/**
 * Independent hostile acceptance of the pinned Node transport, over real TLS
 * sockets to a loopback fixture whose certificates come from the system
 * `openssl`, not from the implementation's own test helpers. Each test names
 * the contract it defends. Nothing leaves the loopback interface.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import dns from 'node:dns';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { Credentials } from '../../src/auth.js';
import { collect } from '../../src/collectors/index.js';
import { parseConfig, type Config } from '../../src/config.js';
import { PulseError } from '../../src/errors.js';
import { createPinnedTransport } from '../../src/selfhost/node-transport.js';
import {
  SYNTHETIC_LOOPBACK,
  admitDestination,
  type PinnedCall,
  type PinnedReply,
  type SelfHostedRead,
  type SelfHostedRuntime,
} from '../../src/selfhost/policy.js';
import { ctx } from '../helpers.js';
import { HOSTILE_ENVIRONMENT, REDIRECT_STATUSES } from '../selfhosted-hostile-vectors.js';
import {
  INSTANCE_HOST,
  TOKEN,
  createPki,
  hostileServer,
  respond,
  trap,
  type HostileServer,
  type LeafKind,
  type Pki,
  type Responder,
} from './fixture.js';

const MARKER = 'synthetic-private-upstream-content';
const PLAUSIBLE_ROWS = {
  results: [
    { dimensions: ['2026-10-12'], metrics: [7, 3] },
    { dimensions: ['2026-10-13'], metrics: [11, 4] },
  ],
  meta: { imports_included: false },
};
const UMAMI_ROWS = {
  pageviews: [
    { x: '2026-10-12 00:00:00', y: 7 },
    { x: '2026-10-13 00:00:00', y: 11 },
  ],
  sessions: [
    { x: '2026-10-12 00:00:00', y: 3 },
    { x: '2026-10-13 00:00:00', y: 4 },
  ],
};
const READ: SelfHostedRead = {
  variant: 'plausible-ce',
  siteId: 'site.example.org',
  from: '2026-10-12',
  to: '2026-10-13',
  limit: 51,
};

let pki: Pki;
let exchange: (call: PinnedCall) => Promise<PinnedReply>;
const servers: { close(): Promise<void> }[] = [];
before(() => {
  pki = createPki();
  exchange = createPinnedTransport({ ca: pki.ca });
});
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  pki.dispose();
});
async function serve(respondWith: Responder, kind: LeafKind = 'good'): Promise<HostileServer> {
  const server = await hostileServer(pki.leaf(kind), respondWith);
  servers.push(server);
  return server;
}
function runtime(): SelfHostedRuntime {
  return {
    exchange,
    settings: { FIXTURE_ADDRESS: '127.0.0.1' },
    [SYNTHETIC_LOOPBACK]: ['127.0.0.1'],
  };
}
function destination(port: number, provider: 'plausible' | 'umami' = 'plausible') {
  return admitDestination(
    {
      id: 'analytics',
      provider,
      tokenEnv: 'TEST_TOKEN',
      selfHosted: {
        instance: 'fixture',
        hostname: INSTANCE_HOST,
        port,
        addressEnv: 'FIXTURE_ADDRESS',
      },
    },
    runtime(),
  );
}
/** One exchange at the transport boundary. */
function call(server: { port: number }, overrides: Partial<PinnedCall> = {}): Promise<PinnedReply> {
  return exchange({
    destination: destination(server.port),
    read: READ,
    token: TOKEN,
    timeoutMs: 4000,
    maximumBytes: 64 * 1024,
    ...overrides,
  });
}
function installation(provider: 'plausible' | 'umami', port: number, timeoutMs = 4000): Config {
  return parseConfig({
    version: 1,
    settings: { maxRows: 50, lookbackDays: 14, requestTimeoutMs: timeoutMs },
    connections: [
      {
        id: 'analytics',
        provider,
        tokenEnv: 'TEST_TOKEN',
        selfHosted: {
          instance: 'fixture',
          hostname: INSTANCE_HOST,
          port,
          addressEnv: 'FIXTURE_ADDRESS',
        },
      },
    ],
    resources: [
      {
        id: 'site',
        provider,
        connection: 'analytics',
        instance: 'fixture',
        ...(provider === 'plausible'
          ? { siteId: 'site.example.org', timezone: 'Europe/Madrid' }
          : { websiteId: 'website-123' }),
      },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
}
/** A whole adapter collection, exactly as a Node job runs it. */
function collectFrom(
  server: { port: number },
  provider: 'plausible' | 'umami',
  timeoutMs?: number,
) {
  const config = installation(provider, server.port, timeoutMs);
  const x = ctx(config, async () => {
    throw new Error('synthetic: the hosted client must not be reached');
  });
  x.credentials = new Credentials({ TEST_TOKEN: TOKEN }, x.http, () => x.now);
  x.bindings = { selfHosted: runtime() };
  return collect(config.resources[0]!, 'traffic', x);
}
/** A failure must be one of ours and must carry nothing from the wire. */
function clean(code?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof PulseError, `not a PulseError: ${String(error)}`);
    if (code) assert.equal(error.code, code, error.message);
    const text = `${error.message}\n${String(error.cause ?? '')}\n${JSON.stringify(error)}`;
    for (const secret of [TOKEN, MARKER, 'evil.example', 'Location', 'Set-Cookie'])
      assert.ok(!text.includes(secret), `failure text leaks ${secret}: ${error.message}`);
    return true;
  };
}
/** Duration of an assertion. A failed assertion propagates: timing never hides it. */
const elapsed = async (work: Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await work;
  return performance.now() - started;
};
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('pin: the socket reaches the pinned address while the hostname is unresolvable, with the hostname as SNI and Host', async () => {
  const server = await serve(respond.json(PLAUSIBLE_ROWS));
  const reply = await call(server);
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(reply.body).toString()), PLAUSIBLE_ROWS);
  assert.equal(server.handshakes.length, 1);
  assert.equal(server.handshakes[0]?.localAddress, '127.0.0.1');
  assert.equal(server.handshakes[0]?.servername, INSTANCE_HOST, 'SNI is the hostname');
  assert.equal(server.handshakes[0]?.alpn, 'http/1.1', 'only HTTP/1.1 is negotiated');
  const [request] = server.requests;
  assert.equal(server.requests.length, 1);
  assert.equal(request?.method, 'POST');
  assert.equal(request?.target, '/api/v2/query');
  assert.equal(request?.version, 'HTTP/1.1');
  assert.deepEqual(server.header(request!, 'host'), [`${INSTANCE_HOST}:${server.port}`]);
  assert.deepEqual(server.header(request!, 'authorization'), [`Bearer ${TOKEN}`]);
  // Exactly the fixed header set: nothing ambient, nothing negotiable.
  assert.deepEqual(request!.headers.map(([name]) => name.toLowerCase()).sort(), [
    'accept',
    'authorization',
    'connection',
    'content-length',
    'content-type',
    'host',
  ]);
  assert.deepEqual(server.header(request!, 'connection'), ['close']);
  assert.deepEqual(JSON.parse(request!.body), {
    site_id: 'site.example.org',
    metrics: ['pageviews', 'visitors'],
    date_range: ['2026-10-12', '2026-10-13'],
    dimensions: ['time:day'],
    include: { imports: false },
    pagination: { limit: 51, offset: 0 },
  });
});

