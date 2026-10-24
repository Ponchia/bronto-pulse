import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, fixture, publish, sample, now, window } from './helpers.js';
import { collected, entry } from '../src/collectors/context.js';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import { D1Driver, type D1Prepared } from '../src/storage/driver.js';
import { projectReport, portfolio } from '../src/report.js';
import { parseConfig } from '../src/config.js';
import { sync } from '../src/sync.js';

test('upserts permit downward corrections and remove vanished dimensions', async () => {
  const c = fixture(),
    s = await database(c);
  try {
    await publish(s, c, [sample('2026-10-12', 20), sample('2026-10-13', 10)]);
    await publish(s, c, [sample('2026-10-12', 5)]);
    const obs = await s.observations('source', window);
    assert.equal(obs.length, 1);
    assert.equal(obs[0]?.value, 5);
  } finally {
    s.driver.close?.();
  }
});
test('staged incomplete data remains invisible after failure', async () => {
  const c = fixture(),
    s = await database(c);
  try {
    await publish(s, c, [sample()]);
    const id = await s.begin(c.resources[0]!, 'views', window, now);
    await s.fail(id, 'NETWORK', 'Safe failure', 1, now);
    const obs = await s.observations('source', window);
    assert.equal(obs[0]?.value, 8);
    assert.equal((await s.runs()).find((x) => x.id === id)?.status, 'failed');
  } finally {
    s.driver.close?.();
  }
});
test('lease mutual exclusion and owner fencing', async () => {
  const s = await database();
  try {
    assert.equal(await s.acquire('test', 'one'), true);
    assert.equal(await s.acquire('test', 'two'), false);
    await s.release('test', 'two');
    assert.equal(await s.acquire('test', 'three'), false);
    await s.release('test', 'one');
    assert.equal(await s.acquire('test', 'three'), true);
  } finally {
    s.driver.close?.();
  }
});
test('expired lease cannot publish staged rows', async () => {
  const c = fixture(),
    s = await database(c);
  try {
    await publish(s, c, [sample()]);
    const key = 'source:views',
      id = await s.begin(c.resources[0]!, 'views', window, now);
    await s.acquire(key, 'stale', -1);
    await s.acquire(key, 'new-owner');
    await assert.rejects(
      s.publish(
        id,
        c.resources[0]!,
        'views',
        collected(window, [sample('2026-10-12', 900)]),
        key,
        'stale',
        1,
        now,
        100,
      ),
      /lease expired/,
    );
    assert.equal((await s.observations('source', window))[0]?.value, 8);
  } finally {
    s.driver.close?.();
  }
});
test('SQLite batch rolls back all statements on an error', async () => {
  const driver = new SqliteDriver(':memory:');
  try {
    await driver.batch([{ sql: 'CREATE TABLE example(id INTEGER PRIMARY KEY)' }]);
    await assert.rejects(
      driver.batch([
        { sql: 'INSERT INTO example VALUES(1)' },
        { sql: 'INSERT INTO example VALUES(1)' },
      ]),
    );
    assert.equal((await driver.all({ sql: 'SELECT * FROM example' })).length, 0);
  } finally {
    driver.close();
  }
});
test('portable driver interface works through a D1-shaped binding', async () => {
  const sqlite = new SqliteDriver(':memory:');
  type Prepared = D1Prepared & { sql: string; params: (string | number | null)[] };
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: (string | number | null)[]): Prepared {
          return {
            sql,
            params,
            all: async <T>() => ({ results: (await sqlite.all({ sql, params })) as T[] }),
          };
        },
      };
    },
    async batch(statements: D1Prepared[]) {
      await sqlite.batch((statements as Prepared[]).map((x) => ({ sql: x.sql, params: x.params })));
    },
  };
  const s = new Store(new D1Driver(db));
  try {
    await s.migrate();
    const c = fixture();
    await s.register(c);
    await publish(s, c, [sample()]);
    assert.equal((await s.observations('source', window))[0]?.value, 8);
  } finally {
    sqlite.close();
  }
});
test('export and import reproduce the report and preserve zero/missing distinctions', async () => {
  const c = fixture(),
    a = await database(c),
    b = new Store(new SqliteDriver(':memory:'));
  try {
    await b.migrate();
    await publish(a, c, [sample('2026-10-12', 0)]);
    const exportData = await a.export();
    await b.import(exportData);
    const ar = await projectReport(c, a, 'project', window, now),
      br = await projectReport(c, b, 'project', window, now);
    assert.deepEqual(br, ar);
    const card = br.cards.find((x) => x.metric === 'github.views')!;
    assert.equal(card.value, 0);
    assert.deepEqual(card.coverage.missingDays, ['2026-10-13']);
    await assert.rejects(b.import(exportData), /empty database/);
  } finally {
    a.driver.close?.();
    b.driver.close?.();
  }
});
test('export refuses active collectors and imports reject unknown schema versions', async () => {
  const s = await database();
  try {
    await s.acquire('a', 'owner');
    await assert.rejects(s.export(), /active collection/);
    await assert.rejects(s.import({ format: 'bronto-pulse', version: 2 }), /Unsupported/);
  } finally {
    s.driver.close?.();
  }
});
test('provider identity conflicts do not rewrite source history', async () => {
  const c = fixture(),
    s = await database(c);
  try {
    await s.driver.batch([
      { sql: "UPDATE resources SET provider_identity='github:123' WHERE id='source'" },
    ]);
    const key = 'source:views',
      owner = 'one';
    await s.acquire(key, owner);
    const id = await s.begin(c.resources[0]!, 'views', window, now);
    await assert.rejects(
      s.publish(
        id,
        c.resources[0]!,
        'views',
        { ...collected(window, [sample()]), identity: 'github:456' },
        key,
        owner,
        1,
        now,
        10,
      ),
      /replaced/,
    );
  } finally {
    s.driver.close?.();
  }
});
test('unknown is not zero and non-additive uniques never gain a period sum', async () => {
  const c = fixture(),
    s = await database(c);
  try {
    await publish(s, c, [
      sample(),
      entry('github.unique_viewers', '2026-10-12', 4),
      entry('github.unique_viewers', '2026-10-13', 6),
    ]);
    const report = await projectReport(c, s, 'project', window, now);
    const unique = report.cards.find((c) => c.metric === 'github.unique_viewers')!;
    assert.equal(unique.value, null);
    assert.equal(unique.latestValue, 6);
    const clones = report.cards.find((c) => c.metric === 'github.clones')!;
    assert.equal(clones.value, null);
    assert.equal(clones.coverage.status, 'unavailable');
  } finally {
    s.driver.close?.();
  }
});
test('GSC ratios and means are weighted, not averages of daily means', async () => {
  const c = fixture('gsc'),
    s = await database(c);
  try {
    await publish(
      s,
      c,
      [
        {
          ...entry('gsc.position', '2026-10-12', 2),
          timezone: 'America/Los_Angeles',
          numerator: 20,
          denominator: 10,
        },
        {
          ...entry('gsc.position', '2026-10-13', 10),
          timezone: 'America/Los_Angeles',
          numerator: 900,
          denominator: 90,
        },
      ],
      'totals',
    );
    const card = (await projectReport(c, s, 'project', window, now)).cards.find(
      (x) => x.metric === 'gsc.position',
    )!;
    assert.equal(card.value, 9.2);
  } finally {
    s.driver.close?.();
  }
});
test('page prefixes attribute shared property counts without substring collisions', async () => {
  const base = fixture('cloudflare'),
    c = parseConfig({
      ...base,
      projects: [
        {
          id: 'one',
          label: 'One',
          resources: [
            { resource: 'source', scope: { hostname: 'example.com', pathPrefix: '/one/' } },
          ],
        },
        {
          id: 'two',
          label: 'Two',
          resources: [
            { resource: 'source', scope: { hostname: 'example.com', pathPrefix: '/two/' } },
          ],
        },
      ],
    }),
    s = await database(c);
  try {
    await publish(
      s,
      c,
      [
        entry('cloudflare.pageviews', '2026-10-12', 5, {
          hostname: 'example.com',
          path: '/one/guide',
        }),
        entry('cloudflare.pageviews', '2026-10-12', 99, {
          hostname: 'example.com',
          path: '/one-secret',
        }),
        entry('cloudflare.pageviews', '2026-10-12', 7, { hostname: 'example.com', path: '/two/' }),
      ],
      'pages',
    );
    const one = await projectReport(c, s, 'one', window, now);
    assert.equal(one.cards.find((x) => x.metric === 'cloudflare.pageviews')?.value, 5);
    assert.ok(!one.cards.some((x) => x.metric === 'cloudflare.visits'));
  } finally {
    s.driver.close?.();
  }
});
test('a failed live sync preserves data and gives a redacted diagnostic', async () => {
  const c = fixture('github', { groups: ['views'] }),
    s = await database(c);
  try {
    await publish(s, c, [sample()]);
    const result = await sync(
      c,
      s,
      { TEST_TOKEN: 'SECRET_SHOULD_NOT_LEAK' },
      {
        now,
        window,
        fetcher: async () => new Response('SECRET_SHOULD_NOT_LEAK', { status: 403 }),
        sleep: async () => {},
      },
    );
    assert.equal(result[0]?.status, 'failed');
    assert.ok(!JSON.stringify(result).includes('SECRET_SHOULD_NOT_LEAK'));
    assert.equal((await s.observations('source', window))[0]?.value, 8);
  } finally {
    s.driver.close?.();
  }
});
test('demo and live history can never share a database', async () => {
  const c = fixture(),
    s = await database(c);
  try {
    await assert.rejects(s.register({ ...c, demo: true }), /separate databases/);
  } finally {
    s.driver.close?.();
  }
});

