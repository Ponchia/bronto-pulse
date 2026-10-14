import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../scripts/publication-check.mjs', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pulse-publication-'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/publication-check.mjs'), readFileSync(source));
  writeFileSync(join(root, '.env.example'), '# Empty credential examples\nGITHUB_TOKEN=\n');
  writeFileSync(
    join(root, 'wrangler.jsonc'),
    JSON.stringify({
      workers_dev: false,
      preview_urls: false,
      triggers: { crons: [] },
      d1_databases: [{ database_id: '00000000-0000-4000-8000-000000000000' }],
    }),
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({
      packages: { example: { resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz' } },
    }),
  );
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  return root;
}
function check(root: string) {
  return spawnSync(process.execPath, ['scripts/publication-check.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
  });
}
test('a credential-free public checkout passes publication boundaries', () => {
  const root = fixture();
  try {
    const result = check(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
for (const path of [
  '.pulse/pilot.db',
  '.env',
  'reports/history.json',
  'pulse.config.json',
  'wrangler.private.jsonc',
  'private.bundle',
]) {
  test(`publication refuses tracked private/runtime material: ${path}`, () => {
    const root = fixture();
    try {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), 'synthetic-fixture');
      execFileSync('git', ['add', path], { cwd: root });
      const result = check(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not be tracked/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test('publication refuses populated credential examples', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.env.example'), 'GITHUB_TOKEN=synthetic-not-a-secret\n');
    assert.match(check(root).stderr, /empty named variables/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
for (const change of [
  { workers_dev: true },
  { preview_urls: true },
  { triggers: { crons: ['17 * * * *'] } },
]) {
  test(`publication keeps deployment activation explicit: ${JSON.stringify(change)}`, () => {
    const root = fixture();
    try {
      const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
      writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ ...config, ...change }));
      assert.match(check(root).stderr, /must not enable public routes or recurring collection/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test('publication rejects a private package registry URL', () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        packages: { example: { resolved: 'https://registry.example.invalid/example.tgz' } },
      }),
    );
    assert.match(check(root).stderr, /non-public npm registry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
