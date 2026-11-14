import { credentialStatus, type Secrets } from '../auth.js';
import type { CollectContext } from '../collectors/context.js';
import type { Connection } from '../config.js';
import { PulseError } from '../errors.js';
import {
  admissionBlocker,
  admitDestination,
  wireRequest,
  type PinnedReply,
  type SelfHostedRead,
  type SelfHostedRuntime,
} from './policy.js';

/** A daily series of at most 10,000 rows is far below this. */
export const SELF_HOSTED_MAXIMUM_BYTES = 2 * 1024 * 1024;

/**
 * Readiness of a connection, including the self-hosted destination. A
 * self-hosted connection is never ready without the installation-owned pinned
 * transport, so a Worker reports it as unavailable instead of attempting it.
 */
export function connectionStatus(
  connection: Connection | undefined,
  secrets: Secrets,
  runtime: SelfHostedRuntime | undefined,
): { available: boolean; method: string; missing: string[] } {
  const status = credentialStatus(connection, secrets);
  if (!connection?.selfHosted) return status;
  const missing = [...status.missing];
  if (!runtime) missing.push('node-pinned-transport');
  else {
    const blocker = admissionBlocker(connection, runtime);
    if (blocker) missing.push(blocker);
  }
  return { available: missing.length === 0, method: 'token-pinned-self-hosted', missing };
}

/**
 * One bounded read from a self-hosted provider instance. Order matters:
 * runtime capability, destination admission and request construction all
 * succeed before the credential is read, and the credential is read before
 * any socket exists. There is one attempt and no in-job retry; a retryable
 * failure is left to the scheduler so a misbehaving instance cannot make
 * the collector resend its key.
 */
export async function selfHostedJson(
  ctx: CollectContext,
  connection: Connection | undefined,
  read: SelfHostedRead,
): Promise<unknown> {
  const runtime = ctx.bindings?.selfHosted;
  if (!runtime || typeof runtime.exchange !== 'function')
    throw new PulseError(
      'CONFIG',
      'Self-hosted provider collection requires the Node/OCI pinned transport. This runtime refuses it.',
    );
  const destination = admitDestination(connection, runtime);
  if (destination.variant !== read.variant)
    throw new PulseError('CONFIG', 'Self-hosted read does not match the instance variant.');
  wireRequest(read);
  const token = await ctx.credentials.token(connection);
  // Visible ASCII without spaces: nothing that could split or extend a header.
  if (!/^[\x21-\x7e]{1,4096}$/.test(token))
    throw new PulseError('AUTH', 'Self-hosted provider credential has an invalid format.');
  // Share the per-job request accounting that runs and reports already read.
  ctx.http.requests++;
  let reply: PinnedReply;
  try {
    reply = await runtime.exchange({
      destination,
      read,
      token,
      timeoutMs: ctx.config.settings.requestTimeoutMs,
      maximumBytes: SELF_HOSTED_MAXIMUM_BYTES,
    });
  } catch (error) {
    // The transport raises only fixed messages. Anything else is discarded:
    // a runtime exception may quote a header, an address or a body.
    if (error instanceof PulseError) throw error;
    throw new PulseError(
      'NETWORK',
      'Self-hosted provider request failed. No upstream error content retained.',
      true,
    );
  }
  const status = reply?.status;
  if (!Number.isInteger(status))
    throw new PulseError('SCHEMA', 'Self-hosted transport returned no status.');
  if (status >= 300 && status < 400)
    throw new PulseError(
      'REDIRECT',
      'Self-hosted provider redirect refused. Verify the instance hostname and port.',
    );
  if (status === 401)
    throw new PulseError('AUTH', 'Self-hosted provider rejected the instance credential.');
  if (status === 403)
    throw new PulseError(
      'PERMISSION',
      'Self-hosted provider denied this dataset. Verify the instance key and site access.',
    );
  if (status === 404)
    throw new PulseError(
      'NOT_FOUND',
      'Self-hosted provider has no such site or read endpoint. Verify the site identity and instance version.',
    );
  if (status === 429)
    throw new PulseError(
      'RATE_LIMIT',
      'Self-hosted provider rate limit requires a later collection run.',
      true,
    );
  if (status !== 200)
    throw new PulseError('UNAVAILABLE', `Self-hosted provider returned HTTP ${status}.`);
  if (!(reply.body instanceof Uint8Array))
    throw new PulseError('SCHEMA', 'Self-hosted provider returned no JSON body.');
  if (reply.body.byteLength > SELF_HOSTED_MAXIMUM_BYTES)
    throw new PulseError('ROW_LIMIT', 'Self-hosted provider response exceeds the byte budget.');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.body)) as unknown;
  } catch {
    throw new PulseError('SCHEMA', 'Self-hosted provider returned malformed JSON.');
  }
}
