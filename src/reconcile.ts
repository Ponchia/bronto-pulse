import type { Secrets } from './auth.js';
import type { Config } from './config.js';
import { hasConnector } from './collectors/registry.js';
import { PulseError } from './errors.js';
import { selectCollectionJobs } from './plan.js';
import type { Store } from './storage/store.js';
import { sync, type SyncOptions, type SyncResult } from './sync.js';
import { addDays, dateInZone, day, type DateRange } from './time.js';

const CURSOR = 'reconciliation_cursor';
const DAYS = 'reconciliation_days';
type Selection = Pick<SyncOptions, 'provider' | 'resourceId' | 'group'>;
type ReconciliationOptions = Omit<SyncOptions, 'window' | 'rotate' | 'dueOnly' | 'maxJobs'>;

export interface ReconciliationJob {
  resourceId: string;
  group: string;
  /** Always one complete source-calendar day; never today. */
  window: DateRange;
  horizonDays: number;
}
export interface ReconciliationOutcome {
  /** Opted-in datasets in this selection, not a count of missing dates. */
  pending: number;
  results: SyncResult[];
  job?: ReconciliationJob;
}

function storedDays(raw: string | undefined): Record<string, string> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((pair): pair is [string, string] => {
        if (typeof pair[1] !== 'string') return false;
        try {
          return day(pair[1]) === pair[1];
        } catch {
          return false;
        }
      }),
    );
  } catch {
    return {};
  }
}

/**
 * Pure source-local correction plan. Unlike history, this revisits dates that
 * already have publication pointers, including dates previously returned empty.
 * A rolling horizon deliberately does not promise to discover older corrections.
 */
export function reconciliationJobs(
  config: Config,
  attemptedDays: Readonly<Record<string, string>>,
  now: Date,
  selection: Selection = {},
): ReconciliationJob[] {
  if (!Number.isFinite(now.getTime()))
    throw new PulseError('CONFIG', 'Invalid reconciliation clock.');
  if (selection.provider && !hasConnector(selection.provider))
    throw new PulseError('CONFIG', 'Unknown provider.');
  if (selection.resourceId && !config.resources.some((r) => r.id === selection.resourceId))
    throw new PulseError('CONFIG', 'Unknown resource selection.');
  if (
    !config.resources.some(
      (r) =>
        r.enabled &&
        (!selection.provider || r.provider === selection.provider) &&
        (!selection.resourceId || r.id === selection.resourceId),
    )
  )
    return [];
  const to = addDays(dateInZone(now, 'America/Los_Angeles'), -1);
  return selectCollectionJobs(config, selection).flatMap(({ resource, group }) => {
    const horizonDays =
      resource.provider === 'gsc' ? resource.reconcileDaysByGroup?.[group] : undefined;
    if (horizonDays === undefined) return [];
    const from = addDays(to, 1 - horizonDays);
    const attempted = attemptedDays[`${resource.id}:${group}`];
    let next = from;
    if (attempted !== undefined) {
      try {
        if (day(attempted) >= from && attempted < to) next = addDays(attempted, 1);
      } catch {
        // An invalid checkpoint starts a bounded pass; it never selects an arbitrary date.
      }
    }
    return [{ resourceId: resource.id, group, window: { from: next, to: next }, horizonDays }];
  });
}

/**
 * One selected dataset/day per invocation, using the ordinary lease, validation
 * and atomic publication path. The caller serializes invocations with the
 * reconciliation-scheduler lease, independently of regular/history scheduling.
 */
export async function collectReconciliation(
  config: Config,
  store: Store,
  secrets: Secrets,
  options: ReconciliationOptions = {},
): Promise<ReconciliationOutcome> {
  const now = options.now ?? new Date();
  const [cursorValue, dayValue] = await Promise.all([
    store.getSetting(CURSOR),
    store.getSetting(DAYS),
  ]);
  const attemptedDays = storedDays(dayValue);
  const jobs = reconciliationJobs(config, attemptedDays, now, options);
  if (!jobs.length) return { pending: 0, results: [] };
  const stored = Number(cursorValue ?? 0);
  const cursor = Number.isSafeInteger(stored) && stored >= 0 ? stored % jobs.length : 0;
  const job = jobs[cursor]!;
  const results = await sync(config, store, secrets, {
    ...options,
    now,
    resourceId: job.resourceId,
    group: job.group,
    window: job.window,
    maxJobs: 1,
    rotate: false,
    dueOnly: false,
  });
  // A failed day remains visible in run history and is revisited on the next
  // pass. Advancing after a real attempt prevents one overfull day from starving
  // the rest. Missing credentials or a held lease do not consume that date.
  if (results.some((result) => result.status !== 'skipped')) {
    attemptedDays[`${job.resourceId}:${job.group}`] = job.window.to;
    await store.setSetting(DAYS, JSON.stringify(attemptedDays));
  }
  await store.setSetting(CURSOR, String((cursor + 1) % jobs.length));
  return { pending: jobs.length, results, job };
}
