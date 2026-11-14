/**
 * Independent acceptance of the seams between the pinned transport and the
 * layers integrated around it: provider waits in due-time scheduling, bounded
 * probe windows, and the read-only reporting API. Real TLS on loopback where a
 * response header matters; nothing leaves the machine.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handle, type ApiContext } from '../../src/api/handler.js';
import { workerBindings } from '../../src/collectors/bindings.js';
import { parseConfig, type Config } from '../../src/config.js';
import { createPinnedTransport } from '../../src/selfhost/node-transport.js';
import {
  SYNTHETIC_LOOPBACK,
  type PinnedCall,
  type SelfHostedRuntime,
} from '../../src/selfhost/policy.js';
import { probe, sync } from '../../src/sync.js';
import { database } from '../helpers.js';
import {
  INSTANCE_HOST,
  TOKEN,
  createPki,
  hostileServer,
  respond,
  type HostileServer,
  type Pki,
  type Responder,
} from './fixture.js';

const MARKER = 'synthetic-private-upstream-content';
const ADDRESS_SETTING = 'FIXTURE_ADDRESS';
const HOUR = 3600000;
let pki: Pki;
const servers: HostileServer[] = [];
before(() => {
  pki = createPki();
});
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  pki.dispose();
});
async function serve(responder: Responder): Promise<HostileServer> {
  const server = await hostileServer(pki.leaf('good'), responder);
  servers.push(server);
  return server;
}
function installation(port: number): Config {
  return parseConfig({
    version: 1,
    settings: { maxRows: 50, lookbackDays: 14, requestTimeoutMs: 4000 },
    connections: [
      {
        id: 'analytics',
        provider: 'plausible',
        tokenEnv: 'ANALYTICS_TOKEN',
        selfHosted: {
          instance: 'fixture',
          hostname: INSTANCE_HOST,
          port,
          addressEnv: ADDRESS_SETTING,
        },
      },
    ],
    resources: [
      {
        id: 'site',
        provider: 'plausible',
        connection: 'analytics',
        instance: 'fixture',
        siteId: 'site.example.org',
        timezone: 'UTC',
      },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
}
/** Secrets that record every setting a caller looks at. */
function secrets(extra: Record<string, string> = {}) {
  const read: string[] = [];
  const values: Record<string, string> = { ANALYTICS_TOKEN: TOKEN, ...extra };
  const proxy = new Proxy(values, {
    get(target, key) {
      if (typeof key === 'string') read.push(key);
      return Reflect.get(target, key);
    },
  });
  return { proxy, read, tokenReads: () => read.filter((name) => name.endsWith('_TOKEN')).length };
}
function runtime(): { value: SelfHostedRuntime; exchanges: () => number } {
  const real = createPinnedTransport({ ca: pki.ca });
  let exchanges = 0;
  return {
    value: {
      exchange: (call: PinnedCall) => {
        exchanges++;
        return real(call);
      },
      settings: { [ADDRESS_SETTING]: '127.0.0.1' },
      [SYNTHETIC_LOOPBACK]: ['127.0.0.1'],
    },
    exchanges: () => exchanges,
  };
}
const year = (iso: string | undefined) => (iso ? Number(iso.slice(0, 4)) : undefined);

