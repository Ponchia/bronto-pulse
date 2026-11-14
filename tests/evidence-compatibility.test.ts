import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateDailyCountEvidence,
  type DailyCountEvidence,
} from '../src/evidence-compatibility.js';
import { compareWebsiteSources } from '../src/source-comparison.js';
import { websiteAuthorities } from '../src/website-authority.js';
import type { MetricCard } from '../src/report.js';

const dates = ['2026-10-12', '2026-10-13'];
const window = { from: dates[0]!, to: dates[1]! };
function evidence(): DailyCountEvidence {
  return {
    unit: 'pageviews',
    aggregation: 'sum',
    value: 100,
    coverage: {
      status: 'complete',
      observedDays: 2,
      expectedDays: 2,
      missingDays: [],
      qualities: ['observed'],
    },
    points: dates.map((date) => ({ date, from: date, to: date, value: 50, quality: 'observed' })),
  };
}
function metric(resourceId: string, data = evidence()): MetricCard {
  return {
    ...data,
    key: resourceId + ':pageviews',
    resourceId,
    provider: 'umami',
    metric: 'umami.pageviews',
    evidenceClass: 'discovery',
    label: 'Pageviews',
    dimensions: {},
    timezone: 'UTC',
    methodology: 'test-native',
    scope: {},
    latestCollectedAt: null,
    latestValue: 50,
    latestPeriod: window,
    caveat: 'Synthetic',
    comparison: {
      previousValue: null,
      absoluteChange: null,
      relativeChange: null,
      reason: 'No baseline',
      kind: null,
      baselinePeriod: null,
    },
  };
}
test('shared evidence gate accepts observed zeroes and unordered point storage without mutating inputs', () => {
  const card = evidence();
  card.value = 0;
  card.points = card.points.map((point) => ({ ...point, value: 0 })).reverse();
  const before = structuredClone(card);
  assert.deepEqual(evaluateDailyCountEvidence(card, dates, 'pageviews'), {
    eligible: true,
    issues: [],
  });
  assert.deepEqual(card, before);
});
test('shared evidence gate reports stable reasons for malformed or limited data', () => {
  const cases: [DailyCountEvidence, string][] = [];
  let card = evidence();
  card.value = null;
  cases.push([card, 'invalid_total']);
  card = evidence();
  card.aggregation = 'none';
  cases.push([card, 'non_additive']);
  card = evidence();
  card.unit = 'sessions';
  cases.push([card, 'unsupported_unit']);
  card = evidence();
  card.coverage.missingDays = [dates[0]!];
  cases.push([card, 'incomplete_coverage']);
  card = evidence();
  card.coverage.qualities = ['sampled'];
  cases.push([card, 'limited_quality']);
  card = evidence();
  card.coverage.qualities = [];
  cases.push([card, 'limited_quality']);
  card = evidence();
  card.points[0]!.quality = 'provisional';
  cases.push([card, 'invalid_daily_buckets']);
  card = evidence();
  card.points[1] = { ...card.points[0]! };
  cases.push([card, 'invalid_daily_buckets']);
  card = evidence();
  card.points[1]!.from = dates[0]!;
  cases.push([card, 'invalid_daily_buckets']);
  card = evidence();
  card.points[0]!.value = 0.5;
  cases.push([card, 'invalid_daily_buckets']);
  card = evidence();
  card.value = 99;
  cases.push([card, 'inconsistent_total']);
  card = evidence();
  card.value = Number.MAX_SAFE_INTEGER + 1;
  cases.push([card, 'invalid_total']);
  card = evidence();
  card.points.forEach((point) => (point.value = Number.MAX_SAFE_INTEGER));
  cases.push([card, 'inconsistent_total']);
  for (const [input, code] of cases) {
    const result = evaluateDailyCountEvidence(input, dates, 'pageviews');
    assert.equal(result.eligible, false, code);
    assert.ok(
      result.issues.some((issue) => issue.code === code),
      code,
    );
    assert.deepEqual(result, evaluateDailyCountEvidence(input, dates, 'pageviews'));
  }
});
test('shared gate rejects empty, invalid, duplicated, skipped or reversed requested calendars', () => {
  for (const invalid of [
    [],
    ['bad'],
    ['2026-02-30'],
    [dates[0]!, dates[0]!],
    [dates[1]!, dates[0]!],
    [dates[0]!, '2026-10-14'],
  ]) {
    const result = evaluateDailyCountEvidence(evidence(), invalid);
    assert.equal(result.eligible, false);
    assert.ok(result.issues.some((issue) => issue.code === 'invalid_period'));
  }
});
test('comparison and declared authority share the same strict daily evidence decision', () => {
  const site = {
    id: 'site',
    hostname: 'example.test',
    sources: ['a', 'b'],
    pageviewsAuthority: [{ resource: 'a', effectiveFrom: '2026-01-01' }],
  };
  const invalid = evidence();
  invalid.coverage.missingDays = [dates[0]!];
  const cards = [metric('a', invalid), metric('b')];
  const comparison = compareWebsiteSources({ cards, window }, 'a', 'b', true);
  assert.equal(comparison.status, 'incompatible');
  assert.equal(comparison.difference, null);
  assert.ok(comparison.reasons.some((r) => r.includes('complete observed coverage')));
  const authority = websiteAuthorities([site], cards, window)[0]!;
  assert.equal(authority.status, 'unavailable');
  assert.equal(authority.value, null);
  assert.match(authority.reason, /complete observed coverage/);
  assert.equal(cards[0]!.value, 100, 'raw totals are not changed or silently corrected');
});
