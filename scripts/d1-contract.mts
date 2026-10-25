import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Store } from '../src/storage/store.js';
import { D1Driver } from '../src/storage/driver.js';
import { fixture, publish, sample, window, now } from '../tests/helpers.js';
import { projectReport, portfolio } from '../src/report.js';
import { doctor } from '../src/sync.js';
import { projectBrief } from '../src/brief.js';
import { parseConfig } from '../src/config.js';
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
  console.log(
    'REAL D1 CONTRACT PASSED: schema, JSON1, fenced publication, correction, replacement, reporting, normalized URL inspection history, transactional snapshot, independent recovery.',
  );
} finally {
  await mf.dispose();
}
