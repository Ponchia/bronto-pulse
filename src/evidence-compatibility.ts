import type { MetricCard } from './report.js';
import { day, addDays } from './time.js';

/** A decision about arithmetic evidence, never audience identity or statistical significance. */
export interface DailyCountDecision {
  eligible: boolean;
  issues: {
    code:
      | 'invalid_period'
      | 'unsupported_unit'
      | 'non_additive'
      | 'invalid_total'
      | 'incomplete_coverage'
      | 'limited_quality'
      | 'invalid_daily_buckets'
      | 'inconsistent_total';
    message: string;
  }[];
}
export type DailyCountEvidence = Pick<
  MetricCard,
  'unit' | 'aggregation' | 'value' | 'coverage' | 'points'
>;

/**
 * Shared strict gate for a complete daily count series. Callers supply the
 * requested, ordered ISO calendar dates (normally from time.days). A confirmed
 * zero is valid; absent, sampled, overlapping or inconsistent data is not.
 * Does not mutate observations, align timezones or infer provider equivalence.
 */
export function evaluateDailyCountEvidence(
  card: DailyCountEvidence,
  requestedDates: readonly string[],
  expectedUnit: string = card.unit,
): DailyCountDecision {
  const issues: DailyCountDecision['issues'] = [];
  const add = (code: DailyCountDecision['issues'][number]['code'], message: string) =>
    issues.push({ code, message });
  const validPeriod =
    requestedDates.length > 0 &&
    requestedDates.every((date, i) => {
      try {
        return day(date) === date && (i === 0 || addDays(requestedDates[i - 1]!, 1) === date);
      } catch {
        return false;
      }
    });
  if (!validPeriod)
    add(
      'invalid_period',
      'The requested period must contain consecutive, ordered ISO calendar dates.',
    );
  if (card.unit !== expectedUnit)
    add('unsupported_unit', 'The series has a different measurement unit.');
  if (card.aggregation !== 'sum')
    add('non_additive', 'The metric does not permit addition across daily buckets.');
  if (card.value === null || !Number.isSafeInteger(card.value) || card.value < 0)
    add(
      'invalid_total',
      'The aggregate must be a nonnegative safe integer, including explicit zero.',
    );
  if (
    card.coverage.status !== 'complete' ||
    card.coverage.expectedDays !== requestedDates.length ||
    card.coverage.observedDays !== requestedDates.length ||
    card.coverage.missingDays.length !== 0
  )
    add('incomplete_coverage', 'The requested dates do not have complete observed coverage.');
  if (card.coverage.qualities.length !== 1 || card.coverage.qualities[0] !== 'observed')
    add('limited_quality', 'Only observed, non-sampled daily evidence supports this calculation.');
  const points = [...card.points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (
    points.length !== requestedDates.length ||
    points.some(
      (point, i) =>
        point.date !== requestedDates[i] ||
        point.from !== point.date ||
        point.to !== point.date ||
        point.quality !== 'observed' ||
        !Number.isSafeInteger(point.value) ||
        point.value < 0,
    )
  )
    add(
      'invalid_daily_buckets',
      'Exactly one observed daily count is required for each requested date.',
    );
  const total = points.reduce((sum, point) => sum + point.value, 0);
  if (!Number.isSafeInteger(total) || total !== card.value)
    add(
      'inconsistent_total',
      'The aggregate must exactly match its daily evidence without numeric overflow.',
    );
  return { eligible: issues.length === 0, issues };
}
