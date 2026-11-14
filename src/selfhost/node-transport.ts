import { request } from 'node:http';
import { isIPv4 } from 'node:net';
import { checkServerIdentity, connect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { Secrets } from '../auth.js';
import { PulseError } from '../errors.js';
import {
  isAdmittedDestination,
  wireRequest,
  type PinnedCall,
  type PinnedExchange,
  type PinnedReply,
  type SelfHostedRuntime,
} from './policy.js';

/**
 * Node/OCI-only pinned HTTPS transport (ADR 0004). This is the single module
 * that opens a socket to an operator's own analytics instance. It must never
 * be imported from the Worker graph: `src/cli.ts` is its only importer.
 *
 * One call is one fresh TLS connection to the admitted literal address. No
 * agent, pool, proxy, DNS lookup, redirect or retry exists here. The
 * credential is written only after the certificate has verified for the
 * declared hostname and the peer address equals the pin.
 */
export interface PinnedTransportOptions {
  /**
   * Trust anchors that replace Node's default roots, for embedders and the
   * synthetic TLS tests. The CLI never sets it: a private CA is supplied
   * through Node's own NODE_EXTRA_CA_CERTS. There is no option to relax
   * verification.
   */
  readonly ca?: string | Buffer | readonly (string | Buffer)[];
}
const MAXIMUM_HEADER_BYTES = 16 * 1024;
const fail = (category: string, sent: boolean, retryable: boolean) =>
  new PulseError(
    'NETWORK',
    `Self-hosted provider connection failed (${category}). ${
      sent ? 'The request may have been sent' : 'No credential was sent'
    }; no upstream error content retained.`,
    retryable,
  );
/** Map a runtime failure to a fixed category. The message is never reused. */
function category(error: unknown): { name: string; retryable: boolean } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID')
    return { name: 'certificate-name', retryable: false };
  if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID')
    return { name: 'certificate-validity', retryable: false };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ISSUER/.test(code))
    return { name: 'certificate-untrusted', retryable: false };
  if (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS') || code === 'EPROTO')
    return { name: 'tls-protocol', retryable: false };
  if (code.startsWith('HPE_')) return { name: 'http-protocol', retryable: false };
  if (code === 'PULSE_LOOKUP_REFUSED') return { name: 'name-lookup-refused', retryable: false };
  if (code === 'ECONNREFUSED') return { name: 'connection-refused', retryable: true };
  if (code === 'ECONNRESET' || code === 'EPIPE')
    return { name: 'connection-reset', retryable: true };
  if (code === 'ETIMEDOUT') return { name: 'timeout', retryable: true };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH')
    return { name: 'unreachable', retryable: true };
  return { name: 'other', retryable: true };
}
function exchange(call: PinnedCall, options: PinnedTransportOptions): Promise<PinnedReply> {
  const { destination, read, token, timeoutMs, maximumBytes } = call;
  // Only the frozen object the admission policy produced is accepted; a
  // look-alike built elsewhere never reaches a socket.
  if (!isAdmittedDestination(destination) || !isIPv4(destination.address))
    throw new PulseError('CONFIG', 'Self-hosted destination was not admitted.');
  if (destination.variant !== read.variant)
    throw new PulseError('CONFIG', 'Self-hosted read does not match the instance variant.');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new PulseError(
      'CONFIG',
      'Certificate verification is disabled for this process (NODE_TLS_REJECT_UNAUTHORIZED). Self-hosted collection is refused.',
    );
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    typeof token !== 'string' ||
    !/^[\x21-\x7e]{1,4096}$/.test(token)
  )
    throw new PulseError('CONFIG', 'Self-hosted request bounds or credential format are invalid.');
  const wire = wireRequest(read);
  const { hostname, port, address } = destination;
  return new Promise<PinnedReply>((resolve, reject) => {
    let settled = false;
    let sent = false;
    let socket: TLSSocket | undefined;
    const finish = (error: PulseError | undefined, reply?: PinnedReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket?.destroy();
      if (error) reject(error);
      else resolve(reply!);
    };
    // One total deadline covers connect, handshake, headers and body, so a
    // slow drip cannot hold the collector by resetting an idle timer.
    const deadline = setTimeout(() => finish(fail('timeout', sent, true)), timeoutMs);
    const broken = (error: unknown) => {
      const { name, retryable } = category(error);
      finish(fail(name, sent, retryable));
    };
    try {
      const settings: ConnectionOptions = {
        host: address,
        port,
        // A literal address needs no resolution. Any lookup is a defect.
        lookup: (_name, _options, callback) =>
          callback(Object.assign(new Error('refused'), { code: 'PULSE_LOOKUP_REFUSED' }), '', 4),
        servername: hostname,
        rejectUnauthorized: true,
        checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
        minVersion: 'TLSv1.2',
        ALPNProtocols: ['http/1.1'],
      };
      if (options.ca !== undefined)
        settings.ca = options.ca as string | Buffer | (string | Buffer)[];
      socket = connect(settings);
    } catch (error) {
      broken(error);
      return;
    }
    const tls = socket;
    // `finish` is idempotent, so late socket errors stay handled.
    tls.on('error', broken);
    // A body delimited by connection close ends and closes together. Let the
    // response's own end event settle first.
    tls.once('close', () => setImmediate(() => finish(fail('connection-closed', sent, true))));
    tls.once('secureConnect', () => {
      if (
        tls.authorized !== true ||
        tls.remoteFamily !== 'IPv4' ||
        tls.remoteAddress !== address ||
        tls.remotePort !== port
      ) {
        finish(fail('peer-mismatch', false, false));
        return;
      }
      const outgoing = request(
        {
          // The verified socket is the only connection. Without an agent
          // there is no pool, no proxy selection and no keep-alive reuse.
          createConnection: () => tls,
          method: wire.method,
          path: wire.path,
          setHost: false,
          maxHeaderSize: MAXIMUM_HEADER_BYTES,
          headers: {
            Host: port === 443 ? hostname : `${hostname}:${port}`,
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            Connection: 'close',
            ...(wire.body === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': String(Buffer.byteLength(wire.body)),
                }),
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const header = response.headers['retry-after'];
          // Reject over-bound guidance whole: truncating it can invent or shorten a wait.
          const retryAfter = typeof header === 'string' && header.length <= 64 ? header : null;
          // Redirect targets and error bodies are never read or retained.
          if (status !== 200) {
            finish(undefined, { status, retryAfter, body: new Uint8Array() });
            return;
          }
          const encoding = response.headers['content-encoding'];
          if (encoding !== undefined && encoding !== 'identity') {
            // No compression was requested, so none is decoded.
            finish(
              new PulseError(
                'SCHEMA',
                'Self-hosted provider sent an unrequested content encoding.',
              ),
            );
            return;
          }
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > maximumBytes) {
            finish(
              new PulseError('ROW_LIMIT', 'Self-hosted provider response exceeds the byte budget.'),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > maximumBytes)
              finish(
                new PulseError(
                  'ROW_LIMIT',
                  'Self-hosted provider response exceeds the byte budget.',
                ),
              );
            else chunks.push(chunk);
          });
          response.once('error', broken);
          response.once('aborted', () => finish(fail('response-truncated', true, true)));
          response.once('end', () => {
            if (!response.complete) finish(fail('response-truncated', true, true));
            else
              finish(undefined, {
                status,
                retryAfter,
                body: new Uint8Array(Buffer.concat(chunks)),
              });
          });
        },
      );
      outgoing.once('error', broken);
      sent = true;
      outgoing.end(wire.body);
    });
  });
}
export function createPinnedTransport(options: PinnedTransportOptions = {}): PinnedExchange {
  return async (call) => exchange(call, options);
}
/**
 * The installation-owned capability the CLI injects. `environment` supplies
 * the pinned address and private-network admission settings.
 */
export function nodeSelfHosted(environment: Secrets): SelfHostedRuntime {
  return Object.freeze({ exchange: createPinnedTransport(), settings: environment });
}
