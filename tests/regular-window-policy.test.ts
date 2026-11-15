import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { planCollection } from '../src/plan.js';
import { sync } from '../src/sync.js';
import { days } from '../src/time.js';
import { database, fixture } from './helpers.js';

const now = new Date('2026-11-15T20:00:00Z');

test('a group lookback changes only its implicit source-local window', () => {
  const raw = fixture('gsc', {
    collectQueries: true,
    lookbackDaysByGroup: { queries: 2 },
  });
  const config = parseConfig({ ...raw, settings: { ...raw.settings, lookbackDays: 4 } });
  // Before the Pacific date rolls over, yesterday is still Nov 13.
  const plan = planCollection(config, {
    now: new Date('2026-11-15T07:30:00Z'),
    chunkDays: 366,
  });
  assert.deepEqual(
    plan.jobs.map((job) => ({ group: job.group, window: job.window, timezone: job.timezone })),
    [
      {
        group: 'totals',
        window: { from: '2026-11-10', to: '2026-11-13' },
        timezone: 'America/Los_Angeles',
      },
      {
        group: 'pages',
        window: { from: '2026-11-10', to: '2026-11-13' },
        timezone: 'America/Los_Angeles',
      },
      {
        group: 'queries',
        window: { from: '2026-11-12', to: '2026-11-13' },
        timezone: 'America/Los_Angeles',
      },
    ],
  );

  const explicit = { from: '2026-11-01', to: '2026-11-02' };
  assert.deepEqual(
    planCollection(config, {
      now,
      resourceId: 'source',
      group: 'queries',
      window: explicit,
      chunkDays: 366,
    }).jobs[0]?.window,
    explicit,
    'an explicit backfill or probe plan must not be shortened by a regular lookback',
  );
  const legacy = parseConfig({
    ...config,
    resources: [{ ...config.resources[0]!, lookbackDaysByGroup: undefined }],
  });
  assert.deepEqual(
    planCollection(legacy, { now, group: 'queries', chunkDays: 366 }).jobs[0]?.window,
    { from: '2026-11-11', to: '2026-11-14' },
    'no opt-in preserves the original implicit window',
  );
});

test('configured lookback rejects unknown, disabled and non-daily groups', () => {
  assert.deepEqual(
    fixture('npm', { lookbackDaysByGroup: { downloads: 2 } }).resources[0]?.lookbackDaysByGroup,
    { downloads: 2 },
  );
  assert.deepEqual(
    fixture('github', {
      groups: ['repository', 'views'],
      lookbackDaysByGroup: { views: 7 },
    }).resources[0]?.lookbackDaysByGroup,
    { views: 7 },
  );
  assert.throws(
    () => fixture('gsc', { lookbackDaysByGroup: { queries: 2 } }),
    /Per-group lookback days/,
    'disabled private query collection cannot secretly enable a window override',
  );
  assert.throws(
    () => fixture('github', { lookbackDaysByGroup: { releases: 2 } }),
    /collected daily dataset/,
  );
  assert.throws(
    () => fixture('npm', { lookbackDaysByGroup: { typo: 2 } }),
    /Per-group lookback days/,
  );
  assert.throws(
    () => fixture('npm', { lookbackDaysByGroup: { downloads: 0 } }),
    /Invalid project configuration/,
  );
  assert.throws(
    () => fixture('npm', { lookbackDaysByGroup: { downloads: 367 } }),
    /Invalid project configuration/,
  );
  assert.equal('lookbackDaysByGroup' in fixture('npm').resources[0]!, false);
});

test('a shorter GSC query lookback can fit Free profile without relaxing row caps', async () => {
  const initial = fixture('gsc', {
    collectQueries: true,
    lookbackDaysByGroup: { queries: 2 },
  });
  const narrow = parseConfig({
    ...initial,
    settings: { ...initial.settings, lookbackDays: 4, maxRows: 1000 },
  });
  const long = parseConfig({
    ...narrow,
    resources: [{ ...narrow.resources[0]!, lookbackDaysByGroup: undefined }],
  });
  const store = await database(narrow);
  const windows: { from: string; to: string }[] = [];
  const fetcher = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { startDate: string; endDate: string };
    windows.push({ from: body.startDate, to: body.endDate });
    return Response.json({
      responseAggregationType: 'byPage',
      rows: days({ from: body.startDate, to: body.endDate }).flatMap((date) =>
        Array.from({ length: 20 }, (_, index) => ({
          keys: [date, `synthetic-query-${index}`],
          clicks: 1,
          impressions: 4,
          position: 3,
        })),
      ),
    });
  };
  const options = {
    now,
    resourceId: 'source',
    group: 'queries',
    maximumRows: 250,
    maximumRequests: 8,
    fetcher,
  };

  try {
    const first = (await sync(narrow, store, { TEST_TOKEN: 'test-only-credential' }, options))[0];
    assert.equal(first?.status, 'success');
    assert.equal(first?.rows, 160);
    assert.deepEqual(windows.at(-1), { from: '2026-11-13', to: '2026-11-14' });
    const before = await store.observations('source', {
      from: '2026-11-13',
      to: '2026-11-14',
    });
    assert.equal(before.length, 160);
    const failed = (await sync(long, store, { TEST_TOKEN: 'test-only-credential' }, options))[0];
    assert.equal(failed?.code, 'ROW_LIMIT');
    assert.equal(failed?.status, 'failed');
    assert.deepEqual(windows.at(-1), { from: '2026-11-11', to: '2026-11-14' });
    assert.deepEqual(
      await store.observations('source', { from: '2026-11-13', to: '2026-11-14' }),
      before,
      'an over-budget fetch may not replace previously published query evidence',
    );
    const explicit = (
      await sync(
        narrow,
        store,
        { TEST_TOKEN: 'test-only-credential' },
        {
          ...options,
          window: { from: '2026-11-10', to: '2026-11-10' },
        },
      )
    )[0];
    assert.equal(explicit?.status, 'success');
    assert.deepEqual(windows.at(-1), { from: '2026-11-10', to: '2026-11-10' });
  } finally {
    store.driver.close?.();
  }
});
