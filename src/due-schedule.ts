import type { Resource } from './config.js';
import { PulseError } from './errors.js';
import type { Run } from './model.js';
import type { RetryGuidance } from './retry-after.js';
import { addDays, dateInZone } from './time.js';

export interface DueJob {
  resource: Resource;
  group: string;
  /** UTC instant; 0 indicates a dataset with no recent successful/failed run. */
  dueAt: number;
  reason: 'never_collected' | 'refresh_due' | 'retry_due';
  /** Effective minimum gap for this dataset. */
  refreshHours: number;
  /** Where that gap came from: the group entry, the resource, or the 24-hour default. */
  refreshPolicy: 'group' | 'resource' | 'default';
}
export interface RunHeads {
  /** One run per dataset, or several candidates: the newest regular one is used. */
  latest: Run[];
  successful: Run[];
  /** Optional stored provider waits; absent means the fixed backoff alone. */
  retryGuidance?: readonly RetryGuidance[];
  /**
   * Datasets (`resourceId:group`) whose regular head could not be established
   * within the store's bounded scan. They are never reported as due.
   */
  unresolved?: readonly string[];
}
export interface Dataset {
  resource: Resource;
  group: string;
}

function textOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function instant(input: string | null): number {
  const timestamp = input === null ? NaN : Date.parse(input);
  if (!Number.isFinite(timestamp))
    throw new PulseError('SCHEMA', 'Invalid saved collector timestamp.');
  return timestamp;
}

/**
 * The calendar a source reports in. Store.regularRunHeads() pages candidates
 * for the providers that are not UTC here: keep its provider list in step.
 */
export function sourceZone(provider: string, timezone?: string | null): string {
  return provider === 'gsc'
    ? 'America/Los_Angeles'
    : provider === 'plausible' && timezone
      ? timezone
      : 'UTC';
}
function resourceZone(resource: Resource): string {
  return sourceZone(resource.provider, 'timezone' in resource ? resource.timezone : undefined);
}
/**
 * A regular run covers the last complete source day *when it was executed*.
 * Comparing to current yesterday would defeat a 48-hour or 30-day policy each
 * time midnight passes.
 */
export function isRegularRun(zone: string, run: Pick<Run, 'to' | 'startedAt'>): boolean {
  return run.to >= addDays(dateInZone(new Date(instant(run.startedAt)), zone), -1);
}

function failureBackoff(code: string | null): number {
  // A source quota/permission failure should not occupy every scheduled slot.
  if (code === 'AUTH' || code === 'PERMISSION') return 24 * 3600000;
  if (code === 'SCHEMA' || code === 'CONFIG' || code === 'ROW_LIMIT') return 6 * 3600000;
  if (code === 'RATE_LIMIT') return 60 * 60000;
  return 15 * 60000;
}

/**
 * The minimum gap between completed refreshes of one dataset: its group entry,
 * else the resource interval, else 24 hours. Revalidated here because library
 * callers can pass resources that never went through parseConfig.
 */
export function refreshPolicy(
  resource: Resource,
  group: string,
): Pick<DueJob, 'refreshHours' | 'refreshPolicy'> {
  const overrides = resource.refreshHoursByGroup;
  const override =
    overrides && Object.prototype.hasOwnProperty.call(overrides, group)
      ? overrides[group]
      : undefined;
  const refreshHours = override ?? resource.refreshHours ?? 24;
  if (!Number.isSafeInteger(refreshHours) || refreshHours < 1 || refreshHours > 720)
    throw new PulseError(
      'CONFIG',
      override === undefined
        ? 'Invalid per-resource refresh interval.'
        : 'Invalid per-group refresh interval.',
    );
  return {
    refreshHours,
    refreshPolicy:
      override !== undefined
        ? 'group'
        : resource.refreshHours !== undefined
          ? 'resource'
          : 'default',
  };
}

/**
 * Pure due-time selection, not a crawler, queue or person-level predictor.
 * Old backfills are excluded by requiring runs to cover the most recent
 * provider calendar day. Absolute overdue time avoids low-interval starvation.
 */
export function dueJobs(selected: readonly Dataset[], heads: RunHeads, now: Date): DueJob[] {
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new PulseError('CONFIG', 'Invalid scheduler clock.');
  const zones = new Map(
    selected.map(({ resource, group }) => [resource.id + ':' + group, resourceZone(resource)]),
  );
  const newestRegular = (runs: readonly Run[]) => {
    const heads = new Map<string, { run: Run; startedAt: number }>();
    for (const run of runs) {
      const key = run.resourceId + ':' + run.group,
        zone = zones.get(key);
      if (zone === undefined) continue;
      if (!isRegularRun(zone, run)) continue;
      const startedAt = instant(run.startedAt);
      // Ties keep the earlier entry: the store lists candidates newest first.
      const held = heads.get(key);
      if (!held || startedAt > held.startedAt) heads.set(key, { run, startedAt });
    }
    return heads;
  };
  const recentLatest = newestRegular(heads.latest);
  const recentSuccess = newestRegular(heads.successful);
  const guidance = new Map((heads.retryGuidance ?? []).map((hint) => [hint.dataset, hint]));
  const unresolved = new Set(heads.unresolved ?? []);
  const due: DueJob[] = [];
  for (const { resource, group } of selected) {
    const policy = refreshPolicy(resource, group);
    const key = resource.id + ':' + group;
    // Unknown history is not "never collected": collecting could run inside
    // an interval, a failure delay or a provider wait.
    if (unresolved.has(key)) continue;
    const regularLatest = recentLatest.get(key)?.run;
    const regularSuccess = recentSuccess.get(key)?.run;
    let dueAt = regularSuccess
      ? instant(regularSuccess.finishedAt ?? regularSuccess.startedAt) +
        policy.refreshHours * 3600000
      : 0;
    let reason: DueJob['reason'] = regularSuccess ? 'refresh_due' : 'never_collected';
    if (regularLatest?.status === 'failed') {
      const failedAt = instant(regularLatest.finishedAt ?? regularLatest.startedAt);
      let retry = failedAt + failureBackoff(regularLatest.code);
      // A provider wait applies only to the exact failed run that received it
      // and can only lengthen the fixed backoff. It is never shortened: an
      // unreadable instant falls back to the fixed backoff, a far one holds.
      const hint = guidance.get(key);
      if (regularLatest.code === 'RATE_LIMIT' && hint?.runId === regularLatest.id) {
        const until = Date.parse(hint.notBefore);
        if (Number.isFinite(until)) retry = Math.max(retry, until);
      }
      if (retry > dueAt) {
        dueAt = retry;
        reason = 'retry_due';
      }
    } else if (regularLatest?.status === 'running') {
      // A lease-owned in-flight job gets a bounded grace period.
      dueAt = Math.max(dueAt, instant(regularLatest.startedAt) + 3600000);
      reason = 'retry_due';
    }
    if (at >= dueAt) due.push({ resource, group, dueAt, reason, ...policy });
  }
  return due.sort(
    (a, b) =>
      a.dueAt - b.dueAt || textOrder(a.resource.id, b.resource.id) || textOrder(a.group, b.group),
  );
}
