import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, pathMatches, resourceIdentity } from '../src/config.js';
import { day, days, range, previous, dateInZone } from '../src/time.js';
import { fixture, window } from './helpers.js';
for (const provider of ['github', 'npm', 'cloudflare', 'gsc', 'sense6'])
  test(`valid ${provider} configuration`, () =>
    assert.equal(fixture(provider).resources[0]?.provider, provider));
test('reject unknown config keys and inline secrets', () => {
  assert.throws(() => parseConfig({ ...fixture(), token: 'secret' }), /Invalid/);
  assert.throws(
    () =>
      parseConfig({
        ...fixture(),
        connections: [{ id: 'auth', provider: 'github', token: 'secret' }],
      }),
    /Invalid/,
  );
});
test('reject duplicate resources and mismatched connections', () => {
  const c = fixture();
  assert.throws(
    () => parseConfig({ ...c, resources: [...c.resources, ...c.resources] }),
    /Duplicate/,
  );
  assert.throws(
    () => parseConfig({ ...c, connections: [{ id: 'auth', provider: 'gsc', tokenEnv: 'X' }] }),
    /another provider/,
  );
});
test('URL and repository injection is rejected', () => {
  assert.throws(() => fixture('github', { repository: 'x/y/../../secret' }));
  assert.throws(() => fixture('gsc', { siteUrl: 'https://user:pass@example.com/' }));
  assert.throws(() => fixture('cloudflare', { accountId: 'bad"}' }));
});
test('path prefixes are segment-aware', () => {
  assert.equal(pathMatches('/ui', '/ui/'), true);
  assert.equal(pathMatches('/ui/guide', '/ui'), true);
  assert.equal(pathMatches('/ui-secret', '/ui'), false);
  assert.equal(pathMatches('/anything', '/'), true);
});
test('shared property with non-overlapping paths validates', () => {
  const c = fixture('cloudflare');
  const projects = [
    {
      id: 'one',
      label: 'One',
      resources: [{ resource: 'source', scope: { hostname: 'example.com', pathPrefix: '/one/' } }],
    },
    {
      id: 'two',
      label: 'Two',
      resources: [{ resource: 'source', scope: { hostname: 'example.com', pathPrefix: '/two/' } }],
    },
  ];
  assert.equal(parseConfig({ ...c, projects }).projects.length, 2);
});
test('overlap needs explicit shared opt-in on both projects', () => {
  const c = fixture('cloudflare');
  const p = { resource: 'source', scope: { pathPrefix: '/one' } };
  assert.throws(
    () =>
      parseConfig({
        ...c,
        projects: [
          { id: 'a', label: 'A', resources: [p] },
          { id: 'b', label: 'B', resources: [{ resource: 'source' }] },
        ],
      }),
    /Overlapping/,
  );
  assert.doesNotThrow(() =>
    parseConfig({
      ...c,
      projects: [
        { id: 'a', label: 'A', resources: [{ ...p, allowShared: true }] },
        { id: 'b', label: 'B', resources: [{ resource: 'source', allowShared: true }] },
      ],
    }),
  );
});
test('non-overlapping effective periods can share a scope', () => {
  const c = fixture('cloudflare');
  assert.doesNotThrow(() =>
    parseConfig({
      ...c,
      projects: [
        { id: 'a', label: 'A', resources: [{ resource: 'source', effectiveTo: '2026-01-01' }] },
        { id: 'b', label: 'B', resources: [{ resource: 'source', effectiveFrom: '2026-01-02' }] },
      ],
    }),
  );
});
test('stable GitHub identity ignores a repository rename when pinned', () =>
  assert.equal(
    resourceIdentity(fixture('github', { repositoryId: 123 }).resources[0]!),
    resourceIdentity(
      fixture('github', { repository: 'new/name', repositoryId: 123 }).resources[0]!,
    ),
  ));
test('invalid calendar dates and reversed ranges fail', () => {
  for (const x of ['2026-02-29', '2026-13-01', 'today', '2026-1-1']) assert.throws(() => day(x));
  assert.throws(() => range('2026-10-14', '2026-10-01'));
});
test('timezone and preceding period remain explicit', () => {
  assert.equal(dateInZone(new Date('2026-03-10T02:00:00Z'), 'America/Los_Angeles'), '2026-03-09');
  assert.deepEqual(previous(window), { from: '2026-10-10', to: '2026-10-11' });
  assert.equal(days(window).length, 2);
});
