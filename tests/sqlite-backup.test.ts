import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import { recordReview } from '../src/journal.js';
import { entry } from '../src/collectors/context.js';
import { fixture, publish } from './helpers.js';

const script = fileURLToPath(new URL('../deploy/backup-sqlite.mjs', import.meta.url));
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-sqlite-backup-'));
  const dbPath = join(directory, 'pulse.db');
  const output = join(directory, 'backups');
  const driver = new SqliteDriver(dbPath);
  const store = new Store(driver);
  const config = fixture('gsc');
  await store.migrate();
  await store.register(config);
  await publish(store, config, [entry('gsc.impressions', '2026-10-12', 3)], 'totals');
  await publish(store, config, [entry('gsc.impressions', '2026-10-12', 4)], 'totals');
  await store.setSetting('reconciliation_days', '{"source:totals":"2026-10-12"}');
  await recordReview(config, store, {
    id: 'synthetic-backup-review',
    projectId: 'project',
    window: { from: '2026-10-12', to: '2026-10-13' },
    question: 'Does the synthetic snapshot preserve history?',
    conclusion: 'Keep both collection attempts.',
  });
  const inspection = {
    id: '00000000-0000-4000-8000-000000000001',
    resourceId: 'source',
    url: 'https://example.invalid/',
    inspectedAt: '2026-10-13T00:00:00Z',
    status: 'unknown',
    verdict: null,
    coverageState: null,
    declaredCanonical: null,
    googleCanonical: null,
    lastCrawlTime: null,
    sitemaps: null,
    errorCode: null,
  };
  driver.database
    .prepare('INSERT INTO url_inspections VALUES(?,?,?,?,?)')
    .run(
      inspection.id,
      'source',
      inspection.url,
      inspection.inspectedAt,
      JSON.stringify(inspection),
    );
  driver.database.exec(
    'CREATE TABLE backup_parent(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);CREATE TABLE backup_child(id INTEGER PRIMARY KEY,value INTEGER NOT NULL,FOREIGN KEY(id) REFERENCES backup_parent(id));INSERT INTO backup_parent VALUES(1,1);INSERT INTO backup_child VALUES(1,1);',
  );
  const cleanup = () => {
    if (driver.database.isTransaction) driver.database.exec('ROLLBACK');
    driver.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { directory, dbPath, output, driver, store, cleanup };
}
function run(db: string, output: string, extra: string[] = []) {
  return spawnSync(process.execPath, [script, '--db', db, '--out-dir', output, ...extra], {
    encoding: 'utf8',
    timeout: 20000,
    env: { PATH: process.env.PATH, TZ: 'UTC' },
  });
}
function files(directory: string) {
  return readdirSync(directory).sort();
}
test('full SQLite backup reads committed WAL history and preserves superseded runs, reviews and cursors', async () => {
  const x = await setup();
  try {
    assert.ok(statSync(x.dbPath + '-wal').size > 0);
    const rawReview = x.driver.database.prepare('SELECT record_json FROM review_records').get()!
      .record_json;
    x.driver.database.exec(
      'BEGIN IMMEDIATE;UPDATE backup_parent SET value=2;UPDATE backup_child SET value=2;',
    );
    const result = run(x.dbPath, x.output);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.ok, true);
    assert.equal(manifest.offBoxVerified, false);
    assert.equal(manifest.tables.runs.rows, 2);
    assert.equal(manifest.tables.observations.rows, 2);
    assert.equal(manifest.tables.review_records.rows, 1);
    assert.equal(manifest.tables.url_inspections.rows, 1);
    assert.equal(manifest.tables.backup_parent.rows, 1);
    const path = join(x.output, manifest.file);
    assert.equal(digest(path), manifest.sha256);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(path + '.json').mode & 0o777, 0o600);
    assert.equal(statSync(x.output).mode & 0o777, 0o700);
    const restored = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(restored.prepare('SELECT value FROM backup_parent').get()!.value, 1);
      assert.equal(restored.prepare('SELECT value FROM backup_child').get()!.value, 1);
      assert.equal(
        restored.prepare('SELECT record_json FROM review_records').get()!.record_json,
        rawReview,
      );
      assert.equal(
        restored.prepare("SELECT value FROM metadata WHERE key='reconciliation_days'").get()!.value,
        '{"source:totals":"2026-10-12"}',
      );
    } finally {
      restored.close();
    }
    assert.equal(
      x.driver.database.prepare('SELECT value FROM backup_parent').get()!.value,
      2,
      'backup leaves the separate writer transaction intact',
    );
    x.driver.database.exec('ROLLBACK');
    assert.equal(files(x.output).length, 2, 'only the complete archive and its manifest remain');
  } finally {
    x.cleanup();
  }
});
test('online backup remains transactionally consistent while a separate WAL connection keeps committing', async () => {
  const x = await setup();
  let interval: ReturnType<typeof setInterval> | undefined;
  try {
    x.driver.database.exec(
      'CREATE TABLE backup_payload(id INTEGER PRIMARY KEY,payload BLOB);BEGIN;',
    );
    const insert = x.driver.database.prepare('INSERT INTO backup_payload VALUES(?,?)');
    for (let i = 0; i < 2048; i++) insert.run(i, Buffer.alloc(1024, i % 251));
    x.driver.database.exec('COMMIT');
    let generation = 1;
    const child = spawn(process.execPath, [script, '--db', x.dbPath, '--out-dir', x.output], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    interval = setInterval(() => {
      generation++;
      x.driver.database.exec('BEGIN IMMEDIATE;');
      x.driver.database.prepare('UPDATE backup_parent SET value=?').run(generation);
      x.driver.database.prepare('UPDATE backup_child SET value=?').run(generation);
      x.driver.database.exec('COMMIT');
    }, 2);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    const code = await new Promise<number | null>((resolveResult, reject) => {
      child.once('error', reject);
      child.once('exit', resolveResult);
    });
    clearTimeout(timeout);
    clearInterval(interval);
    interval = undefined;
    assert.equal(code, 0, stdout + stderr);
    assert.ok(generation > 2, 'another connection committed during the backup operation');
    const manifest = JSON.parse(stdout);
    const restored = new DatabaseSync(join(x.output, manifest.file), { readOnly: true });
    try {
      const parent = restored.prepare('SELECT value FROM backup_parent').get()!.value;
      const childValue = restored.prepare('SELECT value FROM backup_child').get()!.value;
      assert.equal(parent, childValue, 'a backup cannot mix generations from separate commits');
      assert.equal(
        restored.prepare('SELECT count(*) AS count FROM backup_payload').get()!.count,
        2048,
      );
    } finally {
      restored.close();
    }
  } finally {
    if (interval) clearInterval(interval);
    x.cleanup();
  }
});
test('retention removes only verified owned archive pairs and preserves foreign or tampered files', async () => {
  const x = await setup();
  try {
    const first = run(x.dbPath, x.output, ['--retain', '2']);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const firstFile = JSON.parse(first.stdout).file;
    const unrelated = join(x.output, 'operator-keep.db');
    writeFileSync(unrelated, 'private synthetic operator file', { mode: 0o600 });
    const unverified = join(x.output, 'pulse-sqlite-20200101T000000000Z-aaaaaaaaaaaa.db');
    writeFileSync(unverified, 'unverified synthetic bytes', { mode: 0o600 });
    writeFileSync(unverified + '.json', '{}', { mode: 0o600 });
    for (let i = 0; i < 2; i++) {
      const result = run(x.dbPath, x.output, ['--retain', '2']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    assert.equal(existsSync(join(x.output, firstFile)), false);
    assert.equal(existsSync(join(x.output, firstFile + '.json')), false);
    assert.equal(readFileSync(unrelated, 'utf8'), 'private synthetic operator file');
    assert.equal(readFileSync(unverified, 'utf8'), 'unverified synthetic bytes');
    assert.equal(files(x.output).filter((name) => name.endsWith('.db')).length, 4);
  } finally {
    x.cleanup();
  }
});
test('unsafe paths, overlapping jobs and invalid sources fail without changing prior snapshots or disclosing data', async () => {
  const x = await setup();
  try {
    const initial = run(x.dbPath, x.output);
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    const prior = files(x.output);
    const priorHashes = prior.map((name) => digest(join(x.output, name)));
    const sourceLink = join(x.directory, 'source-link.db');
    symlinkSync(x.dbPath, sourceLink);
    const outLink = join(x.directory, 'output-link');
    symlinkSync(x.output, outLink);
    for (const [db, output] of [
      [join(x.directory, 'missing.db'), x.output],
      [sourceLink, x.output],
      [x.dbPath, outLink],
      [x.dbPath, x.dbPath],
    ]) {
      const result = run(db!, output!);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).ok, false);
    }
    assert.equal(existsSync(join(x.directory, 'missing.db')), false);
    const lock = join(x.output, '.pulse-sqlite-backup.lock');
    mkdirSync(lock, { mode: 0o700 });
    const overlap = run(x.dbPath, x.output);
    assert.equal(JSON.parse(overlap.stdout).category, 'already-running');
    assert.equal(existsSync(lock), true, 'another operation owns this lock');
    rmSync(lock, { recursive: true });
    x.driver.database.exec(
      "PRAGMA foreign_keys=OFF;CREATE TABLE backup_bad_fk(id TEXT REFERENCES resources(id));INSERT INTO backup_bad_fk VALUES('synthetic-private-value-never-print');PRAGMA foreign_keys=ON;",
    );
    const invalid = run(x.dbPath, x.output);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).category, 'backup-verification');
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /synthetic-private-value-never-print/);
    assert.deepEqual(files(x.output), prior);
    assert.deepEqual(
      prior.map((name) => digest(join(x.output, name))),
      priorHashes,
    );
  } finally {
    x.cleanup();
  }
});
test('snapshot size budget includes committed pages still held in WAL and leaves prior backups intact', async () => {
  const x = await setup();
  try {
    assert.equal(run(x.dbPath, x.output).status, 0);
    const prior = files(x.output);
    x.driver.database.exec(
      'CREATE TABLE oversized_backup(payload BLOB);INSERT INTO oversized_backup VALUES(zeroblob(2097152));',
    );
    const result = run(x.dbPath, x.output, ['--max-bytes', '1048576']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).category, 'backup-size');
    assert.deepEqual(files(x.output), prior);
  } finally {
    x.cleanup();
  }
});
