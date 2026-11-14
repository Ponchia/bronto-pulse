import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { connect as tcpConnect, type AddressInfo } from 'node:net';
import { createServer as createTlsServer, type Server } from 'node:tls';
import { parseConfig, type Config } from '../../src/config.js';
import { createPinnedTransport } from '../../src/selfhost/node-transport.js';
import {
  SYNTHETIC_LOOPBACK,
  admitDestination,
  type SelfHostedRuntime,
} from '../../src/selfhost/policy.js';
import { SqliteDriver } from '../../src/storage/sqlite.js';
import { Store } from '../../src/storage/store.js';
import { probe, sync } from '../../src/sync.js';
import { authority } from '../tls-fixture.js';

/**
 * Conformance of the self-hosted Umami adapter against an actual official
 * Umami release. `scripts/upstream-umami-acceptance.sh` starts the pinned
 * image with a disposable private database and passes its loopback port.
 *
 * Everything here is synthetic: the instance is created for this run, the
 * users, websites, keys and events are written by this file, and the whole
 * installation is destroyed afterwards. This is not a real account, a real
 * visitor dataset, a public certificate authority or a real network path.
 *
 * Pulse reads through its unmodified pinned transport. The only test-owned
 * pieces between Pulse and Umami are an in-memory certificate authority and a
 * byte-transparent TLS wrapper, so the transport parses the HTTP reply that
 * the upstream server itself produced.
 */
const upstreamPort = Number(process.env.PULSE_UPSTREAM_UMAMI_PORT);
if (!Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535)
  throw new Error('Run this suite through `npm run test:upstream:umami`.');
const upstream = `http://127.0.0.1:${upstreamPort}`;

/** Reserved test name: it resolves nowhere, so a lookup could never succeed. */
const HOST = 'umami.pulse-upstream.example';
const ADDRESS_SETTING = 'UMAMI_ADDRESS';
const KEY_SETTING = 'UMAMI_KEY';
const LOOPBACK = '127.0.0.1';
const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
/** Upstream's documented first-run account; it exists only inside this instance. */
const BOOTSTRAP = { username: 'admin', password: 'umami' };
const WINDOW = { from: '2026-10-01', to: '2026-10-03' };
const NOW = new Date('2026-10-14T12:00:00Z');

interface Wrapper {
  port: number;
  /** Bytes Pulse wrote, one entry per accepted TLS connection. */
  requests: string[];
  /** Bytes the upstream server wrote back, one entry per connection. */
  replies: string[];
  close(): Promise<void>;
}
/**
 * TLS on loopback in front of the plain upstream port. It copies bytes in
 * both directions and never parses, rewrites or re-frames HTTP.
 */
async function wrapper(leaf: { cert: string; key: string }): Promise<Wrapper> {
  const state: Wrapper = { port: 0, requests: [], replies: [], close: async () => {} };
  const server: Server = createTlsServer(
    { key: leaf.key, cert: leaf.cert, ALPNProtocols: ['http/1.1'] },
    (socket) => {
      const index = state.requests.push('') - 1;
      state.replies.push('');
      const backend = tcpConnect(upstreamPort, LOOPBACK);
      socket.on('data', (chunk: Buffer) => (state.requests[index] += chunk.toString('latin1')));
      backend.on('data', (chunk: Buffer) => (state.replies[index] += chunk.toString('latin1')));
      socket.pipe(backend);
      backend.pipe(socket);
      socket.on('error', () => backend.destroy());
      backend.on('error', () => socket.destroy());
    },
  );
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

/** Fixture provisioning over the private loopback port. Never used by Pulse. */
async function api(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  bearer?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${upstream}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'user-agent': BROWSER,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Some upstream failures have an empty or non-JSON body.
  }
  return { status: response.status, json };
}
async function created(path: string, body: unknown, bearer: string, field: string) {
  const reply = await api('POST', path, body, bearer);
  const value = reply.json[field];
  assert.equal(reply.status, 200, `fixture ${path} returned HTTP ${reply.status}`);
  assert.equal(typeof value, 'string', `fixture ${path} returned no ${field}`);
  return value as string;
}
async function login(account: { username: string; password: string }) {
  const reply = await api('POST', '/api/auth/login', account);
  assert.equal(reply.status, 200, 'fixture login failed');
  assert.equal(typeof reply.json.token, 'string');
  return reply.json.token as string;
}
/** One synthetic event with an explicit historical time and client address. */
async function event(website: string, at: string, address: string, name?: string) {
  const reply = await api('POST', '/api/send', {
    type: 'event',
    payload: {
      website,
      hostname: 'site.pulse-upstream.example',
      url: '/docs',
      title: 'Docs',
      language: 'en',
      screen: '1280x720',
      ip: address,
      userAgent: BROWSER,
      timestamp: Date.parse(at) / 1000,
      ...(name ? { name } : {}),
    },
  });
  // Upstream answers a discarded event (a bot, a blocked address) with 200
  // too. Only a session identity proves the row was written.
  assert.equal(reply.status, 200, `event at ${at} returned HTTP ${reply.status}`);
  assert.equal(typeof reply.json.sessionId, 'string', `event at ${at} was not recorded`);
}

