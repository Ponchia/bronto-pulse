import { nativeSense6, type AggregateBindings } from './collectors/bindings.js';
import { Credentials, type Secrets } from './auth.js';
import { connectionStatus } from './selfhost/client.js';
import { collect, groups, probeCloudflare } from './collectors/index.js';
import type { Config, Provider, Resource } from './config.js';
import { PulseError, safeError } from './errors.js';
import { HttpClient, type Fetcher } from './http.js';
import type { Run } from './model.js';
import { Store } from './storage/store.js';
import { selectCollectionJobs } from './plan.js';
import { dueJobs } from './due-schedule.js';
import { retryNotBefore } from './retry-after.js';
import { dateInZone, defaultRange, range, daysBetween, type DateRange } from './time.js';
export interface SyncOptions {
  provider?: Provider;
  resourceId?: string;
  group?: string;
  window?: DateRange;
  maxJobs?: number;
  rotate?: boolean;
  /** Opt-in durable source freshness scheduling; never combined with rotation. */
  dueOnly?: boolean;
  now?: Date;
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  readyOnly?: boolean;
  maximumRequests?: number;
  maximumBytes?: number;
  maximumRows?: number;
  retryRateLimits?: boolean;
  bindings?: AggregateBindings;
}
export interface SyncResult {
  resourceId: string;
  group: string;
  status: 'success' | 'failed' | 'skipped';
  rows: number;
  requests: number;
  code?: string;
  message?: string;
  runId?: string;
  /** Due-time only: the stored provider wait for this failed dataset. */
  retryNotBefore?: string;
}
export function jobs(config: Config): { resource: Resource; group: string }[] {
  return config.resources
    .filter((r) => r.enabled)
    .flatMap((resource) => groups(resource).map((group) => ({ resource, group })));
}
/** Public GitHub groups do not require moving an operator credential to a Worker.
 * Private traffic remains unavailable until its selected-repository grant exists. */
