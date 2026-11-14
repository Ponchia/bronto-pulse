import type { Resource } from '../config.js';
import type { Collected, Observation } from '../model.js';
import { PulseError, invariant } from '../errors.js';
import { contains, day } from '../time.js';
import { array, number, object, text } from '../validation.js';
import { collected, entry, token, type CollectContext } from './context.js';
import { selfHostedJson } from '../selfhost/client.js';
import { verifyPlausibleQuery } from './provider-query-contracts.js';

type Plausible = Extract<Resource, { provider: 'plausible' }>;

/**
 * Plausible Stats API v2 is aggregate-only. We explicitly exclude imported
 * history, which can otherwise overlap another source in the same portfolio.
 * Site timezone is declared by the operator, never guessed from UTC dates.
 */
export async function collectPlausible(
  r: Plausible,
  group: string,
  ctx: CollectContext,
): Promise<Collected> {
  if (group !== 'traffic') throw new PulseError('CONFIG', 'Unknown Plausible collection group.');
  // Plausible's query endpoint caps a single page at 10,000 rows. Use
  // one extra row as a truncation sentinel whenever our own budget permits.
  const pageLimit = Math.min(ctx.config.settings.maxRows + 1, 10000);
  const connection = ctx.config.connections.find((c) => c.id === r.connection);
  // A self-hosted Community Edition instance never goes through the generic
  // client: its destination is pinned by the Node/OCI transport (ADR 0004)
  // and the query below is rebuilt there from these four values only.
  const selfHosted = Boolean(r.instance || connection?.selfHosted);
  const response = object(
    selfHosted
      ? await selfHostedJson(ctx, connection, {
          variant: 'plausible-ce',
          siteId: r.siteId,
          from: ctx.window.from,
          to: ctx.window.to,
          limit: pageLimit,
        })
      : await ctx.http.json('https://plausible.io/api/v2/query', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await token(r, ctx)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            site_id: r.siteId,
            metrics: ['pageviews', 'visitors'],
            date_range: [ctx.window.from, ctx.window.to],
            dimensions: ['time:day'],
            include: { imports: false },
            // Ask for one more row than our budget, then fail rather than silently
            // publishing a truncated day series.
            pagination: { limit: pageLimit, offset: 0 },
          }),
        }),
  );
  const origin = selfHosted
    ? `Self-hosted Plausible Community Edition instance ${r.instance}; synthetic-tested transport, not yet verified against a real installation.`
    : undefined;
  const meta = response.meta === undefined ? {} : object(response.meta);
  if (meta.imports_included === true)
    throw new PulseError('SCHEMA', 'Plausible unexpectedly included imported analytics history.');
  const data = array(response.results, 'Plausible query results');
  if (data.length >= pageLimit || data.length > ctx.config.settings.maxRows)
    throw new PulseError(
      'ROW_LIMIT',
      'Plausible date series may be truncated; narrow the date window.',
    );
  verifyPlausibleQuery(response, r.siteId, r.timezone, ctx.window, data.length, pageLimit);
  const observations: Observation[] = [];
  const dates = new Set<string>();
  for (const item of data) {
    const row = object(item);
    const dimensions = array(row.dimensions, 'Plausible dimensions');
    const metrics = array(row.metrics, 'Plausible metrics');
    invariant(dimensions.length === 1 && metrics.length === 2, 'Plausible query shape changed.');
    const date = day(text(dimensions[0], 'Plausible day', 10));
    invariant(
      contains(ctx.window, date) && !dates.has(date),
      'Plausible returned duplicate or out-of-window dates.',
    );
    dates.add(date);
    for (const [i, metric] of ['plausible.pageviews', 'plausible.visitors_daily'].entries()) {
      const count = number(metrics[i], metric);
      invariant(Number.isSafeInteger(count) && count >= 0, 'Plausible returned an invalid count.');
      observations.push({
        ...entry(metric, date, count, {}, 'observed', 'plausible-v2-native-daily-v1'),
        timezone: r.timezone,
      });
    }
  }
  return collected(ctx.window, observations, [
    'Plausible native statistics only. Imports are explicitly excluded to avoid ambiguous duplicate counts.',
    'Daily visitors are provider-defined uniques and cannot be summed across days or sources.',
    `Site timezone is declared as ${r.timezone}; ensure it matches the Plausible site settings.`,
    'No absent date is inferred as zero; additional sources for the same site remain separate.',
    ...(origin ? [origin] : []),
  ]);
}
