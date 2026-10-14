import { invariant } from './errors.js';
import { METRICS, type Observation, type Collected, observationKey } from './model.js';
import { day, range } from './time.js';
export function object(value: unknown, where = 'response'): Record<string, unknown> {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `Provider returned an invalid ${where}.`,
  );
  return value as Record<string, unknown>;
}
export function array(value: unknown, where = 'rows'): unknown[] {
  invariant(Array.isArray(value), `Provider omitted or malformed ${where}.`);
  return value;
}
export function number(value: unknown, where = 'metric', integer = false): number {
  invariant(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER &&
      (!integer || Number.isInteger(value)),
    `Provider returned an invalid ${where}.`,
  );
  return value;
}
export function text(value: unknown, where = 'dimension', maximum = 2048): string {
  invariant(
    typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value),
    `Provider returned an invalid ${where}.`,
  );
  return value;
}
export function safePath(value: unknown): string {
  const raw = text(value, 'page path');
  // Discard query strings and fragments rather than persisting accidental personal data.
  const path = raw.split(/[?#]/, 1)[0] ?? '/';
  invariant(
    path.startsWith('/') && !path.startsWith('//'),
    'Provider returned an invalid page path.',
  );
  return path;
}
export function safeUrl(value: unknown): string {
  const raw = text(value, 'URL');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid provider URL');
  }
  invariant(
    ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password,
    'Provider returned an unsafe URL.',
  );
  u.search = '';
  u.hash = '';
  return u.toString();
}
export function validateCollected(c: Collected, provider: string, maxRows: number): void {
  range(c.range.from, c.range.to, 3660);
  invariant(c.observations.length <= maxRows * 8, 'Observation budget exceeded.');
  invariant(
    ['complete', 'provider_limited', 'top_n'].includes(c.completeness),
    'Invalid collection coverage.',
  );
  const seen = new Set<string>();
  for (const o of c.observations) {
    invariant(
      METRICS[o.metric] && o.metric.startsWith(provider + '.'),
      'Unknown or cross-provider metric.',
    );
    number(o.value);
    day(o.from);
    day(o.to);
    invariant(o.from <= o.to, 'Reversed observation period.');
    invariant(
      o.from >= c.range.from && o.to <= c.range.to,
      'Provider returned an observation outside the collected range.',
    );
    invariant(['daily', 'rolling', 'snapshot'].includes(o.kind), 'Invalid observation kind.');
    invariant(
      ['observed', 'provisional', 'sampled', 'provider_limited', 'top_n'].includes(o.quality),
      'Invalid observation quality.',
    );
    invariant(['UTC', 'America/Los_Angeles'].includes(o.timezone), 'Unsupported source timezone.');
    text(o.methodology, 'methodology', 128);
    invariant(Object.keys(o.dimensions).length <= 8, 'Too many dimensions.');
    for (const [key, value] of Object.entries(o.dimensions)) {
      invariant(/^[a-z][a-zA-Z_]{0,31}$/.test(key), 'Invalid dimension key.');
      text(value);
    }
    if (o.numerator !== undefined) number(o.numerator);
    if (o.denominator !== undefined) number(o.denominator);
    if (o.kind !== 'rolling')
      invariant(o.from === o.to, 'Daily observations and snapshots must have one source date.');
    const definition = METRICS[o.metric]!;
    if (definition.aggregation === 'weighted_mean' || definition.aggregation === 'ratio') {
      invariant(
        o.numerator !== undefined && o.denominator !== undefined && o.denominator > 0,
        'Weighted metrics require a positive denominator and explicit numerator.',
      );
      invariant(
        Math.abs(o.value - o.numerator / o.denominator) <= 1e-9 * Math.max(1, o.value),
        'Weighted metric value disagrees with its numerator and denominator.',
      );
    }

    const key = observationKey(o);
    invariant(!seen.has(key), 'Provider returned duplicate observation keys.');
    seen.add(key);
  }
  for (const a of c.annotations ?? []) {
    day(a.date);
    text(a.title, 'annotation', 160);
    text(a.id, 'annotation ID', 160);
    invariant(a.kind === 'release' || a.kind === 'note', 'Unknown annotation kind.');
    if (a.url)
      invariant(
        safeUrl(a.url) === a.url,
        'Annotation URLs must not contain query strings or fragments.',
      );
  }
}
/** Merge only counts after privacy sanitization collapses equivalent path dimensions. */
export function coalesceCounts(rows: Observation[]): Observation[] {
  const merged = new Map<string, Observation>();
  for (const o of rows) {
    const key = observationKey(o);
    const old = merged.get(key);
    if (!old) {
      merged.set(key, { ...o });
      continue;
    }
    invariant(
      METRICS[o.metric]?.aggregation === 'sum',
      'Cannot coalesce non-additive observations.',
    );
    old.value += o.value;
    number(old.value);
    if (o.quality !== 'observed') old.quality = o.quality;
  }
  return [...merged.values()];
}
