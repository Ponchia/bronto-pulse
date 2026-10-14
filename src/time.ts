import { PulseError } from './errors.js';
export type DateRange = { from: string; to: string };
export function day(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value
  ) {
    throw new PulseError('CONFIG', 'Expected a valid calendar date in YYYY-MM-DD format.');
  }
  return value;
}
export function addDays(value: string, n: number): string {
  const d = new Date(day(value) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(day(to)) - Date.parse(day(from))) / 86400000) + 1;
}
export function range(from: string, to: string, maximum = 366): DateRange {
  if (daysBetween(from, to) < 1 || daysBetween(from, to) > maximum)
    throw new PulseError('CONFIG', `Date range must contain between 1 and ${maximum} days.`);
  return { from, to };
}
export function days(window: DateRange): string[] {
  range(window.from, window.to, 3660);
  return Array.from({ length: daysBetween(window.from, window.to) }, (_, i) =>
    addDays(window.from, i),
  );
}
export function dateInZone(now: Date, zone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (key: string) => parts.find((p) => p.type === key)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function previous(window: DateRange): DateRange {
  return {
    from: addDays(window.from, -daysBetween(window.from, window.to)),
    to: addDays(window.from, -1),
  };
}
export function defaultRange(now: Date, lookback = 14, zone = 'UTC'): DateRange {
  const to = addDays(dateInZone(now, zone), -1);
  return range(addDays(to, -lookback + 1), to);
}
export function contains(window: DateRange, value: string): boolean {
  return value >= window.from && value <= window.to;
}

/** Shared report default across CLI, API and UI: last completed UTC dates. */
export function reportRange(
  options: { from?: string; to?: string; days?: number } = {},
  now = new Date(),
): DateRange {
  const count = options.days ?? 30;
  if (!Number.isSafeInteger(count) || count < 1 || count > 366)
    throw new PulseError('CONFIG', 'Report days must be between 1 and 366.');
  const to = options.to ?? addDays(dateInZone(now), -1);
  return range(options.from ?? addDays(to, -count + 1), to);
}
