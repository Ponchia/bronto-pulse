/**
 * Latest instant a stored wait can name. A stated wait is never shortened: one
 * that runs past this instant is kept as this instant, an indefinite hold.
 */
export const RETRY_HOLD_INSTANT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** A stored provider wait, tied to the failed run that received it. */
export interface RetryGuidance {
  /** `resourceId:group`, the dataset lease key. */
  dataset: string;
  runId: string;
  /** ISO instant: failure time plus the stated wait. */
  notBefore: string;
}

/** Digits only. Beyond exact integer range the count is unbounded, not dropped. */
function count(digits: string): number {
  // HTTP delay-seconds permits leading zeroes. Only significant digits
  // determine overflow; zero padding must never create an indefinite hold.
  const significant = digits.replace(/^0+/, '');
  return significant.length <= 15 ? Number(significant) : Number.POSITIVE_INFINITY;
}

/** A positive wait rounded up to whole seconds, possibly unbounded; else no guidance. */
export function validRetryAfter(seconds: number): number | undefined {
  return Number.isNaN(seconds) || seconds <= 0 ? undefined : Math.ceil(seconds);
}

/** The instant a wait ends, measured from the failure, held at the last representable one. */
export function retryNotBefore(failedAtMs: number, seconds: number): Date {
  return new Date(Math.min(failedAtMs + seconds * 1000, RETRY_HOLD_INSTANT));
}

/**
 * Numeric wait guidance from a rate-limited response, or undefined.
 *
 * Only `Retry-After` (delta-seconds or an IMF-fixdate) is read, plus GitHub's
 * documented `x-ratelimit-reset` when its remaining quota is zero. The header
 * text itself is never returned or stored: the result is one number of
 * seconds. Parsing is bounded; the wait is not. When both are present the
 * longer wait is used.
 */
export function retryAfterSeconds(
  headers: Headers,
  nowMs: number,
  githubQuota = false,
): number | undefined {
  const waits: number[] = [];
  const raw = headers.get('retry-after')?.trim();
  if (raw && /^\d+$/.test(raw)) waits.push(count(raw));
  else if (raw && IMF_FIXDATE.test(raw)) waits.push((Date.parse(raw) - nowMs) / 1000);
  if (githubQuota && headers.get('x-ratelimit-remaining')?.trim() === '0') {
    const reset = headers.get('x-ratelimit-reset')?.trim();
    if (reset && /^\d{9,}$/.test(reset)) waits.push(count(reset) - nowMs / 1000);
  }
  return waits
    .map(validRetryAfter)
    .reduce<number | undefined>(
      (longest, wait) => (wait === undefined ? longest : Math.max(longest ?? 0, wait)),
      undefined,
    );
}
