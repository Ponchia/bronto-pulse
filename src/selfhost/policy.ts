import type { Connection } from '../config.js';
import type { Secrets } from '../auth.js';
import { PulseError } from '../errors.js';
import { day } from '../time.js';

/**
 * Admission policy for self-hosted analytics reads (ADR 0004). This module is
 * runtime-neutral and performs no I/O: it decides which destination and which
 * request may exist at all. The Node-only socket code lives in
 * `node-transport.ts` and accepts nothing that did not pass through here.
 *
 * There is deliberately no URL type in this contract. A destination is an
 * operator-declared hostname plus a literal address from the deployment
 * environment, and a request is one member of a closed union of provider reads.
 */
export type SelfHostedVariant = 'plausible-ce' | 'umami-selfhosted';
export type AddressClass = 'public' | 'private' | 'loopback';
export interface PinnedDestination {
  /** Operator label of the provider installation, not of a website. */
  readonly instance: string;
  readonly variant: SelfHostedVariant;
  /** Used for TLS SNI, certificate verification and the HTTP Host header only. */
  readonly hostname: string;
  readonly port: number;
  /** The only address the socket may connect to. Never resolved from DNS. */
  readonly address: string;
  readonly addressClass: AddressClass;
}
export type SelfHostedRead =
  | {
      readonly variant: 'plausible-ce';
      readonly siteId: string;
      readonly from: string;
      readonly to: string;
      readonly limit: number;
    }
  | {
      readonly variant: 'umami-selfhosted';
      readonly websiteId: string;
      readonly startAt: number;
      readonly endAt: number;
    };
export interface WireRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: string;
}
export interface PinnedCall {
  readonly destination: PinnedDestination;
  readonly read: SelfHostedRead;
  readonly token: string;
  readonly timeoutMs: number;
  readonly maximumBytes: number;
}
export interface PinnedReply {
  readonly status: number;
  readonly retryAfter: string | null;
  /** Empty unless the status is 200. Error bodies are never read. */
  readonly body: Uint8Array;
}
export type PinnedExchange = (call: PinnedCall) => Promise<PinnedReply>;
/**
 * Test-fixture seam. Loopback is prohibited for every production input, yet a
 * synthetic TLS server can only listen there. A test builds its own runtime
 * object in code and lists the exact loopback literals of its fixture under
 * this symbol. A symbol key cannot be produced by JSON configuration, an
 * environment variable or a command-line flag, `nodeSelfHosted` never sets
 * it, and nothing under `src/selfhost` is re-exported from the package.
 */
export const SYNTHETIC_LOOPBACK: unique symbol = Symbol('pulse.selfhost.synthetic-loopback');
/**
 * Installation-owned capability. `settings` is the deployment environment
 * that carries pinned addresses and private-network admissions; it is never
 * taken from project configuration, a request, the dashboard or an agent.
 */
export interface SelfHostedRuntime {
  readonly exchange: PinnedExchange;
  readonly settings: Secrets;
  readonly [SYNTHETIC_LOOPBACK]?: readonly string[];
}
/** Deployment-level list of the exact RFC 1918 literals the operator admits. */
export const PRIVATE_ADMISSION_SETTING = 'PULSE_SELFHOSTED_PRIVATE_ADDRESSES';

const INSTANCE = /^[a-z][a-z0-9_-]{0,63}$/;
const SETTING = /^[A-Z][A-Z0-9_]{0,127}$/;
// Every label is LDH and the last label starts with a letter. That refuses
// single-label names and every spelling a URL parser would read as an IPv4
// address (`127.1`, `0x7f.0.0.1`, `2130706433`), so a hostname can never
// double as a destination.
const HOSTNAME =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// The hosted services keep their fixed-origin adapters and their own identity.
// The hostname is never resolved, so a loopback or metadata name could not
// reach those services; refusing them keeps a confused declaration out anyway.
const REFUSED_NAMES = [
  'plausible.io',
  'umami.is',
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
];

