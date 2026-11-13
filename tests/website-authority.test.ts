import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfig,
  assertHistoricalMappings,
  type Config,
  type WebsitePolicy,
} from '../src/config.js';
import { websiteAuthorities } from '../src/website-authority.js';
import type { MetricCard } from '../src/report.js';
import { projectReport, markdownReport } from '../src/report.js';
import { projectBrief, markdownBrief } from '../src/brief.js';
import { collected, entry } from '../src/collectors/context.js';
import { days } from '../src/time.js';
import { database, fixture } from './helpers.js';

const window = { from: '2026-10-12', to: '2026-10-13' };
const ref = () => ({
  id: 'main_site',
  hostname: 'example.org',
  sources: ['cf', 'pl', 'um'],
  pageviewsAuthority: [
    { resource: 'cf', effectiveFrom: '2026-10-01' },
    { resource: 'pl', effectiveFrom: '2026-10-15' },
  ],
});

function config(modify?: (input: Record<string, unknown>) => void): Config {
  const input: Record<string, unknown> = {
    version: 1,
    resources: [
      {
        id: 'cf',
        provider: 'cloudflare',
        accountId: 'a'.repeat(32),
        siteTag: 'b'.repeat(32),
        hostname: 'example.org',
        groups: ['totals'],
        connection: 'cf_key',
      },
      {
        id: 'pl',
        provider: 'plausible',
        siteId: 'example.org',
        timezone: 'UTC',
        connection: 'pl_key',
      },
      {
        id: 'um',
        provider: 'umami',
        websiteId: 'website-123',
        connection: 'um_key',
      },
    ],
    connections: [
      { id: 'cf_key', provider: 'cloudflare', tokenEnv: 'CF_TOKEN' },
      { id: 'pl_key', provider: 'plausible', tokenEnv: 'PL_TOKEN' },
      { id: 'um_key', provider: 'umami', tokenEnv: 'UM_TOKEN' },
    ],
    projects: [
      {
        id: 'project',
        label: 'Example',
        resources: [{ resource: 'cf' }, { resource: 'pl' }, { resource: 'um' }],
        websites: [ref()],
      },
    ],
  };
  modify?.(input);
  return parseConfig(input);
}

function mutate(config: Config, f: (site: WebsitePolicy) => void): Config {
  const copy = structuredClone(config);
  f(copy.projects[0]!.websites![0]!);
  return copy;
}

function sample(
  source: 'cf' | 'pl' | 'um',
  perDay = 10,
  changes: Partial<MetricCard> = {},
): MetricCard {
  const metric = {
    cf: 'cloudflare.pageviews',
    pl: 'plausible.pageviews',
    um: 'umami.pageviews',
  }[source];
  const provider = { cf: 'cloudflare', pl: 'plausible', um: 'umami' }[source];
  return {
    key: source,
    resourceId: source,
    provider,
    metric,
    evidenceClass: 'discovery',
    label: 'Pageviews',
    unit: 'pageviews',
    aggregation: 'sum',
    dimensions: {},
    timezone: 'UTC',
    methodology: provider + '-native-v1',
    scope: {},
    latestCollectedAt: '2026-10-14T10:00:00Z',
    value: perDay * 2,
    latestValue: perDay,
    latestPeriod: { from: window.to, to: window.to },
    coverage: {
      observedDays: 2,
      expectedDays: 2,
      missingDays: [],
      status: 'complete',
      qualities: ['observed'],
    },
    points: days(window).map((d) => ({
      date: d,
      from: d,
      to: d,
      value: perDay,
      quality: 'observed',
    })),
    caveat: '',
    comparison: {
      previousValue: null,
      absoluteChange: null,
      relativeChange: null,
      reason: 'No prior evidence',
      kind: null,
      baselinePeriod: null,
    },
    ...changes,
  };
}

test('site identity is explicit, opt-in and validated against real resources', () => {
  const c = config();
  assert.equal(c.projects[0]!.websites?.[0]?.hostname, 'example.org');
  assert.equal(fixture('npm').projects[0]!.websites, undefined);
  const invalidCases: ((p: Config) => void)[] = [
    (p) => p.projects[0]!.websites![0]!.sources.push('cf'),
    (p) => p.projects[0]!.websites![0]!.sources.push('unknown'),
    (p) => p.projects[0]!.websites![0]!.sources.push('repo'),
    (p) => (p.projects[0]!.websites![0]!.pageviewsAuthority![0]!.resource = 'unknown'),
    (p) => (p.projects[0]!.websites![0]!.pageviewsAuthority![1]!.effectiveFrom = '2026-09-01'),
    (p) =>
      p.projects[0]!.websites![0]!.pageviewsAuthority!.push({
        resource: 'pl',
        effectiveFrom: '2026-10-16',
      }),
    (p) => (p.projects[0]!.websites![0]!.hostname = 'wrong.example.org'),
    (p) => (p.projects[0]!.websites![0]!.hostname = '127.0.0.1'),
    (p) => p.projects[0]!.resources.pop(),
    (p) =>
      p.projects[0]!.websites!.push({
        ...structuredClone(ref()),
        id: 'another',
        hostname: 'another.example.org',
      }),
  ];
  for (const apply of invalidCases) {
    const altered = structuredClone(c);
    apply(altered);
    assert.throws(() => parseConfig(altered));
  }
  const scoped = structuredClone(c);
  scoped.projects[0]!.resources[0]!.scope = { hostname: 'example.org' };
  assert.throws(() => parseConfig(scoped), /unscoped binding/);
});

