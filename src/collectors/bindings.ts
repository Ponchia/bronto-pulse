import type { Resource } from '../config.js';
import type { D1Like } from '../storage/driver.js';
import { PulseError } from '../errors.js';

/** Installation-owned binding, never selected or constructed from a request. */
export interface AggregateBindings {
  sense6?: { accountId: string; databaseId: string; database: D1Like };
}
export interface AggregateEnvironment {
  PULSE_SENSE6_DB?: D1Like;
  PULSE_SENSE6_ACCOUNT_ID?: string;
  PULSE_SENSE6_DATABASE_ID?: string;
}
export function nativeSense6(
  resource: Resource,
  bindings: AggregateBindings = {},
): D1Like | undefined {
  const source = bindings.sense6;
  return resource.provider === 'sense6' &&
    source &&
    resource.accountId === source.accountId &&
    resource.databaseId === source.databaseId
    ? source.database
    : undefined;
}
export function workerBindings(env: AggregateEnvironment): AggregateBindings {
  const fields = [env.PULSE_SENSE6_DB, env.PULSE_SENSE6_ACCOUNT_ID, env.PULSE_SENSE6_DATABASE_ID];
  if (fields.every((x) => x === undefined)) return {};
  if (
    !env.PULSE_SENSE6_DB ||
    typeof env.PULSE_SENSE6_DB.prepare !== 'function' ||
    !/^[a-f0-9]{32}$/i.test(env.PULSE_SENSE6_ACCOUNT_ID ?? '') ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      env.PULSE_SENSE6_DATABASE_ID ?? '',
    )
  )
    throw new PulseError('CONFIG', 'Native Sense6 binding identities are incomplete or invalid.');
  return {
    sense6: {
      accountId: env.PULSE_SENSE6_ACCOUNT_ID!,
      databaseId: env.PULSE_SENSE6_DATABASE_ID!,
      database: env.PULSE_SENSE6_DB,
    },
  };
}
