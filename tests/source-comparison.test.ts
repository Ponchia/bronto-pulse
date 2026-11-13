import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareWebsiteSources } from '../src/source-comparison.js';
import type { MetricCard } from '../src/report.js';
import { parseConfig } from '../src/config.js';
import { database, now } from './helpers.js';
import { collected } from '../src/collectors/context.js';
import { handle, type ApiContext } from '../src/api/handler.js';
import { days } from '../src/time.js';

const window = { from: '2026-10-12', to: '2026-10-13' };
type Options = Partial<MetricCard>;

function card(
  resourceId: string,
  provider: 'cloudflare' | 'plausible' | 'umami',
  amount: number,
  patch: Options = {},
): MetricCard {
  const points = days(window).map((date) => ({
    date,
    from: date,
    to: date,
    quality: 'observed' as const,
    value: amount / 2,
  }));
  return {
    key: resourceId + ':pageviews',
    resourceId,
    provider,
    metric: provider + '.pageviews',
    evidenceClass: 'discovery',
    label: 'Pageviews',
    unit: 'pageviews',
    aggregation: 'sum',
    dimensions: {},
    timezone: 'UTC',
    methodology: provider + '-source-v1',
    scope: {},
    latestCollectedAt: '2026-10-14T00:00:00Z',
    value: amount,
    latestValue: amount / 2,
    latestPeriod: { from: window.to, to: window.to },
    points,
    coverage: {
      observedDays: 2,
      expectedDays: 2,
      missingDays: [],
      status: 'complete',
      qualities: ['observed'],
    },
    caveat: 'Source-native numbers are not deduplicated.',
    comparison: {
      previousValue: null,
      absoluteChange: null,
      relativeChange: null,
      reason: 'Synthetic test',
      kind: null,
      baselinePeriod: null,
    },
    ...patch,
  };
}
function report(a: MetricCard, b: MetricCard) {
  return { window, cards: [a, b] };
}

test('two provider totals require explicit same-site confirmation and never invent audience', () => {
  const r = report(card('cf', 'cloudflare', 100), card('pl', 'plausible', 80));
  const original = structuredClone(r);
  const without = compareWebsiteSources(r, 'cf', 'pl');
  assert.equal(without.status, 'needs_confirmation');
  assert.equal(without.difference, null);
  assert.equal(without.sources[0]!.value, 100);
  const confirmed = compareWebsiteSources(r, 'cf', 'pl', true);
  assert.equal(confirmed.status, 'side_by_side');
  assert.deepEqual(confirmed.difference, { absolute: -20, percentOfPrimary: -0.2 });
  assert.deepEqual(r, original);
  assert.match(confirmed.limitation, /Never add provider totals together/);
  assert.equal(confirmed.schemaVersion, 1);
});
test('different source timezones, scopes, dimensions and incomplete coverage do not create a difference', () => {
  const a = card('cf', 'cloudflare', 100);
  const cases = [
    card('pl', 'plausible', 80, { timezone: 'Europe/Madrid' }),
    card('pl', 'plausible', 80, { scope: { pathPrefix: '/docs' } }),
    card('pl', 'plausible', 80, { dimensions: { device: 'mobile' } }),
    card('pl', 'plausible', 80, {
      coverage: {
        observedDays: 1,
        expectedDays: 2,
        missingDays: ['2026-10-13'],
        status: 'partial',
        qualities: ['observed'],
      },
    }),
    card('pl', 'plausible', 80, {
      coverage: {
        observedDays: 2,
        expectedDays: 2,
        missingDays: [],
        status: 'complete',
        qualities: ['sampled'],
      },
    }),
    card('pl', 'plausible', 80, {
      points: [
        {
          date: '2026-10-12',
          from: '2026-10-12',
          to: '2026-10-12',
          value: 40,
          quality: 'observed',
        },
      ],
    }),
    card('pl', 'plausible', 80, {
      points: [
        {
          date: '2026-10-12',
          from: '2026-10-12',
          to: '2026-10-12',
          value: 30,
          quality: 'observed',
        },
        {
          date: '2026-10-13',
          from: '2026-10-13',
          to: '2026-10-13',
          value: 20,
          quality: 'observed',
        },
      ],
    }),
  ];
  for (const b of cases) {
    const result = compareWebsiteSources(report(a, b), 'cf', 'pl', true);
    assert.equal(result.status, 'incompatible', JSON.stringify(b));
    assert.equal(result.difference, null);
  }
});
test('missing, ambiguous, unsupported metrics and unsafe selectors fail closed', () => {
  const a = card('a', 'cloudflare', 100),
    b = card('b', 'umami', 80);
  assert.equal(compareWebsiteSources({ window, cards: [a] }, 'a', 'b', true).status, 'unavailable');
  assert.equal(
    compareWebsiteSources(
      { window, cards: [a, b, { ...a, methodology: 'second' }] },
      'a',
      'b',
      true,
    ).status,
    'unavailable',
  );
  assert.equal(
    compareWebsiteSources(
      { window, cards: [a, { ...b, metric: 'umami.sessions_daily' }] },
      'a',
      'b',
      true,
    ).status,
    'unavailable',
  );
  for (const ids of [
    ['a', 'a'],
    ['A', 'b'],
    ['a/../../b', 'b'],
    ['', 'b'],
  ])
    assert.throws(
      () => compareWebsiteSources(report(a, b), ids[0]!, ids[1]!, true),
      /distinct, valid/,
    );
});
test('small/zero baseline does not invent an unstable relative percentage', () => {
  const x = card('a', 'cloudflare', 0),
    y = card('b', 'umami', 20);
  assert.deepEqual(compareWebsiteSources(report(x, y), 'a', 'b', true).difference, {
    absolute: 20,
    percentOfPrimary: null,
  });
  assert.equal(
    compareWebsiteSources(
      report(card('a', 'cloudflare', 8), card('b', 'umami', 10)),
      'a',
      'b',
      true,
    ).difference?.percentOfPrimary,
    null,
  );
});

