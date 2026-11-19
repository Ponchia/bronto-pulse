import { workerBindings, type AggregateEnvironment } from './collectors/bindings.js';
import { parseConfig } from './config.js';
import {
  workerConfigSource,
  verifyWorkerConfigSource,
  type WorkerConfigEnvironment,
} from './worker-config.js';
import { D1Driver, type D1Like } from './storage/driver.js';
import { Store } from './storage/store.js';
import { sync, type SyncResult } from './sync.js';
import { collectHistory } from './history.js';
import { collectReconciliation } from './reconcile.js';
import { scheduleOptions } from './worker-schedule.js';
import { PulseError, safeError } from './errors.js';
import type { Secrets } from './auth.js';
import { workerAccess, type AccessEnvironment } from './api/access.js';
export interface WorkerEnv
  extends AccessEnvironment, AggregateEnvironment, WorkerConfigEnvironment {
  DB: D1Like;
  ASSETS: { fetch(request: Request): Promise<Response> };
  PULSE_API_TOKEN?: string;
  GITHUB_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  GOOGLE_ACCESS_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GSC_SERVICE_ACCOUNT_JSON?: string;
  PULSE_MAX_JOBS?: string;
  PULSE_PROVIDER?: string;
  PULSE_EXECUTION_PROFILE?: string;
  PULSE_READY_ONLY?: string;
  /** Explicit optional freshness-driven selection; production default stays rotating. */
  PULSE_DUE_ONLY?: string;
  /** The one cron expression whose invocations collect older dates instead of rotating. */
  PULSE_HISTORY_CRON?: string;
  /** Dedicated bounded correction pass, distinct from history and regular refresh. */
  PULSE_RECONCILE_CRON?: string;
}
let cached:
  | {
      db: D1Like;
      raw: string;
      configDigest: string | null;
      profile: string | undefined;
      ready: Promise<{
        store: Store;
        config: ReturnType<typeof parseConfig>;
        reporting?: Promise<void>;
      }>;
    }
  | undefined;
