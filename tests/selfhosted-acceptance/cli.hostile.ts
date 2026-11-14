/**
 * Independent acceptance through the production entry point. The command
 * line is the only place that creates the pinned transport, so it is where a
 * loopback or metadata pin must be proven unreachable, and where an RFC 1918
 * pin must be proven to need its explicit permit. Trust comes from Node's own
 * NODE_EXTRA_CA_CERTS, as an operator with a private authority would set it.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { classifyAddress, parseIpv4Literal } from '../../src/selfhost/policy.js';
import {
  INSTANCE_HOST,
  TOKEN,
  createPki,
  hostileServer,
  respond,
  type HostileServer,
  type Pki,
} from './fixture.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
// The command runs from a private directory, so the loader is given by location.
const loader = import.meta.resolve('tsx');
const ROWS = {
  results: [
    { dimensions: ['2026-10-12'], metrics: [7, 3] },
    { dimensions: ['2026-10-13'], metrics: [11, 4] },
  ],
  meta: { imports_included: false },
};
/** This host's own RFC 1918 address, if it has one. Nothing leaves the machine. */
const privateAddress = Object.values(networkInterfaces())
  .flat()
  .map((entry) => (entry && entry.family === 'IPv4' && !entry.internal ? entry.address : ''))
  .find((address) => {
    const octets = parseIpv4Literal(address);
    return octets !== undefined && classifyAddress(octets) === 'private';
  });

let pki: Pki;
let dir: string;
const servers: HostileServer[] = [];
before(() => {
  pki = createPki();
  dir = mkdtempSync(join(tmpdir(), 'pulse-selfhosted-cli-'));
  writeFileSync(join(dir, 'authority.pem'), pki.ca, { mode: 0o600 });
});
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  rmSync(dir, { recursive: true, force: true });
  pki.dispose();
});

