import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.js';
import { probe } from '../src/sync.js';
import { days } from '../src/time.js';

const now = new Date('2026-11-14T02:00:00.000Z');
const window = { from: '2026-11-10', to: '2026-11-11' };
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');

function npmResult(input: RequestInfo | URL): Response {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://api.npmjs.org');
  const match = /\/range\/(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\//.exec(url.pathname);
  assert.ok(match, 'Expected the bounded npm range endpoint');
  const [, start, end] = match;
  return Response.json({
    package: '@example/package',
    start,
    end,
    downloads: days({ from: start!, to: end! }).map((day) => ({ day, downloads: 1 })),
  });
}

test('probe honors an explicit short window and reports the actual provider range', async () => {
  const calls: string[] = [];
  const result = await probe(
    fixture('npm'),
    {},
    {
      now,
      window,
      maxJobs: 1,
      fetcher: async (input) => {
        calls.push(String(input));
        return npmResult(input);
      },
    },
  );
  assert.equal(result.readOnly, true);
  assert.equal(result.results[0]!.status, 'available');
  assert.equal(result.results[0]!.rows, 2);
  assert.deepEqual(result.results[0]!.requestedWindow, window);
  assert.deepEqual(result.results[0]!.testedWindow, window);
  assert.equal(result.results[0]!.sourceTimezone, 'UTC');
  assert.match(calls[0]!, /2026-11-10:2026-11-11/);
});

test('probe rejects invalid and over-budget explicit windows before any request', async () => {
  let calls = 0;
  for (const bad of [
    { from: '2026-11-01', to: '2026-11-08' },
    { from: '2026-11-11', to: '2026-11-10' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: 'bad', to: '2026-11-11' },
  ]) {
    await assert.rejects(
      probe(
        fixture('npm'),
        {},
        {
          now,
          window: bad,
          fetcher: async () => {
            calls++;
            throw Error('Invalid probe must not request a source');
          },
        },
      ),
      (error: unknown) => (error as { code?: string }).code === 'CONFIG',
    );
  }
  assert.equal(calls, 0);
});

test('a seven-day probe is accepted while an invalid clock is rejected before requests', async () => {
  const range = { from: '2026-11-01', to: '2026-11-07' };
  const result = await probe(
    fixture('npm'),
    {},
    { now, window: range, fetcher: async (input) => npmResult(input) },
  );
  assert.equal(result.results[0]!.rows, 7);
  assert.deepEqual(result.results[0]!.testedWindow, range);
  let calls = 0;
  await assert.rejects(
    probe(
      fixture('npm'),
      {},
      {
        now: new Date(NaN),
        window,
        fetcher: async () => {
          calls++;
          return Response.json({});
        },
      },
    ),
    /clock/,
  );
  assert.equal(calls, 0);
});

test('default probe windows keep each source calendar at the last completed day', async () => {
  const gsc = await probe(
    fixture('gsc', { collectPages: false }),
    { TEST_TOKEN: 'synthetic' },
    {
      now,
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.startDate, '2026-11-12');
        assert.equal(body.endDate, '2026-11-12');
        return Response.json({ responseAggregationType: 'byProperty' });
      },
    },
  );
  assert.deepEqual(gsc.results[0]!.testedWindow, { from: '2026-11-12', to: '2026-11-12' });
  assert.equal(gsc.results[0]!.sourceTimezone, 'America/Los_Angeles');
  const plausible = await probe(
    fixture('plausible', {
      siteId: 'example.invalid',
      timezone: 'Europe/Madrid',
      connection: 'auth',
    }),
    { TEST_TOKEN: 'synthetic' },
    {
      now,
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.date_range, ['2026-11-13', '2026-11-13']);
        return Response.json({ results: [] });
      },
    },
  );
  assert.equal(
    plausible.results[0]!.rows,
    0,
    'Empty access test is not a zero traffic observation',
  );
  assert.deepEqual(plausible.results[0]!.testedWindow, { from: '2026-11-13', to: '2026-11-13' });
  assert.equal(plausible.results[0]!.sourceTimezone, 'Europe/Madrid');
});