test('API comparison is authenticated, bounded, read-only and preserves source reports', async () => {
  const config = parseConfig({
    version: 1,
    resources: [
      {
        id: 'pl',
        provider: 'plausible',
        siteId: 'same.example.test',
        timezone: 'UTC',
        connection: 'p',
      },
      { id: 'um', provider: 'umami', websiteId: 'same-web', connection: 'u' },
    ],
    connections: [
      { id: 'p', provider: 'plausible', tokenEnv: 'P_TOKEN' },
      { id: 'u', provider: 'umami', tokenEnv: 'U_TOKEN' },
    ],
    projects: [
      { id: 'project', label: 'Project', resources: [{ resource: 'pl' }, { resource: 'um' }] },
    ],
  });
  const store = await database(config);
  const token = 'strong-test-access-token-0123456789';
  const api: ApiContext = {
    config,
    store,
    secrets: {},
    apiToken: token,
    asset: async () => new Response('unused'),
    now: () => now,
  };
  const endpoint =
    'https://pulse.example/api/v1/projects/project/source-comparison?from=2026-10-12&to=2026-10-13&primary=pl&secondary=um';
  const req = (path: string, auth = true) =>
    new Request(path, { headers: auth ? { Authorization: 'Bearer ' + token } : {} });
  try {
    for (const resource of config.resources) {
      const group = 'traffic',
        key = resource.id + ':' + group,
        owner = crypto.randomUUID();
      assert.equal(await store.acquire(key, owner), true);
      const run = await store.begin(resource, group, window, now);
      const pviews = resource.provider === 'plausible' ? 'plausible.pageviews' : 'umami.pageviews';
      const pageviews = days(window).map((date) => ({
        metric: pviews,
        from: date,
        to: date,
        timezone: 'UTC',
        kind: 'daily' as const,
        value: resource.provider === 'plausible' ? 50 : 40,
        dimensions: {},
        quality: 'observed' as const,
        methodology: resource.provider + '-test-v1',
      }));
      await store.publish(
        run,
        resource,
        group,
        collected(window, pageviews),
        key,
        owner,
        1,
        now,
        50,
      );
      await store.release(key, owner);
    }
    assert.equal((await handle(req(endpoint, false), api)).status, 401);
    const unconfirmed = await handle(req(endpoint), api);
    assert.equal(unconfirmed.status, 200);
    assert.equal((await unconfirmed.json()).difference, null);
    const confirmed = await handle(req(endpoint + '&same_site=confirmed'), api);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.headers.get('cache-control'), 'no-store');
    const result = await confirmed.json();
    assert.equal(result.status, 'side_by_side');
    assert.deepEqual(result.difference, { absolute: -20, percentOfPrimary: -0.2 });
    assert.equal((await handle(req(endpoint + '&same_site=yes'), api)).status, 400);
    assert.equal(
      (
        await handle(
          req(endpoint.replace('secondary=um', 'secondary=unknown') + '&same_site=confirmed'),
          api,
        )
      ).status,
      200,
    );
    assert.equal((await store.runs()).length, 2, 'comparisons never trigger collections');
  } finally {
    store.driver.close?.();
  }
});
