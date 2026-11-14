import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfHostedConfig, context, ADDRESS_SETTING, TOKEN } from './selfhost-helpers.js';
import { database } from './helpers.js';
import { selfHostedJson } from '../src/selfhost/client.js';
import { PRIVATE_ADMISSION_SETTING, type SelfHostedRuntime } from '../src/selfhost/policy.js';
import { PulseError } from '../src/errors.js';
import { sync, probe } from '../src/sync.js';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';

function runtime(retryAfter: string | null): SelfHostedRuntime {
  return {
    settings: { [ADDRESS_SETTING]: '10.20.30.40', [PRIVATE_ADMISSION_SETTING]: '10.20.30.40' },
    exchange: async () => ({ status: 429, retryAfter, body: new Uint8Array() }),
  };
}
test('self-hosted 429 retains a normalized delay, never raw text or an in-job retry', async () => {
  const config = selfHostedConfig('umami');
  const read = {
    variant: 'umami-selfhosted' as const,
    websiteId: 'website-123',
    startAt: Date.parse('2026-10-12T00:00:00Z'),
    endAt: Date.parse('2026-10-13T00:00:00Z') - 1,
  };
  const wait = 90 * 86400;
  for (const [header, expected] of [
    [String(wait), wait],
    ['0', undefined],
    ['private-token-secret', undefined],
    ['10\r\nAuthorization: private', undefined],
    ['9'.repeat(65), undefined],
    [null, undefined],
  ] as const) {
    const ctx = context(config, runtime(header));
    await assert.rejects(selfHostedJson(ctx, config.connections[0], read), (error: unknown) => {
      assert.ok(error instanceof PulseError);
      assert.equal(error.code, 'RATE_LIMIT');
      assert.equal(error.retryAfterSeconds, expected);
      assert.doesNotMatch(error.message, /private-token|Authorization|7776000/);
      return true;
    });
    assert.equal(ctx.http.requests, 1);
    assert.equal(ctx.genericFetches(), 0);
  }
  const future = new Date(Date.now() + wait * 1000).toUTCString();
  await assert.rejects(
    selfHostedJson(context(config, runtime(future)), config.connections[0], read),
    (error: unknown) => {
      assert.ok(error instanceof PulseError);
      assert.ok(error.retryAfterSeconds! >= wait - 3);
      return true;
    },
  );
});

test('self-hosted provider wait survives due-time scheduling and portable restore', async () => {
  const config = selfHostedConfig('umami');
  const store = await database(config);
  const restored = new Store(new SqliteDriver(':memory:'));
  const wait = 90 * 86400;
  let attempts = 0;
  const transport = runtime(String(wait));
  const exchange = transport.exchange;
  const binding: SelfHostedRuntime = {
    ...transport,
    exchange: async (call) => {
      attempts++;
      return exchange(call);
    },
  };
  const options = {
    now: new Date(),
    dueOnly: true,
    maxJobs: 1,
    bindings: { selfHosted: binding },
    fetcher: async () => {
      throw new Error('Generic network is forbidden');
    },
  };
  try {
    const before = await store.observedThrough();
    const started = Date.now();
    const result = await sync(config, store, { TEST_TOKEN: TOKEN }, options);
    assert.equal(result[0]!.status, 'failed');
    assert.equal(result[0]!.code, 'RATE_LIMIT');
    const notBefore = result[0]!.retryNotBefore!;
    assert.ok(Date.parse(notBefore) >= started + wait * 1000);
    assert.deepEqual(await store.observedThrough(), before);
    assert.equal(attempts, 1);
    const archive = await store.export();
    assert.equal(archive.retryGuidance?.[0]?.notBefore, notBefore);
    assert.doesNotMatch(JSON.stringify(archive), new RegExp(TOKEN));
    await restored.migrate();
    await restored.import(archive);
    const retry = await sync(
      config,
      restored,
      { TEST_TOKEN: TOKEN },
      { ...options, now: new Date(Date.parse(notBefore) - 1000) },
    );
    assert.deepEqual(retry, []);
    assert.equal(attempts, 1, 'restore must not send an early request');
  } finally {
    store.driver.close?.();
    restored.driver.close?.();
  }
});

test('explicit probe dates and pinned transport coexist after integration without generic fetch', async () => {
  const config = selfHostedConfig('umami');
  const window = { from: '2026-10-12', to: '2026-10-13' };
  let attempts = 0;
  const transport: SelfHostedRuntime = {
    ...runtime(null),
    exchange: async (call) => {
      attempts++;
      assert.equal(call.read.variant, 'umami-selfhosted');
      if (call.read.variant !== 'umami-selfhosted') throw new Error('Wrong fixture request');
      assert.equal(call.read.startAt, Date.parse('2026-10-12T00:00:00Z'));
      assert.equal(call.read.endAt, Date.parse('2026-10-14T00:00:00Z') - 1);
      return {
        status: 200,
        retryAfter: null,
        body: new TextEncoder().encode(
          JSON.stringify({
            pageviews: [
              { x: window.from, y: 4 },
              { x: window.to, y: 5 },
            ],
            sessions: [
              { x: window.from, y: 2 },
              { x: window.to, y: 3 },
            ],
          }),
        ),
      };
    },
  };
  const result = await probe(
    config,
    { TEST_TOKEN: TOKEN },
    {
      window,
      now: new Date('2026-10-14T12:00:00Z'),
      bindings: { selfHosted: transport },
      fetcher: async () => {
        throw new Error('Generic network is forbidden');
      },
    },
  );
  assert.equal(result.results[0]!.status, 'available');
  assert.deepEqual(result.results[0]!.requestedWindow, window);
  assert.deepEqual(result.results[0]!.testedWindow, window);
  assert.equal(attempts, 1);
});
