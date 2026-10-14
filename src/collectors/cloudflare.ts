import type { Resource } from '../config.js';
import type { Collected, Observation } from '../model.js';
import { PulseError, invariant } from '../errors.js';
import { addDays, contains, day } from '../time.js';
import { array, number, object, safePath, text, coalesceCounts } from '../validation.js';
import { collected, entry, token, type CollectContext } from './context.js';
type Cloudflare = Extract<Resource, { provider: 'cloudflare' }>;
export async function cloudflareGraphQL(
  r: Cloudflare,
  ctx: CollectContext,
  selection: string,
): Promise<Record<string, unknown>> {
  const query = `query { viewer { accounts(filter: {accountTag: ${JSON.stringify(r.accountId)}}) { ${selection} } } }`;
  const data = object(
    await ctx.http.json('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await token(r, ctx)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    }),
  );
  if (Array.isArray(data.errors) && data.errors.length)
    throw new PulseError(
      'PERMISSION',
      'Cloudflare GraphQL rejected the dataset or fields. Run probe, verify RUM permissions and siteTag (not the public beacon token).',
    );
  const viewer = object(object(data.data, 'GraphQL data').viewer, 'GraphQL viewer');
  const accounts = array(viewer.accounts, 'Cloudflare accounts');
  invariant(
    accounts.length === 1,
    'Cloudflare account filter returned no unique authorized account.',
  );
  return object(accounts[0]);
}
export async function collectCloudflare(
  r: Cloudflare,
  group: string,
  ctx: CollectContext,
): Promise<Collected> {
  const filter = `{datetime_geq:${JSON.stringify(ctx.window.from + 'T00:00:00Z')},datetime_lt:${JSON.stringify(addDays(ctx.window.to, 1) + 'T00:00:00Z')},siteTag:${JSON.stringify(r.siteTag)}${r.hostname ? `,requestHost:${JSON.stringify(r.hostname)}` : ''}}`;
  const limit = Math.min(ctx.config.settings.maxRows, 10000),
    notes = [
      'Uses the account RUM siteTag, never the publicly embedded beacon token.',
      'Provider counts are kept as reported; sampling is flagged and counts are never multiplied by an assumed factor.',
    ];
  if (['totals', 'pages', 'referrers'].includes(group)) {
    const dims =
      group === 'pages'
        ? 'date requestHost requestPath'
        : group === 'referrers'
          ? 'date refererHost'
          : 'date';
    const dataset = 'rumPageloadEventsAdaptiveGroups';
    const data = await cloudflareGraphQL(
      r,
      ctx,
      `${dataset}(filter:${filter},limit:${limit},orderBy:[date_ASC]){count sum{visits} avg{sampleInterval} dimensions{${dims}}}`,
    );
    const raw = array(data[dataset], 'Cloudflare RUM groups');
    if (raw.length >= limit)
      throw new PulseError(
        'ROW_LIMIT',
        'Cloudflare group limit reached; narrow the date window before publishing. The response may be truncated.',
      );
    const rows: Observation[] = [];
    for (const value of raw) {
      const row = object(value),
        d = object(row.dimensions),
        date = day(text(d.date, 'RUM date'));
      invariant(contains(ctx.window, date), 'Cloudflare returned an out-of-range date.');
      const sample = number(object(row.avg).sampleInterval, 'sample interval');
      invariant(sample >= 1, 'Cloudflare returned an invalid sampling interval.');
      const quality = sample > 1 ? 'sampled' : 'observed';
      const dimensions: Record<string, string> = {};
      if (group === 'pages') {
        dimensions.hostname = text(d.requestHost, 'hostname', 253);
        dimensions.path = safePath(d.requestPath);
      }
      if (group === 'referrers') dimensions.referrer = text(d.refererHost, 'referrer host', 253);
      rows.push(
        entry(
          'cloudflare.pageviews',
          date,
          number(row.count, 'RUM pageviews'),
          dimensions,
          quality,
          'cf-rum-pageload-count-v1',
        ),
      );
      // Paths cannot reconstruct per-project entrances; keep visits only at property scope.
      if (group === 'totals')
        rows.push(
          entry(
            'cloudflare.visits',
            date,
            number(object(row.sum).visits, 'RUM visits'),
            {},
            quality,
            'cf-rum-visits-v1',
          ),
        );
      if (
        sample > 1 &&
        !notes.includes('Sampling was applied by Cloudflare to at least one returned group.')
      )
        notes.push('Sampling was applied by Cloudflare to at least one returned group.');
    }
    if (group === 'pages')
      notes.push(
        'Path attribution includes pageviews only. Host-level visits are not independent per-project sessions.',
      );
    return collected(ctx.window, coalesceCounts(rows), notes);
  }
  if (group === 'performance' || group === 'vitals') {
    const dataset =
      group === 'performance'
        ? 'rumPerformanceEventsAdaptiveGroups'
        : 'rumWebVitalsEventsAdaptiveGroups';
    const fields =
      group === 'performance'
        ? ['pageLoadTimeP75']
        : ['largestContentfulPaintP75', 'interactionToNextPaintP75', 'cumulativeLayoutShiftP75'];
    const data = await cloudflareGraphQL(
      r,
      ctx,
      `${dataset}(filter:${filter},limit:${limit},orderBy:[date_ASC]){count dimensions{date} quantiles{${fields.join(' ')}}}`,
    );
    const raw = array(data[dataset], 'Cloudflare performance groups');
    if (raw.length >= limit)
      throw new PulseError('ROW_LIMIT', 'Performance query hit the group limit.');
    const rows: Observation[] = [];
    const mappings: Record<string, string> = {
      pageLoadTimeP75: 'cloudflare.load_p75',
      largestContentfulPaintP75: 'cloudflare.lcp_p75',
      interactionToNextPaintP75: 'cloudflare.inp_p75',
      cumulativeLayoutShiftP75: 'cloudflare.cls_p75',
    };
    for (const value of raw) {
      const row = object(value),
        date = day(text(object(row.dimensions).date));
      invariant(contains(ctx.window, date), 'Performance date out of bounds.');
      const count = number(row.count, 'performance sample count');
      const q = object(row.quantiles);
      for (const field of fields) {
        const v = q[field];
        if (count === 0 || v === null || (typeof v === 'number' && v < 0)) continue;
        const n = number(v, field),
          scale =
            field === 'cumulativeLayoutShiftP75' ? 1 : r.durationUnit === 'microseconds' ? 1000 : 1;
        rows.push(
          entry(
            mappings[field]!,
            date,
            n / scale,
            {},
            'sampled',
            `cf-${field}-${r.durationUnit}-v1`,
          ),
        );
      }
    }
    return collected(ctx.window, rows, [
      'Field availability must be probed on the actual account. An unsupported field fails this group, not other collection groups.',
      'Missing/negative sentinel samples are unavailable, not zero. Daily p75 is never averaged.',
    ]);
  }
  throw new PulseError('CONFIG', 'Unknown Cloudflare collection group.');
}
export async function probeCloudflare(r: Cloudflare, ctx: CollectContext): Promise<unknown> {
  // Account-specific capability discovery; schema presence is not authorization.
  return cloudflareGraphQL(
    r,
    ctx,
    'settings { rumPageloadEventsAdaptiveGroups { enabled maxDuration maxPageSize notOlderThan } }',
  );
}
