import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Store } from '../src/storage/store.js';
import { D1Driver } from '../src/storage/driver.js';
import { fixture, publish, sample, window, now } from '../tests/helpers.js';
import { projectReport, portfolio } from '../src/report.js';
import { doctor } from '../src/sync.js';
import { projectBrief } from '../src/brief.js';
import { parseConfig } from '../src/config.js';
import { dueJobs } from '../src/due-schedule.js';
// Wrangler installs Miniflare for local Workers; this tests the actual D1 binding.
const require = createRequire(import.meta.url);
const { Miniflare } = require('miniflare');
const mf = new Miniflare({
  workers: [
    {
      config: {
        name: 'pulse',
        compatibilityDate: '2026-10-01',
        manifest: {
          mainModule: 'index.js',
          modulesRoot: '/',
          modules: {
            'index.js': {
              type: 'esm',
              contents: 'export default { fetch(){ return new Response("ok") } }',
            },
          },
        },
        env: {
          DB: { type: 'd1', id: 'pulse-contract' },
          RESTORE: { type: 'd1', id: 'pulse-restoration' },
        },
      },
    },
  ],
});
try {
  const db = await mf.getD1Database('DB', 'pulse');
  const store = new Store(new D1Driver(db));
  await store.migrate();
  const base = fixture();
  const config = parseConfig({
    ...base,
    connections: [...base.connections, { id: 'search', provider: 'gsc', tokenEnv: 'TEST_TOKEN' }],
    resources: [
      ...base.resources,
      { id: 'search', provider: 'gsc', siteUrl: 'sc-domain:example.invalid', connection: 'search' },
    ],
    projects: base.projects.map((p) => ({
      ...p,
      resources: [...p.resources, { resource: 'search' }],
    })),
  });
  await store.register(config, now);
  await store.addInspections([
    {
      id: crypto.randomUUID(),
      resourceId: 'search',
      url: 'https://example.invalid/',
      inspectedAt: '2026-10-12T12:00:00Z',
      status: 'observed',
      verdict: 'PASS',
      coverageState: 'Synthetic indexed',
      declaredCanonical: null,
      googleCanonical: null,
      lastCrawlTime: null,
      sitemaps: null,
      errorCode: null,
    },
  ]);
  assert.equal(
    (await projectReport(config, store, 'project', window, now)).inspections[0]?.verdict,
    'PASS',
  );
  await publish(store, config, [sample('2026-10-12', 9), sample('2026-10-13', 4)]);
  assert.equal(
    (await projectReport(config, store, 'project', window, now)).cards.find(
      (x) => x.metric === 'github.views',
    )?.value,
    13,
  );
  await publish(store, config, [sample('2026-10-12', 3)]);
  assert.equal(
    (await projectReport(config, store, 'project', window, now)).cards.find(
      (x) => x.metric === 'github.views',
    )?.value,
    3,
  );
  assert.equal((await store.observations('source', window)).length, 1);
  const health = await doctor(config, store, { TEST_TOKEN: 'synthetic' }, now);
  assert.equal(health.resources.find((r) => r.group === 'views')?.observedThrough, '2026-10-12');
  assert.ok(
    projectBrief(await projectReport(config, store, 'project', window, now)).findings.length > 0,
  );
  assert.deepEqual(
    (await portfolio(config, store, window, now)).reports,
    [await projectReport(config, store, 'project', window, now)],
    'native D1 compact report projection and latest-group heads must preserve exact reports',
  );
  const exported = await store.export();
  const recovery = new Store(new D1Driver(await mf.getD1Database('RESTORE', 'pulse')));
  await recovery.migrate();
  await recovery.import(exported);
  assert.deepEqual(
    await projectReport(config, recovery, 'project', window, now),
    await projectReport(config, store, 'project', window, now),
  );
  // Due-time reads and writes after the recovery proof, so the export above is
  // unchanged: the exact regular head of a Pacific source behind newer
  // borderline windows (first page and a follow-up page), and a provider wait
  // stored only by the call that fails a running run.
  const search = config.resources.find((r) => r.id === 'search')!;
  const day = { from: '2026-10-13', to: '2026-10-13' };
  const closed = await store.begin(search, 'totals', day, new Date('2026-10-14T09:00:00Z'));
  await store.fail(closed, 'NETWORK', 'Synthetic failure', 1, new Date('2026-10-14T09:01:00Z'));
  const wait = { dataset: 'search:totals', notBefore: new Date('2026-10-14T15:00:00Z') };
  await store.fail(
    closed,
    'RATE_LIMIT',
    'Late',
    1,
    new Date('2026-10-14T09:02:00Z'),
    'failed',
    wait,
  );
  assert.deepEqual((await store.regularRunHeads()).retryGuidance, []);
  const guided = await store.begin(search, 'totals', day, new Date('2026-10-14T10:00:00Z'));
  for (const notBefore of [new Date('2026-10-14T12:00:00Z'), wait.notBefore])
    await store.fail(
      guided,
      'RATE_LIMIT',
      'Synthetic quota failure',
      1,
      new Date('2026-10-14T10:01:00Z'),
      'failed',
      { ...wait, notBefore },
    );
  const before = await store.regularRunHeads();
  assert.equal(before.latest.find((r) => r.resourceId === 'search')?.id, guided);
  // 20 newer explicit windows ending two days back: more than the first page.
  for (let i = 0; i < 20; i++) {
    const at = new Date(Date.parse('2026-10-14T10:10:00Z') + i * 1000);
    const older = { from: '2026-10-12', to: '2026-10-12' };
    await store.fail(await store.begin(search, 'totals', older, at), 'NETWORK', 'Window', 1, at);
  }
  assert.equal(
    (await store.runHeads()).latest.find((r) => r.resourceId === 'search')?.to,
    '2026-10-12',
  );
  const scheduled = await store.regularRunHeads();
  assert.deepEqual(
    scheduled.latest.filter((r) => r.resourceId === 'search').map((r) => r.id),
    [guided],
  );
  assert.deepEqual(scheduled.unresolved, []);
  assert.equal(scheduled.latest.filter((r) => r.resourceId === 'source').length, 1);
  assert.deepEqual(scheduled.retryGuidance, [
    { dataset: 'search:totals', runId: guided, notBefore: '2026-10-14T12:00:00.000Z' },
  ]);
  assert.deepEqual(
    dueJobs([{ resource: search, group: 'totals' }], scheduled, new Date('2026-10-14T11:30:00Z')),
    [],
  );
  assert.equal(
    dueJobs([{ resource: search, group: 'totals' }], scheduled, new Date('2026-10-14T12:00:00Z'))[0]
      ?.reason,
    'retry_due',
  );
  // The portable export keeps that wait with its run, in one D1 snapshot.
  const portable = await store.export();
  assert.deepEqual(portable.retryGuidance, scheduled.retryGuidance);
  assert.ok(portable.runs.some((r) => r.id === guided));
  console.log(
    'REAL D1 CONTRACT PASSED: schema, JSON1, fenced publication, correction, replacement, reporting, normalized URL inspection history, transactional snapshot, independent recovery, exact paged due-time heads and provider wait.',
  );
} finally {
  await mf.dispose();
}
