import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.js';
import { validateCliInput } from '../src/cli-options.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
for (const args of [
  ['report', 'project', '--provider', 'npm'],
  ['brief', 'project', 'ignored-project'],
  ['compact', '--resource', 'source'],
  ['export', '--resource', 'source', '--out', 'partial.json'],
  ['validate', '--db', 'ignored.db'],
  ['plan', '--rotate'],
  ['report'],
  ['import'],
  ['annotate', '--resource', 'source'],
  ['report', 'project', '--days', '0x10'],
  ['report', 'project', '--days', '2', '--days', '3'],
]) {
  test(`CLI rejects ineffective or incomplete input before database access: ${args.join(' ')}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-input-contract-'));
    try {
      writeFileSync(join(dir, 'pulse.config.json'), JSON.stringify(fixture('npm')));
      const result = spawnSync(process.execPath, ['--import', loader, cli, ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC' },
        timeout: 15000,
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /CONFIG:/);
      assert.equal(existsSync(join(dir, '.pulse')), false, 'invalid input must not open a DB');
      assert.equal(existsSync(join(dir, 'partial.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('malformed archive input is bounded and rejected before destination creation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-invalid-import-'));
  try {
    writeFileSync(join(dir, 'private.json'), '{"sensitive-content": malformed}');
    const result = spawnSync(
      process.execPath,
      ['--import', loader, cli, 'import', '--db', 'new/pulse.db', '--input', 'private.json'],
      { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir }, timeout: 15000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CONFIG:/);
    assert.doesNotMatch(result.stderr, /sensitive-content/);
    assert.equal(existsSync(join(dir, 'new')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('documented command shapes retain their effective options', () => {
  const examples: [string, string[], Record<string, string | boolean>][] = [
    ['init', [], { config: 'private.json' }],
    ['validate', [], { config: 'private.json', json: true }],
    ['coverage', [], { config: 'private.json', input: 'inventory.json', json: true }],
    ['connectors', [], { json: true }],
    ['graph', ['project'], { config: 'private.json', json: true }],
    ['plan', [], { resource: 'source', from: '2026-10-12', to: '2026-10-13', json: true }],
    ['sync', [], { db: 'private.db', 'due-only': true, 'max-jobs': '1' }],
    ['backfill', [], { from: '2026-10-12', to: '2026-10-13', 'dry-run': true }],
    ['probe', [], { resource: 'source', group: 'traffic', json: true }],
    ['inspect', [], { resource: 'source', input: 'urls.json', out: 'inspections.json' }],
    ['doctor', [], { db: 'private.db', json: true }],
    ['report', ['project'], { days: '7', to: '2026-10-13', format: 'csv', out: 'private.csv' }],
    ['brief', [], { json: true }],
    ['compare', ['one', 'two'], { days: '30', json: true }],
    ['portfolio', [], { json: true }],
    ['export', [], { out: 'private.json' }],
    ['import', [], { db: 'restored.db', input: 'private.json' }],
    ['annotate', [], { resource: 'source', title: 'Context' }],
    ['compact', [], { db: 'private.db' }],
    ['serve', [], { port: '4177', host: '127.0.0.1' }],
    ['demo', [], { serve: true, scenario: 'evidence' }],
    ['visibility', ['template'], { suite: 'suite.json', session: 'session.json', json: true }],
    ['visibility', ['report'], { suite: 'suite.json', input: 'report.json' }],
    ['visibility', ['promptfoo'], { suite: 'suite.json', out: 'private.json' }],
  ];
  for (const [command, args, values] of examples)
    assert.doesNotThrow(
      () => validateCliInput(command, args, values, Object.keys(values)),
      command,
    );
});
