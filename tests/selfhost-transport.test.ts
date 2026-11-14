import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { collect } from '../src/collectors/index.js';
import { PulseError } from '../src/errors.js';
import { createPinnedTransport } from '../src/selfhost/node-transport.js';
import {
  SYNTHETIC_LOOPBACK,
  admitDestination,
  type PinnedCall,
  type SelfHostedRead,
  type SelfHostedRuntime,
} from '../src/selfhost/policy.js';
import { sync } from '../src/sync.js';
import { database, now } from './helpers.js';
import { ADDRESS_SETTING, HOST, TOKEN, context, selfHostedConfig } from './selfhost-helpers.js';
import {
  authority,
  instance,
  selfSigned,
  type Instance,
  type Leaf,
  type Seen,
} from './tls-fixture.js';

/**
 * Real sockets, real TLS, synthetic everything else. The fixture listens on
 * 127.0.0.1 only and is reached through the test-fixture seam; the instance
 * hostname resolves nowhere, so every success below also shows that the
 * transport connected to the pinned literal without any name resolution.
 */
const LOOPBACK = '127.0.0.1';
const run = promisify(execFile);
const trusted = authority();
const leaf = trusted.issue({ names: [HOST] });
/** `null` selects Node's default roots, exactly as the CLI capability does. */
function runtime(ca: string | null = trusted.certificate): SelfHostedRuntime {
  return {
    exchange: createPinnedTransport(ca === null ? {} : { ca }),
    settings: { [ADDRESS_SETTING]: LOOPBACK },
    [SYNTHETIC_LOOPBACK]: [LOOPBACK],
  };
}
const series = {
  pageviews: [{ x: '2026-10-12 00:00:00', y: 7 }],
  sessions: [{ x: '2026-10-12 00:00:00', y: 3 }],
};
const ok = (_request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(series));
};
const read: SelfHostedRead = {
  variant: 'umami-selfhosted',
  websiteId: 'website-123',
  startAt: 0,
  endAt: 86399999,
};
/** A direct transport call against one fixture, with a small byte budget. */
function call(port: number, overrides: Partial<PinnedCall> = {}, ca?: string): Promise<unknown> {
  const fixture = runtime(ca ?? trusted.certificate);
  const destination = admitDestination(selfHostedConfig('umami', { port }).connections[0], fixture);
  return fixture.exchange({
    destination,
    read,
    token: TOKEN,
    timeoutMs: 4000,
    maximumBytes: 4096,
    ...overrides,
  });
}
const messages: string[] = [];
const failure =
  (code: string, pattern: RegExp, retryable?: boolean) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof PulseError, `expected PulseError, got ${String(error)}`);
    messages.push(error.message);
    assert.equal(error.code, code, error.message);
    assert.match(error.message, pattern);
    if (retryable !== undefined) assert.equal(error.retryable, retryable, error.message);
    return true;
  };