interface Fixture {
  tls: Wrapper;
  runtime: SelfHostedRuntime;
  /** Administrator API key: can read every website of the instance. */
  adminKey: string;
  /** Administrator login token, the pre-API-key way to authenticate. */
  adminSession: string;
  /** API key of a second, non-administrator user who owns no website. */
  outsiderKey: string;
  siteA: string;
  siteB: string;
}
let fixture: Fixture;

before(async () => {
  const run = crypto.randomUUID().slice(0, 8);
  const adminSession = await login(BOOTSTRAP);
  const siteA = await created(
    '/api/websites',
    { name: `Synthetic A ${run}`, domain: 'a.pulse-upstream.example' },
    adminSession,
    'id',
  );
  const siteB = await created(
    '/api/websites',
    { name: `Synthetic B ${run}`, domain: 'b.pulse-upstream.example' },
    adminSession,
    'id',
  );
  const adminKey = await created('/api/me/api-keys', { name: `pulse-${run}` }, adminSession, 'key');
  const outsider = { username: `outsider-${run}`, password: crypto.randomUUID() };
  await created('/api/users', { ...outsider, role: 'user' }, adminSession, 'id');
  const outsiderKey = await created(
    '/api/me/api-keys',
    { name: `outsider-${run}` },
    await login(outsider),
    'key',
  );

  // Site A. Addresses are from the documentation range 198.51.100.0/24.
  await event(siteA, '2026-10-01T00:00:00Z', '198.51.100.1'); // first second of the window
  await event(siteA, '2026-10-01T12:00:00Z', '198.51.100.1');
  await event(siteA, '2026-10-01T23:59:59Z', '198.51.100.2'); // last second of a UTC day
  // 2026-10-02 stays empty on purpose.
  await event(siteA, '2026-10-03T08:00:00Z', '198.51.100.1');
  await event(siteA, '2026-10-03T09:00:00Z', '198.51.100.3', 'signup'); // custom event
  await event(siteA, '2026-09-30T23:59:59Z', '198.51.100.9'); // one second before the window
  await event(siteA, '2026-10-04T00:00:00Z', '198.51.100.9'); // one second after the window
  await event(siteA, '2026-02-10T12:00:00Z', '198.51.100.4'); // only a long window reaches these
  await event(siteA, '2026-02-10T13:00:00Z', '198.51.100.4');
  // Site B shares the instance and the dates but nothing else.
  for (let hour = 1; hour <= 5; hour++)
    await event(siteB, `2026-10-01T0${hour}:00:00Z`, '198.51.100.5');
  await event(siteB, '2026-10-02T10:00:00Z', '198.51.100.5');

  const ca = authority('Synthetic Pulse Upstream Acceptance Root');
  const tls = await wrapper(ca.issue({ names: [HOST] }));
  fixture = {
    tls,
    runtime: {
      exchange: createPinnedTransport({ ca: ca.certificate }),
      settings: { [ADDRESS_SETTING]: LOOPBACK },
      // Test-only admission of loopback. No setting, flag or configuration
      // field can produce this symbol; the CLI runtime never carries it.
      [SYNTHETIC_LOOPBACK]: [LOOPBACK],
    },
    adminKey,
    adminSession,
    outsiderKey,
    siteA,
    siteB,
  };
});
after(async () => {
  await fixture?.tls.close();
});

