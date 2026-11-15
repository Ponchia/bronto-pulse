import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidence } from '../src/evidence.js';
import { ownerReview, markdownReview } from '../src/review.js';
import { projectBrief } from '../src/brief.js';
import type { MetricCard, ProjectReport } from '../src/report.js';
import { days } from '../src/time.js';
import { fixture, database, now } from './helpers.js';
import { portfolio } from '../src/report.js';

const window = { from: '2026-09-01', to: '2026-09-30' };
const baseline = { from: '2026-08-02', to: '2026-08-31' };
const observations = days(window);
function card(resource: string, override: Partial<MetricCard> = {}): MetricCard {
  const points = observations.map((date) => ({
    date,
    from: date,
    to: date,
    value: 20,
    quality: 'observed' as const,
  }));
  return {
    key: JSON.stringify([resource, 'npm.downloads', '{}', 'synthetic-v1']),
    resourceId: resource,
    provider: 'npm',
    metric: 'npm.downloads',
    evidenceClass: 'distribution',
    label: 'Package downloads',
    unit: 'downloads',
    aggregation: 'sum',
    dimensions: {},
    scope: {},
    timezone: 'UTC',
    methodology: 'synthetic-v1',
    latestCollectedAt: '2026-10-01T00:00:00Z',
    value: 600,
    latestValue: 20,
    latestPeriod: { from: window.to, to: window.to },
    points,
    coverage: {
      observedDays: 30,
      expectedDays: 30,
      missingDays: [],
      status: 'complete',
      qualities: ['observed'],
    },
    caveat: 'Downloads are not users.',
    comparison: {
      previousValue: 300,
      absoluteChange: 300,
      relativeChange: 1,
      reason: 'Two complete observed periods.',
      kind: 'period_change',
      baselinePeriod: baseline,
    },
    ...override,
  };
}
function unavailable(resource: string): MetricCard {
  return card(resource, {
    value: null,
    latestValue: null,
    latestPeriod: null,
    points: [],
    methodology: 'unavailable',
    coverage: {
      observedDays: 0,
      expectedDays: 30,
      missingDays: observations,
      status: 'unavailable',
      qualities: [],
    },
    comparison: {
      previousValue: null,
      absoluteChange: null,
      relativeChange: null,
      reason: 'No baseline',
      kind: null,
      baselinePeriod: null,
    },
  });
}
function report(id: string, cards: MetricCard[], description = ''): ProjectReport {
  const base: Omit<ProjectReport, 'evidence'> = {
    schemaVersion: 1,
    project: { id, label: id, description },
    window,
    generatedAt: '2026-10-01T00:00:00Z',
    demo: true,
    cards,
    breakdowns: [],
    annotations: [],
    inspections: [],
    warnings: [],
  };
  return { ...base, evidence: assessEvidence(base) };
}
function snapshot(reports: ProjectReport[]) {
  return {
    schemaVersion: 1 as const,
    name: 'Synthetic owner portfolio',
    demo: true,
    window,
    generatedAt: '2026-10-01T00:00:00Z',
    reports,
    warning: 'Never add people across projects.',
  };
}

