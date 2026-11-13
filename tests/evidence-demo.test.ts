import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { demoConfig, evidenceDemoConfig, seedDemo } from '../src/demo.js';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import { projectReport } from '../src/report.js';
import { reportRange } from '../src/time.js';

const now = new Date('2026-11-13T12:00:00Z');

test('original demo remains four projects with no new website policies or credentials', () => {
  const original = demoConfig();
  assert.equal(original.demo, true);
  assert.equal(original.projects.length, 4);
  assert.equal(original.resources.length, 6);
  assert.equal(original.projects.find((p) => p.id === 'sense6')?.websites, undefined);
  assert.equal(original.connections.length, 0);
});

test('evidence demo combines independent synthetic website sources without inventing an audience', async () => {
  const store = new Store(new SqliteDriver(':memory:'));
  await store.migrate();
  try {
    const configured = evidenceDemoConfig();
    assert.equal(configured.demo, true);
    assert.equal(configured.projects.length, 4);
    assert.equal(configured.resources.length, 9);
    assert.equal(configured.connections.length, 2);
    assert.ok(configured.connections.every((c) => c.tokenEnv?.startsWith('DEMO_')));
    const config = await seedDemo(store, now, 'evidence');
    assert.deepEqual(config, configured);
    const report = await projectReport(
      config,
      store,
      'sense6',
      reportRange({ days: 28 }, now),
      now,
    );
    assert.equal(report.websites?.length, 1);
    const website = report.websites![0]!;
    assert.equal(website.hostname, 'sense6.example.org');
    assert.equal(website.source, 'sense6-rum');
    assert.equal(website.status, 'ready');
    assert.ok((website.value ?? 0) > 0);
    assert.deepEqual(
      website.comparisons.map((x) => [x.source, x.status]),
      [
        ['sense6-plausible', 'incompatible'],
        ['sense6-umami', 'side_by_side'],
      ],
    );
    assert.equal(website.comparisons[0]!.difference, null);
    assert.match(website.comparisons[0]!.reasons.join(' '), /different calendar timezones/);
    const difference = website.comparisons[1]!.difference;
    assert.ok(difference && difference.absolute < 0);
    assert.ok(difference && difference.percentOfPrimary !== null);
    assert.equal(
      website.alternatives.length,
      3,
      'Plausible and Umami counts remain visible but not combined',
    );
    assert.equal(
      report.cards.some((x) => x.metric === 'sense6.test_started'),
      true,
    );
    assert.equal(
      report.cards.some((x) => x.metric === 'sense6.test_completed'),
      true,
    );
    assert.equal(report.cards.filter((x) => x.metric.endsWith('.pageviews')).length, 3);
    assert.equal(report.evidence.humanAudience, 'not_measured');
    assert.equal(report.evidence.automatedShare, 'not_measured');
    assert.equal(report.evidence.independentAdoption, 'not_measured');
    assert.ok(
      report.warnings.every((warning) => !warning.includes('Invalid provider credentials')),
    );
    assert.equal(
      (await store.runs()).every((r) => r.status === 'success'),
      true,
    );
  } finally {
    store.driver.close?.();
  }
});

test('evidence CLI scenario is offline, private, stable and isolated from the standard demo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-evidence-demo-'));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const loader = import.meta.resolve('tsx');
  try {
    const guard = join(dir, 'no-network.mjs');
    writeFileSync(
      guard,
      'globalThis.fetch = async () => { throw Error("NO_PROVIDER_NETWORK_PERMITTED"); };\n',
    );
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', guard, '--import', loader, cli, ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          TZ: 'UTC',
        },
        timeout: 15000,
      });
    const invalid = run(['demo', '--scenario', 'unknown']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Unknown demo scenario/);
    assert.equal(existsSync(join(dir, '.pulse')), false);
    const unrelated = run(['validate', '--scenario', 'evidence']);
    assert.equal(unrelated.status, 1);
    assert.match(unrelated.stderr, /applies only/);
    assert.equal(existsSync(join(dir, '.pulse')), false);

    for (let pass = 0; pass < 2; pass++) {
      const result = run(['demo', '--scenario', 'evidence']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /SYNTHETIC demo data seeded/);
      assert.doesNotMatch(result.stderr, /NO_PROVIDER_NETWORK_PERMITTED/);
    }
    const db = join(dir, '.pulse', 'demo-evidence.db');
    const configFile = join(dir, '.pulse', 'demo-evidence.config.json');
    assert.equal(existsSync(db), true);
    assert.equal(existsSync(configFile), true);
    assert.equal(existsSync(join(dir, '.pulse', 'demo.db')), false);
    assert.equal(existsSync(join(dir, '.pulse', 'demo.config.json')), false);
    const json = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(json.demo, true);
    assert.equal(json.projects.find((p: { id: string }) => p.id === 'sense6').websites.length, 1);
    if (process.platform !== 'win32') {
      assert.equal(statSync(configFile).mode & 0o777, 0o600);
      assert.equal(statSync(db).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