async function withInstance<T>(
  certificate: Leaf,
  respond: (request: IncomingMessage, response: ServerResponse, seen: Seen) => void,
  body: (server: Instance) => Promise<T>,
): Promise<T> {
  const server = await instance(certificate, respond);
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

test('Umami read: pinned address, hostname as SNI and Host, fixed request, nothing else sent', async () => {
  await withInstance(leaf, ok, async (server) => {
    const c = selfHostedConfig('umami', { port: server.port });
    const x = context(c, runtime());
    const rows = await collect(c.resources[0]!, 'traffic', x);
    assert.deepEqual(
      rows.observations.map((o) => [o.metric, o.from, o.value]),
      [
        ['umami.pageviews', '2026-10-12', 7],
        ['umami.sessions_daily', '2026-10-12', 3],
      ],
    );
    assert.deepEqual([server.connections, server.handshakes, server.seen.length], [1, 1, 1]);
    const seen = server.seen[0]!;
    assert.equal(seen.serverName, HOST);
    assert.equal(seen.headers.host, `${HOST}:${server.port}`);
    assert.equal(seen.method, 'GET');
    assert.match(
      seen.url,
      /^\/api\/websites\/website-123\/pageviews\?startAt=\d+&endAt=\d+&timezone=UTC&unit=day$/,
    );
    assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(seen.body, '');
    assert.deepEqual(seen.rawHeaderNames.map((name) => name.toLowerCase()).sort(), [
      'accept',
      'authorization',
      'connection',
      'host',
    ]);
    assert.deepEqual([x.http.requests, x.genericFetches(), x.tokenReads()], [1, 0, 1]);
  });
});

test('Plausible CE read: one fixed read-only query over the same pinned connection', async () => {
  await withInstance(
    leaf,
    (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          results: [{ dimensions: ['2026-10-12'], metrics: [7, 3] }],
          meta: { imports_included: false },
        }),
      );
    },
    async (server) => {
      const c = selfHostedConfig('plausible', { port: server.port });
      const rows = await collect(c.resources[0]!, 'traffic', context(c, runtime()));
      assert.equal(rows.observations.length, 2);
      const seen = server.seen[0]!;
      assert.deepEqual([seen.method, seen.url, seen.serverName], ['POST', '/api/v2/query', HOST]);
      assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(seen.headers['content-length'], String(Buffer.byteLength(seen.body)));
      assert.deepEqual(JSON.parse(seen.body), {
        site_id: 'site.example.org',
        metrics: ['pageviews', 'visitors'],
        date_range: ['2026-10-12', '2026-10-13'],
        dimensions: ['time:day'],
        include: { imports: false },
        pagination: { limit: 51, offset: 0 },
      });
      assert.deepEqual(seen.rawHeaderNames.map((name) => name.toLowerCase()).sort(), [
        'accept',
        'authorization',
        'connection',
        'content-length',
        'content-type',
        'host',
      ]);
    },
  );
});

test('sync publishes a self-hosted run and a later failed run leaves that history intact', async () => {
  let healthy = true;
  await withInstance(
    leaf,
    (request, response) => {
      if (healthy) return ok(request, response);
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('private-upstream-body');
    },
    async (server) => {
      const c = selfHostedConfig('umami', { port: server.port });
      const store = await database(c);
      const options = {
        now,
        bindings: { selfHosted: runtime() },
        fetcher: async () => {
          throw new Error('generic fetch must not be used');
        },
      };
      const first = await sync(c, store, { TEST_TOKEN: TOKEN }, options);
      assert.deepEqual([first[0]!.status, first[0]!.rows, first[0]!.requests], ['success', 2, 1]);
      const published = await store.observedThrough();
      assert.equal(published[0]!.date, '2026-10-12');
      healthy = false;
      const second = await sync(c, store, { TEST_TOKEN: TOKEN }, options);
      assert.deepEqual(
        [second[0]!.status, second[0]!.code, second[0]!.requests],
        ['failed', 'UNAVAILABLE', 1],
      );
      assert.equal(second[0]!.message!.includes('private-upstream'), false);
      assert.deepEqual(await store.observedThrough(), published);
      // One connection per run: no pooling, no retry inside the failed job.
      assert.equal(server.connections, 2);
    },
  );
});

test('the socket follows the pin: a closed pinned port is refused and nothing is resolved', async () => {
  const placeholder = createServer();
  await new Promise<void>((resolve) => placeholder.listen(0, LOOPBACK, resolve));
  const closed = (placeholder.address() as AddressInfo).port;
  await new Promise((resolve) => placeholder.close(resolve));
  await withInstance(leaf, ok, async (server) => {
    // The same hostname with another pinned port never reaches the live fixture.
    await assert.rejects(
      call(closed),
      failure('NETWORK', /connection-refused\)\. No credential was sent/, true),
    );
    assert.equal(server.connections, 0);
  });
});

