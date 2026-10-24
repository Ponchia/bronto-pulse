import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.js';
import { Credentials, credentialStatus, githubAppJwt } from '../src/auth.js';
import { authorized, makeSession } from '../src/api/auth.js';
import { safeError } from '../src/errors.js';
const token = 'this-is-a-strong-synthetic-access-token';
test('provider origin allowlist prevents secret-bearing SSRF', async () => {
  let calls = 0;
  const h = new HttpClient(async () => {
    calls++;
    return new Response('{}');
  });
  await assert.rejects(h.json('http://127.0.0.1/'), /not permitted/);
  await assert.rejects(h.json('https://evil.invalid/'), /not permitted/);
  assert.equal(calls, 0);
});
test('rate limits retry boundedly and preserve JSON', async () => {
  let calls = 0;
  const h = new HttpClient(
    async (_u, init) => {
      assert.equal(init?.redirect, 'manual');
      return ++calls < 3
        ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } })
        : new Response('{"ok":true}');
    },
    1000,
    async () => {},
  );
  assert.deepEqual(await h.json('https://api.github.com/'), { ok: true });
  assert.equal(calls, 3);
});
test('long Retry-After is not slept inside a worker', async () => {
  const h = new HttpClient(
    async () => new Response('{}', { status: 429, headers: { 'retry-after': '300' } }),
    1000,
    async () => {
      throw Error('Should not sleep');
    },
  );
  await assert.rejects(h.json('https://api.github.com/'), /later collection/);
});
test('untrusted provider errors are never echoed', async () => {
  const h = new HttpClient(async () => new Response('secret-test-value', { status: 403 }));
  try {
    await h.json('https://api.github.com/');
    assert.fail();
  } catch (e) {
    assert.equal(safeError(e).code, 'PERMISSION');
    assert.ok(!safeError(e).message.includes('secret-test-value'));
  }
});
test('response-size and malformed JSON budgets fail closed', async () => {
  const big = new HttpClient(
    async () => new Response('x'.repeat(50)),
    1000,
    async () => {},
    20,
  );
  await assert.rejects(big.json('https://api.github.com/'), /byte budget/);
  const bad = new HttpClient(async () => new Response('<html>'));
  await assert.rejects(bad.json('https://api.github.com/'), /malformed JSON/);
});
test('credential inspection never reveals the token value', () => {
  const c = { id: 'g', provider: 'github' as const, tokenEnv: 'TOKEN' };
  assert.equal(credentialStatus(c, { TOKEN: token }).available, true);
  assert.ok(!JSON.stringify(credentialStatus(c, { TOKEN: token })).includes(token));
});
test('OAuth refresh posts credentials only to Google and caches access token', async () => {
  let calls = 0;
  const http = new HttpClient(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(init?.method, 'POST');
    return new Response('{"access_token":"short-lived-token","expires_in":3600}');
  });
  const credentials = new Credentials({ ID: 'id', SECRET: 'secret', REFRESH: 'refresh' }, http);
  const c = {
    id: 'g',
    provider: 'gsc' as const,
    clientIdEnv: 'ID',
    clientSecretEnv: 'SECRET',
    refreshTokenEnv: 'REFRESH',
  };
  assert.equal(await credentials.token(c), 'short-lived-token');
  assert.equal(await credentials.token(c), 'short-lived-token');
  assert.equal(calls, 1);
});
test('GitHub key validation rejects encrypted and PKCS1 forms', async () => {
  await assert.rejects(githubAppJwt('1', '-----BEGIN RSA PRIVATE KEY-----', new Date()), /PKCS8/);
});
test('authentication fails closed and ignores spoofed Access headers', async () => {
  assert.equal(
    await authorized(
      new Request('https://pulse.test', {
        headers: { 'cf-access-authenticated-user-email': 'owner@example.com' },
      }),
      token,
    ),
    false,
  );
  assert.equal(
    await authorized(
      new Request('https://pulse.test', { headers: { Authorization: `Bearer ${token}` } }),
      token,
    ),
    true,
  );
  assert.equal(await authorized(new Request('https://pulse.test'), ''), false);
});
test('signed sessions expire and reject tampering', async () => {
  const at = Date.now(),
    session = await makeSession(token, at);
  assert.equal(
    await authorized(
      new Request('https://pulse.test', { headers: { Cookie: 'pulse_session=' + session } }),
      token,
      at,
    ),
    true,
  );
  assert.equal(
    await authorized(
      new Request('https://pulse.test', { headers: { Cookie: 'pulse_session=' + session } }),
      token,
      at + 3601000,
    ),
    false,
  );
  assert.equal(
    await authorized(
      new Request('https://pulse.test', {
        headers: { Cookie: 'pulse_session=' + session.replace(/.$/, 'g') },
      }),
      token,
      at,
    ),
    false,
  );
});

for (const status of [300, 301, 302, 303, 304, 307, 308]) {
  test(`provider HTTP ${status} redirects are refused without following or retrying`, async () => {
    let calls = 0;
    let canceled = false;
    const client = new HttpClient(
      async (_url, init) => {
        calls++;
        assert.equal(init?.redirect, 'manual');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-token');
        return new Response(
          status === 304
            ? null
            : new ReadableStream({
                cancel() {
                  canceled = true;
                },
              }),
          {
            status,
            headers: { Location: 'https://untrusted.invalid/?token=private-provider-value' },
          },
        );
      },
      1000,
      async () => {
        assert.fail('Redirects must not consume retry delays');
      },
    );
    await assert.rejects(
      client.json('https://api.github.com/', {
        headers: { Authorization: 'Bearer synthetic-token' },
      }),
      (error: unknown) => {
        const safe = safeError(error);
        assert.equal(safe.code, 'REDIRECT');
        assert.equal(safe.message, 'Provider redirect refused. Verify the provider endpoint.');
        assert.ok(!JSON.stringify(safe).includes('private-provider-value'));
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(client.requests, 1);
    if (status !== 304) assert.equal(canceled, true);
  });
}

for (const scenario of [
  {
    label: 'timeout',
    cause: () => new DOMException('private-value', 'TimeoutError'),
    category: 'timeout',
  },
  {
    label: 'abort',
    cause: () => new DOMException('private-value', 'AbortError'),
    category: 'aborted',
  },
  {
    label: 'network disconnect',
    cause: () => new Error('Network connection lost'),
    category: 'connection-lost',
  },
  {
    label: 'runtime type failure',
    cause: () => new TypeError('private-value'),
    category: 'type-error',
  },
  { label: 'untrusted error', cause: () => new Error('private-value'), category: 'other' },
  { label: 'non-Error thrown', cause: () => ({ token: 'private-value' }), category: 'non-error' },
]) {
  test(`transport diagnostics classify ${scenario.label} without leaking upstream values`, async () => {
    let calls = 0;
    const http = new HttpClient(
      async () => {
        calls++;
        throw scenario.cause();
      },
      1000,
      async () => {},
    );
    await assert.rejects(
      http.json('https://api.npmjs.org/downloads/point/last-day/example'),
      (error: unknown) => {
        const safe = safeError(error);
        assert.equal(safe.code, 'NETWORK');
        assert.equal(
          safe.message,
          `Provider fetch failed (${Array(3).fill(scenario.category).join(', ')}). No upstream error content retained.`,
        );
        assert.ok(!JSON.stringify(safe).includes('private-value'));
        assert.ok(!JSON.stringify(safe).includes('https://'));
        return true;
      },
    );
    assert.equal(calls, 3);
    assert.equal(http.requests, 3);
  });
}
