import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTOR_CATALOG,
  connectorCatalog,
  connectorMetricContracts,
  hasConnector,
} from '../src/collectors/registry.js';
import { METRICS } from '../src/model.js';
import { handle, type ApiContext } from '../src/api/handler.js';
import { database, fixture, now } from './helpers.js';

test('curated connector registry covers every built-in metric once and exposes no credentials', () => {
  assert.equal(connectorMetricContracts(METRICS), true);
  assert.equal(hasConnector('plausible'), true);
  assert.equal(hasConnector('umami'), true);
  assert.equal(hasConnector('https://metadata.google.internal'), false);
  const catalog = connectorCatalog();
  assert.equal(catalog.length, 7);
  for (const manifest of catalog) {
    assert.deepEqual(manifest, CONNECTOR_CATALOG[manifest.id]);
    assert.ok(manifest.groups.length > 0);
    assert.ok(manifest.metrics.length > 0);
    assert.ok(manifest.supportedRuntimes.includes('node'));
    assert.ok(manifest.endpoints.every((url) => url.startsWith('https://')));
  }
  assert.equal(catalog.find((x) => x.id === 'plausible')?.defaultTimeZone, 'site');
  assert.equal(catalog.find((x) => x.id === 'umami')?.providerOrigin, 'fixed');
  (catalog[0]!.metrics as string[]).splice(0, 1);
  assert.equal(connectorMetricContracts(METRICS), true, 'A copy must not mutate shared registry');
  assert.equal(JSON.stringify(CONNECTOR_CATALOG).includes('TEST_TOKEN'), false);
});

test('connector catalog API requires authentication and never accesses provider secrets or collection', async () => {
  const config = fixture('npm');
  const store = await database(config);
  const ctx: ApiContext = {
    config,
    store,
    secrets: { TEST_TOKEN: 'very-private-provider-token' },
    apiToken: 'this-is-a-long-synthetic-owner-token',
    asset: async () => new Response('unused'),
    now: () => now,
  };
  try {
    const url = 'https://pulse.example/api/v1/connectors';
    const denied = await handle(new Request(url), ctx);
    assert.equal(denied.status, 401);
    const allowed = await handle(
      new Request(url, {
        headers: { Authorization: 'Bearer this-is-a-long-synthetic-owner-token' },
      }),
      ctx,
    );
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('cache-control'), 'no-store');
    const data = await allowed.json();
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.connectors.length, 7);
    assert.equal(JSON.stringify(data).includes('very-private-provider-token'), false);
    assert.equal((await store.runs()).length, 0);
  } finally {
    store.driver.close?.();
  }
});

test('offline CLI connector discovery reads no configuration, credentials or database', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-registry-'));
  try {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), cli, 'connectors', '--json'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { HOME: dir, PATH: process.env.PATH, TZ: 'UTC' },
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.connectors.length, 7);
    assert.equal(
      json.connectors.find((x: { id: string }) => x.id === 'plausible').defaultTimeZone,
      'site',
    );
    assert.equal(
      json.connectors.find((x: { id: string }) => x.id === 'umami').providerOrigin,
      'fixed',
    );
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(dir, '.pulse')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
