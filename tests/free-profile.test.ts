import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleOptions } from '../src/worker-schedule.js';
import { sync, doctor } from '../src/sync.js';
import { parseConfig } from '../src/config.js';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import type { Statement } from '../src/storage/driver.js';
import { fixture, database } from './helpers.js';

test('Free profile is explicit, one job, and rejects ambiguous or over-budget controls', () => {
  assert.deepEqual(scheduleOptions({ PULSE_EXECUTION_PROFILE: 'free', PULSE_READY_ONLY: 'true' }), {
    maxJobs: 1,
    readyOnly: true,
    maximumRequests: 8,
    maximumBytes: 262144,
    maximumRows: 250,
  });
  assert.throws(() => scheduleOptions({ PULSE_EXECUTION_PROFILE: 'paid' }), /Invalid execution/);
  assert.throws(
    () => scheduleOptions({ PULSE_EXECUTION_PROFILE: 'free', PULSE_MAX_JOBS: '2' }),
    /exactly one/,
  );
  assert.throws(() => scheduleOptions({ PULSE_READY_ONLY: 'yes' }), /Invalid ready-only/);
  assert.deepEqual(scheduleOptions({}), { maxJobs: 8 });
});

test('unchanged catalog registration does not issue writes or duplicate history', async () => {
  class Counted extends SqliteDriver {
    writes = 0;
    override async batch(statements: Statement[]) {
      this.writes += statements.length;
      return super.batch(statements);
    }
  }
  const driver = new Counted(':memory:');
  const store = new Store(driver);
  const config = fixture('npm');
  try {
    await store.migrate();
    await store.register(config);
    const before = driver.writes;
    await store.register(config);
    await store.register(config);
    assert.equal(driver.writes, before);
    const changed = parseConfig({ ...config, name: 'Changed name' });
    await store.register(changed);
    assert.ok(driver.writes > before);
    assert.equal((await store.getConfig())?.name, 'Changed name');
  } finally {
    driver.close();
  }
});

test('ready-only keeps public GitHub collection running and missing traffic grants visible', async () => {
  const config = fixture('github', { groups: ['views', 'repository'] });
  const store = await database(config);
  let requests = 0;
  const results = await sync(
    config,
    store,
    {},
    {
      ...scheduleOptions({ PULSE_EXECUTION_PROFILE: 'free', PULSE_READY_ONLY: 'true' }),
      rotate: true,
      fetcher: async (url, init) => {
        requests++;
        assert.equal(String(url), 'https://api.github.com/repos/example/project');
        assert.equal(new Headers(init?.headers).has('Authorization'), false);
        return Response.json({ id: 1, stargazers_count: 3, forks_count: 2, open_issues_count: 1 });
      },
    },
  );
  assert.equal(requests, 1);
  assert.equal(results[0]?.status, 'success');
  assert.equal(results[0]?.group, 'repository');
  const health = await doctor(config, store, {});
  assert.equal(health.healthy, false);
  assert.equal(health.resources.find((x) => x.group === 'views')?.status, 'credentials_missing');
  assert.equal(health.resources.find((x) => x.group === 'repository')?.status, 'healthy');
  assert.equal((await store.getConfig())?.resources[0]?.connection, 'auth');
  assert.equal(await store.getSetting('scheduler_cursor:*:*:*'), undefined);
  assert.notEqual(await store.getSetting('scheduler_cursor:*:*:*:ready'), undefined);
});

test('a ready-only portfolio with no grants performs no collection and does not fake health', async () => {
  const config = fixture('github', { groups: ['views'] });
  const store = await database(config);
  assert.deepEqual(
    await sync(
      config,
      store,
      {},
      {
        readyOnly: true,
        rotate: true,
        fetcher: async () => {
          throw Error('Must not fetch');
        },
      },
    ),
    [],
  );
  assert.equal((await doctor(config, store, {})).healthy, false);
  assert.equal((await store.runs()).length, 0);
});

test('public GitHub fallback is not used when an explicit provider credential is present', async () => {
  const config = fixture('github', { groups: ['repository'] });
  const store = await database(config);
  const results = await sync(
    config,
    store,
    { TEST_TOKEN: 'synthetic-provider-token' },
    {
      readyOnly: true,
      fetcher: async (_url, init) => {
        assert.equal(
          new Headers(init?.headers).get('Authorization'),
          'Bearer synthetic-provider-token',
        );
        return Response.json({}, { status: 403 });
      },
    },
  );
  assert.equal(results[0]?.code, 'PERMISSION');
});

test('release annotations publish in one bounded SQL statement without losing existing behavior', async () => {
  class Counted extends SqliteDriver {
    annotationStatements = 0;
    override async batch(statements: Statement[]) {
      this.annotationStatements += statements.filter((s) =>
        s.sql.startsWith('INSERT INTO annotations'),
      ).length;
      return super.batch(statements);
    }
  }
  const driver = new Counted(':memory:');
  const store = new Store(driver);
  const config = fixture('github', { groups: ['releases'] });
  try {
    await store.migrate();
    await store.register(config);
    const fixtureData = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      tag_name: `v${i}`,
      published_at: '2026-10-23T00:00:00Z',
      draft: false,
      assets: [],
      html_url: `https://github.com/example/project/releases/tag/v${i}`,
    }));
    const results = await sync(
      config,
      store,
      {},
      { readyOnly: true, maximumRows: 250, fetcher: async () => Response.json(fixtureData) },
    );
    assert.equal(results[0]?.status, 'success');
    assert.equal(driver.annotationStatements, 1);
    assert.equal(
      (await store.annotations(['source'], { from: '2026-10-01', to: '2026-10-31' })).length,
      30,
    );
  } finally {
    driver.close();
  }
});
