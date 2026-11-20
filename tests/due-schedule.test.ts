import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { dueJobs } from '../src/due-schedule.js';
import type { Run } from '../src/model.js';
import { scheduleOptions } from '../src/worker-schedule.js';
import { database, fixture } from './helpers.js';
import { entry, collected } from '../src/collectors/context.js';
import { addDays } from '../src/time.js';
import { sync } from '../src/sync.js';
import worker, { type WorkerEnv } from '../src/worker.js';

const now = new Date('2026-11-13T12:00:00Z');
function packages() {
  return parseConfig({
    version: 1,
    settings: { lookbackDays: 7, maxRows: 100 },
    resources: [
      { id: 'a', provider: 'npm', package: 'alpha', refreshHours: 24 },
      { id: 'b', provider: 'npm', package: 'beta' },
      { id: 'c', provider: 'npm', package: 'gamma', refreshHours: 48 },
    ],
    projects: [
      {
        id: 'project',
        label: 'Project',
        resources: [{ resource: 'a' }, { resource: 'b' }, { resource: 'c' }],
      },
    ],
  });
}
function run(
  resourceId: string,
  status: Run['status'],
  at: string,
  code: string | null = null,
  to = '2026-11-12',
): Run {
  return {
    id: resourceId + ':' + status + ':' + at,
    resourceId,
    group: 'downloads',
    from: '2026-11-01',
    to,
    status,
    startedAt: at,
    finishedAt: status === 'running' ? null : at,
    rows: status === 'success' ? 7 : 0,
    requests: 1,
    code,
    message: null,
    notes: [],
    completeness: status === 'success' ? 'complete' : null,
  };
}

test('due-time scheduling prioritizes never-collected sources without starving unrelated groups', () => {
  const resources = packages().resources;
  const jobs = resources.map((resource) => ({ resource, group: 'downloads' }));
  const initial = dueJobs(jobs, { latest: [], successful: [] }, now);
  assert.deepEqual(
    initial.map((j) => j.resource.id),
    ['a', 'b', 'c'],
  );
  assert.ok(initial.every((j) => j.reason === 'never_collected'));
  const a = run('a', 'success', '2026-11-13T10:00:00Z');
  const b = run('b', 'failed', '2026-11-13T11:30:00Z', 'RATE_LIMIT');
  const backlog = dueJobs(jobs, { latest: [a, b], successful: [a] }, now);
  assert.deepEqual(
    backlog.map((j) => j.resource.id),
    ['c'],
  );
  // Once all never-collected datasets are attempted, a deferred quota
  // failure can return; it never occupies every cron slot.
  const after = dueJobs(
    jobs,
    { latest: [a, b], successful: [a] },
    new Date('2026-11-13T12:31:00Z'),
  );
  assert.deepEqual(
    after.map((j) => j.resource.id),
    ['c', 'b'],
  );
  assert.equal(after[1]?.reason, 'retry_due');
});

test('freshness uses configured per-source intervals and a bounded running grace period', () => {
  const jobs = packages().resources.map((resource) => ({ resource, group: 'downloads' }));
  const a = run('a', 'success', '2026-11-12T09:00:00Z');
  const c = run('c', 'success', '2026-11-12T09:00:00Z');
  const b = run('b', 'running', '2026-11-13T11:30:00Z');
  assert.deepEqual(
    dueJobs(jobs, { latest: [a, b, c], successful: [a, c] }, now).map((j) => j.resource.id),
    ['a'],
  );
  assert.deepEqual(
    dueJobs(jobs, { latest: [a, b, c], successful: [a, c] }, new Date('2026-11-13T12:31:00Z')).map(
      (j) => j.resource.id,
    ),
    ['a', 'b'],
  );
});

test('source calendars respect Plausible IANA timezone instead of guessing UTC', () => {
  const config = parseConfig({
    version: 1,
    connections: [{ id: 'p', provider: 'plausible', tokenEnv: 'P_TOKEN' }],
    resources: [
      {
        id: 'p',
        provider: 'plausible',
        siteId: 'example.org',
        timezone: 'America/Los_Angeles',
        connection: 'p',
      },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'p' }] }],
  });
  const local = new Date('2026-11-13T01:00:00Z');
  const success = run('p', 'success', '2026-11-12T21:00:00Z', null, '2026-11-11');
  success.group = 'traffic';
  const items = dueJobs(
    [{ resource: config.resources[0]!, group: 'traffic' }],
    { latest: [success], successful: [success] },
    local,
  );
  assert.deepEqual(items, [], 'Local November 12 has November 11 as last complete site day');
});

