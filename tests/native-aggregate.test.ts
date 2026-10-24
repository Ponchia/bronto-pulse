import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeSense6,
  workerBindings,
  type AggregateBindings,
} from '../src/collectors/bindings.js';
import { collectSense6, SENSE6_QUERY } from '../src/collectors/sense6.js';
import type { D1Like, SqlValue } from '../src/storage/driver.js';
import { readyResource, sync, doctor } from '../src/sync.js';
import { scheduleOptions } from '../src/worker-schedule.js';
import { fixture, ctx, database, now } from './helpers.js';

function source(
  rows: unknown[] = [{ day: '2026-10-13', test: 'site', metric: 'site_loaded', count: 7 }],
) {
  const calls: { sql: string; params: SqlValue[] }[] = [];
  const db: D1Like = {
    prepare(sql) {
      return {
        bind(...params) {
          calls.push({ sql, params });
          return {
            async all<T>() {
              return { results: rows as T[] };
            },
          };
        },
      };
    },
    async batch() {
      assert.fail('Source binding must never receive writes');
    },
  };
  const bindings: AggregateBindings = {
    sense6: {
      accountId: 'a'.repeat(32),
      databaseId: '00000000-0000-4000-8000-000000000001',
      database: db,
    },
  };
  return { db, bindings, calls };
}

test('native aggregate binding reads only the fixed parameterized four-column contract', async () => {
  const config = fixture('sense6');
  const { bindings, calls } = source();
  const context = ctx(config, async () => {
    assert.fail('No credential or REST request is needed');
  });
  const resource = config.resources[0]!;
  assert.equal(resource.provider, 'sense6');
  if (resource.provider !== 'sense6') return;
  const result = await collectSense6(resource, { ...context, bindings });
  assert.deepEqual(calls, [{ sql: SENSE6_QUERY, params: ['2026-10-12', '2026-10-13', 101] }]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0]?.value, 7);
  assert.equal(context.http.requests, 0);
});

test('native readiness requires exact account/database identity, never just a binding name', () => {
  const config = fixture('sense6');
  const { bindings, calls } = source();
  const resource = config.resources[0]!;
  assert.equal(readyResource(config, resource, 'activity', {}, bindings), resource);
  assert.equal(
    nativeSense6({ ...resource, accountId: 'b'.repeat(32) } as typeof resource, bindings),
    undefined,
  );
  assert.equal(
    nativeSense6(
      { ...resource, databaseId: '00000000-0000-4000-8000-000000000002' } as typeof resource,
      bindings,
    ),
    undefined,
  );
  assert.deepEqual(calls, []);
});

test('partial native installation fails closed and never reflects input values', () => {
  assert.deepEqual(workerBindings({}), {});
  const { db } = source();
  for (const env of [
    { PULSE_SENSE6_DB: db },
    { PULSE_SENSE6_ACCOUNT_ID: 'private-input' },
    {
      PULSE_SENSE6_DB: db,
      PULSE_SENSE6_ACCOUNT_ID: 'a'.repeat(32),
      PULSE_SENSE6_DATABASE_ID: 'private-input',
    },
  ])
    assert.throws(
      () => workerBindings(env),
      /Native Sense6 binding identities are incomplete or invalid\./,
    );
  assert.ok(
    workerBindings({
      PULSE_SENSE6_DB: db,
      PULSE_SENSE6_ACCOUNT_ID: 'a'.repeat(32),
      PULSE_SENSE6_DATABASE_ID: '00000000-0000-4000-8000-000000000001',
    }).sense6,
  );
});

test('native source keeps privacy and truncation validation identical to REST', async () => {
  const config = fixture('sense6');
  const resource = config.resources[0]!;
  if (resource.provider !== 'sense6') return;
  for (const rows of [
    [
      {
        day: '2026-10-13',
        test: 'site',
        metric: 'site_loaded',
        count: 7,
        participant: 'must-not-be-stored',
      },
    ],
    Array.from({ length: 101 }, () => ({})),
  ]) {
    const { bindings } = source(rows);
    await assert.rejects(
      collectSense6(resource, { ...ctx(config, []), bindings }),
      /aggregate contract|row budget/,
    );
  }
});

test('Free-profile collection and health recognize the native source without a token', async () => {
  const config = fixture('sense6');
  const store = await database(config);
  const { bindings } = source();
  const results = await sync(
    config,
    store,
    {},
    {
      ...scheduleOptions({ PULSE_EXECUTION_PROFILE: 'free', PULSE_READY_ONLY: 'true' }),
      bindings,
      now,
      fetcher: async () => {
        assert.fail('No REST requests');
      },
    },
  );
  assert.equal(results[0]?.status, 'success');
  assert.equal(results[0]?.requests, 0);
  assert.equal(results[0]?.rows, 1);
  const health = await doctor(config, store, {}, now, bindings);
  assert.equal(health.healthy, true);
  assert.equal(health.resources[0]?.credentials.method, 'd1-binding');
  const noBinding = await doctor(config, store, {}, now);
  assert.equal(noBinding.resources[0]?.status, 'credentials_missing');
  store.driver.close?.();
});
