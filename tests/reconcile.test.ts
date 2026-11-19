import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { collectReconciliation, reconciliationJobs } from '../src/reconcile.js';
import { sync } from '../src/sync.js';
import type { Fetcher } from '../src/http.js';
import { database, fixture } from './helpers.js';

const now = new Date('2026-11-19T12:00:00Z');
const secrets = { TEST_TOKEN: 'synthetic-test-token' };
const selected = { resourceId: 'source', group: 'queries' };

function config(days = 3) {
  const value = fixture('gsc', {
    collectQueries: true,
    lookbackDaysByGroup: { queries: 1 },
    reconcileDaysByGroup: { queries: days },
  });
  return parseConfig({ ...value, settings: { ...value.settings, maxRows: 5000 } });
}

function responses(
  requested: string[],
  values: { clicks?: number; rows?: number; fail?: boolean } = {},
): Fetcher {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      startDate: string;
      endDate: string;
      dimensions: string[];
    };
    assert.equal(body.startDate, body.endDate, 'every request contains exactly one source day');
    assert.deepEqual(body.dimensions, ['date', 'query']);
    requested.push(body.startDate);
    if (values.fail) return Response.json({ error: 'synthetic outage' }, { status: 503 });
    return Response.json({
      responseAggregationType: 'byPage',
      rows: Array.from({ length: values.rows ?? 1 }, (_, index) => ({
        keys: [body.startDate, `fixture-query-${index}`],
        clicks: values.clicks ?? 3,
        impressions: 10,
        position: 2,
      })),
    });
  };
}

test('reconciliation requires explicit collected GSC groups and a bounded horizon', () => {
  assert.doesNotThrow(() => config(1));
  assert.doesNotThrow(() => config(366));
  for (const days of [0, -1, 1.5, 367]) assert.throws(() => config(days));
  assert.throws(() => fixture('gsc', { reconcileDaysByGroup: { queries: 14 } }), /collected/);
  assert.throws(() => fixture('gsc', { reconcileDaysByGroup: { typo: 14 } }), /collected/);
  for (const provider of ['github', 'npm', 'cloudflare', 'sense6'])
    assert.throws(() => fixture(provider, { reconcileDaysByGroup: { totals: 14 } }));
  assert.deepEqual(reconciliationJobs(fixture('gsc'), {}, now), []);
});

test('the correction horizon follows Pacific dates and clamps stale or invalid checkpoints', () => {
  const c = config();
  const midnightUtc = new Date('2026-11-19T02:00:00Z');
  assert.deepEqual(reconciliationJobs(c, {}, midnightUtc)[0]?.window, {
    from: '2026-11-15',
    to: '2026-11-15',
  });
  assert.equal(
    reconciliationJobs(c, { 'source:queries': '2026-11-16' }, now)[0]?.window.from,
    '2026-11-17',
  );
  for (const checkpoint of ['2020-01-01', '2026-11-18', '2099-01-01', 'not-a-date'])
    assert.equal(
      reconciliationJobs(c, { 'source:queries': checkpoint }, now)[0]?.window.from,
      '2026-11-16',
    );
  assert.throws(() => reconciliationJobs(c, {}, new Date('invalid')), /clock/);
  assert.deepEqual(reconciliationJobs(c, {}, now, { provider: 'npm' }), []);
  assert.deepEqual(
    reconciliationJobs(
      parseConfig({ ...c, resources: c.resources.map((r) => ({ ...r, enabled: false })) }),
      {},
      now,
    ),
    [],
  );
});

