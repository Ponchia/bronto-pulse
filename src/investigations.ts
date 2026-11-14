import { PulseError } from './errors.js';
import type { EvidenceSignal } from './evidence.js';
import { evaluateDailyCountEvidence } from './evidence-compatibility.js';
import type { GraphIdentity, ProjectGraph, ResourceKind } from './project-graph.js';
import type { MetricCard, ProjectReport } from './report.js';
import { days, previous, type DateRange } from './time.js';

/**
 * Investigation leads: what a published report supports, what it cannot show
 * and one bounded place to verify it. Every lead restates values already in
 * the report. Nothing is filtered, corrected, scored, forecast or attributed to
 * a cause, an audience or automation, and unavailable evidence stays unavailable.
 */

/** Stable identifiers, listed in report order. Renaming one is a breaking change. */
export const INVESTIGATION_REASONS = [
  'coverage.series_unavailable',
  'coverage.dates_missing',
  'quality.values_not_final',
  'website.preferred_source_unavailable',
  'website.preference_changed_in_window',
  'website.no_preferred_source',
  'website.sources_not_comparable',
  'website.sources_differ',
  'concentration.activity_window',
  'attribution.site_referrer_rows_concentrated',
  'attribution.referrer_snapshot_concentrated',
  'attribution.referrer_missing',
  'interpretation.review_signal',
  'change.period',
  'change.small_baseline',
  'change.snapshot_net',
  'comparison.baseline_unavailable',
] as const;
export type InvestigationReason = (typeof INVESTIGATION_REASONS)[number];

type Text = (resource: string, window: DateRange | null) => string;
const span = (window: DateRange | null) =>
  window ? `${window.from} to ${window.to}` : 'the requested period';
/** The only next steps a lead may name. Each is a place to look, never a command or a link. */
const CHECKS = {
  'health.latest_refresh': [
    'pulse_health',
    (r) =>
      `Check collection health for ${r}: last successful refresh, data lag and any recorded failure code.`,
  ],
  'plan.window_coverage': [
    'pulse_plan',
    (r, w) =>
      `Review the offline collection plan for ${r} over ${span(w)} to see whether those dates are still collectable within provider retention.`,
  ],
  'config.binding_dates': [
    'configuration',
    (r, w) =>
      `Confirm that the project binding for ${r} has effective dates and a scope covering ${span(w)}.`,
  ],
  'config.website_preference': [
    'configuration',
    (_r, w) =>
      `Review the declared website sources and dated pageview preference that apply to ${span(w)}.`,
  ],
  'report.daily_points': [
    'pulse_report',
    (r, w) => `Read the daily points for ${r} over ${span(w)} in the full project report.`,
  ],
  'report.recorded_context': [
    'pulse_report',
    (r, w) =>
      `Read the annotations recorded for ${r} dated ${span(w)} as context only; a date match does not establish a cause.`,
  ],
  'report.referrer_rows': [
    'pulse_report',
    (r, w) =>
      `Read the returned referrer rows for ${r} over ${span(w)} in the full project report; they are a returned subset, not all traffic.`,
  ],
  'report.after_finalization': [
    'pulse_report',
    (r, w) =>
      `Repeat the report for ${r} over ${span(w)} after the provider finalizes those dates; compare only once every value is observed.`,
  ],
  'report.next_complete_window': [
    'pulse_report',
    (r, w) =>
      `Repeat the report for ${r} once a second complete, equal-length period follows ${span(w)}.`,
  ],
  'report.split_window': [
    'pulse_report',
    (_r, w) =>
      `Request separate reports for the dates before and after the preference change inside ${span(w)}.`,
  ],
  'provider.same_window': [
    'provider_console',
    (r, w) =>
      `Compare the same metric for ${r} in the provider's own interface over ${span(w)}, using the series timezone and scope.`,
  ],
  'provider.reporting_calendar': [
    'provider_console',
    (r) =>
      `Confirm in the provider's own settings which reporting timezone and site scope ${r} uses.`,
  ],
  'provider.counting_scope': [
    'provider_console',
    (r) =>
      `Review in the provider's own settings which pages and requests ${r} counts for this site.`,
  ],
} as const satisfies Record<string, readonly [NextCheck['surface'], Text]>;
export type NextCheckId = keyof typeof CHECKS;