test('provider wait: a self-hosted 429 defers due-time collection, sends no credential while held, and stores only an instant', async () => {
  const started = Date.now();
  const later = (hours: number) => new Date(started + hours * HOUR);
  // [Retry-After value, hours at which it must still be held, hours at which it must be due]
  const cases: [string, string | undefined, number[], number | undefined][] = [
    ['no header', undefined, [0.5], 2],
    ['two minutes', '120', [0.5], 2],
    ['one day', '86400', [2, 23], 25],
    ['HTTP date far ahead', 'Fri, 31 Dec 9999 23:59:59 GMT', [2, 24 * 3650], undefined],
    ['twenty digits', '99999999999999999999', [2, 24 * 3650], undefined],
    ['HTTP date in the past', 'Wed, 01 Jan 2020 00:00:00 GMT', [0.5], 2],
    ['zero', '0', [0.5], 2],
    ['negative', '-86400', [0.5], 2],
    ['fraction', '86400.5', [0.5], 2],
    ['exponent', '1e9', [0.5], 2],
    ['hexadecimal', '0x15180', [0.5], 2],
    ['unit suffix', '86400s', [0.5], 2],
    ['list', '120, 99999999', [0.5], 2],
    ['words', `${MARKER}`, [0.5], 2],
  ];
  for (const [why, header, held, due] of cases) {
    const server = await serve(
      respond.status(429, header === undefined ? {} : { 'Retry-After': header }, MARKER),
    );
    const config = installation(server.port);
    const store = await database(config);
    const guard = runtime();
    const bindings = { selfHosted: guard.value };
    const vault = secrets();
    const first = await sync(config, store, vault.proxy, {
      dueOnly: true,
      now: new Date(started),
      bindings,
    });
    assert.equal(first.length, 1, why);
    assert.equal(first[0]?.status, 'failed', why);
    assert.equal(first[0]?.code, 'RATE_LIMIT', why);
    assert.equal(server.requests.length, 1, `${why}: a rate limit was retried inside the job`);
    const readsForOneJob = vault.tokenReads();
    const text = JSON.stringify(first);
    for (const secret of [TOKEN, MARKER, header && header.length > 6 ? header : MARKER])
      assert.ok(!text.includes(secret), `${why}: the result repeats upstream or secret text`);
    // Stored guidance is a representable instant, never header text.
    const rows = await store.driver.all({
      sql: "SELECT key,value FROM metadata WHERE key LIKE 'scheduler_retry:%'",
    });
    for (const row of rows) {
      const value = JSON.parse(String(row.value)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(value).sort(), ['notBefore', 'run'], why);
      const until = Date.parse(String(value.notBefore));
      assert.ok(Number.isFinite(until) && until > started, `${why}: stored instant is not ahead`);
      assert.ok(year(String(value.notBefore))! <= 9999, why);
      assert.ok(!String(row.value).includes(MARKER), why);
    }
    for (const hours of held) {
      const again = await sync(config, store, vault.proxy, {
        dueOnly: true,
        now: later(hours),
        bindings,
      });
      assert.deepEqual(again, [], `${why}: collected ${hours} h into the wait`);
    }
    assert.equal(server.requests.length, 1, `${why}: the credential was sent again while held`);
    assert.equal(guard.exchanges(), 1, why);
    assert.equal(vault.tokenReads(), readsForOneJob, `${why}: a held dataset read its credential`);
    if (due !== undefined) {
      await sync(config, store, vault.proxy, { dueOnly: true, now: later(due), bindings });
      assert.equal(server.requests.length, 2, `${why}: not due ${due} h later`);
    } else {
      // An indefinite provider wait must stay an operator-clearable state.
      const manual = await sync(config, store, vault.proxy, {
        now: new Date(started + HOUR),
        bindings,
      });
      assert.equal(manual[0]?.code, 'RATE_LIMIT', why);
      assert.equal(server.requests.length, 2, `${why}: an explicit sync could not override`);
      const after = await sync(config, store, vault.proxy, {
        dueOnly: true,
        now: later(24 * 3650),
        bindings,
      });
      assert.equal(after.length, 1, `${why}: the old wait outlived a newer explicit run`);
    }
    await server.close();
  }
});

// Open finding at 3f5fb42 (low): the transport cuts Retry-After to 64 characters and the
// client then parses the cut text, so 64 digits followed by anything become an
// indefinite wait. An over-long value should carry no guidance at all.
test(
  'provider wait: a Retry-After longer than the transport bound is ignored, not cut into a wait',
  { todo: 'open low finding: over-long Retry-After is truncated before parsing' },
  async () => {
    const started = Date.now();
    for (const header of ['9'.repeat(70), `${'9'.repeat(64)} seconds, or not`]) {
      const server = await serve(respond.status(429, { 'Retry-After': header }, MARKER));
      const config = installation(server.port);
      const store = await database(config);
      const bindings = { selfHosted: runtime().value };
      const first = await sync(config, store, secrets().proxy, {
        dueOnly: true,
        now: new Date(started),
        bindings,
      });
      assert.equal(first[0]?.code, 'RATE_LIMIT');
      assert.equal(first[0]?.retryNotBefore, undefined, 'a cut header became a stored wait');
      await sync(config, store, secrets().proxy, {
        dueOnly: true,
        now: new Date(started + 2 * HOUR),
        bindings,
      });
      assert.equal(server.requests.length, 2, 'held past the fixed backoff by a cut header');
      await server.close();
    }
  },
);

