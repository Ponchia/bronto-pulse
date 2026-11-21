#!/usr/bin/env node
/** Private, bounded full SQLite snapshots. No migrations, catalog writes or provider access. */
import {
  chmodSync,
  closeSync,
  createReadStream,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync, backup } from 'node:sqlite';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEADLINE_MS = 180_000;
const ARCHIVE = /^pulse-sqlite-\d{8}T\d{9}Z-[a-f0-9]{12}\.db$/;
const REQUIRED_TABLES = [
  'metadata',
  'resources',
  'config_versions',
  'leases',
  'runs',
  'observations',
  'partitions',
  'annotations',
  'url_inspections',
  'review_records',
];
class BackupFailure extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}
const fail = (category) => {
  throw new BackupFailure(category);
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
function checkTime(deadline) {
  if (Date.now() >= deadline) fail('backup-timeout');
}
function privatePath(path, directory = false) {
  const info = lstatSync(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 ||
    realpathSync(path) !== path
  )
    fail('operator-setup');
  return info;
}
function fsyncFile(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
async function checksum(path, deadline) {
  checkTime(deadline);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, {
    highWaterMark: 256 * 1024,
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  })) {
    checkTime(deadline);
    digest.update(chunk);
  }
  return digest.digest('hex');
}
function fingerprint(db) {
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
    fail('backup-verification');
  if (db.prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1').get())
    fail('backup-verification');
  const schema = db
    .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
    .all();
  const tables = schema
    .filter((row) => row.type === 'table')
    .map((row) => row.name)
    .sort();
  if (REQUIRED_TABLES.some((name) => !tables.includes(name))) fail('backup-verification');
  const version = db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value;
  const config = db.prepare("SELECT value FROM metadata WHERE key='config'").get()?.value;
  if (version !== '1' || typeof config !== 'string') fail('backup-verification');
  const parsed = JSON.parse(config);
  if (
    !Array.isArray(parsed.projects) ||
    !parsed.projects.length ||
    !Array.isArray(parsed.resources) ||
    !parsed.resources.length ||
    db.prepare('SELECT count(*) AS count FROM resources').get().count !== parsed.resources.length
  )
    fail('backup-verification');
  const result = {
    schemaVersion: version,
    configurationSha256: sha(config),
    schemaSha256: sha(JSON.stringify(schema)),
    tables: {},
  };
  for (const name of tables) {
    const columns = db.prepare('PRAGMA table_info(' + quote(name) + ')').all();
    const key = columns
      .filter((column) => column.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    const order = key.length ? key : columns.map((column) => column.name);
    const rows = db.prepare(
      'SELECT * FROM ' + quote(name) + ' ORDER BY ' + order.map(quote).join(','),
    );
    rows.setReadBigInts(true);
    const digest = createHash('sha256');
    digest.update(JSON.stringify(columns.map((column) => column.name)) + '\n');
    let count = 0;
    for (const row of rows.iterate()) {
      const values = columns.map((column) => {
        const value = row[column.name];
        return typeof value === 'bigint'
          ? ['integer', value.toString()]
          : value instanceof Uint8Array
            ? ['blob', Buffer.from(value).toString('base64')]
            : [typeof value, value];
      });
      digest.update(JSON.stringify(values) + '\n');
      count += 1;
    }
    result.tables[name] = { rows: count, sha256: digest.digest('hex') };
  }
  result.fingerprintSha256 = sha(JSON.stringify(result));
  return result;
}
async function snapshot({ db: sourcePath, destination, maxBytes }) {
  let source;
  let copy;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5000 });
    source.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192; BEGIN;');
    // The first read pins a consistent WAL snapshot. Other connections may keep
    // committing, while this connection and its backup observe the same version.
    const pages = source.prepare('PRAGMA page_count').get().page_count;
    const pageSize = source.prepare('PRAGMA page_size').get().page_size;
    if (pages * pageSize > maxBytes) fail('backup-size');
    const before = fingerprint(source);
    await backup(source, destination, { rate: 100 });
    if (statSync(destination).size > maxBytes) fail('backup-size');
    // Normalize only the private destination: the published archive must remain
    // a standalone file when inspected later, without inherited WAL sidecars.
    copy = new DatabaseSync(destination, { timeout: 5000 });
    copy.exec('PRAGMA journal_mode=DELETE; PRAGMA query_only=ON; PRAGMA cache_size=-8192;');
    const after = fingerprint(copy);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail('backup-verification');
    return after;
  } catch (error) {
    if (error instanceof BackupFailure) throw error;
    fail('backup-verification');
  } finally {
    copy?.close();
    if (source?.isTransaction) source.exec('ROLLBACK');
    source?.close();
  }
}
async function boundedSnapshot(data, deadline) {
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let message;
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        void worker.terminate();
      },
      Math.max(1, deadline - Date.now()),
    );
    worker.on('message', (value) => {
      message = value;
    });
    worker.on('error', () => {
      message = { ok: false, category: 'backup-failed' };
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new BackupFailure('backup-timeout'));
      else if (code !== 0 || !message?.ok)
        reject(new BackupFailure(message?.category ?? 'backup-failed'));
      else resolveResult(message.fingerprint);
    });
  });
}
async function verifiedArchives(directory, sourceInfo, deadline) {
  const names = readdirSync(directory);
  if (names.length > 4096) fail('operator-setup');
  const verified = [];
  for (const name of names.sort()) {
    if (!ARCHIVE.test(name)) continue;
    const path = join(directory, name);
    try {
      const info = privatePath(path);
      const manifestPath = path + '.json';
      const manifestInfo = privatePath(manifestPath);
      if (
        (info.dev === sourceInfo.dev && info.ino === sourceInfo.ino) ||
        info.nlink !== 1 ||
        manifestInfo.nlink !== 1 ||
        manifestInfo.size > 65536
      )
        continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (
        manifest.format !== 'bronto-pulse-sqlite-backup' ||
        manifest.version !== 1 ||
        manifest.schemaVersion !== '1' ||
        !/^[a-f0-9]{64}$/.test(manifest.fingerprintSha256 ?? '') ||
        !/^[a-f0-9]{64}$/.test(manifest.configurationSha256 ?? '') ||
        info.size > 1073741824 ||
        manifest.file !== name ||
        manifest.integrity !== 'ok' ||
        manifest.foreignKeyViolations !== 0 ||
        manifest.bytes !== info.size ||
        !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') ||
        !Number.isFinite(Date.parse(manifest.createdAt)) ||
        (await checksum(path, deadline)) !== manifest.sha256
      )
        continue;
      verified.push({
        name,
        path,
        info,
        manifestPath,
        manifestInfo,
        createdAt: manifest.createdAt,
      });
    } catch (error) {
      if (error instanceof BackupFailure && error.category === 'backup-timeout') throw error;
      // Foreign, partial, changed or unreadable files stay untouched.
    }
  }
  return verified.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name),
  );
}
function unchanged(path, expected) {
  const current = lstatSync(path);
  return (
    current.isFile() &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs &&
    current.nlink === 1
  );
}
async function main() {
  let lock;
  let scratch;
  let published;
  try {
    if (!process.getuid) fail('operator-setup');
    process.umask(0o077);
    const { values } = parseArgs({
      options: {
        db: { type: 'string' },
        'out-dir': { type: 'string' },
        retain: { type: 'string', default: '14' },
        'max-bytes': { type: 'string', default: String(DEFAULT_MAX_BYTES) },
      },
      strict: true,
      allowPositionals: false,
    });
    if (
      !values.db ||
      !values['out-dir'] ||
      !/^\d+$/.test(values.retain) ||
      !/^\d+$/.test(values['max-bytes'])
    )
      fail('operator-setup');
    const retain = Number(values.retain);
    const maxBytes = Number(values['max-bytes']);
    if (
      !Number.isSafeInteger(retain) ||
      retain < 2 ||
      retain > 31 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1048576 ||
      maxBytes > 1073741824
    )
      fail('operator-setup');
    const sourcePath = resolve(values.db);
    const directory = resolve(values['out-dir']);
    const sourceInfo = privatePath(sourcePath);
    if (sourceInfo.size > maxBytes) fail('backup-size');
    for (const suffix of ['-wal', '-shm']) {
      try {
        privatePath(sourcePath + suffix);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privatePath(directory, true);
    if (readdirSync(directory).length > 4096) fail('operator-setup');
    const lockPath = join(directory, '.pulse-sqlite-backup.lock');
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') fail('already-running');
      throw error;
    }
    lock = lockPath;
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    scratch = mkdtempSync(join(directory, '.pulse-sqlite-pending-'));
    const destination = join(scratch, 'snapshot.db');
    const deadline = Date.now() + DEADLINE_MS;
    const fingerprint = await boundedSnapshot({ db: sourcePath, destination, maxBytes }, deadline);
    chmodSync(destination, 0o600);
    const bytes = statSync(destination).size;
    if (bytes > maxBytes) fail('backup-size');
    const createdAt = new Date().toISOString();
    const name =
      'pulse-sqlite-' +
      createdAt.replaceAll(/[-:.]/g, '') +
      '-' +
      randomBytes(6).toString('hex') +
      '.db';
    const manifest = {
      format: 'bronto-pulse-sqlite-backup',
      version: 1,
      createdAt,
      file: name,
      bytes,
      sha256: await checksum(destination, deadline),
      integrity: 'ok',
      foreignKeyViolations: 0,
      ...fingerprint,
      offBoxVerified: false,
    };
    const tempManifest = join(scratch, 'manifest.json');
    writeFileSync(tempManifest, JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    fsyncFile(destination);
    fsyncFile(tempManifest);
    // Atomic, no-replace publication. An archive is valid only with its complete
    // checksum manifest; a crash between these links cannot prune older backups.
    const finalPath = join(directory, name);
    linkSync(destination, finalPath);
    unlinkSync(destination);
    linkSync(tempManifest, finalPath + '.json');
    unlinkSync(tempManifest);
    fsyncFile(directory);
    published = manifest;
    const verified = await verifiedArchives(directory, sourceInfo, deadline);
    let removed = 0;
    for (const entry of verified.slice(retain)) {
      checkTime(deadline);
      if (!unchanged(entry.path, entry.info) || !unchanged(entry.manifestPath, entry.manifestInfo))
        continue;
      unlinkSync(entry.path);
      unlinkSync(entry.manifestPath);
      removed += 1;
    }
    fsyncFile(directory);
    console.log(JSON.stringify({ ok: true, ...manifest, oldVerifiedArchivesRemoved: removed }));
    return 0;
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        category: error instanceof BackupFailure ? error.category : 'operator-setup',
        ...(published
          ? { backupPublished: true, file: published.file, sha256: published.sha256 }
          : {}),
      }),
    );
    return 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (lock) rmSync(lock, { recursive: true, force: true });
  }
}
if (isMainThread) process.exitCode = await main();
else {
  try {
    parentPort.postMessage({ ok: true, fingerprint: await snapshot(workerData) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      category: error instanceof BackupFailure ? error.category : 'backup-failed',
    });
  }
}
