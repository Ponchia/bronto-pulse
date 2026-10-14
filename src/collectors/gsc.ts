import type { Resource } from '../config.js';
import type { Observation } from '../model.js';
import { PulseError, invariant } from '../errors.js';
import { contains, day } from '../time.js';
import { array, number, object, text, safeUrl } from '../validation.js';
import { canonicalDimensions } from '../model.js';
import { collected, entry, token, type CollectContext } from './context.js';
export async function collectGsc(
  r: Extract<Resource, { provider: 'gsc' }>,
  group: string,
  ctx: CollectContext,
) {
  if (!['totals', 'pages', 'queries'].includes(group) || (group === 'queries' && !r.collectQueries))
    throw new PulseError('CONFIG', 'Search query collection was not explicitly enabled.');
  const dimensions = group === 'totals' ? ['date'] : ['date', group === 'pages' ? 'page' : 'query'];
  const expectedAggregation =
    group === 'totals' && !['discover', 'googleNews'].includes(r.searchType)
      ? 'byProperty'
      : 'byPage';
  const tokenValue = await token(r, ctx);
  const max = ctx.config.settings.maxRows;
  const pageSize = Math.min(25000, max + 1);
  const records: {
    date: string;
    dimensions: Record<string, string>;
    clicks: number;
    impressions: number;
    position: number;
    quality: Observation['quality'];
  }[] = [];
  let startRow = 0;
  let incomplete: string | undefined;
  while (true) {
    const result = object(
      await ctx.http.json(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(r.siteUrl)}/searchAnalytics/query`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenValue}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startDate: ctx.window.from,
            endDate: ctx.window.to,
            dimensions,
            type: r.searchType,
            aggregationType: expectedAggregation,
            dataState: 'all',
            rowLimit: pageSize,
            startRow,
          }),
        },
      ),
    );
    invariant(
      result.responseAggregationType === expectedAggregation,
      'Search Console returned a different aggregation scope.',
    );
    if (result.metadata) {
      const meta = object(result.metadata);
      if (meta.first_incomplete_date) incomplete = day(text(meta.first_incomplete_date));
    }
    // The API omits rows entirely for an empty result. A declared empty result is not a zero observation.
    const values = result.rows === undefined ? [] : array(result.rows, 'search rows');
    if (records.length + values.length > max)
      throw new PulseError(
        'ROW_LIMIT',
        'Search Console row budget reached. Narrow the date window; earlier history remains untouched.',
      );
    for (const raw of values) {
      const value = object(raw);
      const keys = array(value.keys, 'search dimension keys');
      invariant(
        keys.length === dimensions.length,
        'Search Console returned unexpected dimensions.',
      );
      const date = day(text(keys[0], 'search date'));
      invariant(contains(ctx.window, date), 'Search Console date outside requested window.');
      const dims: Record<string, string> = {
        searchType: r.searchType,
        aggregation: expectedAggregation,
      };
      if (group === 'pages') {
        const page = safeUrl(keys[1]);
        const url = new URL(page);
        dims.hostname = url.hostname;
        dims.path = url.pathname;
      }
      if (group === 'queries') dims.query = text(keys[1], 'search query', 500);
      const quality: Observation['quality'] =
        incomplete && date >= incomplete
          ? 'provisional'
          : group === 'totals'
            ? 'observed'
            : 'provider_limited';
      records.push({
        date,
        dimensions: dims,
        clicks: number(value.clicks, 'search clicks'),
        impressions: number(value.impressions, 'search impressions'),
        position: number(value.position, 'search position'),
        quality,
      });
    }
    if (values.length < pageSize) break;
    startRow += values.length;
  }
  // Privacy URL sanitization can collapse canonical query variants. Recalculate ratios/means correctly.
  const merged = new Map<string, (typeof records)[number] & { positionWeight: number }>();
  for (const item of records) {
    const key = item.date + canonicalDimensions(item.dimensions);
    const old = merged.get(key);
    if (old) {
      old.clicks += item.clicks;
      old.impressions += item.impressions;
      old.positionWeight += item.position * item.impressions;
      if (item.quality !== 'observed') old.quality = item.quality;
    } else merged.set(key, { ...item, positionWeight: item.position * item.impressions });
  }
  const observations: Observation[] = [];
  for (const item of merged.values()) {
    const base = (metric: string, value: number) => ({
      ...entry(
        metric,
        item.date,
        value,
        item.dimensions,
        item.quality,
        `gsc-${expectedAggregation}-${r.searchType}-v1`,
      ),
      timezone: 'America/Los_Angeles',
    });
    observations.push(base('gsc.clicks', item.clicks), base('gsc.impressions', item.impressions));
    if (item.impressions > 0) {
      observations.push(
        {
          ...base('gsc.ctr', item.clicks / item.impressions),
          numerator: item.clicks,
          denominator: item.impressions,
        },
        {
          ...base('gsc.position', item.positionWeight / item.impressions),
          numerator: item.positionWeight,
          denominator: item.impressions,
        },
      );
    }
  }
  return collected(
    ctx.window,
    observations,
    [
      'Source dates use America/Los_Angeles, not UTC. Recent incomplete dates are marked provisional.',
      group === 'totals'
        ? 'Unfiltered source totals are separate from page and query breakdowns.'
        : 'The Search Console API returns top rows, not a complete population. Pagination cannot recover anonymized or internally omitted rows.',
      'Page URL query strings and fragments are removed. Query text is disabled unless explicitly opted in.',
    ],
    group === 'totals' ? 'complete' : 'provider_limited',
  );
}
