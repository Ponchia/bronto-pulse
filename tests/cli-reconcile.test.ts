import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { parseConfig } from '../src/config.js';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import { fixture } from './helpers.js';
import { addDays } from '../src/time.js';

test('Node CLI reconciliation retains bounded publication and scheduler ownership across restarts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-cli-reconcile-'));
  const configPath = join(directory, 'config.json');
  const dbPath = join(directory, 'pulse.db');
  const config = fixture('gsc', {
    collectQueries: true,
    lookbackDaysByGroup: { queries: 1 },
    reconcileDaysByGroup: { queries: 2 },
  });
  writeFileSync(
    configPath,
    JSON.stringify(parseConfig({ ...config, settings: { ...config.settings, maxRows: 5000 } })),
  );
  const requested: string[] = [];
  let rows = 1;
  let clicks = 3;
  const output: unknown[] = [];
  const priorToken = process.env.TEST_TOKEN;
  process.env.TEST_TOKEN = 'synthetic-reconciliation-token';
  t.mock.method(console, 'log', (line: string) => output.push(JSON.parse(line)));
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.startDate, body.endDate);
    assert.deepEqual(body.dimensions, ['date', 'query']);
    requested.push(body.startDate);
    return Response.json({
      responseAggregationType: 'byPage',
      rows: Array.from({ length: rows }, (_, i) => ({
        keys: [body.startDate, 'synthetic-query-' + i],
        clicks,
        impressions: 10,
        position: 2,
      })),
    });
  });
  const args = [
    '--config',
    configPath,
    '--db',
    dbPath,
    '--ready-only',
    '--execution-profile',
    'free',
    '--json',
  ];
  let store: Store | undefined;
  try {
    assert.equal(await main(['reconcile', ...args]), 0);
    assert.equal(await main(['reconcile', ...args]), 0);
    assert.equal(requested.length, 2);
    assert.equal(requested[1], addDays(requested[0]!, 1));

    store = new Store(new SqliteDriver(dbPath));
    const checkpoint = await store.getSetting('reconciliation_days');
    assert.equal(await store.acquire('reconciliation-scheduler', 'another-process'), true);
    await assert.rejects(main(['reconcile', ...args]), /holds the reconciliation scheduler/);
    assert.equal(requested.length, 2, 'held scheduler cannot contact a provider');
    assert.equal(await store.getSetting('reconciliation_days'), checkpoint);
    await store.release('reconciliation-scheduler', 'another-process');

    // 63 rows expand to 252 normalized observations: the explicit profile must
    // retain the old publication even though the native config allows more.
    rows = 63;
    clicks = 9;
    assert.equal(await main(['reconcile', ...args]), 2);
    assert.equal(requested[2], requested[0]);
    const retained = await store.observations('source', {
      from: requested[0]!,
      to: requested[0]!,
    });
    assert.equal(retained.filter((row) => row.metric === 'gsc.clicks').length, 1);
    assert.equal(retained.find((row) => row.metric === 'gsc.clicks')?.value, 3);
    assert.equal(
      await store.acquire('reconciliation-scheduler', 'lease-check'),
      true,
      'failure releases the outer scheduler lease',
    );
    await store.release('reconciliation-scheduler', 'lease-check');

    rows = 1;
    assert.equal(await main(['reconcile', ...args]), 0);
    assert.equal(requested[3], requested[1], 'failed dates do not starve later corrections');
    const corrected = await store.observations('source', {
      from: requested[1]!,
      to: requested[1]!,
    });
    assert.equal(corrected.find((row) => row.metric === 'gsc.clicks')?.value, 9);
    assert.equal(output.length, 4);

    // The same explicit profile must apply to ordinary Node collection.
    rows = 63;
    assert.equal(await main(['sync', ...args, '--resource', 'source', '--group', 'queries']), 2);
    const failures = await store.runs(10);
    assert.equal(failures[0]?.code, 'ROW_LIMIT');
  } finally {
    store?.driver.close?.();
    if (priorToken === undefined) delete process.env.TEST_TOKEN;
    else process.env.TEST_TOKEN = priorToken;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Node reconciliation is opt-in and ready-only skips unavailable grants without consuming dates', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-cli-reconcile-readiness-'));
  const configPath = join(directory, 'config.json');
  const dbPath = join(directory, 'pulse.db');
  const output: unknown[] = [];
  const priorToken = process.env.TEST_TOKEN;
  delete process.env.TEST_TOKEN;
  t.mock.method(console, 'log', (line: string) => output.push(JSON.parse(line)));
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('No provider request is allowed without an opted-in, ready dataset.');
  });
  let store: Store | undefined;
  try {
    writeFileSync(configPath, JSON.stringify(fixture('gsc')));
    const args = ['--config', configPath, '--db', dbPath, '--ready-only', '--json'];
    assert.equal(await main(['reconcile', ...args]), 0);
    assert.deepEqual(output[0], { pending: 0, results: [] });
    writeFileSync(
      configPath,
      JSON.stringify(
        fixture('gsc', {
          collectQueries: true,
          reconcileDaysByGroup: { queries: 14 },
        }),
      ),
    );
    assert.equal(await main(['reconcile', ...args]), 0);
    store = new Store(new SqliteDriver(dbPath));
    assert.equal(await store.getSetting('reconciliation_days'), undefined);
    assert.deepEqual((output[1] as { results: unknown[] }).results, []);
    assert.deepEqual(await store.runs(10), []);
  } finally {
    store?.driver.close?.();
    if (priorToken === undefined) delete process.env.TEST_TOKEN;
    else process.env.TEST_TOKEN = priorToken;
    rmSync(directory, { recursive: true, force: true });
  }
});
