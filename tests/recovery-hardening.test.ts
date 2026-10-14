import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, fixture, publish, sample, window, now } from './helpers.js';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import { D1Driver } from '../src/storage/driver.js';
import { parseConfig, assertHistoricalMappings } from '../src/config.js';

test('an interrupted unpublished run does not poison a recoverable export', async () => {
  const config = fixture(),
    source = await database(config),
    target = new Store(new SqliteDriver(':memory:'));
  try {
    await target.migrate();
    await publish(source, config, [sample()]);
    const abandoned = await source.begin(config.resources[0]!, 'clones', window, now);
    const archive = await source.export();
    assert.ok(!archive.runs.some((r) => r.id === abandoned));
    await target.import(archive);
    assert.equal((await target.observations('source', window))[0]?.value, 8);
  } finally {
    source.driver.close?.();
    target.driver.close?.();
  }
});

test('export uses a transactional snapshot instead of independent table queries', async () => {
  const s = await database();
  try {
    await publish(s, fixture(), [sample()]);
    const unsafeRead = s.driver.all;
    s.driver.all = async () => {
      throw Error('unsafe multi-query export');
    };
    try {
      assert.equal((await s.export()).observations.length, 1);
    } finally {
      s.driver.all = unsafeRead;
    }
  } finally {
    s.driver.close?.();
  }
});

test('D1 snapshot rejects missing result sets rather than silently exporting blanks', async () => {
  const driver = new D1Driver({
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
    async batch() {
      return undefined;
    },
  });
  await assert.rejects(driver.readBatch([{ sql: 'SELECT 1' }]), /invalid result/);
});

test('archived resource metadata must agree with the validated configuration', async () => {
  const c = fixture(),
    a = await database(c),
    b = new Store(new SqliteDriver(':memory:'));
  try {
    await b.migrate();
    const archive = await a.export();
    archive.resources[0]!.identity = 'github:wrong/repository';
    await assert.rejects(b.import(archive), /identity/);
    assert.equal((await b.driver.all({ sql: 'SELECT * FROM resources' })).length, 0);
  } finally {
    a.driver.close?.();
    b.driver.close?.();
  }
});

test('archived annotation references are validated before any writes', async () => {
  const c = fixture(),
    a = await database(c),
    b = new Store(new SqliteDriver(':memory:'));
  try {
    await b.migrate();
    const archive = await a.export();
    archive.annotations.push({
      id: 'note',
      resource_id: 'missing',
      title: 'Release',
      date: '2026-10-12',
      kind: 'note',
      url: null,
    });
    await assert.rejects(b.import(archive), /annotation reference/);
    assert.equal((await b.driver.all({ sql: 'SELECT * FROM resources' })).length, 0);
  } finally {
    a.driver.close?.();
    b.driver.close?.();
  }
});

test('history is retained by disabling rather than removing a collected resource', async () => {
  const c = fixture(),
    s = await database(c);
  try {
    await publish(s, c, [sample()]);
    const extra = { id: 'other', provider: 'npm' as const, package: 'example', enabled: true };
    await assert.rejects(
      s.register(
        parseConfig({
          ...c,
          resources: [extra],
          projects: [{ id: 'project', label: 'Example', resources: [{ resource: 'other' }] }],
        }),
        now,
      ),
      /historical|orphan/i,
    );
    await s.register(
      parseConfig({ ...c, resources: c.resources.map((r) => ({ ...r, enabled: false })) }),
      now,
    );
    assert.equal((await s.observations('source', window)).length, 1);
  } finally {
    s.driver.close?.();
  }
});

test('historical project path attribution cannot be silently rewritten', () => {
  const c = fixture('cloudflare');
  c.projects[0]!.resources[0]!.scope = { hostname: 'example.com', pathPrefix: '/old/' };
  const updated = parseConfig({
    ...c,
    projects: [
      {
        id: 'project',
        label: 'Example',
        resources: [
          { resource: 'source', scope: { hostname: 'example.com', pathPrefix: '/new/' } },
        ],
      },
    ],
  });
  assert.throws(() => assertHistoricalMappings(c, updated, '2026-10-14'), /Historical mapping/);
});

test('effective-dated scope changes preserve old reports and allow future attribution', () => {
  const c = fixture('cloudflare');
  c.projects[0]!.resources[0]!.scope = { hostname: 'example.com', pathPrefix: '/old/' };
  const updated = parseConfig({
    ...c,
    projects: [
      {
        id: 'project',
        label: 'Renamed label',
        resources: [
          {
            resource: 'source',
            scope: { hostname: 'example.com', pathPrefix: '/old/' },
            effectiveTo: '2026-10-13',
          },
          {
            resource: 'source',
            scope: { hostname: 'example.com', pathPrefix: '/new/' },
            effectiveFrom: '2026-10-14',
          },
        ],
      },
    ],
  });
  assert.doesNotThrow(() => assertHistoricalMappings(c, updated, '2026-10-14'));
});

test('retired sources remain visible in historical reports and health', async () => {
  const { projectReport } = await import('../src/report.js');
  const { doctor, jobs } = await import('../src/sync.js');
  const c = fixture(),
    s = await database(c);
  try {
    await publish(s, c, [sample()]);
    const retired = parseConfig({
      ...c,
      resources: c.resources.map((r) => ({ ...r, enabled: false })),
    });
    await s.register(retired, now);
    const report = await projectReport(retired, s, 'project', window, now);
    assert.equal(report.cards.find((c) => c.metric === 'github.views')?.value, 8);
    assert.ok(report.warnings.some((w) => w.includes('retained history')));
    const health = await doctor(retired, s, {}, now);
    assert.ok(health.resources.length > 0);
    assert.ok(health.resources.every((r) => r.status === 'disabled'));
    assert.equal(jobs(retired).length, 0);
  } finally {
    s.driver.close?.();
  }
});

test('switching from property totals to all-page rows is a historical scope change', () => {
  const c = fixture('cloudflare');
  const updated = parseConfig({
    ...c,
    projects: [
      {
        id: 'project',
        label: 'Example',
        resources: [{ resource: 'source', scope: { pathPrefix: '/' } }],
      },
    ],
  });
  assert.throws(() => assertHistoricalMappings(c, updated, '2026-10-14'), /Historical mapping/);
});