test('provider wait: only a 429 carries one; a 503 with Retry-After keeps the fixed backoff', async () => {
  const started = Date.now();
  const server = await serve(respond.status(503, { 'Retry-After': '99999999' }, MARKER));
  const config = installation(server.port);
  const store = await database(config);
  const bindings = { selfHosted: runtime().value };
  const vault = secrets();
  const first = await sync(config, store, vault.proxy, {
    dueOnly: true,
    now: new Date(started),
    bindings,
  });
  assert.equal(first[0]?.code, 'UNAVAILABLE');
  assert.equal(first[0]?.retryNotBefore, undefined);
  assert.deepEqual(await store.retryGuidance(), []);
  await sync(config, store, vault.proxy, {
    dueOnly: true,
    now: new Date(started + HOUR),
    bindings,
  });
  assert.equal(server.requests.length, 2, 'an unavailable instance was held by its own header');
});

test('probe: the window is bounded before any credential, reaches the instance exactly, and a Worker refuses it', async () => {
  const rows = {
    results: [
      { dimensions: ['2026-10-12'], metrics: [7, 3] },
      { dimensions: ['2026-10-13'], metrics: [11, 4] },
    ],
    meta: { imports_included: false },
  };
  const server = await serve(respond.json(rows));
  const config = installation(server.port);
  const guard = runtime();
  const bindings = { selfHosted: guard.value };
  const now = new Date('2026-10-14T12:00:00Z');
  for (const window of [
    { from: '2026-10-01', to: '2026-10-13' },
    { from: '2025-10-13', to: '2026-10-13' },
    { from: '2026-10-13', to: '2026-10-12' },
    { from: '2026-10-13', to: '2026-10-13T00:00:00Z' },
    { from: '../../etc', to: '2026-10-13' },
  ]) {
    const vault = secrets();
    await assert.rejects(
      probe(config, vault.proxy, { now, window, bindings }),
      (error: { code?: string }) => error.code === 'CONFIG',
      JSON.stringify(window),
    );
    assert.equal(vault.read.length, 0, 'an invalid probe window looked at a setting');
  }
  assert.equal(guard.exchanges(), 0);
  assert.equal(server.handshakes.length, 0);

  const vault = secrets();
  const window = { from: '2026-10-12', to: '2026-10-13' };
  const result = await probe(config, vault.proxy, { now, window, bindings });
  assert.equal(result.results.length, 1);
  const [row] = result.results as Record<string, unknown>[];
  assert.equal(row?.status, 'available', JSON.stringify(row));
  assert.deepEqual(row?.requestedWindow, window);
  assert.deepEqual(row?.testedWindow, window);
  assert.equal(server.requests.length, 1);
  assert.deepEqual(JSON.parse(server.requests[0]!.body).date_range, ['2026-10-12', '2026-10-13']);
  assert.ok(!JSON.stringify(result).includes(TOKEN));

  // The same probe on a Worker-shaped runtime: no transport, no credential, no fetch.
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as typeof fetch;
  try {
    const worker = secrets();
    const refused = await probe(config, worker.proxy, {
      now,
      window,
      bindings: workerBindings({}),
    });
    const [only] = refused.results as Record<string, unknown>[];
    assert.equal(only?.status, 'unavailable');
    assert.equal(only?.code, 'CONFIG');
    assert.equal(only?.testedWindow, null);
    assert.equal(worker.tokenReads(), 0);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(server.requests.length, 1);
});

test('reporting API: every route is read-only for a self-hosted source and reveals no credential, pinned address or permit', async (t) => {
  const server = await serve(respond.status(429, { 'Retry-After': '86400' }, MARKER));
  const config = installation(server.port);
  const store = await database(config);
  const guard = runtime();
  const bindings = { selfHosted: guard.value };
  const PINNED = '10.123.45.67';
  const environment = {
    [ADDRESS_SETTING]: PINNED,
    PULSE_SELFHOSTED_PRIVATE_ADDRESSES: `${PINNED},192.168.77.88`,
    PULSE_API_TOKEN: 'synthetic-reporting-token-long-enough',
  };
  // One failed, guided run so health and run listings have something to show.
  await sync(config, store, secrets().proxy, { dueOnly: true, bindings });
  assert.equal(server.requests.length, 1);
  const before = { requests: server.requests.length, exchanges: guard.exchanges() };

  const vault = secrets(environment);
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return Response.json({});
  }) as typeof fetch;
  const routes = [
    '/api/v1/connectors',
    '/api/v1/projects',
    '/api/v1/plan',
    '/api/v1/brief',
    '/api/v1/brief?format=markdown',
    '/api/v1/portfolio',
    '/api/v1/health',
    '/api/v1/runs',
    '/api/v1/metrics',
    '/api/v1/export',
    '/api/v1/projects/project/graph',
    '/api/v1/projects/project/investigation',
    '/api/v1/projects/project/source-comparison',
    '/api/v1/projects/project/report',
    '/api/v1/projects/project/report?format=csv',
    '/api/v1/projects/project/report?format=markdown',
    '/api/v1/projects/project/brief',
  ];
  let readsSoFar = 0;
  try {
    for (const withRuntime of [true, false]) {
      const context: ApiContext = {
        config,
        store,
        secrets: vault.proxy,
        apiToken: environment.PULSE_API_TOKEN,
        asset: async () => new Response('static'),
        ...(withRuntime ? { bindings } : {}),
      };
      for (const route of routes) {
        const response = await handle(
          new Request(`https://pulse.example${route}`, {
            headers: { Authorization: `Bearer ${environment.PULSE_API_TOKEN}` },
          }),
          context,
        );
        const body = await response.text();
        assert.ok(response.status < 500, `${route} answered ${response.status}`);
        // Only health may test that a credential setting exists, and only where a
        // transport exists; no other route looks at provider credentials at all.
        const looked = vault.tokenReads();
        if (!(withRuntime && route === '/api/v1/health'))
          assert.equal(looked, readsSoFar, `${route} looked at a provider credential setting`);
        readsSoFar = looked;
        for (const [what, secret] of [
          ['the provider credential', TOKEN],
          ['the pinned address', PINNED],
          ['a permitted private address', '192.168.77.88'],
          ['the reporting token', environment.PULSE_API_TOKEN],
          ['upstream response text', MARKER],
        ] as const)
          assert.ok(!body.includes(secret), `${route} reveals ${what}`);
        if (withRuntime)
          t.diagnostic(
            `${route} -> ${response.status}; instance hostname ${body.includes(INSTANCE_HOST) ? 'present' : 'absent'}; setting names ${body.includes(ADDRESS_SETTING) || body.includes('ANALYTICS_TOKEN') ? 'present' : 'absent'}`,
          );
      }
      // Writes are not a thing this API does, for any route.
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
        for (const route of ['/api/v1/runs', '/api/v1/export', '/api/v1/projects/project/report']) {
          const response = await handle(
            new Request(`https://pulse.example${route}`, {
              method,
              headers: {
                Authorization: `Bearer ${environment.PULSE_API_TOKEN}`,
                Origin: 'https://pulse.example',
              },
            }),
            context,
          );
          assert.ok(
            response.status >= 400 && response.status < 500,
            `${method} ${route} answered ${response.status}`,
          );
        }
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(server.requests.length, before.requests, 'a reporting request reached the provider');
  assert.equal(guard.exchanges(), before.exchanges);
  assert.equal(fetched, 0, 'a reporting request called fetch');
});