export interface EvidenceRef {
  resourceId: string;
  /** Null only when the report holds no unambiguous series for that resource. */
  metric: string | null;
  /** The matching `MetricCard.key` in the full report, when exactly one exists. */
  seriesKey: string | null;
  /** The dates these facts describe, which can be narrower than the requested period. */
  window: DateRange;
  facts: Record<string, string | number | null>;
}
export interface NextCheck {
  id: NextCheckId;
  surface: 'pulse_health' | 'pulse_plan' | 'pulse_report' | 'provider_console' | 'configuration';
  resourceId: string | null;
  window: DateRange | null;
  text: string;
}
export interface InvestigationSubject {
  kind: ResourceKind;
  identity: GraphIdentity;
  sharedWithProjects: number;
  websites: string[];
}
export interface InvestigationFinding {
  /** Stable for one reason, resource and series across runs and periods. */
  id: string;
  reason: InvestigationReason;
  category:
    | 'coverage'
    | 'quality'
    | 'website'
    | 'concentration'
    | 'attribution'
    | 'interpretation'
    | 'change'
    | 'comparison';
  /** How much published evidence stands behind the lead, not how important it is. */
  evidenceState: 'unavailable' | 'partial' | 'limited' | 'observed';
  /** Empty when the lead concerns a declared website rather than one resource. */
  resourceId: string;
  summary: string;
  evidence: EvidenceRef[];
  omittedEvidence: number;
  limitations: string[];
  nextChecks: NextCheck[];
  /** Present only when a project graph was supplied and declares this resource. */
  subject?: InvestigationSubject;
}
export interface ProjectInvestigation {
  schemaVersion: 1;
  findings: InvestigationFinding[];
  omittedFindings: number;
  limitation: string;
}

