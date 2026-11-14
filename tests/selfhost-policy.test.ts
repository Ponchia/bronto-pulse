import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, resourceIdentity } from '../src/config.js';
import { collect } from '../src/collectors/index.js';
import { workerBindings } from '../src/collectors/bindings.js';
import { PulseError } from '../src/errors.js';
import { connectionStatus, selfHostedJson } from '../src/selfhost/client.js';
import { nodeSelfHosted } from '../src/selfhost/node-transport.js';
import {
  PRIVATE_ADMISSION_SETTING,
  SYNTHETIC_LOOPBACK,
  admitDestination,
  classifyAddress,
  isAdmittedDestination,
  isInstanceHostname,
  isInstancePort,
  parseIpv4Literal,
  wireRequest,
  type PinnedCall,
  type PinnedReply,
  type SelfHostedRead,
  type SelfHostedRuntime,
} from '../src/selfhost/policy.js';
import { doctor, readyResource, sync } from '../src/sync.js';
import { database, now, window as period } from './helpers.js';
import { ADDRESS_SETTING, HOST, TOKEN, context, selfHostedConfig } from './selfhost-helpers.js';

const LAN = '192.168.10.20';
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function fake(
  reply: PinnedReply | ((call: PinnedCall) => PinnedReply | Promise<PinnedReply>),
  settings: Record<string, string> = { [ADDRESS_SETTING]: LAN, [PRIVATE_ADMISSION_SETTING]: LAN },
): SelfHostedRuntime & { calls: PinnedCall[] } {
  const calls: PinnedCall[] = [];
  return {
    calls,
    settings,
    exchange: async (call) => {
      calls.push(call);
      return typeof reply === 'function' ? reply(call) : reply;
    },
  };
}
const refused = (code: string, pattern?: RegExp) => (error: unknown) =>
  error instanceof PulseError && error.code === code && (!pattern || pattern.test(error.message));
const umamiSeries = {
  pageviews: [{ x: '2026-10-12 00:00:00', y: 7 }],
  sessions: [{ x: '2026-10-12 00:00:00', y: 3 }],
};

test('address literals: only canonical dotted-decimal IPv4 parses', () => {
  for (const value of ['1.1.1.1', '10.0.0.1', '255.255.255.255', '0.0.0.0'])
    assert.ok(parseIpv4Literal(value), value);
  for (const value of [
    '',
    '127.1',
    '1.1.1',
    '1.1.1.1.1',
    '2130706433',
    '0x7f000001',
    '0x7f.0.0.1',
    '0177.0.0.1',
    '010.0.0.1',
    '127.000.000.001',
    '1.1.1.01',
    '256.1.1.1',
    '1.1.1.-1',
    '+1.1.1.1',
    '1e0.1.1.1',
    '127.0.0.1.',
    '.127.0.0.1',
    ' 1.1.1.1',
    '1.1.1.1 ',
    '1.1.1.1\n',
    '1.1.1.1\u0000',
    '１.1.1.1',
    '127。0。0。1',
    '1.1.1.1:443',
    '1.1.1.1/32',
    '1.1.1.1,10.0.0.1',
    '[1.1.1.1]',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    'fd00:ec2::254',
    '2606:4700:4700::1111',
    'localhost',
    HOST,
  ])
    assert.equal(parseIpv4Literal(value), undefined, JSON.stringify(value));
  for (const value of [undefined, null, 16843009, ['1.1.1.1'], { toString: () => '1.1.1.1' }])
    assert.equal(parseIpv4Literal(value), undefined);
});

test('address classes: RFC 1918 is private, loopback is separate, special ranges are prohibited', () => {
  const verdict = (value: string) => classifyAddress(parseIpv4Literal(value)!);
  const expected: Record<string, string[]> = {
    public: [
      '1.1.1.1',
      '9.255.255.255',
      '11.0.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '126.255.255.255',
      '128.0.0.0',
      '169.253.255.255',
      '169.255.0.0',
      '172.15.255.255',
      '172.32.0.0',
      '192.167.255.255',
      '192.169.0.1',
      '223.255.255.255',
    ],
    private: [
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.0.1',
      '192.168.255.255',
    ],
    loopback: ['127.0.0.1', '127.0.0.53', '127.255.255.254'],
    prohibited: [
      '0.0.0.0',
      '0.1.2.3',
      '100.64.0.1',
      '100.100.100.200',
      '100.127.255.255',
      '169.254.0.1',
      '169.254.169.254',
      '169.254.170.2',
      '168.63.129.16',
      '192.0.0.1',
      '192.0.0.192',
      '192.0.2.1',
      '192.88.99.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
    ],
  };
  for (const [wanted, values] of Object.entries(expected))
    for (const value of values) assert.equal(verdict(value), wanted, value);
});

