import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidence } from '../src/evidence.js';
import {
  INVESTIGATION_LIMITS,
  INVESTIGATION_REASONS,
  investigateProject,
  type InvestigationFinding,
} from '../src/investigations.js';
import { projectBrief, markdownBrief } from '../src/brief.js';
import { projectGraph } from '../src/project-graph.js';
import { type MetricCard, type ProjectReport, projectReport } from '../src/report.js';
import { evidenceDemoConfig, seedDemo } from '../src/demo.js';
import { collected, entry } from '../src/collectors/context.js';
import type { Observation } from '../src/model.js';
import type { Config } from '../src/config.js';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import { days, reportRange } from '../src/time.js';
import { database, fixture, now, window as shortWindow } from './helpers.js';

const window = { from: '2026-09-01', to: '2026-09-30' };
const prior = { from: '2026-08-02', to: '2026-08-31' };
function card(patch: Partial<MetricCard> = {}): MetricCard {
  const points = days(window).map((date) => ({
    date,
    from: date,
    to: date,
    value: 10,
    quality: 'observed' as const,
  }));
  const base: MetricCard = {
    key: '',
    resourceId: 'example',
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
    value: 300,
    latestValue: 10,
    latestPeriod: { from: window.to, to: window.to },
    points,
    coverage: {
      observedDays: 30,
      expectedDays: 30,
      missingDays: [],
      status: 'complete',
      qualities: ['observed'],
    },
    caveat: 'Not unique users.',
    comparison: {
      previousValue: null,
      absoluteChange: null,
      relativeChange: null,
      reason: 'Insufficient comparable coverage or changed mapping duration.',
      kind: null,
      baselinePeriod: null,
    },
    ...patch,
  };
  return {
    ...base,
    key: patch.key ?? JSON.stringify([base.resourceId, base.metric, '{}', base.methodology]),
  };
}
/** Thirty observed daily counts that sum exactly to `total`. */
const spread = (total: number, range = window) =>
  days(range).map((date, i, all) => ({
    date,
    from: date,
    to: date,
    value: Math.floor(total / all.length) + (i < total % all.length ? 1 : 0),
    quality: 'observed' as const,
  }));
const unavailable = (patch: Partial<MetricCard> = {}) =>
  card({
    value: null,
    latestValue: null,
    latestPeriod: null,
    points: [],
    methodology: 'unavailable',
    coverage: {
      observedDays: 0,
      expectedDays: 30,
      missingDays: days(window),
      status: 'unavailable',
      qualities: [],
    },
    ...patch,
  });
const changed = (previousValue: number, value: number, patch: Partial<MetricCard> = {}) =>
  card({
    value,
    points: spread(value),
    comparison: {
      previousValue,
      absoluteChange: value - previousValue,
      relativeChange: previousValue >= 10 ? (value - previousValue) / previousValue : null,
      reason: 'Synthetic fixture.',
      kind: 'period_change',
      baselinePeriod: prior,
    },
    ...patch,
  });
function report(cards: MetricCard[], extra: Partial<Omit<ProjectReport, 'evidence'>> = {}) {
  const base: Omit<ProjectReport, 'evidence'> = {
    schemaVersion: 1,
    project: { id: 'project', label: 'Example', description: '' },
    window,
    generatedAt: '2026-10-01T00:00:00.000Z',
    demo: false,
    cards,
    breakdowns: [],
    annotations: [],
    inspections: [],
    warnings: [],
    ...extra,
  };
  return { ...base, evidence: assessEvidence(base) } satisfies ProjectReport;
}
const reasons = (findings: InvestigationFinding[]) => findings.map((f) => f.reason);
async function put(
  store: Store,
  config: Config,
  group: string,
  rows: Observation[],
  from: string,
  to: string,
) {
  const resource = config.resources[0]!,
    key = `${resource.id}:${group}`,
    owner = crypto.randomUUID();
  assert.equal(await store.acquire(key, owner), true);
  const id = await store.begin(resource, group, { from, to }, now);
  try {
    await store.publish(
      id,
      resource,
      group,
      collected({ from, to }, rows),
      key,
      owner,
      1,
      now,
      1000,
    );
  } finally {
    await store.release(key, owner);
  }
}

test('leads are deterministic and put evidence barriers before observed changes', () => {
  const cards = [
    changed(100, 140, { resourceId: 'zeta', metric: 'npm.downloads' }),
    unavailable({ resourceId: 'beta', metric: 'github.views' }),
    card({ resourceId: 'alpha' }),
    card({
      resourceId: 'beta',
      metric: 'github.clones',
      coverage: {
        observedDays: 29,
        expectedDays: 30,
        missingDays: ['2026-09-07'],
        status: 'partial',
        qualities: ['observed'],
      },
    }),
    card({
      resourceId: 'gamma',
      coverage: {
        observedDays: 30,
        expectedDays: 30,
        missingDays: [],
        status: 'complete',
        qualities: ['observed', 'sampled'],
      },
    }),
  ];
  const forward = investigateProject(report(cards));
  assert.deepEqual(investigateProject(report([...cards].reverse())), forward);
  assert.deepEqual(investigateProject(report(cards)), forward);
  assert.deepEqual(reasons(forward.findings), [
    'coverage.series_unavailable',
    'coverage.dates_missing',
    'quality.values_not_final',
    'change.period',
    'comparison.baseline_unavailable',
  ]);
  const rank = forward.findings.map((f) => INVESTIGATION_REASONS.indexOf(f.reason));
  assert.deepEqual(
    rank,
    [...rank].sort((a, b) => a - b),
  );
  assert.equal(new Set(forward.findings.map((f) => f.id)).size, forward.findings.length);
  assert.equal(forward.schemaVersion, 1);
  assert.match(forward.limitation, /no cause, forecast, score or audience estimate/);
  // No ranking number, confidence or adoption score is attached to a lead.
  for (const finding of forward.findings)
    assert.deepEqual(
      Object.keys(finding).filter((key) => /score|confidence|priority|rank|severity/i.test(key)),
      [],
    );
});

