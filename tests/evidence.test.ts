import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidence, metricEvidenceClass } from '../src/evidence.js';
import {
  type MetricCard,
  type ProjectReport,
  projectReport,
  markdownReport,
} from '../src/report.js';
import { projectBrief, markdownBrief } from '../src/brief.js';
import { csvReport } from '../src/report-export.js';
import { fixture, database, now, window as shortWindow } from './helpers.js';
import { days } from '../src/time.js';

const window = { from: '2026-09-01', to: '2026-09-30' };
function card(patch: Partial<MetricCard> = {}): MetricCard {
  const points = days(window).map((date, i) => ({
    date,
    from: date,
    to: date,
    value: i >= 10 && i < 17 ? 100 : 1,
    quality: 'observed' as const,
  }));
  return {
    key: 'synthetic',
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
    value: 723,
    latestValue: 1,
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
      reason: 'Synthetic fixture.',
      kind: null,
      baselinePeriod: null,
    },
    ...patch,
  };
}
function report(cards: MetricCard[] = [card()], breakdowns: ProjectReport['breakdowns'] = []) {
  return { cards, breakdowns, window };
}
function referral(
  referrer: string,
  value: number,
  to = '2026-09-30',
): ProjectReport['breakdowns'][number] {
  return {
    resourceId: 'repo',
    group: 'referrers',
    metric: 'github.referral_views',
    period: { from: '2026-09-17', to },
    dimensions: { referrer },
    value,
    quality: 'top_n',
  };
}

test('evidence classes describe measurements, not users or intents', () => {
  const expectations = {
    'npm.downloads': 'distribution',
    'github.clones': 'distribution',
    'github.release_downloads': 'distribution',
    'github.views': 'discovery',
    'gsc.clicks': 'discovery',
    'sense6.test_completed': 'activity',
    'github.stars': 'interest',
    'github.open_issues': 'maintenance',
    'cloudflare.lcp_p75': 'performance',
    unknown: 'unclassified',
  };
  for (const [metric, expected] of Object.entries(expectations))
    assert.equal(metricEvidenceClass(metric), expected);
});
test('concentration preserves counts and exposes exact period, scope and thresholds', () => {
  const r = report(),
    before = structuredClone(r),
    assessed = assessEvidence(r);
  assert.deepEqual(r, before);
  assert.deepEqual(assessed, assessEvidence(r));
  assert.equal(assessed.humanAudience, 'not_measured');
  assert.equal(assessed.independentAdoption, 'not_measured');
  assert.equal(assessed.automatedShare, 'not_measured');
  const s = assessed.signals[0]!;
  assert.equal(s.code, 'concentrated_activity');
  assert.equal(s.evidence.periodTotal, 723);
  assert.equal(s.evidence.peakSevenDayTotal, 700);
  assert.equal(s.evidence.peakFrom, '2026-09-11');
  assert.equal(s.evidence.peakTo, '2026-09-17');
  assert.equal(s.evidence.scope, '{}');
  assert.match(s.message, /cause and human share are unknown/);
});
test('short, small, evenly distributed or unavailable series do not trigger concentration', () => {
  const small = card();
  small.points = small.points.map((p) => ({ ...p, value: p.value / 10 }));
  const even = card();
  even.points = even.points.map((p) => ({ ...p, value: 100 }));
  const missing = card();
  missing.coverage.status = 'partial';
  missing.points.pop();
  for (const c of [
    small,
    even,
    missing,
    card({ aggregation: 'latest' }),
    card({ aggregation: 'none' }),
  ])
    assert.equal(assessEvidence(report([c])).signals.length, 0);
  const short = report();
  short.window = { from: '2026-09-24', to: '2026-09-30' };
  assert.equal(assessEvidence(short).signals.length, 0);
});
for (const quality of ['provisional', 'sampled', 'provider_limited', 'top_n'] as const)
  test(`${quality} series cannot establish full-period concentration`, () => {
    const c = card();
    c.coverage.qualities.push(quality);
    assert.equal(assessEvidence(report([c])).signals.length, 0);
    const c2 = card();
    c2.points[0]!.quality = quality;
    assert.equal(assessEvidence(report([c2])).signals.length, 0);
  });