test('previous site authority cannot be backdated or removed after history exists', () => {
  const c = config();
  const date = '2026-11-13';
  assert.doesNotThrow(() => assertHistoricalMappings(c, c, date));
  const future = mutate(c, (w) =>
    w.pageviewsAuthority!.push({ resource: 'um', effectiveFrom: '2026-11-14' }),
  );
  assert.doesNotThrow(() => assertHistoricalMappings(c, parseConfig(future), date));
  const backdated = mutate(c, (w) =>
    w.pageviewsAuthority!.push({ resource: 'um', effectiveFrom: '2026-11-12' }),
  );
  assert.throws(() => assertHistoricalMappings(c, parseConfig(backdated), date), /retroactively/);
  const replaced = mutate(c, (w) => {
    w.pageviewsAuthority![0]!.resource = 'um';
  });
  assert.throws(() => assertHistoricalMappings(c, parseConfig(replaced), date), /retroactively/);
  const siteDeleted = structuredClone(c);
  siteDeleted.projects[0]!.websites = undefined;
  assert.throws(() => assertHistoricalMappings(c, parseConfig(siteDeleted), date), /remain stable/);
  const withoutSite = structuredClone(c);
  withoutSite.projects[0]!.websites = undefined;
  const addOldSite = parseConfig(withoutSite);
  assert.throws(() => assertHistoricalMappings(addOldSite, c, date), /must begin on or after/);
  const addFutureSite = mutate(c, (w) => {
    w.pageviewsAuthority = [
      { resource: 'cf', effectiveFrom: '2026-11-13' },
      { resource: 'pl', effectiveFrom: '2026-11-15' },
    ];
  });
  assert.doesNotThrow(() => assertHistoricalMappings(addOldSite, parseConfig(addFutureSite), date));
  const membershipLost = mutate(c, (w) => {
    w.sources = ['cf', 'pl'];
  });
  assert.throws(
    () => assertHistoricalMappings(c, parseConfig(membershipLost), date),
    /membership must remain/,
  );
});

test('date-scoped preferred pageviews never sum independent providers', () => {
  const sites = config().projects[0]!.websites!;
  const cards = [sample('cf', 100), sample('pl', 90), sample('um', 85)];
  const original = structuredClone(cards);
  const ready = websiteAuthorities(sites, cards, window)[0]!;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.source, 'cf');
  assert.equal(ready.value, 200);
  assert.equal(ready.metric, 'cloudflare.pageviews');
  assert.deepEqual(
    ready.alternatives.map((x) => x.observedValue),
    [200, 180, 170],
  );
  assert.equal(
    ready.alternatives.some((x) => x.observedValue === 550),
    false,
  );
  assert.deepEqual(cards, original, 'analysis must not rewrite source observations');
  assert.match(ready.limitation, /never summed/);
  const next = websiteAuthorities(sites, cards, { from: '2026-10-14', to: '2026-10-16' })[0]!;
  assert.equal(next.status, 'changed_during_period');
  assert.equal(next.source, null);
  assert.equal(next.value, null);
  const unselected = websiteAuthorities(sites, cards, { from: '2026-09-15', to: '2026-09-16' })[0]!;
  assert.equal(unselected.status, 'not_selected');
  assert.equal(unselected.value, null);
});

test('partial, sampled and ambiguous chosen sources never fall back to another provider', () => {
  const sites = config().projects[0]!.websites!;
  const alternatives = [sample('pl', 90), sample('um', 85)];
  const bad: MetricCard[] = [
    sample('cf', 100, {
      coverage: {
        observedDays: 1,
        expectedDays: 2,
        missingDays: ['2026-10-13'],
        status: 'partial',
        qualities: ['observed'],
      },
    }),
    sample('cf', 100, {
      coverage: {
        observedDays: 2,
        expectedDays: 2,
        missingDays: [],
        status: 'complete',
        qualities: ['sampled'],
      },
    }),
    sample('cf', 100, {
      points: [
        {
          date: '2026-10-12',
          from: '2026-10-12',
          to: '2026-10-12',
          value: 100,
          quality: 'observed',
        },
      ],
    }),
    sample('cf', 100, { value: 199 }),
  ];
  for (const preferred of bad) {
    const result = websiteAuthorities(sites, [preferred, ...alternatives], window)[0]!;
    assert.equal(result.status, 'unavailable');
    assert.equal(result.value, null);
    assert.equal(result.source, 'cf');
    assert.equal(result.alternatives[1]!.observedValue, 180);
  }
  assert.equal(
    websiteAuthorities(sites, [sample('cf', 100), sample('cf', 90), ...alternatives], window)[0]!
      .status,
    'unavailable',
  );
  assert.equal(websiteAuthorities(sites, [sample('cf', 0), ...alternatives], window)[0]!.value, 0);
});