export const INVESTIGATION_LIMITS = {
  evidence: 8,
  limitations: 4,
  nextChecks: 3,
  missingDates: 7,
} as const;
const LIMITATION =
  'These are leads to verify, derived only from the published aggregates in this report. They state no cause, forecast, score or audience estimate, and they change no count. An absent lead does not certify complete or authentic data.';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function show(value: number): string {
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(4)).toString();
}
/** Provider-supplied text is evidence, never prose: flatten controls and bound it. */
function clean(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximum);
}
function dated(from: unknown, to: unknown, fallback: DateRange): DateRange {
  return typeof from === 'string' &&
    typeof to === 'string' &&
    DATE.test(from) &&
    DATE.test(to) &&
    from <= to
    ? { from, to }
    : fallback;
}
/** FNV-1a: a short stable suffix that needs no crypto runtime. Not a secret or a checksum. */
function suffix(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function series(count: number, singular: string, plural: string): string {
  return `${count} metric series ${count === 1 ? singular : plural}`;
}
function check(id: NextCheckId, resourceId: string | null, window: DateRange | null): NextCheck {
  const [surface, text] = CHECKS[id];
  return { id, surface, resourceId, window, text: text(resourceId ?? 'this project', window) };
}
function cardRef(card: MetricCard, window: DateRange, facts: EvidenceRef['facts']): EvidenceRef {
  return {
    resourceId: card.resourceId,
    metric: card.metric,
    seriesKey: card.key.length <= 512 ? card.key : null,
    window,
    facts,
  };
}
/** The requested dates a binding actually covers; a mapping boundary narrows them. */
function covered(card: MetricCard, window: DateRange): DateRange {
  const from =
    card.scope.effectiveFrom && card.scope.effectiveFrom > window.from
      ? card.scope.effectiveFrom
      : window.from;
  const to =
    card.scope.effectiveTo && card.scope.effectiveTo < window.to
      ? card.scope.effectiveTo
      : window.to;
  return from <= to ? { from, to } : window;
}
/** Recorded context is counted, never credited: a date match is not a cause. */
function annotated(report: ProjectReport, resourceId: string, window: DateRange): number {
  return report.annotations.filter(
    (a) => a.resourceId === resourceId && a.date >= window.from && a.date <= window.to,
  ).length;
}
function lead(
  reason: InvestigationReason,
  evidenceState: InvestigationFinding['evidenceState'],
  resourceId: string,
  key: string,
  summary: string,
  evidence: EvidenceRef[],
  limitations: string[],
  nextChecks: NextCheck[],
): InvestigationFinding {
  const refs = [...evidence].sort(
    (a, b) =>
      compare(a.metric ?? '', b.metric ?? '') ||
      compare(a.seriesKey ?? '', b.seriesKey ?? '') ||
      compare(a.resourceId, b.resourceId) ||
      compare(a.window.from, b.window.from),
  );
  return {
    id: [reason, resourceId, ...(key ? [suffix(key)] : [])].join(':'),
    reason,
    category: reason.slice(0, reason.indexOf('.')) as InvestigationFinding['category'],
    evidenceState,
    resourceId,
    summary: summary.slice(0, 480),
    evidence: refs.slice(0, INVESTIGATION_LIMITS.evidence),
    omittedEvidence: Math.max(0, refs.length - INVESTIGATION_LIMITS.evidence),
    // A metric without a caveat contributes no empty limitation.
    limitations: limitations
      .filter((text) => text.trim())
      .slice(0, INVESTIGATION_LIMITS.limitations)
      .map((text) => text.slice(0, 320)),
    nextChecks: nextChecks.slice(0, INVESTIGATION_LIMITS.nextChecks),
  };
}

function coverageLeads(report: ProjectReport, out: InvestigationFinding[]): void {
  const window = report.window;
  for (const resourceId of [...new Set(report.cards.map((c) => c.resourceId))].sort(compare)) {
    const cards = report.cards.filter((c) => c.resourceId === resourceId);
    const unavailable = cards.filter((c) => c.coverage.status === 'unavailable');
    if (unavailable.length)
      out.push(
        lead(
          'coverage.series_unavailable',
          'unavailable',
          resourceId,
          '',
          `${resourceId}: ${series(unavailable.length, 'has', 'have')} no published observation for ${span(window)}. ${unavailable.length === 1 ? 'The value is' : 'The values are'} unavailable, not zero.`,
          unavailable.map((c) =>
            cardRef(c, covered(c, window), {
              aggregation: c.aggregation,
              observedDays: c.coverage.observedDays,
              expectedDays: c.coverage.expectedDays,
              value: null,
            }),
          ),
          [
            'An absent observation is not a measured zero. This report does not establish whether collection did not run, access was refused, the provider no longer retains the dates or a mapping boundary excludes them.',
          ],
          [
            check('health.latest_refresh', resourceId, null),
            check('plan.window_coverage', resourceId, window),
            check('config.binding_dates', resourceId, window),
          ],
        ),
      );
    // Snapshots are not daily series: a missing snapshot day is not a coverage gap.
    const partial = cards.filter(
      (c) => c.coverage.status === 'partial' && c.aggregation !== 'latest',
    );
    if (partial.length)
      out.push(
        lead(
          'coverage.dates_missing',
          'partial',
          resourceId,
          '',
          `${resourceId}: ${series(partial.length, 'lacks', 'lack')} some requested dates in ${span(window)}. Observed subtotals cover the published dates only and are not full-period totals.`,
          partial.map((c) =>
            cardRef(c, covered(c, window), {
              aggregation: c.aggregation,
              observedDays: c.coverage.observedDays,
              expectedDays: c.coverage.expectedDays,
              missingDays: c.coverage.missingDays.length,
              firstMissing: c.coverage.missingDays[0] ?? null,
              lastMissing: c.coverage.missingDays.at(-1) ?? null,
              missingDates: c.coverage.missingDays
                .slice(0, INVESTIGATION_LIMITS.missingDates)
                .join(','),
              observedSubtotal: finite(c.value),
            }),
          ),
          [
            'Missing dates are not counted as zero, and no period comparison is made for these series. Whether the dates can still be collected is not established here.',
          ],
          [
            check('plan.window_coverage', resourceId, window),
            check('health.latest_refresh', resourceId, null),
            check('provider.same_window', resourceId, window),
          ],
        ),
      );
    const unqualified = cards.filter((c) => c.coverage.qualities.some((q) => q !== 'observed'));
    if (unqualified.length) {
      const qualities = [
        ...new Set(
          unqualified.flatMap((c) => c.coverage.qualities).filter((q) => q !== 'observed'),
        ),
      ].sort(compare);
      out.push(
        lead(
          'quality.values_not_final',
          'limited',
          resourceId,
          '',
          `${resourceId}: ${series(unqualified.length, 'carries', 'carry')} ${qualities.join(', ')} values in ${span(window)}. They are shown as published and no trend comparison is made.`,
          unqualified.map((c) =>
            cardRef(c, covered(c, window), {
              qualities: [...new Set(c.coverage.qualities.filter((q) => q !== 'observed'))]
                .sort(compare)
                .join(','),
              value: finite(c.value),
              latestValue: finite(c.latestValue),
              observedDays: c.coverage.observedDays,
              expectedDays: c.coverage.expectedDays,
            }),
          ),
          [
            'Provisional, sampled, top-N or provider-limited values are not exact complete-population totals. Complete date coverage does not change that.',
          ],
          [
            ...(qualities.includes('provisional')
              ? [check('report.after_finalization', resourceId, window)]
              : []),
            check('provider.same_window', resourceId, window),
            check('report.daily_points', resourceId, window),
          ],
        ),
      );
    }
  }
}

/** The one card for a resource and metric; null when the report holds none or several. */
function seriesKey(report: ProjectReport, resourceId: string, metric: string | null) {
  const cards = report.cards.filter((c) => c.resourceId === resourceId && c.metric === metric);
  return cards.length === 1 && cards[0]!.key.length <= 512 ? cards[0]!.key : null;
}
const SITE_LIMITATION =
  'A declared website preference is an operator assertion, not verification of the site or its visitors. Provider values stay separate: they are never summed and one never replaces another.';
function websiteLeads(report: ProjectReport, out: InvestigationFinding[]): void {
  const window = report.window;
  for (const site of [...(report.websites ?? [])].sort((a, b) => compare(a.id, b.id))) {
    const name = `Website ${site.id} (${site.hostname})`;
    const sources = site.alternatives.map((alternative): EvidenceRef => ({
      resourceId: alternative.source,
      metric: alternative.metric,
      seriesKey: seriesKey(report, alternative.source, alternative.metric),
      window,
      facts: {
        website: site.id,
        role: alternative.source === site.source ? 'preferred' : 'alternative',
        observedValue: finite(alternative.observedValue),
        coverage: alternative.coverage,
        timezone: alternative.timezone,
      },
    }));
    if (site.status === 'unavailable') {
      out.push(
        lead(
          'website.preferred_source_unavailable',
          'unavailable',
          site.source ?? '',
          site.id,
          `${name}: the declared preferred pageview source ${site.source ?? 'none'} lacks complete observed daily pageviews for ${span(window)}. No alternative source is substituted.`,
          sources,
          [
            SITE_LIMITATION,
            'A partial subtotal from the preferred source is not a period total, and its absence is not zero pageviews.',
          ],
          [
            check('health.latest_refresh', site.source, null),
            check('plan.window_coverage', site.source, window),
            check('config.website_preference', null, window),
          ],
        ),
      );
      continue;
    }
    if (site.status === 'changed_during_period' || site.status === 'not_selected') {
      const changed = site.status === 'changed_during_period';
      out.push(
        lead(
          changed ? 'website.preference_changed_in_window' : 'website.no_preferred_source',
          'limited',
          '',
          site.id,
          changed
            ? `${name}: the declared preferred pageview source changes inside ${span(window)}, so no single source value is stated for the period.`
            : `${name}: no preferred pageview source is declared for ${span(window)}. Its sources are shown separately and are not compared.`,
          sources,
          [SITE_LIMITATION],
          [
            ...(changed ? [check('report.split_window', null, window)] : []),
            check('config.website_preference', null, window),
          ],
        ),
      );
      continue;
    }
    for (const comparison of [...site.comparisons].sort((a, b) => compare(a.source, b.source))) {
      const pair = sources.filter(
        (ref) => ref.resourceId === site.source || ref.resourceId === comparison.source,
      );
      const key = site.id + '|' + comparison.source;
      if (comparison.status !== 'side_by_side') {
        out.push(
          lead(
            'website.sources_not_comparable',
            'limited',
            comparison.source,
            key,
            `${name}: ${comparison.source} and the preferred source ${site.source} are not compared for ${span(window)} because their evidence does not match (${comparison.status}). No difference is calculated.`,
            pair.map((ref) =>
              ref.resourceId === comparison.source
                ? {
                    ...ref,
                    facts: {
                      ...ref.facts,
                      comparison: comparison.status,
                      reasons: comparison.reasons.length,
                      firstReason: clean(comparison.reasons[0], 240),
                    },
                  }
                : ref,
            ),
            [
              SITE_LIMITATION,
              'Two sources are compared only with matching dates, timezone, scope, coverage and observed quality. A refused comparison says nothing about which source is right.',
            ],
            // Complete series that still do not match differ in calendar or scope,
            // which collection cannot repair; incomplete ones are a collection question.
            pair.every((ref) => ref.facts.coverage === 'complete')
              ? [
                  check('provider.reporting_calendar', comparison.source, null),
                  check('provider.reporting_calendar', site.source, null),
                  check('report.daily_points', comparison.source, window),
                ]
              : [
                  check('health.latest_refresh', comparison.source, null),
                  check('plan.window_coverage', comparison.source, window),
                  check('report.daily_points', comparison.source, window),
                ],
          ),
        );
        continue;
      }
      const difference = finite(comparison.difference?.absolute);
      if (difference === null || difference === 0) continue;
      out.push(
        lead(
          'website.sources_differ',
          'observed',
          comparison.source,
          key,
          `${name}: ${comparison.source} reports ${show(Math.abs(difference))} ${difference > 0 ? 'more' : 'fewer'} pageviews than the preferred source ${site.source} for the same dates in ${span(window)}. This is a descriptive difference between two providers.`,
          pair.map((ref) =>
            ref.resourceId === comparison.source
              ? {
                  ...ref,
                  facts: {
                    ...ref.facts,
                    differenceFromPreferred: difference,
                    percentOfPreferred: finite(comparison.difference?.percentOfPrimary),
                  },
                }
              : ref,
          ),
          [
            SITE_LIMITATION,
            'The difference is not an estimate of missing traffic, automated share or true audience. Neither value is corrected.',
          ],
          [
            check('provider.counting_scope', comparison.source, null),
            check('provider.counting_scope', site.source, null),
            check('report.daily_points', comparison.source, window),
          ],
        ),
      );
    }
  }
}

function signalLeads(report: ProjectReport, out: InvestigationFinding[]): void {
  const window = report.window;
  for (const signal of report.evidence.signals) {
    const ev = signal.evidence;
    const resourceId = signal.resourceId;
    const ref = (
      range: DateRange,
      facts: EvidenceRef['facts'],
      seriesKey: string | null = null,
    ) => [{ resourceId, metric: signal.metric, seriesKey, window: range, facts }];
    const code: EvidenceSignal['code'] | (string & {}) = signal.code;
    if (code === 'concentrated_activity') {
      const peak = dated(ev.peakFrom, ev.peakTo, window);
      const matches = report.cards.filter(
        (c) =>
          c.resourceId === resourceId &&
          c.metric === signal.metric &&
          c.methodology === ev.methodology &&
          JSON.stringify(c.dimensions) === ev.dimensions &&
          JSON.stringify(c.scope) === ev.scope,
      );
      const key = matches.length === 1 && matches[0]!.key.length <= 512 ? matches[0]!.key : null;
      const context = annotated(report, resourceId, peak);
      const peakTotal = finite(ev.peakSevenDayTotal) ?? Number.NaN;
      const total = finite(ev.periodTotal) ?? Number.NaN;
      const counted = Number.isFinite(peakTotal) && Number.isFinite(total);
      out.push(
        lead(
          'concentration.activity_window',
          counted ? 'observed' : 'limited',
          resourceId,
          [signal.metric, ev.methodology, ev.dimensions, ev.scope].join('|'),
          // A signal without usable counts is restated as such, never as zero.
          counted
            ? `${resourceId}: ${signal.metric} has ${show(peakTotal)} of ${show(total)} in the seven days ${span(peak)}, at least half of the ${span(window)} total. The cause is not established.`
            : `${resourceId}: ${signal.metric} was flagged for concentrated activity in ${span(window)}, but the signal carries no usable counts. Its values are unavailable here.`,
          ref(
            peak,
            {
              periodTotal: finite(ev.periodTotal),
              peakSevenDayTotal: finite(ev.peakSevenDayTotal),
              peakShare: finite(ev.peakShare),
              minimumTotal: finite(ev.minimumTotal),
              shareThreshold: finite(ev.shareThreshold),
              timezone: clean(ev.timezone, 64),
              // Context only: a count of recorded annotations, never a cause.
              recordedAnnotationsInPeak: context,
            },
            key,
          ),
          [
            'A seven-day concentration is an explicit review heuristic, not a statistical test. Its cause, any automation and the human share are unknown.',
            ...(context
              ? [
                  'An annotation dated inside the peak is context only; it does not show that a release or note produced the activity.',
                ]
              : []),
          ],
          [
            check('report.daily_points', resourceId, window),
            ...(context ? [check('report.recorded_context', resourceId, peak)] : []),
            check('provider.same_window', resourceId, peak),
          ],
        ),
      );
    } else if (code === 'concentrated_referrers' || code === 'concentrated_site_referrers') {
      const rolling = code === 'concentrated_referrers';
      const range = rolling ? dated(ev.from, ev.to, window) : window;
      const part = finite(rolling ? ev.referrerViews : ev.referrerPageviews);
      const whole = finite(rolling ? ev.listedViews : ev.listedPageviews);
      out.push(
        lead(
          rolling
            ? 'attribution.referrer_snapshot_concentrated'
            : 'attribution.site_referrer_rows_concentrated',
          'limited',
          resourceId,
          signal.metric,
          part === null || whole === null
            ? `${resourceId}: the returned referrer rows for ${span(range)} were flagged as concentrated on one referrer, but the signal carries no usable counts. Its values are unavailable here.`
            : rolling
              ? `${resourceId}: one referrer accounts for ${show(part)} of ${show(whole)} views in the latest returned top-referrer snapshot (${span(range)}). The share is of the returned list only.`
              : `${resourceId}: one referrer is named on ${show(part)} of ${show(whole)} pageviews in the returned referrer rows for ${span(range)}. The share is of the returned rows only.`,
          ref(range, {
            referrer: clean(ev.referrer, 120),
            referrerCount: part,
            listedCount: whole,
            listedShare: finite(ev.listedShare),
            shareThreshold: finite(ev.shareThreshold),
            scope: rolling ? 'latest_returned_top_n_snapshot' : 'returned_daily_referrer_rows_only',
          }),
          [
            'A referrer value is supplied by the client and names no verified person, organisation or visit. The denominator is the returned list, never all traffic.',
            'No referrer is classified as genuine or automated, and underlying totals are unchanged.',
          ],
          [
            check('report.referrer_rows', resourceId, range),
            check('provider.same_window', resourceId, range),
          ],
        ),
      );
    } else if (code === 'unattributed_referrer') {
      const missing = finite(ev.unattributedPageviews);
      const listed = finite(ev.listedPageviews);
      out.push(
        lead(
          'attribution.referrer_missing',
          missing === null || listed === null ? 'limited' : 'observed',
          resourceId,
          signal.metric,
          missing === null || listed === null
            ? `${resourceId}: some returned referrer rows for ${span(window)} have pageviews without a referrer. A reliable subtotal is unavailable.`
            : `${resourceId}: ${show(missing)} of ${show(listed)} pageviews in the returned referrer rows for ${span(window)} have no referrer.`,
          ref(window, {
            unattributedPageviews: missing,
            listedPageviews: listed,
            listedShare: finite(ev.listedShare),
            scope: 'returned_daily_referrer_rows_only',
          }),
          [
            'A missing referrer is unknown attribution, not a direct visit or a human visitor. The rows are a returned subset, not all site traffic.',
          ],
          [
            check('report.referrer_rows', resourceId, window),
            check('provider.same_window', resourceId, window),
          ],
        ),
      );
    } else {
      // A signal this module does not yet describe is still surfaced, without detail.
      const label = String(code)
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, 64);
      out.push(
        lead(
          'interpretation.review_signal',
          'limited',
          resourceId,
          label + '|' + signal.metric,
          `${resourceId}: the report raised review signal ${label} for ${signal.metric} in ${span(window)}.`,
          ref(window, { signal: label }),
          ['This lead restates a review signal; read its evidence in the full project report.'],
          [check('report.daily_points', resourceId, window)],
        ),
      );
    }
  }
}

