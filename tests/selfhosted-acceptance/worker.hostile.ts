/**
 * Independent acceptance of the runtime boundary: a Worker must refuse a
 * self-hosted source before it reads a credential or calls fetch, its bundle
 * must contain no socket-capable module, and the hosted adapters must be the
 * same modules in both runtimes.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { workerBindings } from '../../src/collectors/bindings.js';
import { parseConfig, type Config } from '../../src/config.js';
import { doctor, sync } from '../../src/sync.js';
import { database, now, window as period } from '../helpers.js';
import { TOKEN } from './fixture.js';

const require = createRequire(import.meta.url);
const { build } = require('esbuild') as {
  build(options: Record<string, unknown>): Promise<{
    outputFiles: { text: string }[];
    metafile: {
      inputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
    };
  }>;
};
const source = (file: string) => fileURLToPath(new URL(`../../src/${file}`, import.meta.url));

function installation(): Config {
  return parseConfig({
    version: 1,
    settings: { maxRows: 50, lookbackDays: 14 },
    connections: [
      {
        id: 'plausible-home',
        provider: 'plausible',
        tokenEnv: 'PLAUSIBLE_HOME_TOKEN',
        selfHosted: {
          instance: 'home',
          hostname: 'analytics.example.org',
          addressEnv: 'PLAUSIBLE_HOME_ADDRESS',
        },
      },
      {
        id: 'umami-home',
        provider: 'umami',
        tokenEnv: 'UMAMI_HOME_TOKEN',
        selfHosted: {
          instance: 'office',
          hostname: 'umami.example.org',
          port: 8443,
          addressEnv: 'UMAMI_HOME_ADDRESS',
        },
      },
    ],
    resources: [
      {
        id: 'plausible-site',
        provider: 'plausible',
        connection: 'plausible-home',
        instance: 'home',
        siteId: 'site.example.org',
        timezone: 'UTC',
      },
      {
        id: 'umami-site',
        provider: 'umami',
        connection: 'umami-home',
        instance: 'office',
        websiteId: 'website-123',
      },
    ],
    projects: [
      {
        id: 'project',
        label: 'Project',
        resources: [{ resource: 'plausible-site' }, { resource: 'umami-site' }],
      },
    ],
  });
}
/** Everything an operator could set on a Worker, including every self-hosted setting. */
function workerEnvironment() {
  const read: string[] = [];
  const values: Record<string, string> = {
    PLAUSIBLE_HOME_TOKEN: TOKEN,
    UMAMI_HOME_TOKEN: TOKEN,
    PLAUSIBLE_HOME_ADDRESS: '1.1.1.1',
    UMAMI_HOME_ADDRESS: '10.0.0.5',
    PULSE_SELFHOSTED_PRIVATE_ADDRESSES: '10.0.0.5',
    PULSE_SELFHOSTED: '1',
    PULSE_SELFHOSTED_TRANSPORT: 'fetch',
    PULSE_RUNTIME: 'node',
  };
  const secrets = new Proxy(values, {
    get(target, key) {
      if (typeof key === 'string') read.push(key);
      return Reflect.get(target, key);
    },
  });
  return { values, secrets, read };
}