test('instance hostnames are exact lower-case names, never an address, URL or hosted origin', () => {
  for (const value of [
    HOST,
    'stats.team-site.example',
    'a.b.c.d.example.org',
    'xn--bcher-kva.example',
    'plausible.intranet.example.com',
  ])
    assert.ok(isInstanceHostname(value), value);
  for (const value of [
    '',
    'localhost',
    'app.localhost',
    'LOCALHOST',
    'analytics',
    'metadata',
    'metadata.google.internal',
    'metadata.goog',
    '127.0.0.1',
    '10.0.0.1',
    '127.1',
    '2130706433',
    '0x7f.0.0.1',
    'example.123',
    'example.0x7f',
    '[::1]',
    '::1',
    'analytics.example.org.',
    '.analytics.example.org',
    'analytics..example.org',
    'Analytics.Example.Org',
    'analytics.example.org:8443',
    'analytics.example.org/api',
    'analytics.example.org?x=1',
    'analytics.example.org#x',
    'user@analytics.example.org',
    'analytics.example.org@evil.example',
    'https://analytics.example.org',
    '//analytics.example.org',
    '%61nalytics.example.org',
    'analytics.example.org%00',
    'analytics.example.org\u0000',
    'analytics.example.org\r\nX-Injected: 1',
    'analytics.example.org\n',
    'analytics.example.org ',
    ' analytics.example.org',
    '*.example.org',
    '_dmarc.example.org',
    '-analytics.example.org',
    'analytics-.example.org',
    'análytics.example.org',
    'analytics.exаmple.org',
    'analytics。example。org',
    `${'a'.repeat(64)}.example.org`,
    `${'a.'.repeat(127)}org`,
    'plausible.io',
    'api.umami.is',
    'cloud.umami.is',
  ])
    assert.equal(isInstanceHostname(value), false, JSON.stringify(value));
  for (const port of [443, 1024, 8443, 65535]) assert.ok(isInstancePort(port), String(port));
  for (const port of [0, 22, 25, 80, 444, 1023, 65536, 443.5, -443, NaN, '443'])
    assert.equal(isInstancePort(port), false, String(port));
});

test('configuration: the instance block has no URL, path, scheme or verification switch', () => {
  const base = () => ({
    version: 1,
    connections: [
      {
        id: 'analytics',
        provider: 'umami',
        tokenEnv: 'TEST_TOKEN',
        selfHosted: { instance: 'home', hostname: HOST, addressEnv: ADDRESS_SETTING } as Record<
          string,
          unknown
        >,
      },
    ],
    resources: [
      {
        id: 'site',
        provider: 'umami',
        websiteId: 'website-123',
        connection: 'analytics',
        instance: 'home' as string | undefined,
      },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
  const parsed = parseConfig(base());
  assert.equal(parsed.connections[0]!.selfHosted!.port, 443);
  for (const extra of [
    { url: 'https://analytics.example.org' },
    { baseUrl: 'https://analytics.example.org/api' },
    { origin: 'https://analytics.example.org' },
    { scheme: 'http' },
    { path: '/api/admin' },
    { address: '10.0.0.1' },
    { insecure: true },
    { rejectUnauthorized: false },
    { ca: 'x' },
    { followRedirects: true },
    { headers: { Cookie: 'x' } },
    { hostname: 'analytics.example.org:8443' },
    { hostname: '127.0.0.1' },
    { hostname: 'localhost' },
    { hostname: 'plausible.io' },
    { port: 80 },
    { port: 22 },
    { port: 1023 },
    { port: '443' },
    { addressEnv: 'TEST_TOKEN' },
    { addressEnv: PRIVATE_ADMISSION_SETTING },
    { addressEnv: '10.0.0.1' },
    { instance: 'Home Instance' },
  ]) {
    const next = base();
    Object.assign(next.connections[0]!.selfHosted, extra);
    assert.throws(() => parseConfig(next), PulseError, JSON.stringify(extra));
  }
  // The site and its connection must name the same instance, or neither.
  for (const instance of [undefined, 'other']) {
    const next = base();
    next.resources[0]!.instance = instance;
    assert.throws(() => parseConfig(next), refused('CONFIG', /same self-hosted instance/));
  }
  const hostedWithInstance = base();
  delete (hostedWithInstance.connections[0] as { selfHosted?: unknown }).selfHosted;
  assert.throws(() => parseConfig(hostedWithInstance), refused('CONFIG'));
  // Only the two website analytics providers have a self-hosted variant.
  assert.throws(
    () =>
      parseConfig({
        version: 1,
        connections: [
          {
            id: 'auth',
            provider: 'github',
            tokenEnv: 'TEST_TOKEN',
            selfHosted: { instance: 'home', hostname: HOST, addressEnv: ADDRESS_SETTING },
          },
        ],
        resources: [{ id: 'source', provider: 'github', repository: 'a/b', connection: 'auth' }],
        projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'source' }] }],
      }),
    refused('CONFIG', /Only Plausible and Umami/),
  );
  // One label cannot name two origins and one origin cannot carry two labels.
  for (const second of [
    { instance: 'home', hostname: 'other.pulse-fixture.example', addressEnv: ADDRESS_SETTING },
    { instance: 'second', hostname: HOST, addressEnv: ADDRESS_SETTING },
    { instance: 'home', hostname: HOST, addressEnv: 'OTHER_ADDRESS' },
  ]) {
    const next = base();
    next.connections.push({
      id: 'analytics-two',
      provider: 'umami',
      tokenEnv: 'TEST_TOKEN',
      selfHosted: second,
    });
    assert.throws(() => parseConfig(next), refused('CONFIG', /exactly one hostname/));
  }
});