test('unavailable evidence stays unavailable and is never reported as zero', async () => {
  const config = fixture(),
    store = await database(config);
  try {
    const real = await projectReport(config, store, 'project', shortWindow, now);
    const before = structuredClone(real);
    const result = investigateProject(real);
    assert.deepEqual(real, before, 'the report is read, never adjusted');
    assert.deepEqual([...new Set(reasons(result.findings))], ['coverage.series_unavailable']);
    const lead = result.findings[0]!;
    assert.equal(lead.evidenceState, 'unavailable');
    assert.match(lead.summary, /unavailable, not zero/);
    assert.ok(lead.evidence.length > 0);
    for (const ref of lead.evidence) {
      assert.equal(ref.facts.value, null);
      assert.equal(ref.facts.observedDays, 0);
      assert.deepEqual(ref.window, shortWindow);
      assert.ok(real.cards.some((c) => c.key === ref.seriesKey));
    }
    assert.deepEqual(
      lead.nextChecks.map((step) => step.id),
      ['health.latest_refresh', 'plan.window_coverage', 'config.binding_dates'],
    );
  } finally {
    store.driver.close?.();
  }
  const empty = investigateProject(report([]));
  assert.deepEqual(empty.findings, []);
  assert.equal(empty.omittedFindings, 0);
});

test('partial series keep their observed subtotal and a bounded list of missing dates', () => {
  const missing = days(window).slice(3, 15);
  const partial = card({
    value: 180,
    coverage: {
      observedDays: 18,
      expectedDays: 30,
      missingDays: missing,
      status: 'partial',
      qualities: ['observed'],
    },
  });
  // A snapshot observed on some days is not a daily coverage gap.
  const snapshot = card({
    metric: 'github.stars',
    aggregation: 'latest',
    value: 40,
    coverage: { ...partial.coverage, missingDays: missing },
  });
  const result = investigateProject(report([partial, snapshot]));
  const lead = result.findings.find((f) => f.reason === 'coverage.dates_missing')!;
  assert.equal(lead.evidenceState, 'partial');
  assert.equal(lead.evidence.length, 1);
  const facts = lead.evidence[0]!.facts;
  assert.equal(facts.observedSubtotal, 180);
  assert.equal(facts.missingDays, 12);
  assert.equal(facts.firstMissing, '2026-09-04');
  assert.equal(facts.lastMissing, '2026-09-15');
  assert.equal(String(facts.missingDates).split(',').length, INVESTIGATION_LIMITS.missingDates);
  assert.match(lead.summary, /not full-period totals/);
  assert.ok(!reasons(result.findings).includes('change.period'));
  // The partial series is not also offered as a missing baseline.
  assert.ok(!reasons(result.findings).includes('comparison.baseline_unavailable'));
  const baseline = result.findings.find(
    (f) => f.reason === 'comparison.snapshot_baseline_unavailable',
  )!;
  assert.deepEqual(
    baseline.evidence.map((ref) => ref.metric),
    ['github.stars'],
  );
});

test('a snapshot without history is never sent to a collection plan', async () => {
  const stars = card({
    metric: 'github.stars',
    label: 'Stars',
    unit: 'stars',
    aggregation: 'latest',
    value: 12,
  });
  const result = investigateProject(
    report([
      stars,
      card(),
      unavailable({ metric: 'github.forks', aggregation: 'latest' }),
      unavailable({ metric: 'github.open_issues', aggregation: 'latest' }),
    ]),
  );
  assert.deepEqual(reasons(result.findings), [
    'coverage.series_unavailable',
    'comparison.baseline_unavailable',
    'comparison.snapshot_baseline_unavailable',
  ]);
  const [missing, dated, snapshots] = result.findings;
  // Only snapshots are missing: no plan check, and the limit says why.
  assert.deepEqual(
    missing!.nextChecks.map((step) => step.id),
    ['health.latest_refresh', 'config.binding_dates'],
  );
  assert.match(missing!.limitations.join(' '), /cannot be collected afterwards/);
  // A dated series keeps the plan for the preceding period.
  assert.deepEqual(
    dated!.evidence.map((ref) => ref.metric),
    ['npm.downloads'],
  );
  assert.deepEqual(
    dated!.nextChecks.map((step) => [step.id, step.window]),
    [
      ['report.next_complete_window', window],
      ['plan.window_coverage', prior],
      ['config.binding_dates', prior],
    ],
  );
  assert.ok(!/snapshot/.test(dated!.limitations.join(' ')));
  assert.deepEqual(
    snapshots!.evidence.map((ref) => [ref.metric, ref.facts.currentValue]),
    [['github.stars', 12]],
  );
  assert.deepEqual(
    snapshots!.nextChecks.map((step) => step.id),
    ['health.latest_refresh', 'report.next_complete_window'],
  );
  assert.match(snapshots!.summary, /current snapshot .* no supported net change/);
  assert.match(snapshots!.limitations.join(' '), /cannot be collected afterwards/);
  assert.match(snapshots!.limitations.join(' '), /not a baseline of zero/);
  // A mix of missing dated and snapshot series keeps the plan and adds the snapshot limit.
  const mixed = investigateProject(
    report([unavailable(), unavailable({ metric: 'github.forks', aggregation: 'latest' })]),
  ).findings[0]!;
  assert.deepEqual(
    mixed.nextChecks.map((step) => step.id),
    ['health.latest_refresh', 'plan.window_coverage', 'config.binding_dates'],
  );
  assert.match(mixed.limitations.join(' '), /cannot be collected afterwards/);

  // End to end: one stored snapshot and nothing earlier.
  const config = fixture('github', { groups: ['repository'] }),
    store = await database(config);
  try {
    await put(
      store,
      config,
      'repository',
      [{ ...entry('github.stars', '2026-10-13', 12), kind: 'snapshot' }],
      '2026-10-13',
      '2026-10-13',
    );
    const real = await projectReport(config, store, 'project', shortWindow, now);
    for (const finding of real.investigation!.findings)
      assert.ok(
        !finding.nextChecks.some((step) => step.id === 'plan.window_coverage'),
        finding.reason,
      );
    assert.ok(
      real.investigation!.findings.some(
        (f) => f.reason === 'comparison.snapshot_baseline_unavailable',
      ),
    );
  } finally {
    store.driver.close?.();
  }
});