test('outdated history backfills cannot displace a newer regular-run source date', async () => {
  const config = fixture('npm');
  const resource = config.resources[0]!;
  const store = await database(config);
  try {
    const owner = crypto.randomUUID();
    const key = resource.id + ':downloads';
    assert.equal(await store.acquire(key, owner), true);
    const sourceWindow = { from: '2026-11-06', to: '2026-11-12' };
    const regularStarted = new Date('2026-11-13T09:55:00Z');
    const regular = await store.begin(resource, 'downloads', sourceWindow, regularStarted);
    await store.publish(
      regular,
      resource,
      'downloads',
      collected(sourceWindow, [entry('npm.downloads', '2026-11-12', 10)]),
      key,
      owner,
      1,
      new Date('2026-11-13T10:00:00Z'),
      100,
    );
    await store.release(key, owner);
    const historical = await store.begin(
      resource,
      'downloads',
      { from: '2026-10-01', to: '2026-10-07' },
      new Date('2026-11-13T11:00:00Z'),
    );
    await store.fail(
      historical,
      'RATE_LIMIT',
      'Synthetic backfill quota error',
      1,
      new Date('2026-11-13T11:01:00Z'),
    );
    assert.equal((await store.runHeads()).latest[0]?.id, historical);
    const heads = await store.regularRunHeads();
    assert.equal(heads.latest[0]?.id, regular);
    assert.equal(heads.successful[0]?.id, regular);
    assert.deepEqual(dueJobs([{ resource, group: 'downloads' }], heads, now), []);
  } finally {
    store.driver.close?.();
  }
});

test('midnight does not reset a two-day or thirty-day refresh interval', () => {
  const cfg = packages();
  const longSource = cfg.resources[2]!;
  const priorDaySuccess = run('c', 'success', '2026-11-12T23:30:00Z', null, '2026-11-11');
  assert.deepEqual(
    dueJobs(
      [{ resource: longSource, group: 'downloads' }],
      { latest: [priorDaySuccess], successful: [priorDaySuccess] },
      new Date('2026-11-13T00:10:00Z'),
    ),
    [],
  );
  const extended = { ...longSource, refreshHours: 720 };
  const tenDaysAgo = run('c', 'success', '2026-10-31T12:00:00Z', null, '2026-10-30');
  assert.deepEqual(
    dueJobs(
      [{ resource: extended, group: 'downloads' }],
      { latest: [tenDaysAgo], successful: [tenDaysAgo] },
      now,
    ),
    [],
  );
  const oldBackfill = run('c', 'success', '2026-11-13T11:45:00Z', null, '2026-11-01');
  assert.equal(
    dueJobs(
      [{ resource: extended, group: 'downloads' }],
      { latest: [oldBackfill], successful: [oldBackfill] },
      now,
    )[0]?.reason,
    'never_collected',
  );
});

test('invalid refreshHours are refused, and existing profiles remain unchanged unless enabled', () => {
  assert.equal(packages().resources[1]?.refreshHours, undefined);
  for (const invalid of [0, 721, -1, 1.5]) {
    const cfg = packages();
    const resources = cfg.resources.map((r) => ({ ...r }));
    resources[0]!.refreshHours = invalid;
    assert.throws(() => parseConfig({ ...cfg, resources }), /Invalid project configuration/);
  }
  assert.deepEqual(scheduleOptions({}), { maxJobs: 8 });
  assert.deepEqual(scheduleOptions({ PULSE_EXECUTION_PROFILE: 'free', PULSE_DUE_ONLY: 'true' }), {
    maxJobs: 1,
    maximumRequests: 8,
    maximumBytes: 262144,
    maximumRows: 250,
    retryRateLimits: false,
    dueOnly: true,
  });
  assert.deepEqual(scheduleOptions({ PULSE_DUE_ONLY: 'false' }), { maxJobs: 8 });
  for (const invalid of ['', '1', 'TRUE', 'on']) {
    assert.throws(
      () => scheduleOptions({ PULSE_DUE_ONLY: invalid }),
      /Invalid due-time collection setting/,
    );
  }
});

test('opt-in sync collects due npm datasets once and defers failed rate-limit sources', async () => {
  const cfg = packages();
  const store = await database(cfg);
  const start = new Date();
  const received: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    assert.equal(u.origin, 'https://api.npmjs.org');
    const match = /^\/downloads\/range\/(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(
      u.pathname,
    );
    assert.ok(match);
    const packageId = decodeURIComponent(match[3]!);
    received.push(packageId);
    if (packageId === 'alpha') return new Response('{}', { status: 429 });
    const from = match[1]!,
      to = match[2]!;
    const downloads: { day: string; downloads: number }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) downloads.push({ day: d, downloads: 1 });
    return Response.json({ start: from, end: to, package: packageId, downloads });
  };
  const options = {
    dueOnly: true,
    maxJobs: 1,
    now: start,
    fetcher,
    retryRateLimits: false,
  };
  try {
    const first = await sync(cfg, store, {}, options);
    assert.deepEqual(
      first.map((x) => [x.resourceId, x.status, x.code]),
      [['a', 'failed', 'RATE_LIMIT']],
    );
    const second = await sync(cfg, store, {}, options);
    assert.deepEqual(
      second.map((x) => [x.resourceId, x.status]),
      [['b', 'success']],
    );
    const third = await sync(cfg, store, {}, options);
    assert.deepEqual(
      third.map((x) => [x.resourceId, x.status]),
      [['c', 'success']],
    );
    assert.deepEqual(await sync(cfg, store, {}, options), []);
    assert.deepEqual(received, ['alpha', 'beta', 'gamma']);
    assert.equal((await store.runHeads()).latest.length, 3);
    await assert.rejects(
      sync(cfg, store, {}, { ...options, rotate: true }),
      /cannot combine with rotation/,
    );
    await assert.rejects(
      sync(cfg, store, {}, { ...options, window: { from: '2026-10-01', to: '2026-10-02' } }),
      /explicit collection window/,
    );
  } finally {
    store.driver.close?.();
  }
});

