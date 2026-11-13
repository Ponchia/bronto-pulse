import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, type Config } from '../src/config.js';
import { collect } from '../src/collectors/index.js';
import { ctx, database, window as period } from './helpers.js';
import { HttpClient } from '../src/http.js';
import { projectReport } from '../src/report.js';
import { collected } from '../src/collectors/context.js';

function config(provider: 'plausible' | 'umami'): Config {
  const resource =
    provider === 'plausible'
      ? {
          id: 'site',
          provider,
          siteId: 'site.example.org',
          timezone: 'Europe/Madrid',
          connection: 'analytics',
        }
      : { id: 'site', provider, websiteId: 'website-123', connection: 'analytics' };
  return parseConfig({
    version: 1,
    name: 'Test installation',
    settings: { maxRows: 50, lookbackDays: 14 },
    connections: [{ id: 'analytics', provider, tokenEnv: 'TEST_TOKEN' }],
    resources: [resource],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
}

test('Plausible adapter uses exact read-only Stats API, native history, timezone and nonadditive visitors', async () => {
  const c = config('plausible');
  let requests = 0;
  const x = ctx(c, async (url, init) => {
    requests++;
    assert.equal(String(url), 'https://plausible.io/api/v2/query');
    assert.equal(init?.method, 'POST');
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer private-test-token-not-for-logs',
    );
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.metrics, ['pageviews', 'visitors']);
    assert.deepEqual(body.dimensions, ['time:day']);
    assert.equal(body.include.imports, false);
    assert.deepEqual(body.pagination, { limit: 51, offset: 0 });
    assert.deepEqual(body.date_range, [period.from, period.to]);
    return Response.json({
      results: [
        { dimensions: ['2026-10-12'], metrics: [7, 3] },
        { dimensions: ['2026-10-13'], metrics: [11, 4] },
      ],
      meta: { imports_included: false },
    });
  });
  const rows = await collect(c.resources[0]!, 'traffic', x);
  assert.equal(requests, 1);
  assert.equal(rows.observations.length, 4);
  assert.deepEqual(
    rows.observations.map((o) => [o.metric, o.from, o.value, o.timezone]),
    [
      ['plausible.pageviews', '2026-10-12', 7, 'Europe/Madrid'],
      ['plausible.visitors_daily', '2026-10-12', 3, 'Europe/Madrid'],
      ['plausible.pageviews', '2026-10-13', 11, 'Europe/Madrid'],
      ['plausible.visitors_daily', '2026-10-13', 4, 'Europe/Madrid'],
    ],
  );
  const store = await database(c);
  try {
    const key = 'site:traffic';
    const owner = crypto.randomUUID();
    assert.equal(await store.acquire(key, owner), true);
    const run = await store.begin(c.resources[0]!, 'traffic', period, x.now);
    await store.publish(
      run,
      c.resources[0]!,
      'traffic',
      collected(period, rows.observations),
      key,
      owner,
      1,
      x.now,
      50,
    );
    await store.release(key, owner);
    const report = await projectReport(c, store, 'project', period, x.now);
    assert.equal(report.cards.find((d) => d.metric === 'plausible.pageviews')?.value, 18);
    assert.equal(report.cards.find((d) => d.metric === 'plausible.visitors_daily')?.value, null);
    assert.equal(report.cards.find((d) => d.metric === 'plausible.visitors_daily')?.latestValue, 4);
    assert.equal(report.evidence.humanAudience, 'not_measured');
  } finally {
    store.driver.close?.();
  }
});

