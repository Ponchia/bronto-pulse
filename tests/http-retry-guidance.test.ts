import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.js';
import { PulseError } from '../src/errors.js';

const NPM = 'https://api.npmjs.org/downloads/range/2026-11-01:2026-11-02/example';
const GITHUB = 'https://api.github.com/repos/example/project';

async function failure(
  statuses: readonly number[],
  headers: Readonly<Record<string, string>>,
  url = NPM,
  retryRateLimits = true,
  guidanceFromAttempt = 1,
) {
  let requests = 0;
  const sleeps: number[] = [];
  const client = new HttpClient(
    async () => {
      requests++;
      return new Response('private upstream response must not escape', {
        status: statuses[Math.min(requests - 1, statuses.length - 1)]!,
        headers: requests >= guidanceFromAttempt ? headers : {},
      });
    },
    1000,
    async (ms) => {
      sleeps.push(ms);
    },
    undefined,
    undefined,
    retryRateLimits,
  );
  let caught: PulseError | undefined;
  await assert.rejects(client.json(url), (error: unknown) => {
    assert.ok(error instanceof PulseError);
    assert.doesNotMatch(error.message, /private upstream/);
    caught = error;
    return true;
  });
  assert.ok(caught);
  return { error: caught, requests, sleeps };
}

for (const status of [429, 500, 502, 503, 504]) {
  test(`HTTP ${status}: an unbounded provider wait defers without retry`, async () => {
    const result = await failure([status], { 'retry-after': '1' + '0'.repeat(400) });
    assert.equal(result.requests, 1);
    assert.deepEqual(result.sleeps, []);
    assert.equal(result.error.code, 'RATE_LIMIT');
    assert.equal(result.error.retryAfterSeconds, Number.POSITIVE_INFINITY);
  });
}

test('GitHub 403 recognizes an HTTP-date wait without a remaining-quota header', async () => {
  const result = await failure(
    [403],
    { 'retry-after': new Date(Date.now() + 2 * 3600000).toUTCString() },
    GITHUB,
  );
  assert.equal(result.error.code, 'RATE_LIMIT');
  assert.ok(result.error.retryAfterSeconds! > 7190);
  assert.ok(result.error.retryAfterSeconds! <= 7200);
  assert.equal(result.requests, 1);
  assert.deepEqual(result.sleeps, []);
});

for (const raw of ['0x20', '2e2', 'Infinity', '1.5', '-1']) {
  test(`HTTP 503: malformed delay ${raw} uses bounded fallback, not numeric coercion`, async () => {
    const result = await failure([503], { 'retry-after': raw });
    assert.equal(result.requests, 3);
    assert.deepEqual(result.sleeps, [200, 400]);
    assert.equal(result.error.code, 'UNAVAILABLE');
    assert.equal(result.error.retryAfterSeconds, undefined);
  });
}

for (const raw of ['0x20', '2e2', 'Infinity', '1.5']) {
  test(`GitHub 403: malformed delay ${raw} does not invent a quota failure`, async () => {
    const result = await failure([403], { 'retry-after': raw }, GITHUB);
    assert.equal(result.error.code, 'PERMISSION');
    assert.equal(result.error.retryAfterSeconds, undefined);
    assert.equal(result.requests, 1);
    assert.deepEqual(result.sleeps, []);
  });
}

for (const delay of ['90', '2', '1' + '0'.repeat(400)]) {
  test(`HTTP 503 preserves final guidance (${delay.length > 20 ? 'huge' : delay})`, async () => {
    const result = await failure([500, 502, 503], { 'retry-after': delay }, NPM, true, 3);
    assert.equal(result.requests, 3);
    assert.deepEqual(result.sleeps, [200, 400]);
    assert.equal(result.error.code, 'RATE_LIMIT');
    assert.equal(
      result.error.retryAfterSeconds,
      delay.length > 20 ? Number.POSITIVE_INFINITY : Number(delay),
    );
  });
}

test('short decimal waits retain bounded retries and terminal guidance', async () => {
  const result = await failure([429], { 'retry-after': '2' });
  assert.equal(result.requests, 3);
  assert.deepEqual(result.sleeps, [2000, 2000]);
  assert.equal(result.error.code, 'RATE_LIMIT');
  assert.equal(result.error.retryAfterSeconds, 2);
});

test('the free profile still defers a short 429 immediately', async () => {
  const result = await failure([429], { 'retry-after': '2' }, NPM, false);
  assert.equal(result.requests, 1);
  assert.deepEqual(result.sleeps, []);
  assert.equal(result.error.code, 'RATE_LIMIT');
  assert.equal(result.error.retryAfterSeconds, 2);
});

test('GitHub zero remaining quota is rate-limited without a usable wait', async () => {
  const result = await failure(
    [403],
    { 'x-ratelimit-remaining': '0', 'retry-after': 'untrusted text' },
    GITHUB,
  );
  assert.equal(result.error.code, 'RATE_LIMIT');
  assert.equal(result.error.retryAfterSeconds, undefined);
  assert.equal(result.requests, 1);
  assert.deepEqual(result.sleeps, []);
});
