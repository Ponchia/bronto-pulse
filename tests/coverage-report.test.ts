import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { observedCoverage } from '../src/coverage-report.js';
import type { Run } from '../src/model.js';
import type { Store } from '../src/storage/store.js';
import { database, fixture, now, publish, sample, window } from './helpers.js';

function recorded(resourceId: string, group: string, extra: Partial<Run> = {}): Run {
  return {
    id: resourceId + '-' + group,
    resourceId,
    group,
    from: window.from,
    to: window.to,
    status: 'success',
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    rows: 2,
    requests: 1,
    code: null,
    message: null,
    notes: [],
    completeness: 'complete',
    ...extra,
  };
}
function reads(
  latest: Run[],
  successful: Run[],
  dates: { resourceId: string; group: string; date: string }[],
): Store {
  return {
    async runHeads() {
      return { latest, successful };
    },
    async observedThrough() {
      return dates;
    },
  } as unknown as Store;
}

test('observed coverage counts intended groups that are missing, disabled, unbound or never published', async () => {
  const base = fixture('github', { groups: ['views'] });
  const config = parseConfig({
    ...base,
    resources: [
      ...base.resources,
      { id: 'disabled', provider: 'npm', package: 'disabled-package', enabled: false },
      { id: 'unbound', provider: 'npm', package: 'unbound-package' },
      { id: 'new', provider: 'npm', package: 'new-package' },
    ],
    projects: [
      {
        ...base.projects[0],
        resources: [{ resource: 'source' }, { resource: 'disabled' }, { resource: 'new' }],
      },
    ],
  });
  const store = await database(config);
  try {
    await publish(store, config, [sample(window.from, 8), sample(window.to, 10)]);
    const result = await observedCoverage(
      config,
      store,
      {
        version: 1,
        resources: [
          { provider: 'github', repository: 'example/project', groups: ['views', 'clones'] },
          { provider: 'npm', package: 'disabled-package' },
          { provider: 'npm', package: 'unbound-package' },
          { provider: 'npm', package: 'new-package' },
          { provider: 'npm', package: 'absent-package' },
        ],
      },
      now,
    );
    assert.equal(result.summary.intendedResources, 5);
    assert.equal(result.summary.intendedDatasets, 6);
    assert.equal(result.summary.publishedDatasets, 1);
    assert.equal(result.summary.neverPublishedDatasets, 5);
    assert.deepEqual(
      result.datasets.map((row) => row.configurationState),
      ['configured', 'group_not_configured', 'disabled', 'unbound', 'configured', 'missing'],
    );
    const published = result.datasets[0]!.sources[0]!;
    assert.equal(published.lastAttempt?.status, 'success');
    assert.equal(published.lastSuccess?.rows, 2);
    assert.equal(published.collectionRecency.state, 'recent');
    assert.equal(published.sourceData.observedThrough, window.to);
    assert.equal(published.permissionEvidence.state, 'last_success');
    assert.equal(published.permissionEvidence.provesCurrentAccess, false);
    assert.equal(result.datasets[4]!.sources[0]!.permissionEvidence.state, 'unknown');
    assert.deepEqual(result.datasets[5]!.sources, []);
    assert.doesNotMatch(JSON.stringify(result), /TEST_TOKEN|private-test-token/);
  } finally {
    store.driver.close?.();
  }
});