/** Canonical dotted-decimal only: no octal, hex, shorthand, padding, IPv6 or whitespace. */
export function parseIpv4Literal(value: unknown): [number, number, number, number] | undefined {
  if (typeof value !== 'string' || value.length > 15) return undefined;
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) =>
    /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255 ? Number(part) : -1,
  );
  if (octets.some((octet) => octet < 0)) return undefined;
  return octets as [number, number, number, number];
}
/**
 * Classify one IPv4 address. `prohibited` covers cloud metadata, link-local,
 * unspecified, shared (RFC 6598), multicast, reserved, broadcast, relay,
 * documentation and benchmarking space: no setting admits those. RFC 1918
 * space is reachable only by exact literal admission. Loopback is reported
 * separately only so that the test-fixture seam can name it; every
 * production path treats it as prohibited.
 */
export function classifyAddress(
  octets: readonly [number, number, number, number],
): AddressClass | 'prohibited' {
  const [a, b, c, d] = octets;
  if (a === 0) return 'prohibited'; // "this network" and the unspecified address
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  // Shared address space is not RFC 1918 and contains a metadata service.
  if (a === 100 && b >= 64 && b <= 127) return 'prohibited';
  if (a === 169 && b === 254) return 'prohibited'; // link-local, instance metadata
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'prohibited'; // protocol assignments (192.0.0.192 metadata), TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return 'prohibited'; // deprecated 6to4 relay anycast
  if (a === 192 && b === 168) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'prohibited'; // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'prohibited'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'prohibited'; // TEST-NET-3
  if (a === 168 && b === 63 && c === 129 && d === 16) return 'prohibited'; // cloud platform wire server
  if (a >= 224) return 'prohibited'; // multicast, reserved, limited broadcast
  return 'public';
}
export function isInstanceHostname(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    HOSTNAME.test(value) &&
    !REFUSED_NAMES.some((name) => value === name || value.endsWith('.' + name))
  );
}
/** 443, or an unprivileged port the operator names. Never another well-known service port. */
export function isInstancePort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (value === 443 || (value >= 1024 && value <= 65535))
  );
}
export function selfHostedVariant(provider: string): SelfHostedVariant | undefined {
  return provider === 'plausible'
    ? 'plausible-ce'
    : provider === 'umami'
      ? 'umami-selfhosted'
      : undefined;
}

const ADMITTED = new WeakSet<object>();
/** True only for the exact frozen object `admitDestination` returned. */
export function isAdmittedDestination(value: unknown): value is PinnedDestination {
  return typeof value === 'object' && value !== null && ADMITTED.has(value);
}
type Resolution =
  { destination: PinnedDestination } | { refused: string; setting: string | undefined };
