import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../src/collectors/index.js';
import { SENSE6_QUERY } from '../src/collectors/sense6.js';
import { fixture, ctx, window } from './helpers.js';
import { validateCollected } from '../src/validation.js';

test('GitHub daily counts preserve explicit zero and omit unknown dates', async () => {
  const c = fixture(),
    r = c.resources[0]!;
  const data = await collect(
    r,
    'views',
    ctx(c, [
      {
        count: 5,
        uniques: 2,
        views: [{ timestamp: '2026-10-12T00:00:00Z', count: 0, uniques: 0 }],
      },
    ]),
  );
  assert.equal(data.observations.length, 2);
  assert.equal(data.observations[0]?.value, 0);
  assert.ok(!data.observations.some((x) => x.from === '2026-10-13'));
});
test('GitHub malformed response does not become a zero series', async () => {
  const c = fixture();
  await assert.rejects(
    collect(c.resources[0]!, 'clones', ctx(c, [{ count: 0, uniques: 0 }])),
    /omitted or malformed/,
  );
});
test('top refs remain rolling snapshots and never become daily data', async () => {
  const c = fixture();
  const d = await collect(
    c.resources[0]!,
    'referrers',
    ctx(c, [[{ referrer: 'Google', count: 8, uniques: 4 }]]),
  );
  assert.equal(d.completeness, 'top_n');
  assert.equal(d.observations[0]?.kind, 'rolling');
  assert.equal(d.observations[0]?.from, '2026-10-01');
  assert.equal(d.observations[0]?.to, '2026-10-14');
});
test('GitHub numeric identity mismatch is a conflict', async () => {
  const c = fixture('github', { repositoryId: 123 });
  await assert.rejects(
    collect(
      c.resources[0]!,
      'repository',
      ctx(c, [{ id: 456, stargazers_count: 1, forks_count: 2, open_issues_count: 3 }]),
    ),
    /ID does not match/,
  );
});
test('GitHub repository source does not store contributor profiles', async () => {
  const c = fixture();
  const d = await collect(
    c.resources[0]!,
    'repository',
    ctx(c, [
      {
        id: 123,
        stargazers_count: 1,
        forks_count: 2,
        open_issues_count: 3,
        owner: { email: 'secret@example.com' },
      },
    ]),
  );
  assert.equal(d.identity, 'github:123');
  assert.ok(!JSON.stringify(d).includes('secret@example'));
});
test('npm validates returned identity and requested interval', async () => {
  const c = fixture('npm');
  await assert.rejects(
    collect(
      c.resources[0]!,
      'downloads',
      ctx(c, [{ package: 'wrong', start: window.from, end: window.to, downloads: [] }]),
    ),
    /different package/,
  );
  await assert.rejects(
    collect(
      c.resources[0]!,
      'downloads',
      ctx(c, [{ package: '@example/package', start: '2026-10-13', end: window.to, downloads: [] }]),
    ),
    /truncated/,
  );
});
test('npm counts stay distribution events and have no credential header', async () => {
  const c = fixture('npm');
  const d = await collect(
    c.resources[0]!,
    'downloads',
    ctx(c, async (_u, init) => {
      assert.equal(init?.headers, undefined);
      return new Response(
        JSON.stringify({
          package: '@example/package',
          start: window.from,
          end: window.to,
          downloads: [
            { day: '2026-10-12', downloads: 12 },
            { day: '2026-10-13', downloads: 0 },
          ],
        }),
      );
    }),
  );
  assert.equal(d.observations[1]?.value, 0);
  assert.equal(d.observations[1]?.quality, 'provisional');
});
function cf(rows: unknown[], dataset = 'rumPageloadEventsAdaptiveGroups') {
  return { data: { viewer: { accounts: [{ [dataset]: rows }] } }, errors: null };
}
test('Cloudflare GraphQL errors under HTTP 200 fail closed', async () => {
  const c = fixture('cloudflare');
  await assert.rejects(
    collect(c.resources[0]!, 'totals', ctx(c, [{ errors: [{ message: 'private detail' }] }])),
    /GraphQL rejected/,
  );
});
test('Cloudflare sampled page count is not blindly multiplied', async () => {
  const c = fixture('cloudflare');
  const d = await collect(
    c.resources[0]!,
    'totals',
    ctx(c, [
      cf([
        {
          count: 17,
          sum: { visits: 9 },
          avg: { sampleInterval: 10 },
          dimensions: { date: '2026-10-12' },
        },
      ]),
    ]),
  );
  assert.equal(d.observations[0]?.value, 17);
  assert.equal(d.observations[0]?.quality, 'sampled');
});
test('Cloudflare page scopes exclude artificial per-project visits and strip URL secrets', async () => {
  const c = fixture('cloudflare');
  const d = await collect(
    c.resources[0]!,
    'pages',
    ctx(c, [
      cf([
        {
          count: 3,
          sum: { visits: 2 },
          avg: { sampleInterval: 1 },
          dimensions: {
            date: '2026-10-12',
            requestHost: 'example.com',
            requestPath: '/docs/?email=secret@example.com',
          },
        },
      ]),
    ]),
  );
  assert.equal(d.observations.length, 1);
  assert.equal(d.observations[0]?.dimensions.path, '/docs/');
  assert.ok(!JSON.stringify(d).includes('secret@example'));
});
test('Cloudflare limit equality is treated as truncation', async () => {
  const c = fixture('cloudflare');
  c.settings.maxRows = 10;
  const rows = Array.from({ length: 10 }, () => ({ count: 0 }));
  await assert.rejects(collect(c.resources[0]!, 'pages', ctx(c, [cf(rows)])), /group limit/);
});
test('performance durations normalize microseconds and omit no-sample sentinels', async () => {
  const c = fixture('cloudflare');
  const d = await collect(
    c.resources[0]!,
    'performance',
    ctx(c, [
      cf(
        [
          { count: 10, dimensions: { date: '2026-10-12' }, quantiles: { pageLoadTimeP75: 900000 } },
          { count: 1, dimensions: { date: '2026-10-13' }, quantiles: { pageLoadTimeP75: -1 } },
        ],
        'rumPerformanceEventsAdaptiveGroups',
      ),
    ]),
  );
  assert.equal(d.observations.length, 1);
  assert.equal(d.observations[0]?.value, 900);
});
test('GSC totals preserve Pacific date, aggregation and finalization metadata', async () => {
  const c = fixture('gsc');
  const d = await collect(
    c.resources[0]!,
    'totals',
    ctx(c, [
      {
        responseAggregationType: 'byProperty',
        metadata: { first_incomplete_date: '2026-10-13' },
        rows: [
          { keys: ['2026-10-12'], clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
          { keys: ['2026-10-13'], clicks: 2, impressions: 10, ctr: 0.2, position: 3 },
        ],
      },
    ]),
  );
  assert.equal(d.observations[0]?.timezone, 'America/Los_Angeles');
  assert.equal(d.observations.find((x) => x.from === '2026-10-13')?.quality, 'provisional');
  assert.equal(d.observations.find((x) => x.metric === 'gsc.position')?.numerator, 200);
});
test('GSC query text requires explicit opt-in', async () => {
  const c = fixture('gsc');
  await assert.rejects(collect(c.resources[0]!, 'queries', ctx(c, [])), /explicitly enabled/);
});
test('GSC totals never silently switch aggregation', async () => {
  const c = fixture('gsc');
  await assert.rejects(
    collect(c.resources[0]!, 'totals', ctx(c, [{ responseAggregationType: 'byPage', rows: [] }])),
    /different aggregation/,
  );
});
test('GSC row caps do not publish incomplete pagination', async () => {
  const c = fixture('gsc');
  c.settings.maxRows = 10;
  await assert.rejects(
    collect(
      c.resources[0]!,
      'pages',
      ctx(c, [{ responseAggregationType: 'byPage', rows: Array.from({ length: 11 }, () => ({})) }]),
    ),
    /row budget/,
  );
});
test('Sense6 adapter uses a fixed aggregate-only SQL query', async () => {
  const c = fixture('sense6');
  const d = await collect(
    c.resources[0]!,
    'activity',
    ctx(c, async (_u, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.sql, SENSE6_QUERY);
      assert.ok(!body.sql.includes('*'));
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              success: true,
              results: [{ day: '2026-10-12', test: 'riflessi', metric: 'test_started', count: 5 }],
            },
          ],
        }),
      );
    }),
  );
  assert.equal(d.observations[0]?.value, 5);
});
test('Sense6 refuses extra participant fields', async () => {
  const c = fixture('sense6');
  await assert.rejects(
    collect(
      c.resources[0]!,
      'activity',
      ctx(c, [
        {
          success: true,
          result: [
            {
              results: [
                {
                  day: '2026-10-12',
                  test: 'riflessi',
                  metric: 'test_started',
                  count: 5,
                  email: 'x@example.com',
                },
              ],
            },
          ],
        },
      ]),
    ),
    /outside the aggregate/,
  );
});
test('observation schema rejects unknown metrics, duplicate keys and unsafe arithmetic', () => {
  const c = {
    range: window,
    notes: [],
    completeness: 'complete' as const,
    observations: [
      {
        metric: 'npm.downloads',
        from: '2026-10-12',
        to: '2026-10-12',
        timezone: 'UTC',
        kind: 'daily' as const,
        dimensions: {},
        value: NaN,
        quality: 'observed' as const,
        methodology: 'v1',
      },
    ],
  };
  assert.throws(() => validateCollected(c, 'npm', 10), /invalid/);
  c.observations[0]!.value = 5;
  c.observations.push(c.observations[0]!);
  assert.throws(() => validateCollected(c, 'npm', 10), /duplicate/);
});