test('fresh collection, source-data lag and access evidence remain independent across duplicate identities', async () => {
  const config = parseConfig({
    version: 1,
    resources: [
      { id: 'search', provider: 'gsc', siteUrl: 'sc-domain:example.org', collectPages: false },
      { id: 'good', provider: 'github', repository: 'example/project', groups: ['views'] },
      { id: 'bad', provider: 'github', repository: 'example/project', groups: ['views'] },
    ],
    projects: [
      {
        id: 'project',
        label: 'Project',
        resources: [{ resource: 'search' }, { resource: 'good' }, { resource: 'bad' }],
      },
    ],
  });
  const search = recorded('search', 'totals');
  const good = recorded('good', 'views');
  const denied = recorded('bad', 'views', {
    status: 'failed',
    code: 'PERMISSION',
    message: 'do not expose provider payload',
  });
  const result = await observedCoverage(
    config,
    reads(
      [search, good, denied],
      [search, good],
      [
        { resourceId: 'search', group: 'totals', date: '2026-10-01' },
        { resourceId: 'good', group: 'views', date: window.to },
      ],
    ),
    {
      version: 1,
      resources: [
        { provider: 'gsc', siteUrl: 'sc-domain:example.org', groups: ['totals'] },
        { provider: 'github', repository: 'example/project', groups: ['views'] },
      ],
    },
    now,
  );
  assert.equal(
    result.summary.intendedDatasets,
    2,
    'duplicate config IDs cannot inflate intended coverage',
  );
  const source = result.datasets[0]!.sources[0]!;
  assert.equal(source.collectionRecency.state, 'recent');
  assert.equal(source.sourceData.state, 'lagging');
  assert.equal(source.sourceData.timezone, 'America/Los_Angeles');
  const siblings = result.datasets[1]!.sources;
  assert.equal(
    siblings.find((s) => s.resourceId === 'bad')?.permissionEvidence.state,
    'access_error',
  );
  assert.equal(
    siblings.find((s) => s.resourceId === 'good')?.permissionEvidence.state,
    'last_success',
  );
  assert.equal(siblings.find((s) => s.resourceId === 'bad')?.lastSuccess, null);
  assert.doesNotMatch(JSON.stringify(result), /do not expose provider payload/);
});

test('empty successful publication does not become observed data or measured zero', async () => {
  const config = fixture('npm');
  const success = recorded('source', 'downloads', { rows: 0 });
  const result = await observedCoverage(
    config,
    reads([success], [success], []),
    {
      version: 1,
      resources: [{ provider: 'npm', package: '@example/package' }],
    },
    now,
  );
  const row = result.datasets[0]!;
  assert.equal(row.publicationState, 'published');
  assert.equal(row.sources[0]!.collectionRecency.state, 'recent');
  assert.equal(row.sources[0]!.sourceData.state, 'not_observed');
  assert.equal(row.sources[0]!.sourceData.observedThrough, null);
  assert.equal(row.sources[0]!.sourceData.lagDays, null);
  const stale = await observedCoverage(
    config,
    reads([success], [success], []),
    {
      version: 1,
      resources: [{ provider: 'npm', package: '@example/package' }],
    },
    new Date('2026-11-19T12:00:00Z'),
  );
  assert.equal(stale.datasets[0]!.sources[0]!.collectionRecency.state, 'stale');
});

test('configuration asOf binding rules are reused and invalid inventories do not read storage', async () => {
  const config = parseConfig({
    version: 1,
    resources: [{ id: 'search', provider: 'gsc', siteUrl: 'sc-domain:example.org' }],
    projects: [
      {
        id: 'project',
        label: 'Project',
        resources: [{ resource: 'search', effectiveFrom: '2026-10-15' }],
      },
    ],
  });
  const inventory = {
    version: 1,
    asOf: '2026-10-14',
    resources: [{ provider: 'gsc', siteUrl: 'sc-domain:example.org', groups: ['totals'] }],
  };
  const report = await observedCoverage(config, reads([], [], []), inventory, now);
  assert.equal(report.datasets[0]!.configurationState, 'unbound');
  assert.equal(report.datasets[0]!.sources[0]!.configurationState, 'unbound');
  const noReads = {
    async runHeads() {
      assert.fail('invalid inventory reached storage');
    },
    async observedThrough() {
      assert.fail('invalid inventory reached storage');
    },
  } as unknown as Store;
  await assert.rejects(
    observedCoverage(config, noReads, { ...inventory, token: 'rejected' }, now),
    { code: 'CONFIG' },
  );
  await assert.rejects(
    observedCoverage(
      config,
      noReads,
      {
        version: 1,
        resources: Array.from({ length: 501 }, (_, i) => ({ provider: 'npm', package: 'p' + i })),
      },
      now,
    ),
    { code: 'CONFIG' },
  );
});