test('failed probes retain the attempted window without claiming validated provider coverage', async () => {
  const result = await probe(
    fixture('npm'),
    {},
    { now, window, fetcher: async () => new Response('{}', { status: 403 }) },
  );
  assert.equal(result.results[0]!.status, 'unavailable');
  assert.deepEqual(result.results[0]!.requestedWindow, window);
  assert.equal(result.results[0]!.testedWindow, null);
  assert.equal(result.results[0]!.sourceTimezone, 'UTC');
});

test('snapshot and rolling probes show native windows rather than pretending to fetch historical totals', async () => {
  const config = fixture('github', { groups: ['repository', 'referrers'] });
  const result = await probe(
    config,
    { TEST_TOKEN: 'synthetic' },
    {
      now,
      window,
      fetcher: async (input) =>
        String(input).endsWith('/referrers')
          ? Response.json([])
          : Response.json({ id: 1, stargazers_count: 2, forks_count: 0, open_issues_count: 0 }),
    },
  );
  assert.deepEqual(
    result.results.map((entry) => entry.requestedWindow),
    [window, window],
  );
  assert.deepEqual(
    result.results.map((entry) => entry.testedWindow),
    [
      { from: '2026-11-14', to: '2026-11-14' },
      { from: '2026-11-01', to: '2026-11-14' },
    ],
  );
});

test('GitHub traffic probes reveal retention-clipped provider windows', async () => {
  const requested = { from: '2026-10-31', to: '2026-11-06' };
  const result = await probe(
    fixture('github', { groups: ['views'] }),
    { TEST_TOKEN: 'synthetic' },
    {
      now,
      window: requested,
      fetcher: async () =>
        Response.json({
          count: 2,
          uniques: 1,
          views: [{ timestamp: '2026-11-01T00:00:00Z', count: 2, uniques: 1 }],
        }),
    },
  );
  assert.deepEqual(result.results[0]!.requestedWindow, requested);
  assert.deepEqual(result.results[0]!.testedWindow, { from: '2026-11-01', to: '2026-11-06' });
});

test('CLI forwards explicit probe dates without creating a database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-probe-range-'));
  try {
    writeFileSync(join(dir, 'pulse.config.json'), JSON.stringify(fixture('npm')));
    const recorder = join(dir, 'requests.jsonl');
    const stub = join(dir, 'provider.mjs');
    writeFileSync(
      stub,
      `
      import {appendFileSync} from 'node:fs';
      globalThis.fetch=async(input)=>{
        const url=new URL(String(input));
        if(url.origin!=='https://api.npmjs.org') throw Error('Unexpected source');
        appendFileSync(${JSON.stringify(recorder)},JSON.stringify({url:String(input)})+'\\n');
        const match=/range\\/(\\d{4}-\\d{2}-\\d{2}):(\\d{4}-\\d{2}-\\d{2})/.exec(url.pathname);
        if(!match)throw Error('No date range');
        const [,start,end]=match;
        return Response.json({package:'@example/package',start,end,downloads:[]});
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
        'probe',
        '--resource',
        'source',
        '--group',
        'downloads',
        '--from',
        window.from,
        '--to',
        window.to,
        '--max-jobs',
        '1',
        '--json',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 15000,
        env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC' },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.deepEqual(data.results[0].testedWindow, window);
    assert.match(readFileSync(recorder, 'utf8'), /2026-11-10:2026-11-11/);
    assert.equal(existsSync(join(dir, '.pulse')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects ambiguous or over-budget probe dates before config or network access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-probe-invalid-'));
  try {
    const marker = join(dir, 'network-used');
    const stub = join(dir, 'deny-network.mjs');
    writeFileSync(
      stub,
      `import {writeFileSync} from 'node:fs'; globalThis.fetch=async()=>{writeFileSync(${JSON.stringify(marker)},'unexpected'); throw Error('No requests allowed');};`,
    );
    for (const args of [
      ['--from', window.from],
      ['--to', window.to],
      ['--days', '2'],
      ['--rotate'],
      ['--from', '2026-11-01', '--to', '2026-11-08'],
      ['--from', '2026-11-11', '--to', '2026-11-10'],
      ['--from', '2026-02-30', '--to', '2026-03-01'],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['--import', stub, '--import', loader, cli, 'probe', ...args],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 15000,
          env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC' },
        },
      );
      assert.equal(result.status, 1, args.join(' '));
      assert.doesNotMatch(
        result.stderr,
        /Cannot read configuration/,
        'Dates must be rejected before config loading',
      );
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(join(dir, '.pulse')), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
