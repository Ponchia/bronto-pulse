import type { Resource } from './config.js';
import { PulseError } from './errors.js';
import type { Run } from './model.js';
import { addDays, dateInZone } from './time.js';

export interface DueJob {
  resource: Resource;
  group: string;
  /** UTC instant; 0 indicates a dataset with no recent successful/failed run. */
  dueAt: number;
  reason: 'never_collected' | 'refresh_due' | 'retry_due';
  refreshHours: number;
}
export interface RunHeads {
  latest: Run[];
  successful: Run[];
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

function resourceZone(resource: Resource): string {
  return resource.provider === 'gsc'
    ? 'America/Los_Angeles'
    : resource.provider === 'plausible'
      ? resource.timezone
      : 'UTC';
}

function failureBackoff(code: string | null): number {
  // A source quota/permission failure should not occupy every scheduled slot.
  if (code === 'AUTH' || code === 'PERMISSION') return 24 * 3600000;
  if (code === 'SCHEMA' || code === 'CONFIG' || code === 'ROW_LIMIT') return 6 * 3600000;
  if (code === 'RATE_LIMIT') return 60 * 60000;
  return 15 * 60000;
}

/**
 * Pure due-time selection, not a crawler, queue or person-level predictor.
 * Old backfills are excluded by requiring runs to cover the most recent
 * provider calendar day. Absolute overdue time avoids low-interval starvation.
 */
export function dueJobs(selected: readonly Dataset[], heads: RunHeads, now: Date): DueJob[] {
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new PulseError('CONFIG', 'Invalid scheduler clock.');
  const recentLatest = new Map(heads.latest.map((run) => [run.resourceId + ':' + run.group, run]));
  const recentSuccess = new Map(
    heads.successful.map((run) => [run.resourceId + ':' + run.group, run]),
  );
  const due: DueJob[] = [];
  for (const { resource, group } of selected) {
    const refreshHours = resource.refreshHours ?? 24;
    if (!Number.isSafeInteger(refreshHours) || refreshHours < 1 || refreshHours > 720)
      throw new PulseError('CONFIG', 'Invalid per-resource refresh interval.');
    const key = resource.id + ':' + group;
    const latest = recentLatest.get(key);
    const success = recentSuccess.get(key);
    // Qualify each run against the source calendar *when it was executed*.
    // Comparing to current yesterday would defeat a 48-hour or 30-day policy
    // each time midnight passes.
    const isRegular = (run: Run) => {
      const atStart = instant(run.startedAt);
      const completedAtStart = addDays(dateInZone(new Date(atStart), resourceZone(resource)), -1);
      return run.to >= completedAtStart;
    };
    const regularSuccess = success && isRegular(success) ? success : undefined;
    const regularLatest = latest && isRegular(latest) ? latest : undefined;
    let dueAt = regularSuccess
      ? instant(regularSuccess.finishedAt ?? regularSuccess.startedAt) + refreshHours * 3600000
      : 0;
    let reason: DueJob['reason'] = regularSuccess ? 'refresh_due' : 'never_collected';
    if (regularLatest?.status === 'failed') {
      const retry =
        instant(regularLatest.finishedAt ?? regularLatest.startedAt) +
        failureBackoff(regularLatest.code);
      if (retry > dueAt) {
        dueAt = retry;
        reason = 'retry_due';
      }
    } else if (regularLatest?.status === 'running') {
      // A lease-owned in-flight job gets a bounded grace period.
      dueAt = Math.max(dueAt, instant(regularLatest.startedAt) + 3600000);
      reason = 'retry_due';
    }
    if (at >= dueAt) due.push({ resource, group, dueAt, reason, refreshHours });
  }
  return due.sort(
    (a, b) =>
      a.dueAt - b.dueAt || textOrder(a.resource.id, b.resource.id) || textOrder(a.group, b.group),
  );
}