test('Worker: self-hosted sources fail closed before any credential read or fetch', async () => {
  const config = installation();
  const store = await database(config);
  const { values, secrets, read } = workerEnvironment();
  const original = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return Response.json({});
  }) as typeof fetch;
  try {
    const bindings = workerBindings(values as never);
    assert.equal(bindings.selfHosted, undefined, 'a Worker environment produced the capability');
    const results = await sync(config, store, secrets, { now, window: period, bindings });
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.status, 'failed');
      assert.equal(result.code, 'CONFIG');
      assert.equal(result.requests, 0);
      assert.equal(result.rows, 0);
      assert.ok(!JSON.stringify(result).includes(TOKEN));
      assert.ok(!JSON.stringify(result).includes('1.1.1.1'));
    }
    // A fetcher handed to sync must not be used for these sources either.
    let injected = 0;
    const again = await sync(config, store, secrets, {
      now,
      window: period,
      bindings,
      fetcher: async () => {
        injected++;
        return Response.json({});
      },
    });
    assert.ok(again.every((result) => result.status === 'failed' && result.code === 'CONFIG'));
    assert.equal(injected, 0);
    assert.deepEqual(
      read.filter((name) => name.endsWith('_TOKEN')),
      [],
      'a Worker collection read a self-hosted credential',
    );
    // Ready-only scheduling skips them instead of attempting them.
    const ready = await sync(config, store, secrets, {
      now,
      window: period,
      bindings,
      readyOnly: true,
    });
    assert.deepEqual(ready, []);
    assert.deepEqual(fetched, [], 'the Worker path called fetch for a self-hosted source');
    // Readiness may test that a credential setting is present; collection above never reads it.
    // Health reporting names the missing runtime capability rather than claiming readiness.
    const health = await doctor(config, store, values, now, bindings);
    for (const row of health.resources) {
      assert.notEqual(row.status, 'ok');
      assert.notEqual(row.status, 'ready');
    }
    assert.ok(!JSON.stringify(health).includes(TOKEN));
    assert.ok(
      !JSON.stringify(health).includes('10.0.0.5'),
      'health output reveals a pinned address',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('bundles: the Worker graph has no socket-capable module; the Node CLI graph has the pinned transport', async () => {
  const bundle = (entry: string, platform: 'browser' | 'node') =>
    build({
      entryPoints: [source(entry)],
      bundle: true,
      metafile: true,
      write: false,
      format: 'esm',
      platform,
      target: 'es2022',
      logLevel: 'silent',
      // Report Node built-ins as external imports instead of failing, so the
      // assertion below names the offending module.
      external: ['node:*'],
    });
  const worker = await bundle('worker.ts', 'browser');
  const inputs = Object.keys(worker.metafile.inputs);
  const builtins = Object.entries(worker.metafile.inputs).flatMap(([file, input]) =>
    input.imports
      .filter(
        (entry) =>
          entry.external &&
          /^(?:node:)?(?:tls|net|http|https|http2|dns|dgram|child_process|fs)$/.test(entry.path),
      )
      .map((entry) => `${file} -> ${entry.path}`),
  );
  assert.deepEqual(builtins, [], 'the Worker graph imports a socket or host module');
  assert.deepEqual(
    Object.values(worker.metafile.inputs).flatMap((input) =>
      input.imports.filter((entry) => entry.path.startsWith('node:')).map((entry) => entry.path),
    ),
    [],
    'the Worker graph imports a Node built-in',
  );
  assert.ok(!inputs.some((file) => file.includes('selfhost/node-transport')));
  const text = worker.outputFiles[0]!.text;
  for (const marker of [
    'node:tls',
    'node:http',
    'node:net',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'checkServerIdentity',
    'rejectUnauthorized',
  ])
    assert.ok(!text.includes(marker), `the Worker bundle contains ${marker}`);
  // The refusal logic and the shared adapters are in the Worker; only the socket code is not.
  for (const shared of [
    'src/selfhost/policy.ts',
    'src/selfhost/client.ts',
    'src/collectors/plausible.ts',
    'src/collectors/umami.ts',
    'src/http.ts',
    'src/config.ts',
  ])
    assert.ok(
      inputs.some((file) => file.endsWith(shared)),
      `the Worker graph lacks ${shared}`,
    );

  const cli = await bundle('cli.ts', 'node');
  const cliInputs = Object.keys(cli.metafile.inputs);
  assert.ok(cliInputs.some((file) => file.endsWith('src/selfhost/node-transport.ts')));
  // Parity: every collector, connector policy and client module the Worker runs is the
  // module Node runs, so a hosted read cannot differ between the two runtimes.
  const connectorModules = inputs.filter((file) =>
    /src\/(?:collectors\/[a-z0-9-]+|selfhost\/[a-z0-9-]+|http|auth|config|sync|model|validation|errors|time)\.ts$/.test(
      file,
    ),
  );
  assert.ok(connectorModules.length >= 20, 'the connector module set is unexpectedly small');
  assert.deepEqual(
    connectorModules.filter((file) => !cliInputs.includes(file)),
    [],
    'connector modules the Worker runs that the Node CLI does not',
  );
  // The only importer of the socket module is the Node entry point.
  const importers = Object.entries(cli.metafile.inputs)
    .filter(([, input]) =>
      input.imports.some((entry) => entry.path.endsWith('src/selfhost/node-transport.ts')),
    )
    .map(([file]) => file.replace(/^.*src\//, 'src/'));
  assert.deepEqual(importers, ['src/cli.ts']);
});