test('project report attaches website policy without changing existing report schema or running extra collectors', async () => {
  const c = config();
  const store = await database(c);
  const now = new Date('2026-10-14T12:00:00Z');
  try {
    for (const r of c.resources) {
      const group = r.provider === 'cloudflare' ? 'totals' : 'traffic';
      const key = r.id + ':' + group;
      const owner = crypto.randomUUID();
      assert.equal(await store.acquire(key, owner), true);
      const run = await store.begin(r, group, window, now);
      const metric =
        r.provider === 'cloudflare'
          ? 'cloudflare.pageviews'
          : r.provider === 'plausible'
            ? 'plausible.pageviews'
            : 'umami.pageviews';
      const perDay = r.id === 'cf' ? 100 : r.id === 'pl' ? 90 : 85;
      const payload = days(window).map((date) => ({
        ...entry(metric, date, perDay, {}, 'observed', r.provider + '-test-v1'),
        timezone: 'UTC',
      }));
      await store.publish(run, r, group, collected(window, payload), key, owner, 1, now, 50);
      await store.release(key, owner);
    }
    const before = (await store.runs()).length;
    const report = await projectReport(c, store, 'project', window, now);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.websites?.length, 1);
    assert.equal(report.websites![0]!.value, 200);
    assert.equal(report.cards.filter((x) => x.metric.endsWith('.pageviews')).length, 3);
    assert.equal(
      report.cards.some((x) => x.value === 550),
      false,
    );
    assert.equal((await store.runs()).length, before);
    assert.match(markdownReport(report), /Declared website source preferences/);
    const capped = projectBrief(report, 1);
    assert.equal(capped.websites?.[0]?.source, 'cf');
    assert.equal(capped.websites?.[0]?.value, 200);
    assert.match(markdownBrief(capped), /Declared website sources/);
    assert.match(markdownBrief(capped), /pageviews 200/);
    const legacyConfig = fixture('npm');
    const legacyStore = await database(legacyConfig);
    try {
      const old = await projectReport(legacyConfig, legacyStore, 'project', window, now);
      assert.equal(old.websites, undefined);
    } finally {
      legacyStore.driver.close?.();
    }
  } finally {
    store.driver.close?.();
  }
});

test('persisted history refuses a newly backdated website preference and retains source records', async () => {
  const withWebsite = config();
  const baseline = structuredClone(withWebsite);
  baseline.projects[0]!.websites = undefined;
  const store = await database(baseline);
  const now = new Date('2026-10-14T12:00:00Z');
  try {
    const cf = baseline.resources.find((r) => r.id === 'cf')!;
    const owner = crypto.randomUUID();
    const key = 'cf:totals';
    assert.equal(await store.acquire(key, owner), true);
    const run = await store.begin(cf, 'totals', window, now);
    const rows = days(window).map((date) =>
      entry('cloudflare.pageviews', date, 7, {}, 'observed', 'cf-totals-test-v1'),
    );
    await store.publish(run, cf, 'totals', collected(window, rows), key, owner, 1, now, 50);
    await store.release(key, owner);
    const before = await store.observations('cf', window);
    assert.equal(before.length, 2);

    await assert.rejects(
      store.register(withWebsite, new Date('2026-11-13T12:00:00Z')),
      /New website pageview authority must begin/,
    );
    assert.equal((await store.getConfig())!.projects[0]!.websites, undefined);
    assert.deepEqual(await store.observations('cf', window), before);

    const future = mutate(withWebsite, (site) => {
      site.pageviewsAuthority = [{ resource: 'cf', effectiveFrom: '2026-11-13' }];
    });
    await store.register(parseConfig(future), new Date('2026-11-13T12:00:00Z'));
    const report = await projectReport(parseConfig(future), store, 'project', window, now);
    assert.equal(report.websites![0]!.status, 'not_selected');
    assert.equal(report.websites![0]!.value, null);
    assert.equal((await store.runs()).length, 1);
    assert.deepEqual(await store.observations('cf', window), before);
  } finally {
    store.driver.close?.();
  }
});