async function pulse(name: string, port: number, environment: Record<string, string>) {
  const work = mkdtempSync(join(dir, `${name}-`));
  writeFileSync(
    join(work, 'pulse.config.json'),
    JSON.stringify({
      version: 1,
      settings: { maxRows: 50, lookbackDays: 14, requestTimeoutMs: 5000 },
      connections: [
        {
          id: 'analytics',
          provider: 'plausible',
          tokenEnv: 'ANALYTICS_TOKEN',
          selfHosted: {
            instance: 'fixture',
            hostname: INSTANCE_HOST,
            port,
            addressEnv: 'ANALYTICS_ADDRESS',
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
    }),
  );
  const result = await run(
    process.execPath,
    ['--import', loader, cli, 'sync', '--json', '--from', '2026-10-12', '--to', '2026-10-13'],
    {
      cwd: work,
      env: {
        PATH: process.env.PATH,
        HOME: work,
        TZ: 'UTC',
        NODE_EXTRA_CA_CERTS: join(dir, 'authority.pem'),
        ANALYTICS_TOKEN: TOKEN,
        ...environment,
      },
      timeout: 60000,
    },
  ).then(
    (ok) => ({ code: 0, ...ok }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }),
  );
  const text = `${result.stdout}\n${result.stderr}`;
  assert.ok(!text.includes(TOKEN), 'command output contains the credential');
  let results: { status: string; code?: string; rows: number; requests: number }[] = [];
  try {
    results = JSON.parse(result.stdout);
  } catch {
    assert.fail(`sync printed no JSON result: ${text.slice(0, 400)}`);
  }
  return { exit: result.code, results, text };
}

test('CLI: no deployment setting admits a loopback or metadata pin', async () => {
  const server = await hostileServer(pki.leaf('good'), respond.json(ROWS));
  servers.push(server);
  const everything = {
    PULSE_SELFHOSTED_PRIVATE_ADDRESSES: '127.0.0.1',
    PULSE_SELFHOSTED_LOOPBACK: '127.0.0.1',
    PULSE_SELFHOSTED_SYNTHETIC_LOOPBACK: '127.0.0.1',
    PULSE_SELFHOSTED_ALLOW_LOOPBACK: '1',
    PULSE_ALLOW_LOOPBACK: '1',
    PULSE_TEST: '1',
    NODE_ENV: 'test',
  };
  for (const [index, address] of [
    '127.0.0.1',
    '127.1',
    '2130706433',
    '0x7f.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'localhost',
    '169.254.169.254',
    '0.0.0.0',
  ].entries()) {
    const { exit, results, text } = await pulse(`refused-${index}`, server.port, {
      ...everything,
      ANALYTICS_ADDRESS: address,
      PULSE_SELFHOSTED_PRIVATE_ADDRESSES: address,
    });
    assert.equal(exit, 2, text.slice(0, 400));
    assert.deepEqual(
      results.map((result) => [result.status, result.code, result.rows, result.requests]),
      [['failed', 'CONFIG', 0, 0]],
      address,
    );
  }
  assert.equal(server.handshakes.length, 0, 'the command line reached a loopback listener');
  assert.equal(server.handshakeFailures, 0);
  assert.equal(server.received(), 0);
});

test(
  'CLI: an RFC 1918 pin needs its exact permit, then collects end to end with a verified certificate',
  { skip: privateAddress ? false : 'this host has no RFC 1918 interface address' },
  async () => {
    const server = await hostileServer(pki.leaf('good'), respond.json(ROWS), privateAddress);
    servers.push(server);
    for (const [index, permit] of [undefined, '', '10.0.0.0/8', '*', '192.168.255.254'].entries()) {
      const { exit, results } = await pulse(`unpermitted-${index}`, server.port, {
        ANALYTICS_ADDRESS: privateAddress!,
        ...(permit === undefined ? {} : { PULSE_SELFHOSTED_PRIVATE_ADDRESSES: permit }),
      });
      assert.equal(exit, 2);
      assert.deepEqual(
        results.map((result) => [result.status, result.code, result.requests]),
        [['failed', 'CONFIG', 0]],
        `permit ${String(permit)}`,
      );
    }
    assert.equal(server.handshakes.length, 0, 'an unpermitted private pin was contacted');

    const { exit, results, text } = await pulse('permitted', server.port, {
      ANALYTICS_ADDRESS: privateAddress!,
      PULSE_SELFHOSTED_PRIVATE_ADDRESSES: privateAddress!,
      // Ambient settings that must not matter.
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NODE_USE_ENV_PROXY: '1',
    });
    assert.equal(exit, 0, text.slice(0, 600));
    assert.deepEqual(
      results.map((result) => [result.status, result.rows, result.requests]),
      [['success', 4, 1]],
    );
    assert.equal(server.handshakes.length, 1);
    assert.equal(server.handshakes[0]?.localAddress, privateAddress);
    assert.equal(server.handshakes[0]?.servername, INSTANCE_HOST);
    assert.equal(server.requests[0]?.target, '/api/v2/query');
    assert.deepEqual(server.header(server.requests[0]!, 'authorization'), [`Bearer ${TOKEN}`]);

    // The same production path refuses a certificate it cannot verify.
    const untrusted = await hostileServer(
      pki.leaf('untrusted'),
      respond.json(ROWS),
      privateAddress,
    );
    servers.push(untrusted);
    const settings: Record<string, string>[] = [{}, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }];
    for (const [index, extra] of settings.entries()) {
      const refused = await pulse(`untrusted-${index}`, untrusted.port, {
        ANALYTICS_ADDRESS: privateAddress!,
        PULSE_SELFHOSTED_PRIVATE_ADDRESSES: privateAddress!,
        ...extra,
      });
      assert.equal(refused.exit, 2);
      assert.equal(refused.results[0]?.status, 'failed');
      assert.equal(refused.results[0]?.rows, 0);
    }
    assert.equal(untrusted.received(), 0, 'a credential reached an unverified peer');
  },
);