test('TLS: a certificate that does not verify for the declared hostname stops before the credential', async () => {
  const other = authority('Unrelated Synthetic Root');
  const cases: [string, Leaf, RegExp, string?][] = [
    [
      'name of another host',
      trusted.issue({ names: ['other.pulse-fixture.example'] }),
      /certificate-name/,
    ],
    [
      'address-only subject alternative name',
      trusted.issue({ addresses: [LOOPBACK] }),
      /certificate-name/,
    ],
    [
      'wildcard of another domain',
      trusted.issue({ names: ['*.other-fixture.example'] }),
      /certificate-name/,
    ],
    [
      'parent-domain wildcard that does not cover the label depth',
      trusted.issue({ names: ['*.example'] }),
      /certificate-name/,
    ],
    ['unrelated authority', other.issue({ names: [HOST] }), /certificate-untrusted/],
    ['self-signed leaf', selfSigned(HOST), /certificate-untrusted/],
    [
      'expired',
      trusted.issue({
        names: [HOST],
        notBefore: new Date(Date.now() - 48 * 3600_000),
        notAfter: new Date(Date.now() - 24 * 3600_000),
      }),
      /certificate-validity/,
    ],
    [
      'not yet valid',
      trusted.issue({
        names: [HOST],
        notBefore: new Date(Date.now() + 24 * 3600_000),
        notAfter: new Date(Date.now() + 48 * 3600_000),
      }),
      /certificate-validity/,
    ],
  ];
  for (const [label, certificate, pattern] of cases)
    await withInstance(certificate, ok, async (server) => {
      await assert.rejects(
        call(server.port),
        (error: unknown) => {
          assert.ok(error instanceof PulseError, label);
          messages.push(error.message);
          assert.equal(error.code, 'NETWORK', label);
          assert.match(error.message, pattern, label);
          assert.match(error.message, /No credential was sent/, label);
          assert.equal(error.retryable, false, label);
          return true;
        },
        label,
      );
      assert.equal(server.seen.length, 0, label);
    });
  // Without the fixture authority, Node's default roots refuse the fixture.
  await withInstance(leaf, ok, async (server) => {
    const fixture = runtime(null);
    await assert.rejects(
      fixture.exchange({
        destination: admitDestination(
          selfHostedConfig('umami', { port: server.port }).connections[0],
          fixture,
        ),
        read,
        token: TOKEN,
        timeoutMs: 4000,
        maximumBytes: 4096,
      }),
      failure('NETWORK', /certificate-untrusted\)\. No credential was sent/, false),
    );
    assert.equal(server.seen.length, 0);
  });
});

test('TLS: a process-wide verification bypass refuses the read before any connection', async () => {
  // The bypass is given to a child process only; this process never carries it.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const bypass = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' };
  await withInstance(selfSigned('other.pulse-fixture.example'), ok, async (server) => {
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', 'tests/selfhost-bypass-child.ts', String(server.port)],
      { cwd: root, env: bypass, timeout: 120000 },
    );
    const outcome = JSON.parse(stdout) as { code: string; message: string };
    messages.push(outcome.message);
    assert.equal(outcome.code, 'CONFIG', outcome.message);
    assert.match(outcome.message, /verification is disabled/);
    assert.equal(server.connections, 0);
  });
});

test('a plaintext listener on the pinned port never receives the credential', async () => {
  const received: Buffer[] = [];
  const plain = createServer((socket) => {
    socket.on('data', (chunk) => received.push(chunk));
    socket.on('error', () => {});
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}');
  });
  await new Promise<void>((resolve) => plain.listen(0, LOOPBACK, resolve));
  try {
    await assert.rejects(
      call((plain.address() as AddressInfo).port),
      failure('NETWORK', /No credential was sent/),
    );
    assert.equal(Buffer.concat(received).includes(TOKEN), false);
    assert.equal(Buffer.concat(received).includes('Bearer'), false);
  } finally {
    await new Promise((resolve) => plain.close(resolve));
  }
});

