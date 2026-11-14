import { invariant, PulseError } from '../errors.js';
import { dateInZone, day, type DateRange } from '../time.js';
import { array, object } from '../validation.js';

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, i) => item === expected[i])
  );
}

/** Validate a boundary after provider normalization, without assuming 24-hour local days. */
function boundary(value: unknown, expected: string, timezone: string, end: boolean): boolean {
  if (value === expected) return true; // Date-only echo: timezone remains operator-declared.
  if (typeof value !== 'string' || value.length > 40) return false;
  const parts =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59)
    return false;
  try {
    day(parts[1]!);
  } catch {
    return false;
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return false;
  // Both local-offset and UTC-normalized timestamps may describe the same day.
  // Crossing the adjacent second must cross the calendar boundary. This works
  // for DST changes, including a day whose first local hour is not midnight.
  return (
    dateInZone(new Date(instant), timezone) === expected &&
    dateInZone(new Date(instant + (end ? 1000 : -1000)), timezone) !== expected
  );
}

/**
 * The Stats v2 response echoes the executed query. Never treat a contradictory
 * echo as the requested measurement. Missing echoes retain legacy compatibility;
 * they do not independently verify site identity or the declared timezone.
 */
export function verifyPlausibleQuery(
  response: Record<string, unknown>,
  siteId: string,
  timezone: string,
  window: DateRange,
  rowCount: number,
): void {
  const meta = response.meta === undefined ? {} : object(response.meta, 'Plausible metadata');
  if (meta.imports_included !== undefined)
    invariant(meta.imports_included === false, 'Plausible imported-history metadata is invalid.');
  if (meta.total_rows !== undefined) {
    invariant(
      Number.isSafeInteger(meta.total_rows) && Number(meta.total_rows) >= 0,
      'Plausible returned an invalid total row count.',
    );
    if (Number(meta.total_rows) > rowCount)
      throw new PulseError(
        'ROW_LIMIT',
        'Plausible reports an incomplete result; narrow the date window.',
      );
    invariant(meta.total_rows === rowCount, 'Plausible result count contradicts its metadata.');
  }
  if (response.query === undefined) return;
  const query = object(response.query, 'Plausible executed query');
  invariant(query.site_id === siteId, 'Plausible executed query names a different site.');
  invariant(
    exactStrings(query.metrics, ['pageviews', 'visitors']),
    'Plausible executed metric order differs from the requested metrics.',
  );
  invariant(
    exactStrings(query.dimensions, ['time:day']),
    'Plausible executed dimensions differ from daily traffic.',
  );
  invariant(
    query.filters === undefined || exactStrings(query.filters, []),
    'Plausible executed query unexpectedly restricts the requested scope.',
  );
  if (query.include !== undefined) {
    const include = object(query.include, 'Plausible executed include options');
    invariant(
      include.imports === undefined || include.imports === false,
      'Plausible executed query includes unexpected imported history.',
    );
  }
  const dates = array(query.date_range, 'Plausible executed date range');
  invariant(
    dates.length === 2 &&
      boundary(dates[0], window.from, timezone, false) &&
      boundary(dates[1], window.to, timezone, true),
    'Plausible executed dates do not match complete days in the configured timezone.',
  );
  // The only accepted pagination offset is the first page. The caller rejects
  // a full sentinel page before publication, so no later page is silently used.
  if (query.pagination !== undefined) {
    const pagination = object(query.pagination, 'Plausible executed pagination');
    invariant(
      pagination.offset === undefined || pagination.offset === 0,
      'Plausible executed query starts after the first result.',
    );
  }
  // Do not return or retain any query text, hostnames, filters or metadata.
}
