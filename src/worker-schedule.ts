import type { Provider } from './config.js';
import { PulseError } from './errors.js';

const providers = ['github', 'npm', 'cloudflare', 'gsc', 'sense6'] as const;

/** Explicit installation controls; credentials and source data never belong here. */
export function scheduleOptions(env: { PULSE_MAX_JOBS?: string; PULSE_PROVIDER?: string }): {
  maxJobs: number;
  provider?: Provider;
} {
  const maxJobs = Number(env.PULSE_MAX_JOBS ?? '8');
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 32)
    throw new PulseError('CONFIG', 'Invalid scheduled job bound; expected 1 to 32.');
  const provider = env.PULSE_PROVIDER;
  if (provider === undefined) return { maxJobs };
  if (!(providers as readonly string[]).includes(provider))
    throw new PulseError('CONFIG', 'Invalid scheduled provider selection.');
  return { maxJobs, provider: provider as Provider };
}
