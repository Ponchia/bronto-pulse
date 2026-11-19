import test from 'node:test';
import assert from 'node:assert/strict';
import { database, fixture, now, publish, sample, window } from './helpers.js';
import { recordReview, readReviewHistory, readReviewRecord } from '../src/journal.js';
import { evidenceDigest } from '../src/review-record.js';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import { handle } from '../src/api/handler.js';

const input = {
  id: 'release-review-0001',
  projectId: 'project',
  window,
  question: 'Did repository attention change after the documentation release?',
  conclusion: 'Reviewed; no action justified by these observations.',
  actionUrl: 'https://github.com/example/project/pull/1',
};
test('review retries retain the first evidence; a linked follow-up captures later corrected data', async () => {
  const config = fixture(),
    store = await database(config);
  try {
    await publish(store, config, [sample()]);
    const first = await recordReview(config, store, input, now);
    await publish(store, config, [sample('2026-10-12', 30)]);
    assert.deepEqual(
      await recordReview(config, store, input, new Date(now.getTime() + 1000)),
      first,
    );
    const next = await recordReview(
      config,
      store,
      {
        ...input,
        id: 'release-review-0002',
        followUpOf: first.id,
        conclusion:
          'A source correction changed the observed value; the original conclusion is retained.',
      },
      new Date(now.getTime() + 2000),
    );
    assert.notEqual(next.evidence.sha256, first.evidence.sha256);
    assert.equal(next.followUpOf, first.id);
    assert.deepEqual(await readReviewRecord(config, store, 'project', first.id), first);
    assert.equal((await readReviewHistory(config, store, 'project')).length, 2);
    await assert.rejects(
      recordReview(config, store, { ...input, conclusion: 'Different conclusion' }, now),
      /already used/,
    );
    assert.deepEqual(await readReviewRecord(config, store, 'project', first.id), first);
  } finally {
    store.driver.close?.();
  }
});
test('journal survives archive restore and rejects tampered snapshots before any import', async () => {
  const config = fixture(),
    store = await database(config);
  const restored = new Store(new SqliteDriver(':memory:'));
  const rejected = new Store(new SqliteDriver(':memory:'));
  try {
    await publish(store, config, [sample()]);
    const first = await recordReview(config, store, input, now);
    await recordReview(
      config,
      store,
      { ...input, id: 'release-review-0002', followUpOf: first.id },
      now,
    );
    const archive = await store.export();
    await restored.migrate();
    await restored.import(archive);
    assert.deepEqual(await readReviewRecord(config, restored, 'project', first.id), first);
    assert.equal((await restored.reviewRecords('project')).length, 2);
    const invalid = structuredClone(archive);
    const record = JSON.parse(String(invalid.reviews![0]!.record_json));
    record.evidence.report.warnings.push('tampered');
    invalid.reviews![0]!.record_json = JSON.stringify(record);
    await rejected.migrate();
    await assert.rejects(rejected.import(invalid), /digest/);
    assert.equal(await rejected.getConfig(), undefined);
    assert.equal((await rejected.driver.all({ sql: 'SELECT * FROM resources' })).length, 0);
    assert.equal(await evidenceDigest(first.evidence.report), first.evidence.sha256);
  } finally {
    store.driver.close?.();
    restored.driver.close?.();
    rejected.driver.close?.();
  }
});
test('review validation rejects unsafe links, unknown projects, dangling follow-ups and oversized text', async () => {
  const config = fixture(),
    store = await database(config);
  try {
    for (const change of [
      { actionUrl: 'javascript:alert(1)' },
      { actionUrl: 'https://user:password@example.invalid' },
      { projectId: 'absent' },
      { followUpOf: 'missing-record-0001' },
      { followUpOf: input.id },
      { question: ' ' },
      { conclusion: 'x'.repeat(5001) },
      { surprise: 'ignored?' },
    ])
      await assert.rejects(recordReview(config, store, { ...input, ...change }, now));
    assert.equal((await store.reviewRecords('project')).length, 0);
    await assert.rejects(readReviewHistory(config, store, 'project', 101), /page size/);
  } finally {
    store.driver.close?.();
  }
});
test('same-id concurrent writes converge on the first evidence without replacing it', async () => {
  const config = fixture(),
    store = await database(config);
  try {
    const [a, b] = await Promise.all([
      recordReview(config, store, input, now),
      recordReview(config, store, input, new Date(now.getTime() + 1000)),
    ]);
    assert.deepEqual(a, b);
    assert.equal((await store.reviewRecords('project')).length, 1);
  } finally {
    store.driver.close?.();
  }
});
test('journal API requires owner authentication and returns summaries before selected frozen evidence', async () => {
  const config = fixture(),
    store = await database(config);
  const token = 'journal-test-owner-token-123456789';
  const context = {
    config,
    store,
    secrets: {},
    apiToken: token,
    asset: async () => new Response(''),
    now: () => now,
  };
  const path = 'https://pulse.example.invalid/api/v1/projects/project/reviews';
  try {
    const first = await recordReview(config, store, input, now);
    assert.equal((await handle(new Request(path), context)).status, 401);
    const request = (url: string) =>
      new Request(url, { headers: { Authorization: 'Bearer ' + token } });
    const response = await handle(request(path + '?limit=1'), context);
    const result = (await response.json()) as { reviews: { evidence: Record<string, unknown> }[] };
    assert.equal(response.status, 200);
    assert.equal(result.reviews[0]!.evidence.sha256, first.evidence.sha256);
    assert.equal(result.reviews[0]!.evidence.report, undefined);
    const full = await handle(request(path + '/' + first.id), context);
    assert.deepEqual(await full.json(), first);
    assert.equal((await handle(request(path + '?limit=101'), context)).status, 400);
    assert.equal((await handle(request(path + '/' + first.id + '?limit=1'), context)).status, 400);
    assert.equal(
      (
        await handle(
          new Request(path, { method: 'POST', headers: { Authorization: 'Bearer ' + token } }),
          context,
        )
      ).status,
      405,
    );
  } finally {
    store.driver.close?.();
  }
});