test('identity: hosted identities are unchanged; a self-hosted one binds label, hostname and port', () => {
  const hosted = parseConfig({
    version: 1,
    connections: [{ id: 'analytics', provider: 'umami', tokenEnv: 'TEST_TOKEN' }],
    resources: [
      { id: 'site', provider: 'umami', websiteId: 'website-123', connection: 'analytics' },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
  assert.equal(resourceIdentity(hosted.resources[0]!), 'umami:website-123');
  assert.equal(resourceIdentity(hosted.resources[0]!, hosted.connections), 'umami:website-123');
  const identity = (provider: 'plausible' | 'umami', instance: Record<string, unknown> = {}) => {
    const c = selfHostedConfig(provider, instance);
    return resourceIdentity(c.resources[0]!, c.connections);
  };
  assert.equal(identity('umami'), `umami:selfhosted:home@${HOST}:443:website-123`);
  assert.equal(
    identity('plausible'),
    `plausible:selfhosted:home@${HOST}:443:site.example.org:Europe/Madrid`,
  );
  const variants = new Set([
    identity('umami'),
    identity('umami', { instance: 'renamed' }),
    identity('umami', { hostname: 'moved.pulse-fixture.example' }),
    identity('umami', { port: 8443 }),
    'umami:website-123',
  ]);
  assert.equal(variants.size, 5);
  // The pinned address is a deployment detail and stays outside identity.
  assert.equal(identity('umami', { addressEnv: 'OTHER_ADDRESS' }), identity('umami'));
  // Without its connection the identity fails instead of passing for hosted.
  const selfHosted = selfHostedConfig('umami');
  assert.throws(() => resourceIdentity(selfHosted.resources[0]!), refused('CONFIG'));
  assert.throws(
    () => resourceIdentity(selfHosted.resources[0]!, hosted.connections),
    refused('CONFIG'),
  );
});

test('history: switching to, between or relabelling instances cannot reuse a resource ID', async () => {
  const hosted = parseConfig({
    version: 1,
    connections: [{ id: 'analytics', provider: 'umami', tokenEnv: 'TEST_TOKEN' }],
    resources: [
      { id: 'site', provider: 'umami', websiteId: 'website-123', connection: 'analytics' },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
  const first = await database(hosted);
  await assert.rejects(first.register(selfHostedConfig('umami'), now), refused('CONFLICT'));
  const second = await database(selfHostedConfig('umami'));
  for (const change of [
    { instance: 'renamed' },
    { hostname: 'moved.pulse-fixture.example' },
    { port: 8443 },
  ])
    await assert.rejects(
      second.register(selfHostedConfig('umami', change), now),
      refused('CONFLICT'),
      JSON.stringify(change),
    );
  await assert.rejects(second.register(hosted, now), refused('CONFLICT'));
  // Re-pinning the same installation to a new address keeps its history.
  await second.register(selfHostedConfig('umami', { addressEnv: 'OTHER_ADDRESS' }), now);
});

test('admission: the pin comes from a deployment setting and must be a permitted literal', () => {
  const connection = selfHostedConfig('umami').connections[0]!;
  const admit = (settings: Record<string, string | undefined>) =>
    admitDestination(connection, { exchange: async () => ({}) as PinnedReply, settings });
  const destination = admit({ [ADDRESS_SETTING]: '1.1.1.1' });
  assert.deepEqual(
    { ...destination },
    {
      instance: 'home',
      variant: 'umami-selfhosted',
      hostname: HOST,
      port: 443,
      address: '1.1.1.1',
      addressClass: 'public',
    },
  );
  assert.ok(Object.isFrozen(destination) && isAdmittedDestination(destination));
  // A copy is not the admitted object, and the original cannot be altered.
  assert.equal(isAdmittedDestination({ ...destination }), false);
  assert.equal(isAdmittedDestination(structuredClone(destination)), false);
  assert.throws(() => {
    (destination as { address: string }).address = '169.254.169.254';
  }, TypeError);
  for (const value of [
    undefined,
    '',
    HOST,
    'localhost',
    '1.1.1.1 ',
    '1.1.1.1,10.0.0.1',
    '127.1',
    '0x7f000001',
    '::1',
    '::ffff:10.0.0.1',
    '1.1.1.1:8443',
  ])
    assert.throws(
      () => admit({ [ADDRESS_SETTING]: value }),
      refused('CONFIG', /canonical dotted-decimal/),
      JSON.stringify(value),
    );
  for (const value of [
    '0.0.0.0',
    '169.254.169.254',
    '169.254.170.2',
    '100.64.0.1',
    '100.100.100.200',
    '168.63.129.16',
    '192.0.0.192',
    '224.0.0.1',
    '255.255.255.255',
  ])
    for (const list of [undefined, value, `${LAN},${value}`])
      assert.throws(
        () => admit({ [ADDRESS_SETTING]: value, [PRIVATE_ADMISSION_SETTING]: list }),
        refused('CONFIG', /prohibited range/),
        value,
      );
  // RFC 1918 needs its exact literal in the deployment admission list.
  assert.equal(
    admit({ [ADDRESS_SETTING]: LAN, [PRIVATE_ADMISSION_SETTING]: `10.0.0.7,${LAN}` }).addressClass,
    'private',
  );
  for (const list of [
    undefined,
    '',
    '192.168.10.21',
    '192.168.10.0/24',
    '192.168.0.0/16',
    '*',
    'all',
    'true',
    ` ${LAN}`,
    `${LAN} `,
    `${LAN},`,
    `${LAN};10.0.0.7`,
    `${LAN},1.1.1.1`,
    `${LAN},127.0.0.1`,
    `${LAN},169.254.169.254`,
    `${LAN},192.168.010.020`,
  ])
    assert.throws(
      () => admit({ [ADDRESS_SETTING]: LAN, [PRIVATE_ADMISSION_SETTING]: list }),
      refused('CONFIG', /does not admit/),
      JSON.stringify(list),
    );
  // Refusals name a setting and never echo its value.
  try {
    admit({ [ADDRESS_SETTING]: '169.254.169.254' });
    assert.fail('expected refusal');
  } catch (error) {
    assert.ok(error instanceof PulseError);
    assert.ok(error.message.includes(ADDRESS_SETTING));
    assert.equal(error.message.includes('169.254'), false);
  }
});

test('admission: no setting, configuration or CLI capability admits loopback', () => {
  const connection = selfHostedConfig('umami').connections[0]!;
  const exchange = async () => ({}) as PinnedReply;
  for (const settings of [
    { [ADDRESS_SETTING]: '127.0.0.1' },
    { [ADDRESS_SETTING]: '127.0.0.1', [PRIVATE_ADMISSION_SETTING]: '127.0.0.1' },
    { [ADDRESS_SETTING]: '127.0.0.53', [PRIVATE_ADMISSION_SETTING]: '127.0.0.53,10.0.0.1' },
    {
      [ADDRESS_SETTING]: '127.0.0.1',
      [PRIVATE_ADMISSION_SETTING]: '127.0.0.1',
      PULSE_SELFHOSTED_LOOPBACK: '127.0.0.1',
      SYNTHETIC_LOOPBACK: '127.0.0.1',
      'pulse.selfhost.synthetic-loopback': '127.0.0.1',
      'Symbol(pulse.selfhost.synthetic-loopback)': '127.0.0.1',
    },
  ]) {
    assert.throws(
      () => admitDestination(connection, { exchange, settings }),
      refused('CONFIG', /No setting admits loopback/),
    );
    // The capability the CLI builds from the process environment has no seam.
    const runtime = nodeSelfHosted(settings);
    assert.deepEqual(Object.getOwnPropertySymbols(runtime), []);
    assert.deepEqual(Object.keys(runtime).sort(), ['exchange', 'settings']);
    assert.ok(Object.isFrozen(runtime));
    assert.throws(() => admitDestination(connection, runtime), refused('CONFIG', /loopback/));
  }
  // A string-keyed look-alike of the seam, as JSON or an environment could produce, is inert.
  const lookalike = JSON.parse(
    '{"settings":{"ANALYTICS_ADDRESS":"127.0.0.1"},"Symbol(pulse.selfhost.synthetic-loopback)":["127.0.0.1"],"SYNTHETIC_LOOPBACK":["127.0.0.1"]}',
  );
  assert.throws(() => admitDestination(connection, { ...lookalike, exchange }), refused('CONFIG'));
  // The seam itself admits only the exact loopback literals a test lists.
  const seam = (addresses: string[], address: string): SelfHostedRuntime => ({
    exchange,
    settings: { [ADDRESS_SETTING]: address },
    [SYNTHETIC_LOOPBACK]: addresses,
  });
  assert.equal(
    admitDestination(connection, seam(['127.0.0.1'], '127.0.0.1')).addressClass,
    'loopback',
  );
  assert.throws(() => admitDestination(connection, seam(['127.0.0.1'], '127.0.0.2')), PulseError);
  for (const address of ['169.254.169.254', LAN, '100.64.0.1', '0.0.0.0'])
    assert.throws(
      () => admitDestination(connection, seam([address], address)),
      PulseError,
      address,
    );
});

test('the seam and the transport are not part of the published package surface', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const index = await readFile(resolve(root, 'src/index.ts'), 'utf8');
  assert.equal(/selfhost|SYNTHETIC_LOOPBACK|PinnedTransport/.test(index), false);
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.exports, { '.': './dist/index.js', './worker': './dist/worker.js' });
  const cli = await readFile(resolve(root, 'src/cli.ts'), 'utf8');
  assert.equal(/SYNTHETIC_LOOPBACK|createPinnedTransport|\bca\s*:/.test(cli), false);
  assert.match(cli, /nodeSelfHosted\(process\.env\)/);
});

test('reads: a closed union builds one fixed method and path per variant', () => {
  assert.deepEqual(
    wireRequest({ variant: 'umami-selfhosted', websiteId: 'website-123', startAt: 5, endAt: 9 }),
    {
      method: 'GET',
      path: '/api/websites/website-123/pageviews?startAt=5&endAt=9&timezone=UTC&unit=day',
    },
  );
  const plausible = wireRequest({
    variant: 'plausible-ce',
    siteId: 'site.example.org',
    from: '2026-10-12',
    to: '2026-10-13',
    limit: 51,
  });
  assert.equal(plausible.method, 'POST');
  assert.equal(plausible.path, '/api/v2/query');
  assert.deepEqual(JSON.parse(plausible.body!), {
    site_id: 'site.example.org',
    metrics: ['pageviews', 'visitors'],
    date_range: ['2026-10-12', '2026-10-13'],
    dimensions: ['time:day'],
    include: { imports: false },
    pagination: { limit: 51, offset: 0 },
  });
  for (const websiteId of [
    '',
    '..',
    '.',
    '../users',
    'id/../../users',
    'id%2f..',
    'id?x=1',
    'id#x',
    'id\r\nHost: evil.example',
    'id\u0000',
    'id id',
    '%2e%2e',
    'id/pageviews',
    'id\\..\\users',
    'a'.repeat(129),
  ])
    assert.throws(
      () => wireRequest({ variant: 'umami-selfhosted', websiteId, startAt: 0, endAt: 1 }),
      refused('CONFIG'),
      JSON.stringify(websiteId),
    );
  for (const [startAt, endAt] of [
    [-1, 1],
    [2, 1],
    [0.5, 1],
    [0, Infinity],
    [NaN, 1],
    ['0', 1],
  ] as [number, number][])
    assert.throws(
      () => wireRequest({ variant: 'umami-selfhosted', websiteId: 'id', startAt, endAt }),
      refused('CONFIG'),
    );
  const query = { variant: 'plausible-ce', siteId: 'site.example.org', limit: 10 } as const;
  for (const bad of [
    { from: '2026-10-13', to: '2026-10-12' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: 'today', to: '2026-10-12' },
    { from: '2026-10-12', to: '2026-10-13', limit: 0 },
    { from: '2026-10-12', to: '2026-10-13', limit: 10001 },
    { from: '2026-10-12', to: '2026-10-13', limit: 1.5 },
    { from: '2026-10-12', to: '2026-10-13', siteId: 'site.example.org/../x' },
    { from: '2026-10-12', to: '2026-10-13', siteId: 'site"\n,"metrics":["events"]' },
  ])
    assert.throws(() => wireRequest({ ...query, ...bad }), refused('CONFIG'), JSON.stringify(bad));
  // Nothing outside the union reaches a path: no method, header or URL field exists.
  for (const read of [
    { variant: 'umami-cloud', websiteId: 'id', startAt: 0, endAt: 1 },
    { variant: 'plausible-ce', path: '/api/v1/sites', method: 'POST' },
    { variant: 'generic', url: 'https://evil.example/' },
    {},
  ])
    assert.throws(() => wireRequest(read as unknown as SelfHostedRead), refused('CONFIG'));
});

test('the self-hosted Plausible query is byte-identical to the hosted adapter query', async () => {
  const hosted = parseConfig({
    version: 1,
    settings: { maxRows: 50, lookbackDays: 14 },
    connections: [{ id: 'analytics', provider: 'plausible', tokenEnv: 'TEST_TOKEN' }],
    resources: [
      {
        id: 'site',
        provider: 'plausible',
        siteId: 'site.example.org',
        timezone: 'Europe/Madrid',
        connection: 'analytics',
      },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
  let hostedBody = '';
  const { ctx } = await import('./helpers.js');
  await collect(
    hosted.resources[0]!,
    'traffic',
    ctx(hosted, async (_url, init) => {
      hostedBody = String(init?.body);
      return Response.json({ results: [] });
    }),
  );
  const runtime = fake({ status: 200, retryAfter: null, body: json({ results: [] }) });
  const c = selfHostedConfig('plausible');
  await collect(c.resources[0]!, 'traffic', context(c, runtime));
  assert.equal(wireRequest(runtime.calls[0]!.read).body, hostedBody);
});

test('client: admission and request construction precede the credential and the socket', async () => {
  const c = selfHostedConfig('umami');
  const read: SelfHostedRead = {
    variant: 'umami-selfhosted',
    websiteId: 'website-123',
    startAt: 0,
    endAt: 1,
  };
  for (const settings of [
    {},
    { [ADDRESS_SETTING]: '169.254.169.254' },
    { [ADDRESS_SETTING]: LAN },
    { [ADDRESS_SETTING]: '127.0.0.1', [PRIVATE_ADMISSION_SETTING]: '127.0.0.1' },
  ] as Record<string, string>[]) {
    const runtime = fake({ status: 200, retryAfter: null, body: json(umamiSeries) }, settings);
    const x = context(c, runtime);
    await assert.rejects(selfHostedJson(x, c.connections[0], read), refused('CONFIG'));
    assert.deepEqual([x.tokenReads(), runtime.calls.length, x.http.requests], [0, 0, 0]);
  }
  // A read for the other variant, or outside the contract, never costs a credential read.
  const runtime = fake({ status: 200, retryAfter: null, body: json(umamiSeries) });
  const x = context(c, runtime);
  for (const bad of [
    {
      variant: 'plausible-ce',
      siteId: 'site.example.org',
      from: '2026-10-12',
      to: '2026-10-12',
      limit: 5,
    },
    { variant: 'umami-selfhosted', websiteId: '../users', startAt: 0, endAt: 1 },
  ] as SelfHostedRead[])
    await assert.rejects(selfHostedJson(x, c.connections[0], bad), refused('CONFIG'));
  assert.deepEqual([x.tokenReads(), runtime.calls.length], [0, 0]);
  // A hosted connection can never be sent through the pinned path.
  const hosted = parseConfig({
    version: 1,
    connections: [{ id: 'analytics', provider: 'umami', tokenEnv: 'TEST_TOKEN' }],
    resources: [
      { id: 'site', provider: 'umami', websiteId: 'website-123', connection: 'analytics' },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
  await assert.rejects(selfHostedJson(x, hosted.connections[0], read), refused('CONFIG'));
  await assert.rejects(selfHostedJson(x, undefined, read), refused('CONFIG'));
  assert.equal(runtime.calls.length, 0);
});

test('client: one attempt, fixed status classes and no upstream content in any error', async () => {
  const c = selfHostedConfig('umami');
  const cases: [number, string, boolean][] = [
    [301, 'REDIRECT', false],
    [302, 'REDIRECT', false],
    [307, 'REDIRECT', false],
    [308, 'REDIRECT', false],
    [401, 'AUTH', false],
    [403, 'PERMISSION', false],
    [404, 'NOT_FOUND', false],
    [429, 'RATE_LIMIT', true],
    [500, 'UNAVAILABLE', false],
    [503, 'UNAVAILABLE', false],
    [201, 'UNAVAILABLE', false],
    [204, 'UNAVAILABLE', false],
  ];
  for (const [status, code, retryable] of cases) {
    const runtime = fake({
      status,
      retryAfter: '1',
      body: new TextEncoder().encode('private-upstream-body'),
    });
    const x = context(c, runtime);
    await assert.rejects(collect(c.resources[0]!, 'traffic', x), (error: unknown) => {
      assert.ok(error instanceof PulseError, String(status));
      assert.equal(error.code, code, String(status));
      assert.equal(error.retryable, retryable, String(status));
      assert.equal(/private-upstream|private-test-token|192\.168/.test(error.message), false);
      return true;
    });
    // No in-job retry: a failing instance receives the key exactly once.
    assert.deepEqual([runtime.calls.length, x.http.requests, x.genericFetches()], [1, 1, 0]);
  }
  // A transport exception may quote anything. Only a fixed message survives.
  const leaking = fake(() => {
    throw new Error(`connect failed for Bearer ${TOKEN} at ${LAN} body private-upstream-body`);
  });
  await assert.rejects(
    collect(c.resources[0]!, 'traffic', context(c, leaking)),
    (error: unknown) =>
      error instanceof PulseError &&
      error.code === 'NETWORK' &&
      error.retryable &&
      !/Bearer|private|192\.168/.test(error.message),
  );
  for (const body of [
    new TextEncoder().encode('{"pageviews":'),
    new Uint8Array([0xff, 0xfe, 0x00]),
    new Uint8Array(),
  ])
    await assert.rejects(
      collect(
        c.resources[0]!,
        'traffic',
        context(c, fake({ status: 200, retryAfter: null, body })),
      ),
      refused('SCHEMA'),
    );
  await assert.rejects(
    collect(
      c.resources[0]!,
      'traffic',
      context(
        c,
        fake({ status: 200, retryAfter: null, body: new Uint8Array(2 * 1024 * 1024 + 1) }),
      ),
    ),
    refused('ROW_LIMIT'),
  );
  // An unusable credential is refused before it can reach a header.
  for (const bad of [`${TOKEN}\r\nX-Injected: 1`, `${TOKEN} extra`, 'tökén', 'a'.repeat(4097)]) {
    const runtime = fake({ status: 200, retryAfter: null, body: json(umamiSeries) });
    const x = context(c, runtime);
    x.credentials.token = async () => bad;
    await assert.rejects(collect(c.resources[0]!, 'traffic', x), refused('AUTH'));
    assert.equal(runtime.calls.length, 0);
  }
});

test('client: both adapters normalize a self-hosted reply with instance-aware provenance', async () => {
  const umami = selfHostedConfig('umami');
  const runtime = fake({ status: 200, retryAfter: null, body: json(umamiSeries) });
  const x = context(umami, runtime);
  const rows = await collect(umami.resources[0]!, 'traffic', x);
  assert.deepEqual(
    rows.observations.map((o) => [o.metric, o.from, o.value, o.methodology]),
    [
      ['umami.pageviews', '2026-10-12', 7, 'umami-selfhosted-utc-daily-v1'],
      ['umami.sessions_daily', '2026-10-12', 3, 'umami-selfhosted-utc-daily-v1'],
    ],
  );
  assert.match(rows.notes.join(' '), /Self-hosted Umami instance home/);
  assert.match(rows.notes.join(' '), /not yet verified against a real installation/);
  const call = runtime.calls[0]!;
  assert.equal(call.token, TOKEN);
  assert.equal(call.destination.address, LAN);
  assert.deepEqual(call.read, {
    variant: 'umami-selfhosted',
    websiteId: 'website-123',
    startAt: Date.parse(`${period.from}T00:00:00.000Z`),
    endAt: Date.parse(`${period.to}T23:59:59.999Z`),
  });
  assert.deepEqual([x.http.requests, x.genericFetches()], [1, 0]);
  const plausible = selfHostedConfig('plausible');
  const stats = fake({
    status: 200,
    retryAfter: null,
    body: json({
      results: [{ dimensions: ['2026-10-12'], metrics: [7, 3] }],
      meta: { imports_included: false },
    }),
  });
  const result = await collect(plausible.resources[0]!, 'traffic', context(plausible, stats));
  assert.deepEqual(
    result.observations.map((o) => [o.metric, o.value, o.timezone]),
    [
      ['plausible.pageviews', 7, 'Europe/Madrid'],
      ['plausible.visitors_daily', 3, 'Europe/Madrid'],
    ],
  );
  assert.match(result.notes.join(' '), /Community Edition instance home/);
  // Imported history stays refused on a self-hosted instance too.
  await assert.rejects(
    collect(
      plausible.resources[0]!,
      'traffic',
      context(
        plausible,
        fake({
          status: 200,
          retryAfter: null,
          body: json({ results: [], meta: { imports_included: true } }),
        }),
      ),
    ),
    refused('SCHEMA'),
  );
});

test('Worker: no pinned transport exists, so a self-hosted job fails before any credential read', async () => {
  for (const provider of ['umami', 'plausible'] as const) {
    const c = selfHostedConfig(provider);
    const store = await database(c);
    const read: string[] = [];
    let fetches = 0;
    const secrets = new Proxy<Record<string, string>>(
      { TEST_TOKEN: TOKEN, [ADDRESS_SETTING]: '1.1.1.1', [PRIVATE_ADMISSION_SETTING]: LAN },
      {
        get(target, key) {
          read.push(String(key));
          return target[String(key)];
        },
      },
    );
    const bindings = workerBindings({});
    assert.equal('selfHosted' in bindings, false);
    const results = await sync(c, store, secrets, {
      now,
      bindings,
      fetcher: async () => {
        fetches++;
        throw new Error('no generic fetch for a self-hosted source');
      },
    });
    assert.equal(results.length, 1);
    assert.deepEqual(
      [results[0]!.status, results[0]!.code, results[0]!.requests, results[0]!.rows],
      ['failed', 'CONFIG', 0, 0],
    );
    assert.match(results[0]!.message!, /requires the Node\/OCI pinned transport/);
    assert.equal(fetches, 0);
    assert.equal(read.includes('TEST_TOKEN'), false);
    // Readiness reports the missing capability instead of a missing key.
    assert.equal(readyResource(c, c.resources[0]!, 'traffic', secrets, bindings), undefined);
    assert.deepEqual(
      await sync(c, store, secrets, { now, bindings, readyOnly: true, fetcher: fetch }),
      [],
    );
    const health = await doctor(c, store, secrets, now, bindings);
    assert.deepEqual(health.resources[0]!.credentials, {
      available: false,
      method: 'token-pinned-self-hosted',
      missing: ['node-pinned-transport'],
    });
  }
});

test('readiness: a Node installation reports the blocking deployment setting by name', () => {
  const c = selfHostedConfig('umami');
  const connection = c.connections[0]!;
  const exchange = async () => ({}) as PinnedReply;
  const status = (
    settings: Record<string, string>,
    secrets: Record<string, string> = { TEST_TOKEN: TOKEN },
  ) => connectionStatus(connection, secrets, { exchange, settings });
  assert.deepEqual(status({ [ADDRESS_SETTING]: '1.1.1.1' }), {
    available: true,
    method: 'token-pinned-self-hosted',
    missing: [],
  });
  assert.deepEqual(status({}).missing, [ADDRESS_SETTING]);
  assert.deepEqual(status({ [ADDRESS_SETTING]: LAN }).missing, [PRIVATE_ADMISSION_SETTING]);
  assert.deepEqual(status({ [ADDRESS_SETTING]: '127.0.0.1' }).missing, [ADDRESS_SETTING]);
  assert.deepEqual(status({ [ADDRESS_SETTING]: '1.1.1.1' }, {}).missing, ['TEST_TOKEN']);
  // Hosted connections keep the existing status shape exactly.
  const hosted = { id: 'analytics', provider: 'umami', tokenEnv: 'TEST_TOKEN' } as const;
  assert.deepEqual(connectionStatus(hosted, { TEST_TOKEN: TOKEN }, undefined), {
    available: true,
    method: 'token',
    missing: [],
  });
});

test('Worker and library graphs contain no Node module and cannot reach the pinned transport', async () => {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  async function graph(entry: string) {
    const files = new Set<string>();
    const external = new Set<string>();
    const queue = [resolve(source, entry)];
    while (queue.length) {
      const file = queue.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      const text = await readFile(file, 'utf8');
      // Type-only statements are erased from the bundle; everything else counts.
      const pattern =
        /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (const match of text.matchAll(pattern)) {
        const specifier = (match[1] ?? match[2] ?? match[3])!;
        if (specifier.startsWith('.'))
          queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
        else external.add(specifier);
      }
    }
    return { files: [...files].map((file) => file.slice(source.length + 1)), external };
  }
  for (const entry of ['worker.ts', 'index.ts']) {
    const { files, external } = await graph(entry);
    assert.ok(files.includes('selfhost/policy.ts') && files.includes('selfhost/client.ts'), entry);
    assert.equal(files.includes('selfhost/node-transport.ts'), false, entry);
    assert.deepEqual(
      [...external].filter((specifier) => specifier.startsWith('node:') || isBuiltin(specifier)),
      [],
      entry,
    );
  }
  // The walker does see the transport from the one entry point that owns it.
  const cli = await graph('cli.ts');
  assert.ok(cli.files.includes('selfhost/node-transport.ts'));
  assert.ok(cli.external.has('node:tls'));
  // Neutral policy code performs no I/O of its own.
  for (const file of ['selfhost/policy.ts', 'selfhost/client.ts']) {
    const text = await readFile(resolve(source, file), 'utf8');
    assert.equal(/\bfetch\s*\(|node:|new URL\(|XMLHttpRequest|WebSocket/.test(text), false, file);
  }
});