test('a disabled resource is named before any collection check', async () => {
  const config = fixture('github', { groups: ['views'], enabled: false }),
    store = await database(config);
  try {
    const real = await projectReport(config, store, 'project', shortWindow, now);
    assert.match(real.warnings.join(' '), /collection is disabled/);
    const lead = real.investigation!.findings[0]!;
    assert.equal(lead.reason, 'coverage.series_unavailable');
    assert.equal(lead.subject?.enabled, false);
    assert.equal(lead.nextChecks[0]!.id, 'config.collection_enabled');
    assert.equal(lead.nextChecks[0]!.surface, 'configuration');
    assert.equal(lead.nextChecks.length, INVESTIGATION_LIMITS.nextChecks);
    assert.match(lead.limitations[0]!, /disabled in configuration/);
    assert.ok(lead.limitations.length <= INVESTIGATION_LIMITS.limitations);
    // The briefing, which the CLI and API return, says the same.
    const brief = projectBrief(real, 20, real.resources);
    assert.deepEqual(brief.investigation, real.investigation);
    assert.match(markdownBrief(brief), /Limit: Collection for this resource is disabled/);
    // Without the map the lead is unchanged: nothing is guessed about configuration.
    const plain = investigateProject(real).findings[0]!;
    assert.equal(plain.subject, undefined);
    assert.equal(plain.nextChecks[0]!.id, 'health.latest_refresh');
    assert.equal(plain.id, lead.id);
  } finally {
    store.driver.close?.();
  }
  // An enabled resource gains neither the limit nor the check.
  const enabled = fixture('github', { groups: ['views'] }),
    other = await database(enabled);
  try {
    const real = await projectReport(enabled, other, 'project', shortWindow, now);
    const lead = real.investigation!.findings[0]!;
    assert.equal(lead.subject?.enabled, true);
    assert.ok(!lead.nextChecks.some((step) => step.id === 'config.collection_enabled'));
    assert.ok(!/disabled/.test(lead.limitations.join(' ')));
  } finally {
    other.driver.close?.();
  }
});

test('a mapping boundary narrows the dates a lead describes', () => {
  const scoped = unavailable({ scope: { effectiveFrom: '2026-09-10', effectiveTo: '2026-09-20' } });
  const lead = investigateProject(report([scoped])).findings[0]!;
  assert.deepEqual(lead.evidence[0]!.window, { from: '2026-09-10', to: '2026-09-20' });
});