test('mapping boundaries, invalid daily points and duplicate dates fail closed', () => {
  for (const mutate of [
    (c: MetricCard) => {
      c.coverage.expectedDays = 29;
    },
    (c: MetricCard) => {
      c.points[0]!.value = -1;
    },
    (c: MetricCard) => {
      c.points[0]!.value = Infinity;
    },
    (c: MetricCard) => {
      c.points[0]!.from = '2026-08-31';
    },
    (c: MetricCard) => {
      c.points[1]!.date = c.points[0]!.date;
    },
  ]) {
    const c = card();
    mutate(c);
    assert.equal(assessEvidence(report([c])).signals.length, 0);
  }
});
test('referrer review uses only the newest returned rolling snapshot, never daily traffic', () => {
  const r = report(
    [],
    [
      referral('old.example', 1000, '2026-09-29'),
      referral('source.example', 90),
      referral('other.example', 10),
    ],
  );
  const s = assessEvidence(r).signals[0]!;
  assert.equal(s.code, 'concentrated_referrers');
  assert.equal(s.evidence.listedViews, 100);
  assert.equal(s.evidence.referrerViews, 90);
  assert.equal(s.evidence.referrer, 'source.example');
  assert.match(s.message, /not all repository traffic/);
  assert.match(s.message, /does not verify human interest or automation/);
});
test('no named referrer is treated as a bot and ambiguous lists are not summed', () => {
  for (const referrer of ['unknown.example', 'crawler.example', 'github.com', '']) {
    const result = assessEvidence(report([], [referral(referrer, 100)]));
    assert.equal(result.automatedShare, 'not_measured');
    assert.equal(result.signals[0]!.evidence.listedViews, 100);
  }
  for (const entries of [
    [referral('one', 5)],
    [referral('one', 40), referral('two', 60)],
    [referral('one', 90), referral('one', 90)],
    [{ ...referral('one', 90), quality: 'observed' as const }],
    [referral('one', 90, '2026-10-01')],
  ])
    assert.equal(assessEvidence(report([], entries)).signals.length, 0);
});
test('blank website referrers stay unknown and do not become direct human visits', () => {
  const result = assessEvidence(
    report([], [{ ...referral('', 10), metric: 'cloudflare.pageviews', quality: 'observed' }]),
  );
  assert.equal(result.signals[0]!.code, 'unattributed_referrer');
  assert.match(result.signals[0]!.message, /not proof of direct human visits/);
});
test('reports, briefs and private CSV keep adoption limits even when findings are capped', async () => {
  const config = fixture('npm'),
    store = await database(config);
  try {
    const r = await projectReport(config, store, 'project', shortWindow, now);
    assert.equal(r.evidence.independentAdoption, 'not_measured');
    assert.equal(r.cards[0]!.evidenceClass, 'distribution');
    assert.match(markdownReport(r), /## Interpretation/);
    assert.match(markdownBrief(projectBrief(r, 1)), /do not establish independent adopters/);
    assert.equal(projectBrief(r, 1).evidence.independentAdoption, 'not_measured');
    assert.match(csvReport(r), /"evidence_class","independent_adoption","metric_caveat"/);
    assert.match(csvReport(r), /"distribution","not_measured"/);
  } finally {
    store.driver.close?.();
  }
});

test('referrer totals that overflow remain unclassified rather than inventing a share', () => {
  const entries = [
    referral('one.example', Number.MAX_VALUE),
    referral('two.example', Number.MAX_VALUE),
  ];
  assert.equal(assessEvidence(report([], entries)).signals.length, 0);
});

test('rolling concentration thresholds are inclusive and a zero series is not an adoption claim', () => {
  const boundary = assessEvidence(
    report([], [referral('one.example', 8), referral('two.example', 2)]),
  );
  assert.equal(boundary.signals[0]!.evidence.listedShare, 0.8);
  const zero = card();
  zero.points = zero.points.map((point) => ({ ...point, value: 0 }));
  const assessed = assessEvidence(report([zero]));
  assert.equal(assessed.signals.length, 0);
  assert.equal(assessed.independentAdoption, 'not_measured');
});