test('daily correction passes replace published evidence without double counting', async () => {
  const c = config();
  const store = await database(c);
  const requested: string[] = [];
  for (let index = 0; index < 3; index++) {
    const result = await collectReconciliation(c, store, secrets, {
      now,
      ...selected,
      fetcher: responses(requested),
      maximumRows: 250,
      maximumRequests: 8,
    });
    assert.equal(result.pending, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, 'success');
  }
  const corrected = await collectReconciliation(c, store, secrets, {
    now,
    ...selected,
    fetcher: responses(requested, { clicks: 7 }),
    maximumRows: 250,
  });
  assert.equal(corrected.results[0]?.status, 'success');
  assert.deepEqual(requested, ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-16']);
  const observations = await store.observations('source', {
    from: '2026-11-16',
    to: '2026-11-18',
  });
  const clicks = observations.filter((item) => item.metric === 'gsc.clicks');
  assert.equal(clicks.length, 3);
  assert.equal(clicks.find((item) => item.from === '2026-11-16')?.value, 7);
  assert.equal(
    clicks.reduce((sum, item) => sum + item.value, 0),
    13,
  );
});

test('an over-budget correction preserves prior history and does not starve the next day', async () => {
  const c = config();
  const store = await database(c);
  const requested: string[] = [];
  const original = await sync(c, store, secrets, {
    now,
    ...selected,
    window: { from: '2026-11-16', to: '2026-11-16' },
    fetcher: responses(requested, { clicks: 5 }),
    maximumRows: 8,
  });
  assert.equal(original[0]?.status, 'success');
  const failed = await collectReconciliation(c, store, secrets, {
    now,
    ...selected,
    fetcher: responses(requested, { rows: 3 }),
    maximumRows: 8,
  });
  assert.equal(failed.results[0]?.code, 'ROW_LIMIT', 'raw rows expand into four observations');
  const retained = await store.observations('source', { from: '2026-11-16', to: '2026-11-16' });
  assert.equal(retained.find((item) => item.metric === 'gsc.clicks')?.value, 5);
  const next = await collectReconciliation(c, store, secrets, {
    now,
    ...selected,
    fetcher: responses(requested),
    maximumRows: 8,
  });
  assert.equal(next.job?.window.from, '2026-11-17');
  assert.equal(next.results[0]?.status, 'success');
});

test('missing credentials or a held dataset lease do not consume the correction date', async () => {
  const c = config();
  const store = await database(c);
  const unavailable = await collectReconciliation(c, store, {}, { now, readyOnly: true });
  assert.deepEqual(unavailable.results, []);
  assert.equal(await store.getSetting('reconciliation_days'), undefined);
  assert.equal(await store.acquire('source:queries', 'another-collector'), true);
  const held = await collectReconciliation(c, store, secrets, { now });
  assert.equal(held.results[0]?.code, 'CONFLICT');
  assert.equal(await store.getSetting('reconciliation_days'), undefined);
  await store.release('source:queries', 'another-collector');
  const requested: string[] = [];
  const collected = await collectReconciliation(c, store, secrets, {
    now,
    fetcher: responses(requested),
  });
  assert.equal(collected.job?.window.from, '2026-11-16');
});

test('regular refresh remains separate from the bounded correction cursor', async () => {
  const c = config();
  const store = await database(c);
  const requested: string[] = [];
  await collectReconciliation(c, store, secrets, { now, fetcher: responses(requested) });
  const checkpoint = await store.getSetting('reconciliation_days');
  await sync(c, store, secrets, { now, ...selected, fetcher: responses(requested) });
  assert.deepEqual(requested, ['2026-11-16', '2026-11-18']);
  assert.equal(await store.getSetting('reconciliation_days'), checkpoint);
});

test('correction selection rotates across opted-in datasets and validates explicit selectors', async () => {
  const original = config(2);
  const source = original.resources[0]!;
  const c = parseConfig({
    ...original,
    resources: [source, { ...source, id: 'second', siteUrl: 'sc-domain:second.invalid' }],
  });
  const store = await database(c);
  const requested: string[] = [];
  const one = await collectReconciliation(c, store, secrets, {
    now,
    fetcher: responses(requested),
  });
  const two = await collectReconciliation(c, store, secrets, {
    now,
    fetcher: responses(requested),
  });
  const three = await collectReconciliation(c, store, secrets, {
    now,
    fetcher: responses(requested),
  });
  assert.deepEqual(
    [one.job?.resourceId, two.job?.resourceId, three.job?.resourceId],
    ['source', 'second', 'source'],
  );
  assert.deepEqual(requested, ['2026-11-17', '2026-11-17', '2026-11-18']);
  assert.throws(() => reconciliationJobs(c, {}, now, { resourceId: 'missing' }));
});
