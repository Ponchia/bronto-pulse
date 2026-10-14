import type { ProjectReport } from './report.js';

export interface Finding {
  kind: 'coverage' | 'quality' | 'change' | 'baseline';
  resourceId: string;
  metric?: string;
  message: string;
  evidence: Record<string, string | number | null>;
}
export interface Brief {
  schemaVersion: 1;
  project: ProjectReport['project'];
  window: ProjectReport['window'];
  generatedAt: string;
  demo: boolean;
  findings: Finding[];
  omittedFindings: number;
  annotations: ProjectReport['annotations'];
  warnings: string[];
  limitation: string;
}
const display = (n: number) => (Number.isInteger(n) ? String(n) : Number(n.toFixed(4)).toString());
/** Deterministic evidence summaries. No LLM, identity attribution or causal claims. */
export function projectBrief(report: ProjectReport, maximum = 20): Brief {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100)
    throw new RangeError('Brief limit must be between 1 and 100.');
  const findings: Finding[] = [];
  const resources = [...new Set(report.cards.map((c) => c.resourceId))].sort();
  for (const resourceId of resources) {
    const cards = report.cards.filter((c) => c.resourceId === resourceId);
    const gaps = cards.filter(
      (c) => c.coverage.status !== 'complete' && c.aggregation !== 'latest',
    );
    if (gaps.length)
      findings.push({
        kind: 'coverage',
        resourceId,
        message: `${resourceId}: ${gaps.length} metric series have missing or unavailable dates. Observed subtotals must not be treated as full-period totals.`,
        evidence: {
          affectedSeries: gaps.length,
          requestedFrom: report.window.from,
          requestedTo: report.window.to,
        },
      });
    const qualities = [
      ...new Set(cards.flatMap((c) => c.coverage.qualities).filter((q) => q !== 'observed')),
    ].sort();
    if (qualities.length)
      findings.push({
        kind: 'quality',
        resourceId,
        message: `${resourceId}: ${qualities.join(', ')} values are present. Unqualified growth comparisons are withheld.`,
        evidence: {
          qualities: qualities.join(','),
          requestedFrom: report.window.from,
          requestedTo: report.window.to,
        },
      });
  }
  for (const card of [...report.cards].sort((a, b) => a.key.localeCompare(b.key))) {
    const change = card.comparison.absoluteChange;
    if (change === null || change === 0) continue;
    const direction = change > 0 ? 'increased' : 'decreased';
    const basis =
      card.comparison.kind === 'net_change'
        ? 'between the two recorded snapshots'
        : 'against the preceding equal-length period';
    findings.push({
      kind: 'change',
      resourceId: card.resourceId,
      metric: card.metric,
      message: `${card.label} ${direction} by ${display(Math.abs(change))} ${card.unit} ${basis}.`,
      evidence: {
        currentValue: card.value,
        previousValue: card.comparison.previousValue,
        absoluteChange: change,
        relativeChange: card.comparison.relativeChange,
        baselineFrom: card.comparison.baselinePeriod?.from ?? null,
        baselineTo: card.comparison.baselinePeriod?.to ?? null,
        currentFrom: report.window.from,
        currentTo: report.window.to,
        timezone: card.timezone,
        methodology: card.methodology,
      },
    });
  }
  if (!findings.some((f) => f.kind === 'change'))
    findings.push({
      kind: 'baseline',
      resourceId: '',
      message:
        'No supported non-zero change was established for this period. This can mean unchanged comparable data or an insufficient baseline, not absence of interest.',
      evidence: {
        comparableSeries: report.cards.filter((c) => c.comparison.absoluteChange !== null).length,
      },
    });
  return {
    schemaVersion: 1,
    project: report.project,
    window: report.window,
    generatedAt: report.generatedAt,
    demo: report.demo,
    findings: findings.slice(0, maximum),
    omittedFindings: Math.max(0, findings.length - maximum),
    annotations: report.annotations,
    warnings: report.warnings,
    limitation:
      'Independent source observations, not people, conversions or causal effects. Release annotations provide context only.',
  };
}
function prose(value: string): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/([\\`*_{}\[\]#|])/g, '\\$1');
}
export function markdownBrief(brief: Brief): string {
  return [
    `# ${prose(brief.project.label)} — project briefing`,
    '',
    `${brief.window.from} → ${brief.window.to}${brief.demo ? ' · SYNTHETIC DEMO' : ''}`,
    '',
    ...brief.findings.map((f) => `- ${prose(f.message)}`),
    ...(brief.omittedFindings
      ? [
          '',
          `${brief.omittedFindings} additional findings omitted; inspect the full project report.`,
        ]
      : []),
    ...(brief.annotations.length
      ? [
          '',
          '## Recorded context',
          ...brief.annotations.slice(0, 20).map((a) => `- ${a.date}: ${prose(a.title)}`),
        ]
      : []),
    ...(brief.warnings.length
      ? [
          '',
          '## Collection and interpretation notes',
          ...brief.warnings.map((w) => `- ${prose(w)}`),
        ]
      : []),
    '',
    brief.limitation,
    '',
  ].join('\n');
}
