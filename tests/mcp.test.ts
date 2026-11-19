import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createPulseMcpServer, MCP_RESULT_BYTES } from '../src/mcp/server.js';
import { handlePulseMcp } from '../src/mcp/http.js';
import { reportRevision } from '../src/mcp/domain.js';
import { projectReport } from '../src/report.js';
import { recordReview } from '../src/journal.js';
import { Store } from '../src/storage/store.js';
import { database, fixture, now, publish, sample, window } from './helpers.js';

async function connected(source: Parameters<typeof createPulseMcpServer>[0]) {
  const server = createPulseMcpServer(source, { version: 'test' });
  const client = new Client({ name: 'pulse-tests', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
function payload(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}
const expectedTools = [
  'get_collection_health',
  'get_portfolio_review',
  'get_project_brief',
  'get_project_evidence',
  'get_project_map',
  'get_review_history',
  'list_projects',
];

test('MCP discovery is lazy, bounded and exposes only read tools', async () => {
  let loads = 0;
  const connection = await connected(async () => {
    loads++;
    throw new Error('private configuration must not load during discovery');
  });
  try {
    const result = await connection.client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), expectedTools);
    assert.equal(loads, 0);
    for (const tool of result.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    for (const args of [
      { projectId: 'project', unknown: true },
      { projectId: 'project', days: 367 },
      { projectId: 'project', from: '2026-02-30' },
      { projectId: 'project', from: window.from, days: 2 },
      { projectId: 'project', includePoints: true },
      { projectId: 'project', reviewId: 'review-01', days: 2 },
      { projectId: 'project', pointOffset: 1 },
    ]) {
      const invalid = await connection.client.callTool({
        name: 'get_project_evidence',
        arguments: args,
      });
      assert.equal(invalid.isError, true);
    }
    assert.equal(loads, 0, 'schema validation precedes context loading');
  } finally {
    await connection.close();
  }
});

test('MCP brief and evidence preserve exact source data, pagination and revision checks without writes', async () => {
  const config = fixture('github', { groups: ['views'] });
  const store = await database(config);
  await publish(store, config, [sample(window.from, 8), sample(window.to, 10)]);
  let writes = 0;
  const readonlyStore = new Store({
    all: store.driver.all.bind(store.driver),
    readBatch: store.driver.readBatch.bind(store.driver),
    async batch() {
      writes++;
      throw new Error('MCP attempted a write');
    },
  });
  const connection = await connected({
    config,
    store: readonlyStore,
    now,
    secrets: { TEST_TOKEN: 'never-print-this-token' },
  });
  try {
    const catalog = payload(
      await connection.client.callTool({ name: 'list_projects', arguments: {} }),
    );
    assert.equal(catalog.projects.items[0].id, 'project');
    const brief = payload(
      await connection.client.callTool({
        name: 'get_project_brief',
        arguments: { projectId: 'project', ...window, limit: 10 },
      }),
    );
    assert.match(brief.evidenceRevision, /^[a-f0-9]{64}$/);
    const evidence = payload(
      await connection.client.callTool({
        name: 'get_project_evidence',
        arguments: { ...brief.evidenceRef.arguments, metric: 'github.views' },
      }),
    );
    assert.equal(evidence.evidence.items[0].value, 18);
    assert.equal(evidence.evidence.items[0].coverage.status, 'complete');
    assert.equal(evidence.evidence.items[0].timezone, 'UTC');
    assert.equal(evidence.evidence.items[0].pointsIncluded, false);
    const seriesKey = evidence.evidence.items[0].key;
    const points = payload(
      await connection.client.callTool({
        name: 'get_project_evidence',
        arguments: {
          projectId: 'project',
          ...window,
          seriesKey,
          includePoints: true,
          pointLimit: 1,
        },
      }),
    );
    assert.equal(points.evidence.items[0].points.items.length, 1);
    assert.equal(points.evidence.items[0].points.total, 2);
    assert.equal(points.evidence.items[0].points.nextOffset, 1);
    assert.deepEqual(points.evidence.items[0].points.items[0], {
      date: window.from,
      value: 8,
      quality: 'observed',
      from: window.from,
      to: window.from,
    });
    const missing = payload(
      await connection.client.callTool({
        name: 'get_project_evidence',
        arguments: { projectId: 'project', ...window, metric: 'github.unique_viewers' },
      }),
    );
    assert.equal(missing.evidence.items[0].value, null);
    assert.equal(missing.evidence.items[0].coverage.status, 'unavailable');
    const health = payload(
      await connection.client.callTool({
        name: 'get_collection_health',
        arguments: { projectId: 'project' },
      }),
    );
    assert.equal(health.health.items[0].lastRun.status, 'success');
    assert.equal(health.health.items[0].credentials.available, true);
    const map = payload(
      await connection.client.callTool({
        name: 'get_project_map',
        arguments: { projectId: 'project' },
      }),
    );
    assert.equal(map.map.resources[0].identity.value, 'example/project');
    const text = JSON.stringify({ catalog, brief, evidence, points, missing, health, map });
    assert.doesNotMatch(text, /never-print-this-token|TEST_TOKEN/);
    const report = await projectReport(config, store, 'project', window, now);
    assert.equal(
      await reportRevision({ ...report, generatedAt: '2030-01-01T00:00:00.000Z' }),
      brief.evidenceRevision,
    );
    await publish(store, config, [sample(window.from, 99), sample(window.to, 10)]);
    const stale = await connection.client.callTool({
      name: 'get_project_evidence',
      arguments: { projectId: 'project', ...window, expectedRevision: brief.evidenceRevision },
    });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale), /EVIDENCE_CHANGED/);
    assert.equal(writes, 0);
  } finally {
    await connection.close();
    store.driver.close?.();
  }
});

