import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
  resources: [
    {
      id: 'usage',
      provider: 'sense6',
      accountId: 'a'.repeat(32),
      databaseId: '00000000-0000-4000-8000-000000000001',
    },
  ],
  projects: [{ id: 'site', label: 'Synthetic site', resources: [{ resource: 'usage' }] }],
};
const harness = `import worker from './worker.js';export default {async fetch(request,bindings){const env={...bindings,PULSE_CONFIG:${JSON.stringify(JSON.stringify(config))},PULSE_API_TOKEN:'synthetic-native-aggregate-contract',PULSE_READY_ONLY:'true',PULSE_MAX_JOBS:'1',PULSE_SENSE6_ACCOUNT_ID:'${'a'.repeat(32)}',PULSE_SENSE6_DATABASE_ID:'00000000-0000-4000-8000-000000000001'};globalThis.fetch=()=>{throw Error('Unexpected HTTP request')};await worker.scheduled({scheduledTime:Date.now()},env);return Response.json({ok:true});}}`;
const mf = new Miniflare({
  workers: [
    {
      config: {
        name: 'native-aggregate',
        compatibilityDate: '2026-10-01',
        manifest: {
          mainModule: 'index.js',
          modulesRoot: '/',
          modules: {
            'index.js': { type: 'esm', contents: harness },
            'worker.js': { type: 'esm', contents: bundle.outputFiles[0].text },
          },
        },
        env: {
          DB: { type: 'd1', id: 'pulse-target' },
          PULSE_SENSE6_DB: { type: 'd1', id: 'sense6-source' },
        },
      },
    },
  ],
});
try {
  const source = await mf.getD1Database('PULSE_SENSE6_DB', 'native-aggregate');
  await source
    .prepare('CREATE TABLE daily_metrics(day TEXT,test TEXT,metric TEXT,count INTEGER)')
    .run();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await source
    .prepare('INSERT INTO daily_metrics VALUES(?,?,?,?)')
    .bind(yesterday, 'site', 'site_loaded', 7)
    .run();
  await source.prepare('CREATE TABLE private_participants(secret TEXT)').run();
  await source
    .prepare('INSERT INTO private_participants VALUES(?)')
    .bind('synthetic-not-for-analytics')
    .run();
  const response = await mf.dispatchFetch('http://localhost/');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const target = await mf.getD1Database('DB', 'native-aggregate');
  const run = await target.prepare('SELECT status,rows_count,requests_count FROM runs').first();
  assert.deepEqual(run, { status: 'success', rows_count: 1, requests_count: 0 });
  const rows = (await target.prepare('SELECT metric,value,dimensions_json FROM observations').all())
    .results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metric, 'sense6.site_loaded');
  assert.equal(rows[0].value, 7);
  assert.ok(!JSON.stringify(rows).includes('synthetic-not-for-analytics'));
  assert.equal((await source.prepare('SELECT count FROM daily_metrics').first()).count, 7);
  console.log(
    'NATIVE AGGREGATE CONTRACT PASSED: source D1 fixed SELECT, target D1 publication, no HTTP credentials, no participant fields, source unchanged.',
  );
} finally {
  await mf.dispose();
}