export interface SupportedChange {
  change: number;
  before: number;
  current: number;
  baseline: DateRange;
}
/**
 * Whether a card's recorded comparison may be restated. The comparison must
 * agree with the card that carries it: both values finite, their difference
 * exactly the recorded change, a dated baseline and only observed values. A
 * summed daily count must also pass the shared strict daily count gate, so a
 * sampled, partial or inconsistent series cannot keep a stale comparison.
 * Snapshots and weighted ratios keep the report's own comparison rules.
 */
export function supportedChange(card: MetricCard, window: DateRange): SupportedChange | null {
  const change = finite(card.comparison.absoluteChange);
  const before = finite(card.comparison.previousValue);
  const current = finite(card.value);
  const baseline = card.comparison.baselinePeriod;
  if (change === null || before === null || current === null || !baseline) return null;
  if (current - before !== change) return null;
  if (!card.coverage.qualities.length || card.coverage.qualities.some((q) => q !== 'observed'))
    return null;
  const supported = { change, before, current, baseline };
  if (card.comparison.kind === 'net_change')
    return card.aggregation === 'latest' && card.latestPeriod ? supported : null;
  if (card.comparison.kind !== 'period_change') return null;
  if (card.aggregation === 'sum')
    return evaluateDailyCountEvidence(card, days(window)).eligible ? supported : null;
  return (card.aggregation === 'weighted_mean' || card.aggregation === 'ratio') &&
    card.coverage.status === 'complete'
    ? supported
    : null;
}

