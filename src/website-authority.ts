import type { WebsitePolicy } from './config.js';
import type { MetricCard } from './report.js';
import { days, type DateRange } from './time.js';
import { evaluateDailyCountEvidence } from './evidence-compatibility.js';
import { compareWebsiteSources, type WebsiteSourceComparison } from './source-comparison.js';

/**
 * Explicit website identity and metric authority, never automatic source
 * reconciliation or inferred independent users. A different source must not
 * silently replace a failed preferred source.
 */
export interface WebsiteAuthority {
  id: string;
  hostname: string;
  status: 'not_selected' | 'changed_during_period' | 'unavailable' | 'ready';
  source: string | null;
  metric: string | null;
  value: number | null;
  effectiveFrom: string | null;
  alternatives: {
    source: string;
    provider: string | null;
    metric: string | null;
    observedValue: number | null;
    coverage: 'complete' | 'partial' | 'unavailable';
    timezone: string | null;
  }[];
  reason: string;
  limitation: string;
  /** Strict same-site, operator-declared descriptive comparisons to the preferred source.
   * No difference is calculated when coverage, scope, calendars or quality disagree.
   */
  comparisons: {
    source: string;
    status: WebsiteSourceComparison['status'];
    difference: WebsiteSourceComparison['difference'];
    reasons: string[];
  }[];
}

const PAGEVIEWS = new Set(['cloudflare.pageviews', 'plausible.pageviews', 'umami.pageviews']);
const LIMITATION =
  'This is an operator-declared source preference, not independent verification of the website or its visitors. Alternative providers remain visible. Source values are never summed or silently substituted.';

export function websiteAuthorities(
  sites: readonly WebsitePolicy[],
  cards: readonly MetricCard[],
  window: DateRange,
): WebsiteAuthority[] {
  const requestedDates = days(window);
  return sites.map((site) => {
    const alternatives = site.sources.map((source) => {
      const options = cards.filter(
        (card) => card.resourceId === source && PAGEVIEWS.has(card.metric),
      );
      const single = options.length === 1 ? options[0]! : null;
      return {
        source,
        provider: single?.provider ?? null,
        metric: single?.metric ?? null,
        observedValue: single?.value ?? null,
        coverage: single?.coverage.status ?? ('unavailable' as const),
        timezone: single?.timezone ?? null,
      };
    });
    const result = (
      status: WebsiteAuthority['status'],
      source: string | null,
      effectiveFrom: string | null,
      metric: string | null,
      value: number | null,
      reason: string,
    ): WebsiteAuthority => ({
      id: site.id,
      hostname: site.hostname,
      status,
      source,
      metric,
      value,
      effectiveFrom,
      alternatives,
      reason,
      limitation: LIMITATION,
      comparisons:
        status === 'ready' && source !== null
          ? site.sources
              .filter((candidate) => candidate !== source)
              .map((candidate) => {
                // The website policy itself is the explicit same-site owner
                // assertion. The standalone comparison API still requires
                // an independent confirmation from its caller.
                const comparison = compareWebsiteSources(
                  { window, cards: [...cards] },
                  source,
                  candidate,
                  true,
                );
                return {
                  source: candidate,
                  status: comparison.status,
                  difference: comparison.difference,
                  reasons: comparison.reasons,
                };
              })
          : [],
    });
    const selections = site.pageviewsAuthority ?? [];
    const active = selections.filter((item) => item.effectiveFrom <= window.from).at(-1);
    const changes = selections.filter(
      (item) => item.effectiveFrom > window.from && item.effectiveFrom <= window.to,
    );
    if (changes.length) {
      return result(
        'changed_during_period',
        null,
        null,
        null,
        null,
        'Preferred pageview source changes within the requested period. Split the period before interpreting it; do not combine separate sources.',
      );
    }
    if (!active) {
      return result(
        'not_selected',
        null,
        null,
        null,
        null,
        'No preferred pageview source is declared for this period.',
      );
    }
    const matches = cards.filter(
      (card) => card.resourceId === active.resource && PAGEVIEWS.has(card.metric),
    );
    if (matches.length !== 1)
      return result(
        'unavailable',
        active.resource,
        active.effectiveFrom,
        null,
        null,
        'The preferred source has no unambiguous pageview series. Alternatives are not automatically substituted.',
      );
    const preferred = matches[0]!;
    const decision = evaluateDailyCountEvidence(preferred, requestedDates, 'pageviews');
    if (!decision.eligible)
      return result(
        'unavailable',
        active.resource,
        active.effectiveFrom,
        preferred.metric,
        null,
        'The preferred source lacks complete, exact observed daily pageviews for this period. A partial subtotal cannot become authoritative. ' +
          decision.issues.map((issue) => issue.message).join(' '),
      );
    return result(
      'ready',
      active.resource,
      active.effectiveFrom,
      preferred.metric,
      preferred.value,
      'The declared preferred source has complete, observed daily pageview evidence for this period; its value remains provider-defined.',
    );
  });
}
