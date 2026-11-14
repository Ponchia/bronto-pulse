import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { collect } from '../src/collectors/index.js';
import { ctx } from './helpers.js';
import { HttpClient } from '../src/http.js';
import { days, daysBetween } from '../src/time.js';
import { METRICS } from '../src/model.js';

function config(provider: 'plausible' | 'umami', timezone = 'Europe/Madrid') {
  return parseConfig({
    version: 1,
    connections: [{ id: 'auth', provider, tokenEnv: 'TEST_TOKEN' }],
    resources: [
      {
        id: 'site',
        provider,
        connection: 'auth',
        ...(provider === 'plausible'
          ? { siteId: 'example.org', timezone }
          : { websiteId: '00000000-0000-4000-8000-000000000001' }),
      },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
}
const window = { from: '2026-10-12', to: '2026-10-13' };
function plausible(query: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    results: [{ dimensions: [window.from], metrics: [12, 3] }],
    meta: { imports_included: false, ...meta },
    query: {
      site_id: 'example.org',
      metrics: ['pageviews', 'visitors'],
      dimensions: ['time:day'],
      date_range: ['2026-10-11T22:00:00Z', '2026-10-13T21:59:59Z'],
      filters: [],
      include: { imports: false },
      ...query,
    },
  };
}
for (const [name, query] of Object.entries({
  'wrong site': { site_id: 'different.example.org' },
  'reordered metrics': { metrics: ['visitors', 'pageviews'] },
  'wrong dimensions': { dimensions: ['time:month'] },
  'filtered scope': { filters: [['is', 'event:page', ['/private']]] },
  'imported scope': { include: { imports: true } },
  'wrong timezone': { date_range: ['2026-10-12T00:00:00Z', '2026-10-13T23:59:59Z'] },
  'partial first day': { date_range: ['2026-10-12T10:00:00+02:00', '2026-10-13T23:59:59+02:00'] },
  'partial last day': { date_range: ['2026-10-12T00:00:00+02:00', '2026-10-13T12:59:59+02:00'] },
  'wrong dates': { date_range: ['2026-10-11', '2026-10-13'] },
  'missing metrics': { metrics: null },
  'malformed date': { date_range: ['2026-10-12T25:00:00+02:00', '2026-10-13T23:59:59+02:00'] },
})) {
  test(`Plausible refuses a contradictory executed query: ${name}`, async () => {
    const c = config('plausible');
    await assert.rejects(collect(c.resources[0]!, 'traffic', ctx(c, [plausible(query)])));
  });
}

test('Plausible accepts UTC-normalized full-day boundaries matching the configured site calendar', async () => {
  const c = config('plausible');
  const data = await collect(c.resources[0]!, 'traffic', ctx(c, [plausible()]));
  assert.deepEqual(
    data.observations.map((o) => [o.metric, o.value, o.timezone]),
    [
      ['plausible.pageviews', 12, 'Europe/Madrid'],
      ['plausible.visitors_daily', 3, 'Europe/Madrid'],
    ],
  );
});

test('Plausible accepts date-only echo and explicit fractional end-of-day boundaries', async () => {
  const c = config('plausible');
  for (const date_range of [
    [window.from, window.to],
    ['2026-10-12T00:00:00+02:00', '2026-10-13T23:59:59.999999+02:00'],
  ]) {
    const result = await collect(c.resources[0]!, 'traffic', ctx(c, [plausible({ date_range })]));
    assert.equal(result.observations[0]?.value, 12);
  }
});

test('Plausible accepts a DST transition without assuming a fixed day length', async () => {
  const c = config('plausible');
  const context = ctx(c, [
    {
      ...plausible({
        date_range: ['2026-10-25T00:00:00+02:00', '2026-10-25T23:59:59+01:00'],
      }),
      results: [{ dimensions: ['2026-10-25'], metrics: [12, 3] }],
    },
  ]);
  context.window = { from: '2026-10-25', to: '2026-10-25' };
  const result = await collect(c.resources[0]!, 'traffic', context);
  assert.equal(result.observations[0]?.value, 12);
});

for (const meta of [{ imports_included: 'false' }, { total_rows: 2 }, { total_rows: -1 }]) {
  test(`Plausible rejects conflicting metadata ${JSON.stringify(meta)}`, async () => {
    const c = config('plausible');
    await assert.rejects(collect(c.resources[0]!, 'traffic', ctx(c, [plausible({}, meta)])));
  });
}

test('Plausible keeps old responses without query echoes usable and never invents empty-day zeros', async () => {
  const c = config('plausible');
  const result = await collect(c.resources[0]!, 'traffic', ctx(c, [{ results: [] }]));
  assert.deepEqual(result.observations, []);
});

test('Umami splits a long date range into bounded daily queries with exact contiguous coverage', async () => {
  const c = config('umami');
  const wanted = { from: '2026-01-01', to: '2026-10-01' };
  const windows: (typeof wanted)[] = [];
  const context = ctx(c, async (input) => {
    const u = new URL(String(input));
    const from = new Date(Number(u.searchParams.get('startAt'))).toISOString().slice(0, 10);
    const to = new Date(Number(u.searchParams.get('endAt'))).toISOString().slice(0, 10);
    windows.push({ from, to });
    assert.equal(u.searchParams.get('unit'), 'day');
    assert.equal(u.searchParams.get('timezone'), 'UTC');
    assert.ok(daysBetween(from, to) <= 31, 'Daily query exceeded the reviewed provider-safe bound');
    assert.equal(Number(u.searchParams.get('endAt')) % 86400000, 86399999);
    return Response.json({
      pageviews: days({ from, to }).map((x) => ({ x, y: 2 })),
      sessions: days({ from, to }).map((x) => ({ x, y: 1 })),
    });
  });
  context.window = wanted;
  const result = await collect(c.resources[0]!, 'traffic', context);
  assert.deepEqual(windows.flatMap(days), days(wanted));
  assert.deepEqual(result.range, wanted);
  assert.equal(
    result.observations.filter((o) => o.metric === 'umami.pageviews').length,
    days(wanted).length,
  );
});

test('Umami rejects a day belonging to another slice, even when inside the outer window', async () => {
  const c = config('umami');
  let calls = 0;
  const context = ctx(c, async () => {
    calls++;
    return Response.json({ pageviews: [{ x: '2026-10-01', y: 2 }], sessions: [] });
  });
  context.window = { from: '2026-01-01', to: '2026-10-01' };
  await assert.rejects(collect(c.resources[0]!, 'traffic', context), /out-of-window/);
  assert.equal(calls, 1);
});

test('Umami keeps the request budget across all chunks', async () => {
  const c = config('umami');
  let calls = 0;
  const context = ctx(c, []);
  context.http = new HttpClient(
    async () => {
      calls++;
      return Response.json({ pageviews: [], sessions: [] });
    },
    1000,
    async () => {},
    undefined,
    1,
  );
  context.window = { from: '2026-01-01', to: '2026-10-01' };
  await assert.rejects(collect(c.resources[0]!, 'traffic', context), /request budget/);
  assert.equal(calls, 1);
});

test('Umami metric caveat identifies visitor/session identifiers without relabeling stored series', () => {
  const metric = METRICS['umami.sessions_daily']!;
  assert.equal(metric.aggregation, 'none');
  assert.equal(metric.unit, 'sessions');
  assert.match(metric.caveat, /visitor/i);
  assert.match(metric.caveat, /visit count|visits/i);
});
