import { PulseError } from './errors.js';

/**
 * A Cloudflare Workers Free variable is limited to 5 KB. The optional manifest
 * selects a bounded, integrity-checked sequence of separately staged secrets.
 *
 * Without PULSE_CONFIG_MANIFEST, the historical PULSE_CONFIG remains authoritative.
 * Operators can stage parts without changing production until they stage the
 * matching manifest and deploy the entire Worker Version together.
 */
const PART_KEYS = [
  'PULSE_CONFIG_PART_1',
  'PULSE_CONFIG_PART_2',
  'PULSE_CONFIG_PART_3',
  'PULSE_CONFIG_PART_4',
  'PULSE_CONFIG_PART_5',
  'PULSE_CONFIG_PART_6',
  'PULSE_CONFIG_PART_7',
  'PULSE_CONFIG_PART_8',
] as const;

const MAX_CHUNK_BYTES = 4096;
const MAX_CONFIG_BYTES = PART_KEYS.length * MAX_CHUNK_BYTES;
const encoder = new TextEncoder();

export type WorkerConfigEnvironment = {
  PULSE_CONFIG?: string;
  PULSE_CONFIG_MANIFEST?: string;
} & Partial<Record<(typeof PART_KEYS)[number], string>>;

export interface WorkerConfigSource {
  raw: string;
  /** Hash of the selected parts; null means legacy single-secret mode. */
  expectedSha256: string | null;
}

function invalid(): never {
  throw new PulseError('CONFIG', 'Invalid Worker configuration secret layout.');
}

function byteSize(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Pure input validation; never emits the configuration or its pieces in an error. */
export function workerConfigSource(env: WorkerConfigEnvironment): WorkerConfigSource {
  const manifest = env.PULSE_CONFIG_MANIFEST;
  if (manifest === undefined) {
    const raw = env.PULSE_CONFIG;
    if (typeof raw !== 'string' || !raw || byteSize(raw) > MAX_CONFIG_BYTES) invalid();
    return { raw, expectedSha256: null };
  }
  if (typeof manifest !== 'string' || byteSize(manifest) > 512) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return invalid();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'parts,sha256,version'
  )
    invalid();
  const candidate = parsed as Record<string, unknown>;
  const partCount = candidate.parts;
  if (
    candidate.version !== 1 ||
    typeof partCount !== 'number' ||
    !Number.isInteger(partCount) ||
    partCount < 2 ||
    partCount > PART_KEYS.length ||
    typeof candidate.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.sha256)
  )
    invalid();
  const parts: string[] = [];
  for (const key of PART_KEYS.slice(0, partCount)) {
    const part = env[key];
    if (typeof part !== 'string' || !part || byteSize(part) > MAX_CHUNK_BYTES) invalid();
    parts.push(part);
  }
  const raw = parts.join('');
  if (byteSize(raw) > MAX_CONFIG_BYTES) invalid();
  return { raw, expectedSha256: candidate.sha256 as string };
}

/**
 * Hash only on a new Worker configuration, not on every request to the cached
 * Worker isolate. An inconsistent staged version cannot register its sources.
 */
export async function verifyWorkerConfigSource(source: WorkerConfigSource): Promise<void> {
  if (source.expectedSha256 === null) return;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(source.raw)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== source.expectedSha256)
    throw new PulseError('CONFIG', 'Worker configuration parts fail the integrity check.');
}