export function readyResource(
  config: Config,
  resource: Resource,
  group: string,
  secrets: Secrets,
  bindings: AggregateBindings = {},
): Resource | undefined {
  if (resource.provider === 'npm' || nativeSense6(resource, bindings)) return resource;
  const connection = config.connections.find((c) => c.id === resource.connection);
  if (connectionStatus(connection, secrets, bindings.selfHosted).available) return resource;
  if (resource.provider === 'github' && ['repository', 'releases'].includes(group))
    return { ...resource, connection: undefined };
  return undefined;
}
export async function sync(
  config: Config,
  store: Store,
  secrets: Secrets,
  options: SyncOptions = {},
): Promise<SyncResult[]> {
  if (config.demo)
    throw new PulseError(
      'CONFIG',
      'Demo data cannot be synchronized against live providers. Use a separate live database.',
    );
  const now = options.now ?? new Date();
  let selected = selectCollectionJobs(config, options);
  if (options.readyOnly)
    selected = selected.flatMap(({ resource, group }) => {
      const ready = readyResource(config, resource, group, secrets, options.bindings);
      return ready ? [{ resource: ready, group }] : [];
    });
  if (
    options.maxJobs !== undefined &&
    (!Number.isSafeInteger(options.maxJobs) || options.maxJobs < 1 || options.maxJobs > 1000)
  )
    throw new PulseError('CONFIG', 'Job bound must be between 1 and 1000.');
  if (options.window) range(options.window.from, options.window.to);
  for (const bound of [options.maximumRequests, options.maximumBytes, options.maximumRows])
    if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 1))
      throw new PulseError('CONFIG', 'Collection budgets must be positive integers.');
  if (options.retryRateLimits !== undefined && typeof options.retryRateLimits !== 'boolean')
    throw new PulseError('CONFIG', 'Invalid rate-limit retry policy.');
  if (options.dueOnly && (options.rotate || options.window))
    throw new PulseError(
      'CONFIG',
      'Due-time scheduling cannot combine with rotation or an explicit collection window.',
    );
  await store.register(config, now);
  if (!selected.length) return [];
  const results: SyncResult[] = [];
  if (options.dueOnly) {
    // Regular source-date-qualified heads keep old backfills from postponing
    // fresh collection while honoring longer resource or group intervals and
    // any stored provider wait.
    const heads = await store.regularRunHeads();
    // Ambiguous history is reported, never collected as if it were absent.
    const unresolved = new Set(heads.unresolved);
    for (const { resource, group } of selected)
      if (unresolved.has(`${resource.id}:${group}`))
        results.push({
          resourceId: resource.id,
          group,
          status: 'skipped',
          rows: 0,
          requests: 0,
          code: 'CONFLICT',
          message:
            'Regular run history is ambiguous beyond the bounded scan; nothing was collected. Run an explicit sync for this dataset.',
        });
    selected = dueJobs(selected, heads, now).map(({ resource, group }) => ({ resource, group }));
    if (!selected.length) return results;
  }
  const collectionConfig =
    options.maximumRows === undefined
      ? config
      : {
          ...config,
          settings: {
            ...config.settings,
            maxRows: Math.min(config.settings.maxRows, options.maximumRows),
          },
        };
  const cursorKey = `scheduler_cursor:${options.provider ?? '*'}:${options.resourceId ?? '*'}:${options.group ?? '*'}${options.readyOnly ? ':ready' : ''}`;
  const storedCursor = options.rotate ? Number((await store.getSetting(cursorKey)) ?? 0) : 0;
  const cursor = Number.isSafeInteger(storedCursor) && storedCursor >= 0 ? storedCursor : 0;
  if (options.rotate)
    selected = [
      ...selected.slice(cursor % selected.length),
      ...selected.slice(0, cursor % selected.length),
    ];
  const total = selected.length;
  selected = selected.slice(0, options.maxJobs ?? selected.length);
  for (const { resource, group } of selected) {
    const window =
      options.window ??
      defaultRange(
        now,
        config.settings.lookbackDays,
        resource.provider === 'gsc'
          ? 'America/Los_Angeles'
          : resource.provider === 'plausible'
            ? resource.timezone
            : 'UTC',
      );
    range(window.from, window.to);
    const key = `${resource.id}:${group}`,
      owner = crypto.randomUUID();
    if (!(await store.acquire(key, owner))) {
      results.push({
        resourceId: resource.id,
        group,
        status: 'skipped',
        rows: 0,
        requests: 0,
        code: 'CONFLICT',
        message: 'Another collector holds this dataset lease.',
      });
      continue;
    }
    let id: string | undefined;
    const http = new HttpClient(
      options.fetcher,
      config.settings.requestTimeoutMs,
      options.sleep,
      options.maximumBytes,
      options.maximumRequests,
      options.retryRateLimits,
    );
    try {
      id = await store.begin(resource, group, window, now);
      const credentials = new Credentials(secrets, http, () => now);
      const data = await collect(resource, group, {
        config: collectionConfig,
        http,
        credentials,
        window,
        now,
        bindings: options.bindings,
      });
      // Provider row counts may expand into several observations. The Free
      // profile bounds the normalized output, not only the upstream row count.
      if (options.maximumRows !== undefined && data.observations.length > options.maximumRows)
        throw new PulseError(
          'ROW_LIMIT',
          'Normalized observation budget exceeded; no data published.',
        );
      await store.publish(
        id,
        resource,
        group,
        data,
        key,
        owner,
        http.requests,
        new Date(),
        collectionConfig.settings.maxRows,
      );
      results.push({
        resourceId: resource.id,
        group,
        status: 'success',
        rows: data.observations.length,
        requests: http.requests,
        runId: id,
      });
    } catch (error) {
      const clean = safeError(error);
      const failedAt = new Date();
      // Only the opt-in due-time mode records a provider wait; rotation and
      // history backfills keep their exact previous writes.
      const wait =
        options.dueOnly && error instanceof PulseError && error.code === 'RATE_LIMIT'
          ? error.retryAfterSeconds
          : undefined;
      const notBefore =
        id && wait !== undefined ? retryNotBefore(failedAt.getTime(), wait) : undefined;
      if (id)
        await store.fail(
          id,
          clean.code,
          clean.message,
          http.requests,
          failedAt,
          'failed',
          notBefore && { dataset: key, notBefore },
        );
      results.push({
        resourceId: resource.id,
        group,
        status: 'failed',
        rows: 0,
        requests: http.requests,
        ...clean,
        runId: id,
        ...(notBefore ? { retryNotBefore: notBefore.toISOString() } : {}),
      });
    } finally {
      await store.release(key, owner);
    }
  }
  if (options.rotate) await store.setSetting(cursorKey, String((cursor + selected.length) % total));
  return results;
}
export function expectedGroups(config: Config): Map<string, string[]> {
  return new Map(config.resources.map((r) => [r.id, groups(r)]));
}
export async function doctor(
  config: Config,
  store: Store,
  secrets: Secrets,
  now = new Date(),
  bindings: AggregateBindings = {},
) {
  const heads = await store.runHeads();
  const observed = await store.observedThrough();
  const waits = await store.retryGuidance();
  const states = config.resources
    .flatMap((resource) => groups(resource).map((group) => ({ resource, group })))
    .map(({ resource, group }) => {
      const latest = heads.latest.find((r) => r.resourceId === resource.id && r.group === group);
      const success = heads.successful.find(
        (r) => r.resourceId === resource.id && r.group === group && r.status === 'success',
      );
      const age = success
        ? (now.getTime() - Date.parse(success.finishedAt ?? success.startedAt)) / 3600000
        : null;
      const wait =
        latest?.status === 'failed' && latest.code === 'RATE_LIMIT'
          ? waits.find((w) => w.dataset === `${resource.id}:${group}` && w.runId === latest.id)
          : undefined;
      const credentials = nativeSense6(resource, bindings)
        ? { available: true, method: 'd1-binding', missing: [] }
        : resource.provider === 'npm' ||
            (resource.provider === 'github' &&
              ['repository', 'releases'].includes(group) &&
              !connectionStatus(
                config.connections.find((c) => c.id === resource.connection),
                secrets,
                bindings.selfHosted,
              ).available)
          ? { available: true, method: 'public', missing: [] }
          : connectionStatus(
              config.connections.find((c) => c.id === resource.connection),
              secrets,
              bindings.selfHosted,
            );
      const latestDate =
        observed.find((o) => o.resourceId === resource.id && o.group === group)?.date ?? null;
      const sourceToday = dateInZone(
        now,
        resource.provider === 'gsc'
          ? 'America/Los_Angeles'
          : resource.provider === 'plausible'
            ? resource.timezone
            : 'UTC',
      );
      const lagDays = latestDate ? Math.max(0, daysBetween(latestDate, sourceToday) - 1) : null;
      const runAge = latest ? (now.getTime() - Date.parse(latest.startedAt)) / 3600000 : null;
      const lagThreshold = resource.provider === 'gsc' ? 4 : 2;
      const daily = !(
        resource.provider === 'github' &&
        ['repository', 'releases', 'referrers', 'paths'].includes(group)
      );
      const status = !resource.enabled
        ? 'disabled'
        : !credentials.available && !config.demo
          ? 'credentials_missing'
          : !latest
            ? 'never_collected'
            : latest.status === 'running' && runAge !== null && runAge > 1
              ? 'interrupted'
              : latest.status === 'failed'
                ? 'failed'
                : age !== null && age > config.settings.staleAfterHours
                  ? 'stale'
                  : latest.status === 'running'
                    ? 'running'
                    : !success
                      ? 'never_collected'
                      : daily && lagDays !== null && lagDays > lagThreshold
                        ? 'lagging'
                        : 'healthy';
      return {
        resourceId: resource.id,
        provider: resource.provider,
        group,
        status,
        credentials,
        lastRun: latest ?? null,
        lastSuccess: success?.finishedAt ?? null,
        ageHours: age,
        observedThrough: latestDate,
        dataLagDays: lagDays,
        dataState: !success
          ? 'not_collected'
          : success.rows === 0
            ? 'no_observations'
            : 'observations',
        nextAction: nextAction(resource.id, group, status, latest?.code ?? null),
        // Present only while the latest run is the failure a provider wait belongs to.
        ...(wait ? { retryNotBefore: wait.notBefore } : {}),
      };
    });
  return {
    generatedAt: now.toISOString(),
    schemaVersion: 1,
    sourceDate: dateInZone(now),
    demo: config.demo,
    healthy: states.every((x) => x.status === 'healthy' || x.status === 'disabled'),
    resources: states,
  };
}
export function nextAction(resourceId: string, group: string, status: string, code: string | null) {
  const command = ['pulse', 'probe', '--resource', resourceId, '--group', group, '--json'];
  if (status === 'healthy')
    return {
      message: 'Collection succeeded; inspect data dates and quality before interpreting values.',
      command: null,
    };
  if (status === 'disabled')
    return {
      message: 'Collection is disabled. Retained history remains available.',
      command: null,
    };
  if (status === 'credentials_missing' || code === 'AUTH' || code === 'PERMISSION')
    return {
      message:
        'Check only this resource credential and its least-privilege provider access, then probe the affected group.',
      command,
    };
  if (code === 'ROW_LIMIT')
    return {
      message:
        'Plan smaller date chunks before retrying. A truncated response must not replace complete history.',
      command: [
        'pulse',
        'plan',
        '--resource',
        resourceId,
        '--group',
        group,
        '--chunk-days',
        '1',
        '--json',
      ],
    };
  if (code === 'RATE_LIMIT')
    return {
      message: 'Respect the provider reset window before retrying; do not increase concurrency.',
      command,
    };
  if (status === 'running')
    return {
      message: 'An in-progress run is not evidence of a completed collection.',
      command: null,
    };
  if (status === 'interrupted')
    return {
      message:
        'Inspect the collector process and expired lease, then retry. Do not delete history.',
      command,
    };
  if (status === 'lagging')
    return {
      message:
        'Requests are succeeding but observed dates lag behind. Check provider publication delay; absent dates are not zero.',
      command,
    };
  return {
    message:
      'Probe this dataset before running a bounded sync; previous successful observations remain intact.',
    command,
  };
}
export const MAX_PROBE_DAYS = 7;

