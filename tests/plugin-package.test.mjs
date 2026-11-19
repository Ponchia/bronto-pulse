import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugins/bronto-pulse-review');
const launcher = join(plugin, 'scripts/start-mcp.mjs');
const readJson = async (path) => JSON.parse(await readFile(join(plugin, path), 'utf8'));

test('portable and Claude packages identify the same workflow and included launcher', async () => {
  const portable = await readJson('plugin.json');
  const claude = await readJson('.claude-plugin/plugin.json');
  for (const key of ['name', 'version', 'description', 'license']) {
    assert.equal(claude[key], portable[key]);
  }
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.ok(portable.extensions['com.openai'].interface.shortDescription.length <= 30);
  assert.deepEqual(portable.extensions['com.openai'].interface.capabilities, ['Read']);
  const mcp = await readJson('mcp.json');
  const compat = await readJson('.mcp.json');
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  for (const config of [mcp, compat]) {
    assert.deepEqual(Object.keys(config.mcpServers), ['bronto-pulse']);
    const server = config.mcpServers['bronto-pulse'];
    assert.equal(server.type, 'stdio');
    assert.equal(server.command, 'node');
    assert.equal(server.args.length, 1);
    assert.ok(server.args[0].endsWith('/scripts/start-mcp.mjs'));
    assert.equal(server.env, undefined);
  }
  const skill = await readFile(join(plugin, 'skills/pulse-project-review/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: pulse-project-review\ndescription: /);
  assert.doesNotMatch(skill, /\[TODO:/);
  const metadata = await readFile(
    join(plugin, 'skills/pulse-project-review/agents/openai.yaml'),
    'utf8',
  );
  assert.ok(metadata.includes('$pulse-project-review'));
});

test('launcher refuses missing owner paths without writing protocol output', () => {
  const result = spawnSync(process.execPath, [launcher], { env: {}, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /PULSE_CLI_PATH must be an absolute path/);
});

test('launcher preserves private paths as arguments and excludes provider credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse plugin paths '));
  try {
    const cli = join(dir, 'configured cli.mjs');
    const config = join(dir, 'private config.json');
    const db = join(dir, 'private history.db');
    await writeFile(config, '{}');
    await writeFile(db, '');
    await writeFile(
      cli,
      "process.stdout.write(JSON.stringify({args:process.argv.slice(2),hasProviderKey:'PULSE_TEST_PROVIDER_KEY' in process.env,hasNodeOptions:'NODE_OPTIONS' in process.env}));process.exitCode=23;",
    );
    const result = spawnSync(process.execPath, [launcher], {
      env: {
        PULSE_CLI_PATH: cli,
        PULSE_CONFIG_PATH: config,
        PULSE_DB_PATH: db,
        PULSE_TEST_PROVIDER_KEY: 'synthetic-do-not-forward',
        NODE_OPTIONS: '--no-warnings',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 23);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.args, ['mcp', '--config', config, '--db', db]);
    assert.equal(output.hasProviderKey, false);
    assert.equal(output.hasNodeOptions, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
