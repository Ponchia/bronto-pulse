import { PulseError } from './errors.js';
import type { ProjectReport } from './report.js';
import { days } from './time.js';
import { evaluateDailyCountEvidence } from './evidence-compatibility.js';

const PAGEVIEW_METRICS = new Set([
  'cloudflare.pageviews',
  'plausible.pageviews',
  'umami.pageviews',
]);

export interface WebsiteSourceComparison {
  schemaVersion: 1;
  status: 'needs_confirmation' | 'unavailable' | 'incompatible' | 'side_by_side';
  window: ProjectReport['window'];
  sources: {
    resourceId: string;
    metric: string | null;
    provider: string | null;
    timezone: string | null;
    observedDays: number | null;
    expectedDays: number | null;
    value: number | null;
    methodology: string | null;
  }[];
  difference: { absolute: number; percentOfPrimary: number | null } | null;
  reasons: string[];
  limitation: string;
}

const LIMITATION =
  'These numbers are independent provider observations, not deduplicated visits or verified people. A side-by-side difference is not an estimate of missing traffic, bot share, or true audience. Never add provider totals together.';

function canonical(obj: unknown) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '{}';
  return JSON.stringify(
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))),
  );
}

/** Require explicit user assertion of same-site identity; never infer it from project membership. */
export function compareWebsiteSources(
  report: Pick<ProjectReport, 'window' | 'cards'>,
  primaryId: string,
  secondaryId: string,
  confirmedSameSite = false,
): WebsiteSourceComparison {
  if (
    !/^[a-z][a-z0-9_-]{0,63}$/.test(primaryId) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(secondaryId) ||
    primaryId === secondaryId
  )
    throw new PulseError('CONFIG', 'Select two distinct, valid project resource identifiers.');

  const candidates = [primaryId, secondaryId].map((id) => {
    const found = report.cards.filter(
      (card) => card.resourceId === id && PAGEVIEW_METRICS.has(card.metric),
    );
    return found.length === 1 ? found[0]! : null;
  });
  const [primary, secondary] = candidates;
  const sources = candidates.map((card, i) => ({
    resourceId: i === 0 ? primaryId : secondaryId,
    metric: card?.metric ?? null,
    provider: card?.provider ?? null,
    timezone: card?.timezone ?? null,
    observedDays: card?.coverage.observedDays ?? null,
    expectedDays: card?.coverage.expectedDays ?? null,
    value: card?.value ?? null,
    methodology: card?.methodology ?? null,
  }));
  const result = (
    status: WebsiteSourceComparison['status'],
    reasons: string[],
    difference: WebsiteSourceComparison['difference'] = null,
  ): WebsiteSourceComparison => ({
    schemaVersion: 1,
    status,
    window: report.window,
    sources,
    difference,
    reasons,
    limitation: LIMITATION,
  });
  if (!confirmedSameSite)
    return result('needs_confirmation', [
      'Two resources in one project do not necessarily monitor the same site. Confirm the identity and intended scope before comparing.',
    ]);
  if (!primary || !secondary)
    return result('unavailable', [
      'Each resource must have exactly one pageview series for the selected period. Missing or ambiguous series cannot be compared.',
    ]);
  if (primary.timezone !== secondary.timezone)
    return result('incompatible', [
      'The sources report different calendar timezones. Align the source period before comparing daily counts.',
    ]);
  if (
    canonical(primary.scope) !== canonical(secondary.scope) ||
    canonical(primary.dimensions) !== canonical(secondary.dimensions)
  )
    return result('incompatible', [
      'The sources have different explicit scope/dimensions. Partial-page and whole-property counts are not comparable.',
    ]);
  const dates = days(report.window);
  const decisions = [primary, secondary].map((card) =>
    evaluateDailyCountEvidence(card, dates, 'pageviews'),
  );
  if (decisions.some((decision) => !decision.eligible))
    return result('incompatible', [
      'Both series require complete, observed, non-sampled daily buckets for identical dates. Missing values are not zero.',
      ...decisions.flatMap((decision, i) =>
        decision.issues.map((issue) => `${sources[i]!.resourceId}: ${issue.message}`),
      ),
    ]);
  const difference = secondary.value! - primary.value!;
  return result(
    'side_by_side',
    [
      'The same-site assertion comes from the operator, not provider identity verification.',
      'Pageview collection methods may differ, so the difference is descriptive rather than a corrected or universal audience count.',
    ],
    {
      absolute: difference,
      percentOfPrimary: primary.value! >= 10 ? difference / primary.value! : null,
    },
  );
}