test('review surfaces a supported change buried under more than 20 coverage leads', () => {
  const gaps = Array.from({ length: 27 }, (_, index) =>
    unavailable('r' + String(index).padStart(2, '0')),
  );
  const r = report('project', [...gaps, card('reviewed-package')]);
  const clipped = projectBrief(r);
  assert.ok(clipped.findings.every((f) => f.kind === 'coverage'));
  const before = structuredClone(r);
  const result = ownerReview(snapshot([r]));
  assert.deepEqual(r, before, 'review must not modify report data');
  assert.deepEqual(result, ownerReview(snapshot([r])), 'same evidence always has the same agenda');
  const p = result.projects[0]!;
  assert.equal(p.counts.qualify, 27);
  assert.equal(p.counts.change, 1);
  assert.equal(p.focus.find((f) => f.lane === 'change')?.lead.reason, 'change.period');
  assert.match(
    p.focus.find((f) => f.lane === 'change')!.lead.summary,
    /increased by 300 downloads/,
  );
  assert.deepEqual(
    p.focus.map((f) => f.lane),
    ['change', 'qualify'],
  );
  assert.equal(result.totals.withSupportedChange, 1);
  assert.equal(result.totals.withEvidenceLimits, 1);
  assert.match(markdownReview(result), /## project/);
  assert.match(markdownReview(result), /Missing evidence is not zero/);
  assert.ok(!markdownReview(result).includes('300 new users'));
});

test('changes with sampled or missing dates are not promoted to supported comparisons', () => {
  const partial = card('partial', {
    coverage: {
      observedDays: 29,
      expectedDays: 30,
      missingDays: [window.to],
      status: 'partial',
      qualities: ['observed'],
    },
    points: observations.slice(0, -1).map((date) => ({
      date,
      from: date,
      to: date,
      value: 20,
      quality: 'observed',
    })),
  });
  const sampled = card('sampled', {
    coverage: {
      observedDays: 30,
      expectedDays: 30,
      missingDays: [],
      status: 'complete',
      qualities: ['sampled'],
    },
  });
  const result = ownerReview(snapshot([report('unknown', [partial, sampled])]));
  assert.equal(result.projects[0]?.counts.change, 0);
  assert.ok((result.projects[0]?.counts.qualify ?? 0) >= 1);
  assert.equal(result.projects[0]?.focus[0]?.lane, 'qualify');
});

test('interpretation signals and changes use different lanes, without magnitude rankings', () => {
  const concentrated = card('concentrated', {
    value: 700,
    points: observations.map((date, index) => ({
      date,
      from: date,
      to: date,
      value: index >= 10 && index < 17 ? 100 : 0,
      quality: 'observed',
    })),
    comparison: {
      previousValue: null,
      absoluteChange: null,
      relativeChange: null,
      reason: 'No previous period.',
      kind: null,
      baselinePeriod: null,
    },
  });
  const data = ownerReview(
    snapshot([
      report('one', [concentrated, card('downloads')]),
      report('two', [unavailable('missing')]),
    ]),
  );
  assert.equal(data.totals.projects, 2);
  assert.equal(data.totals.withInvestigation, 1);
  assert.equal(data.totals.withSupportedChange, 1);
  assert.equal(data.totals.withEvidenceLimits, 2); // First project also lacks a prior comparable baseline.
  assert.equal(data.projects[0]?.focus[0]?.lane, 'investigate');
  assert.equal(data.projects[0]?.focus[0]?.lead.reason, 'concentration.activity_window');
  assert.match(data.projects[0]!.focus[0]!.lead.summary, /cause is not established/);
  assert.equal(data.projects[0]!.focus[1]?.lane, 'change');
  assert.ok(data.projects[0]!.focus[0]!.lead.nextChecks.length);
  assert.ok(!JSON.stringify(data).includes('independent adopters: 700'));
});

test('large evidence portfolios disclose leads beyond the 100-per-project inspection ceiling', () => {
  const gaps = Array.from({ length: 112 }, (_, index) =>
    unavailable('gap' + String(index).padStart(3, '0')),
  );
  const result = ownerReview(snapshot([report('many', gaps)]));
  const p = result.projects[0]!;
  assert.equal(p.counts.qualify, 100);
  assert.equal(p.omittedLeads, 12);
  assert.equal(result.totals.omittedLeads, 12);
  assert.match(markdownReview(result), /12 additional leads beyond/);
});

test('review of a real Store portfolio does not collect or alter published history', async () => {
  const config = fixture('npm');
  const store = await database(config);
  try {
    const before = await store.runs();
    const source = await portfolio(config, store, window, now);
    const review = ownerReview(source);
    assert.equal(review.demo, false);
    assert.equal(review.projects.length, 1);
    assert.equal(review.projects[0]?.project.id, 'project');
    assert.ok(review.projects[0]!.focus.length);
    assert.deepEqual(await store.runs(), before);
  } finally {
    store.driver.close?.();
  }
});
