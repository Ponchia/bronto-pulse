import { parseConfig, type Config } from '../src/config.js';
import type { CollectContext } from '../src/collectors/context.js';
import type { SelfHostedRuntime } from '../src/selfhost/policy.js';
import { ctx } from './helpers.js';

/** Reserved test name: it resolves nowhere, so a lookup could never succeed. */
export const HOST = 'analytics.pulse-fixture.example';
/** The credential `ctx()` supplies under TEST_TOKEN. */
export const TOKEN = 'private-test-token-not-for-logs';
export const ADDRESS_SETTING = 'ANALYTICS_ADDRESS';

export function selfHostedConfig(
  provider: 'plausible' | 'umami',
  instance: Record<string, unknown> = {},
  resource: Record<string, unknown> = {},
): Config {
  const declared = { instance: 'home', hostname: HOST, addressEnv: ADDRESS_SETTING, ...instance };
  return parseConfig({
    version: 1,
    settings: { maxRows: 50, lookbackDays: 14, requestTimeoutMs: 4000 },
    connections: [{ id: 'analytics', provider, tokenEnv: 'TEST_TOKEN', selfHosted: declared }],
    resources: [
      provider === 'plausible'
        ? {
            id: 'site',
            provider,
            siteId: 'site.example.org',
            timezone: 'Europe/Madrid',
            connection: 'analytics',
            instance: declared.instance,
            ...resource,
          }
        : {
            id: 'site',
            provider,
            websiteId: 'website-123',
            connection: 'analytics',
            instance: declared.instance,
            ...resource,
          },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
}
/**
 * Collection context whose generic client fails the test if it is ever
 * used: a self-hosted read must not touch the fixed-origin fetch path.
 */
export function context(
  config: Config,
  runtime: SelfHostedRuntime | undefined,
): CollectContext & { genericFetches: () => number; tokenReads: () => number } {
  let fetches = 0,
    reads = 0;
  const base = ctx(config, async () => {
    fetches++;
    throw new Error('generic fetch must not be used for a self-hosted read');
  });
  const original = base.credentials.token.bind(base.credentials);
  base.credentials.token = async (connection) => {
    reads++;
    return original(connection);
  };
  return {
    ...base,
    bindings: runtime ? { selfHosted: runtime } : {},
    genericFetches: () => fetches,
    tokenReads: () => reads,
  };
}
