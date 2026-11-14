import type { Resource } from '../config.js';
import type { Collected, Observation } from '../model.js';
import { PulseError, invariant } from '../errors.js';
import { addDays, contains, day } from '../time.js';
import { array, number, object, text } from '../validation.js';
import { collected, entry, token, type CollectContext } from './context.js';
import { selfHostedJson } from '../selfhost/client.js';

type Umami = Extract<Resource, { provider: 'umami' }>;

/**
 * Umami Cloud uses its fixed origin and /v1 prefix. A self-hosted instance
 * uses the pinned Node/OCI transport and the /api prefix (ADR 0004).
 */
export async function collectUmami(
  r: Umami,
  group: string,
  ctx: CollectContext,
): Promise<Collected> {
  if (group !== 'traffic') throw new PulseError('CONFIG', 'Unknown Umami collection group.');
  const start = Date.parse(`${ctx.window.from}T00:00:00.000Z`),
    end = Date.parse(`${addDays(ctx.window.to, 1)}T00:00:00.000Z`) - 1;
  const params = new URLSearchParams({
    startAt: String(start),
    endAt: String(end),
    timezone: 'UTC',
    unit: 'day',
  });
  const connection = ctx.config.connections.find((c) => c.id === r.connection);
  const selfHosted = Boolean(r.instance || connection?.selfHosted);
  const response = object(
    selfHosted
      ? await selfHostedJson(ctx, connection, {
          variant: 'umami-selfhosted',
          websiteId: r.websiteId,
          startAt: start,
          endAt: end,
        })
      : await ctx.http.json(`https://api.umami.is/v1/websites/${r.websiteId}/pageviews?${params}`, {
          headers: { Authorization: `Bearer ${await token(r, ctx)}` },
        }),
  );
  const observations: Observation[] = [];
  for (const [field, metric] of [
    ['pageviews', 'umami.pageviews'],
    ['sessions', 'umami.sessions_daily'],
  ] as const) {
    const values = array(response[field], `Umami ${field}`);
    if (values.length > ctx.config.settings.maxRows)
      throw new PulseError('ROW_LIMIT', 'Umami date series exceeds the bounded row budget.');
    const dates = new Set<string>();
    for (const value of values) {
      const point = object(value);
      const x = text(point.x, 'Umami date', 64);
      // Umami can return day buckets as 'YYYY-MM-DD 00:00:00',
      // 'YYYY-MM-DDT00:00:00Z' or a date-only label. Do not use
      // Date.parse on timezone-less timestamps (that uses the host locale).
      invariant(
        /^\d{4}-\d{2}-\d{2}(?:(?:[ T]00:00:00(?:\.0+)?)(?:Z|\+00:00)?)?$/.test(x),
        'Umami returned an invalid daily bucket.',
      );
      const date = day(x.slice(0, 10));
      invariant(
        contains(ctx.window, date) && !dates.has(date),
        'Umami returned duplicate or out-of-window dates.',
      );
      dates.add(date);
      const count = number(point.y, `Umami ${field}`);
      invariant(Number.isSafeInteger(count) && count >= 0, 'Umami returned an invalid count.');
      observations.push(
        entry(
          metric,
          date,
          count,
          {},
          'observed',
          // The instance version is not observable through this endpoint.
          selfHosted ? 'umami-selfhosted-utc-daily-v1' : 'umami-v3-utc-daily-v1',
        ),
      );
    }
  }
  return collected(ctx.window, observations, [
    selfHosted
      ? `Self-hosted Umami instance ${r.instance}, time series grouped by UTC calendar day. No inferred zeroes. Synthetic-tested transport, not yet verified against a real installation.`
      : 'Umami v3 Cloud time series grouped by UTC calendar day. No inferred zeroes.',
    'Sessions are recorded as daily source-defined values, not summed into distinct people.',
    'Other web analytics providers observing the same site remain independent datasets.',
  ]);
}
