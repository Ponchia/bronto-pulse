import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, type ApiContext } from '../src/api/handler.js';
import { database, fixture, now } from './helpers.js';
const token = 'synthetic-reporting-token-long-enough';
async function setup() {
  const config = fixture(),
    store = await database(config);
  const ctx: ApiContext = {
    config,
    store,
    secrets: { TEST_TOKEN: 'never-expose-me' },
    apiToken: token,
    asset: async () => new Response('static', { headers: { 'Content-Type': 'text/html' } }),
    now: () => now,
  };
  return ctx;
}
function request(path: string, auth = true) {
  return new Request('https://pulse.example' + path, {
    headers: auth ? { Authorization: 'Bearer ' + token } : {},
  });
}
test('read-only routes require auth except minimal liveness', async () => {
  const c = await setup();
  try {
    assert.equal((await handle(request('/health', false), c)).status, 200);
    assert.equal((await handle(request('/api/v1/projects', false), c)).status, 401);
    assert.equal((await handle(request('/', false), c)).status, 303);
    assert.equal((await handle(request('/api/v1/projects'), c)).status, 200);
  } finally {
    c.store.driver.close?.();
  }
});
test('API credentials and internal bindings never appear in reports', async () => {
  const c = await setup();
  try {
    const response = await handle(request('/api/v1/health'), c),
      text = await response.text();
    assert.ok(!text.includes('never-expose-me'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  } finally {
    c.store.driver.close?.();
  }
});
test('cross-origin login is refused; valid login creates a secure httpOnly session', async () => {
  const c = await setup();
  try {
    const make = (origin: string) =>
      new Request('https://pulse.example/login', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
    assert.equal((await handle(make('https://evil.example'), c)).status, 403);
    const response = await handle(make('https://pulse.example'), c);
    assert.equal(response.status, 303);
    const cookie = response.headers.get('set-cookie')!;
    assert.ok(cookie.includes('HttpOnly'));
    assert.ok(cookie.includes('Secure'));
    assert.ok(!cookie.includes(token));
  } finally {
    c.store.driver.close?.();
  }
});
test('unsupported methods, paths and invalid date ranges fail safely', async () => {
  const c = await setup();
  try {
    assert.equal(
      (
        await handle(
          new Request('https://pulse.example/api/v1/sync', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token },
          }),
          c,
        )
      ).status,
      405,
    );
    assert.equal(
      (await handle(request('/api/v1/projects/project/report?from=2026-02-31'), c)).status,
      400,
    );
    assert.equal((await handle(request('/api/v1/projects/unknown/report'), c)).status, 404);
    assert.equal((await handle(request('/etc/passwd'), c)).status, 404);
  } finally {
    c.store.driver.close?.();
  }
});
test('missing deployment token locks the service rather than opening it', async () => {
  const c = await setup();
  try {
    assert.equal((await handle(request('/api/v1/projects'), { ...c, apiToken: '' })).status, 503);
  } finally {
    c.store.driver.close?.();
  }
});
