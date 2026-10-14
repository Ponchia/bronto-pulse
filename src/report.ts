import { type Binding, type Config, type Resource, pathMatches } from './config.js';
import { groups } from './collectors/index.js';
import {
  METRICS,
  canonicalDimensions,
  type MetricDefinition,
  type StoredObservation,
  type Quality,
} from './model.js';
import { PulseError } from './errors.js';
import { days, previous, range, type DateRange } from './time.js';
import { Store } from './storage/store.js';
export interface Point {
  date: string;
  value: number;
  quality: Quality;
  from: string;
  to: string;
}
export interface MetricCard {
  key: string;
  resourceId: string;
  provider: string;
  metric: string;
  label: string;
  unit: string;
  aggregation: MetricDefinition['aggregation'];
  dimensions: Record<string, string>;
  timezone: string;
  methodology: string;
  value: number | null;
  latestValue: number | null;
  latestPeriod: DateRange | null;
  coverage: {
    observedDays: number;
    expectedDays: number;
    missingDays: string[];
    status: 'complete' | 'partial' | 'unavailable';
    qualities: Quality[];
  };
  points: Point[];
  caveat: string;
  comparison: {
    previousValue: number | null;
    absoluteChange: number | null;
    relativeChange: number | null;
    reason: string;
  };
}
export interface ProjectReport {
  schemaVersion: 1;
  project: { id: string; label: string; description: string };
  window: DateRange;
  generatedAt: string;
  demo: boolean;
  cards: MetricCard[];
  breakdowns: {
    resourceId: string;
    group: string;
    metric: string;
    period: DateRange;
    dimensions: Record<string, string>;
    value: number;
    quality: Quality;
  }[];
  annotations: Awaited<ReturnType<Store['annotations']>>;
  warnings: string[];
}
function allowed(o: StoredObservation, b: Binding): boolean {
  if ((b.effectiveFrom && o.from < b.effectiveFrom) || (b.effectiveTo && o.to > b.effectiveTo))
    return false;
  if (b.scope?.hostname && o.dimensions.hostname !== b.scope.hostname) return false;
  return (
    !b.scope?.pathPrefix ||
    (!!o.dimensions.path && pathMatches(o.dimensions.path, b.scope.pathPrefix))
  );
}
function primaryGroups(r: Resource, b: Binding): string[] {
  switch (r.provider) {
    case 'github':
      return ['repository', 'views', 'clones', 'releases'];
    case 'npm':
      return ['downloads'];
    case 'cloudflare':
      return b.scope ? ['pages'] : ['totals', 'performance', 'vitals'];
    case 'gsc':
      return b.scope ? ['pages'] : ['totals'];
    case 'sense6':
      return ['activity'];
  }
}
const groupMetrics: Record<string, string[]> = {
  'github:repository': ['github.stars', 'github.forks', 'github.open_issues'],
  'github:views': ['github.views', 'github.unique_viewers'],
  'github:clones': ['github.clones', 'github.unique_cloners'],
  'npm:downloads': ['npm.downloads'],
  'cloudflare:totals': ['cloudflare.pageviews', 'cloudflare.visits'],
  'cloudflare:pages': ['cloudflare.pageviews'],
  'cloudflare:performance': ['cloudflare.load_p75'],
  'cloudflare:vitals': ['cloudflare.lcp_p75', 'cloudflare.inp_p75', 'cloudflare.cls_p75'],
  'gsc:totals': ['gsc.clicks', 'gsc.impressions', 'gsc.ctr', 'gsc.position'],
  'gsc:pages': ['gsc.clicks', 'gsc.impressions', 'gsc.ctr', 'gsc.position'],
};
function seriesDimensions(o: StoredObservation, b: Binding): Record<string, string> {
  if (o.metric === 'github.release_downloads' || (o.resourceId && o.metric.startsWith('sense6.')))
    return o.dimensions;
  if (b.scope) {
    const d = { ...o.dimensions };
    delete d.path;
    delete d.hostname;
    return d;
  }
  return o.dimensions;
}
function aggregate(rows: StoredObservation[], definition: MetricDefinition): number | null {
  if (!rows.length) return null;
  if (definition.aggregation === 'none') return null;
  if (definition.aggregation === 'latest')
    return rows.toSorted(
      (a, b) => b.to.localeCompare(a.to) || b.collectedAt.localeCompare(a.collectedAt),
    )[0]!.value;
  if (definition.aggregation === 'sum') return rows.reduce((total, row) => total + row.value, 0);
  const denominator = rows.reduce((total, row) => total + (row.denominator ?? 0), 0);
  return denominator > 0
    ? rows.reduce((total, row) => total + (row.numerator ?? 0), 0) / denominator
    : null;
}
function summarize(
  resource: Resource,
  binding: Binding,
  metric: string,
  rows: StoredObservation[],
  window: DateRange,
  dimensions: Record<string, string>,
  methodology: string,
): MetricCard {
  const definition = METRICS[metric]!;
  const from =
    binding.effectiveFrom && binding.effectiveFrom > window.from
      ? binding.effectiveFrom
      : window.from;
  const to =
    binding.effectiveTo && binding.effectiveTo < window.to ? binding.effectiveTo : window.to;
  const expected = from <= to ? days({ from, to }) : [];
  const seen = new Set(rows.map((x) => x.to));
  const missing = expected.filter((d) => !seen.has(d));
  const byDay = new Map<string, StoredObservation[]>();
  for (const row of rows) {
    const items = byDay.get(row.to) ?? [];
    items.push(row);
    byDay.set(row.to, items);
  }
  const points = [...byDay]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({
      date,
      value:
        definition.aggregation === 'none'
          ? values[0]!.value
          : (aggregate(values, definition) ?? values[0]!.value),
      quality: values.find((x) => x.quality !== 'observed')?.quality ?? 'observed',
      from: values[0]!.from,
      to: values[0]!.to,
    }));
  const latest = points.at(-1);
  const qualities = [...new Set(rows.map((x) => x.quality))];
  return {
    key: JSON.stringify([resource.id, metric, canonicalDimensions(dimensions), methodology]),
    resourceId: resource.id,
    provider: resource.provider,
    metric,
    label: definition.label,
    unit: definition.unit,
    aggregation: definition.aggregation,
    dimensions,
    timezone: rows[0]?.timezone ?? (resource.provider === 'gsc' ? 'America/Los_Angeles' : 'UTC'),
    methodology,
    value: aggregate(rows, definition),
    latestValue: latest?.value ?? null,
    latestPeriod: latest ? { from: latest.from, to: latest.to } : null,
    coverage: {
      observedDays: seen.size,
      expectedDays: expected.length,
      missingDays: missing,
      status: !rows.length
        ? 'unavailable'
        : missing.length && definition.aggregation !== 'latest'
          ? 'partial'
          : 'complete',
      qualities,
    },
    points,
    caveat: definition.caveat,
    comparison: {
      previousValue: null,
      absoluteChange: null,
      relativeChange: null,
      reason: 'Not compared.',
    },
  };
}
function buildCards(
  r: Resource,
  b: Binding,
  rows: StoredObservation[],
  window: DateRange,
): MetricCard[] {
  const accepted = rows.filter((o) => allowed(o, b) && primaryGroups(r, b).includes(o.group));
  const buckets = new Map<
    string,
    {
      metric: string;
      dimensions: Record<string, string>;
      methodology: string;
      rows: StoredObservation[];
    }
  >();
  for (const o of accepted) {
    const dimensions = seriesDimensions(o, b);
    const key = JSON.stringify([
      o.metric,
      canonicalDimensions(dimensions),
      o.timezone,
      o.methodology,
    ]);
    const bucket = buckets.get(key) ?? {
      metric: o.metric,
      dimensions,
      methodology: o.methodology,
      rows: [],
    };
    bucket.rows.push(o);
    buckets.set(key, bucket);
  }
  for (const group of primaryGroups(r, b).filter((x) => groups(r).includes(x))) {
    for (const metric of groupMetrics[`${r.provider}:${group}`] ?? []) {
      if (!accepted.some((o) => o.metric === metric))
        buckets.set(metric, { metric, dimensions: {}, methodology: 'unavailable', rows: [] });
    }
  }
  return [...buckets.values()].map((x) =>
    summarize(r, b, x.metric, x.rows, window, x.dimensions, x.methodology),
  );
}
export async function projectReport(
  config: Config,
  store: Store,
  projectId: string,
  window: DateRange,
  now = new Date(),
): Promise<ProjectReport> {
  range(window.from, window.to);
  const project = config.projects.find((x) => x.id === projectId);
  if (!project) throw new PulseError('NOT_FOUND', 'Project was not found.');
  const prior = previous(window),
    cards: MetricCard[] = [],
    breakdowns: ProjectReport['breakdowns'] = [],
    warnings: string[] = [];
  const cache = new Map<string, StoredObservation[]>();
  for (const binding of project.resources) {
    const resource = config.resources.find((r) => r.id === binding.resource)!;
    if (!resource.enabled) {
      warnings.push(`${resource.id}: collection is disabled.`);
      continue;
    }
    let rows = cache.get(resource.id);
    if (!rows) {
      rows = await store.observations(resource.id, { from: prior.from, to: window.to });
      cache.set(resource.id, rows);
    }
    const current = buildCards(
      resource,
      binding,
      rows.filter((o) => o.to >= window.from),
      window,
    );
    const previousCards = buildCards(
      resource,
      binding,
      rows.filter((o) => o.to < window.from),
      prior,
    );
    for (const card of current) {
      const before = previousCards.find((p) => p.key === card.key && p.timezone === card.timezone);
      if (card.aggregation === 'latest')
        card.comparison.reason =
          'Snapshots show the last available total; net change requires an earlier matching snapshot.';
      else if (card.aggregation === 'none')
        card.comparison.reason = 'This metric cannot be combined across source periods.';
      else if (
        before &&
        before.value !== null &&
        card.value !== null &&
        before.coverage.status === 'complete' &&
        card.coverage.status === 'complete' &&
        !card.coverage.qualities.some((x) => x === 'provisional') &&
        !before.coverage.qualities.some((x) => x === 'provisional')
      ) {
        card.comparison = {
          previousValue: before.value,
          absoluteChange: card.value - before.value,
          relativeChange:
            before.value >= 10 && card.aggregation === 'sum'
              ? (card.value - before.value) / before.value
              : null,
          reason:
            before.value < 10
              ? 'Absolute change only: the comparison baseline is small.'
              : 'Same metric, source scope, timezone and duration; correlation is not causation.',
        };
      } else
        card.comparison.reason =
          'Insufficient comparable coverage. Missing or provisional periods are not treated as zero.';
      cards.push(card);
    }
    // Breakdowns are separate dimensions of the same events, never extra totals.
    const details = rows.filter(
      (o) =>
        o.to >= window.from &&
        allowed(o, binding) &&
        ['referrers', 'paths', 'pages', 'queries'].includes(o.group),
    );
    for (const o of details.slice(0, 2000))
      breakdowns.push({
        resourceId: o.resourceId,
        group: o.group,
        metric: o.metric,
        period: { from: o.from, to: o.to },
        dimensions: o.dimensions,
        value: o.value,
        quality: o.quality,
      });
    if (details.length > 2000)
      warnings.push(
        `${resource.id}: report detail display capped at 2,000 observations; stored data remains intact.`,
      );
    if (binding.scope)
      warnings.push(
        `${resource.id}: page-scoped attribution; visits and unique people are not reconstructed across project paths.`,
      );
    if (binding.allowShared)
      warnings.push(
        `${resource.id}: explicitly shared with other projects. Do not sum projects into a portfolio total.`,
      );
    if (current.some((x) => x.coverage.status !== 'complete'))
      warnings.push(
        `${resource.id}: some dates or metrics are unavailable; totals cover only observed buckets.`,
      );
    const runs = await store.runs(100, resource.id);
    for (const group of groups(resource)) {
      const latest = runs.find((x) => x.group === group);
      if (latest?.status === 'failed')
        warnings.push(
          `${resource.id}/${group}: latest refresh failed (${latest.code}); previous valid history is retained.`,
        );
    }
  }
  const duplicate = new Set<string>();
  for (const c of cards) {
    if (duplicate.has(c.key))
      warnings.push(
        'Effective mapping changes produce separate report segments; do not combine non-additive series.',
      );
    duplicate.add(c.key);
  }
  return {
    schemaVersion: 1,
    project: { id: project.id, label: project.label, description: project.description },
    window,
    generatedAt: now.toISOString(),
    demo: config.demo,
    cards,
    breakdowns,
    annotations: await store.annotations(
      [...new Set(project.resources.map((x) => x.resource))],
      window,
    ),
    warnings: [...new Set(warnings)],
  };
}
export async function portfolio(config: Config, store: Store, window: DateRange, now = new Date()) {
  const reports = [];
  for (const p of config.projects)
    reports.push(await projectReport(config, store, p.id, window, now));
  return {
    schemaVersion: 1,
    name: config.name,
    demo: config.demo,
    window,
    generatedAt: now.toISOString(),
    reports,
    warning:
      'Each metric retains its own source, date convention and meaning. There is no universal adoption or unique-user total.',
  };
}
export function markdownReport(report: ProjectReport): string {
  const lines = [
    `# ${report.project.label}`,
    ``,
    `${report.window.from} → ${report.window.to}${report.demo ? ' · SYNTHETIC DEMO' : ''}`,
    '',
    report.project.description,
    '',
    '| Metric | Resource | Value | Coverage |',
    '| --- | --- | ---: | --- |',
  ];
  for (const c of report.cards) {
    const value =
      c.value === null
        ? c.latestValue === null
          ? 'Unavailable'
          : `${c.latestValue} (latest source bucket only)`
        : String(c.value);
    lines.push(
      `| ${c.label.replaceAll('|', '/')} | ${c.resourceId} | ${value} | ${c.coverage.observedDays}/${c.coverage.expectedDays} dates; ${c.coverage.status} |`,
    );
  }
  if (report.warnings.length)
    lines.push('', '## Data quality', ...report.warnings.map((x) => `- ${x}`));
  lines.push('', 'No individual journeys or causal conversions are inferred.');
  return lines.join('\n');
}
