import type { Resource } from '../config.js';
import { PulseError, invariant } from '../errors.js';
import { contains, day } from '../time.js';
import { array, number, object, text } from '../validation.js';
import { collected, entry, token, type CollectContext } from './context.js';
export const SENSE6_QUERY =
  'SELECT day,test,metric,count FROM daily_metrics WHERE day >= ? AND day <= ? ORDER BY day,test,metric LIMIT ?';
/** Fixed aggregate-only query. This connector is not a general-purpose D1 SQL proxy. */
export async function collectSense6(
  r: Extract<Resource, { provider: 'sense6' }>,
  ctx: CollectContext,
) {
  const data = object(
    await ctx.http.json(
      `https://api.cloudflare.com/client/v4/accounts/${r.accountId}/d1/database/${r.databaseId}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await token(r, ctx)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sql: SENSE6_QUERY,
          params: [ctx.window.from, ctx.window.to, ctx.config.settings.maxRows + 1],
        }),
      },
    ),
  );
  invariant(data.success === true, 'Cloudflare denied the aggregate D1 query.');
  const result = array(data.result, 'D1 result sets');
  invariant(result.length === 1, 'Unexpected D1 result set count.');
  const resultSet = object(result[0]);
  invariant(resultSet.success !== false, 'D1 query failed.');
  const rows = array(resultSet.results, 'D1 aggregate rows');
  if (rows.length > ctx.config.settings.maxRows)
    throw new PulseError('ROW_LIMIT', 'Sense6 aggregate query exceeded its row budget.');
  const metrics = [
    'site_loaded',
    'test_viewed',
    'test_started',
    'test_completed',
    'report_downloaded',
  ];
  const tests = ['site', 'tetracromia', 'riflessi', 'udito', 'acutezza', 'daltonia'];
  const values = rows.map((raw) => {
    const row = object(raw);
    invariant(
      Object.keys(row).sort().join(',') === 'count,day,metric,test',
      'D1 returned fields outside the aggregate contract.',
    );
    const date = day(text(row.day));
    invariant(contains(ctx.window, date), 'D1 date outside requested window.');
    const metric = text(row.metric),
      test = text(row.test);
    invariant(
      metrics.includes(metric) && tests.includes(test),
      'D1 returned a non-allowlisted metric or test.',
    );
    return entry(
      `sense6.${metric}`,
      date,
      number(row.count, 'activity count', true),
      { test },
      'observed',
      'sense6-daily-aggregate-v1',
    );
  });
  return collected(ctx.window, values, [
    'Only four aggregate columns are queried; no participant data, scores, journals or individual events are retrieved.',
  ]);
}