test('MCP review history resolves frozen evidence after later collection', async () => {
  const config = fixture('github', { groups: ['views'] });
  const store = await database(config);
  await publish(store, config, [sample(window.from, 8), sample(window.to, 10)]);
  const record = await recordReview(
    config,
    store,
    {
      id: 'review-test-001',
      projectId: 'project',
      window,
      question: 'Did the recorded views change?',
      conclusion: 'The aggregate alone does not establish human adoption.',
    },
    now,
  );
  await publish(store, config, [sample(window.from, 90), sample(window.to, 10)]);
  const connection = await connected({ config, store, now });
  try {
    const history = payload(
      await connection.client.callTool({
        name: 'get_review_history',
        arguments: { projectId: 'project', limit: 1 },
      }),
    );
    assert.equal(history.records.length, 1);
    assert.equal(history.records[0].evidence.sha256, record.evidence.sha256);
    assert.equal(history.records[0].evidence.report, undefined);
    const frozen = payload(
      await connection.client.callTool({
        name: 'get_project_evidence',
        arguments: {
          projectId: 'project',
          reviewId: record.id,
          expectedRevision: record.evidence.sha256,
          metric: 'github.views',
        },
      }),
    );
    assert.equal(frozen.snapshotKind, 'saved_review');
    assert.equal(frozen.evidence.items[0].value, 18);
    const current = payload(
      await connection.client.callTool({
        name: 'get_project_evidence',
        arguments: { projectId: 'project', ...window, metric: 'github.views' },
      }),
    );
    assert.equal(current.evidence.items[0].value, 100);
  } finally {
    await connection.close();
    store.driver.close?.();
  }
});

test('MCP failures redact internal errors and refuse oversized results', async () => {
  const broken = await connected(async () => {
    throw new Error('SQL SELECT token=private-secret');
  });
  try {
    const failure = await broken.client.callTool({ name: 'list_projects', arguments: {} });
    assert.equal(failure.isError, true);
    assert.doesNotMatch(JSON.stringify(failure), /SQL|SELECT|private-secret/);
  } finally {
    await broken.close();
  }
  const config = fixture();
  const store = await database(config);
  // The response bound is defensive even when a caller supplies an unparsed context.
  config.projects[0]!.description = 'x'.repeat(MCP_RESULT_BYTES);
  const large = await connected({ config, store, now });
  try {
    const response = await large.client.callTool({ name: 'list_projects', arguments: {} });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response), /RESULT_TOO_LARGE/);
    assert.ok(new TextEncoder().encode(JSON.stringify(response)).byteLength < MCP_RESULT_BYTES);
  } finally {
    await large.close();
    store.driver.close?.();
  }
});

test('MCP HTTP rejects malformed boundaries before loading private state', async () => {
  let loads = 0;
  const source = async () => {
    loads++;
    throw new Error('must not load');
  };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  for (const [request, status] of [
    [new Request('https://pulse.invalid/mcp'), 405],
    [new Request('https://pulse.invalid/mcp', { method: 'POST', body: '{}' }), 415],
    [
      new Request('https://pulse.invalid/mcp', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.invalid' },
        body: '{}',
      }),
      403,
    ],
    [
      new Request('https://pulse.invalid/mcp', {
        method: 'POST',
        headers: { ...headers, Origin: 'null' },
        body: '{}',
      }),
      403,
    ],
    [
      new Request('https://pulse.invalid/mcp', {
        method: 'POST',
        headers,
        body: 'x'.repeat(32769),
      }),
      413,
    ],
  ] as const) {
    const response = await handlePulseMcp(request, source);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  const malformed = await handlePulseMcp(
    new Request('https://pulse.invalid/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: {}, version: 4 },
        },
      }),
    }),
    source,
  );
  assert.ok(malformed.status >= 400 || (await malformed.text()).includes('error'));
  assert.equal(loads, 0);
});

for (const mode of ['legacy', 'auto'] as const) {
  test('SDK HTTP discovery and harmless call work in ' + mode + ' negotiation', async () => {
    const config = fixture('github', { groups: ['views'] });
    const store = await database(config);
    const source = { config, store, now };
    const client = new Client(
      { name: 'pulse-http-tests', version: '1.0.0' },
      { versionNegotiation: { mode } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('https://pulse.invalid/mcp'), {
      fetch: async (input, init) => handlePulseMcp(new Request(input, init), source),
    });
    try {
      await client.connect(transport);
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
        expectedTools,
      );
      const result = payload(await client.callTool({ name: 'list_projects', arguments: {} }));
      assert.equal(result.projects.items[0].id, 'project');
      assert.equal(result.readOnly, true);
    } finally {
      await client.close();
      store.driver.close?.();
    }
  });
}