test('tiny baselines report an absolute change only, and a first period is a baseline', async () => {
  const small = investigateProject(report([changed(3, 12)])).findings;
  assert.deepEqual(reasons(small), ['change.small_baseline']);
  assert.equal(small[0]!.evidenceState, 'limited');
  assert.match(small[0]!.summary, /increased by 9 downloads/);
  assert.match(small[0]!.summary, /no percentage is stated/);
  assert.ok(!small[0]!.summary.includes('%'));
  const current = small[0]!.evidence.find((ref) => ref.facts.role === 'current')!;
  const earlier = small[0]!.evidence.find((ref) => ref.facts.role === 'baseline')!;
  assert.equal(current.facts.value, 12);
  assert.equal(current.facts.absoluteChange, 9);
  assert.equal(current.facts.relativeChange, null);
  assert.equal(earlier.facts.value, 3);
  assert.deepEqual(earlier.window, prior);

  const supported = investigateProject(report([changed(100, 60)])).findings;
  assert.deepEqual(reasons(supported), ['change.period']);
  assert.ok(!supported[0]!.nextChecks.some((step) => step.id === 'report.recorded_context'));
  const annotated = investigateProject(
    report([changed(100, 60)], {
      annotations: [
        { id: 'a', resourceId: 'example', date: '2026-09-12', title: 'v2', kind: 'release' },
        { id: 'b', resourceId: 'example', date: '2026-08-12', title: 'v1', kind: 'release' },
      ],
    }),
  ).findings[0]!;
  assert.equal(
    annotated.evidence.find((r) => r.facts.role === 'current')!.facts.recordedAnnotationsInWindow,
    1,
  );
  assert.equal(annotated.nextChecks[1]!.id, 'report.recorded_context');
  assert.ok(!annotated.summary.includes('v2'));
  assert.match(supported[0]!.summary, /decreased by 40 downloads/);
  assert.equal(
    supported[0]!.evidence.find((r) => r.facts.role === 'current')!.facts.relativeChange,
    -0.4,
  );

  // Zero or unsupported changes produce no change lead and no invented baseline.
  assert.deepEqual(reasons(investigateProject(report([changed(50, 50)])).findings), []);
  const first = investigateProject(report([card()])).findings;
  assert.deepEqual(reasons(first), ['comparison.baseline_unavailable']);
  assert.equal(first[0]!.evidence[0]!.facts.currentValue, 300);
  assert.match(first[0]!.summary, /baseline, not a trend/);
  assert.match(first[0]!.limitations[0]!, /not a baseline of zero/);
  assert.deepEqual(first[0]!.nextChecks[1]!.window, prior);

  // The same rule holds end to end through the store and report.
  const config = fixture('github', { groups: ['views'] }),
    store = await database(config);
  try {
    await put(
      store,
      config,
      'views',
      [
        entry('github.views', '2026-10-10', 2),
        entry('github.views', '2026-10-11', 3),
        entry('github.views', '2026-10-12', 8),
        entry('github.views', '2026-10-13', 12),
      ],
      '2026-10-10',
      '2026-10-13',
    );
    const real = await projectReport(config, store, 'project', shortWindow, now);
    const lead = investigateProject(real).findings.find((f) => f.category === 'change')!;
    assert.equal(lead.reason, 'change.small_baseline');
    assert.equal(lead.evidence.find((r) => r.facts.role === 'current')!.facts.absoluteChange, 15);
    assert.equal(lead.evidence.find((r) => r.facts.role === 'baseline')!.facts.value, 5);
  } finally {
    store.driver.close?.();
  }
});

test('a stale comparison on a sampled, partial or inconsistent series is not restated', () => {
  const sound = changed(100, 140);
  assert.deepEqual(reasons(investigateProject(report([sound])).findings), ['change.period']);
  assert.equal(projectBrief(report([sound])).findings[0]!.kind, 'change');
  const points = sound.points;
  const stale: [string, Partial<MetricCard>][] = [
    ['sampled quality', { coverage: { ...sound.coverage, qualities: ['observed', 'sampled'] } }],
    ['a sampled point', { points: points.map((p, i) => (i ? p : { ...p, quality: 'sampled' })) }],
    [
      'a missing date',
      {
        coverage: {
          ...sound.coverage,
          observedDays: 29,
          missingDays: ['2026-09-30'],
          status: 'partial',
        },
        points: points.slice(0, 29),
      },
    ],
    ['a mapping boundary', { coverage: { ...sound.coverage, observedDays: 20, expectedDays: 20 } }],
    ['a total unlike its days', { points: spread(139) }],
    ['a change unlike its values', { comparison: { ...sound.comparison, absoluteChange: 41 } }],
    [
      'a multi-day bucket',
      { points: points.map((p, i) => (i ? p : { ...p, from: '2026-08-31' })) },
    ],
    [
      'a fractional count',
      { points: points.map((p, i) => (i > 1 ? p : { ...p, value: p.value + (i ? -0.5 : 0.5) })) },
    ],
    ['a snapshot rule on a count', { comparison: { ...sound.comparison, kind: 'net_change' } }],
  ];
  for (const [name, patch] of stale) {
    const input = report([{ ...sound, ...patch }]);
    const leads = investigateProject(input).findings;
    assert.ok(!leads.some((f) => f.category === 'change'), name);
    assert.ok(!leads.some((f) => /increased|decreased/.test(f.summary)), name);
    const brief = projectBrief(input);
    assert.ok(!brief.findings.some((f) => f.kind === 'change'), name);
    assert.ok(
      brief.findings.some((f) => f.kind === 'baseline'),
      name,
    );
    assert.doesNotMatch(markdownBrief(brief), /increased by|decreased by/, name);
  }
  // Ratios and snapshots are not daily counts and keep the report's own comparison rules.
  const ratio = card({
    metric: 'gsc.ctr',
    label: 'Click-through rate',
    unit: 'ratio',
    aggregation: 'ratio',
    value: 0.25,
    comparison: {
      previousValue: 0.125,
      absoluteChange: 0.125,
      relativeChange: null,
      reason: 'Synthetic fixture.',
      kind: 'period_change',
      baselinePeriod: prior,
    },
  });
  const kept = investigateProject(report([ratio])).findings;
  assert.deepEqual(reasons(kept), ['change.period']);
  assert.ok(!kept[0]!.summary.includes('%'));
  assert.ok(
    !investigateProject(
      report([{ ...ratio, coverage: { ...ratio.coverage, status: 'partial' } }]),
    ).findings.some((f) => f.category === 'change'),
  );
});