function environmentSecrets(env: WorkerEnv): Secrets {
  // No bindings or objects are passed to provider credential resolution.
  return Object.fromEntries(
    Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  );
}
async function context(env: WorkerEnv) {
  const source = workerConfigSource(env);
  if (
    cached?.db === env.DB &&
    cached.raw === source.raw &&
    cached.configDigest === source.expectedSha256 &&
    cached.profile === env.PULSE_EXECUTION_PROFILE
  )
    return cached.ready;
  const ready = (async () => {
    await verifyWorkerConfigSource(source);
    const config = parseConfig(JSON.parse(source.raw));
    const store = new Store(new D1Driver(env.DB));
    if (env.PULSE_EXECUTION_PROFILE === 'free') {
      // One snapshot checks both migration markers without two sequential D1 round trips.
      // Provision schema through migrations, never during a Free-profile cold start.
      const [versions, inspections] = await store.driver.readBatch([
        { sql: "SELECT value FROM metadata WHERE key='schema_version'" },
        {
          sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('url_inspections','review_records')",
        },
      ]);
      if (versions?.[0]?.value !== '1' || inspections?.length !== 2)
        throw new PulseError(
          'SCHEMA',
          'Apply supported database migrations before enabling the Free profile.',
        );
    } else await store.migrate();
    return { store, config, reporting: undefined as Promise<void> | undefined };
  })();
  cached = {
    db: env.DB,
    raw: source.raw,
    configDigest: source.expectedSha256,
    profile: env.PULSE_EXECUTION_PROFILE,
    ready,
  };
  try {
    return await ready;
  } catch (error) {
    if (cached?.ready === ready) cached = undefined;
    throw error;
  }
}
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      // Keep API-only module initialization off the scheduled execution path.
      const { handle } = await import('./api/handler.js');
      return await handle(request, {
        loadMcpData: async () => {
          // Agent reads use the authoritative catalog without migrating or registering it.
          const store = new Store(new D1Driver(env.DB));
          if ((await store.getSetting('schema_version')) !== '1')
            throw new PulseError('SCHEMA', 'Apply supported database migrations before using MCP.');
          const config = await store.getConfig();
          if (!config)
            throw new PulseError('CONFIG', 'Register the operator configuration before using MCP.');
          return { store, config };
        },
        loadData: async () => {
          const data = await context(env);
          // Reporting initializes its catalog lazily once, after authentication.
          // Scheduled sync owns its own registration, avoiding duplicate parsing
          // and D1 round trips on the same cold collection invocation.
          const ready = (data.reporting ??= data.store.register(data.config));
          try {
            await ready;
          } catch (error) {
            if (data.reporting === ready) data.reporting = undefined;
            throw error;
          }
          return data;
        },
        secrets: environmentSecrets(env),
        apiToken: env.PULSE_API_TOKEN ?? '',
        access: workerAccess(env),
        bindings: workerBindings(env),
        asset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
      });
    } catch {
      return new Response(
        JSON.stringify({
          error: {
            code: 'CONFIG',
            message:
              'Private reporting service is not configured. Check the operator deployment settings.',
          },
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        },
      );
    }
  },
  async scheduled(event: { scheduledTime: number; cron?: string }, env: WorkerEnv): Promise<void> {
    // Validate explicit scheduling controls before touching private storage.
    if (
      env.PULSE_RECONCILE_CRON !== undefined &&
      (!env.PULSE_RECONCILE_CRON.trim() || env.PULSE_RECONCILE_CRON === env.PULSE_HISTORY_CRON)
    )
      throw new PulseError(
        'CONFIG',
        'Reconciliation requires a nonempty cron distinct from history.',
      );
    const selection = scheduleOptions(env);
    const bindings = workerBindings(env);
    // History runs only on its own trigger, so it never delays the regular rotation.
    const history =
      env.PULSE_HISTORY_CRON !== undefined &&
      event.cron !== undefined &&
      event.cron === env.PULSE_HISTORY_CRON;
    const reconciliation =
      env.PULSE_RECONCILE_CRON !== undefined &&
      event.cron !== undefined &&
      event.cron === env.PULSE_RECONCILE_CRON;
    const { store, config } = await context(env);
    if (config.demo) return;
    const owner = crypto.randomUUID(),
      key = reconciliation
        ? 'reconciliation-scheduler'
        : history
          ? 'history-scheduler'
          : 'scheduler';
    if (!(await store.acquire(key, owner))) return;
    try {
      let results: SyncResult[], pending: number | undefined;
      if (reconciliation) {
        const { maxJobs: _one, dueOnly: _notReconciliation, ...bounds } = selection;
        ({ results, pending } = await collectReconciliation(
          config,
          store,
          environmentSecrets(env),
          {
            ...bounds,
            bindings,
          },
        ));
      } else if (history) {
        const { maxJobs: _one, dueOnly: _notHistory, ...bounds } = selection;
        ({ results, pending } = await collectHistory(config, store, environmentSecrets(env), {
          ...bounds,
          bindings,
        }));
      } else
        results = await sync(config, store, environmentSecrets(env), {
          ...selection,
          bindings,
          rotate: !selection.dueOnly,
        });
      // Only aggregate result codes. No URLs, credentials or provider payloads in logs.
      console.log(
        JSON.stringify({
          event: reconciliation ? 'reconciliation' : history ? 'history' : 'collection',
          ...(history || reconciliation ? { pendingDatasets: pending } : {}),
          succeeded: results.filter((x) => x.status === 'success').length,
          failed: results.filter((x) => x.status === 'failed').length,
          skipped: results.filter((x) => x.status === 'skipped').length,
          providerRequests: results.reduce((sum, x) => sum + x.requests, 0),
          observations: results.reduce((sum, x) => sum + x.rows, 0),
          profile: env.PULSE_EXECUTION_PROFILE ?? 'standard',
          readyOnly: selection.readyOnly ?? false,
        }),
      );
      // sync records per-job failures instead of throwing, so propagate the outcome
      // after independent jobs have finished. Cron must not report a false success.
      if (results.some((result) => result.status === 'failed'))
        throw new PulseError('UNAVAILABLE', 'One or more scheduled collection jobs failed.', true);
    } catch (error) {
      console.error(JSON.stringify({ event: 'collection_failed', ...safeError(error) }));
      throw error;
    } finally {
      await store.release(key, owner);
    }
  },
};
