import type { Config, Resource } from '../config.js';
import type { HttpClient } from '../http.js';
import type { Credentials } from '../auth.js';
import type { DateRange } from '../time.js';
import type { Collected, Observation } from '../model.js';
export interface CollectContext {
  config: Config;
  http: HttpClient;
  credentials: Credentials;
  now: Date;
  window: DateRange;
}
export function groups(r: Resource): string[] {
  switch (r.provider) {
    case 'github':
    case 'cloudflare':
      return r.groups;
    case 'npm':
      return ['downloads'];
    case 'gsc':
      return [
        'totals',
        ...(r.collectPages ? ['pages'] : []),
        ...(r.collectQueries ? ['queries'] : []),
      ];
    case 'sense6':
      return ['activity'];
  }
}
export function entry(
  metric: string,
  date: string,
  value: number,
  dimensions: Observation['dimensions'] = {},
  quality: Observation['quality'] = 'observed',
  methodology = 'v1',
): Observation {
  return {
    metric,
    from: date,
    to: date,
    timezone: 'UTC',
    kind: 'daily',
    dimensions,
    value,
    quality,
    methodology,
  };
}
export function collected(
  window: DateRange,
  observations: Observation[],
  notes: string[] = [],
  completeness: Collected['completeness'] = 'complete',
): Collected {
  return { range: window, observations, notes, completeness };
}
export async function token(r: Resource, ctx: CollectContext): Promise<string> {
  return ctx.credentials.token(ctx.config.connections.find((c) => c.id === r.connection));
}
