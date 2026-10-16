import { parseConfig } from './config.js';
import { D1Driver, type D1Like } from './storage/driver.js';
import { Store } from './storage/store.js';
import { handle } from './api/handler.js';
import { sync } from './sync.js';
import { scheduleOptions } from './worker-schedule.js';
import { safeError } from './errors.js';
import type { Secrets } from './auth.js';
export interface WorkerEnv {
  DB: D1Like;
  ASSETS: { fetch(request: Request): Promise<Response> };
  PULSE_CONFIG: string;
  PULSE_API_TOKEN: string;
  GITHUB_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  GOOGLE_ACCESS_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  PULSE_MAX_JOBS?: string;
  PULSE_PROVIDER?: string;
}
let cached:
  | {
      db: D1Like;
      raw: string;
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
  if (cached?.db === env.DB && cached.raw === env.PULSE_CONFIG) return cached.ready;
  const ready = (async () => {
    const config = parseConfig(JSON.parse(env.PULSE_CONFIG));
    const store = new Store(new D1Driver(env.DB));
    await store.migrate();
    await store.register(config);
    return { store, config };
  })();
  cached = { db: env.DB, raw: env.PULSE_CONFIG, ready };
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
    const { store, config } = await context(env);
    if (config.demo) return;
    const owner = crypto.randomUUID(),
      key = 'scheduler';
    if (!(await store.acquire(key, owner))) return;
    try {
      const results = await sync(config, store, environmentSecrets(env), {
        ...selection,
        rotate: true,
      });
      // Only aggregate result codes. No URLs, credentials or provider payloads in logs.
      console.log(
        JSON.stringify({
          event: 'collection',
          succeeded: results.filter((x) => x.status === 'success').length,
          failed: results.filter((x) => x.status === 'failed').length,
        }),
      );
    } catch (error) {
      console.error(JSON.stringify({ event: 'collection_failed', ...safeError(error) }));
      throw error;
    } finally {
      await store.release(key, owner);
    }
  },
};