test('stdio CLI supports real SDK discovery/read and exits on input EOF without changing its database', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const { SqliteDriver } = await import('../src/storage/sqlite.js');
  const directory = await mkdtemp(join(tmpdir(), 'pulse-mcp-'));
  const configPath = join(directory, 'config.json'),
    dbPath = join(directory, 'pulse.db');
  const config = fixture('github', { groups: ['views'] });
  const store = new Store(new SqliteDriver(dbPath));
  try {
    await store.migrate();
    await store.register(config, now);
    await publish(store, config, [sample(window.from, 8), sample(window.to, 10)]);
  } finally {
    store.driver.close?.();
  }
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const before = await readFile(dbPath);
  const args = ['--import', 'tsx', 'src/cli.ts', 'mcp', '--config', configPath, '--db', dbPath];
  const client = new Client({ name: 'pulse-stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      expectedTools,
    );
    const result = payload(await client.callTool({ name: 'list_projects', arguments: {} }));
    assert.equal(result.projects.items[0].id, 'project');
    await client.close();
    assert.deepEqual(await readFile(dbPath), before);
    assert.doesNotMatch(stderr, /TEST_TOKEN|private-test-token|SQL SELECT/);
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('stdio did not exit after EOF'));
      }, 5000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.equal(stdout, '', 'EOF before initialization must not print non-protocol output');
    assert.deepEqual(await readFile(dbPath), before);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Worker MCP reads persisted D1 config without migration or registration despite invalid deployment config', async () => {
  const { default: worker } = await import('../src/worker.js');
  const config = fixture('github', { groups: ['views'] });
  const backing = await database(config);
  const originalMigrate = Store.prototype.migrate;
  const originalRegister = Store.prototype.register;
  let migrations = 0,
    registrations = 0,
    writes = 0,
    reads = 0;
  Store.prototype.migrate = async () => {
    migrations++;
    throw new Error('MCP must not migrate');
  };
  Store.prototype.register = async () => {
    registrations++;
    throw new Error('MCP must not register');
  };
  const DB = {
    prepare(sql: string) {
      if (!/^SELECT\s/i.test(sql)) {
        writes++;
        throw new Error('MCP attempted D1 write');
      }
      return {
        bind(...params: (string | number | null)[]) {
          return {
            async all<T>() {
              reads++;
              return { results: (await backing.driver.all({ sql, params })) as unknown as T[] };
            },
          };
        },
      };
    },
    async batch() {
      writes++;
      throw new Error('MCP attempted D1 batch');
    },
  };
  const token = 'synthetic-mcp-worker-owner-token-long-enough';
  try {
    for (const PULSE_CONFIG of [
      '{ deliberately invalid private deployment config',
      JSON.stringify({
        ...config,
        projects: [{ ...config.projects[0], label: 'Stale deployment label' }],
      }),
    ]) {
      const env = {
        DB,
        PULSE_CONFIG,
        PULSE_API_TOKEN: token,
        ASSETS: {
          async fetch() {
            throw new Error('MCP must not load assets');
          },
        },
      };
      const client = new Client({ name: 'worker-mcp-read-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL('https://pulse.invalid/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + token } },
        fetch: async (input, init) => worker.fetch(new Request(input, init), env),
      });
      try {
        await client.connect(transport);
        assert.equal((await client.listTools()).tools.length, 7);
        const response = payload(await client.callTool({ name: 'list_projects', arguments: {} }));
        assert.equal(response.projects.items[0].label, config.projects[0]!.label);
      } finally {
        await client.close();
      }
    }
    assert.equal(reads, 4, 'schema and persisted config are checked for each harmless tool call');
    assert.deepEqual(
      { migrations, registrations, writes },
      { migrations: 0, registrations: 0, writes: 0 },
    );

    await backing.setSetting('schema_version', 'unsupported');
    const client = new Client({ name: 'worker-mcp-schema-test', version: '1.0.0' });
    const env = {
      DB,
      PULSE_CONFIG: JSON.stringify(config),
      PULSE_API_TOKEN: token,
      ASSETS: {
        async fetch() {
          throw new Error('MCP must not load assets');
        },
      },
    };
    const transport = new StreamableHTTPClientTransport(new URL('https://pulse.invalid/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
      fetch: async (input, init) => worker.fetch(new Request(input, init), env),
    });
    try {
      await client.connect(transport);
      const response = await client.callTool({ name: 'list_projects', arguments: {} });
      assert.equal(response.isError, true);
      assert.doesNotMatch(JSON.stringify(response), /Example project/);
    } finally {
      await client.close();
    }
    assert.equal(reads, 5, 'unsupported schema stops after its metadata read');
    assert.deepEqual(
      { migrations, registrations, writes },
      { migrations: 0, registrations: 0, writes: 0 },
    );
  } finally {
    Store.prototype.migrate = originalMigrate;
    Store.prototype.register = originalRegister;
    backing.driver.close?.();
  }
});
