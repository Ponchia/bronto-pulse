import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Use Wrangler's locked runtime dependencies, matching the D1 contract test.
const require = createRequire(import.meta.url);
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');
const bundle = await build({
  entryPoints: [new URL('../src/worker.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
const config = {
  version: 1,
  settings: { lookbackDays: 14 },
  resources: [{ id: 'package', provider: 'npm', package: '@example/package' }],
  projects: [{ id: 'project', label: 'Synthetic project', resources: [{ resource: 'package' }] }],
};
// Provider data is synthetic, but Request, Response, streams, the Worker handler
// and D1 run inside workerd. A Node fetch stub alone misses runtime incompatibilities.
const harness = `
import worker from './worker.js';
export default { async fetch(request, bindings) {
  const mode = new URL(request.url).searchParams.get('mode');
  const original = globalThis.fetch;
  let requests = 0;
  // Reject the wrong receiver exactly as native workerd fetch does. This
  // catches a regression where HttpClient saves fetch then calls it as a method.
  globalThis.fetch = async function (input, init) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError('Illegal invocation: incorrect fetch receiver');
    const upstream = new Request(input, init);
    requests++;
    const url = new URL(upstream.url);
    if (url.origin !== 'https://api.npmjs.org') throw Error('Unexpected provider origin');
    if (mode === 'network') throw new TypeError('secret-private-network-exception');
    if (mode === 'redirect') return new Response('private-provider-value', {
      status: 302, headers: {Location:'https://untrusted.invalid/?token=private-provider-value'}
    });
    const match = url.pathname.match(/\\/downloads\\/range\\/([0-9-]+):([0-9-]+)\\/(.+)$/);
    if (!match) throw Error('Unexpected npm request');
    const [,start,end,packageName] = match;
    const downloads = [];
    for (let time = Date.parse(start); time <= Date.parse(end); time += 86400000)
      downloads.push({day:new Date(time).toISOString().slice(0,10),downloads:7});
    return Response.json({start,end,package:decodeURIComponent(packageName),downloads});
  };
  const env = {...bindings, PULSE_CONFIG:${JSON.stringify(JSON.stringify(config))},
    PULSE_API_TOKEN:'synthetic-worker-contract-token', PULSE_PROVIDER:'npm', PULSE_MAX_JOBS:'1',
    ASSETS:{fetch:async()=>new Response('synthetic')}};
  try {
    await worker.scheduled({scheduledTime:Date.now()}, env);
    return Response.json({ok:true,requests});
  } catch (error) {
    return Response.json({ok:false,requests,code:error.code,message:error.message});
  } finally { globalThis.fetch = original; }
}};
`;
const mf = new Miniflare({
  workers: [
    {
      config: {
        name: 'pulse-worker-contract',
        compatibilityDate: '2026-10-01',
        manifest: {
          mainModule: 'index.js',
          modulesRoot: '/',
          modules: {
            'index.js': { type: 'esm', contents: harness },
            'worker.js': { type: 'esm', contents: bundle.outputFiles[0].text },
          },
        },
        env: { DB: { type: 'd1', id: 'pulse-worker-contract' } },
      },
    },
  ],
});
try {
  const db = await mf.getD1Database('DB', 'pulse-worker-contract');
  const run = async (mode) => (await mf.dispatchFetch('http://localhost/run?mode=' + mode)).json();
  assert.deepEqual(await run('success'), { ok: true, requests: 1 });
  const before = await db.prepare('SELECT * FROM partitions ORDER BY day').all();
  assert.equal(before.results.length, 14);
  const failed = await run('redirect');
  assert.equal(failed.ok, false, 'a failed job must reject the scheduled handler');
  assert.equal(failed.requests, 1, 'redirects are never followed or retried');
  assert.equal(failed.code, 'UNAVAILABLE');
  assert.ok(!JSON.stringify(failed).includes('private-provider-value'));
  const errors = await db
    .prepare("SELECT error_code,error_message FROM runs WHERE status='failed'")
    .all();
  assert.equal(errors.results.length, 1);
  assert.equal(errors.results[0].error_code, 'REDIRECT');
  assert.ok(!JSON.stringify(errors).includes('private-provider-value'));
  assert.deepEqual(
    (await db.prepare('SELECT * FROM partitions ORDER BY day').all()).results,
    before.results,
    'failed collection must preserve the last published history',
  );
  assert.equal(
    (await db.prepare('SELECT COUNT(*) AS n FROM leases').first()).n,
    0,
    'scheduler and dataset leases must be released after failure',
  );
  const networkFailure = await run('network');
  assert.equal(networkFailure.ok, false);
  assert.equal(networkFailure.requests, 3);
  assert.ok(!JSON.stringify(networkFailure).includes('secret-private-network-exception'));
  const latestNetwork = await db
    .prepare(
      "SELECT error_code,error_message FROM runs WHERE status='failed' AND error_code='NETWORK' LIMIT 1",
    )
    .first();
  assert.equal(latestNetwork.error_code, 'NETWORK');
  assert.match(latestNetwork.error_message, /type-error, type-error, type-error/);
  assert.ok(!JSON.stringify(latestNetwork).includes('secret-private-network-exception'));
  assert.deepEqual(
    (await db.prepare('SELECT * FROM partitions ORDER BY day').all()).results,
    before.results,
  );
  assert.deepEqual(await run('recovery'), { ok: true, requests: 1 });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM partitions').first()).n, 14);
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='success'").first()).n,
    2,
  );
  console.log(
    'WORKER CONTRACT PASSED: native Request, provider parsing, scheduled failure, redirect refusal, private errors, D1 publication, preserved history, released leases and recovery.',
  );
} finally {
  await mf.dispose();
}