function changeLeads(report: ProjectReport, out: InvestigationFinding[]): void {
  const window = report.window;
  for (const card of [...report.cards].sort((a, b) => compare(a.key, b.key))) {
    const supported = supportedChange(card, window);
    if (!supported || supported.change === 0) continue;
    const { change, before, current, baseline } = supported;
    const direction = change > 0 ? 'increased' : 'decreased';
    const amount = `${show(Math.abs(change))} ${card.unit}`;
    const context = annotated(report, card.resourceId, window);
    const facts = {
      absoluteChange: change,
      recordedAnnotationsInWindow: context,
      relativeChange: finite(card.comparison.relativeChange),
      timezone: card.timezone,
      methodology: card.methodology,
      aggregation: card.aggregation,
    };
    if (card.comparison.kind === 'net_change') {
      const latest = card.latestPeriod ?? window;
      out.push(
        lead(
          'change.snapshot_net',
          'observed',
          card.resourceId,
          card.key,
          `${card.resourceId}: ${card.label} ${direction} by ${amount} net between the snapshots dated ${baseline.to} and ${latest.to}.`,
          [
            cardRef(card, latest, { role: 'current', value: current, ...facts }),
            cardRef(card, baseline, { role: 'baseline', value: before }),
          ],
          [
            'This is the net difference between two dated snapshots, not gross additions or removals between them, and no cause is credited.',
            card.caveat,
          ],
          [
            check('provider.same_window', card.resourceId, { from: baseline.to, to: latest.to }),
            ...(context ? [check('report.recorded_context', card.resourceId, window)] : []),
          ],
        ),
      );
      continue;
    }
    if (card.comparison.kind !== 'period_change') continue;
    // The report withholds a percentage for a summed baseline below ten.
    const small = card.aggregation === 'sum' && before < 10;
    out.push(
      lead(
        small ? 'change.small_baseline' : 'change.period',
        small ? 'limited' : 'observed',
        card.resourceId,
        card.key,
        `${card.resourceId}: ${card.label} ${direction} by ${amount} against ${span(baseline)} (${show(before)} then ${show(current)}).${small ? ' The baseline is below 10, so no percentage is stated.' : ''}`,
        [
          cardRef(card, window, { role: 'current', value: current, ...facts }),
          cardRef(card, baseline, { role: 'baseline', value: before }),
        ],
        [
          'Both periods use the same metric, source scope, timezone and duration. The change is described, not explained: no cause, campaign or release is credited.',
          ...(small
            ? [
                'A percentage of a baseline below 10 would overstate a small count; only the absolute change is supported.',
              ]
            : []),
          card.caveat,
        ],
        [
          check('provider.same_window', card.resourceId, window),
          ...(context ? [check('report.recorded_context', card.resourceId, window)] : []),
          check('report.daily_points', card.resourceId, window),
        ],
      ),
    );
  }
}

