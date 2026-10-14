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

test('brief, plan and formatted downloads are private and bounded', async () => {
  const c = await setup();
  try {
    for (const path of [
      '/api/v1/brief',
      '/api/v1/plan',
      '/api/v1/projects/project/brief',
      '/api/v1/projects/project/report?format=csv',
    ]) {
      assert.equal((await handle(request(path, false), c)).status, 401);
      const response = await handle(request(path), c);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(!(await response.text()).includes('never-expose-me'));
    }
    const csv = await handle(request('/api/v1/projects/project/report?format=csv'), c);
    assert.match(csv.headers.get('content-type')!, /text\/csv/);
    assert.match(csv.headers.get('content-disposition')!, /pulse-project-report\.csv/);
    const md = await handle(request('/api/v1/brief?format=markdown'), c);
    assert.match(await md.text(), /project briefing/);
    assert.equal(
      (await handle(request('/api/v1/projects/project/brief?format=csv'), c)).status,
      400,
    );
    assert.equal(
      (await c.store.runs()).length,
      0,
      'planning and reporting must not start collectors',
    );
  } finally {
    c.store.driver.close?.();
  }
});
test('HEAD routes authenticate normally but return no response body', async () => {
  const c = await setup();
  try {
    const response = await handle(
      new Request('https://pulse.example/api/v1/brief', {
        method: 'HEAD',
        headers: { Authorization: 'Bearer ' + token },
      }),
      c,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  } finally {
    c.store.driver.close?.();
  }
});
test('login rejects an oversized streaming request without reading the entire body', async () => {
  const c = await setup();
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(4096));
    },
    cancel() {
      cancelled = true;
    },
  });
  try {
    const req = new Request('https://pulse.example/login', {
      method: 'POST',
      headers: { Origin: 'https://pulse.example' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    assert.equal((await handle(req, c)).status, 413);
    assert.equal(cancelled, true);
    assert.ok(reads <= 5, 'body consumption must stay bounded');
  } finally {
    c.store.driver.close?.();
  }
});

for (const row of [
  { origin: 'null', site: 'same-origin', status: 303 },
  { origin: 'null', site: 'cross-site', status: 403 },
  { origin: 'null', site: 'same-site', status: 403 },
  { origin: 'null', site: undefined, status: 403 },
  { origin: 'https://evil.example', site: 'same-origin', status: 403 },
  { origin: 'https://pulse.example', site: 'cross-site', status: 403 },
  { origin: undefined, site: 'cross-site', status: 403 },
])
  test(`native sign-out origin=${row.origin} metadata=${row.site} has safe status ${row.status}`, async () => {
    const c = await setup();
    try {
      const headers: Record<string, string> = {};
      if (row.origin) headers.Origin = row.origin;
      if (row.site) headers['Sec-Fetch-Site'] = row.site;
      const response = await handle(
        new Request('https://pulse.example/logout', { method: 'POST', headers }),
        c,
      );
      assert.equal(response.status, row.status);
      if (row.status === 303) {
        assert.match(response.headers.get('set-cookie')!, /Max-Age=0; Secure/);
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      }
    } finally {
      c.store.driver.close?.();
    }
  });
test('same-origin metadata does not authenticate a login token', async () => {
  const c = await setup();
  try {
    const response = await handle(
      new Request('https://pulse.example/login', {
        method: 'POST',
        headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
        body: 'token=not-the-token',
      }),
      c,
    );
    assert.equal(response.status, 401);
  } finally {
    c.store.driver.close?.();
  }
});