function resolve(connection: Connection | undefined, runtime: SelfHostedRuntime): Resolution {
  const settings: Secrets =
    typeof runtime?.settings === 'object' && runtime.settings !== null ? runtime.settings : {};
  const declared = connection?.selfHosted;
  const variant = connection ? selfHostedVariant(connection.provider) : undefined;
  if (!connection || !declared || !variant)
    return {
      refused: 'This connection declares no self-hosted provider instance.',
      setting: undefined,
    };
  // Re-validate instead of trusting that the object came from parseConfig.
  if (
    typeof declared.instance !== 'string' ||
    !INSTANCE.test(declared.instance) ||
    !isInstanceHostname(declared.hostname) ||
    !isInstancePort(declared.port) ||
    typeof declared.addressEnv !== 'string' ||
    !SETTING.test(declared.addressEnv) ||
    declared.addressEnv === PRIVATE_ADMISSION_SETTING
  )
    return { refused: 'Self-hosted instance declaration is invalid.', setting: undefined };
  const octets = parseIpv4Literal(settings[declared.addressEnv]);
  if (!octets)
    return {
      refused: `Pinned address setting ${declared.addressEnv} must hold exactly one canonical dotted-decimal IPv4 literal. Hostnames, IPv6 and alternative encodings are refused.`,
      setting: declared.addressEnv,
    };
  const addressClass = classifyAddress(octets);
  if (addressClass === 'prohibited')
    return {
      refused: `Pinned address setting ${declared.addressEnv} names a prohibited range (metadata, link-local, shared, unspecified, multicast, reserved or documentation space).`,
      setting: declared.addressEnv,
    };
  const address = octets.join('.');
  if (addressClass === 'loopback') {
    const fixture = runtime?.[SYNTHETIC_LOOPBACK];
    if (!Array.isArray(fixture) || !fixture.includes(address))
      return {
        refused: `Pinned address setting ${declared.addressEnv} names a loopback address. No setting admits loopback.`,
        setting: declared.addressEnv,
      };
  }
  if (addressClass === 'private') {
    const raw = settings[PRIVATE_ADMISSION_SETTING];
    const entries = typeof raw === 'string' && raw.length <= 4096 ? raw.split(',') : [];
    // One malformed, public, loopback or prohibited entry voids the whole list.
    const valid = entries.every((entry) => {
      const parsed = parseIpv4Literal(entry);
      return parsed !== undefined && classifyAddress(parsed) === 'private';
    });
    if (!entries.length || !valid || !entries.includes(address))
      return {
        refused: `Pinned address setting ${declared.addressEnv} names an RFC 1918 address that ${PRIVATE_ADMISSION_SETTING} does not admit as an exact literal.`,
        setting: PRIVATE_ADMISSION_SETTING,
      };
  }
  const destination: PinnedDestination = Object.freeze({
    instance: declared.instance,
    variant,
    hostname: declared.hostname,
    port: declared.port,
    address,
    addressClass,
  });
  ADMITTED.add(destination);
  return { destination };
}
/**
 * The only constructor of a destination. Runs before any credential is read
 * and before any socket exists; refusals name a setting, never its value.
 */
export function admitDestination(
  connection: Connection | undefined,
  runtime: SelfHostedRuntime,
): PinnedDestination {
  const result = resolve(connection, runtime);
  if ('refused' in result) throw new PulseError('CONFIG', result.refused);
  return result.destination;
}
/** Names the deployment setting that blocks admission, for readiness reporting. */
export function admissionBlocker(
  connection: Connection | undefined,
  runtime: SelfHostedRuntime,
): string | undefined {
  const result = resolve(connection, runtime);
  return 'refused' in result ? (result.setting ?? 'selfHosted') : undefined;
}

const refuse = (): never => {
  throw new PulseError('CONFIG', 'Self-hosted provider read is outside the fixed read contract.');
};
/**
 * Build the one request a variant permits. Method, path, query keys and the
 * Plausible query shape are fixed here; callers supply only validated
 * identifiers and bounds, never a path, a header or a body.
 */
export function wireRequest(read: SelfHostedRead): WireRequest {
  if (read.variant === 'plausible-ce') {
    if (
      typeof read.siteId !== 'string' ||
      read.siteId.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(read.siteId) ||
      !Number.isInteger(read.limit) ||
      read.limit < 1 ||
      read.limit > 10000
    )
      refuse();
    try {
      if (day(read.from) > day(read.to)) refuse();
    } catch {
      refuse();
    }
    // Stats API v2 is a read-only query despite POST. Imports stay excluded,
    // exactly as in the hosted adapter.
    return {
      method: 'POST',
      path: '/api/v2/query',
      body: JSON.stringify({
        site_id: read.siteId,
        metrics: ['pageviews', 'visitors'],
        date_range: [read.from, read.to],
        dimensions: ['time:day'],
        include: { imports: false },
        pagination: { limit: read.limit, offset: 0 },
      }),
    };
  }
  if (read.variant === 'umami-selfhosted') {
    if (
      typeof read.websiteId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(read.websiteId) ||
      !Number.isSafeInteger(read.startAt) ||
      !Number.isSafeInteger(read.endAt) ||
      read.startAt < 0 ||
      read.endAt < read.startAt
    )
      refuse();
    // Self-hosted Umami serves its API under /api; Umami Cloud's /v1 prefix
    // belongs to the hosted adapter only.
    return {
      method: 'GET',
      path: `/api/websites/${read.websiteId}/pageviews?startAt=${read.startAt}&endAt=${read.endAt}&timezone=UTC&unit=day`,
    };
  }
  return refuse();
}
