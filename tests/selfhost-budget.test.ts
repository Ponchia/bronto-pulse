import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.js';
import { PulseError } from '../src/errors.js';
import { selfHostedJson } from '../src/selfhost/client.js';
import { PRIVATE_ADMISSION_SETTING, type SelfHostedRuntime } from '../src/selfhost/policy.js';
import { selfHostedConfig, context, ADDRESS_SETTING } from './selfhost-helpers.js';

const read = {
  variant: 'umami-selfhosted' as const,
  websiteId: 'website-123',
  startAt: Date.parse('2026-10-12T00:00:00Z'),
  endAt: Date.parse('2026-10-13T00:00:00Z') - 1,
};
const settings = { [ADDRESS_SETTING]: '10.20.30.40', [PRIVATE_ADMISSION_SETTING]: '10.20.30.40' };
const rowLimit = (error: unknown) => {
  assert.ok(error instanceof PulseError);
  assert.equal(error.code, 'ROW_LIMIT');
  return true;
};

function boundedClient() {
  return new HttpClient(
    async () => {
      throw new Error('Generic fetch is forbidden');
    },
    1000,
    undefined,
    64,
    1,
  );
}

test('self-hosted reads share the job request budget before reading another credential', async () => {
  const config = selfHostedConfig('umami');
  let exchanges = 0;
  const runtime: SelfHostedRuntime = {
    settings,
    exchange: async () => {
      exchanges++;
      return { status: 200, retryAfter: null, body: new TextEncoder().encode('{}') };
    },
  };
  const ctx = context(config, runtime);
  ctx.http = boundedClient();
  await selfHostedJson(ctx, config.connections[0], read);
  await assert.rejects(selfHostedJson(ctx, config.connections[0], read), rowLimit);
  assert.equal(exchanges, 1);
  assert.equal(ctx.tokenReads(), 1);
});

test('self-hosted reads enforce a smaller job byte budget at both transport and decoder', async () => {
  const config = selfHostedConfig('umami');
  let transmittedLimit = 0;
  const runtime: SelfHostedRuntime = {
    settings,
    exchange: async (request) => {
      transmittedLimit = request.maximumBytes;
      // The client must also reject oversized replies from an embedded transport.
      return {
        status: 200,
        retryAfter: null,
        body: new TextEncoder().encode(JSON.stringify('x'.repeat(64))),
      };
    },
  };
  const ctx = context(config, runtime);
  ctx.http = boundedClient();
  await assert.rejects(selfHostedJson(ctx, config.connections[0], read), rowLimit);
  assert.equal(transmittedLimit, 64);
  assert.equal(ctx.http.requests, 1);
});
