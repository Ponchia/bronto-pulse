import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.js';
import { PulseError } from '../src/errors.js';

const npm = 'https://api.npmjs.org/downloads/range/2026-11-01:2026-11-02/alpha';

test('an unrepresentable provider wait never causes an early in-job retry', async () => {
  for (const status of [429, 503]) {
    let requests = 0;
    const sleeps: number[] = [];
    const client = new HttpClient(
      async () => {
        requests++;
        return new Response('{}', { status, headers: { 'retry-after': '1' + '0'.repeat(400) } });
      },
      1000,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    await assert.rejects(client.json(npm), (error: unknown) => {
      assert.ok(error instanceof PulseError);
      assert.equal(error.code, 'RATE_LIMIT');
      assert.equal(error.retryAfterSeconds, Number.POSITIVE_INFINITY);
      return true;
    });
    assert.equal(requests, 1, `HTTP ${status} retried before the provider wait`);
    assert.deepEqual(sleeps, []);
  }
});

test('a GitHub secondary limit with an HTTP-date is not mislabeled as denied permission', async () => {
  let requests = 0;
  const client = new HttpClient(
    async () => {
      requests++;
      return new Response('{}', {
        status: 403,
        headers: { 'retry-after': new Date(Date.now() + 7200000).toUTCString() },
      });
    },
    1000,
    async () => {
      throw new Error('A GitHub quota must defer immediately');
    },
  );
  await assert.rejects(
    client.json('https://api.github.com/repos/example/project'),
    (error: unknown) => {
      assert.ok(error instanceof PulseError);
      assert.equal(error.code, 'RATE_LIMIT');
      assert.ok(error.retryAfterSeconds! > 7190 && error.retryAfterSeconds! <= 7200);
      return true;
    },
  );
  assert.equal(requests, 1);
});