export async function probe(config: Config, secrets: Secrets, options: SyncOptions = {}) {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new PulseError('CONFIG', 'Invalid probe clock.');
  // Explicit probes must stay small and cannot silently become yesterday's check.
  // Validate before selecting sources or constructing a credential-bearing client.
  const requestedWindow =
    options.window === undefined
      ? undefined
      : range(options.window.from, options.window.to, MAX_PROBE_DAYS);
  const selected = selectCollectionJobs(config, options);
  const maximum = options.maxJobs ?? 64;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000)
    throw new PulseError('CONFIG', 'Probe job budget must be between 1 and 1000.');
  const results = [];
  const capabilities = new Map<string, unknown>();
  for (const { resource, group } of selected.slice(0, maximum)) {
    const http = new HttpClient(options.fetcher, config.settings.requestTimeoutMs, options.sleep);
    const credentials = new Credentials(secrets, http, () => now);
    const sourceTimezone =
      resource.provider === 'gsc'
        ? 'America/Los_Angeles'
        : resource.provider === 'plausible'
          ? resource.timezone
          : 'UTC';
    const context = {
      config,
      http,
      credentials,
      now,
      window: requestedWindow ?? defaultRange(now, 1, sourceTimezone),
      bindings: options.bindings,
    };
    if (resource.provider === 'cloudflare' && !capabilities.has(resource.id)) {
      try {
        capabilities.set(resource.id, await probeCloudflare(resource, context));
      } catch (error) {
        capabilities.set(resource.id, { discovery: 'unavailable', ...safeError(error) });
      }
    }
    try {
      const data = await collect(resource, group, context);
      results.push({
        resourceId: resource.id,
        status: 'available',
        testedGroup: group,
        requestedWindow: context.window,
        // Native snapshots, rolling groups or retention limits can change this.
        testedWindow: data.range,
        sourceTimezone,
        rows: data.observations.length,
        capabilities: capabilities.get(resource.id),
        notes: data.notes,
        requests: http.requests,
      });
    } catch (error) {
      results.push({
        resourceId: resource.id,
        status: 'unavailable',
        testedGroup: group,
        requestedWindow: context.window,
        testedWindow: null,
        sourceTimezone,
        ...safeError(error),
        requests: http.requests,
      });
    }
  }
  return {
    readOnly: true,
    testedJobs: results.length,
    omittedJobs: Math.max(0, selected.length - maximum),
    results,
  };
}
export function latestSuccessful(runs: Run[], resourceId: string, group: string): Run | undefined {
  return runs.find(
    (r) => r.resourceId === resourceId && r.group === group && r.status === 'success',
  );
}
