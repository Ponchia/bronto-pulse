import { parseConfig, type Config } from '../src/config.js';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import { Credentials } from '../src/auth.js';
import { HttpClient, type Fetcher } from '../src/http.js';
import type { CollectContext } from '../src/collectors/context.js';
import { entry, collected } from '../src/collectors/context.js';
import type { Observation } from '../src/model.js';
export const now = new Date('2026-10-14T12:00:00Z');
export const window = { from: '2026-10-12', to: '2026-10-13' };
export function fixture(provider = 'github', extra: Record<string, unknown> = {}): Config {
  const settings = { maxRows: 100, lookbackDays: 14 };
  const base: Record<string, unknown> = { id: 'source', provider, ...extra };
  if (provider === 'github')
    Object.assign(base, { repository: 'example/project', connection: 'auth', ...extra });
  if (provider === 'npm') Object.assign(base, { package: '@example/package', ...extra });
  if (provider === 'cloudflare')
    Object.assign(base, {
      accountId: 'a'.repeat(32),
      siteTag: 'b'.repeat(32),
      connection: 'auth',
      ...extra,
    });
  if (provider === 'gsc')
    Object.assign(base, { siteUrl: 'sc-domain:example.invalid', connection: 'auth', ...extra });
  if (provider === 'sense6')
    Object.assign(base, {
      accountId: 'a'.repeat(32),
      databaseId: '00000000-0000-4000-8000-000000000001',
      connection: 'auth',
      ...extra,
    });
  return parseConfig({
    version: 1,
    settings,
    connections:
      provider === 'npm'
        ? []
        : [
            {
              id: 'auth',
              provider: provider === 'sense6' ? 'cloudflare' : provider,
              tokenEnv: 'TEST_TOKEN',
            },
          ],
    resources: [base],
    projects: [{ id: 'project', label: 'Example project', resources: [{ resource: 'source' }] }],
  });
}
export async function database(config = fixture()): Promise<Store> {
  const store = new Store(new SqliteDriver(':memory:'));
  await store.migrate();
  await store.register(config, now);
  return store;
}
export function ctx(config: Config, responses: unknown[] | Fetcher): CollectContext {
  const queue = Array.isArray(responses) ? [...responses] : [];
  const fetcher: Fetcher =
    typeof responses === 'function'
      ? responses
      : async () =>
          new Response(JSON.stringify(queue.shift() ?? {}), {
            headers: { 'Content-Type': 'application/json' },
          });
  const http = new HttpClient(fetcher, 1000, async () => {});
  return {
    config,
    http,
    credentials: new Credentials(
      { TEST_TOKEN: 'private-test-token-not-for-logs' },
      http,
      () => now,
    ),
    now,
    window,
  };
}
export async function publish(
  store: Store,
  config: Config,
  rows: Observation[],
  group = 'views',
  notes: string[] = [],
) {
  const r = config.resources[0]!,
    key = `${r.id}:${group}`,
    owner = crypto.randomUUID();
  await store.acquire(key, owner);
  const run = await store.begin(r, group, window, now);
  try {
    await store.publish(run, r, group, collected(window, rows, notes), key, owner, 1, now, 50000);
  } finally {
    await store.release(key, owner);
  }
  return run;
}
export const sample = (date = '2026-10-12', value = 8) => entry('github.views', date, value);
