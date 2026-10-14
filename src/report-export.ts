import type { ProjectReport } from './report.js';
/** Quoting alone does not prevent spreadsheet formula execution in text cells. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '""';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('CSV values must be finite.');
    return `"${value}"`;
  }
  const plain = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(plain) || /^[\t\r\n]/.test(plain) ? "'" + plain : plain;
  return '"' + safe.replaceAll('"', '""') + '"';
}
const headings = [
  'project',
  'resource',
  'metric',
  'unit',
  'aggregation',
  'from',
  'to',
  'timezone',
  'scope',
  'methodology',
  'value',
  'latest_value',
  'latest_from',
  'latest_to',
  'observed_days',
  'expected_days',
  'coverage',
  'qualities',
  'previous_value',
  'absolute_change',
  'comparison_kind',
  'comparison_reason',
];
export function csvReport(report: ProjectReport): string {
  const rows: (string | number | null)[][] = [headings];
  for (const c of report.cards)
    rows.push([
      report.project.id,
      c.resourceId,
      c.metric,
      c.unit,
      c.aggregation,
      report.window.from,
      report.window.to,
      c.timezone,
      JSON.stringify(c.scope),
      c.methodology,
      c.value,
      c.latestValue,
      c.latestPeriod?.from ?? null,
      c.latestPeriod?.to ?? null,
      c.coverage.observedDays,
      c.coverage.expectedDays,
      c.coverage.status,
      c.coverage.qualities.join(';'),
      c.comparison.previousValue,
      c.comparison.absoluteChange,
      c.comparison.kind,
      c.comparison.reason,
    ]);
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