test('adapters: self-hosted Plausible and Umami collect through the pin on their own paths', async () => {
  const plausible = await serve(respond.json(PLAUSIBLE_ROWS));
  const rows = await collectFrom(plausible, 'plausible');
  assert.deepEqual(
    rows.observations.map((o) => [o.metric, o.from, o.value, o.timezone]),
    [
      ['plausible.pageviews', '2026-10-12', 7, 'Europe/Madrid'],
      ['plausible.visitors_daily', '2026-10-12', 3, 'Europe/Madrid'],
      ['plausible.pageviews', '2026-10-13', 11, 'Europe/Madrid'],
      ['plausible.visitors_daily', '2026-10-13', 4, 'Europe/Madrid'],
    ],
  );
  assert.equal(plausible.requests[0]?.target, '/api/v2/query');
  const umami = await serve(respond.json(UMAMI_ROWS));
  const series = await collectFrom(umami, 'umami');
  assert.equal(series.observations.length, 4);
  const [request] = umami.requests;
  assert.equal(request?.method, 'GET');
  const start = Date.parse('2026-10-12T00:00:00.000Z');
  const end = Date.parse('2026-10-14T00:00:00.000Z') - 1;
  assert.equal(
    request?.target,
    `/api/websites/website-123/pageviews?startAt=${start}&endAt=${end}&timezone=UTC&unit=day`,
    'self-hosted Umami uses /api, never the Cloud /v1 prefix',
  );
  assert.equal(request?.body, '');
  assert.deepEqual(request!.headers.map(([name]) => name.toLowerCase()).sort(), [
    'accept',
    'authorization',
    'connection',
    'host',
  ]);
  assert.deepEqual(umami.header(request!, 'authorization'), [`Bearer ${TOKEN}`]);
});