test('Worker refuses an invalid due-only selector before reading D1 or private config', async () => {
  let dbReads = 0;
  const env: WorkerEnv = {
    DB: {
      prepare() {
        dbReads++;
        throw Error('Should not query D1');
      },
      async batch() {
        dbReads++;
        throw Error('Should not batch D1');
      },
    },
    ASSETS: {
      async fetch() {
        return new Response('unused');
      },
    },
    PULSE_CONFIG: 'not valid JSON',
    PULSE_DUE_ONLY: 'YES',
  };
  await assert.rejects(
    worker.scheduled({ scheduledTime: Date.now() }, env),
    /Invalid due-time collection setting/,
  );
  assert.equal(dbReads, 0);
});

test('invalid CLI due-only combinations fail before creating a database or reading source config', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'pulse-due-flags-'));
  try {
    for (const flags of [
      ['sync', '--due-only', '--rotate'],
      ['sync', '--due-only', '--from', '2026-11-01'],
      ['sync', '--due-only', '--dry-run'],
      ['report', '--due-only'],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), cli, ...flags],
        {
          cwd: dir,
          env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC' },
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.equal(result.status, 1, flags.join(' '));
      assert.match(result.stderr, /Due-only selection requires sync/);
      assert.equal(existsSync(join(dir, '.pulse')), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('portable collector sidecar defaults to rotation and selects due-only explicitly', async () => {
  if (process.platform === 'win32') return;
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const directory = mkdtempSync(join(tmpdir(), 'pulse-collector-sidecar-'));
  const script = fileURLToPath(new URL('../deploy/collect-loop.sh', import.meta.url));
  try {
    const fakeNode = join(directory, 'node');
    const fakeSleep = join(directory, 'sleep');
    writeFileSync(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PULSE_CAPTURE_FILE"\n', {
      mode: 0o700,
    });
    writeFileSync(fakeSleep, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    chmodSync(fakeNode, 0o700);
    chmodSync(fakeSleep, 0o700);
    for (const mode of ['false', 'true', 'invalid']) {
      const capture = join(directory, 'args.txt');
      rmSync(capture, { force: true });
      const result = spawnSync('/bin/sh', [script], {
        encoding: 'utf8',
        timeout: 4000,
        env: {
          PATH: directory + ':' + process.env.PATH,
          HOME: directory,
          PULSE_COLLECT_INTERVAL_SECONDS: '60',
          PULSE_COLLECT_MAX_JOBS: '1',
          PULSE_COLLECT_DUE_ONLY: mode,
          PULSE_CAPTURE_FILE: capture,
        },
      });
      assert.equal(result.status, mode === 'invalid' ? 2 : 0, result.stderr);
      if (mode === 'invalid') {
        assert.equal(existsSync(capture), false);
        assert.match(result.stderr, /Invalid collector due-time setting/);
      } else {
        const args = readFileSync(capture, 'utf8').trim().split('\n');
        assert.ok(args.includes(mode === 'true' ? '--due-only' : '--rotate'));
        assert.equal(args.includes(mode === 'true' ? '--rotate' : '--due-only'), false);
        assert.deepEqual(args.slice(0, 2), ['/app/dist/cli.js', 'sync']);
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('portable collector serializes opted-in correction cycles and preserves explicit budgets', async () => {
  if (process.platform === 'win32') return;
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const directory = mkdtempSync(join(tmpdir(), 'pulse-reconcile-sidecar-'));
  const script = fileURLToPath(new URL('../deploy/collect-loop.sh', import.meta.url));
  const capture = join(directory, 'commands.txt');
  const counter = join(directory, 'counter.txt');
  const env = {
    PATH: directory + ':' + process.env.PATH,
    HOME: directory,
    PULSE_COLLECT_INTERVAL_SECONDS: '60',
    PULSE_COLLECT_MAX_JOBS: '1',
    PULSE_COLLECT_DUE_ONLY: 'true',
    PULSE_COLLECT_READY_ONLY: 'true',
    PULSE_COLLECT_EXECUTION_PROFILE: 'free',
    PULSE_RECONCILE_INTERVAL_SECONDS: '90',
    PULSE_CAPTURE_FILE: capture,
    PULSE_COUNTER_FILE: counter,
  };
  try {
    writeFileSync(
      join(directory, 'node'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PULSE_CAPTURE_FILE"\n[ "$2" != "sync" ]\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(directory, 'sleep'),
      '#!/bin/sh\nn=$(cat "$PULSE_COUNTER_FILE")\nn=$((n + 1))\nprintf "%s" "$n" > "$PULSE_COUNTER_FILE"\n[ "$n" -lt 3 ]\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(directory, 'date'),
      '#!/bin/sh\nn=$(cat "$PULSE_COUNTER_FILE")\nprintf "%s\\n" "$((1000 + n * 60))"\n',
      { mode: 0o700 },
    );
    writeFileSync(counter, '0');
    const result = spawnSync('/bin/sh', [script], { encoding: 'utf8', timeout: 4000, env });
    assert.equal(result.status, 0, result.stderr);
    const commands = readFileSync(capture, 'utf8').trim().split('\n');
    assert.deepEqual(
      commands.map((command) => command.split(' ')[1]),
      ['sync', 'reconcile', 'sync', 'sync', 'reconcile'],
      'correction runs serialize after regular jobs and wait for their configured gap',
    );
    for (const command of commands) {
      assert.match(command, /--ready-only --execution-profile free/);
      assert.match(command, /--config \/run\/pulse\/config.json --db \/app\/.pulse\/pulse.db/);
      if (command.includes(' reconcile ')) assert.doesNotMatch(command, /--due-only|--max-jobs/);
      else assert.match(command, /--max-jobs 1 --due-only/);
    }
    assert.match(
      result.stderr,
      /collector cycle failed/,
      'source failure does not stop later cycles',
    );
    for (const invalid of [
      { PULSE_COLLECT_READY_ONLY: 'maybe' },
      { PULSE_COLLECT_EXECUTION_PROFILE: 'unbounded' },
      { PULSE_COLLECT_MAX_JOBS: '2' },
      { PULSE_RECONCILE_INTERVAL_SECONDS: '59' },
      { PULSE_RECONCILE_INTERVAL_SECONDS: '86401' },
      { PULSE_RECONCILE_INTERVAL_SECONDS: 'invalid' },
    ]) {
      rmSync(capture);
      const refused = spawnSync('/bin/sh', [script], {
        encoding: 'utf8',
        timeout: 4000,
        env: { ...env, ...invalid },
      });
      assert.equal(refused.status, 2, refused.stderr);
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(capture), false, 'invalid controls refuse before any collection');
      writeFileSync(capture, '');
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('portable collector forwards termination and reaps the active collection child', async () => {
  if (process.platform === 'win32') return;
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { once } = await import('node:events');
  const { setTimeout: delay } = await import('node:timers/promises');
  const directory = mkdtempSync(join(tmpdir(), 'pulse-collector-stop-'));
  const script = fileURLToPath(new URL('../deploy/collect-loop.sh', import.meta.url));
  const pidFile = join(directory, 'child.pid');
  const stoppedFile = join(directory, 'child.stopped');
  writeFileSync(
    join(directory, 'node'),
    [
      '#!' + process.execPath,
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => { fs.writeFileSync(process.env.PULSE_STOPPED_FILE, 'stopped'); process.exit(0); });",
      'fs.writeFileSync(process.env.PULSE_PID_FILE, String(process.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n') + '\n',
    { mode: 0o700 },
  );
  const child = spawn('/bin/sh', [script], {
    stdio: 'ignore',
    env: {
      PATH: directory + ':' + process.env.PATH,
      HOME: directory,
      PULSE_COLLECT_INTERVAL_SECONDS: '60',
      PULSE_PID_FILE: pidFile,
      PULSE_STOPPED_FILE: stoppedFile,
    },
  });
  let activePid: number | undefined;
  let confirmedStopped = false;
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt++) await delay(10);
    assert.equal(existsSync(pidFile), true, 'fixture collection reached its active state');
    activePid = Number(readFileSync(pidFile, 'utf8'));
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(4000) });
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(readFileSync(stoppedFile, 'utf8'), 'stopped');
    assert.throws(() => process.kill(activePid!, 0), { code: 'ESRCH' });
    confirmedStopped = true;
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (!confirmedStopped && activePid !== undefined) {
      try {
        process.kill(activePid, 'SIGKILL');
      } catch {
        // Expected after successful reaping; never target an unrelated process.
      }
    }
    rmSync(directory, { force: true, recursive: true });
  }
});
