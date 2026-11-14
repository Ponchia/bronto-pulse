import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { handle, type ApiContext } from '../src/api/handler.js';
import { projectReport, markdownReport } from '../src/report.js';
import { parseConfig } from '../src/config.js';
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

test('bounded investigation API exposes more than the default 20 leads without accepting unbounded limits', async () => {
  const resources = Array.from({ length: 25 }, (_, i) => ({
    id: 'package_' + i,
    provider: 'npm',
    package: 'example-package-' + i,
  }));
  const config = parseConfig({
    version: 1,
    resources,
    projects: [
      { id: 'many', label: 'Many sources', resources: resources.map((r) => ({ resource: r.id })) },
    ],
  });
  const store = await database(config);
  const context: ApiContext = {
    config,
    store,
    secrets: {},
    apiToken: accessToken,
    now: () => now,
    asset: async () => new Response('unused'),
  };
  const request = (limit: string) =>
    new Request(
      'https://pulse.example/api/v1/projects/many/investigation?from=' +
        window.from +
        '&to=' +
        window.to +
        limit,
      { headers: { Authorization: 'Bearer ' + accessToken } },
    );
  try {
    const initial = await (await handle(request(''), context)).json();
    assert.equal(initial.investigation.findings.length, 20);
    assert.equal(initial.investigation.omittedFindings, 5);
    const expanded = await (await handle(request('&limit=100'), context)).json();
    assert.equal(expanded.investigation.findings.length, 25);
    assert.equal(expanded.investigation.omittedFindings, 0);
    const one = await (await handle(request('&limit=1'), context)).json();
    assert.equal(one.investigation.findings.length, 1);
    assert.equal(one.investigation.omittedFindings, 24);
    for (const invalid of ['', '0', '-1', '101', '1.5', '1e2', 'Infinity', '1&limit=2'])
      assert.equal((await handle(request('&limit=' + invalid), context)).status, 400, invalid);
  } finally {
    store.driver.close?.();
  }
});

test('Markdown reports retain per-lead interpretation limits and structured next checks', async () => {
  const config = fixture();
  const store = await database(config);
  try {
    const report = await projectReport(config, store, 'project', window, now);
    const finding = report.investigation!.findings[0]!;
    report.investigation!.findings = [
      {
        ...finding,
        limitations: [
          'A difference does not estimate missing traffic.',
          '<ScRiPt >unsafe()</ScRiPt><img src=x onerror=unsafe()>',
        ],
      },
      {
        ...finding,
        id: finding.id + ':second',
        limitations: ['A difference does not estimate missing traffic.'],
      },
    ];
    const markdown = markdownReport(report);
    assert.match(markdown, /\n  - Next check: /);
    assert.match(markdown, /\n  - Evidence: /);
    assert.match(markdown, /\n  - Limit: A difference does not estimate missing traffic\./);
    assert.equal(markdown.split('A difference does not estimate missing traffic.').length - 1, 1);
    // No raw HTML delimiter may survive, regardless of tag name, case or attributes.
    assert.doesNotMatch(markdown, /[<>]/);
    assert.doesNotMatch(markdown, /\n  Next check: /);
  } finally {
    store.driver.close?.();
  }
});