function configuration(
  sites: Record<string, string>,
  settings: Record<string, unknown> = {},
): Config {
  return parseConfig({
    version: 1,
    settings: { maxRows: 500, lookbackDays: 14, requestTimeoutMs: 20000, ...settings },
    connections: [
      {
        id: 'analytics',
        provider: 'umami',
        tokenEnv: KEY_SETTING,
        selfHosted: {
          instance: 'acceptance',
          hostname: HOST,
          port: fixture.tls.port,
          addressEnv: ADDRESS_SETTING,
        },
      },
    ],
    resources: Object.entries(sites).map(([id, websiteId]) => ({
      id,
      provider: 'umami',
      websiteId,
      connection: 'analytics',
      instance: 'acceptance',
    })),
    projects: [
      {
        id: 'project',
        label: 'Project',
        resources: Object.keys(sites).map((resource) => ({ resource })),
      },
    ],
  });
}
async function emptyStore(): Promise<Store> {
  const store = new Store(new SqliteDriver(':memory:'));
  await store.migrate();
  return store;
}
const collect = (config: Config, store: Store, key: string, window = WINDOW) =>
  sync(
    config,
    store,
    { [KEY_SETTING]: key },
    {
      now: NOW,
      window,
      bindings: { selfHosted: fixture.runtime },
      // The generic client must stay unused for a self-hosted read.
      fetcher: async () => {
        throw new Error('generic fetch must not be used for a self-hosted read');
      },
    },
  );
