import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { type WorkerEnv } from '../src/worker.js';
import { fixture } from './helpers.js';

const token = 'synthetic-worker-boundary-token-long-enough';
function environment(raw = JSON.stringify(fixture())) {
  let databaseCalls = 0;
  let assetCalls = 0;
  const env: WorkerEnv = {
    DB: {
      prepare() {
        databaseCalls++;
        throw new Error('synthetic-private-database-error');
      },
      async batch() {
        databaseCalls++;
        throw new Error('synthetic-private-database-error');
      },
    },
    ASSETS: {
      async fetch() {
        assetCalls++;
        return new Response('static fixture');
      },
    },
    PULSE_CONFIG: raw,
    PULSE_API_TOKEN: token,
  };
  return { env, counts: () => ({ databaseCalls, assetCalls }) };
}
for (const row of [
  { path: '/health', status: 200 },
  { path: '/api/v1/projects', status: 401 },
  { path: '/', status: 303 },
  { path: '/login', status: 200 },
  { path: '/style.css', status: 200 },
]) {
  test(`cold Worker ${row.path} does not initialize D1 before authorization`, async () => {
    const { env, counts } = environment();
    const response = await worker.fetch(new Request('https://pulse.example' + row.path), env);
    assert.equal(response.status, row.status);
    assert.equal(counts().databaseCalls, 0);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
}
test('missing API token locks an unconfigured Worker without parsing private configuration', async () => {
  const { env, counts } = environment('invalid synthetic private configuration');
  env.PULSE_API_TOKEN = '';
  const response = await worker.fetch(new Request('https://pulse.example/api/v1/projects'), env);
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'AUTH');
  assert.equal(counts().databaseCalls, 0);
});
test('valid login works before D1 availability and grants only the existing signed session', async () => {
  const { env, counts } = environment('not configured yet');
  const response = await worker.fetch(
    new Request('https://pulse.example/login', {
      method: 'POST',
      headers: { Origin: 'https://pulse.example' },
      body: new URLSearchParams({ token }),
    }),
    env,
  );
  assert.equal(response.status, 303);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.equal(counts().databaseCalls, 0);
});
test('cross-origin login and unsupported methods do not initialize D1', async () => {
  const { env, counts } = environment();
  const denied = await worker.fetch(
    new Request('https://pulse.example/login', {
      method: 'POST',
      headers: { Origin: 'https://other.example' },
      body: new URLSearchParams({ token }),
    }),
    env,
  );
  assert.equal(denied.status, 403);
  assert.equal(
    (
      await worker.fetch(
        new Request('https://pulse.example/api/v1/projects', { method: 'POST' }),
        env,
      )
    ).status,
    405,
  );
  assert.equal(counts().databaseCalls, 0);
});
test('authorized data requests still initialize storage and safely report unavailable configuration', async () => {
  const { env, counts } = environment();
  const response = await worker.fetch(
    new Request('https://pulse.example/api/v1/projects', {
      headers: { Authorization: 'Bearer ' + token },
    }),
    env,
  );
  assert.equal(response.status, 503);
  assert.ok(counts().databaseCalls > 0);
  assert.ok(!(await response.text()).includes('synthetic-private-database-error'));
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
});
test('authorized HEAD failures preserve security headers and contain no response body', async () => {
  const { env } = environment('not valid JSON');
  const response = await worker.fetch(
    new Request('https://pulse.example/api/v1/projects', {
      method: 'HEAD',
      headers: { Authorization: 'Bearer ' + token },
    }),
    env,
  );
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('a failed old initialization cannot discard a newer successful cached context', async () => {
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let fail!: (error: Error) => void;
  const blocked = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const first = environment().env;
  first.DB = {
    prepare() {
      return {
        bind() {
          return {
            async all<T>() {
              reached();
              await blocked;
              return { results: [] as T[] };
            },
          };
        },
      };
    },
    async batch() {
      reached();
      return blocked;
    },
  };
  const next = environment().env;
  let nextCalls = 0;
  // Minimal successful initialization fixture, not a full SQL implementation.
  next.DB = {
    prepare(sql) {
      nextCalls++;
      return {
        bind(...values) {
          return {
            async all<T>() {
              const schema =
                sql === 'SELECT value FROM metadata WHERE key=?' && values[0] === 'schema_version';
              return { results: (schema ? [{ value: '1' }] : []) as T[] };
            },
          };
        },
      };
    },
    async batch(statements) {
      nextCalls++;
      return statements.map(() => ({ results: [] }));
    },
  };
  const request = () =>
    new Request('https://pulse.example/api/v1/projects', {
      headers: { Authorization: 'Bearer ' + token },
    });
  const older = worker.fetch(request(), first);
  await started;
  assert.equal((await worker.fetch(request(), next)).status, 200);
  const completedCalls = nextCalls;
  assert.ok(completedCalls > 0);
  fail(new Error('synthetic-old-initialization-failure'));
  assert.equal((await older).status, 503);
  assert.equal((await worker.fetch(request(), next)).status, 200);
  assert.equal(
    nextCalls,
    completedCalls,
    'failed old context must not force healthy migrations again',
  );
});