test('pin: no name lookup of any kind is attempted', async () => {
  // Listeners are created first: binding a server performs its own lookup of the bind address.
  const server = await serve(respond.json(PLAUSIBLE_ROWS));
  const wrong = await serve(respond.json(PLAUSIBLE_ROWS), 'wrong-name');
  const dead = await trap();
  const deadPort = dead.port;
  await dead.close();
  const lookups: string[] = [];
  const patched: [Record<string, unknown>, string, unknown][] = [];
  const spy = (holder: Record<string, unknown>, name: string) => {
    const original = holder[name];
    if (typeof original !== 'function') return;
    patched.push([holder, name, original]);
    holder[name] = function (this: unknown, ...args: unknown[]) {
      lookups.push(`${name}(${String(args[0])})`);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  };
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname']) {
    spy(dns as unknown as Record<string, unknown>, name);
    spy(dns.promises as unknown as Record<string, unknown>, name);
  }
  try {
    await call(server);
    await collectFrom(server, 'plausible');
    // Refused certificates and dead ports must not fall back to a lookup either.
    await assert.rejects(call(wrong));
    await assert.rejects(call({ port: deadPort }));
  } finally {
    for (const [holder, name, original] of patched) holder[name] = original;
  }
  assert.deepEqual(lookups, []);
  assert.equal(server.requests.length, 2);
});

for (const kind of ['wrong-name', 'address-only', 'expired', 'untrusted', 'self-signed'] as const)
  test(`TLS: a "${kind}" certificate is refused before any credential is written`, async () => {
    const server = await serve(respond.json(PLAUSIBLE_ROWS), kind);
    await assert.rejects(call(server), (error) => {
      clean('NETWORK')(error);
      assert.equal((error as PulseError).retryable, false, 'a certificate refusal is not retried');
      assert.match((error as PulseError).message, /No credential was sent/);
      return true;
    });
    await assert.rejects(collectFrom(server, 'umami'), clean('NETWORK'));
    await settle(50);
    assert.equal(server.requests.length, 0);
    assert.equal(server.received(), 0, 'no application byte may follow a refused certificate');
  });

const run = promisify(execFile);
async function child(port: number, environment: Record<string, string>) {
  const { stdout } = await run(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('./child-call.ts', import.meta.url)),
      JSON.stringify({ port, ca: pki.ca }),
    ],
    { env: { ...process.env, ...environment }, timeout: 60000 },
  );
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as {
    ok: boolean;
    status?: number;
    body?: string;
    code?: string;
    message?: string;
  };
}

test('environment: proxy variables set at process start neither carry the request nor see the credential', async () => {
  const proxy = await trap();
  servers.push(proxy);
  const server = await serve(respond.json(PLAUSIBLE_ROWS));
  const environment = Object.fromEntries(
    Object.entries(HOSTILE_ENVIRONMENT)
      .filter(([name]) => name !== 'NODE_TLS_REJECT_UNAUTHORIZED')
      .map(([name, value]) => [name, value.replace(':9', `:${proxy.port}`)]),
  );
  const result = await child(server.port, environment);
  assert.equal(proxy.connections(), 0, 'the proxy received a connection');
  assert.equal(proxy.bytes(), '');
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(JSON.parse(result.body!), PLAUSIBLE_ROWS);
  assert.equal(server.handshakes[0]?.localAddress, '127.0.0.1');
  assert.equal(server.requests.length, 1);
});

