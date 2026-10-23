import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Credentials, credentialStatus, googleServiceAccountJwt } from '../src/auth.js';
import { HttpClient } from '../src/http.js';
import { inspectUrls, inspectionUrl } from '../src/inspection.js';
import { parseConfig } from '../src/config.js';
import { projectReport, markdownReport } from '../src/report.js';
import { fixture, database } from './helpers.js';

const at = new Date('2026-10-23T12:00:00Z');
const connection = { id: 'g', provider: 'gsc' as const, serviceAccountJsonEnv: 'GOOGLE_JSON' };
const pair = crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  },
  true,
  ['sign', 'verify'],
);
async function account() {
  const key = await crypto.subtle.exportKey('pkcs8', (await pair).privateKey);
  return {
    type: 'service_account',
    client_email: 'pulse@example-project.iam.gserviceaccount.com',
    private_key: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(key).toString('base64')}\n-----END PRIVATE KEY-----\n`,
    token_uri: 'https://evil.invalid/token',
    scope: 'write-everything',
    subject: 'spoofed@example.invalid',
  };
}
test('service account signs verified RS256 JWT with pinned audience, read-only scope and no delegation', async () => {
  const jwt = await googleServiceAccountJwt(JSON.stringify(await account()), at);
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
    alg: 'RS256',
    typ: 'JWT',
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()), {
    iss: 'pulse@example-project.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: at.getTime() / 1000,
    exp: at.getTime() / 1000 + 3600,
  });
  assert.equal(
    await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      (await pair).publicKey,
      Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(header + '.' + payload),
    ),
    true,
  );
});
test('service-account exchange and cache expire; explicit token keeps existing precedence', async () => {
  let calls = 0,
    clock = at.getTime();
  const raw = JSON.stringify(await account());
  const credentials = new Credentials(
    { GOOGLE_JSON: raw, TOKEN: 'synthetic-token' },
    new HttpClient(async (url, init) => {
      calls++;
      assert.equal(String(url), 'https://oauth2.googleapis.com/token');
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assert.ok(form.get('assertion')?.split('.').length === 3);
      return new Response(
        JSON.stringify({ access_token: 'synthetic-google-token', expires_in: 120 }),
      );
    }),
    () => new Date(clock),
  );
  assert.equal(credentialStatus(connection, { GOOGLE_JSON: raw }).method, 'service-account');
  assert.equal(credentialStatus(connection, {}).available, false);
  assert.equal(await credentials.token({ ...connection, tokenEnv: 'TOKEN' }), 'synthetic-token');
  assert.equal(calls, 0);
  await credentials.token(connection);
  await credentials.token(connection);
  assert.equal(calls, 1);
  clock += 61000;
  await credentials.token(connection);
  assert.equal(calls, 2);
});
test('malformed account JSON, identity and key fail with controlled errors before exchange', async () => {
  for (const raw of [
    'secret-input',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...(await account()), type: 'authorized_user' }),
    JSON.stringify({ ...(await account()), client_email: 'invalid@example.com' }),
    JSON.stringify({ ...(await account()), private_key: 'PRIVATE-SECRET-INPUT' }),
  ]) {
    await assert.rejects(googleServiceAccountJwt(raw, at), (error) => {
      assert.equal(
        (error as Error).message,
        'Google service-account JSON, signing identity or PKCS8 RSA key is invalid.',
      );
      return true;
    });
  }
  const config = fixture('gsc');
  assert.throws(
    () => parseConfig({ ...config, connections: [{ ...connection, clientIdEnv: 'CLIENT' }] }),
    /Choose service-account/,
  );
  assert.throws(
    () => parseConfig({ ...config, connections: [{ ...connection, provider: 'github' }] }),
    /requires GSC/,
  );
});
test('inspection property membership enforces host, scheme, credentials and path segment bounds', () => {
  assert.equal(
    inspectionUrl('sc-domain:example.invalid', 'https://sub.example.invalid/a'),
    'https://sub.example.invalid/a',
  );
  assert.equal(
    inspectionUrl('https://example.invalid/docs/', 'https://example.invalid/docs/a'),
    'https://example.invalid/docs/a',
  );
  for (const url of [
    'https://example.invalid.evil/a',
    'https://evil-example.invalid/a',
    'http://example.invalid/a',
    'https://x:secret@example.invalid/a',
    'https://example.invalid:8443/a',
    'https://example.invalid/a?q=secret',
    'https://example.invalid/a#fragment',
    'https://example.invalid/a%2fb',
    'https://example.invalid/a\\b',
  ])
    assert.throws(() => inspectionUrl('sc-domain:example.invalid', url), /must be HTTPS/);
  assert.throws(
    () => inspectionUrl('https://example.invalid/docs/', 'https://example.invalid/docs-evil/a'),
    /must be HTTPS/,
  );
  assert.throws(
    () => inspectionUrl('https://example.invalid/docs/', 'https://sub.example.invalid/docs/a'),
    /must be HTTPS/,
  );
});
test('inspection exact endpoint only; list is fully validated before network access', async () => {
  let calls = 0;
  const http = new HttpClient(async () => {
    calls++;
    return new Response('{}');
  });
  for (const path of [
    '/v1/sites',
    '/v1/urlInspection/index:inspect?x=1',
    '/v1/urlInspection/index:inspect#x',
  ])
    await assert.rejects(
      http.json('https://searchconsole.googleapis.com' + path, { method: 'POST' }),
      /Only the read-only/,
    );
  await assert.rejects(
    http.json('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'),
    /Only the read-only/,
  );
  const config = fixture('gsc');
  await assert.rejects(
    inspectUrls(
      config,
      'source',
      ['https://example.invalid/a', 'https://evil.invalid/a'],
      {},
      { http },
    ),
    /must be HTTPS/,
  );
  await assert.rejects(
    inspectUrls(config, 'source', Array(21).fill('https://example.invalid/a'), {}, { http }),
    /1–20/,
  );
  assert.equal(calls, 0);
});
test('normalized attempts retain canonicals/crawl/sitemaps, unknowns and failures; archive and scoped reports roundtrip', async () => {
  const config = fixture('gsc');
  let calls = 0;
  const http = new HttpClient(async (url, init) => {
    assert.equal(
      String(url),
      'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
    );
    assert.equal(JSON.parse(String(init?.body)).siteUrl, 'sc-domain:example.invalid');
    calls++;
    if (calls === 3) return new Response('private-upstream-message', { status: 403 });
    return new Response(
      JSON.stringify({
        inspectionResult:
          calls === 1
            ? {
                indexStatusResult: {
                  verdict: 'PASS',
                  coverageState: 'Submitted and indexed',
                  userCanonical: 'https://example.invalid/docs/a?private=removed',
                  googleCanonical: 'https://example.invalid/docs/a',
                  lastCrawlTime: '2026-10-22T10:00:00Z',
                  sitemap: ['https://example.invalid/sitemap.xml'],
                },
              }
            : {},
      }),
    );
  });
  const rows = await inspectUrls(
    config,
    'source',
    [
      'https://example.invalid/docs/a',
      'https://example.invalid/docs/b',
      'https://example.invalid/other',
    ],
    { TEST_TOKEN: 'synthetic' },
    { http, now: () => at },
  );
  assert.deepEqual(
    rows.map((r) => r.status),
    ['observed', 'unknown', 'error'],
  );
  assert.equal(rows[0]?.declaredCanonical, 'https://example.invalid/docs/a');
  assert.equal(rows[1]?.verdict, null);
  assert.equal(rows[1]?.sitemaps, null);
  assert.equal(rows[2]?.errorCode, 'PERMISSION');
  assert.ok(!JSON.stringify(rows).includes('private-upstream-message'));
  const store = await database(config);
  try {
    await store.addInspections(rows);
    const period = { from: '2026-10-23', to: '2026-10-23' };
    let report = await projectReport(config, store, 'project', period, at);
    assert.equal(report.inspections.length, 3);
    assert.match(markdownReport(report), /Declared canonical/);
    const archive = await store.export();
    // Restore into an independently created empty database.
    const { Store } = await import('../src/storage/store.js');
    const { SqliteDriver } = await import('../src/storage/sqlite.js');
    const restored = new Store(new SqliteDriver(':memory:'));
    try {
      await restored.migrate();
      await restored.import(archive);
      assert.deepEqual(
        await restored.inspections('source', period),
        await store.inspections('source', period),
      );
    } finally {
      restored.driver.close?.();
    }
    const scoped = parseConfig({
      ...config,
      projects: [
        {
          ...config.projects[0],
          resources: [{ resource: 'source', scope: { pathPrefix: '/docs' } }],
        },
      ],
    });
    report = await projectReport(scoped, store, 'project', period, at);
    assert.equal(report.inspections.length, 2);
    // Appending a new failed attempt retains the earlier observed record.
    await store.addInspections([{ ...rows[2]!, id: crypto.randomUUID(), url: rows[0]!.url }]);
    assert.equal(
      (await store.inspections('source', period)).filter((r) => r.url === rows[0]!.url).length,
      2,
    );
  } finally {
    store.driver.close?.();
  }
});
