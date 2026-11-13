import type { Provider } from '../config.js';
import type { MetricDefinition } from '../model.js';

/** Capabilities are declared, never inferred from a successful HTTP response. */
export interface ConnectorManifest {
  readonly id: Provider;
  readonly category: 'repository' | 'distribution' | 'website' | 'search' | 'product';
  readonly authentication:
    | 'selected-repository-or-public'
    | 'none'
    | 'read-only-token'
    | 'read-only-oauth-or-token'
    | 'selected-d1-or-token';
  readonly endpoints: readonly string[];
  readonly supportedRuntimes: readonly ('node' | 'worker')[];
  readonly groups: readonly string[];
  readonly metrics: readonly string[];
  readonly history: 'bounded-daily' | 'rolling-and-snapshots' | 'daily-aggregate';
  readonly defaultTimeZone: 'UTC' | 'America/Los_Angeles' | 'site';
  readonly providerOrigin: 'fixed' | 'binding';
}

/**
 * Statically registered built-in adapters. The manifest powers discovery and
 * stable capability review, not arbitrary code loading or credential grants.
 * Runtime implementation and metric definitions remain separate contracts.
 */
export const CONNECTOR_CATALOG: Readonly<Record<Provider, ConnectorManifest>> = Object.freeze({
  github: {
    id: 'github',
    category: 'repository',
    authentication: 'selected-repository-or-public',
    endpoints: ['https://api.github.com'],
    supportedRuntimes: ['node', 'worker'],
    groups: ['repository', 'views', 'clones', 'referrers', 'paths', 'releases'],
    metrics: [
      'github.views',
      'github.unique_viewers',
      'github.clones',
      'github.unique_cloners',
      'github.stars',
      'github.forks',
      'github.open_issues',
      'github.referral_views',
      'github.path_views',
      'github.release_downloads',
    ],
    history: 'rolling-and-snapshots',
    defaultTimeZone: 'UTC',
    providerOrigin: 'fixed',
  },
  npm: {
    id: 'npm',
    category: 'distribution',
    authentication: 'none',
    endpoints: ['https://api.npmjs.org'],
    supportedRuntimes: ['node', 'worker'],
    groups: ['downloads'],
    metrics: ['npm.downloads'],
    history: 'bounded-daily',
    defaultTimeZone: 'UTC',
    providerOrigin: 'fixed',
  },
  cloudflare: {
    id: 'cloudflare',
    category: 'website',
    authentication: 'read-only-token',
    endpoints: ['https://api.cloudflare.com'],
    supportedRuntimes: ['node', 'worker'],
    groups: ['totals', 'pages', 'referrers', 'performance', 'vitals'],
    metrics: [
      'cloudflare.pageviews',
      'cloudflare.visits',
      'cloudflare.load_p75',
      'cloudflare.lcp_p75',
      'cloudflare.inp_p75',
      'cloudflare.cls_p75',
    ],
    history: 'bounded-daily',
    defaultTimeZone: 'UTC',
    providerOrigin: 'fixed',
  },
  gsc: {
    id: 'gsc',
    category: 'search',
    authentication: 'read-only-oauth-or-token',
    endpoints: ['https://www.googleapis.com', 'https://searchconsole.googleapis.com'],
    supportedRuntimes: ['node', 'worker'],
    groups: ['totals', 'pages', 'queries'],
    metrics: ['gsc.clicks', 'gsc.impressions', 'gsc.ctr', 'gsc.position'],
    history: 'bounded-daily',
    defaultTimeZone: 'America/Los_Angeles',
    providerOrigin: 'fixed',
  },
  sense6: {
    id: 'sense6',
    category: 'product',
    authentication: 'selected-d1-or-token',
    endpoints: ['https://api.cloudflare.com'],
    supportedRuntimes: ['node', 'worker'],
    groups: ['activity'],
    metrics: [
      'sense6.site_loaded',
      'sense6.test_viewed',
      'sense6.test_started',
      'sense6.test_completed',
      'sense6.report_downloaded',
    ],
    history: 'daily-aggregate',
    defaultTimeZone: 'UTC',
    providerOrigin: 'binding',
  },
  plausible: {
    id: 'plausible',
    category: 'website',
    authentication: 'read-only-token',
    endpoints: ['https://plausible.io'],
    supportedRuntimes: ['node', 'worker'],
    groups: ['traffic'],
    metrics: ['plausible.pageviews', 'plausible.visitors_daily'],
    history: 'bounded-daily',
    defaultTimeZone: 'site',
    providerOrigin: 'fixed',
  },
  umami: {
    id: 'umami',
    category: 'website',
    authentication: 'read-only-token',
    endpoints: ['https://api.umami.is'],
    supportedRuntimes: ['node', 'worker'],
    groups: ['traffic'],
    metrics: ['umami.pageviews', 'umami.sessions_daily'],
    history: 'bounded-daily',
    defaultTimeZone: 'UTC',
    providerOrigin: 'fixed',
  },
});
export function hasConnector(id: string): id is Provider {
  return Object.hasOwn(CONNECTOR_CATALOG, id);
}
export function connectorCatalog(): ConnectorManifest[] {
  return Object.values(CONNECTOR_CATALOG).map((value) => ({
    ...value,
    endpoints: [...value.endpoints],
    supportedRuntimes: [...value.supportedRuntimes],
    groups: [...value.groups],
    metrics: [...value.metrics],
  }));
}
/** Every declared metric must have one compatible aggregation contract. */
export function connectorMetricContracts(
  metrics: Readonly<Record<string, MetricDefinition>>,
): boolean {
  const seen = new Set<string>();
  for (const def of Object.values(CONNECTOR_CATALOG)) {
    for (const metric of def.metrics) {
      if (seen.has(metric) || !metrics[metric]) return false;
      seen.add(metric);
    }
  }
  return Object.keys(metrics).every((metric) => seen.has(metric));
}
