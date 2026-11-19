import type { Config } from './config.js';
import { groups } from './collectors/context.js';
import { auditCoverage, type CoverageEntry } from './coverage.js';
import { PulseError } from './errors.js';
import type { Run } from './model.js';
import type { Store } from './storage/store.js';
import { dateInZone, daysBetween } from './time.js';

type ConfigurationState = Exclude<CoverageEntry['state'], 'partial'> | 'group_not_configured';
export interface ObservedCoverageSource {
  resourceId: string;
  configurationState: ConfigurationState;
  lastAttempt: {
    id: string;
    status: Run['status'];
    errorCode: string | null;
    startedAt: string;
    finishedAt: string | null;
    window: { from: string; to: string };
  } | null;
  lastSuccess: {
    id: string;
    at: string;
    rows: number;
    window: { from: string; to: string };
    completeness: Run['completeness'];
  } | null;
  collectionRecency: {
    state: 'never_published' | 'recent' | 'stale' | 'clock_skew';
    ageHours: number | null;
    staleAfterHours: number;
  };
  sourceData: {
    observedThrough: string | null;
    sourceToday: string;
    timezone: string;
    lagDays: number | null;
    lagThresholdDays: number | null;
    state: 'not_observed' | 'recent' | 'lagging' | 'snapshot';
  };
  permissionEvidence: {
    state: 'last_success' | 'access_error' | 'unknown';
    at: string | null;
    runId: string | null;
    errorCode: string | null;
    provesCurrentAccess: false;
  };
}
export interface ObservedCoverageDataset {
  provider: CoverageEntry['provider'];
  identity: string;
  projectId?: string;
  pathPrefix?: string;
  group: string;
  configurationState: ConfigurationState;
  publicationState: 'published' | 'retained_only' | 'never_published';
  sources: ObservedCoverageSource[];
}
function key(resourceId: string, group: string): string {
  return resourceId + ':' + group;
}
function state(entry: CoverageEntry, group: string): ConfigurationState {
  if (['missing', 'disabled', 'unbound'].includes(entry.state))
    return entry.state as 'missing' | 'disabled' | 'unbound';
  return entry.missingGroups.includes(group) ? 'group_not_configured' : 'configured';
}
function attempt(run: Run | undefined): ObservedCoverageSource['lastAttempt'] {
  return run
    ? {
        id: run.id,
        status: run.status,
        errorCode: run.code,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        window: { from: run.from, to: run.to },
      }
    : null;
}
/**
 * Observed collection evidence for an explicit intended inventory.
 * There is one denominator row per intended identity/group, even if it has
 * never been configured or published. Matching resource IDs stay independent.
 * This performs stored reads only: no credentials, grants or provider calls.
 */
