import type { Provider } from './config.js';
import { PulseError } from './errors.js';
import type { SyncOptions } from './sync.js';

const providers = ['github', 'npm', 'cloudflare', 'gsc', 'sense6'] as const;

/** Explicit installation controls; credentials and source data never belong here. */
export function scheduleOptions(env: {
  PULSE_MAX_JOBS?: string;
  PULSE_PROVIDER?: string;
  PULSE_EXECUTION_PROFILE?: string;
  PULSE_READY_ONLY?: string;
}): Pick<
  SyncOptions,
  | 'maxJobs'
  | 'provider'
  | 'readyOnly'
  | 'maximumRequests'
  | 'maximumBytes'
  | 'maximumRows'
  | 'retryRateLimits'
> {
  const profile = env.PULSE_EXECUTION_PROFILE;
  if (profile !== undefined && profile !== 'free')
    throw new PulseError('CONFIG', 'Invalid execution profile.');
  if (env.PULSE_READY_ONLY !== undefined && !['true', 'false'].includes(env.PULSE_READY_ONLY))
    throw new PulseError('CONFIG', 'Invalid ready-only setting.');
  const maxJobs = Number(env.PULSE_MAX_JOBS ?? (profile === 'free' ? '1' : '8'));
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 32)
    throw new PulseError('CONFIG', 'Invalid scheduled job bound; expected 1 to 32.');
  if (profile === 'free' && maxJobs !== 1)
    throw new PulseError(
      'CONFIG',
      'The Free execution profile requires exactly one job per invocation.',
    );
  const budgets =
    profile === 'free'
      ? { maximumRequests: 8, maximumBytes: 262144, maximumRows: 250, retryRateLimits: false }
      : {};
  const readiness = env.PULSE_READY_ONLY === 'true' ? { readyOnly: true } : {};
  const provider = env.PULSE_PROVIDER;
  if (provider === undefined) return { maxJobs, ...budgets, ...readiness };
  if (!(providers as readonly string[]).includes(provider))
    throw new PulseError('CONFIG', 'Invalid scheduled provider selection.');
  return { maxJobs, provider: provider as Provider, ...budgets, ...readiness };
}
