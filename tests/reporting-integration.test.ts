import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { handle, type ApiContext } from '../src/api/handler.js';
import { projectReport } from '../src/report.js';
import { projectBrief } from '../src/brief.js';
import { projectGraph } from '../src/project-graph.js';
import { fixture, database, now, window } from './helpers.js';

const accessToken = 'synthetic-evidence-integration-token-012345';
test('report, brief and read-only evidence APIs share the same findings and explicit resource graph', async () => {
  const config = fixture();
  const store = await database(config);
  const fetchBefore = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('Unexpected provider request');
  };
  const context: ApiContext = {
    config,
    store,
    secrets: { TEST_TOKEN: 'synthetic-provider-secret-must-never-leak' },
    apiToken: accessToken,
    now: () => now,
    asset: async () => new Response('unused'),
  };
  const request = (path: string, auth = true, method = 'GET') =>
    new Request('https://pulse.example' + path, {
      method,
      headers: auth ? { Authorization: 'Bearer ' + accessToken } : {},
    });
  const suffix = '?from=' + window.from + '&to=' + window.to;
  try {
    const before = await store.runs();
    const report = await projectReport(config, store, 'project', window, now);
    const brief = projectBrief(report, 20, report.resources);
    assert.deepEqual(report.resources, projectGraph(config, 'project'));
    assert.deepEqual(brief.investigation, report.investigation);
    assert.ok(report.investigation!.findings.length > 0);
    assert.ok(report.investigation!.findings[0]!.nextChecks.length > 0);
    for (const view of ['graph', 'investigation']) {
      const path = '/api/v1/projects/project/' + view + (view === 'investigation' ? suffix : '');
      assert.equal((await handle(request(path, false), context)).status, 401);
      assert.equal((await handle(request(path, true, 'POST'), context)).status, 405);
      const response = await handle(request(path), context);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const data = await response.json();
      if (view === 'graph') assert.deepEqual(data, report.resources);
      else {
        assert.deepEqual(data.investigation, report.investigation);
        assert.deepEqual(data.window, window);
        assert.equal(data.project.id, 'project');
      }
      assert.doesNotMatch(
        JSON.stringify(data),
        /TEST_TOKEN|synthetic-provider-secret|synthetic-evidence-integration-token/,
      );
      const head = await handle(request(path, true, 'HEAD'), context);
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    }
    const response = await handle(request('/api/v1/projects/project/brief' + suffix), context);
    assert.deepEqual((await response.json()).investigation, report.investigation);
    assert.equal((await handle(request('/api/v1/projects/unknown/graph'), context)).status, 404);
    assert.equal(
      (await handle(request('/api/v1/projects/project/graph' + suffix), context)).status,
      400,
    );
    assert.equal(
      (await handle(request('/api/v1/projects/project/investigation?format=csv'), context)).status,
      400,
    );
    assert.deepEqual(
      await store.runs(),
      before,
      'read paths never initiate collection or update history',
    );
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = fetchBefore;
    store.driver.close?.();
  }
});

test('pulse graph is an offline configuration projection and does not create a database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulse-graph-test-'));
  const configPath = join(directory, 'config.json');
  const config = fixture();
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ['--import', tsx, cli, ...args], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, TEST_TOKEN: 'synthetic-graph-secret-not-for-output' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    const output = run('graph', 'project', '--config', configPath, '--json');
    assert.deepEqual(JSON.parse(output), projectGraph(config, 'project'));
    assert.doesNotMatch(output, /TEST_TOKEN|synthetic-graph-secret|connection/);
    await assert.rejects(access(join(directory, '.pulse')));
    assert.throws(() =>
      run('graph', 'project', '--config', configPath, '--db', join(directory, 'forbidden.db')),
    );
    await assert.rejects(access(join(directory, 'forbidden.db')));
    assert.throws(() => run('graph', 'missing', '--config', configPath));
    assert.throws(() => run('graph', 'project', 'extra', '--config', configPath));
    assert.throws(() => run('graph', 'project', '--config', configPath, '--serve'));
    assert.throws(() => run('graph', 'project', '--config', configPath, '--port', '1'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