test('snapshot changes are net differences between dated snapshots', () => {
  const stars = card({
    metric: 'github.stars',
    label: 'Stars',
    unit: 'stars',
    aggregation: 'latest',
    value: 12,
    latestPeriod: { from: '2026-09-29', to: '2026-09-29' },
    comparison: {
      previousValue: 15,
      absoluteChange: -3,
      relativeChange: null,
      reason: 'Synthetic fixture.',
      kind: 'net_change',
      baselinePeriod: { from: '2026-08-30', to: '2026-08-30' },
    },
  });
  const lead = investigateProject(report([stars])).findings[0]!;
  assert.equal(lead.reason, 'change.snapshot_net');
  assert.match(
    lead.summary,
    /decreased by 3 stars net between the snapshots dated 2026-08-30 and 2026-09-29/,
  );
  assert.match(lead.limitations[0]!, /not gross additions or removals/);
  assert.deepEqual(lead.limitations.slice(1), ['Not unique users.']);
  const plain = investigateProject(report([{ ...stars, caveat: '' }])).findings[0]!;
  assert.equal(plain.limitations.length, 1);
  assert.deepEqual(lead.nextChecks[0]!.window, { from: '2026-08-30', to: '2026-09-29' });
});

test('every list is bounded and the omitted remainder is counted', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    unavailable({ metric: `synthetic.metric_${String(i).padStart(2, '0')}` }),
  );
  const crowded = investigateProject(report(many)).findings[0]!;
  assert.equal(crowded.evidence.length, INVESTIGATION_LIMITS.evidence);
  assert.equal(crowded.omittedEvidence, 30 - INVESTIGATION_LIMITS.evidence);
  assert.match(crowded.summary, /30 metric series have/);

  const wide = report(
    Array.from({ length: 40 }, (_, i) =>
      unavailable({ resourceId: `source_${String(i).padStart(2, '0')}` }),
    ),
  );
  const capped = investigateProject(wide, 5);
  assert.equal(capped.findings.length, 5);
  assert.equal(capped.omittedFindings, 35);
  assert.deepEqual(
    capped.findings.map((f) => f.resourceId),
    ['source_00', 'source_01', 'source_02', 'source_03', 'source_04'],
  );
  assert.equal(investigateProject(wide).findings.length, 20);
  for (const maximum of [0, 101, 1.5, Number.NaN])
    assert.throws(() => investigateProject(wide, maximum), RangeError);

  const everything = investigateProject(
    report([changed(3, 12, { caveat: 'c'.repeat(2000) }), ...many]),
    100,
  );
  for (const finding of everything.findings) {
    assert.ok(finding.summary.length <= 480);
    assert.ok(finding.evidence.length <= INVESTIGATION_LIMITS.evidence);
    assert.ok(finding.limitations.length <= INVESTIGATION_LIMITS.limitations);
    assert.ok(finding.limitations.every((text) => text.length <= 320));
    assert.ok(finding.nextChecks.length >= 1);
    assert.ok(finding.nextChecks.length <= INVESTIGATION_LIMITS.nextChecks);
  }
});

test('concentration leads link the peak dates and count recorded context without crediting it', () => {
  const spike = card({
    value: 723,
    points: days(window).map((date, i) => ({
      date,
      from: date,
      to: date,
      value: i >= 10 && i < 17 ? 100 : 1,
      quality: 'observed' as const,
    })),
  });
  const input = report([spike], {
    annotations: [
      { id: 'a', resourceId: 'example', date: '2026-09-12', title: 'v1.0.0', kind: 'release' },
      { id: 'b', resourceId: 'example', date: '2026-09-29', title: 'v1.0.1', kind: 'release' },
      { id: 'c', resourceId: 'other', date: '2026-09-12', title: 'v9', kind: 'release' },
    ],
  });
  assert.equal(input.evidence.signals[0]!.code, 'concentrated_activity');
  const lead = investigateProject(input).findings.find(
    (f) => f.reason === 'concentration.activity_window',
  )!;
  assert.deepEqual(lead.evidence[0]!.window, { from: '2026-09-11', to: '2026-09-17' });
  assert.equal(lead.evidence[0]!.seriesKey, spike.key);
  assert.equal(lead.evidence[0]!.facts.peakSevenDayTotal, 700);
  assert.equal(lead.evidence[0]!.facts.periodTotal, 723);
  assert.equal(lead.evidence[0]!.facts.recordedAnnotationsInPeak, 1);
  assert.match(lead.summary, /700 of 723/);
  assert.match(lead.summary, /cause is not established/);
  assert.ok(!lead.summary.includes('v1.0.0'));
  assert.match(lead.limitations.join(' '), /context only/);
  assert.deepEqual(
    lead.nextChecks.map((step) => [step.id, step.window]),
    [
      ['report.daily_points', window],
      ['report.recorded_context', { from: '2026-09-11', to: '2026-09-17' }],
      ['provider.same_window', { from: '2026-09-11', to: '2026-09-17' }],
    ],
  );
  assert.equal(input.cards[0]!.value, 723, 'raw counts are unchanged');
  // With no annotation in the peak there is no context to read and none is suggested.
  const bare = investigateProject(report([spike])).findings.find(
    (f) => f.reason === 'concentration.activity_window',
  )!;
  assert.equal(bare.evidence[0]!.facts.recordedAnnotationsInPeak, 0);
  assert.ok(!bare.nextChecks.some((step) => step.id === 'report.recorded_context'));
  assert.ok(!/annotation/.test(bare.limitations.join(' ')));
  assert.equal(bare.id, lead.id);
});

