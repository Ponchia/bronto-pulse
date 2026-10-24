import test from 'node:test';
import assert from 'node:assert/strict';
import { dateInZone, days, defaultRange, range } from '../src/time.js';

test('UTC provider and report dates never construct an ICU formatter', () => {
  const original = Intl.DateTimeFormat;
  try {
    Intl.DateTimeFormat = function () {
      throw new Error('Unexpected UTC ICU initialization');
    } as unknown as typeof Intl.DateTimeFormat;
    const at = new Date('2026-10-24T00:00:00Z');
    assert.equal(dateInZone(at), '2026-10-24');
    assert.deepEqual(defaultRange(at, 14), { from: '2026-10-10', to: '2026-10-23' });
    assert.throws(() => dateInZone(new Date(NaN)), RangeError);
  } finally {
    Intl.DateTimeFormat = original;
  }
});

test('non-UTC provider dates retain IANA offset and daylight-saving rules', () => {
  for (const [iso, expected] of [
    ['2026-03-08T07:59:59Z', '2026-03-07'],
    ['2026-03-08T08:00:00Z', '2026-03-08'],
    ['2026-11-01T06:59:59Z', '2026-10-31'],
    ['2026-11-01T07:00:00Z', '2026-11-01'],
  ])
    assert.equal(dateInZone(new Date(iso!), 'America/Los_Angeles'), expected);
  assert.throws(() => dateInZone(new Date(), 'not-a-time-zone'), RangeError);
});

test('bounded epoch date enumeration preserves leap years and month/year transitions', () => {
  assert.deepEqual(days({ from: '2024-02-28', to: '2024-03-01' }), [
    '2024-02-28',
    '2024-02-29',
    '2024-03-01',
  ]);
  assert.deepEqual(days({ from: '2026-12-31', to: '2027-01-02' }), [
    '2026-12-31',
    '2027-01-01',
    '2027-01-02',
  ]);
  assert.deepEqual(days({ from: '0001-01-01', to: '0001-01-02' }), ['0001-01-01', '0001-01-02']);
  assert.deepEqual(days({ from: '2026-10-24', to: '2026-10-24' }), ['2026-10-24']);
  for (const value of [
    { from: '2026-02-29', to: '2026-03-01' },
    { from: '2026-01-02', to: '2026-01-01' },
    { from: '2000-01-01', to: '2020-01-01' },
  ])
    assert.throws(() => days(value));
  assert.throws(() => range('2026-01-01', '2026-01-15', 14));
});
