import type { DateRange } from './time.js';
export type Quality = 'observed' | 'provisional' | 'sampled' | 'provider_limited' | 'top_n';
export type WindowKind = 'daily' | 'rolling' | 'snapshot';
export type Dimensions = Record<string, string>;
export interface Observation {
  metric: string;
  from: string;
  to: string;
  timezone: string;
  kind: WindowKind;
  dimensions: Dimensions;
  value: number;
  numerator?: number;
  denominator?: number;
  quality: Quality;
  methodology: string;
}
export interface Annotation {
  id: string;
  resourceId: string;
  date: string;
  title: string;
  url?: string;
  kind: 'release' | 'note';
}
export interface Collected {
  observations: Observation[];
  annotations?: Annotation[];
  range: DateRange;
  notes: string[];
  completeness: 'complete' | 'provider_limited' | 'top_n';
  identity?: string;
}
export interface StoredObservation extends Observation {
  resourceId: string;
  group: string;
  collectedAt: string;
  runId: string;
}
export interface Run {
  id: string;
  resourceId: string;
  group: string;
  from: string;
  to: string;
  status: 'running' | 'success' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  rows: number;
  requests: number;
  code: string | null;
  message: string | null;
  notes: string[];
  completeness: Collected['completeness'] | null;
}
export interface MetricDefinition {
  key: string;
  label: string;
  unit: string;
  aggregation: 'sum' | 'latest' | 'none' | 'weighted_mean' | 'ratio';
  caveat: string;
}
const m = (
  key: string,
  label: string,
  unit: string,
  aggregation: MetricDefinition['aggregation'],
  caveat = '',
): MetricDefinition => ({ key, label, unit, aggregation, caveat });
export const METRICS: Readonly<Record<string, MetricDefinition>> = Object.freeze(
  Object.fromEntries(
    [
      m('github.views', 'Repository views', 'views', 'sum'),
      m(
        'github.unique_viewers',
        'Unique viewers within each source day',
        'viewers',
        'none',
        'Daily unique counts cannot be added into period-wide unique people.',
      ),
      m(
        'github.clones',
        'Repository clones',
        'clones',
        'sum',
        'Includes automation; not an adoption or people count.',
      ),
      m(
        'github.unique_cloners',
        'Unique cloners within each source day',
        'cloners',
        'none',
        'No deduplication across dates or repositories.',
      ),
      m(
        'github.stars',
        'Stars at collection',
        'stars',
        'latest',
        'A snapshot. Differences are net changes, not gross new stargazers.',
      ),
      m('github.forks', 'Forks at collection', 'forks', 'latest'),
      m(
        'github.open_issues',
        'Open issues and pull requests',
        'items',
        'latest',
        'GitHub open_issues_count includes pull requests.',
      ),
      m(
        'github.referral_views',
        'Top-ten referrer views, rolling 14 days',
        'views',
        'none',
        'Overlapping rolling snapshots must never be added together.',
      ),
      m(
        'github.path_views',
        'Top-ten repository paths, rolling 14 days',
        'views',
        'none',
        'Top ten only; not a daily or complete path series.',
      ),
      m(
        'github.release_downloads',
        'Release asset downloads at collection',
        'downloads',
        'latest',
        'Snapshot per asset; includes automated downloads.',
      ),
      m(
        'npm.downloads',
        'Package downloads',
        'downloads',
        'sum',
        'Includes CI, repeat installations and automated downloads. Not unique users.',
      ),
      m(
        'cloudflare.pageviews',
        'Website pageviews',
        'pageviews',
        'sum',
        'Provider-reported RUM; blocked beacons and bots affect coverage. Sampling metadata is preserved, never scaled blindly.',
      ),
      m(
        'cloudflare.visits',
        'Website visits (Cloudflare definition)',
        'visits',
        'sum',
        'External/direct entrances under the provider definition, not unique people or per-project sessions.',
      ),
      m(
        'cloudflare.load_p75',
        'Page load time p75',
        'ms',
        'none',
        'Percentiles across days cannot be averaged into a period percentile.',
      ),
      m(
        'cloudflare.lcp_p75',
        'Largest Contentful Paint p75',
        'ms',
        'none',
        'Only sample-supported field measurements. Daily percentiles are non-additive.',
      ),
      m(
        'cloudflare.inp_p75',
        'Interaction to Next Paint p75',
        'ms',
        'none',
        'No sample is unavailable, not zero.',
      ),
      m('cloudflare.cls_p75', 'Cumulative Layout Shift p75', 'score', 'none'),
      m(
        'gsc.clicks',
        'Search clicks',
        'clicks',
        'sum',
        'Property totals and canonical-page breakdowns are separate query scopes.',
      ),
      m(
        'gsc.impressions',
        'Search impressions',
        'impressions',
        'sum',
        'Search Console may omit low-volume data and return only top rows.',
      ),
      m(
        'gsc.ctr',
        'Search click-through rate',
        'ratio',
        'ratio',
        'Computed from clicks and impressions within the identical query scope.',
      ),
      m(
        'gsc.position',
        'Average search position',
        'position',
        'weighted_mean',
        'Impression-weighted only within identical source aggregation and search type.',
      ),
      ...['site_loaded', 'test_viewed', 'test_started', 'test_completed', 'report_downloaded'].map(
        (x) =>
          m(
            `sense6.${x}`,
            x.replaceAll('_', ' '),
            'events',
            'sum',
            'Anonymous activity totals. Repeats and bots are not deduplicated into people.',
          ),
      ),
    ].map((x) => [x.key, x]),
  ),
);
export function canonicalDimensions(d: Dimensions): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(d).sort(([a], [b]) => a.localeCompare(b))),
  );
}
export function observationKey(o: Observation): string {
  return JSON.stringify([
    o.metric,
    o.from,
    o.to,
    o.timezone,
    o.kind,
    canonicalDimensions(o.dimensions),
    o.methodology,
  ]);
}