test('small portfolio uses one request-scoped snapshot with identical report content', async () => {
  const c = fixture();
  const s = await database(c);
  try {
    await publish(s, c, [sample('2026-10-12', 8), sample('2026-10-13', 4)]);
    const expected = await projectReport(c, s, 'project', window, now);
    let batches = 0;
    let singleReads = 0;
    const counted = new Store({
      all: async (q) => {
        singleReads++;
        return s.driver.all(q);
      },
      batch: async () => assert.fail('Portfolio must not write'),
      readBatch: async (queries) => {
        batches++;
        return s.driver.readBatch(queries);
      },
    });
    const result = await portfolio(c, counted, window, now);
    assert.deepEqual(result.reports, [expected]);
    assert.equal(batches, 1);
    assert.equal(singleReads, 0);
    const snapshot = await s.reportingSnapshot(c, window);
    await publish(s, c, [sample('2026-10-12', 1)]);
    assert.deepEqual(await projectReport(c, snapshot, 'project', window, now), expected);
    await assert.rejects(snapshot.setSetting('unwanted', 'write'), /read-only/);
    await assert.rejects(snapshot.runs(10, 'outside'), /outside this report/);
    assert.notDeepEqual(await projectReport(c, s, 'project', window, now), expected);
  } finally {
    s.driver.close?.();
  }
});
test('malformed portfolio snapshot results fail closed', async () => {
  const c = fixture();
  const s = new Store({ all: async () => [], batch: async () => {}, readBatch: async () => [] });
  await assert.rejects(portfolio(c, s, window, now), /Incomplete portfolio snapshot/);
});
