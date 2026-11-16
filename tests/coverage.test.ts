import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
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
    const db = join(dir, '.pulse');
    writeFileSync(config, JSON.stringify(base()));
    writeFileSync(inventory, JSON.stringify(input));
    const result = spawnSync(
      process.execPath,
      ['--import', loader, cli, 'coverage', '--config', config, '--input', inventory, '--json'],
      { cwd: dir, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).configured, false);
    assert.equal(existsSync(db), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage CLI bounds input bytes and rejects unsupported private output without echo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-coverage-bounds-'));
  try {
    const config = join(dir, 'config.json');
    const inventory = join(dir, 'inventory.json');
    const db = join(dir, '.pulse');
    const out = join(dir, 'never-written.json');
    writeFileSync(config, JSON.stringify(base()));
    const run = (extra: string[] = []) =>
      spawnSync(
        process.execPath,
        ['--import', loader, cli, 'coverage', '--config', config, '--input', inventory, ...extra],
        { cwd: dir, encoding: 'utf8', timeout: 10000 },
      );
    writeFileSync(inventory, JSON.stringify(input) + ' '.repeat(256 * 1024));
    const oversized = run();
    assert.equal(oversized.status, 1);
    assert.match(oversized.stderr, /byte budget/);
    assert.equal(oversized.stdout, '');
    writeFileSync(inventory, JSON.stringify(input));
    const unsupported = run(['--out', out]);
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /--out applies/);
    assert.equal(unsupported.stdout, '');
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(db), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('website coverage distinguishes Cloudflare host groups and exact Search Console property', () => {
  const config = parseConfig({
    version: 1,
    resources: [
      {
        id: 'pages',
        provider: 'cloudflare',
        accountId: 'a'.repeat(32),
        siteTag: 'b'.repeat(32),
        hostname: 'example.org',
        groups: ['totals', 'pages', 'referrers'],
      },
      {
        id: 'search',
        provider: 'gsc',
        siteUrl: 'https://example.org/',
        collectPages: true,
        collectQueries: false,
      },
    ],
    projects: [
      {
        id: 'website',
        label: 'Website',
        resources: [{ resource: 'pages' }, { resource: 'search' }],
      },
    ],
  });
  const report = auditCoverage(config, {
    version: 1,
    resources: [
      { provider: 'cloudflare', hostname: 'EXAMPLE.ORG' },
      { provider: 'gsc', siteUrl: 'https://example.org' },
      { provider: 'gsc', siteUrl: 'sc-domain:example.org', groups: ['totals'] },
    ],
  });
  assert.equal(report.configured, false);
  assert.deepEqual(
    report.resources.map((r) => r.state),
    ['partial', 'partial', 'missing'],
  );
  assert.deepEqual(report.resources[0]?.missingGroups, ['vitals', 'performance']);
  assert.deepEqual(report.resources[1]?.missingGroups, ['queries']);
  assert.deepEqual(report.resources[1]?.projectIds, ['website']);
  assert.deepEqual(report.resources[2]?.resourceIds, []);
});

test('website audits respect explicit asOf dates without inventing historical coverage', () => {
  const config = parseConfig({
    version: 1,
    resources: [
      { id: 'old', provider: 'gsc', siteUrl: 'https://old.example.org/' },
      { id: 'new', provider: 'gsc', siteUrl: 'https://new.example.org/' },
    ],
    projects: [
      {
        id: 'website',
        label: 'Website',
        resources: [
          { resource: 'old', effectiveTo: '2026-11-13' },
          { resource: 'new', effectiveFrom: '2026-11-14' },
        ],
      },
    ],
  });
  const input = {
    version: 1 as const,
    resources: [
      { provider: 'gsc' as const, siteUrl: 'https://new.example.org/', groups: ['totals'] },
      { provider: 'gsc' as const, siteUrl: 'https://old.example.org/', groups: ['totals'] },
    ],
  };
  assert.deepEqual(
    auditCoverage(config, { ...input, asOf: '2026-11-13' }).resources.map((r) => r.state),
    ['unbound', 'configured'],
  );
  assert.deepEqual(
    auditCoverage(config, { ...input, asOf: '2026-11-14' }).resources.map((r) => r.state),
    ['configured', 'unbound'],
  );
  assert.deepEqual(
    auditCoverage(config, input).resources.map((r) => r.state),
    ['configured', 'configured'],
  );
});

test('website coverage fails closed on unsafe properties, duplicate groups and untrusted fields', () => {
  const config = parseConfig(base());
  const invalid = [
    { provider: 'cloudflare', hostname: 'http://example.org' },
    { provider: 'cloudflare', hostname: 'localhost' },
    { provider: 'cloudflare', hostname: 'example..org' },
    { provider: 'gsc', siteUrl: 'sc-domain:' },
    { provider: 'gsc', siteUrl: 'sc-domain:example..org' },
    { provider: 'cloudflare', hostname: 'example.org', groups: ['pages', 'pages'] },
    { provider: 'gsc', siteUrl: 'http://example.org/' },
    { provider: 'gsc', siteUrl: 'https://user:secret@example.org/' },
    { provider: 'gsc', siteUrl: 'https://example.org/?token=secret' },
    { provider: 'gsc', siteUrl: 'https://example.org/', token: 'secret' },
    { provider: 'gsc', siteUrl: 'sc-domain:example.org', groups: ['queries', 'queries'] },
  ];
  for (const resource of invalid)
    assert.throws(() => auditCoverage(config, { version: 1, resources: [resource] }), {
      code: 'CONFIG',
    });
  assert.throws(
    () =>
      auditCoverage(config, {
        version: 1,
        resources: [
          { provider: 'cloudflare', hostname: 'example.org' },
          { provider: 'cloudflare', hostname: 'EXAMPLE.ORG' },
        ],
      }),
    { code: 'CONFIG' },
  );
  assert.throws(
    () =>
      auditCoverage(config, {
        version: 1,
        asOf: '2026-02-30',
        resources: [{ provider: 'npm', package: '@example/library' }],
      }),
    { code: 'CONFIG' },
  );
});

test('shared documentation hostname needs an exact path-bound project', () => {
  const config = parseConfig({
    version: 1,
    resources: [
      {
        id: 'docs-rum',
        provider: 'cloudflare',
        accountId: 'a'.repeat(32),
        siteTag: 'b'.repeat(32),
        hostname: 'ponchia.github.io',
        groups: ['pages', 'referrers'],
      },
    ],
    projects: [
      {
        id: 'bronto-ui',
        label: 'Bronto UI',
        resources: [
          {
            resource: 'docs-rum',
            scope: {
              hostname: 'ponchia.github.io',
              pathPrefix: '/bronto-ui/',
            },
          },
        ],
      },
      {
        id: 'bronto-annotations',
        label: 'Bronto Annotations',
        resources: [
          {
            resource: 'docs-rum',
            scope: {
              hostname: 'ponchia.github.io',
              pathPrefix: '/bronto-annotations/',
            },
          },
        ],
      },
    ],
  });
  const report = auditCoverage(config, {
    version: 1,
    resources: [
      {
        provider: 'cloudflare',
        hostname: 'ponchia.github.io',
        projectId: 'bronto-ui',
        pathPrefix: '/bronto-ui',
        groups: ['pages', 'referrers'],
      },
      {
        provider: 'cloudflare',
        hostname: 'ponchia.github.io',
        projectId: 'bronto-annotations',
        pathPrefix: '/bronto-annotations/',
        groups: ['pages'],
      },
      {
        provider: 'cloudflare',
        hostname: 'ponchia.github.io',
        projectId: 'bronto-visual-models',
        pathPrefix: '/bronto-visual-models/',
        groups: ['pages'],
      },
    ],
  });
  assert.deepEqual(
    report.resources.map((r) => r.state),
    ['configured', 'configured', 'unbound'],
  );
  assert.deepEqual(report.resources[0]?.projectIds, ['bronto-ui']);
  assert.equal(report.resources[0]?.pathPrefix, '/bronto-ui');
  assert.deepEqual(report.resources[2]?.projectIds, []);
  assert.throws(
    () =>
      auditCoverage(config, {
        version: 1,
        resources: [
          {
            provider: 'cloudflare',
            hostname: 'ponchia.github.io',
            pathPrefix: '/bronto-ui/',
          },
        ],
      }),
    { code: 'CONFIG' },
  );
});