test('referrer leads keep provider text out of prose and bound it as evidence', () => {
  const hostile = '<script>alert(1)</script>\n[x](https://evil.example)' + 'r'.repeat(400);
  const input = report([], {
    breakdowns: [
      {
        resourceId: 'site',
        group: 'referrers',
        metric: 'cloudflare.pageviews',
        period: { from: '2026-09-02', to: '2026-09-02' },
        dimensions: { referrer: hostile },
        value: 90,
        quality: 'observed',
      },
      {
        resourceId: 'site',
        group: 'referrers',
        metric: 'cloudflare.pageviews',
        period: { from: '2026-09-02', to: '2026-09-02' },
        dimensions: { referrer: '' },
        value: 10,
        quality: 'observed',
      },
    ],
  });
  const result = investigateProject(input);
  assert.deepEqual(reasons(result.findings), [
    'attribution.site_referrer_rows_concentrated',
    'attribution.referrer_missing',
  ]);
  const [concentrated, missing] = result.findings;
  assert.equal(concentrated!.evidence[0]!.facts.referrerCount, 90);
  assert.equal(concentrated!.evidence[0]!.facts.listedCount, 100);
  const referrer = String(concentrated!.evidence[0]!.facts.referrer);
  assert.equal(referrer.length, 120);
  assert.ok(!/[\u0000-\u001f]/.test(referrer));
  assert.match(missing!.summary, /10 of 100 pageviews/);
  assert.equal(missing!.evidenceState, 'observed');
  for (const finding of result.findings) {
    assert.ok(!finding.summary.includes('script'));
    assert.ok(!finding.summary.includes('evil'));
    assert.ok(finding.nextChecks.every((step) => !step.text.includes('evil')));
  }
  const brief = projectBrief(input);
  const markdown = markdownBrief(brief);
  assert.ok(!markdown.includes('<script>'));
  assert.ok(!markdown.includes('[x]('));
  // An unquantified warning stays unquantified.
  const sampled = report([], {
    breakdowns: [{ ...input.breakdowns[1]!, quality: 'sampled' }],
  });
  const vague = investigateProject(sampled).findings[0]!;
  assert.equal(vague.evidenceState, 'limited');
  assert.equal(vague.evidence[0]!.facts.unattributedPageviews, null);
  assert.match(vague.summary, /reliable subtotal is unavailable/);
});

test('malformed signals and comparisons are labelled unavailable, never restated as zero', () => {
  for (const broken of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '700']) {
    const input = report([card()]);
    const signal = (code: string, evidence: Record<string, unknown>) =>
      ({ code, resourceId: 'example', metric: 'npm.downloads', message: '', evidence }) as never;
    input.evidence.signals = [
      signal('concentrated_activity', {
        periodTotal: broken,
        peakSevenDayTotal: 700,
        peakFrom: 'not-a-date',
        peakTo: '2026-09-17',
      }),
      signal('concentrated_referrers', { referrerViews: 12, listedViews: broken }),
      signal('concentrated_site_referrers', { referrerPageviews: broken, listedPageviews: 12 }),
      signal('unattributed_referrer', { unattributedPageviews: broken, listedPageviews: 12 }),
      signal('future_signal<script>', {}),
    ];
    const leads = investigateProject(input).findings.filter((f) =>
      ['concentration', 'attribution', 'interpretation'].includes(f.category),
    );
    assert.equal(leads.length, 5);
    for (const lead of leads) {
      assert.equal(lead.evidenceState, 'limited', lead.reason);
      assert.ok(!/\b0\b|NaN|Infinity|undefined|null|[<>]/.test(lead.summary), lead.summary);
      for (const [name, value] of Object.entries(lead.evidence[0]!.facts))
        if (name !== 'recordedAnnotationsInPeak') assert.notEqual(value, 0, name);
      assert.deepEqual(
        lead.evidence[0]!.window,
        window,
        'an invalid peak falls back to no narrower claim',
      );
    }
    assert.match(leads[0]!.summary, /no usable counts/);
    assert.equal(leads[0]!.evidence[0]!.facts.periodTotal, null);
    assert.equal(leads[0]!.evidence[0]!.facts.peakSevenDayTotal, 700);
    assert.equal(leads.at(-1)!.reason, 'interpretation.review_signal');
    assert.equal(leads.at(-1)!.evidence[0]!.facts.signal, 'future_signalscript');

    // A change without both of its values or its baseline dates is not restated at all.
    const half = changed(100, 140);
    for (const patch of [
      { value: broken as never },
      { comparison: { ...half.comparison, previousValue: broken as never } },
      { comparison: { ...half.comparison, absoluteChange: broken as never } },
      { comparison: { ...half.comparison, baselinePeriod: null } },
    ])
      assert.ok(
        !investigateProject(report([{ ...half, ...patch }])).findings.some(
          (f) => f.category === 'change',
        ),
      );
  }
});

