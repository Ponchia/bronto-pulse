import test from 'node:test';
import assert from 'node:assert/strict';
import { retryAfterSeconds } from '../src/retry-after.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const read = (value: string) => retryAfterSeconds(new Headers({ 'retry-after': value }), now);

test('Retry-After decimal padding does not turn finite delays into indefinite holds', () => {
  // RFC 9110 delay-seconds is 1*DIGIT; leading zeroes do not change its value.
  for (const padding of [0, 1, 15, 32, 60])
    for (const seconds of [1, 60, 3600]) assert.equal(read('0'.repeat(padding) + seconds), seconds);
});

test('a zero delay remains absent guidance even when the header is padded', () => {
  assert.equal(read('0'.repeat(64)), undefined);
});

test('GitHub reset timestamps retain their value after decimal zero padding', () => {
  const reset = String(now / 1000 + 120);
  const headers = new Headers({
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '0'.repeat(40) + reset,
  });
  assert.equal(retryAfterSeconds(headers, now, true), 120);
  headers.set('retry-after', '0'.repeat(32) + '300');
  assert.equal(retryAfterSeconds(headers, now, true), 300);
});

test('large significant values still fail closed instead of shortening the provider wait', () => {
  assert.equal(read('0'.repeat(20) + '9999999999999999'), Number.POSITIVE_INFINITY);
  assert.equal(read('0'.repeat(20) + '999999999999999'), 999999999999999);
  for (const invalid of ['-001', '+001', '0 01', '1.0']) assert.equal(read(invalid), undefined);
});
