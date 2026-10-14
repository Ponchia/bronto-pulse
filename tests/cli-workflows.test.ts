import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.js';
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-cli-contract-'));
  writeFileSync(join(dir, 'pulse.config.json'), JSON.stringify(fixture('npm')));
  return dir;
}
function run(dir: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', loader, cli, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC' },
    timeout: 15000,
  });
}
for (const command of [
  ['validate', '--json'],
  ['plan', '--json'],
  ['sync', '--dry-run', '--json'],
  ['backfill', '--dry-run', '--from', '2026-10-01', '--to', '2026-10-03', '--json'],
])
  test(`${command.join(' ')} is offline and does not create a database`, () => {
    const dir = setup();
    try {
      const r = run(dir, command);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotThrow(() => JSON.parse(r.stdout));
      assert.equal(existsSync(join(dir, '.pulse')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
for (const args of [
  ['nonsense'],
  ['report', 'project', '--format', 'xml'],
  ['brief', '--format', 'csv'],
  ['report', 'project', '--json', '--format', 'csv'],
  ['sync', '--chunk-days', '2'],
  ['validate', '--out', 'ignored.md'],
])
  test(`invalid CLI input fails without changing history: ${args.join(' ')}`, () => {
    const dir = setup();
    try {
      const r = run(dir, args);
      assert.equal(r.status, 1);
      assert.equal(existsSync(join(dir, '.pulse')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
test('report and briefing file output is private, exclusive and machine-readable', () => {
  const dir = setup();
  try {
    const path = join(dir, 'private.csv');
    let r = run(dir, ['report', 'project', '--format', 'csv', '--out', path]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(path, 'utf8'), /^"project","resource","metric"/);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    const original = readFileSync(path, 'utf8');
    r = run(dir, ['report', 'project', '--format', 'json', '--out', path]);
    assert.equal(r.status, 1);
    assert.equal(readFileSync(path, 'utf8'), original);
    r = run(dir, ['brief', 'project', '--json', '--from', '2026-10-12', '--to', '2026-10-13']);
    assert.equal(r.status, 0, r.stderr);
    const brief = JSON.parse(r.stdout);
    assert.equal(brief.project.id, 'project');
    assert.deepEqual(brief.window, { from: '2026-10-12', to: '2026-10-13' });
    assert.ok(brief.findings.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('probe validates its source selection before opening a database or making requests', () => {
  const dir = setup();
  try {
    const r = run(dir, ['probe', '--resource', 'nonexistent', '--json']);
    assert.equal(r.status, 1);
    assert.equal(existsSync(join(dir, '.pulse')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const failSecond of [false, true])
  test(`bounded CLI backfill ${failSecond ? 'retains the first chunk when the second fails' : 'publishes independent synthetic date chunks'}`, () => {
    const dir = setup();
    try {
      const stub = join(dir, 'synthetic-provider.mjs');
      writeFileSync(
        stub,
        `
      import { appendFileSync } from 'node:fs';
      globalThis.fetch=async(input)=>{
        appendFileSync(${JSON.stringify(join(dir, 'requests.txt'))},'request\\n');
        const url=new URL(String(input));
        if(url.hostname!=='api.npmjs.org') throw new Error('Unexpected provider in synthetic CLI test');
        const dates=/range\\/(\\d{4}-\\d{2}-\\d{2}):(\\d{4}-\\d{2}-\\d{2})/.exec(url.pathname);
        if(!dates)throw new Error('Missing bounded date range');
        const [,start,end]=dates;
        if(${JSON.stringify(failSecond)}&&start==='2026-10-03')return new Response('{}',{status:403});
        const downloads=[];
        for(let date=new Date(start+'T00:00:00Z');date<=new Date(end+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+1))downloads.push({day:date.toISOString().slice(0,10),downloads:1});
        return Response.json({start,end,package:'@example/package',downloads});
      };
    `,
      );
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          stub,
          '--import',
          loader,
          cli,
          'backfill',
          '--from',
          '2026-10-01',
          '--to',
          '2026-10-04',
          '--chunk-days',
          '2',
          '--max-jobs',
          '4',
          '--json',
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 15000,
          env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC' },
        },
      );
      assert.equal(result.status, failSecond ? 2 : 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.plan.totalJobs, 2);
      assert.deepEqual(
        output.results.map((x: { status: string }) => x.status),
        failSecond ? ['success', 'failed'] : ['success', 'success'],
      );
      const report = JSON.parse(
        run(dir, ['report', 'project', '--from', '2026-10-01', '--to', '2026-10-04', '--json'])
          .stdout,
      );
      assert.equal(
        report.cards.find((x: { metric: string }) => x.metric === 'npm.downloads').value,
        failSecond ? 2 : 4,
      );
      assert.equal(readFileSync(join(dir, 'requests.txt'), 'utf8').trim().split('\n').length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
test('backfill refuses an over-budget plan before any provider call', () => {
  const dir = setup();
  try {
    const stub = join(dir, 'no-network.mjs');
    writeFileSync(stub, `globalThis.fetch=()=>{throw Error('No provider calls may run');};`);
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        stub,
        '--import',
        loader,
        cli,
        'backfill',
        '--from',
        '2026-10-01',
        '--to',
        '2026-10-04',
        '--chunk-days',
        '1',
        '--max-jobs',
        '1',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 15000,
        env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC' },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ROW_LIMIT/);
    assert.match(result.stderr, /no provider requests/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run and real sync use the same custom lookback anchored to --to', () => {
  const dir = setup();
  try {
    const config = fixture('npm');
    config.settings.lookbackDays = 3;
    writeFileSync(join(dir, 'pulse.config.json'), JSON.stringify(config));
    const preview = run(dir, ['sync', '--to', '2026-10-05', '--dry-run', '--json']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout).jobs[0].window, {
      from: '2026-10-03',
      to: '2026-10-05',
    });
    assert.equal(existsSync(join(dir, '.pulse')), false);
    const stub = join(dir, 'matching-window.mjs');
    writeFileSync(
      stub,
      `globalThis.fetch=async(input)=>{const url=String(input);if(!url.includes('/2026-10-03:2026-10-05/'))throw Error('Window did not match dry-run');return Response.json({package:'@example/package',start:'2026-10-03',end:'2026-10-05',downloads:[{day:'2026-10-03',downloads:1},{day:'2026-10-04',downloads:1},{day:'2026-10-05',downloads:1}]});};`,
    );
    const actual = spawnSync(
      process.execPath,
      ['--import', stub, '--import', loader, cli, 'sync', '--to', '2026-10-05', '--json'],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 15000,
        env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC' },
      },
    );
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(JSON.parse(actual.stdout)[0].rows, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