test('environment: verification disabled for the whole process still sends nothing to an unverified peer', async () => {
  // The setting is given to a child process at start, the way an operator would set it.
  for (const kind of [
    'untrusted',
    'wrong-name',
    'self-signed',
    'expired',
    'address-only',
  ] as const) {
    const server = await serve(respond.json(PLAUSIBLE_ROWS), kind);
    const result = await child(server.port, { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    assert.equal(result.ok, false, `${kind}: the read succeeded`);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.equal(server.requests.length, 0);
    assert.equal(server.received(), 0, `${kind}: a credential reached an unverified peer`);
  }
});

test('redirects: every status is refused, and no redirect target ever sees a connection', async () => {
  const proxy = await trap();
  servers.push(proxy);
  const target = await serve(respond.json(PLAUSIBLE_ROWS));
  const locations = [
    `https://${INSTANCE_HOST}:${target.port}/api/v2/query`,
    `https://evil.example:${target.port}/api/v2/query`,
    `https://127.0.0.1:${target.port}/api/v2/query`,
    `http://127.0.0.1:${proxy.port}/api/v2/query`,
    `//127.0.0.1:${target.port}/api/v2/query`,
    '/api/auth/login',
    '/api/v2/query',
  ];
  for (const status of REDIRECT_STATUSES)
    for (const location of locations) {
      const server = await serve(respond.redirect(status, location));
      const reply = await call(server);
      assert.equal(reply.status, status);
      assert.equal(reply.body.byteLength, 0, 'a redirect body is never read');
      await assert.rejects(collectFrom(server, 'plausible'), clean('REDIRECT'));
      await assert.rejects(collectFrom(server, 'umami'), clean('REDIRECT'));
      assert.equal(server.requests.length, 3, 'one request per call: no retry and no follow');
      await server.close();
    }
  assert.equal(target.handshakes.length, 0, 'a redirect target received a TLS connection');
  assert.equal(target.handshakeFailures, 0);
  assert.equal(proxy.connections(), 0, 'a plain-text redirect target received a connection');
});

test('response headers: Location, cookies and alternative services on a 200 are inert', async () => {
  const target = await serve(respond.json(PLAUSIBLE_ROWS));
  const server = await serve(
    respond.json(PLAUSIBLE_ROWS, {
      Location: `https://127.0.0.1:${target.port}/`,
      'Content-Location': `https://127.0.0.1:${target.port}/`,
      Refresh: `0; url=https://127.0.0.1:${target.port}/`,
      'Set-Cookie': 'session=synthetic; Path=/',
      'Alt-Svc': `h2="127.0.0.1:${target.port}"; ma=3600`,
      Link: `<https://127.0.0.1:${target.port}/>; rel="preconnect"`,
      'Strict-Transport-Security': 'max-age=0',
    }),
  );
  await collectFrom(server, 'plausible');
  await collectFrom(server, 'plausible');
  assert.equal(server.requests.length, 2);
  assert.equal(target.handshakes.length, 0);
  for (const request of server.requests) assert.deepEqual(server.header(request, 'cookie'), []);
});

test('statuses: each maps to a fixed category, is requested once, and its body is discarded', async () => {
  for (const [status, code, retryable] of [
    [400, 'UNAVAILABLE', false],
    [401, 'AUTH', false],
    [402, 'UNAVAILABLE', false],
    [403, 'PERMISSION', false],
    [404, 'NOT_FOUND', false],
    [429, 'RATE_LIMIT', true],
    [500, 'UNAVAILABLE', false],
    [502, 'UNAVAILABLE', false],
    [503, 'UNAVAILABLE', false],
    [201, 'UNAVAILABLE', false],
    [204, 'UNAVAILABLE', false],
    [206, 'UNAVAILABLE', false],
  ] as const) {
    const server = await serve(
      respond.status(status, { 'Retry-After': '1', 'WWW-Authenticate': MARKER }, MARKER),
    );
    for (const provider of ['plausible', 'umami'] as const)
      await assert.rejects(collectFrom(server, provider), (error) => {
        clean(code)(error);
        assert.equal((error as PulseError).retryable, retryable, `HTTP ${status}`);
        return true;
      });
    assert.equal(server.requests.length, 2, `HTTP ${status} was retried inside the job`);
    await server.close();
  }
});

test('encoding: a compressed or oddly encoded 200 is refused, never inflated', async () => {
  const json = Buffer.from(JSON.stringify(PLAUSIBLE_ROWS));
  // A small compressed body that would inflate far beyond the byte budget.
  const bomb = gzipSync(Buffer.alloc(32 * 1024 * 1024, 0x20));
  for (const [encoding, bytes] of [
    ['gzip', gzipSync(json)],
    ['GZIP', gzipSync(json)],
    ['x-gzip', gzipSync(json)],
    ['deflate', deflateSync(json)],
    ['br', brotliCompressSync(json)],
    ['gzip, identity', gzipSync(json)],
    ['identity, gzip', gzipSync(json)],
    ['gzip', bomb],
    ['zstd', json],
    ['compress', json],
  ] as const) {
    const server = await serve(respond.encoded(encoding, bytes));
    await assert.rejects(call(server), clean(), `Content-Encoding: ${encoding}`);
    await assert.rejects(collectFrom(server, 'plausible'), clean());
    await server.close();
  }
  // The request itself must not invite compression.
  const plain = await serve(respond.json(PLAUSIBLE_ROWS));
  await call(plain);
  assert.deepEqual(plain.header(plain.requests[0]!, 'accept-encoding'), []);
  assert.deepEqual(plain.header(plain.requests[0]!, 'te'), []);
});

test('size: an endless chunked body is cut at the byte budget without being buffered', async () => {
  const server = await serve(respond.endlessChunks());
  const took = await elapsed(
    assert.rejects(call(server, { maximumBytes: 256 * 1024 }), clean('ROW_LIMIT')),
  );
  assert.ok(took < 3500, `refusal took ${took} ms: it must not wait for the deadline`);
  await settle(100);
  assert.ok(
    server.written() < 16 * 1024 * 1024,
    `the server was allowed to write ${server.written()} bytes`,
  );
  assert.equal(server.open(), 0, 'the connection must be closed once the budget is exceeded');
  const adapter = await serve(respond.endlessChunks());
  await assert.rejects(collectFrom(adapter, 'plausible'), clean('ROW_LIMIT'));
});

test('size: a declared length over the budget is refused without waiting for the body', async () => {
  for (const declared of [64 * 1024 + 1, 10 * 1024 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
    const server = await serve(respond.declaredLength(declared));
    const took = await elapsed(assert.rejects(call(server), clean('ROW_LIMIT')));
    assert.ok(took < 3000, `declared ${declared}: refusal took ${took} ms`);
    await server.close();
  }
  // The adapter path has its own fixed ceiling, independent of what a caller asks for.
  const body = `{"results":[],"padding":"${'p'.repeat(2 * 1024 * 1024)}"}`;
  const honest = await serve((socket) =>
    socket.end(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    ),
  );
  await assert.rejects(collectFrom(honest, 'plausible'), clean('ROW_LIMIT'));
});

test('truncation: a body cut short is a transport failure even when the received prefix is valid JSON', async () => {
  const complete = JSON.stringify(PLAUSIBLE_ROWS);
  for (const [why, responder] of [
    ['shorter than its declared length', respond.shortBody(complete.length + 64, complete)],
    ['declared length with an empty body', respond.shortBody(complete.length, '')],
    ['reset inside a chunked body', respond.resetMidBody(complete)],
    [
      'chunked body closed without its terminating chunk',
      respond.raw(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${complete.length.toString(16)}\r\n${complete}\r\n`,
      ),
    ],
    [
      'chunk shorter than its declared size',
      respond.raw(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\nfff\r\n${complete}`,
      ),
    ],
    ['headers cut before the blank line', respond.raw('HTTP/1.1 200 OK\r\nContent-Type: applic')],
    ['closed without any response', respond.raw('')],
  ] as const) {
    const server = await serve(responder);
    await assert.rejects(call(server), clean('NETWORK'), why);
    await assert.rejects(collectFrom(server, 'plausible'), clean('NETWORK'), why);
    await server.close();
  }
});

test('deadline: one total budget covers a silent peer, slow headers and a trickled body', async () => {
  const budget = 400;
  for (const [why, responder] of [
    ['never answers', respond.silent()],
    ['one header line every 50 ms', respond.trickleHeaders(50)],
    ['one body byte every 50 ms', respond.trickle(50)],
    ['interim responses forever', respond.interim(1, respond.trickleHeaders(50))],
    ['declares a body and stalls', respond.declaredLength(1024)],
  ] as const) {
    const server = await serve(responder);
    const took = await elapsed(
      assert.rejects(call(server, { timeoutMs: budget }), (error) => {
        clean('NETWORK')(error);
        assert.equal((error as PulseError).retryable, true, why);
        return true;
      }),
    );
    assert.ok(took >= budget - 50, `${why}: ended early after ${took} ms`);
    assert.ok(took < budget + 2500, `${why}: ran ${took} ms past a ${budget} ms budget`);
    await settle(50);
    assert.equal(server.open(), 0, `${why}: the connection outlived the deadline`);
    await server.close();
  }
  // The adapter honours the configured request timeout, not a hidden longer one.
  const silent = await serve(respond.silent());
  const took = await elapsed(
    assert.rejects(collectFrom(silent, 'umami', budget), clean('NETWORK')),
  );
  assert.ok(took < budget + 2500, `adapter ran ${took} ms`);
  assert.equal(silent.requests.length, 1, 'a timeout is not retried inside the job');
});

test('deadline and bounds: values outside the fixed limits are refused before a socket exists', async () => {
  const server = await serve(respond.json(PLAUSIBLE_ROWS));
  for (const overrides of [
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 60001 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { timeoutMs: 1.5 },
    { maximumBytes: 0 },
    { maximumBytes: -1 },
    { maximumBytes: Number.NaN },
    { maximumBytes: Number.POSITIVE_INFINITY },
  ])
    await assert.rejects(call(server, overrides), clean('CONFIG'), JSON.stringify(overrides));
  await assert.rejects(
    call(server, { read: { variant: 'umami-selfhosted', websiteId: 'w', startAt: 0, endAt: 1 } }),
    clean('CONFIG'),
    'a read for another variant than the admitted instance',
  );
  assert.equal(server.handshakes.length, 0);
});

test('credential format: a token that could split or extend a header never reaches a socket', async () => {
  const server = await serve(respond.json(PLAUSIBLE_ROWS));
  for (const token of [
    '',
    'two words',
    'line\r\nX-Injected: 1',
    'line\nX-Injected: 1',
    'tab\tseparated',
    'nul\u0000byte',
    'non-ascii-é',
    'x'.repeat(4097),
    'a b',
  ]) {
    await assert.rejects(call(server, { token }), clean(), JSON.stringify(token.slice(0, 20)));
    const config = installation('plausible', server.port);
    const x = ctx(config, async () => {
      throw new Error('synthetic: the hosted client must not be reached');
    });
    x.credentials = new Credentials({ TEST_TOKEN: token }, x.http, () => x.now);
    x.bindings = { selfHosted: runtime() };
    await assert.rejects(collect(config.resources[0]!, 'traffic', x), PulseError);
  }
  await settle(50);
  assert.equal(server.handshakes.length, 0);
  assert.equal(server.received(), 0);
});

test('protocol: oversized heads, upgrades and malformed responses fail closed', async () => {
  const body = JSON.stringify(PLAUSIBLE_ROWS);
  const ok = (extra: string) =>
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n${extra}Content-Length: ${body.length}\r\n\r\n${body}`;
  for (const [why, responder] of [
    ['64 KiB response header', respond.hugeHeaders(64 * 1024)],
    ['1 MiB response header', respond.hugeHeaders(1024 * 1024)],
    ['101 Switching Protocols', respond.switchingProtocols()],
    ['not HTTP at all', respond.raw('SSH-2.0-synthetic\r\n\r\n')],
    ['HTTP/2 status line on an HTTP/1.1 connection', respond.raw('HTTP/2 200\r\n\r\n{}')],
    ['conflicting Content-Length headers', respond.raw(ok('Content-Length: 2\r\n'))],
    ['negative Content-Length', respond.raw('HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n{}')],
    ['NUL inside a header value', respond.raw(ok('X-Synthetic: a\u0000b\r\n'))],
    ['bare line feed header terminator', respond.raw('HTTP/1.1 200 OK\nContent-Length: 2\n\n{}')],
    ['status line without a status', respond.raw('HTTP/1.1  OK\r\n\r\n{}')],
  ] as const) {
    const server = await serve(responder);
    const took = await elapsed(
      assert.rejects(call(server, { timeoutMs: 1500 }), clean('NETWORK'), why),
    );
    assert.ok(took < 4000, `${why}: took ${took} ms`);
    await settle(50);
    assert.equal(server.open(), 0, `${why}: the connection stayed open`);
    await server.close();
  }
});

test('payload: hostile JSON never becomes observations', async () => {
  const bytes =
    (value: Uint8Array | string): Responder =>
    (socket) => {
      const body = Buffer.from(value);
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
      );
      socket.end(body);
    };
  const many = Array.from({ length: 60 }, (_, i) => ({
    dimensions: [`2026-10-${String(12 + (i % 2)).padStart(2, '0')}`],
    metrics: [1, 1],
  }));
  for (const [why, responder, code] of [
    ['malformed JSON', bytes('{"results":['), 'SCHEMA'],
    [
      'invalid UTF-8',
      bytes(Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])),
      'SCHEMA',
    ],
    ['null', bytes('null'), 'SCHEMA'],
    ['array', bytes('[]'), 'SCHEMA'],
    ['HTML error page with status 200', bytes(`<html>${MARKER}</html>`), 'SCHEMA'],
    ['empty body', bytes(''), 'SCHEMA'],
    ['imports included', respond.json({ results: [], meta: { imports_included: true } }), 'SCHEMA'],
    [
      'row outside the window',
      respond.json({ results: [{ dimensions: ['2026-01-01'], metrics: [1, 1] }] }),
      'SCHEMA',
    ],
    [
      'negative count',
      respond.json({ results: [{ dimensions: ['2026-10-12'], metrics: [-1, 1] }] }),
      'SCHEMA',
    ],
    [
      'fractional count',
      respond.json({ results: [{ dimensions: ['2026-10-12'], metrics: [1.5, 1] }] }),
      'SCHEMA',
    ],
    [
      'count as string',
      respond.json({ results: [{ dimensions: ['2026-10-12'], metrics: ['7', 1] }] }),
      'SCHEMA',
    ],
    [
      'duplicate day',
      respond.json({ results: [PLAUSIBLE_ROWS.results[0], PLAUSIBLE_ROWS.results[0]] }),
      'SCHEMA',
    ],
    ['more rows than the budget', respond.json({ results: many }), 'ROW_LIMIT'],
    [
      'prototype-shaped keys',
      bytes('{"__proto__":{"results":[]},"constructor":{"prototype":{}}}'),
      'SCHEMA',
    ],
  ] as const) {
    const server = await serve(responder);
    await assert.rejects(collectFrom(server, 'plausible'), clean(code), why);
    await server.close();
  }
  assert.equal(({} as { results?: unknown }).results, undefined, 'prototype was polluted');
});

test('connections: every call is one fresh connection that is closed afterwards', async () => {
  // A server that invites reuse must not get it.
  const body = JSON.stringify(PLAUSIBLE_ROWS);
  const server = await serve((socket) =>
    socket.write(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\nKeep-Alive: timeout=60\r\n\r\n${body}`,
    ),
  );
  await call(server);
  await call(server);
  await Promise.all([call(server), call(server), call(server)]);
  assert.equal(server.handshakes.length, 5);
  assert.equal(server.requests.length, 5);
  await settle(100);
  assert.equal(server.open(), 0, 'a connection was kept alive');
  // A second instance on another port never shares a socket with the first.
  const other = await serve(respond.json(UMAMI_ROWS));
  await collectFrom(other, 'umami');
  assert.equal(other.handshakes.length, 1);
  assert.equal(server.handshakes.length, 5);
});

test('unreachable: a closed port fails as a retryable transport error without sending anything', async () => {
  const dead = await trap();
  const port = dead.port;
  await dead.close();
  await assert.rejects(call({ port }), (error) => {
    clean('NETWORK')(error);
    assert.match((error as PulseError).message, /No credential was sent/);
    return true;
  });
  // A plain-text listener on the pinned port must never receive the request line or the token.
  const plain = await trap();
  servers.push(plain);
  await assert.rejects(call({ port: plain.port }, { timeoutMs: 1000 }), clean('NETWORK'));
  assert.ok(!plain.bytes().includes(TOKEN));
  assert.ok(!plain.bytes().includes('POST '), 'an HTTP request was written to a non-TLS peer');
});

test('framing: complete responses always arrive whole, and the byte budget is exact', async (t) => {
  const rows = { results: [], padding: 'p'.repeat(300 * 1024) };
  const body = JSON.stringify(rows);
  const framings: [string, Responder, boolean][] = [
    [
      'declared length, server closes',
      (socket) =>
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
        ),
      true,
    ],
    [
      'declared length, server keeps the connection open',
      (socket) =>
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        ),
      true,
    ],
    [
      'chunked in many pieces, server closes',
      (socket) => {
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n',
        );
        for (let at = 0; at < body.length; at += 7001) {
          const piece = body.slice(at, at + 7001);
          socket.write(`${piece.length.toString(16)}\r\n${piece}\r\n`);
        }
        socket.end('0\r\n\r\n');
      },
      true,
    ],
    [
      'delimited by connection close',
      (socket) => socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${body}`),
      false,
    ],
  ];
  for (const [why, responder, mustSucceed] of framings) {
    const server = await serve(responder);
    let whole = 0;
    const rounds = 25;
    for (let round = 0; round < rounds; round++) {
      const outcome = await call(server, { maximumBytes: body.length }).then(
        (reply) => Buffer.from(reply.body).toString(),
        (error: unknown) => error,
      );
      if (typeof outcome === 'string') {
        // A success is the whole body, never a prefix of it.
        assert.equal(outcome.length, body.length, `${why}: partial body returned as success`);
        assert.equal(outcome, body);
        whole++;
      } else clean('NETWORK')(outcome);
    }
    t.diagnostic(`${why}: ${whole}/${rounds} complete`);
    if (mustSucceed) assert.equal(whole, rounds, `${why}: a complete response was reported failed`);
    await server.close();
  }
  // One byte under the body length is refused; the budget is not approximate.
  const exact = await serve(framings[0]![1]);
  await assert.rejects(call(exact, { maximumBytes: body.length - 1 }), clean('ROW_LIMIT'));
  const chunked = await serve(framings[2]![1]);
  await assert.rejects(call(chunked, { maximumBytes: body.length - 1 }), clean('ROW_LIMIT'));
});

test('TLS: a peer limited to TLS 1.1 is refused', async (t) => {
  const tls = await import('node:tls');
  const leaf = pki.leaf('good');
  let server: import('node:tls').Server;
  try {
    server = tls.createServer({
      key: leaf.key,
      cert: leaf.cert,
      minVersion: 'TLSv1.1',
      maxVersion: 'TLSv1.1',
      ciphers: 'DEFAULT@SECLEVEL=0',
    });
  } catch {
    t.skip('this runtime cannot serve TLS 1.1');
    return;
  }
  let received = 0;
  server.on('secureConnection', (socket) =>
    socket.on('data', (chunk) => (received += chunk.length)),
  );
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    await assert.rejects(call({ port }, { timeoutMs: 2000 }), clean('NETWORK'));
    assert.equal(received, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
