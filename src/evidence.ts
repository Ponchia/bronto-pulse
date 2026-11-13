import type { MetricCard, ProjectReport } from './report.js';
import { days } from './time.js';

export type EvidenceClass =
  | 'distribution'
  | 'discovery'
  | 'activity'
  | 'interest'
  | 'maintenance'
  | 'performance'
  | 'unclassified';

/** Describes the measurement, never the identity or intent of its source. */
export function metricEvidenceClass(metric: string): EvidenceClass {
  if (
    [
      'npm.downloads',
      'github.clones',
      'github.unique_cloners',
      'github.release_downloads',
    ].includes(metric)
  )
    return 'distribution';
  if (['github.stars', 'github.forks'].includes(metric)) return 'interest';
  if (metric === 'github.open_issues') return 'maintenance';
  if (metric.startsWith('sense6.')) return 'activity';
  if (metric.startsWith('cloudflare.') && metric.endsWith('_p75')) return 'performance';
  if (
    metric.startsWith('gsc.') ||
    [
      'github.views',
      'github.unique_viewers',
      'github.referral_views',
      'github.path_views',
      'cloudflare.pageviews',
      'cloudflare.visits',
    ].includes(metric)
  )
    return 'discovery';
  return 'unclassified';
}

export interface EvidenceSignal {
  code:
    | 'concentrated_activity'
    | 'concentrated_referrers'
    | 'concentrated_site_referrers'
    | 'unattributed_referrer';
  resourceId: string;
  metric: string;
  message: string;
  evidence: Record<string, string | number | null>;
}
export interface EvidenceAssessment {
  humanAudience: 'not_measured';
  independentAdoption: 'not_measured';
  automatedShare: 'not_measured';
  limitation: string;
  signals: EvidenceSignal[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function concentration(
  card: MetricCard,
  window: ProjectReport['window'],
  dates: string[],
): EvidenceSignal | null {
  // An explicit review heuristic, not a bot detector or an adjusted count.
  // Require the whole requested period and one observed daily bucket per date.
  if (
    dates.length < 28 ||
    card.aggregation !== 'sum' ||
    card.coverage.status !== 'complete' ||
    card.coverage.expectedDays !== dates.length ||
    card.points.length !== dates.length ||
    card.coverage.qualities.some((q) => q !== 'observed')
  )
    return null;
  const points = [...card.points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (
    points.some(
      (p, i) =>
        p.date !== dates[i] ||
        p.from !== p.date ||
        p.to !== p.date ||
        p.quality !== 'observed' ||
        !Number.isFinite(p.value) ||
        p.value < 0,
    )
  )
    return null;
  const total = points.reduce((sum, p) => sum + p.value, 0);
  if (!Number.isFinite(total) || total < 100) return null;
  let peak = 0,
    start = 0,
    running = 0;
  for (let i = 0; i < points.length; i++) {
    running += points[i]!.value;
    if (i >= 7) running -= points[i - 7]!.value;
    if (i >= 6 && running > peak) {
      peak = running;
      start = i - 6;
    }
  }
  if (peak / total < 0.5) return null;
  const from = points[start]!.date,
    to = points[start + 6]!.date;
  return {
    code: 'concentrated_activity',
    resourceId: card.resourceId,
    metric: card.metric,
    message: `${card.resourceId}: ${peak} of ${total} ${card.unit} fall in ${from} to ${to}. This concentration needs review before describing sustained growth; its cause and human share are unknown. Raw counts are unchanged.`,
    evidence: {
      periodTotal: total,
      peakSevenDayTotal: peak,
      peakShare: peak / total,
      peakFrom: from,
      peakTo: to,
      requestedFrom: window.from,
      requestedTo: window.to,
      timezone: card.timezone,
      methodology: card.methodology,
      dimensions: JSON.stringify(card.dimensions),
      scope: JSON.stringify(card.scope),
      minimumTotal: 100,
      shareThreshold: 0.5,
    },
  };
}

/** Pure interpretation of published data. No filtering, identity inference or cross-source funnel. */
export function assessEvidence(
  report: Pick<ProjectReport, 'cards' | 'breakdowns' | 'window'>,
): EvidenceAssessment {
  const signals: EvidenceSignal[] = [];
  const dates = days(report.window);
  for (const card of report.cards) {
    const signal = concentration(card, report.window, dates);
    if (signal) signals.push(signal);
  }
  const resources = [...new Set(report.breakdowns.map((b) => b.resourceId))].sort();
  for (const resourceId of resources) {
    const rows = report.breakdowns.filter(
      (b) =>
        b.resourceId === resourceId &&
        b.group === 'referrers' &&
        b.period.to >= report.window.from &&
        b.period.to <= report.window.to,
    );
    // RUM referrer rows are daily pageviews, not independent visits. Only
    // compare the referrers *returned* in this bounded report; a missing
    // date, absent referrer or sampled row cannot identify a human or a bot.
    const website = rows.filter((b) => b.metric === 'cloudflare.pageviews');
    const validWebsite =
      website.length > 0 &&
      website.every(
        (b) =>
          b.quality === 'observed' &&
          b.period.from === b.period.to &&
          typeof b.dimensions.referrer === 'string' &&
          Number.isFinite(b.value) &&
          b.value >= 0,
      ) &&
      new Set(website.map((b) => JSON.stringify([b.period.from, b.dimensions.referrer]))).size ===
        website.length;
    const reportedTotal = validWebsite ? website.reduce((sum, b) => sum + b.value, 0) : null;
    const listedTotal =
      reportedTotal !== null && Number.isFinite(reportedTotal) ? reportedTotal : null;
    const missingReferrer = website.some((b) => b.dimensions.referrer === '' && b.value > 0);
    if (missingReferrer) {
      const missingCount =
        listedTotal !== null
          ? website.filter((b) => b.dimensions.referrer === '').reduce((sum, b) => sum + b.value, 0)
          : null;
      signals.push({
        code: 'unattributed_referrer',
        resourceId,
        metric: 'cloudflare.pageviews',
        message:
          missingCount === null
            ? `${resourceId}: some reported pageviews have no referrer. Sampled, duplicate or invalid breakdown rows prevent a reliable subtotal; absent attribution is not proof of direct human visits.`
            : `${resourceId}: ${missingCount} of ${listedTotal} returned referrer-row pageviews have no referrer. This is a share of the returned rows, not all site traffic or a count of direct human visits.`,
        evidence: {
          requestedFrom: report.window.from,
          requestedTo: report.window.to,
          unattributedPageviews: missingCount,
          listedPageviews: listedTotal,
          listedShare:
            listedTotal !== null && listedTotal > 0 && missingCount !== null
              ? missingCount / listedTotal
              : null,
          scope: 'returned_daily_referrer_rows_only',
        },
      });
    }
    if (listedTotal !== null && listedTotal >= 10) {
      const named = website.filter((b) => b.dimensions.referrer !== '');
      const totals = new Map<string, number>();
      for (const b of named) {
        const referrer = b.dimensions.referrer!;
        totals.set(referrer, (totals.get(referrer) ?? 0) + b.value);
      }
      const largest = [...totals].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0];
      if (largest && largest[1] >= 10 && largest[1] / listedTotal >= 0.8)
        signals.push({
          code: 'concentrated_site_referrers',
          resourceId,
          metric: 'cloudflare.pageviews',
          message: `${resourceId}: ${largest[1]} of ${listedTotal} pageviews in the returned RUM referrer rows name one referrer. This is a limited attribution signal, not proof of genuine referrals or automation; underlying site totals are unchanged.`,
          evidence: {
            referrer: largest[0],
            referrerPageviews: largest[1],
            listedPageviews: listedTotal,
            listedShare: largest[1] / listedTotal,
            requestedFrom: report.window.from,
            requestedTo: report.window.to,
            scope: 'returned_daily_referrer_rows_only',
            minimumListedPageviews: 10,
            minimumNamedPageviews: 10,
            shareThreshold: 0.8,
          },
        });
    }
    // GitHub supplies overlapping rolling top-ten snapshots. Never add snapshots,
    // or divide this subtotal by daily repository traffic from a different period.
    const rolling = rows.filter((b) => b.metric === 'github.referral_views');
    const newest = [...rolling].sort(
      (a, b) => compareText(b.period.to, a.period.to) || compareText(b.period.from, a.period.from),
    )[0];
    if (!newest) continue;
    const latest = rolling.filter(
      (b) => b.period.from === newest.period.from && b.period.to === newest.period.to,
    );
    if (
      latest.some(
        (b) =>
          b.quality !== 'top_n' ||
          !Number.isFinite(b.value) ||
          b.value < 0 ||
          typeof b.dimensions.referrer !== 'string',
      ) ||
      new Set(latest.map((b) => b.dimensions.referrer)).size !== latest.length
    )
      continue;
    const listed = latest.reduce((sum, b) => sum + b.value, 0);
    const largest = [...latest].sort(
      (a, b) => b.value - a.value || compareText(a.dimensions.referrer!, b.dimensions.referrer!),
    )[0]!;
    if (!Number.isFinite(listed) || listed < 10 || largest.value / listed < 0.8) continue;
    signals.push({
      code: 'concentrated_referrers',
      resourceId,
      metric: 'github.referral_views',
      message: `${resourceId}: one referrer accounts for ${largest.value} of ${listed} views in the latest returned top-referrer snapshot. This is a share of the returned list, not all repository traffic. A referrer alone does not verify human interest or automation.`,
      evidence: {
        referrer: largest.dimensions.referrer!,
        referrerViews: largest.value,
        listedViews: listed,
        listedShare: largest.value / listed,
        from: newest.period.from,
        to: newest.period.to,
        quality: 'top_n',
        minimumListedViews: 10,
        shareThreshold: 0.8,
      },
    });
  }
  return {
    humanAudience: 'not_measured',
    independentAdoption: 'not_measured',
    automatedShare: 'not_measured',
    limitation:
      'Distribution, discovery, activity and interest are separate measurements. These aggregates do not establish independent adopters, unique people, a human/bot split or person-level conversions. Review public consumer evidence separately; no counts are removed or corrected by these signals.',
    signals,
  };
}
