import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createPulseMcpServer } from '../src/mcp/server.js';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import { readReviewRecord } from '../src/journal.js';
import { fixture, now, publish, sample, window } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');

test('MCP to operator CLI preserves the reviewed revision through change, save and retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-reviewed-revision-'));
  const config = fixture('github', { groups: ['views'] });
  const dbPath = join(dir, 'pulse.db');
  const store = new Store(new SqliteDriver(dbPath));
  const server = createPulseMcpServer({ config, store, now }, { version: 'test' });
  const client = new Client({ name: 'review-save-tests', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const input = {
    id: 'guarded-review-0001',
    projectId: 'project',
    window,
    question: 'Did the published repository view count change?',
    conclusion: 'The reviewed source is retained with its qualifications.',
  };
  writeFileSync(join(dir, 'pulse.config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'review.json'), JSON.stringify(input));
  function save(revision?: string) {
    return spawnSync(
      process.execPath,
      [
        '--import',
        loader,
        cli,
        'review-record',
        '--input',
        join(dir, 'review.json'),
        '--config',
        join(dir, 'pulse.config.json'),
        '--db',
        dbPath,
        ...(revision ? ['--expected-revision', revision] : []),
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 15000,
        env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC' },
      },
    );
  }
  async function review() {
    const result = await client.callTool({
      name: 'get_project_brief',
      arguments: { projectId: 'project', ...window },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const payload = result.structuredContent as {
      evidenceRef: { arguments: { expectedRevision: string } };
    };
    const revision = payload.evidenceRef.arguments.expectedRevision;
    assert.match(revision, /^[a-f0-9]{64}$/);
    return revision;
  }
  try {
    await store.migrate();
    await store.register(config, now);
    await publish(store, config, [sample(window.from, 8), sample(window.to, 10)]);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const first = await review();
    await publish(store, config, [sample(window.from, 20), sample(window.to, 10)]);
    let result = save(first);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /CONFLICT:.*expected revision/);
    assert.equal(
      await store.reviewRecord(input.id),
      undefined,
      'a changed report cannot be saved under the earlier review',
    );

    const reconsidered = await review();
    assert.notEqual(reconsidered, first);
    result = save(reconsidered);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const saved = await readReviewRecord(config, store, 'project', input.id);
    assert.equal(summary.evidence.sha256, saved.evidence.sha256);
    assert.notEqual(
      saved.evidence.report.generatedAt,
      now.toISOString(),
      'generation time alone does not reject reviewed content',
    );
    assert.equal(
      saved.evidence.report.cards.find((card) => card.metric === 'github.views')!.value,
      30,
    );

    await publish(store, config, [sample(window.from, 40), sample(window.to, 10)]);
    result = save(reconsidered);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      summary,
      'retry returns the original frozen record after collection',
    );
    assert.deepEqual(await readReviewRecord(config, store, 'project', input.id), saved);
    result = save(await review());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CONFLICT:/);
    assert.deepEqual(await readReviewRecord(config, store, 'project', input.id), saved);
    result = save();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      summary,
      'legacy unguarded retries remain compatible',
    );
    assert.equal((await store.reviewRecords('project')).length, 1);
  } finally {
    await client.close();
    await server.close();
    store.driver.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
