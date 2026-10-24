import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { accessSettings, createAccessAuthorizer, type AccessSettings } from '../src/api/access.js';
import { handle } from '../src/api/handler.js';
import { database, fixture } from './helpers.js';

const settings: AccessSettings = {
  team: 'example.cloudflareaccess.com',
  audience: 'a'.repeat(64),
  hostname: 'pulse.example.invalid',
  emails: ['owner@example.invalid'],
};
const at = new Date('2026-10-24T12:00:00Z');
const seconds = at.getTime() / 1000;
const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: 'synthetic-key',
  alg: 'RS256',
  use: 'sig',
};
async function signed(
  overrides: Record<string, unknown> = {},
  key = keys.privateKey,
): Promise<string> {
  return new SignJWT({
    iss: `https://${settings.team}`,
    aud: settings.audience,
    exp: seconds + 3600,
    iat: seconds - 5,
    sub: 'synthetic-subject',
    email: 'owner@example.invalid',
    type: 'app',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .sign(key);
}
const request = (token?: string, url = 'https://pulse.example.invalid/api/v1/projects') =>
  new Request(url, { headers: token ? { 'cf-access-jwt-assertion': token } : {} });
function verifier() {
  let calls = 0;
  return {
    authorize: createAccessAuthorizer(settings, async (url, init) => {
      calls++;
      assert.equal(String(url), 'https://example.cloudflareaccess.com/cdn-cgi/access/certs');
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      return Response.json({ keys: [jwk] });
    }),
    calls: () => calls,
  };
}

test('Access is opt-in and all partial or malformed public settings fail closed', () => {
  assert.equal(accessSettings({}), undefined);
  const complete = {
    PULSE_AUTH_MODE: 'access',
    PULSE_ACCESS_TEAM: settings.team,
    PULSE_ACCESS_AUD: settings.audience,
    PULSE_ACCESS_HOSTNAME: settings.hostname,
    PULSE_ACCESS_EMAILS: 'OWNER@example.invalid',
  };
  assert.deepEqual(accessSettings(complete), settings);
  for (const env of [
    { PULSE_AUTH_MODE: 'access' },
    { PULSE_ACCESS_AUD: settings.audience },
    { ...complete, PULSE_AUTH_MODE: 'trust-headers' },
    { ...complete, PULSE_ACCESS_TEAM: 'example.cloudflareaccess.com.evil.invalid' },
    { ...complete, PULSE_ACCESS_HOSTNAME: 'pulse.example.invalid:443' },
    { ...complete, PULSE_ACCESS_EMAILS: '' },
    { ...complete, PULSE_ACCESS_AUD: 'not-audience' },
  ])
    assert.throws(() => accessSettings(env), /incomplete or invalid/);
});

test('signed owner identity is verified and the pinned public keys are cached', async () => {
  const v = verifier();
  const token = await signed();
  assert.equal(await v.authorize(request(token), at), true);
  assert.equal(await v.authorize(request(token), at), true);
  assert.equal(v.calls(), 1);
});

test('plain identity headers, alternate host, unencrypted access and oversize JWTs never authorize', async () => {
  const v = verifier();
  assert.equal(
    await v.authorize(
      new Request('https://pulse.example.invalid/', {
        headers: { 'cf-access-authenticated-user-email': 'owner@example.invalid' },
      }),
      at,
    ),
    false,
  );
  const token = await signed();
  for (const url of [
    'https://other.example.invalid/',
    'http://pulse.example.invalid/',
    'https://pulse.example.invalid:8443/',
  ])
    assert.equal(await v.authorize(request(token, url), at), false);
  assert.equal(await v.authorize(request('x'.repeat(17000)), at), false);
  assert.equal(v.calls(), 0);
});

test('issuer, audience, expiry, future issue time, user and token kind are all enforced', async () => {
  const v = verifier();
  for (const claims of [
    { iss: 'https://attacker.cloudflareaccess.com' },
    { aud: 'b'.repeat(64) },
    { exp: seconds - 60 },
    { iat: seconds + 60 },
    { email: 'other@example.invalid' },
    { type: 'org' },
    { exp: undefined },
    { iat: undefined },
    { sub: undefined },
    { email: undefined },
  ])
    assert.equal(await v.authorize(request(await signed(claims)), at), false);
  const other = await generateKeyPair('RS256');
  assert.equal(await v.authorize(request(await signed({}, other.privateKey)), at), false);
  const symmetric = await new SignJWT({
    iss: `https://${settings.team}`,
    aud: settings.audience,
    exp: seconds + 3600,
    iat: seconds,
    sub: 'subject',
    email: 'owner@example.invalid',
    type: 'app',
  })
    .setProtectedHeader({ alg: 'HS256', kid: 'synthetic-key' })
    .sign(new Uint8Array(32));
  assert.equal(await v.authorize(request(symmetric), at), false);
});

test('unavailable, malformed, redirected and oversized key services fail without exposing content', async () => {
  const token = await signed();
  for (const response of [
    () => new Response('private-upstream-value', { status: 500 }),
    () =>
      new Response('private-upstream-value', {
        status: 302,
        headers: { Location: 'https://evil.invalid/' },
      }),
    () => new Response('not-json'),
    () => new Response('x'.repeat(66000)),
  ]) {
    const authorize = createAccessAuthorizer(settings, async () => response());
    assert.equal(await authorize(request(token), at), false);
  }
});

test('invalid Access identity cannot fall back to a bearer token or initialize private data', async () => {
  let loaded = 0;
  const result = await handle(
    new Request('https://pulse.example.invalid/api/v1/projects', {
      headers: {
        Authorization: 'Bearer synthetic-token-with-enough-length',
        'cf-access-authenticated-user-email': 'owner@example.invalid',
      },
    }),
    {
      apiToken: 'synthetic-token-with-enough-length',
      secrets: {},
      access: async () => false,
      loadData: async () => {
        loaded++;
        throw Error('Must not initialize D1');
      },
      asset: async () => new Response('not public'),
      now: () => at,
    },
  );
  assert.equal(result.status, 401);
  assert.equal(loaded, 0);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(((await result.json()) as { error: { code: string } }).error.code, 'AUTH');
});

test('Access mode serves verified reports, redirects token login, and keeps logout CSRF checks', async () => {
  const config = fixture('npm');
  const store = await database(config);
  const context = {
    config,
    store,
    secrets: {},
    apiToken: '',
    access: async () => true,
    asset: async () => new Response('private asset'),
    now: () => at,
  };
  const report = await handle(request(), context);
  assert.equal(report.status, 200);
  assert.equal(((await report.json()) as { projects: unknown[] }).projects.length, 1);
  const login = await handle(new Request('https://pulse.example.invalid/login'), context);
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('Location'), '/');
  const rejected = await handle(
    new Request('https://pulse.example.invalid/logout', {
      method: 'POST',
      headers: { Origin: 'https://evil.invalid', 'Sec-Fetch-Site': 'cross-site' },
    }),
    context,
  );
  assert.equal(rejected.status, 403);
  const logout = await handle(
    new Request('https://pulse.example.invalid/logout', {
      method: 'POST',
      headers: { Origin: 'https://pulse.example.invalid' },
    }),
    context,
  );
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get('Location'), '/cdn-cgi/access/logout');
});