test('Plausible rejects imported stats, duplicate days, row overflows and out-of-range observations', async () => {
  const c = config('plausible');
  const payload = (response: unknown) => ctx(c, async () => Response.json(response));
  await assert.rejects(
    collect(c.resources[0]!, 'traffic', payload({ results: [], meta: { imports_included: true } })),
    /imported analytics/,
  );
  await assert.rejects(
    collect(
      c.resources[0]!,
      'traffic',
      payload({
        results: [
          { dimensions: ['2026-10-12'], metrics: [1, 2] },
          { dimensions: ['2026-10-12'], metrics: [1, 2] },
        ],
      }),
    ),
    /duplicate/,
  );
  await assert.rejects(
    collect(
      c.resources[0]!,
      'traffic',
      payload({ results: [{ dimensions: ['2026-10-14'], metrics: [1, 2] }] }),
    ),
    /out-of-window/,
  );
  await assert.rejects(
    collect(
      c.resources[0]!,
      'traffic',
      payload({ results: [{ dimensions: ['2026-10-12'], metrics: [-1, 2] }] }),
    ),
    /invalid plausible\.pageviews|invalid count/,
  );
  const largeBudget = parseConfig({ ...c, settings: { ...c.settings, maxRows: 50000 } });
  await collect(
    largeBudget.resources[0]!,
    'traffic',
    ctx(largeBudget, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.pagination.limit, 10000);
      return Response.json({ results: [] });
    }),
  );
  const big = parseConfig({ ...c, settings: { ...c.settings, maxRows: 10 } });
  await assert.rejects(
    collect(
      big.resources[0]!,
      'traffic',
      ctx(big, async () =>
        Response.json({
          results: Array.from({ length: 11 }, () => ({
            dimensions: ['2026-10-12'],
            metrics: [1, 1],
          })),
        }),
      ),
    ),
    /truncated|row budget/,
  );
});

test('Plausible configuration validates the reporting timezone and requires a token connection', () => {
  const c = config('plausible');
  assert.throws(
    () =>
      parseConfig({
        ...c,
        resources: [{ ...c.resources[0], timezone: 'Mars/Phobos' }],
      }),
    /Invalid project configuration/,
  );
  assert.throws(
    () => parseConfig({ ...c, resources: [{ ...c.resources[0], connection: undefined }] }),
    /selected token connection/,
  );
});

test('Umami Cloud adapter fetches exact daily pageviews and sessions without combining identities', async () => {
  const c = config('umami');
  const x = ctx(c, async (url, init) => {
    const target = new URL(String(url));
    assert.equal(target.origin, 'https://api.umami.is');
    assert.equal(target.pathname, '/v1/websites/website-123/pageviews');
    assert.deepEqual([...target.searchParams.keys()].sort(), [
      'endAt',
      'startAt',
      'timezone',
      'unit',
    ]);
    assert.equal(target.searchParams.get('timezone'), 'UTC');
    assert.equal(target.searchParams.get('unit'), 'day');
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer private-test-token-not-for-logs',
    );
    return Response.json({
      pageviews: [
        { x: '2026-10-12T00:00:00.000Z', y: 12 },
        { x: '2026-10-13T00:00:00.000Z', y: 16 },
      ],
      sessions: [
        { x: '2026-10-12T00:00:00.000Z', y: 4 },
        { x: '2026-10-13T00:00:00.000Z', y: 5 },
      ],
    });
  });
  const data = await collect(c.resources[0]!, 'traffic', x);
  assert.deepEqual(
    data.observations.map((o) => [o.metric, o.from, o.value]),
    [
      ['umami.pageviews', '2026-10-12', 12],
      ['umami.pageviews', '2026-10-13', 16],
      ['umami.sessions_daily', '2026-10-12', 4],
      ['umami.sessions_daily', '2026-10-13', 5],
    ],
  );
});