function baselineLeads(report: ProjectReport, out: InvestigationFinding[]): void {
  const window = report.window;
  const prior = previous(window);
  for (const resourceId of [...new Set(report.cards.map((c) => c.resourceId))].sort(compare)) {
    // Series already reported as missing, unqualified or non-additive are not repeated here.
    const cards = report.cards.filter(
      (c) =>
        c.resourceId === resourceId &&
        c.comparison.kind === null &&
        c.aggregation !== 'none' &&
        finite(c.value) !== null &&
        c.coverage.qualities.length > 0 &&
        c.coverage.qualities.every((q) => q === 'observed') &&
        (c.aggregation === 'latest' || c.coverage.status === 'complete'),
    );
    if (!cards.length) continue;
    out.push(
      lead(
        'comparison.baseline_unavailable',
        'limited',
        resourceId,
        '',
        `${resourceId}: ${series(cards.length, 'has', 'have')} a current value for ${span(window)} but no comparable baseline. Read the period as a baseline, not a trend.`,
        cards.map((c) =>
          cardRef(c, covered(c, window), {
            aggregation: c.aggregation,
            currentValue: finite(c.value),
            comparisonReason: clean(c.comparison.reason, 240),
            mappingEffectiveFrom: c.scope.effectiveFrom ?? null,
            mappingEffectiveTo: c.scope.effectiveTo ?? null,
          }),
        ),
        [
          'No change is stated because the preceding equal-length period lacks complete, observed, same-scope data or a sufficiently recent snapshot. A missing baseline is not a baseline of zero.',
        ],
        [
          check('report.next_complete_window', resourceId, window),
          check('plan.window_coverage', resourceId, prior),
          check('config.binding_dates', resourceId, prior),
        ],
      ),
    );
  }
}