test('next checks are a closed catalogue of places to look, not commands, links or advice', () => {
  const cards = [
    unavailable({ resourceId: 'a' }),
    changed(3, 12, { resourceId: 'b' }),
    changed(100, 140, { resourceId: 'c' }),
    card({ resourceId: 'd' }),
    card({
      resourceId: 'e',
      coverage: {
        observedDays: 30,
        expectedDays: 30,
        missingDays: [],
        status: 'complete',
        qualities: ['provisional'],
      },
    }),
  ];
  const result = investigateProject(report(cards), 100);
  const surfaces = [
    'pulse_health',
    'pulse_plan',
    'pulse_report',
    'provider_console',
    'configuration',
  ];
  for (const finding of result.findings) {
    assert.ok((INVESTIGATION_REASONS as readonly string[]).includes(finding.reason));
    assert.equal(finding.id.startsWith(finding.reason + ':' + finding.resourceId), true);
    assert.ok(
      !/\b(caused by|due to|driven by|thanks to|bots?|humans?|users?|adopters?|should|recommend|grow|improve|optimi[sz]e)\b/i.test(
        finding.summary,
      ),
      finding.summary,
    );
    for (const step of finding.nextChecks) {
      assert.ok(surfaces.includes(step.surface));
      assert.match(step.id, /^[a-z]+\.[a-z_]+$/);
      assert.ok(
        !/https?:|www\.|`|\$\(|--[a-z]|\bnpm\b|\bnode\b|\bcurl\b|&&|[|<>]/.test(step.text),
        step.text,
      );
      assert.ok(
        !/\b(market|promote|campaign|post|announce|seo|audience|convert)\b/i.test(step.text),
        step.text,
      );
    }
  }
  const provisional = result.findings.find((f) => f.reason === 'quality.values_not_final')!;
  assert.equal(provisional.nextChecks[0]!.id, 'report.after_finalization');
});

test('lead IDs are stable across periods and values for the same series', () => {
  const first = investigateProject(report([changed(100, 140)])).findings[0]!;
  const next = { from: '2026-10-01', to: '2026-10-30' };
  const later = investigateProject({
    ...report([changed(140, 90, { points: spread(90, next) })]),
    window: next,
  }).findings[0]!;
  assert.equal(first.id, later.id);
  assert.match(first.id, /^change\.period:example:[0-9a-f]{8}$/);
  const other = investigateProject(report([changed(100, 140, { methodology: 'synthetic-v2' })]))
    .findings[0]!;
  assert.notEqual(first.id, other.id);
});

test('website leads restate declared-source status and never substitute or combine sources', () => {
  const alternatives = [
    {
      source: 'cf',
      provider: 'cloudflare',
      metric: 'cloudflare.pageviews',
      observedValue: 120,
      coverage: 'partial' as const,
      timezone: 'UTC',
    },
    {
      source: 'um',
      provider: 'umami',
      metric: 'umami.pageviews',
      observedValue: 300,
      coverage: 'complete' as const,
      timezone: 'UTC',
    },
  ];
  const site = {
    id: 'main_site',
    hostname: 'example.org',
    metric: null,
    value: null,
    effectiveFrom: '2026-08-01',
    alternatives,
    reason: 'Synthetic.',
    limitation: 'Synthetic.',
    comparisons: [],
  };
  const result = investigateProject(
    report([], {
      websites: [
        { ...site, status: 'unavailable', source: 'cf' },
        { ...site, id: 'docs_site', status: 'changed_during_period', source: null },
        { ...site, id: 'blog_site', status: 'not_selected', source: null },
      ],
    }),
  );
  assert.deepEqual(reasons(result.findings), [
    'website.preferred_source_unavailable',
    'website.preference_changed_in_window',
    'website.no_preferred_source',
  ]);
  const failed = result.findings[0]!;
  assert.equal(failed.resourceId, 'cf');
  assert.equal(failed.evidenceState, 'unavailable');
  assert.match(failed.summary, /No alternative source is substituted/);
  assert.deepEqual(
    failed.evidence.map((ref) => [ref.resourceId, ref.facts.role, ref.facts.observedValue]),
    [
      ['cf', 'preferred', 120],
      ['um', 'alternative', 300],
    ],
  );
  const incomplete = investigateProject(
    report([], {
      websites: [
        {
          ...site,
          status: 'ready',
          source: 'um',
          metric: 'umami.pageviews',
          value: 300,
          comparisons: [
            {
              source: 'cf',
              status: 'unavailable',
              difference: null,
              reasons: ['Synthetic reason.\nSecond line.'],
            },
          ],
        },
      ],
    }),
  ).findings[0]!;
  assert.equal(incomplete.reason, 'website.sources_not_comparable');
  assert.deepEqual(
    incomplete.nextChecks.map((step) => step.id),
    ['health.latest_refresh', 'plan.window_coverage', 'report.daily_points'],
  );
  assert.equal(
    incomplete.evidence.find((ref) => ref.resourceId === 'cf')!.facts.firstReason,
    'Synthetic reason. Second line.',
  );
  // The two provider values are listed apart; their sum appears nowhere.
  assert.ok(!JSON.stringify(result).includes('420'));
  assert.equal(result.findings[1]!.nextChecks[0]!.id, 'report.split_window');
});

test('synthetic acceptance: the evidence demo yields cross-source leads a single provider cannot show', async () => {
  const store = new Store(new SqliteDriver(':memory:'));
  await store.migrate();
  try {
    const at = new Date('2026-11-13T12:00:00Z');
    const config = await seedDemo(store, at, 'evidence');
    assert.deepEqual(config, evidenceDemoConfig());
    const real = await projectReport(config, store, 'sense6', reportRange({ days: 28 }, at), at);
    const graph = projectGraph(config, 'sense6');
    const brief = projectBrief(real, 100, graph);
    assert.equal(brief.demo, true);
    const leads = brief.investigation.findings;
    const website = real.websites![0]!;
    const umami = website.comparisons.find((c) => c.source === 'sense6-umami')!;
    const differ = leads.find((f) => f.reason === 'website.sources_differ')!;
    assert.equal(differ.resourceId, 'sense6-umami');
    assert.equal(differ.evidenceState, 'observed');
    const alternative = differ.evidence.find((ref) => ref.resourceId === 'sense6-umami')!;
    const preferred = differ.evidence.find((ref) => ref.resourceId === 'sense6-rum')!;
    assert.equal(alternative.facts.differenceFromPreferred, umami.difference!.absolute);
    assert.equal(preferred.facts.observedValue, website.value);
    assert.match(differ.summary, /fewer pageviews than the preferred source sense6-rum/);
    assert.match(
      differ.limitations.join(' '),
      /not an estimate of missing traffic, automated share/,
    );
    assert.equal(differ.subject?.kind, 'website_analytics');
    assert.deepEqual(differ.subject?.websites, ['sense6-public']);
    const refused = leads.find((f) => f.reason === 'website.sources_not_comparable')!;
    assert.equal(refused.resourceId, 'sense6-plausible');
    assert.equal(
      refused.evidence.find((ref) => ref.resourceId === 'sense6-plausible')!.facts
        .differenceFromPreferred,
      undefined,
    );
    assert.match(refused.summary, /No difference is calculated/);
    // Both series are complete, so the open question is the calendar, not collection.
    assert.deepEqual(
      refused.nextChecks.map((step) => [step.id, step.resourceId]),
      [
        ['provider.reporting_calendar', 'sense6-plausible'],
        ['provider.reporting_calendar', 'sense6-rum'],
        ['report.daily_points', 'sense6-plausible'],
      ],
    );
    for (const ref of [...differ.evidence, ...refused.evidence])
      assert.ok(real.cards.some((c) => c.key === ref.seriesKey));

    // The established briefing is unchanged and every part of it has a matching lead.
    assert.deepEqual(brief.findings, projectBrief(real, 100).findings);
    assert.deepEqual(brief.evidence, real.evidence);
    for (const change of brief.findings.filter((f) => f.kind === 'change')) {
      const lead = leads.find(
        (f) =>
          f.category === 'change' &&
          f.resourceId === change.resourceId &&
          f.evidence.some(
            (ref) =>
              ref.metric === change.metric &&
              ref.facts.absoluteChange === change.evidence.absoluteChange,
          ),
      );
      assert.ok(lead, `no lead for ${change.message}`);
    }
    assert.equal(
      leads.filter((f) => ['concentration', 'attribution', 'interpretation'].includes(f.category))
        .length,
      real.evidence.signals.length,
    );
    for (const coverage of brief.findings.filter((f) => f.kind === 'coverage')) {
      const refs = leads
        .filter((f) => f.category === 'coverage' && f.resourceId === coverage.resourceId)
        .flatMap((f) => f.evidence.filter((ref) => ref.facts.aggregation !== 'latest'));
      assert.equal(refs.length, coverage.evidence.affectedSeries);
    }
    const markdown = markdownBrief(brief);
    assert.match(markdown, /## What to verify next/);
    assert.match(markdown, /`website\.sources_differ`/);
    assert.match(markdown, /SYNTHETIC DEMO/);
    assert.ok(leads.filter((f) => f.reason === 'change.period').length > 1);
    assert.equal(markdown.split('Both periods use the same metric').length - 1, 1);
    assert.ok(
      markdown.indexOf('## What to verify next') < markdown.indexOf('## Declared website sources'),
    );
    assert.deepEqual(projectBrief(real, 100, graph), brief);
  } finally {
    store.driver.close?.();
  }
});

test('the briefing stays compatible: same findings, additive investigation, optional resources', async () => {
  const config = fixture('npm'),
    store = await database(config);
  try {
    const real = await projectReport(config, store, 'project', shortWindow, now);
    const brief = projectBrief(real, 1);
    assert.equal(brief.schemaVersion, 1);
    assert.equal(brief.findings.length, 1);
    assert.ok(brief.omittedFindings > 0);
    assert.equal(brief.investigation.findings.length, 1);
    assert.equal('resources' in brief, false);
    assert.equal(brief.evidence.independentAdoption, 'not_measured');
    for (const key of [
      'schemaVersion',
      'project',
      'window',
      'generatedAt',
      'demo',
      'findings',
      'omittedFindings',
      'annotations',
      'warnings',
      'limitation',
      'evidence',
    ])
      assert.ok(key in brief, key);
    const withMap = projectBrief(real, 20, projectGraph(config, 'project'));
    assert.equal(withMap.resources?.resources[0]!.identity.value, '@example/package');
    assert.equal(withMap.investigation.findings[0]!.subject?.kind, 'package');
    assert.deepEqual(withMap.findings, projectBrief(real, 20).findings);
    assert.match(markdownBrief(brief), /do not establish independent adopters/);
    assert.throws(() => projectBrief(real, 0), RangeError);
    // A map of another project cannot name this report's subjects.
    const foreign = {
      ...projectGraph(config, 'project'),
      project: { id: 'other', label: 'Other' },
    };
    assert.throws(() => projectBrief(real, 20, foreign), /another project/);
    assert.throws(() => investigateProject(real, 20, foreign), /another project/);
  } finally {
    store.driver.close?.();
  }
});