async function stored(store: Store, resource: string, window = WINDOW) {
  return (await store.observations(resource, window))
    .map((row) => [row.metric, row.from, row.value] as const)
    .sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`));
}
/** The request Pulse wrote, with the credential removed before any assertion prints it. */
function wire(index: number, credential: string) {
  const raw = fixture.tls.requests[index] ?? '';
  const carried = raw.includes(`\r\nAuthorization: Bearer ${credential}\r\n`);
  const [head = '', body = ''] = raw.split('\r\n\r\n');
  const [requestLine = '', ...lines] = head.split(credential).join('<credential>').split('\r\n');
  return {
    carried,
    requestLine,
    body,
    names: lines.map((line) => line.slice(0, line.indexOf(':')).toLowerCase()).sort(),
    host: lines.find((line) => /^host:/i.test(line)),
  };
}

const SITE_A = [
  ['umami.pageviews', '2026-10-01', 3],
  ['umami.pageviews', '2026-10-03', 1],
  ['umami.sessions_daily', '2026-10-01', 2],
  ['umami.sessions_daily', '2026-10-03', 1],
] as const;

test('official Umami: Pulse stores exactly the synthetic daily counts', async () => {
  const config = configuration({ site: fixture.siteA });
  const store = await emptyStore();
  const before = fixture.tls.requests.length;
  const results = await collect(config, store, fixture.adminKey);
  assert.deepEqual(
    results.map((r) => [r.resourceId, r.group, r.status, r.rows, r.requests]),
    [['site', 'traffic', 'success', 4, 1]],
  );
  // Day boundaries land on the right UTC day, the custom event and the two
  // events one second outside the window are absent, and the empty day has
  // no row: Pulse does not invent a zero the provider did not report.
  assert.deepEqual(await stored(store, 'site'), SITE_A);
  const rows = await store.observations('site', WINDOW);
  assert.ok(rows.every((row) => row.timezone === 'UTC' && row.from === row.to));

  // One connection, one request, written exactly as the closed read defines.
  assert.equal(fixture.tls.requests.length, before + 1);
  const sent = wire(before, fixture.adminKey);
  const start = Date.parse('2026-10-01T00:00:00Z');
  const end = Date.parse('2026-10-04T00:00:00Z') - 1;
  assert.equal(
    sent.requestLine,
    `GET /api/websites/${fixture.siteA}/pageviews?startAt=${start}&endAt=${end}&timezone=UTC&unit=day HTTP/1.1`,
  );
  assert.equal(sent.host, `Host: ${HOST}:${fixture.tls.port}`);
  assert.deepEqual(sent.names, ['accept', 'authorization', 'connection', 'host']);
  assert.equal(sent.carried, true);
  assert.equal(sent.body, '');

  // The reply the transport parsed is upstream's own framing.
  const reply = fixture.tls.replies[before] ?? '';
  assert.match(reply, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(reply, /\r\ncontent-type: application\/json\r\n/i);
  assert.match(reply, /\r\ntransfer-encoding: chunked\r\n/i);
  assert.doesNotMatch(reply, /\r\ncontent-encoding:/i);
});

test('official Umami: a probe reads the requested window and stores nothing', async () => {
  const config = configuration({ site: fixture.siteA });
  const before = fixture.tls.requests.length;
  const report = await probe(
    config,
    { [KEY_SETTING]: fixture.adminKey },
    { now: NOW, window: WINDOW, bindings: { selfHosted: fixture.runtime } },
  );
  assert.deepEqual([report.readOnly, report.testedJobs, report.omittedJobs], [true, 1, 0]);
  const [result] = report.results;
  assert.equal(result!.status, 'available');
  assert.deepEqual(
    [result!.rows, result!.requests, result!.requestedWindow, result!.testedWindow],
    [4, 1, WINDOW, WINDOW],
  );
  assert.equal(fixture.tls.requests.length, before + 1);
});

test('official Umami: websites on one instance stay separate datasets', async () => {
  const config = configuration({ a: fixture.siteA, b: fixture.siteB });
  const store = await emptyStore();
  const results = await collect(config, store, fixture.adminKey);
  assert.deepEqual(
    results.map((r) => [r.resourceId, r.status, r.rows]),
    [
      ['a', 'success', 4],
      ['b', 'success', 4],
    ],
  );
  assert.deepEqual(await stored(store, 'a'), SITE_A);
  assert.deepEqual(await stored(store, 'b'), [
    ['umami.pageviews', '2026-10-01', 5],
    ['umami.pageviews', '2026-10-02', 1],
    ['umami.sessions_daily', '2026-10-01', 1],
    ['umami.sessions_daily', '2026-10-02', 1],
  ]);
});

test('official Umami: a login token works as the instance credential', async () => {
  // Instances older than API keys only have login tokens. Upstream binds
  // such a token to the password, so it stops working when that changes.
  const config = configuration({ site: fixture.siteA });
  const store = await emptyStore();
  const results = await collect(config, store, fixture.adminSession);
  assert.deepEqual(
    results.map((r) => [r.status, r.rows, r.requests]),
    [['success', 4, 1]],
  );
  assert.deepEqual(await stored(store, 'site'), SITE_A);
});

test('official Umami: a rejected key fails once and keeps stored history', async () => {
  const config = configuration({ site: fixture.siteA });
  const store = await emptyStore();
  await collect(config, store, fixture.adminKey);
  const before = fixture.tls.requests.length;
  const wrong = `umami_${'0'.repeat(32)}`;
  const results = await collect(config, store, wrong);
  assert.deepEqual(
    results.map((r) => [r.status, r.code, r.rows, r.requests]),
    [['failed', 'AUTH', 0, 1]],
  );
  assert.equal(results[0]!.message, 'Self-hosted provider rejected the instance credential.');
  assert.equal(fixture.tls.requests.length, before + 1, 'no retry with a rejected credential');
  assert.match(fixture.tls.replies[before] ?? '', /^HTTP\/1\.1 401 /);
  assert.deepEqual(await stored(store, 'site'), SITE_A);
});

test('official Umami 3.5.0 answers 401, not 403, to a valid key without access', async () => {
  // Pulse can only report what the provider says. Upstream does not
  // distinguish "wrong key" from "this user cannot view this website", so
  // both surface as AUTH. docs/upstream-provider-acceptance.md records it.
  const config = configuration({ site: fixture.siteA });
  const store = await emptyStore();
  const results = await collect(config, store, fixture.outsiderKey);
  assert.deepEqual(
    results.map((r) => [r.status, r.code, r.requests]),
    [['failed', 'AUTH', 1]],
  );
  assert.deepEqual(await stored(store, 'site'), []);
});

test('official Umami 3.5.0 answers an unknown website with an empty series for an administrator', async () => {
  // A well-formed website ID that does not exist is not a 404 for an
  // administrator key: upstream returns two empty arrays. Pulse records a
  // successful run without rows, so a mistyped ID looks like a silent site.
  const config = configuration({ site: '00000000-0000-4000-8000-000000000000' });
  const store = await emptyStore();
  const results = await collect(config, store, fixture.adminKey);
  assert.deepEqual(
    results.map((r) => [r.status, r.rows, r.requests]),
    [['success', 0, 1]],
  );
  assert.deepEqual(await stored(store, 'site'), []);
  // The same ID with a non-administrator key is refused.
  const refused = await collect(config, await emptyStore(), fixture.outsiderKey);
  assert.deepEqual(
    refused.map((r) => [r.status, r.code]),
    [['failed', 'AUTH']],
  );
});

test('official Umami 3.5.0 answers a malformed website ID with HTTP 500', async () => {
  // Pulse accepts any short identifier in configuration; upstream requires a
  // UUID and fails inside its database query instead of validating.
  const config = configuration({ site: 'website-123' });
  const store = await emptyStore();
  const before = fixture.tls.requests.length;
  const results = await collect(config, store, fixture.adminKey);
  assert.deepEqual(
    results.map((r) => [r.status, r.code, r.requests]),
    [['failed', 'UNAVAILABLE', 1]],
  );
  assert.equal(results[0]!.message, 'Self-hosted provider returned HTTP 500.');
  assert.equal(fixture.tls.requests.length, before + 1);
});

test('no failure text or stored run carries the credential', async () => {
  const config = configuration({ site: fixture.siteA });
  const store = await emptyStore();
  const outcomes = [
    ...(await collect(config, store, fixture.outsiderKey)),
    ...(await collect(config, store, fixture.adminKey)),
  ];
  const archive = JSON.stringify(await store.export());
  for (const secret of [fixture.adminKey, fixture.outsiderKey, fixture.adminSession, LOOPBACK]) {
    assert.ok(!JSON.stringify(outcomes).includes(secret));
    assert.ok(!archive.includes(secret));
  }
});

// Upstream replaces the requested unit when the range spans more than seven
// calendar months (src/lib/date.ts getMinimumUnit, src/lib/request.ts
// getRequestDateRange at the pinned commit). The reply is still 200 with the
// same shape, but each bucket is a month labelled with its first day.
const LONG = { from: '2026-02-01', to: '2026-10-03' };

test('official Umami 3.5.0 keeps daily buckets up to seven calendar months', async () => {
  const config = configuration({ site: fixture.siteA }, { lookbackDays: 366 });
  const store = await emptyStore();
  const window = { from: '2026-03-01', to: '2026-10-03' };
  const results = await collect(config, store, fixture.adminKey, window);
  assert.deepEqual(
    results.map((r) => [r.status, r.rows]),
    [['success', 6]],
  );
  assert.deepEqual(await stored(store, 'site', window), [
    ['umami.pageviews', '2026-09-30', 1],
    ['umami.pageviews', '2026-10-01', 3],
    ['umami.pageviews', '2026-10-03', 1],
    ['umami.sessions_daily', '2026-09-30', 1],
    ['umami.sessions_daily', '2026-10-01', 2],
    ['umami.sessions_daily', '2026-10-03', 1],
  ]);
});

test('official Umami 3.5.0 returns monthly buckets for a longer daily request', async () => {
  // Pins the upstream behaviour itself, read through the pinned transport.
  const start = Date.parse(`${LONG.from}T00:00:00Z`);
  const end = Date.parse('2026-10-04T00:00:00Z') - 1;
  const reply = await fixture.runtime.exchange({
    destination: admitDestination(
      configuration({ site: fixture.siteA }).connections[0],
      fixture.runtime,
    ),
    read: { variant: 'umami-selfhosted', websiteId: fixture.siteA, startAt: start, endAt: end },
    token: fixture.adminKey,
    timeoutMs: 20000,
    maximumBytes: 1024 * 1024,
  });
  assert.equal(reply.status, 200);
  const series = JSON.parse(new TextDecoder().decode(reply.body)) as {
    pageviews: { x: string; y: number }[];
  };
  // The two events of 10 February come back as "1 February: 2".
  assert.deepEqual(series.pageviews, [
    { x: '2026-02-01T00:00:00Z', y: 2 },
    { x: '2026-09-01T00:00:00Z', y: 1 },
    { x: '2026-10-01T00:00:00Z', y: 4 },
  ]);
});

test('Pulse keeps true daily values across the upstream monthly-coarsening boundary', async () => {
  const config = configuration({ site: fixture.siteA }, { lookbackDays: 366 });
  const store = await emptyStore();
  const results = await collect(config, store, fixture.adminKey, LONG);
  assert.deepEqual(
    results.map((result) => [result.status, result.rows, result.requests]),
    [['success', 8, 8]],
  );
  assert.deepEqual(await stored(store, 'site', LONG), [
    ['umami.pageviews', '2026-02-10', 2],
    ['umami.pageviews', '2026-09-30', 1],
    ['umami.pageviews', '2026-10-01', 3],
    ['umami.pageviews', '2026-10-03', 1],
    ['umami.sessions_daily', '2026-02-10', 1],
    ['umami.sessions_daily', '2026-09-30', 1],
    ['umami.sessions_daily', '2026-10-01', 2],
    ['umami.sessions_daily', '2026-10-03', 1],
  ]);
});
