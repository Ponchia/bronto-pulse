import type { Secrets } from './auth.js';
import { groups } from './collectors/index.js';
import type { Config, Resource } from './config.js';
import type { Store } from './storage/store.js';
import { sync, type SyncOptions, type SyncResult } from './sync.js';
import { addDays, dateInZone, type DateRange } from './time.js';

/** Search Console serves about 16 months. Older requests would publish empty days. */
const SEARCH_CONSOLE_DAYS = 480;
const CURSOR = 'history_cursor';
const CHUNKS = 'history_chunks';

export interface HistoryJob {
  resourceId: string;
  group: string;
  window: DateRange;
  chunkDays: number;
}
export interface HistoryOutcome {
  /** Datasets that still had older dates to collect before this invocation. */
  pending: number;
  results: SyncResult[];
}

function targets(config: Config, provider?: Resource['provider']) {
  return config.resources.flatMap((resource) =>
    resource.enabled &&
    (!provider || resource.provider === provider) &&
    'history' in resource &&
    resource.history
      ? groups(resource).map((group) => ({ resource, group, history: resource.history! }))
      : [],
  );
}

/**
 * Pure: the next older chunk of every dataset whose earliest published day is
 * still after its configured history start. A dataset with no published day is
 * left to the regular rotation, which establishes the newest window first.
 */
export function pendingHistory(
  config: Config,
  earliest: ReadonlyMap<string, string>,
  chunks: Readonly<Record<string, number>>,
  now: Date,
  provider?: Resource['provider'],
): HistoryJob[] {
  return targets(config, provider).flatMap(({ resource, group, history }) => {
    const key = `${resource.id}:${group}`,
      first = earliest.get(key);
    if (!first) return [];
    let floor = history.from;
    if (resource.provider === 'gsc') {
      const oldest = addDays(dateInZone(now, 'America/Los_Angeles'), -SEARCH_CONSOLE_DAYS);
      if (floor < oldest) floor = oldest;
    }
    const to = addDays(first, -1);
    if (to < floor) return [];
    const chunkDays = Math.min(history.chunkDays, chunks[key] ?? history.chunkDays),
      from = addDays(to, -(chunkDays - 1));
    return [
      {
        resourceId: resource.id,
        group,
        window: { from: from < floor ? floor : from, to },
        chunkDays,
      },
    ];
  });
}

function storedChunks(raw: string | undefined): Record<string, number> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (pair): pair is [string, number] => Number.isSafeInteger(pair[1]) && pair[1] >= 1,
      ),
    );
  } catch {
    return {};
  }
}

/**
 * Collect one older chunk for one dataset, rotating across datasets so a failing
 * source cannot starve the others. Publication, leases and budgets are the
 * regular sync path; a budget failure halves that dataset's later chunks.
 */
export async function collectHistory(
  config: Config,
  store: Store,
  secrets: Secrets,
  options: Omit<SyncOptions, 'resourceId' | 'group' | 'window' | 'rotate' | 'maxJobs'> = {},
): Promise<HistoryOutcome> {
  const now = options.now ?? new Date();
  const datasets = targets(config, options.provider).map(({ resource, group }) => ({
    resourceId: resource.id,
    group,
  }));
  if (!datasets.length) return { pending: 0, results: [] };
  const [published, cursorValue, chunkValue] = await Promise.all([
    store.earliestPublished(datasets),
    store.getSetting(CURSOR),
    store.getSetting(CHUNKS),
  ]);
  const chunks = storedChunks(chunkValue);
  const pending = pendingHistory(
    config,
    new Map(published.map((p) => [`${p.resourceId}:${p.group}`, p.date])),
    chunks,
    now,
    options.provider,
  );
  if (!pending.length) return { pending: 0, results: [] };
  const stored = Number(cursorValue ?? 0),
    cursor = Number.isSafeInteger(stored) && stored >= 0 ? stored % pending.length : 0,
    job = pending[cursor]!;
  await store.setSetting(CURSOR, String((cursor + 1) % pending.length));
  const results = await sync(config, store, secrets, {
    ...options,
    now,
    resourceId: job.resourceId,
    group: job.group,
    window: job.window,
    maxJobs: 1,
  });
  if (results[0]?.code === 'ROW_LIMIT' && job.chunkDays > 1) {
    chunks[`${job.resourceId}:${job.group}`] = Math.floor(job.chunkDays / 2);
    await store.setSetting(CHUNKS, JSON.stringify(chunks));
  }
  return { pending: pending.length, results };
}