test('Umami rejects malformed dates and duplicate series and both adapters retain fixed-origin SSRF protection', async () => {
  const c = config('umami');
  await assert.rejects(
    collect(
      c.resources[0]!,
      'traffic',
      ctx(c, async () =>
        Response.json({
          pageviews: [{ x: 'not a date', y: 3 }],
          sessions: [],
        }),
      ),
    ),
    /invalid daily bucket/,
  );
  await assert.rejects(
    collect(
      c.resources[0]!,
      'traffic',
      ctx(c, async () =>
        Response.json({
          pageviews: [
            { x: '2026-10-12', y: 3 },
            { x: '2026-10-12', y: 4 },
          ],
          sessions: [],
        }),
      ),
    ),
    /duplicate/,
  );
  const withUtcDayLabels = await collect(
    c.resources[0]!,
    'traffic',
    ctx(c, async () =>
      Response.json({
        pageviews: [{ x: '2026-10-12 00:00:00', y: 9 }],
        sessions: [{ x: '2026-10-12T00:00:00Z', y: 2 }],
      }),
    ),
  );
  assert.deepEqual(
    withUtcDayLabels.observations.map((o) => [o.metric, o.from, o.value]),
    [
      ['umami.pageviews', '2026-10-12', 9],
      ['umami.sessions_daily', '2026-10-12', 2],
    ],
  );
  await assert.rejects(
    collect(
      c.resources[0]!,
      'traffic',
      ctx(c, async () =>
        Response.json({ pageviews: [{ x: '2026-10-12 12:00:00', y: 1 }], sessions: [] }),
      ),
    ),
    /invalid daily bucket/,
  );
  let calls = 0;
  const http = new HttpClient(async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(http.json('https://plausible.example.org/api/v2/query'), /not permitted/);
  await assert.rejects(http.json('http://127.0.0.1:3000/api/v2/query'), /not permitted/);
  await assert.rejects(
    http.json('https://plausible.io/api/v2/other', { method: 'POST' }),
    /read-only/,
  );
  await assert.rejects(http.json('https://api.umami.is/v1/users'), /read-only/);
  assert.equal(calls, 0);
});

test('two analytics sources on one site remain separate without a fabricated combined audience', async () => {
  const c = parseConfig({
    version: 1,
    resources: [
      {
        id: 'plausible_site',
        provider: 'plausible',
        siteId: 'same.example.org',
        timezone: 'UTC',
        connection: 'plausible_auth',
      },
      { id: 'umami_site', provider: 'umami', websiteId: 'same-website', connection: 'umami_auth' },
    ],
    connections: [
      { id: 'plausible_auth', provider: 'plausible', tokenEnv: 'PLAUSIBLE_TOKEN' },
      { id: 'umami_auth', provider: 'umami', tokenEnv: 'UMAMI_TOKEN' },
    ],
    projects: [
      {
        id: 'project',
        label: 'The same website',
        resources: [{ resource: 'plausible_site' }, { resource: 'umami_site' }],
      },
    ],
  });
  const store = await database(c);
  try {
    for (const r of c.resources) {
      const owner = crypto.randomUUID();
      const key = `${r.id}:traffic`;
      assert.equal(await store.acquire(key, owner), true);
      const run = await store.begin(r, 'traffic', period, new Date('2026-10-14T12:00:00Z'));
      const rows =
        r.provider === 'plausible'
          ? [
              { metric: 'plausible.pageviews', value: 100 },
              { metric: 'plausible.visitors_daily', value: 80 },
            ]
          : [
              { metric: 'umami.pageviews', value: 90 },
              { metric: 'umami.sessions_daily', value: 75 },
            ];
      const payload = rows.map(({ metric, value }) => ({
        metric,
        value,
        from: period.from,
        to: period.from,
        timezone: 'UTC',
        kind: 'daily' as const,
        dimensions: {},
        quality: 'observed' as const,
        methodology: r.provider + '-test-v1',
      }));
      await store.publish(
        run,
        r,
        'traffic',
        collected(period, payload),
        key,
        owner,
        1,
        new Date('2026-10-14T12:00:00Z'),
        50,
      );
      await store.release(key, owner);
    }
    const report = await projectReport(
      c,
      store,
      'project',
      period,
      new Date('2026-10-14T12:00:00Z'),
    );
    const pageviewCards = report.cards.filter((x) => x.metric.endsWith('.pageviews'));
    assert.equal(pageviewCards.length, 2);
    assert.deepEqual(
      pageviewCards.map((c) => [c.resourceId, c.value]),
      [
        ['plausible_site', 100],
        ['umami_site', 90],
      ],
    );
    assert.equal(
      report.cards.some((c) => c.value === 190),
      false,
    );
    assert.equal(report.evidence.humanAudience, 'not_measured');
    assert.equal(report.evidence.automatedShare, 'not_measured');
  } finally {
    store.driver.close?.();
  }
});
