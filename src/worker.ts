import { workerBindings, type AggregateEnvironment } from './collectors/bindings.js';
import { parseConfig } from './config.js';
import { D1Driver, type D1Like } from './storage/driver.js';
import { Store } from './storage/store.js';
import { handle } from './api/handler.js';
import { sync } from './sync.js';
import { scheduleOptions } from './worker-schedule.js';
import { PulseError, safeError } from './errors.js';
import type { Secrets } from './auth.js';
import { workerAccess, type AccessEnvironment } from './api/access.js';
export interface WorkerEnv extends AccessEnvironment, AggregateEnvironment {
  DB: D1Like;
  ASSETS: { fetch(request: Request): Promise<Response> };
  PULSE_CONFIG: string;
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
}
let cached:
  | {
      db: D1Like;
      raw: string;
      profile: string | undefined;
      ready: Promise<{ store: Store; config: ReturnType<typeof parseConfig> }>;
    }
  | undefined;
function environmentSecrets(env: WorkerEnv): Secrets {
  // No bindings or objects are passed to provider credential resolution.
  return Object.fromEntries(
    Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  );
}
async function context(env: WorkerEnv) {
  if (
    cached?.db === env.DB &&
    cached.raw === env.PULSE_CONFIG &&
    cached.profile === env.PULSE_EXECUTION_PROFILE
  )
    return cached.ready;
  const ready = (async () => {
    const config = parseConfig(JSON.parse(env.PULSE_CONFIG));
    const store = new Store(new D1Driver(env.DB));
    if (env.PULSE_EXECUTION_PROFILE === 'free') {
      // Provision schema once through migrations rather than on every cold start.
      if (
        (await store.getSetting('schema_version')) !== '1' ||
        !(
          await store.driver.all({
            sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='url_inspections'",
          })
        ).length
      )
        throw new PulseError(
          'SCHEMA',
          'Apply supported database migrations before enabling the Free profile.',
        );
    } else await store.migrate();
    await store.register(config);
    return { store, config };
  })();
  cached = { db: env.DB, raw: env.PULSE_CONFIG, profile: env.PULSE_EXECUTION_PROFILE, ready };
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
      return await handle(request, {
        loadData: () => context(env),
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
  async scheduled(_event: { scheduledTime: number }, env: WorkerEnv): Promise<void> {
    // Validate explicit scheduling controls before touching private storage.
    const selection = scheduleOptions(env);
    const bindings = workerBindings(env);
    const { store, config } = await context(env);
    if (config.demo) return;
    const owner = crypto.randomUUID(),
      key = 'scheduler';
    if (!(await store.acquire(key, owner))) return;
    try {
      const results = await sync(config, store, environmentSecrets(env), {
        ...selection,
        bindings,
        rotate: true,
      });
      // Only aggregate result codes. No URLs, credentials or provider payloads in logs.
      console.log(
        JSON.stringify({
          event: 'collection',
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