test('redirects are refused: the target is never contacted and never retained', async () => {
  // The redirect target presents a certificate that would verify for the same name.
  await withInstance(leaf, ok, async (target) => {
    for (const status of [300, 301, 302, 303, 305, 307, 308])
      await withInstance(
        leaf,
        (_request, response) => {
          response.writeHead(status, {
            Location: `https://${HOST}:${target.port}/api/websites/website-123/pageviews?token=leak-marker`,
          });
          response.end('private-upstream-body');
        },
        async (server) => {
          const c = selfHostedConfig('umami', { port: server.port });
          await assert.rejects(
            collect(c.resources[0]!, 'traffic', context(c, runtime())),
            failure('REDIRECT', /redirect refused/, false),
          );
          assert.equal(server.seen.length, 1, String(status));
        },
      );
    assert.equal(target.connections, 0);
  });
});

test('provider status classes map to fixed errors after exactly one request', async () => {
  for (const [status, code, retryable] of [
    [401, 'AUTH', false],
    [403, 'PERMISSION', false],
    [404, 'NOT_FOUND', false],
    [429, 'RATE_LIMIT', true],
    [500, 'UNAVAILABLE', false],
    [502, 'UNAVAILABLE', false],
    [503, 'UNAVAILABLE', false],
  ] as [number, string, boolean][])
    await withInstance(
      leaf,
      (_request, response) => {
        response.writeHead(status, { 'Retry-After': '1', 'Content-Type': 'application/json' });
        response.end('{"error":"private-upstream-body"}');
      },
      async (server) => {
        const c = selfHostedConfig('umami', { port: server.port });
        const x = context(c, runtime());
        await assert.rejects(
          collect(c.resources[0]!, 'traffic', x),
          failure(code, /Self-hosted provider/, retryable),
        );
        assert.deepEqual([server.seen.length, server.connections, x.http.requests], [1, 1, 1]);
      },
    );
});

test('a body delimited by connection close is read completely', async () => {
  await withInstance(
    leaf,
    (_request, response) => {
      // Neither Content-Length nor chunked framing: the close ends the body.
      response.useChunkedEncodingByDefault = false;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(series));
    },
    async (server) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const reply = (await call(server.port)) as { status: number; body: Uint8Array };
        assert.equal(reply.status, 200);
        assert.deepEqual(JSON.parse(new TextDecoder().decode(reply.body)), series);
      }
      assert.equal(server.seen[0]!.headers.connection, 'close');
    },
  );
});

test('response bounds: declared size, streamed size, encoding, headers and truncation', async () => {
  const big = JSON.stringify({ pageviews: [], sessions: [], pad: 'x'.repeat(16 * 1024) });
  await withInstance(
    leaf,
    (_request, response) => {
      response.writeHead(200, { 'Content-Length': String(Buffer.byteLength(big)) });
      response.end(big);
    },
    async (server) => {
      await assert.rejects(call(server.port), failure('ROW_LIMIT', /byte budget/));
    },
  );
  await withInstance(
    leaf,
    (_request, response) => {
      // Chunked, with no declared length: the budget applies to the stream.
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const timer = setInterval(() => response.write('x'.repeat(1024)), 5);
      response.on('close', () => clearInterval(timer));
    },
    async (server) => {
      await assert.rejects(call(server.port), failure('ROW_LIMIT', /byte budget/));
    },
  );
  await withInstance(
    leaf,
    (_request, response) => {
      response.writeHead(200, { 'Content-Encoding': 'gzip' });
      response.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    },
    async (server) => {
      await assert.rejects(call(server.port), failure('SCHEMA', /content encoding/));
      assert.equal(server.seen[0]!.headers['accept-encoding'], undefined);
    },
  );
  await withInstance(
    leaf,
    (_request, response) => {
      response.setHeader('X-Padding', 'a'.repeat(20 * 1024));
      response.end('{}');
    },
    async (server) => {
      await assert.rejects(call(server.port), failure('NETWORK', /http-protocol/, false));
    },
  );
  await withInstance(
    leaf,
    (_request, response) => {
      response.writeHead(200, { 'Content-Length': '100' });
      response.write('{"pageviews"');
      setTimeout(() => response.socket?.destroy(), 30);
    },
    async (server) => {
      await assert.rejects(
        call(server.port),
        failure('NETWORK', /The request may have been sent/, true),
      );
    },
  );
});