export async function observedCoverage(
  config: Config,
  store: Store,
  input: unknown,
  now = new Date(),
) {
  const configurationAudit = auditCoverage(config, input);
  if (!Number.isFinite(now.getTime()))
    throw new PulseError('CONFIG', 'Coverage report requires a valid observation time.');
  const [heads, dates] = await Promise.all([store.runHeads(), store.observedThrough()]);
  const latest = new Map(heads.latest.map((run) => [key(run.resourceId, run.group), run]));
  const successful = new Map(heads.successful.map((run) => [key(run.resourceId, run.group), run]));
  const observed = new Map(dates.map((row) => [key(row.resourceId, row.group), row.date]));
  const resources = new Map(config.resources.map((resource) => [resource.id, resource]));
  const datasets: ObservedCoverageDataset[] = [];
  let sourceRows = 0;
  for (const entry of configurationAudit.resources) {
    for (const group of entry.requestedGroups) {
      const sources: ObservedCoverageSource[] = entry.resourceIds.map((resourceId) => {
        const resource = resources.get(resourceId)!;
        const datasetKey = key(resourceId, group);
        const last = latest.get(datasetKey);
        const success = successful.get(datasetKey);
        const at = success ? (success.finishedAt ?? success.startedAt) : null;
        const ageHours = at ? (now.getTime() - Date.parse(at)) / 3600000 : null;
        const timezone = resource.provider === 'gsc' ? 'America/Los_Angeles' : 'UTC';
        const sourceToday = dateInZone(now, timezone);
        const observedThrough = observed.get(datasetKey) ?? null;
        const lagDays = observedThrough
          ? Math.max(0, daysBetween(observedThrough, sourceToday) - 1)
          : null;
        // Match doctor semantics: these GitHub groups are snapshots/rankings,
        // not daily periods whose missing dates imply ingestion lag.
        const daily = !(
          resource.provider === 'github' &&
          ['repository', 'releases', 'referrers', 'paths'].includes(group)
        );
        const lagThresholdDays = daily ? (resource.provider === 'gsc' ? 4 : 2) : null;
        const accessError =
          last?.status === 'failed' && (last.code === 'AUTH' || last.code === 'PERMISSION');
        return {
          resourceId,
          configurationState: !resource.enabled
            ? 'disabled'
            : !entry.enabledBoundResourceIds.includes(resourceId)
              ? 'unbound'
              : !groups(resource).includes(group)
                ? 'group_not_configured'
                : 'configured',
          lastAttempt: attempt(last),
          lastSuccess: success
            ? {
                id: success.id,
                at: at!,
                rows: success.rows,
                window: { from: success.from, to: success.to },
                completeness: success.completeness,
              }
            : null,
          collectionRecency: {
            state:
              ageHours === null
                ? 'never_published'
                : ageHours < 0
                  ? 'clock_skew'
                  : ageHours > config.settings.staleAfterHours
                    ? 'stale'
                    : 'recent',
            ageHours,
            staleAfterHours: config.settings.staleAfterHours,
          },
          sourceData: {
            observedThrough,
            sourceToday,
            timezone,
            lagDays,
            lagThresholdDays,
            state:
              observedThrough === null
                ? 'not_observed'
                : !daily
                  ? 'snapshot'
                  : lagDays! > lagThresholdDays!
                    ? 'lagging'
                    : 'recent',
          },
          permissionEvidence: accessError
            ? {
                state: 'access_error',
                at: last.finishedAt ?? last.startedAt,
                runId: last.id,
                errorCode: last.code,
                provesCurrentAccess: false,
              }
            : success
              ? {
                  state: 'last_success',
                  at,
                  runId: success.id,
                  errorCode: null,
                  provesCurrentAccess: false,
                }
              : {
                  state: 'unknown',
                  at: null,
                  runId: null,
                  errorCode: null,
                  provesCurrentAccess: false,
                },
        };
      });
      sourceRows += sources.length;
      if (sourceRows > 10000)
        throw new PulseError(
          'ROW_LIMIT',
          'Coverage source fan-out exceeds 10,000 rows. Narrow the intended inventory.',
        );
      datasets.push({
        provider: entry.provider,
        identity: entry.identity,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        ...(entry.pathPrefix ? { pathPrefix: entry.pathPrefix } : {}),
        group,
        configurationState: state(entry, group),
        publicationState: sources.some(
          (source) => source.configurationState === 'configured' && source.lastSuccess !== null,
        )
          ? 'published'
          : sources.some((source) => source.lastSuccess !== null)
            ? 'retained_only'
            : 'never_published',
        sources,
      });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    configurationAudit,
    summary: {
      intendedResources: configurationAudit.resources.length,
      intendedDatasets: datasets.length,
      configuredDatasets: datasets.filter((row) => row.configurationState === 'configured').length,
      publishedDatasets: datasets.filter((row) => row.publicationState === 'published').length,
      neverPublishedDatasets: datasets.filter((row) => row.publicationState === 'never_published')
        .length,
      retainedOnlyDatasets: datasets.filter((row) => row.publicationState === 'retained_only')
        .length,
      matchingSourceRows: sourceRows,
    },
    datasets,
    limitation:
      'The denominator is the explicit intended identity/group inventory, including missing, disabled, unbound and never-published datasets. Matching configured resource IDs are reported independently. Collection recency is time since the last successful publication; source-data lag is separate and does not establish complete historical coverage. A successful empty publication is not a measured zero. Permission evidence describes a recorded success or the latest recorded AUTH/PERMISSION failure, never verified current access; credentials are not read. Stored status and source-date reads may straddle a concurrent publication. No provider was contacted and no grants, configuration or schedules were changed.',
  };
}
