import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseConfig } from '../src/config.js';
import { auditCoverage } from '../src/coverage.js';

const input = {
  version: 1,
  resources: [
    { provider: 'github', repository: 'Example/Library' },
    { provider: 'npm', package: '@example/library' },
  ],
};
const base = () => ({
  version: 1,
  resources: [
    {
      id: 'repo',
      provider: 'github',
      repository: 'example/library',
      groups: ['repository', 'releases'],
    },
  ],
  projects: [{ id: 'library', label: 'Library', resources: [{ resource: 'repo' }] }],
});

test('coverage distinguishes configured metadata from missing traffic and npm', () => {
  const config = parseConfig(base());
  const before = JSON.stringify(config);
  const report = auditCoverage(config, input);
  assert.equal(report.configured, false);
  assert.equal(report.resources[0]!.state, 'partial');
  assert.deepEqual(report.resources[0]!.missingGroups, ['views', 'clones', 'referrers', 'paths']);
  assert.equal(report.resources[1]!.state, 'missing');
  assert.equal(JSON.stringify(config), before);
  assert.match(report.limitation, /does not prove provider access/);
});

test('explicitly limited inventory can be configured without inventing traffic access', () => {
  const report = auditCoverage(parseConfig(base()), {
    version: 1,
    resources: [{ provider: 'github', repository: 'EXAMPLE/library', groups: ['repository'] }],
  });
  assert.equal(report.configured, true);
  assert.deepEqual(report.resources[0]!.projectIds, ['library']);
});

test('disabled resources are not configured coverage', () => {
  const b = base();
  const config = parseConfig({ ...b, resources: [{ ...b.resources[0], enabled: false }] });
  assert.equal(auditCoverage(config, input).resources[0]!.state, 'disabled');
});

test('an unbound resource does not supply a project report', () => {
  const b = base();
  const config = parseConfig({
    ...b,
    resources: [...b.resources, { id: 'npm', provider: 'npm', package: '@example/library' }],
  });
  assert.equal(auditCoverage(config, input).resources[1]!.state, 'unbound');
});

test('bound enabled npm resource satisfies only its exact package identity', () => {
  const b = base();
  const config = parseConfig({
    ...b,
    resources: [...b.resources, { id: 'npm', provider: 'npm', package: '@example/library' }],
    projects: [{ ...b.projects[0], resources: [{ resource: 'repo' }, { resource: 'npm' }] }],
  });
  const report = auditCoverage(config, input);
  assert.equal(report.resources[1]!.state, 'configured');
  assert.deepEqual(report.resources[1]!.missingGroups, []);
});

test('invalid, duplicate, unsupported and oversized inventories fail closed', () => {
  const config = parseConfig(base());
  for (const invalid of [
    null,
    {},
    { version: 1, resources: [] },
    { version: 2, resources: input.resources },
    { ...input, token: 'not-accepted' },
    { version: 1, resources: [{ provider: 'github', repository: 'https://example.test/x' }] },
    {
      version: 1,
      resources: [
        { provider: 'github', repository: 'Example/Library', groups: ['views', 'views'] },
      ],
    },
    {
      version: 1,
      resources: [input.resources[0], { provider: 'github', repository: 'example/library' }],
    },
    {
      version: 1,
      resources: Array.from({ length: 501 }, (_, i) => ({ provider: 'npm', package: `p${i}` })),
    },
  ]) {
    assert.throws(() => auditCoverage(config, invalid), { code: 'CONFIG' });
  }
});

test('coverage CLI reports gaps with exit 2 and never opens its database path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-coverage-'));
  try {
    const config = join(dir, 'config.json');
    const inventory = join(dir, 'inventory.json');
    const db = join(dir, 'never-created.db');
    writeFileSync(config, JSON.stringify(base()));
    writeFileSync(inventory, JSON.stringify(input));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'coverage',
        '--config',
        config,
        '--input',
        inventory,
        '--db',
        db,
        '--json',
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).configured, false);
    assert.equal(existsSync(db), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
