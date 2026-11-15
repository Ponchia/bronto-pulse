import { investigateProject, type InvestigationFinding } from './investigations.js';
import type { portfolio } from './report.js';

/**
 * A read-only owner agenda across projects. The source investigations already
 * establish what is knowable; this merely exposes one navigable example per
 * evidence lane. Magnitudes from different metrics are never ranked or summed.
 */
type PortfolioSnapshot = Awaited<ReturnType<typeof portfolio>>;
export type ReviewLane = 'investigate' | 'change' | 'qualify';
export interface ReviewFocus {
  lane: ReviewLane;
  lead: InvestigationFinding;
}
export interface ReviewedProject {
  project: PortfolioSnapshot['reports'][number]['project'];
  /** Counts only the leads actually inspected (at most 100), not hidden leads. */
  counts: Record<ReviewLane, number>;
  otherLeads: number;
  omittedLeads: number;
  focus: ReviewFocus[];
}
export interface OwnerReview {
  schemaVersion: 1;
  window: PortfolioSnapshot['window'];
  generatedAt: string;
  demo: boolean;
  projects: ReviewedProject[];
  totals: {
    projects: number;
    withInvestigation: number;
    withSupportedChange: number;
    withEvidenceLimits: number;
    omittedLeads: number;
  };
  limitation: string;
}

const LIMITATION =
  'An operator agenda, not a priority score or growth forecast. Each project shows at most one example per evidence lane; counts describe listed leads, never distinct people or severity. All examples retain their published source, dates, limitations and next checks. Missing evidence is not zero, and absence of a lead is not proof of independent adoption.';

// Only recorded cross-source differences and interpretation signals merit the
// investigate lane. Ordinary comparisons have a separate, less assertive lane.
function lane(finding: InvestigationFinding): ReviewLane | null {
  if (
    ['concentration', 'attribution', 'interpretation'].includes(finding.category) ||
    finding.reason === 'website.sources_differ'
  )
    return 'investigate';
  if (finding.category === 'change') return 'change';
  if (['coverage', 'quality', 'comparison', 'website'].includes(finding.category)) return 'qualify';
  return null;
}
const order: readonly ReviewLane[] = ['investigate', 'change', 'qualify'];

/** No I/O. Reuses precisely the same deterministic investigation implementation. */
export function ownerReview(snapshot: PortfolioSnapshot): OwnerReview {
  const projects = snapshot.reports.map((report): ReviewedProject => {
    // Normal reports already include a deterministic investigation with up to
    // twenty leads. Reuse it when complete; source-backed reasons and next
    // checks must not be recomputed for a typical portfolio request.
    // If truncated, expand from the same in-memory report (never a new read)
    // so early coverage barriers cannot hide later supported changes.
    const cached = report.investigation;
    const investigation =
      cached?.schemaVersion === 1 &&
      cached.omittedFindings === 0 &&
      Array.isArray(cached.findings) &&
      cached.findings.length <= 100
        ? cached
        : investigateProject(report, 100, report.resources);
    const grouped: Record<ReviewLane, InvestigationFinding[]> = {
      investigate: [],
      change: [],
      qualify: [],
    };
    let otherLeads = 0;
    for (const finding of investigation.findings) {
      const destination = lane(finding);
      if (destination) grouped[destination].push(finding);
      else otherLeads++;
    }
    const focus: ReviewFocus[] = [];
    for (const kind of order) {
      // For investigation signals, observed evidence takes precedence over a
      // limited signal. Every other choice stays in the source's fixed reason
      // order, not a fabricated rank across metrics or projects.
      const example =
        (kind === 'investigate'
          ? grouped[kind].find((f) => f.evidenceState === 'observed')
          : undefined) ?? grouped[kind][0];
      if (example)
        // Do not expose mutable aliases of the project report's cached leads.
        focus.push({ lane: kind, lead: structuredClone(example) });
    }
    return {
      project: report.project,
      counts: {
        investigate: grouped.investigate.length,
        change: grouped.change.length,
        qualify: grouped.qualify.length,
      },
      otherLeads,
      omittedLeads: investigation.omittedFindings,
      focus,
    };
  });
  return {
    schemaVersion: 1,
    window: snapshot.window,
    generatedAt: snapshot.generatedAt,
    demo: snapshot.demo,
    projects,
    totals: {
      projects: projects.length,
      withInvestigation: projects.filter((p) => p.counts.investigate > 0).length,
      withSupportedChange: projects.filter((p) => p.counts.change > 0).length,
      withEvidenceLimits: projects.filter((p) => p.counts.qualify > 0).length,
      omittedLeads: projects.reduce((count, p) => count + p.omittedLeads, 0),
    },
    limitation: LIMITATION,
  };
}
function prose(text: string): string {
  return text
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/([\\`*_{}\[\]#|])/g, '\\$1');
}
const headings: Record<ReviewLane, string> = {
  investigate: 'Investigate published evidence',
  change: 'Supported comparison',
  qualify: 'Qualify missing or limited evidence',
};
export function markdownReview(review: OwnerReview): string {
  const lines = [
    '# Bronto Pulse — owner review',
    '',
    `${review.window.from} → ${review.window.to}${review.demo ? ' · SYNTHETIC DEMO' : ''}`,
    '',
    review.limitation,
    '',
    `Projects: ${review.totals.projects}; investigation signals: ${review.totals.withInvestigation} projects; supported changes: ${review.totals.withSupportedChange} projects; evidence limits: ${review.totals.withEvidenceLimits} projects.`,
  ];
  for (const project of review.projects) {
    lines.push('', `## ${prose(project.project.label)}`, '');
    if (!project.focus.length)
      lines.push(
        'No qualifying example from the listed evidence. This does not establish zero activity or independent adoption.',
      );
    for (const item of project.focus) {
      lines.push(
        `### ${headings[item.lane]} · ${item.lead.reason}`,
        '',
        prose(item.lead.summary),
        '',
        ...item.lead.limitations.slice(0, 2).map((x) => `- Limit: ${prose(x)}`),
        ...item.lead.nextChecks.slice(0, 2).map((x) => `- Verify: ${prose(x.text)}`),
        '',
      );
    }
    lines.push(
      `Listed: ${project.counts.investigate} investigation, ${project.counts.change} supported change, ${project.counts.qualify} qualification leads.`,
    );
    if (project.omittedLeads)
      lines.push(
        `${project.omittedLeads} additional leads beyond the per-project 100-lead analysis ceiling; inspect the full report.`,
      );
  }
  return lines.join('\n') + '\n';
}
