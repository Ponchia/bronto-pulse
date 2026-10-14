import { parseConfig, type Config } from './config.js';
import { Store } from './storage/store.js';
import { entry, collected } from './collectors/context.js';
import { addDays, dateInZone } from './time.js';
import type { Observation } from './model.js';
export function demoConfig(): Config {
  return parseConfig({
    version: 1,
    name: 'Bronto / project observatory',
    demo: true,
    resources: [
      {
        id: 'ui-repo',
        provider: 'github',
        repository: 'example/ui',
        groups: ['repository', 'views', 'clones'],
      },
      { id: 'ui-package', provider: 'npm', package: '@example/ui' },
      {
        id: 'annotations-repo',
        provider: 'github',
        repository: 'example/annotations',
        groups: ['repository', 'views', 'clones'],
      },
      {
        id: 'pages',
        provider: 'cloudflare',
        accountId: '0'.repeat(32),
        siteTag: '1'.repeat(32),
        groups: ['totals', 'pages'],
      },
      { id: 'search', provider: 'gsc', siteUrl: 'sc-domain:example.invalid' },
      {
        id: 'sense6-counters',
        provider: 'sense6',
        accountId: '0'.repeat(32),
        databaseId: '00000000-0000-4000-8000-000000000001',
      },
    ],
    projects: [
      {
        id: 'bronto-ui',
        label: 'Bronto UI',
        description: 'Documentation discovery, repository interest and package distribution.',
        resources: [
          { resource: 'ui-repo' },
          { resource: 'ui-package' },
          { resource: 'pages', scope: { hostname: 'example.github.io', pathPrefix: '/ui/' } },
        ],
      },
      {
        id: 'bronto-annotations',
        label: 'Bronto Annotations',
        description: 'A second project sharing a website property, with distinct path attribution.',
        resources: [
          { resource: 'annotations-repo' },
          {
            resource: 'pages',
            scope: { hostname: 'example.github.io', pathPrefix: '/annotations/' },
          },
        ],
      },
      {
        id: 'sense6',
        label: 'Sense6',
        description: 'Private experiment counters remain distinct from website visitors.',
        resources: [{ resource: 'sense6-counters' }],
      },
      {
        id: 'personal',
        label: 'Personal website',
        description: 'Search discovery without any visitor-level tracking.',
        resources: [{ resource: 'search' }],
      },
    ],
  });
}
export async function seedDemo(store: Store, now = new Date()): Promise<Config> {
  const config = demoConfig();
  await store.register(config, now);
  const today = dateInZone(now),
    from = addDays(today, -60),
    to = addDays(today, -1);
  const publish = async (id: string, group: string, rows: Observation[]) => {
    const r = config.resources.find((x) => x.id === id)!,
      key = `${id}:${group}`,
      owner = crypto.randomUUID();
    if (!(await store.acquire(key, owner))) throw new Error('Demo database busy');
    const run = await store.begin(r, group, { from, to }, now);
    try {
      await store.publish(
        run,
        r,
        group,
        collected({ from, to }, rows, [
          'SYNTHETIC DEMO: generated fixtures, not production metrics.',
        ]),
        key,
        owner,
        0,
        now,
        50000,
      );
    } finally {
      await store.release(key, owner);
    }
  };
  for (const id of ['ui-repo', 'annotations-repo']) {
    const factor = id === 'ui-repo' ? 2 : 1;
    for (const group of ['views', 'clones']) {
      const rows: Observation[] = [];
      for (let i = 0; i < 60; i++) {
        if (id === 'annotations-repo' && i >= 53 && i <= 55) continue;
        const date = addDays(from, i),
          n = Math.round(
            (group === 'views' ? 12 : 50) * factor +
              (i > 40 ? factor * 7 : 0) +
              Math.sin(i * 1.8) * factor * 4,
          );
        rows.push(
          entry(`github.${group}`, date, n),
          entry(
            group === 'views' ? 'github.unique_viewers' : 'github.unique_cloners',
            date,
            Math.round(n * 0.63),
          ),
        );
      }
      await publish(id, group, rows);
    }
    const snapshots = Array.from({ length: 60 }, (_, i) => ({
      ...entry('github.stars', addDays(from, i), 10 * factor + Math.floor(i * 0.6 * factor)),
      kind: 'snapshot' as const,
    }));
    await publish(id, 'repository', snapshots);
  }
  await publish(
    'ui-package',
    'downloads',
    Array.from({ length: 60 }, (_, i) =>
      entry(
        'npm.downloads',
        addDays(from, i),
        Math.round(140 + i * 2 + (i > 40 ? 80 : 0) + Math.sin(i * 0.9) * 32),
      ),
    ),
  );
  const pages: Observation[] = [];
  for (let i = 0; i < 60; i++)
    for (const [path, factor] of [
      ['/ui/', 3],
      ['/ui/guide', 2],
      ['/annotations/', 1],
    ] as const)
      pages.push(
        entry(
          'cloudflare.pageviews',
          addDays(from, i),
          Math.round(10 * factor + Math.sin(i) * 3 + (i > 40 ? factor * 3 : 0)),
          { hostname: 'example.github.io', path },
          i === 58 ? 'sampled' : 'observed',
          'cf-rum-pageload-count-v1',
        ),
      );
  await publish('pages', 'pages', pages);
  const search: Observation[] = [];
  for (let i = 0; i < 60; i++) {
    const date = addDays(from, i),
      clicks = 6 + Math.floor(i / 6),
      impressions = 100 + i * 4;
    const dims = { searchType: 'web', aggregation: 'byProperty' };
    for (const [key, value] of [
      ['clicks', clicks],
      ['impressions', impressions],
    ] as const)
      search.push({ ...entry(`gsc.${key}`, date, value, dims), timezone: 'America/Los_Angeles' });
    search.push({
      ...entry('gsc.ctr', date, clicks / impressions, dims),
      timezone: 'America/Los_Angeles',
      numerator: clicks,
      denominator: impressions,
    });
  }
  await publish('search', 'totals', search);
  const counters: Observation[] = [];
  for (let i = 0; i < 60; i++)
    for (const [metric, n] of [
      ['test_started', 20],
      ['test_completed', 14],
    ] as const)
      counters.push(entry(`sense6.${metric}`, addDays(from, i), n + (i % 7), { test: 'riflessi' }));
  await publish('sense6-counters', 'activity', counters);
  const release = {
    id: 'demo-release-ui',
    resourceId: 'ui-repo',
    date: addDays(from, 40),
    title: 'v0.3.0 release (synthetic)',
    kind: 'release' as const,
  };
  const existing = await store.annotations(['ui-repo'], { from, to });
  if (!existing.some((x) => x.id === release.id)) await store.addAnnotation(release);
  return config;
}
