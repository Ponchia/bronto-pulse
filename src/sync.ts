import { Credentials, credentialStatus, type Secrets } from './auth.js';
import { collect, groups, probeCloudflare } from './collectors/index.js';
import type { Config, Provider, Resource } from './config.js';
import { PulseError, safeError } from './errors.js';
import { HttpClient, type Fetcher } from './http.js';
import type { Run } from './model.js';
import { Store } from './storage/store.js';
import { dateInZone, defaultRange, range, type DateRange } from './time.js';
export interface SyncOptions {
  provider?: Provider;
  resourceId?: string;
  group?: string;
  window?: DateRange;
  maxJobs?: number;
  rotate?: boolean;
  now?: Date;
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
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
}
export function jobs(config: Config): { resource: Resource; group: string }[] {
  return config.resources
    .filter((r) => r.enabled)
    .flatMap((resource) => groups(resource).map((group) => ({ resource, group })));
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
  await store.register(config, now);
  let selected = jobs(config).filter(
    (j) =>
      (!options.provider || j.resource.provider === options.provider) &&
      (!options.resourceId || j.resource.id === options.resourceId) &&
      (!options.group || j.group === options.group),
  );
  if (!selected.length)
    throw new PulseError('CONFIG', 'No enabled collection jobs match this selection.');
  const cursor = options.rotate ? Number((await store.getSetting('scheduler_cursor')) ?? 0) : 0;
  if (options.rotate)
    selected = [
      ...selected.slice(cursor % selected.length),
      ...selected.slice(0, cursor % selected.length),
    ];
  const total = selected.length;
  selected = selected.slice(0, options.maxJobs ?? selected.length);
  const results: SyncResult[] = [];
  for (const { resource, group } of selected) {
    const window =
      options.window ??
      defaultRange(
        now,
        config.settings.lookbackDays,
        resource.provider === 'gsc' ? 'America/Los_Angeles' : 'UTC',
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
    const id = await store.begin(resource, group, window, now);
    const http = new HttpClient(options.fetcher, config.settings.requestTimeoutMs, options.sleep);
    try {
      const credentials = new Credentials(secrets, http, () => now);
      const data = await collect(resource, group, { config, http, credentials, window, now });
      await store.publish(
        id,
        resource,
        group,
        data,
        key,
        owner,
        http.requests,
        new Date(),
        config.settings.maxRows,
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
      await store.fail(id, clean.code, clean.message, http.requests, new Date());
      results.push({
        resourceId: resource.id,
        group,
        status: 'failed',
        rows: 0,
        requests: http.requests,
        ...clean,
        runId: id,
      });
    } finally {
      await store.release(key, owner);
    }
  }
  if (options.rotate)
    await store.setSetting('scheduler_cursor', String((cursor + selected.length) % total));
  return results;
}
export function expectedGroups(config: Config): Map<string, string[]> {
  return new Map(config.resources.map((r) => [r.id, groups(r)]));
}
export async function doctor(config: Config, store: Store, secrets: Secrets, now = new Date()) {
  const runs = await store.runs(10000);
  const states = config.resources
    .flatMap((resource) => groups(resource).map((group) => ({ resource, group })))
    .map(({ resource, group }) => {
      const latest = runs.find((r) => r.resourceId === resource.id && r.group === group);
      const success = runs.find(
        (r) => r.resourceId === resource.id && r.group === group && r.status === 'success',
      );
      const age = success
        ? (now.getTime() - Date.parse(success.finishedAt ?? success.startedAt)) / 3600000
        : null;
      const credentials =
        resource.provider === 'npm'
          ? { available: true, method: 'public', missing: [] }
          : credentialStatus(
              config.connections.find((c) => c.id === resource.connection),
              secrets,
            );
      const status = !resource.enabled
        ? 'disabled'
        : !credentials.available && !config.demo
          ? 'credentials_missing'
          : !latest
            ? 'never_collected'
            : latest.status === 'failed'
              ? 'failed'
              : age !== null && age > config.settings.staleAfterHours
                ? 'stale'
                : latest.status === 'running'
                  ? 'running'
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
export async function probe(config: Config, secrets: Secrets, options: SyncOptions = {}) {
  const now = options.now ?? new Date(),
    results = [];
  for (const resource of config.resources.filter(
    (r) =>
      r.enabled &&
      (!options.resourceId || r.id === options.resourceId) &&
      (!options.provider || r.provider === options.provider),
  )) {
    const http = new HttpClient(options.fetcher, config.settings.requestTimeoutMs, options.sleep);
    const credentials = new Credentials(secrets, http, () => now);
    const context = {
      config,
      http,
      credentials,
      now,
      window: defaultRange(now, 1, resource.provider === 'gsc' ? 'America/Los_Angeles' : 'UTC'),
    };
    try {
      const capabilities =
        resource.provider === 'cloudflare' ? await probeCloudflare(resource, context) : undefined;
      const group = resource.provider === 'github' ? 'views' : groups(resource)[0]!;
      const data = await collect(resource, group, context);
      results.push({
        resourceId: resource.id,
        status: 'available',
        testedGroup: group,
        rows: data.observations.length,
        capabilities,
        notes: data.notes,
        requests: http.requests,
      });
    } catch (error) {
      results.push({
        resourceId: resource.id,
        status: 'unavailable',
        ...safeError(error),
        requests: http.requests,
      });
    }
  }
  return { readOnly: true, results };
}
export function latestSuccessful(runs: Run[], resourceId: string, group: string): Run | undefined {
  return runs.find(
    (r) => r.resourceId === resourceId && r.group === group && r.status === 'success',
  );
}