/**
 * Deterministic for a given report: the same input yields the same leads in
 * the same order. `maximum` bounds the returned leads; the rest are counted.
 */
export function investigateProject(
  report: ProjectReport,
  maximum = 20,
  graph?: ProjectGraph,
): ProjectInvestigation {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100)
    throw new RangeError('Investigation limit must be between 1 and 100.');
  const findings: InvestigationFinding[] = [];
  coverageLeads(report, findings);
  websiteLeads(report, findings);
  signalLeads(report, findings);
  changeLeads(report, findings);
  baselineLeads(report, findings);
  findings.sort(
    (a, b) =>
      INVESTIGATION_REASONS.indexOf(a.reason) - INVESTIGATION_REASONS.indexOf(b.reason) ||
      compare(a.resourceId, b.resourceId) ||
      compare(a.evidence[0]?.metric ?? '', b.evidence[0]?.metric ?? '') ||
      compare(a.id, b.id),
  );
  // Identical reason, resource and series can only repeat for duplicated input rows.
  const seen = new Map<string, number>();
  for (const finding of findings) {
    const count = (seen.get(finding.id) ?? 0) + 1;
    seen.set(finding.id, count);
    if (count > 1) finding.id += '~' + count;
  }
  if (graph && graph.project.id !== report.project.id)
    throw new PulseError('CONFIG', 'The project graph belongs to another project.');
  if (graph)
    for (const finding of findings) {
      const resource = graph.resources.find((candidate) => candidate.id === finding.resourceId);
      if (!resource) continue;
      finding.subject = {
        kind: resource.kind,
        identity: resource.identity,
        sharedWithProjects: resource.sharedWithProjects.length,
        websites: resource.websites,
      };
      if (
        resource.sharedWithProjects.length &&
        finding.limitations.length < INVESTIGATION_LIMITS.limitations
      )
        finding.limitations.push(
          'This resource is explicitly shared with other projects; its values must not be added across projects.',
        );
    }
  return {
    schemaVersion: 1,
    findings: findings.slice(0, maximum),
    omittedFindings: Math.max(0, findings.length - maximum),
    limitation: LIMITATION,
  };
}
