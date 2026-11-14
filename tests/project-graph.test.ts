import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, type Config } from '../src/config.js';
import { projectGraph } from '../src/project-graph.js';
import { investigateProject } from '../src/investigations.js';
import { projectReport } from '../src/report.js';
import { PulseError } from '../src/errors.js';
import { demoConfig } from '../src/demo.js';
import { database, now, window } from './helpers.js';

const ACCOUNT = 'a'.repeat(32);
const SITE_TAG = 'b'.repeat(32);
const DATABASE = '00000000-0000-4000-8000-000000000001';
function config(reorder = false): Config {
  const resources: Record<string, unknown>[] = [
    {
      id: 'repo',
      provider: 'github',
      repository: 'example/widget',
      repositoryId: 4242,
      connection: 'gh_key',
    },
    { id: 'fork', provider: 'github', repository: 'example/widget-fork', connection: 'gh_key' },
    // Same name as the repository on purpose: a name never creates a relationship.
    { id: 'pkg', provider: 'npm', package: 'widget', label: 'Widget package' },
    {
      id: 'cf',
      provider: 'cloudflare',
      accountId: ACCOUNT,
      siteTag: SITE_TAG,
      hostname: 'example.org',
      groups: ['totals'],
      connection: 'cf_key',
    },
    {
      id: 'pl',
      provider: 'plausible',
      siteId: 'example.org',
      timezone: 'UTC',
      connection: 'pl_key',
    },
    { id: 'um', provider: 'umami', websiteId: 'website-private-123', connection: 'um_key' },
    { id: 'search', provider: 'gsc', siteUrl: 'sc-domain:example.org', connection: 'gsc_key' },
    {
      id: 'events',
      provider: 'sense6',
      accountId: ACCOUNT,
      databaseId: DATABASE,
      connection: 'cf_key',
      enabled: false,
    },
  ];
  const projects: Record<string, unknown>[] = [
    {
      id: 'widget',
      label: 'Widget',
      resources: [
        { resource: 'repo' },
        { resource: 'pkg', allowShared: true },
        { resource: 'cf' },
        { resource: 'pl' },
        { resource: 'um' },
        { resource: 'search', scope: { pathPrefix: '/widget' }, effectiveFrom: '2026-09-01' },
        { resource: 'events' },
      ],
      websites: [
        {
          id: 'main_site',
          hostname: 'example.org',
          sources: ['um', 'cf', 'pl'],
          pageviewsAuthority: [
            { resource: 'cf', effectiveFrom: '2026-09-01' },
            { resource: 'pl', effectiveFrom: '2026-10-15' },
          ],
        },
      ],
    },
    { id: 'toolkit', label: 'Toolkit', resources: [{ resource: 'pkg', allowShared: true }] },
    { id: 'other', label: 'Other', resources: [{ resource: 'fork' }] },
  ];
  return parseConfig({
    version: 1,
    connections: [
      { id: 'gh_key', provider: 'github', tokenEnv: 'GH_PRIVATE_TOKEN' },
      { id: 'cf_key', provider: 'cloudflare', tokenEnv: 'CF_PRIVATE_TOKEN' },
      { id: 'pl_key', provider: 'plausible', tokenEnv: 'PL_PRIVATE_TOKEN' },
      { id: 'um_key', provider: 'umami', tokenEnv: 'UM_PRIVATE_TOKEN' },
      { id: 'gsc_key', provider: 'gsc', tokenEnv: 'GSC_PRIVATE_TOKEN' },
    ],
    resources: reorder ? [...resources].reverse() : resources,
    projects: reorder
      ? [
          ...projects.slice(1).reverse(),
          {
            ...projects[0]!,
            resources: [...(projects[0]!.resources as unknown[])].reverse(),
          },
        ]
      : projects,
  });
}

test('the project map restates explicit configuration and nothing else', () => {
  const input = config();
  const before = structuredClone(input);
  const graph = projectGraph(input, 'widget');
  assert.deepEqual(input, before, 'configuration is read, never changed');
  assert.equal(graph.schemaVersion, 1);
  assert.deepEqual(graph.project, { id: 'widget', label: 'Widget' });
  assert.deepEqual(
    graph.resources.map((r) => [r.id, r.kind, r.identity.type, r.identity.value, r.identity.basis]),
    [
      ['cf', 'website_analytics', 'hostname', 'example.org', 'config_declared'],
      ['events', 'product_events', 'none', null, 'config_declared'],
      ['pkg', 'package', 'package', 'widget', 'config_declared'],
      ['pl', 'website_analytics', 'hostname', 'example.org', 'config_declared'],
      ['repo', 'repository', 'repository', 'example/widget', 'config_pinned_id'],
      ['search', 'search_property', 'search_property', 'sc-domain:example.org', 'config_declared'],
      ['um', 'website_analytics', 'none', null, 'config_declared'],
    ],
  );
  const byId = Object.fromEntries(graph.resources.map((r) => [r.id, r]));
  assert.equal(byId.events!.enabled, false);
  assert.equal(byId.pkg!.label, 'Widget package');
  assert.deepEqual(byId.pkg!.sharedWithProjects, ['toolkit']);
  assert.deepEqual(byId.repo!.sharedWithProjects, []);
  assert.deepEqual(byId.search!.bindings, [
    {
      scope: { hostname: null, pathPrefix: '/widget' },
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      shared: false,
    },
  ]);
  assert.deepEqual(byId.um!.websites, ['main_site']);
  assert.deepEqual(byId.repo!.websites, []);
  assert.deepEqual(graph.websites, [
    {
      id: 'main_site',
      hostname: 'example.org',
      sources: ['cf', 'pl', 'um'],
      pageviewAuthority: [
        { resource: 'cf', effectiveFrom: '2026-09-01' },
        { resource: 'pl', effectiveFrom: '2026-10-15' },
      ],
    },
  ]);
  // Another project's unshared resource is not part of this project's map.
  assert.equal(JSON.stringify(graph).includes('widget-fork'), false);
  assert.match(graph.limitation, /no relationship is inferred from a name/);
});