test('one total deadline ends a silent instance and a slow drip alike', async () => {
  const started = Date.now();
  await withInstance(
    leaf,
    () => {},
    async (server) => {
      await assert.rejects(
        call(server.port, { timeoutMs: 250 }),
        failure('NETWORK', /\(timeout\)\. The request may have been sent/, true),
      );
    },
  );
  await withInstance(
    leaf,
    (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      // Each byte would reset an idle timer; the total deadline still fires.
      const timer = setInterval(() => response.write(' '), 20);
      response.on('close', () => clearInterval(timer));
    },
    async (server) => {
      await assert.rejects(
        call(server.port, { timeoutMs: 250, maximumBytes: 1024 * 1024 }),
        failure('NETWORK', /\(timeout\)/, true),
      );
    },
  );
  // Generous bound: the point is termination, not a timing measurement.
  assert.ok(Date.now() - started < 20000);
});

test('the transport accepts only an admitted destination, a matching read and sane bounds', async () => {
  await withInstance(leaf, ok, async (server) => {
    const fixture = runtime();
    const connection = selfHostedConfig('umami', { port: server.port }).connections[0];
    const destination = admitDestination(connection, fixture);
    const base: PinnedCall = {
      destination,
      read,
      token: TOKEN,
      timeoutMs: 4000,
      maximumBytes: 4096,
    };
    for (const [label, forged] of [
      ['copy of an admitted destination', { ...destination }],
      ['hand-built destination', { ...destination, address: '169.254.169.254', port: 80 }],
      ['another hostname', { ...destination, hostname: 'evil.example' }],
      ['null', null],
    ] as [string, never][])
      await assert.rejects(
        fixture.exchange({ ...base, destination: forged }),
        failure('CONFIG', /not admitted/),
        label,
      );
    await assert.rejects(
      fixture.exchange({
        ...base,
        read: {
          variant: 'plausible-ce',
          siteId: 'site.example.org',
          from: '2026-10-12',
          to: '2026-10-12',
          limit: 5,
        },
      }),
      failure('CONFIG', /does not match/),
    );
    await assert.rejects(
      fixture.exchange({ ...base, read: { ...read, websiteId: '../../admin' } }),
      failure('CONFIG', /fixed read contract/),
    );
    for (const overrides of [
      { token: `${TOKEN}\r\nX-Injected: 1` },
      { token: '' },
      { timeoutMs: 0 },
      { timeoutMs: 600000 },
      { maximumBytes: 0 },
      { maximumBytes: Infinity },
    ])
      await assert.rejects(
        fixture.exchange({ ...base, ...overrides }),
        failure('CONFIG', /bounds or credential format/),
      );
    assert.equal(server.connections, 0);
    // The untouched admitted destination still works, on a fresh connection each time.
    await fixture.exchange(base);
    await fixture.exchange(base);
    assert.deepEqual([server.connections, server.seen.length], [2, 2]);
    assert.equal(server.seen[1]!.headers.connection, 'close');
  });
});

test('proxy settings in the environment do not redirect the pinned connection', async () => {
  const names = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ];
  const previous = names.map((name) => process.env[name]);
  await withInstance(leaf, ok, async (server) => {
    try {
      // Port 9 (discard) is closed here: any proxied attempt would fail.
      for (const name of names) process.env[name] = 'http://127.0.0.1:9';
      await call(server.port);
      assert.deepEqual([server.connections, server.seen.length], [1, 1]);
      assert.equal(server.seen[0]!.serverName, HOST);
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });
});

test('no failure message carries the credential, the address, the hostname or upstream content', () => {
  assert.ok(messages.length >= 40, `collected ${messages.length} failure messages`);
  for (const message of messages) {
    assert.equal(
      new RegExp(
        [TOKEN, 'Bearer', 'private-upstream', 'leak-marker', '127\\.0\\.0\\.1', HOST].join('|'),
      ).test(message),
      false,
      message,
    );
    assert.ok(message.length <= 400);
  }
});