test('saved review captures one selected-project snapshot, closes it, and refuses live-read fallback', async () => {
  const { parseConfig } = await import('../src/config.js');
  const { projectReport } = await import('../src/report.js');
  const base = fixture('github', { groups: ['views'] });
  const extra = Array.from({ length: 20 }, (_, i) => ({
    id: 'extra-' + i,
    provider: 'npm',
    package: 'extra-package-' + i,
  }));
  const config = parseConfig({
    ...base,
    resources: [...base.resources, ...extra],
    projects: [
      ...base.projects,
      {
        id: 'large',
        label: 'Large project',
        resources: extra.map((r) => ({ resource: r.id })),
      },
    ],
  });
  const backing = await database(config);
  let publications = 0,
    readBatches = 0,
    closes = 0,
    failRead = false;
  const selectedProjects: string[][] = [];
  const observed = new Store({
    all: backing.driver.all.bind(backing.driver),
    batch: backing.driver.batch.bind(backing.driver),
    async readBatch(statements) {
      readBatches++;
      const rows = await backing.driver.readBatch(statements);
      // A collector commits after the database snapshot was read, but before
      // projectReport consumes its first observation. Saved evidence must
      // continue to describe the captured rows, not this newer publication.
      if (publications++ === 0) await publish(backing, config, [sample('2026-10-12', 30)]);
      return rows;
    },
  });
  const originalSnapshot = observed.reportingSnapshot.bind(observed);
  observed.reportingSnapshot = async (selected, range, options) => {
    selectedProjects.push(selected.projects.map((p) => p.id));
    const snapshot = await originalSnapshot(selected, range, options);
    const close = snapshot.driver.close?.bind(snapshot.driver);
    snapshot.driver.close = () => {
      closes++;
      close?.();
    };
    if (failRead)
      snapshot.driver.all = async () => {
        throw new Error('synthetic report failure');
      };
    return snapshot;
  };
  try {
    await publish(backing, config, [sample()]);
    const saved = await recordReview(config, observed, input, now);
    const views = (report: Awaited<ReturnType<typeof projectReport>>) =>
      report.cards.find((card) => card.metric === 'github.views')!.value;
    assert.equal(views(saved.evidence.report), 8);
    assert.equal(views(await projectReport(config, backing, 'project', window, now)), 30);
    assert.equal(readBatches, 1);
    assert.equal(closes, 1);
    assert.deepEqual(
      selectedProjects[0],
      ['project'],
      'unrelated large projects do not exhaust this snapshot',
    );

    failRead = true;
    await assert.rejects(
      recordReview(config, observed, { ...input, id: 'failed-review-0001' }, now),
      /synthetic report failure/,
    );
    assert.equal(closes, 2, 'a failed report closes its captured read view');
    assert.equal(await backing.reviewRecord('failed-review-0001'), undefined);

    const readsBeforeRefusal = readBatches;
    await assert.rejects(
      recordReview(
        config,
        observed,
        {
          ...input,
          id: 'large-review-0001',
          projectId: 'large',
        },
        now,
      ),
      { code: 'ROW_LIMIT' },
    );
    assert.equal(
      readBatches,
      readsBeforeRefusal,
      'oversized snapshots fail before database reads or fallback',
    );
    assert.equal(await backing.reviewRecord('large-review-0001'), undefined);
    assert.equal((await backing.reviewRecords('project')).length, 1);
    assert.deepEqual(selectedProjects[2], ['large']);
  } finally {
    backing.driver.close?.();
  }
});

test('saved reviews preserve project identity even before any observations exist', async () => {
  const base = fixture('npm');
  // Both synthetic project identities intentionally share this source.
  base.projects[0]!.resources[0]!.allowShared = true;
  const config = {
    ...base,
    projects: [
      ...base.projects,
      { ...base.projects[0]!, id: 'unreviewed', label: 'Unreviewed synthetic project' },
    ],
  };
  const store = await database(config);
  const restored = new Store(new SqliteDriver(':memory:'));
  try {
    const first = await recordReview(config, store, input, now);
    assert.equal((await store.driver.all({ sql: 'SELECT * FROM partitions' })).length, 0);
    assert.equal((await store.driver.all({ sql: 'SELECT * FROM url_inspections' })).length, 0);
    await assert.rejects(
      store.register(
        { ...config, projects: config.projects.filter((project) => project.id !== 'project') },
        now,
      ),
      { code: 'CONFLICT' },
    );
    assert.deepEqual(await store.getConfig(), config);
    const narrowed = {
      ...config,
      projects: config.projects.filter((project) => project.id === 'project'),
    };
    await store.register(narrowed, now);
    await restored.migrate();
    await restored.import(await store.export());
    assert.deepEqual(await readReviewRecord(narrowed, restored, 'project', first.id), first);
  } finally {
    store.driver.close?.();
    restored.driver.close?.();
  }
});