test('relationships come only from declared bindings and website policies', () => {
  const graph = projectGraph(config(), 'widget');
  const edges = graph.relationships.map((edge) => [
    edge.type,
    edge.from,
    edge.to,
    edge.provenance,
    edge.effectiveFrom,
    edge.effectiveTo,
  ]);
  assert.deepEqual(edges, [
    ['project_measures_resource', 'project:widget', 'resource:cf', 'project_binding', null, null],
    [
      'project_measures_resource',
      'project:widget',
      'resource:events',
      'project_binding',
      null,
      null,
    ],
    ['project_measures_resource', 'project:widget', 'resource:pkg', 'project_binding', null, null],
    ['project_measures_resource', 'project:widget', 'resource:pl', 'project_binding', null, null],
    ['project_measures_resource', 'project:widget', 'resource:repo', 'project_binding', null, null],
    [
      'project_measures_resource',
      'project:widget',
      'resource:search',
      'project_binding',
      '2026-09-01',
      null,
    ],
    ['project_measures_resource', 'project:widget', 'resource:um', 'project_binding', null, null],
    [
      'resource_shared_with_project',
      'resource:pkg',
      'project:toolkit',
      'project_binding',
      null,
      null,
    ],
    [
      'resource_reports_website',
      'resource:cf',
      'website:main_site',
      'website_declaration',
      null,
      null,
    ],
    [
      'resource_reports_website',
      'resource:pl',
      'website:main_site',
      'website_declaration',
      null,
      null,
    ],
    [
      'resource_reports_website',
      'resource:um',
      'website:main_site',
      'website_declaration',
      null,
      null,
    ],
    [
      'website_prefers_pageview_source',
      'website:main_site',
      'resource:cf',
      'pageview_authority',
      '2026-09-01',
      '2026-10-14',
    ],
    [
      'website_prefers_pageview_source',
      'website:main_site',
      'resource:pl',
      'pageview_authority',
      '2026-10-15',
      null,
    ],
  ]);
  // A package and a repository with the same name stay unrelated, and no
  // deployment, ownership or publication edge exists at all.
  assert.ok(
    !graph.relationships.some(
      (edge) =>
        [edge.from, edge.to].includes('resource:pkg') &&
        [edge.from, edge.to].includes('resource:repo'),
    ),
  );
  assert.ok(!graph.relationships.some((edge) => /deploy|own|publish|host/.test(edge.type)));
});

test('the map is deterministic for reordered configuration', () => {
  assert.deepEqual(projectGraph(config(true), 'widget'), projectGraph(config(), 'widget'));
  assert.deepEqual(projectGraph(config(), 'widget'), projectGraph(config(), 'widget'));
});

test('the map discloses no credential, connection or account-side identifier', () => {
  const input = config();
  for (const project of input.projects) {
    const text = JSON.stringify(projectGraph(input, project.id));
    for (const secret of [
      ACCOUNT,
      SITE_TAG,
      DATABASE,
      'website-private-123',
      '4242',
      '_key',
      'PRIVATE_TOKEN',
      'tokenEnv',
      'connection',
    ])
      assert.equal(text.includes(secret), false, secret);
  }
  assert.throws(
    () => projectGraph(input, 'missing'),
    (error) => error instanceof PulseError && error.code === 'NOT_FOUND',
  );
});

test('a supplied map names each lead subject and flags shared resources', async () => {
  const input = demoConfig();
  const store = await database(input);
  try {
    for (const project of input.projects) {
      const graph = projectGraph(input, project.id);
      assert.deepEqual(
        graph.resources.map((r) => r.id),
        [...new Set(project.resources.map((b) => b.resource))].sort(),
      );
      const report = await projectReport(input, store, project.id, window, now);
      const plain = investigateProject(report, 100);
      const mapped = investigateProject(report, 100, graph);
      assert.deepEqual(
        mapped.findings.map((f) => f.id),
        plain.findings.map((f) => f.id),
      );
      for (const finding of mapped.findings) {
        const resource = graph.resources.find((r) => r.id === finding.resourceId);
        assert.equal(finding.subject?.kind, resource?.kind);
        assert.equal(
          finding.limitations.some((text) => /shared with other projects/.test(text)),
          Boolean(resource?.sharedWithProjects.length),
        );
      }
      assert.ok(plain.findings.every((f) => f.subject === undefined));
    }
  } finally {
    store.driver.close?.();
  }
});
