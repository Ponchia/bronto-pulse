/**
 * Independent hostile acceptance of the self-hosted destination policy.
 * Written by the review lane from its own corpus; it asserts the security
 * contract (ADR 0004 and the operator's decisions of 14 Nov 2026), not the
 * implementation's own expectations. No network traffic is produced.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig, resourceIdentity, type Config, type Connection } from '../../src/config.js';
import { PulseError } from '../../src/errors.js';
import { collect } from '../../src/collectors/index.js';
import { workerBindings } from '../../src/collectors/bindings.js';
import {
  SYNTHETIC_LOOPBACK,
  admitDestination,
  classifyAddress,
  parseIpv4Literal,
  wireRequest,
  type PinnedCall,
  type SelfHostedRead,
  type SelfHostedRuntime,
} from '../../src/selfhost/policy.js';
import { createPinnedTransport } from '../../src/selfhost/node-transport.js';
import { ctx, database } from '../helpers.js';
import {
  ACCEPTED_HOSTNAMES,
  ADDRESS_VECTORS,
  REFUSED_HOSTNAMES,
  REFUSED_PLAUSIBLE_REQUESTS,
  REFUSED_PROVIDER_IDS,
  REFUSED_UMAMI_REQUESTS,
} from '../selfhosted-hostile-vectors.js';

const HOST = 'analytics.example.org';
const PERMIT = 'PULSE_SELFHOSTED_PRIVATE_ADDRESSES';
const show = (value: string) => JSON.stringify(value);

function connection(overrides: Record<string, unknown> = {}): Connection {
  return {
    id: 'analytics',
    provider: 'plausible',
    tokenEnv: 'TEST_TOKEN',
    selfHosted: { instance: 'home', hostname: HOST, port: 443, addressEnv: 'ANALYTICS_ADDRESS' },
    ...overrides,
  } as Connection;
}
/** A runtime whose transport fails the test if it is ever reached. */
function runtime(settings: Record<string, string | undefined>, extra: object = {}) {
  let exchanges = 0;
  const value = {
    exchange: async (_call: PinnedCall) => {
      exchanges++;
      throw new Error('synthetic: the transport must not be reached');
    },
    settings,
    ...extra,
  } as SelfHostedRuntime;
  return { value, exchanges: () => exchanges };
}
function admitted(address: string, settings: Record<string, string | undefined> = {}): boolean {
  try {
    const destination = admitDestination(
      connection(),
      runtime({ ANALYTICS_ADDRESS: address, ...settings }).value,
    );
    assert.equal(destination.address, address, 'an admitted address is the literal itself');
    return true;
  } catch (error) {
    assert.ok(error instanceof PulseError && error.code === 'CONFIG');
    assert.ok(!error.message.includes(address) || address === '', 'a refusal names no value');
    return false;
  }
}
function config(
  provider: 'plausible' | 'umami',
  // `null` declares a hosted connection; omitting the argument declares the default instance.
  selfHosted: Record<string, unknown> | null = {
    instance: 'home',
    hostname: HOST,
    addressEnv: 'ANALYTICS_ADDRESS',
  },
  resource: Record<string, unknown> = {},
): Config {
  return parseConfig({
    version: 1,
    settings: { maxRows: 50, lookbackDays: 14 },
    connections: [
      { id: 'analytics', provider, tokenEnv: 'TEST_TOKEN', ...(selfHosted ? { selfHosted } : {}) },
    ],
    resources: [
      {
        id: 'site',
        provider,
        connection: 'analytics',
        ...(selfHosted ? { instance: selfHosted.instance } : {}),
        ...(provider === 'plausible'
          ? { siteId: 'site.example.org', timezone: 'Europe/Madrid' }
          : { websiteId: 'website-123' }),
        ...resource,
      },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
}

test('address literals: only canonical dotted-decimal IPv4 parses, and each range has the contract verdict', () => {
  for (const [value, verdict, why] of ADDRESS_VECTORS) {
    const octets = parseIpv4Literal(value);
    if (verdict === 'malformed' || value.includes(':')) {
      assert.equal(octets, undefined, `${show(value)} must not parse (${why})`);
      continue;
    }
    assert.ok(octets, `${show(value)} is canonical and must parse (${why})`);
    const actual = classifyAddress(octets);
    const normalized = actual === 'public' || actual === 'private' ? actual : 'blocked';
    assert.equal(normalized, verdict, `${show(value)} (${why}) classified ${actual}`);
  }
});

test('admission: without a permit only public addresses pass', () => {
  for (const [value, verdict, why] of ADDRESS_VECTORS)
    assert.equal(
      admitted(value),
      verdict === 'public' && !value.includes(':'),
      `${show(value)} (${why})`,
    );
});

test('admission: the most permissive operator permit admits RFC 1918 and nothing else', () => {
  for (const [value, verdict, why] of ADDRESS_VECTORS) {
    const expected = (verdict === 'public' || verdict === 'private') && !value.includes(':');
    // The operator lists exactly the hostile value itself.
    assert.equal(admitted(value, { [PERMIT]: value }), expected, `${show(value)} (${why})`);
  }
});

test('admission: a permit is an exact-literal list and cannot be widened by notation', () => {
  const target = '10.1.2.3';
  for (const list of [
    '10.0.0.0/8',
    '10.*',
    '10.1.2.0/24',
    '*',
    'all',
    'true',
    '1',
    '0.0.0.0/0',
    '10.1.2.3 ',
    ' 10.1.2.3',
    '10.1.2.3\n',
    '10.1.2.3;',
    '010.1.2.3',
    '10.1.2.03',
    '10.1.2.4',
    '10.1.2.3,127.0.0.1',
    '10.1.2.3,169.254.169.254',
    '10.1.2.3,100.64.0.1',
    '10.1.2.3,8.8.8.8',
    '10.1.2.3,',
    ',10.1.2.3',
    '10.1.2.3,,10.1.2.4',
    '::ffff:10.1.2.3',
    '',
  ])
    assert.equal(admitted(target, { [PERMIT]: list }), false, `permit ${show(list)}`);
  assert.equal(admitted(target, { [PERMIT]: '10.1.2.3' }), true);
  assert.equal(admitted(target, { [PERMIT]: '192.168.1.1,10.1.2.3' }), true);
  // A permit never changes the verdict of a public address.
  assert.equal(admitted('1.1.1.1', { [PERMIT]: 'garbage' }), true);
});

test('loopback: no setting, string key, registry symbol or look-alike symbol admits it', () => {
  const settings = {
    ANALYTICS_ADDRESS: '127.0.0.1',
    [PERMIT]: '127.0.0.1',
    PULSE_SELFHOSTED_LOOPBACK: '127.0.0.1',
    PULSE_SELFHOSTED_SYNTHETIC_LOOPBACK: '127.0.0.1',
    PULSE_SELFHOSTED_ALLOW_LOOPBACK: '1',
    PULSE_SELFHOSTED_TEST: '1',
    NODE_ENV: 'test',
    'pulse.selfhost.synthetic-loopback': '127.0.0.1',
  };
  const description = SYNTHETIC_LOOPBACK.description!;
  for (const extra of [
    {},
    { [description]: ['127.0.0.1'] },
    { SYNTHETIC_LOOPBACK: ['127.0.0.1'] },
    { [Symbol.for(description)]: ['127.0.0.1'] },
    { [Symbol(description)]: ['127.0.0.1'] },
  ])
    assert.throws(
      () => admitDestination(connection(), runtime(settings, extra).value),
      (error) => error instanceof PulseError && error.code === 'CONFIG',
    );
  // The seam is a symbol that is not in the global registry.
  assert.equal(Symbol.keyFor(SYNTHETIC_LOOPBACK), undefined);
  // The seam admits only loopback literals it lists, never another blocked range.
  for (const blocked of ['169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '10.0.0.1'])
    assert.throws(() =>
      admitDestination(
        connection(),
        runtime({ ANALYTICS_ADDRESS: blocked }, { [SYNTHETIC_LOOPBACK]: [blocked, '127.0.0.1'] })
          .value,
      ),
    );
  assert.throws(() =>
    admitDestination(
      connection(),
      runtime({ ANALYTICS_ADDRESS: '127.0.0.2' }, { [SYNTHETIC_LOOPBACK]: ['127.0.0.1'] }).value,
    ),
  );
});

test('loopback seam: unreachable from configuration, the package entry point and the Worker environment', async () => {
  // Strict configuration objects refuse any attempt to carry an address or seam.
  for (const extra of [
    { address: '127.0.0.1' },
    { syntheticLoopback: ['127.0.0.1'] },
    { 'pulse.selfhost.synthetic-loopback': ['127.0.0.1'] },
    { allowLoopback: true },
    { private: true },
    { ca: 'synthetic' },
    { rejectUnauthorized: false },
    { insecure: true },
    { url: 'https://127.0.0.1/' },
    { baseUrl: 'https://127.0.0.1/' },
    { path: '/api/auth/login' },
    { scheme: 'http' },
    { protocol: 'http:' },
    { headers: { Host: 'evil.example' } },
    { proxy: 'http://127.0.0.1:9' },
  ])
    assert.throws(
      () =>
        config('plausible', {
          instance: 'home',
          hostname: HOST,
          addressEnv: 'ANALYTICS_ADDRESS',
          ...extra,
        }),
      (error) => error instanceof PulseError && error.code === 'CONFIG',
      `selfHosted key ${Object.keys(extra)[0]}`,
    );
  const entry = (await import('../../src/index.js')) as Record<string, unknown>;
  for (const name of Object.keys(entry))
    assert.doesNotMatch(
      name,
      /loopback|synthetic|pinnedtransport|selfhost/i,
      `package entry point exports ${name}`,
    );
  for (const value of Object.values(entry)) assert.notEqual(value, SYNTHETIC_LOOPBACK);
  // A Worker environment cannot construct the capability at all.
  const fromWorker = workerBindings({
    PULSE_SELFHOSTED: '1',
    PULSE_SELFHOSTED_PRIVATE_ADDRESSES: '10.0.0.1',
    selfHosted: runtime({}).value,
  } as never);
  assert.equal(fromWorker.selfHosted, undefined);
});

test('instance hostnames: every refused spelling fails configuration and direct admission', () => {
  for (const [hostname, why] of REFUSED_HOSTNAMES) {
    assert.throws(
      () => config('plausible', { instance: 'home', hostname, addressEnv: 'ANALYTICS_ADDRESS' }),
      (error) => error instanceof PulseError && error.code === 'CONFIG',
      `configuration accepted ${show(hostname)} (${why})`,
    );
    // An object that never passed parseConfig is re-validated at admission.
    assert.throws(
      () =>
        admitDestination(
          connection({
            selfHosted: { instance: 'home', hostname, port: 443, addressEnv: 'ANALYTICS_ADDRESS' },
          }),
          runtime({ ANALYTICS_ADDRESS: '1.1.1.1' }).value,
        ),
      (error) => error instanceof PulseError && error.code === 'CONFIG',
      `admission accepted ${show(hostname)} (${why})`,
    );
  }
  for (const hostname of ACCEPTED_HOSTNAMES) {
    const parsed = config('plausible', {
      instance: 'home',
      hostname,
      addressEnv: 'ANALYTICS_ADDRESS',
    });
    assert.equal(parsed.connections[0]?.selfHosted?.hostname, hostname);
    assert.equal(parsed.connections[0]?.selfHosted?.port, 443, 'the default port is 443');
  }
});

test('ports and address settings: only 443 or an unprivileged port, and a dedicated setting name', () => {
  const declare = (extra: Record<string, unknown>) =>
    config('umami', {
      instance: 'home',
      hostname: HOST,
      addressEnv: 'ANALYTICS_ADDRESS',
      ...extra,
    });
  for (const port of [0, 1, 22, 25, 80, 442, 444, 1023, 65536, 70000, -443, 443.5, '443', null])
    assert.throws(() => declare({ port }), PulseError, `port ${String(port)}`);
  for (const port of [443, 1024, 8443, 65535])
    assert.equal(declare({ port }).connections[0]?.selfHosted?.port, port);
  for (const addressEnv of [
    'TEST_TOKEN',
    PERMIT,
    'lowercase',
    '__proto__',
    'constructor',
    '1.1.1.1',
    'A B',
    '',
    'A=B',
  ])
    assert.throws(() => declare({ addressEnv }), PulseError, `addressEnv ${show(addressEnv)}`);
  // The same checks hold for an object that bypassed parseConfig.
  for (const port of [80, 1023, 65536, 443.5, '443', undefined])
    assert.throws(() =>
      admitDestination(
        connection({
          selfHosted: { instance: 'home', hostname: HOST, port, addressEnv: 'ANALYTICS_ADDRESS' },
        }),
        runtime({ ANALYTICS_ADDRESS: '1.1.1.1' }).value,
      ),
    );
  // Prototype members are not deployment settings.
  for (const addressEnv of ['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
    assert.throws(() =>
      admitDestination(
        connection({ selfHosted: { instance: 'home', hostname: HOST, port: 443, addressEnv } }),
        runtime({}).value,
      ),
    );
});

test('only Plausible and Umami connections may declare an instance, and site and connection must agree', () => {
  for (const provider of ['github', 'cloudflare', 'gsc'])
    assert.throws(() =>
      parseConfig({
        version: 1,
        connections: [
          {
            id: 'auth',
            provider,
            tokenEnv: 'TEST_TOKEN',
            selfHosted: { instance: 'home', hostname: HOST, addressEnv: 'ANALYTICS_ADDRESS' },
          },
        ],
        resources: [{ id: 'package', provider: 'npm', package: '@example/package' }],
        projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'package' }] }],
      }),
    );
  // A site that claims an instance its connection does not declare, and the reverse.
  assert.throws(() => config('plausible', null, { instance: 'home' }));
  assert.throws(() => config('umami', null, { instance: 'home' }));
  assert.throws(() => config('plausible', null, { instance: '' }));
  assert.throws(() =>
    config(
      'plausible',
      { instance: 'home', hostname: HOST, addressEnv: 'ANALYTICS_ADDRESS' },
      { instance: 'other' },
    ),
  );
  assert.throws(() =>
    config(
      'plausible',
      { instance: 'home', hostname: HOST, addressEnv: 'ANALYTICS_ADDRESS' },
      { instance: undefined },
    ),
  );
});

test('requests: the closed read union cannot express any refused method, path, query or header', () => {
  const plausible: SelfHostedRead = {
    variant: 'plausible-ce',
    siteId: 'site.example.org',
    from: '2026-10-12',
    to: '2026-10-13',
    limit: 51,
  };
  const umami: SelfHostedRead = {
    variant: 'umami-selfhosted',
    websiteId: 'website-123',
    startAt: 1,
    endAt: 2,
  };
  const smuggled = {
    method: 'DELETE',
    path: '/api/auth/login',
    url: 'https://evil.example/',
    target: '//evil.example/',
    headers: { Host: 'evil.example', Cookie: 'a=b' },
    body: '{"username":"admin"}',
    query: { url: '/admin' },
    hostname: 'evil.example',
    port: 22,
  };
  for (const [read, method, path] of [
    [plausible, 'POST', '/api/v2/query'],
    [umami, 'GET', '/api/websites/website-123/pageviews?startAt=1&endAt=2&timezone=UTC&unit=day'],
  ] as const) {
    for (const input of [read, { ...read, ...smuggled }, { ...smuggled, ...read }]) {
      const wire = wireRequest(input as SelfHostedRead);
      assert.deepEqual(
        Object.keys(wire).sort(),
        wire.body === undefined ? ['method', 'path'] : ['body', 'method', 'path'],
      );
      assert.equal(wire.method, method);
      assert.equal(wire.path, path);
    }
  }
  const produced = (read: SelfHostedRead) => {
    const wire = wireRequest(read);
    return `${wire.method} ${wire.path}`;
  };
  for (const [method, path] of REFUSED_PLAUSIBLE_REQUESTS)
    assert.notEqual(produced(plausible), `${method} ${path}`);
  for (const [method, path] of REFUSED_UMAMI_REQUESTS)
    assert.notEqual(produced(umami), `${method} ${path.replace('{id}', 'website-123')}`);
  // The Plausible body is the fixed read-only query: no caller field can add to it.
  const body = JSON.parse(wireRequest({ ...plausible, ...smuggled } as SelfHostedRead).body!);
  assert.deepEqual(body, {
    site_id: 'site.example.org',
    metrics: ['pageviews', 'visitors'],
    date_range: ['2026-10-12', '2026-10-13'],
    dimensions: ['time:day'],
    include: { imports: false },
    pagination: { limit: 51, offset: 0 },
  });
  // Hostile identifiers never reach a path or a body.
  for (const id of REFUSED_PROVIDER_IDS) {
    assert.throws(() => wireRequest({ ...umami, websiteId: id }), PulseError, show(id));
    assert.throws(() => wireRequest({ ...plausible, siteId: id }), PulseError, show(id));
  }
  for (const read of [
    { ...umami, startAt: -1 },
    { ...umami, endAt: 0 },
    { ...umami, startAt: 1.5 },
    { ...umami, startAt: '1&url=/admin' },
    { ...umami, endAt: Number.POSITIVE_INFINITY },
    { ...umami, variant: 'umami-cloud' },
    { ...plausible, limit: 0 },
    { ...plausible, limit: 10001 },
    { ...plausible, from: '2026-10-14' },
    { ...plausible, from: '2026-10-12","x":"y' },
    { ...plausible, variant: 'plausible' },
    { variant: '__proto__' },
    {},
  ])
    assert.throws(() => wireRequest(read as never), PulseError, JSON.stringify(read));
});

test('order: a refused destination is rejected before any credential is read or any transport is reached', async () => {
  const refusals: [string, Record<string, string | undefined>][] = [
    ['metadata address', { ANALYTICS_ADDRESS: '169.254.169.254' }],
    ['loopback', { ANALYTICS_ADDRESS: '127.0.0.1', [PERMIT]: '127.0.0.1' }],
    ['unpermitted private address', { ANALYTICS_ADDRESS: '10.0.0.1' }],
    ['IPv4-mapped literal', { ANALYTICS_ADDRESS: '::ffff:1.1.1.1' }],
    ['integer literal', { ANALYTICS_ADDRESS: '16843009' }],
    ['hostname instead of an address', { ANALYTICS_ADDRESS: HOST }],
    ['missing address', {}],
  ];
  for (const provider of ['plausible', 'umami'] as const)
    for (const [why, settings] of refusals) {
      const c = config(provider);
      const read: string[] = [];
      const secrets = new Proxy(
        { TEST_TOKEN: 'synthetic-token-that-must-not-be-read' } as Record<string, string>,
        {
          get(target, key) {
            if (typeof key === 'string') read.push(key);
            return Reflect.get(target, key);
          },
        },
      );
      const x = ctx(c, async () => {
        throw new Error('synthetic: the hosted client must not be reached');
      });
      const { Credentials } = await import('../../src/auth.js');
      x.credentials = new Credentials(secrets, x.http, () => x.now);
      const guard = runtime(settings);
      x.bindings = { selfHosted: guard.value };
      await assert.rejects(
        collect(c.resources[0]!, 'traffic', x),
        (error) => error instanceof PulseError && error.code === 'CONFIG',
        `${provider}: ${why}`,
      );
      assert.deepEqual(read, [], `${provider}: ${why} read a credential`);
      assert.equal(guard.exchanges(), 0);
      assert.equal(x.http.requests, 0);
    }
});

test('runtime: without the installation-owned transport a self-hosted source fails closed, never falling back to the hosted origin', async () => {
  for (const provider of ['plausible', 'umami'] as const) {
    const c = config(provider);
    let hosted = 0;
    const x = ctx(c, async () => {
      hosted++;
      return Response.json({});
    });
    for (const bindings of [undefined, {}, workerBindings({})]) {
      x.bindings = bindings;
      await assert.rejects(
        collect(c.resources[0]!, 'traffic', x),
        (error) => error instanceof PulseError && error.code === 'CONFIG',
      );
    }
    assert.equal(hosted, 0, 'a self-hosted source must never reach the hosted fixed origin');
    // A resource object whose instance marker was stripped still follows its connection.
    const stripped = { ...c.resources[0]!, instance: undefined } as (typeof c.resources)[number];
    await assert.rejects(collect(stripped, 'traffic', x), PulseError);
    assert.equal(hosted, 0);
  }
});

test('transport: a look-alike destination that was not admitted never reaches a socket', async () => {
  const exchange = createPinnedTransport();
  const real = admitDestination(connection(), runtime({ ANALYTICS_ADDRESS: '1.1.1.1' }).value);
  assert.ok(Object.isFrozen(real));
  const read: SelfHostedRead = {
    variant: 'plausible-ce',
    siteId: 'site.example.org',
    from: '2026-10-12',
    to: '2026-10-13',
    limit: 10,
  };
  for (const forged of [
    { ...real },
    Object.freeze({ ...real }),
    Object.freeze({ ...real, address: '127.0.0.1', addressClass: 'public' }),
    Object.create(real) as typeof real,
    JSON.parse(JSON.stringify(real)) as typeof real,
  ])
    await assert.rejects(
      exchange({
        destination: forged,
        read,
        token: 'synthetic-token',
        timeoutMs: 500,
        maximumBytes: 1024,
      }),
      (error) => error instanceof PulseError && error.code === 'CONFIG',
    );
});

test('identity: a provider instance is part of the resource identity and hosted identities are unchanged', () => {
  const hostedPlausible = config('plausible', null);
  const hostedUmami = config('umami', null);
  assert.equal(
    resourceIdentity(hostedPlausible.resources[0]!, hostedPlausible.connections),
    'plausible:site.example.org:Europe/Madrid',
  );
  assert.equal(
    resourceIdentity(hostedPlausible.resources[0]!),
    'plausible:site.example.org:Europe/Madrid',
  );
  assert.equal(resourceIdentity(hostedUmami.resources[0]!), 'umami:website-123');
  const declare = (extra: Record<string, unknown> = {}) => {
    const c = config('umami', {
      instance: 'home',
      hostname: HOST,
      addressEnv: 'ANALYTICS_ADDRESS',
      ...extra,
    });
    return resourceIdentity(c.resources[0]!, c.connections);
  };
  const base = declare();
  assert.notEqual(base, 'umami:website-123', 'a self-hosted dataset is not the hosted dataset');
  assert.notEqual(declare({ hostname: 'analytics.example.net' }), base, 'hostname is identity');
  assert.notEqual(declare({ port: 8443 }), base, 'port is identity');
  assert.notEqual(declare({ instance: 'office' }), base, 'label is identity');
  assert.equal(declare({ addressEnv: 'ANOTHER_ADDRESS' }), base, 'the pin is not identity');
  assert.equal(declare({ port: 443 }), base, 'the default port is canonical');
  // A self-hosted resource without its connection cannot pass for any identity.
  const c = config('umami');
  assert.throws(() => resourceIdentity(c.resources[0]!), PulseError);
  assert.throws(() => resourceIdentity(c.resources[0]!, []), PulseError);
});

test('identity: the store refuses to repoint an existing resource and leaves its record untouched', async () => {
  const selfHosted = { instance: 'home', hostname: HOST, addressEnv: 'ANALYTICS_ADDRESS' };
  for (const provider of ['plausible', 'umami'] as const) {
    const original = config(provider, selfHosted);
    const store = await database(original);
    const moves: [string, Config][] = [
      ['another hostname', config(provider, { ...selfHosted, hostname: 'analytics.example.net' })],
      ['another port', config(provider, { ...selfHosted, port: 8443 })],
      ['another label', config(provider, { ...selfHosted, instance: 'office' })],
      ['self-hosted to hosted', config(provider, null)],
    ];
    for (const [why, moved] of moves)
      await assert.rejects(
        store.register(moved, new Date('2026-10-15T00:00:00Z')),
        (error) => error instanceof PulseError && error.code === 'CONFLICT',
        `${provider}: ${why}`,
      );
    // Rotating only the pinned address setting keeps the same dataset.
    await store.register(
      config(provider, { ...selfHosted, addressEnv: 'ROTATED_ADDRESS' }),
      new Date('2026-10-15T00:00:00Z'),
    );
    // Hosted to self-hosted on the same resource ID is refused as well.
    const hosted = await database(config(provider, null));
    await assert.rejects(
      hosted.register(original, new Date('2026-10-15T00:00:00Z')),
      (error) => error instanceof PulseError && error.code === 'CONFLICT',
      `${provider}: hosted to self-hosted`,
    );
  }
});

test('one label names one origin: two connections cannot share a label across origins or an origin across labels', () => {
  const build = (second: Record<string, unknown>) =>
    parseConfig({
      version: 1,
      connections: [
        {
          id: 'first',
          provider: 'plausible',
          tokenEnv: 'FIRST_TOKEN',
          selfHosted: { instance: 'home', hostname: HOST, addressEnv: 'FIRST_ADDRESS' },
        },
        { id: 'second', provider: 'umami', tokenEnv: 'SECOND_TOKEN', selfHosted: second },
      ],
      resources: [
        {
          id: 'site',
          provider: 'plausible',
          connection: 'first',
          instance: 'home',
          siteId: 'site.example.org',
          timezone: 'UTC',
        },
      ],
      projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
    });
  assert.throws(() =>
    build({ instance: 'home', hostname: 'other.example.org', addressEnv: 'FIRST_ADDRESS' }),
  );
  assert.throws(() =>
    build({ instance: 'home', hostname: HOST, port: 8443, addressEnv: 'FIRST_ADDRESS' }),
  );
  assert.throws(() => build({ instance: 'office', hostname: HOST, addressEnv: 'FIRST_ADDRESS' }));
  assert.throws(() => build({ instance: 'home', hostname: HOST, addressEnv: 'SECOND_ADDRESS' }));
  build({ instance: 'office', hostname: 'other.example.org', addressEnv: 'SECOND_ADDRESS' });
});
