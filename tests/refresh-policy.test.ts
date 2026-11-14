import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, type Config, type Resource } from '../src/config.js';
import { dueJobs, refreshPolicy } from '../src/due-schedule.js';
import { PulseError } from '../src/errors.js';
import { HttpClient } from '../src/http.js';
import type { Run } from '../src/model.js';
import {
  RETRY_HOLD_INSTANT,
  retryAfterSeconds,
  retryNotBefore,
  validRetryAfter,
} from '../src/retry-after.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import { Store } from '../src/storage/store.js';
import { doctor, sync } from '../src/sync.js';
import { addDays } from '../src/time.js';
import { collected } from '../src/collectors/context.js';
import { database } from './helpers.js';

const HOUR = 3600000;
const now = new Date('2026-11-13T12:00:00Z');

function portfolio(resources: Record<string, unknown>[]): Config {
  return parseConfig({
    version: 1,
    settings: { lookbackDays: 7, maxRows: 100 },
    connections: [
      { id: 'gh', provider: 'github', tokenEnv: 'GH_TOKEN' },
      { id: 'search', provider: 'gsc', tokenEnv: 'GSC_TOKEN' },
    ],
    resources,
    projects: [
      {
        id: 'project',
        label: 'Project',
        resources: resources.map((r) => ({ resource: r.id })),
      },
    ],
  });
}
const repo = (extra: Record<string, unknown> = {}) => ({
  id: 'repo',
  provider: 'github',
  repository: 'example/project',
  connection: 'gh',
  groups: ['repository', 'views', 'releases'],
  ...extra,
});
const pkg = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  provider: 'npm',
  package: id,
  ...extra,
});
function run(
  resourceId: string,
  group: string,
  status: Run['status'],
  at: string,
  code: string | null = null,
  to = '2026-11-12',
): Run {
  return {
    id: [resourceId, group, status, at].join(':'),
    resourceId,
    group,
    from: '2026-11-01',
    to,
    status,
    startedAt: at,
    finishedAt: status === 'running' ? null : at,
    rows: status === 'success' ? 7 : 0,
    requests: 1,
    code,
    message: null,
    notes: [],
    completeness: status === 'success' ? 'complete' : null,
  };
}
const datasets = (resource: Resource, groups: string[]) =>
  groups.map((group) => ({ resource, group }));

test('configuration accepts per-group intervals only for groups the resource collects', () => {
  const config = portfolio([
    repo({ refreshHours: 12, refreshHoursByGroup: { repository: 168, releases: 1 } }),
    pkg('alpha', { refreshHoursByGroup: { downloads: 720 } }),
    {
      id: 'site',
      provider: 'gsc',
      siteUrl: 'sc-domain:example.org',
      connection: 'search',
      refreshHoursByGroup: { totals: 24, pages: 72 },
    },
  ]);
  assert.deepEqual(config.resources[0]?.refreshHoursByGroup, { repository: 168, releases: 1 });
  assert.deepEqual(config.resources[2]?.refreshHoursByGroup, { totals: 24, pages: 72 });

  // An empty map is a no-op, not an error: generated configurations may emit it.
  assert.deepEqual(
    refreshPolicy(portfolio([repo({ refreshHoursByGroup: {} })]).resources[0]!, 'views'),
    { refreshHours: 24, refreshPolicy: 'default' },
  );
  // Omitted stays omitted: an existing configuration parses to the same value.
  const legacy = portfolio([repo({ refreshHours: 48 }), pkg('alpha')]);
  assert.equal(legacy.resources[0]?.refreshHoursByGroup, undefined);
  assert.equal('refreshHoursByGroup' in legacy.resources[1]!, false);
  assert.equal(legacy.resources[0]?.refreshHours, 48);

  const refused: [Record<string, unknown>, RegExp][] = [
    // Not configured on this resource, although GitHub supports it.
    [repo({ refreshHoursByGroup: { clones: 24 } }), /must name groups this resource collects/],
    [repo({ refreshHoursByGroup: { stars: 24 } }), /must name groups this resource collects/],
    [
      pkg('alpha', { refreshHoursByGroup: { views: 24 } }),
      /must name groups this resource collects/,
    ],
    // Queries are off by default, so there is no such dataset to schedule.
    [
      {
        id: 'site',
        provider: 'gsc',
        siteUrl: 'sc-domain:example.org',
        connection: 'search',
        refreshHoursByGroup: { queries: 24 },
      },
      /must name groups this resource collects/,
    ],
    [repo({ refreshHoursByGroup: { views: 0 } }), /Invalid project configuration/],
    [repo({ refreshHoursByGroup: { views: 721 } }), /Invalid project configuration/],
    [repo({ refreshHoursByGroup: { views: 1.5 } }), /Invalid project configuration/],
    [repo({ refreshHoursByGroup: { views: '24' } }), /Invalid project configuration/],
    [repo({ refreshHoursByGroup: { views: null } }), /Invalid project configuration/],
    [repo({ refreshHoursByGroup: { 'Views!': 24 } }), /Invalid project configuration/],
    [repo({ refreshHoursByGroup: [24] }), /Invalid project configuration/],
    [repo({ refreshHoursByGroup: 24 }), /Invalid project configuration/],
  ];
  for (const [resource, message] of refused)
    assert.throws(() => portfolio([resource]), message, JSON.stringify(resource));
});

test('a group interval wins over the resource interval, which wins over the 24-hour default', () => {
  const config = portfolio([
    repo({ refreshHours: 12, refreshHoursByGroup: { repository: 168, releases: 1 } }),
    pkg('alpha'),
    pkg('beta', { refreshHours: 48 }),
  ]);
  const [github, alpha, beta] = config.resources as [Resource, Resource, Resource];
  assert.deepEqual(refreshPolicy(github, 'repository'), {
    refreshHours: 168,
    refreshPolicy: 'group',
  });
  assert.deepEqual(refreshPolicy(github, 'releases'), { refreshHours: 1, refreshPolicy: 'group' });
  assert.deepEqual(refreshPolicy(github, 'views'), { refreshHours: 12, refreshPolicy: 'resource' });
  assert.deepEqual(refreshPolicy(alpha, 'downloads'), {
    refreshHours: 24,
    refreshPolicy: 'default',
  });
  assert.deepEqual(refreshPolicy(beta, 'downloads'), {
    refreshHours: 48,
    refreshPolicy: 'resource',
  });
  // Inherited object members are not group entries.
  assert.deepEqual(refreshPolicy(github, 'constructor'), {
    refreshHours: 12,
    refreshPolicy: 'resource',
  });
  // Library callers can bypass parseConfig; the selector validates again.
  for (const invalid of [0, 721, 1.5, Number.NaN]) {
    assert.throws(
      () => refreshPolicy({ ...github, refreshHoursByGroup: { views: invalid } }, 'views'),
      /Invalid per-group refresh interval/,
    );
    assert.throws(
      () => refreshPolicy({ ...alpha, refreshHours: invalid }, 'downloads'),
      /Invalid per-resource refresh interval/,
    );
  }
});

test('groups of one resource become due on their own intervals', () => {
  const github = portfolio([
    repo({ refreshHours: 12, refreshHoursByGroup: { repository: 168, releases: 1 } }),
  ]).resources[0]!;
  const jobs = datasets(github, ['repository', 'views', 'releases']);
  // All three succeeded six hours ago.
  const at = '2026-11-13T06:00:00Z';
  const heads = (stamp: string) => {
    const runs = ['repository', 'views', 'releases'].map((g) => run('repo', g, 'success', stamp));
    return { latest: runs, successful: runs };
  };
  const dueAt = (clock: Date) => dueJobs(jobs, heads(at), clock).map((j) => j.group);
  assert.deepEqual(dueAt(new Date('2026-11-13T06:59:59Z')), []);
  assert.deepEqual(dueAt(now), ['releases']);
  assert.deepEqual(dueAt(new Date('2026-11-13T18:00:00Z')), ['releases', 'views']);
  assert.deepEqual(dueAt(new Date('2026-11-20T05:59:59Z')), ['releases', 'views']);
  assert.deepEqual(dueAt(new Date('2026-11-20T06:00:00Z')), ['releases', 'views', 'repository']);
  const [first] = dueJobs(jobs, heads(at), now);
  assert.deepEqual(
    [first?.refreshHours, first?.refreshPolicy, first?.reason, first?.dueAt],
    [1, 'group', 'refresh_due', Date.parse(at) + HOUR],
  );

  // Without group entries the same resource behaves exactly as before.
  const plain = portfolio([repo({ refreshHours: 12 })]).resources[0]!;
  const plainJobs = datasets(plain, ['repository', 'views', 'releases']);
  assert.deepEqual(dueJobs(plainJobs, heads(at), now), []);
  assert.deepEqual(
    dueJobs(plainJobs, heads(at), new Date('2026-11-13T18:00:00Z')).map((j) => [
      j.group,
      j.refreshHours,
      j.refreshPolicy,
    ]),
    [
      ['releases', 12, 'resource'],
      ['repository', 12, 'resource'],
      ['views', 12, 'resource'],
    ],
  );
});

test('a long group interval survives midnight and ignores older backfills', () => {
  const alpha = portfolio([
    pkg('alpha', { refreshHours: 1, refreshHoursByGroup: { downloads: 72 } }),
  ]).resources[0]!;
  const jobs = datasets(alpha, ['downloads']);
  const yesterday = run(
    'alpha',
    'downloads',
    'success',
    '2026-11-12T23:30:00Z',
    null,
    '2026-11-11',
  );
  assert.deepEqual(
    dueJobs(
      jobs,
      { latest: [yesterday], successful: [yesterday] },
      new Date('2026-11-13T00:10:00Z'),
    ),
    [],
  );
  // A backfill that ended days before its own execution is not a refresh.
  const backfill = run('alpha', 'downloads', 'success', '2026-11-13T11:45:00Z', null, '2026-11-01');
  assert.equal(
    dueJobs(jobs, { latest: [backfill], successful: [backfill] }, now)[0]?.reason,
    'never_collected',
  );
});

test('fixed failure backoff and in-flight grace do not depend on the group interval', () => {
  const alpha = portfolio([pkg('alpha', { refreshHoursByGroup: { downloads: 1 } })]).resources[0]!;
  const jobs = datasets(alpha, ['downloads']);
  const ok = run('alpha', 'downloads', 'success', '2026-11-13T09:00:00Z');
  const denied = run('alpha', 'downloads', 'failed', '2026-11-13T11:00:00Z', 'PERMISSION');
  // The one-hour interval has passed, yet a denied permission still waits 24 hours.
  assert.deepEqual(dueJobs(jobs, { latest: [denied], successful: [ok] }, now), []);
  assert.equal(
    dueJobs(jobs, { latest: [denied], successful: [ok] }, new Date('2026-11-14T11:00:00Z'))[0]
      ?.reason,
    'retry_due',
  );
  const running = run('alpha', 'downloads', 'running', '2026-11-13T11:30:00Z');
  assert.deepEqual(dueJobs(jobs, { latest: [running], successful: [ok] }, now), []);
});

test('Retry-After parsing returns one bounded integer or nothing', () => {
  const at = Date.parse('2026-11-13T12:00:00Z');
  const read = (headers: Record<string, string>, github = false) =>
    retryAfterSeconds(new Headers(headers), at, github);
  assert.equal(read({ 'retry-after': '120' }), 120);
  assert.equal(read({ 'retry-after': ' 7 ' }), 7);
  assert.equal(read({ 'retry-after': '999999999' }), 999999999);
  assert.equal(read({ 'retry-after': 'Fri, 13 Nov 2026 12:30:00 GMT' }), 1800);
  // A stated wait is never shortened: 2, 10, 31 and 90 days are kept whole.
  assert.equal(read({ 'retry-after': '172800' }), 172800);
  assert.equal(read({ 'retry-after': 'Mon, 23 Nov 2026 12:00:00 GMT' }), 864000);
  assert.equal(read({ 'retry-after': '2678400' }), 31 * 86400);
  assert.equal(read({ 'retry-after': 'Thu, 11 Feb 2027 12:00:00 GMT' }), 90 * 86400);
  assert.equal(read({ 'retry-after': '999999999999999' }), 999999999999999);
  // More digits than an exact integer holds: unbounded, not dropped.
  assert.equal(read({ 'retry-after': '9999999999999999' }), Number.POSITIVE_INFINITY);
  assert.equal(read({ 'retry-after': '1' + '0'.repeat(400) }), Number.POSITIVE_INFINITY);
  // The stored instant is the failure plus the wait, held only at the last
  // instant a timestamp can name.
  assert.equal(retryNotBefore(at, 90 * 86400).toISOString(), '2027-02-11T12:00:00.000Z');
  assert.equal(RETRY_HOLD_INSTANT, Date.parse('9999-12-31T23:59:59.999Z'));
  for (const beyond of [999999999999999, Number.POSITIVE_INFINITY])
    assert.equal(retryNotBefore(at, beyond).getTime(), RETRY_HOLD_INSTANT);
  for (const ignored of [
    '',
    '0',
    '-5',
    '1.5',
    '1e3',
    '0x10',
    'soon',
    'Fri, 13 Nov 2026 11:59:00 GMT', // already past
    '2026-11-13T12:30:00Z', // not an HTTP date
    '13 Nov 2026 12:30:00',
    'Fri, 13 Nov 2026 12:30:00 GMT; https://example.invalid/?token=secret',
  ])
    assert.equal(read({ 'retry-after': ignored }), undefined, ignored);
  assert.equal(read({}), undefined);

  // GitHub's reset instant counts only for GitHub and only at zero remaining.
  const reset = String(at / 1000 + 900);
  assert.equal(read({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), undefined);
  assert.equal(read({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, true), 900);
  assert.equal(read({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': reset }, true), undefined);
  assert.equal(
    read({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'later' }, true),
    undefined,
  );
  assert.equal(
    read({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(at / 1000 - 5) }, true),
    undefined,
  );
  // Both present: the longer wait.
  assert.equal(
    read({ 'retry-after': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, true),
    900,
  );
  assert.equal(
    read({ 'retry-after': '3600', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, true),
    3600,
  );
  assert.equal(validRetryAfter(0.2), 1);
  assert.equal(validRetryAfter(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  assert.equal(validRetryAfter(Number.NaN), undefined);
  assert.equal(validRetryAfter(Number.NEGATIVE_INFINITY), undefined);
});

test('the HTTP client attaches a bounded wait to every rate-limit failure and to nothing else', async () => {
  const failure = async (response: () => Response, retryRateLimits: boolean, url: string) => {
    const client = new HttpClient(
      async () => response(),
      1000,
      async () => undefined,
      undefined,
      undefined,
      retryRateLimits,
    );
    try {
      await client.json(url);
    } catch (error) {
      assert.ok(error instanceof PulseError);
      return error;
    }
    throw new Error('Expected a provider failure.');
  };
  const npm = 'https://api.npmjs.org/downloads/range/2026-11-01:2026-11-02/alpha';
  const github = 'https://api.github.com/repos/example/project';
  const status =
    (code: number, headers: Record<string, string> = {}) =>
    () =>
      new Response('{}', { status: code, headers });

  // Free profile: no in-job retry.
  let error = await failure(status(429, { 'retry-after': '7200' }), false, npm);
  assert.deepEqual([error.code, error.retryAfterSeconds], ['RATE_LIMIT', 7200]);
  error = await failure(status(429), false, npm);
  assert.deepEqual([error.code, error.retryAfterSeconds], ['RATE_LIMIT', undefined]);
  // Default profile: a long wait is handed to the scheduler.
  error = await failure(status(429, { 'retry-after': '300' }), true, npm);
  assert.deepEqual([error.code, error.retryAfterSeconds], ['RATE_LIMIT', 300]);
  error = await failure(status(503, { 'retry-after': '90' }), true, npm);
  assert.deepEqual([error.code, error.retryAfterSeconds], ['RATE_LIMIT', 90]);
  // An HTTP-date wait defers at once, like a numeric one: one request, no sleep.
  const inTwoHours = new Date(Date.now() + 2 * HOUR).toUTCString();
  for (const code of [429, 503]) {
    let requests = 0;
    const client = new HttpClient(
      async () => {
        requests++;
        return new Response('{}', { status: code, headers: { 'retry-after': inTwoHours } });
      },
      1000,
      async () => {
        throw new Error('Should not sleep');
      },
    );
    await assert.rejects(client.json(npm), (failed: unknown) => {
      assert.ok(failed instanceof PulseError);
      assert.equal(failed.code, 'RATE_LIMIT');
      assert.ok(failed.retryAfterSeconds! > 7190 && failed.retryAfterSeconds! <= 7200);
      return true;
    });
    assert.equal(requests, 1, String(code));
  }
  // A date already past is no guidance: the usual bounded in-job retries run.
  let attempts = 0;
  const past = new HttpClient(
    async () => {
      attempts++;
      return new Response('{}', {
        status: 429,
        headers: { 'retry-after': 'Fri, 13 Nov 2026 11:00:00 GMT' },
      });
    },
    1000,
    async () => undefined,
  );
  await assert.rejects(past.json(npm), /rate limit exceeded/);
  assert.equal(attempts, 3);
  // Short waits are retried in the job; the last 429 still reports its header.
  error = await failure(status(429, { 'retry-after': '2' }), true, npm);
  assert.deepEqual([error.code, error.retryAfterSeconds], ['RATE_LIMIT', 2]);
  // GitHub quota as 403, with the reset instant only.
  const reset = String(Math.floor(Date.now() / 1000) + 1800);
  error = await failure(
    status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
    true,
    github,
  );
  assert.equal(error.code, 'RATE_LIMIT');
  assert.ok(error.retryAfterSeconds! > 1790 && error.retryAfterSeconds! <= 1800);
  // Other failures never carry a wait, whatever the headers say.
  error = await failure(status(403, { 'x-ratelimit-reset': reset }), true, github);
  assert.deepEqual([error.code, error.retryAfterSeconds], ['PERMISSION', undefined]);
  error = await failure(status(401, { 'retry-after': '60' }), true, npm);
  assert.deepEqual([error.code, error.retryAfterSeconds], ['AUTH', undefined]);
  error = await failure(status(404, { 'retry-after': '60' }), true, npm);
  assert.deepEqual([error.code, error.retryAfterSeconds], ['NOT_FOUND', undefined]);
});

function packages(extra: Record<string, unknown> = {}): Config {
  return portfolio([pkg('alpha', extra), pkg('beta')]);
}
/** alpha answers 429 with the given headers; every other package succeeds. */
function npmFetcher(headers: () => Record<string, string> | null) {
  const requested: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const match = /^\/downloads\/range\/(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(
      new URL(String(input)).pathname,
    );
    assert.ok(match);
    const [, from, to, name] = match as unknown as [string, string, string, string];
    requested.push(name);
    const limited = name === 'alpha' ? headers() : null;
    if (limited) return new Response('{}', { status: 429, headers: limited });
    const downloads: { day: string; downloads: number }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) downloads.push({ day: d, downloads: 1 });
    return Response.json({ start: from, end: to, package: name, downloads });
  };
  return { fetcher, requested };
}
const retryRows = async (store: Awaited<ReturnType<typeof database>>) =>
  (
    await store.driver.all<{ key: string; value: string }>({
      sql: "SELECT key,value FROM metadata WHERE key LIKE 'scheduler_retry:%' ORDER BY key",
    })
  ).map(({ key, value }) => ({ key, value }));

test('due-time sync stores a provider wait and defers exactly that dataset', async () => {
  const config = packages();
  const store = await database(config);
  let headers: Record<string, string> | null = { 'retry-after': '7200' };
  const { fetcher, requested } = npmFetcher(() => headers);
  const start = new Date();
  const options = { dueOnly: true, maxJobs: 1, now: start, fetcher, retryRateLimits: false };
  try {
    const [failed] = await sync(config, store, {}, options);
    assert.deepEqual(
      [failed?.resourceId, failed?.status, failed?.code],
      ['alpha', 'failed', 'RATE_LIMIT'],
    );
    const heads = await store.regularRunHeads();
    const head = heads.latest.find((r) => r.resourceId === 'alpha')!;
    const failedAt = Date.parse(head.finishedAt!);
    assert.equal(failed?.retryNotBefore, new Date(failedAt + 7200000).toISOString());
    assert.deepEqual(heads.retryGuidance, [
      { dataset: 'alpha:downloads', runId: head.id, notBefore: failed!.retryNotBefore! },
    ]);
    // The stored value is the run identifier and one instant: no header text.
    assert.deepEqual(await retryRows(store), [
      {
        key: 'scheduler_retry:alpha:downloads',
        value: JSON.stringify({ run: head.id, notBefore: failed!.retryNotBefore }),
      },
    ]);

    const alpha = datasets(config.resources[0]!, ['downloads']);
    const dueAfter = (ms: number, source = heads) =>
      dueJobs(alpha, source, new Date(failedAt + ms)).map((j) => j.reason);
    // The fixed one-hour rate-limit backoff alone would release it here.
    assert.deepEqual(dueAfter(HOUR + 60000), []);
    assert.deepEqual(dueAfter(2 * HOUR - 1), []);
    assert.deepEqual(dueAfter(2 * HOUR), ['retry_due']);
    // Heads without stored guidance keep the previous fixed backoff.
    const { retryGuidance: _dropped, ...legacyHeads } = heads;
    assert.deepEqual(
      dueJobs(alpha, legacyHeads, new Date(failedAt + HOUR)).map((j) => j.reason),
      ['retry_due'],
    );

    // The other package is unaffected: no shared or provider-wide deferral.
    const [second] = await sync(config, store, {}, options);
    assert.deepEqual([second?.resourceId, second?.status], ['beta', 'success']);
    assert.equal('retryNotBefore' in second!, false);
    assert.deepEqual(await sync(config, store, {}, options), []);
    assert.deepEqual(
      await sync(config, store, {}, { ...options, now: new Date(failedAt + HOUR + 60000) }),
      [],
    );
    assert.deepEqual(requested, ['alpha', 'beta']);

    // Once the wait passes the dataset is retried; a later failure without a
    // header leaves the old row inert and falls back to the fixed backoff.
    headers = {};
    const later = new Date(failedAt + 2 * HOUR);
    const [again] = await sync(config, store, {}, { ...options, now: later });
    assert.deepEqual([again?.resourceId, again?.code], ['alpha', 'RATE_LIMIT']);
    assert.equal('retryNotBefore' in again!, false);
    const stale = await store.regularRunHeads();
    const newest = stale.latest.find((r) => r.resourceId === 'alpha')!;
    assert.notEqual(newest.id, head.id);
    assert.equal(stale.retryGuidance[0]?.runId, head.id);
    const newestFailedAt = Date.parse(newest.finishedAt!);
    assert.deepEqual(dueJobs(alpha, stale, new Date(newestFailedAt + HOUR - 1)), []);
    assert.deepEqual(
      dueJobs(alpha, stale, new Date(newestFailedAt + HOUR)).map((j) => j.reason),
      ['retry_due'],
    );

    // Success then clears the way: a regular refresh interval applies again.
    headers = null;
    const recovered = new Date(newestFailedAt + HOUR);
    const [ok] = await sync(config, store, {}, { ...options, now: recovered });
    assert.deepEqual([ok?.resourceId, ok?.status], ['alpha', 'success']);
    assert.deepEqual(await sync(config, store, {}, { ...options, now: recovered }), []);
  } finally {
    store.driver.close?.();
  }
});

test('a provider wait lengthens the fixed backoff and is never shortened', async () => {
  const cases: [Record<string, string>, number][] = [
    [{ 'retry-after': '30' }, HOUR], // shorter than the fixed hour: the hour stands
    [{ 'retry-after': '172800' }, 48 * HOUR], // two days
    [{ 'retry-after': '2678400' }, 31 * 24 * HOUR], // 31 days
    [{ 'retry-after': '7776000' }, 90 * 24 * HOUR], // 90 days
    [{ 'retry-after': 'tomorrow' }, HOUR], // unparsable: nothing stored
  ];
  for (const [headers, expected] of cases) {
    const config = packages();
    const store = await database(config);
    const { fetcher } = npmFetcher(() => headers);
    try {
      const [failed] = await sync(
        config,
        store,
        {},
        { dueOnly: true, maxJobs: 1, now: new Date(), fetcher, retryRateLimits: false },
      );
      assert.equal(failed?.code, 'RATE_LIMIT');
      const heads = await store.regularRunHeads();
      const failedAt = Date.parse(heads.latest[0]!.finishedAt!);
      assert.equal(heads.retryGuidance.length, headers['retry-after'] === 'tomorrow' ? 0 : 1);
      const alpha = datasets(config.resources[0]!, ['downloads']);
      assert.deepEqual(dueJobs(alpha, heads, new Date(failedAt + expected - 1)), []);
      assert.equal(dueJobs(alpha, heads, new Date(failedAt + expected)).length, 1);
    } finally {
      store.driver.close?.();
    }
  }
});

test('stored guidance applies to its own run only; unreadable rows fall back to the fixed delay', async () => {
  const config = packages();
  const store = await database(config);
  const alpha = datasets(config.resources[0]!, ['downloads']);
  try {
    const failed = run('alpha', 'downloads', 'failed', '2026-11-13T11:00:00Z', 'RATE_LIMIT');
    const base = { latest: [failed], successful: [] };
    const at = (iso: string) => new Date(iso);
    const hint = (extra: Record<string, string>) => ({
      dataset: 'alpha:downloads',
      runId: failed.id,
      notBefore: '2026-11-13T15:00:00Z',
      ...extra,
    });
    // Honored for the exact run.
    assert.deepEqual(dueJobs(alpha, { ...base, retryGuidance: [hint({})] }, now), []);
    assert.equal(
      dueJobs(alpha, { ...base, retryGuidance: [hint({})] }, at('2026-11-13T15:00:00Z')).length,
      1,
    );
    // Another run, another dataset, or an unreadable instant: fixed backoff.
    for (const ignored of [
      hint({ runId: 'someone-else' }),
      hint({ dataset: 'beta:downloads' }),
      hint({ notBefore: 'never' }),
    ])
      assert.equal(dueJobs(alpha, { ...base, retryGuidance: [ignored] }, now).length, 1);
    // A far instant is honored whole, and the hold instant never comes due.
    const parked = { ...base, retryGuidance: [hint({ notBefore: '2099-01-01T00:00:00Z' })] };
    assert.deepEqual(dueJobs(alpha, parked, at('2098-12-31T23:59:59Z')), []);
    assert.equal(dueJobs(alpha, parked, at('2099-01-01T00:00:00Z')).length, 1);
    const held = { ...base, retryGuidance: [hint({ notBefore: '9999-12-31T23:59:59.999Z' })] };
    assert.deepEqual(dueJobs(alpha, held, at('9000-01-01T00:00:00Z')), []);
    // Unresolved history is never reported as due, whatever the heads say.
    assert.deepEqual(
      dueJobs(alpha, { latest: [], successful: [], unresolved: ['alpha:downloads'] }, now),
      [],
    );
    assert.equal(
      dueJobs(alpha, { latest: [], successful: [], unresolved: ['beta:downloads'] }, now)[0]
        ?.reason,
      'never_collected',
    );
    // Guidance never applies to a different failure class or to a success.
    const denied = { ...failed, code: 'NETWORK' };
    assert.equal(
      dueJobs(alpha, { latest: [denied], successful: [], retryGuidance: [hint({})] }, now).length,
      1,
    );

    // The store drops rows it cannot read instead of failing the scheduler.
    for (const [key, value] of [
      ['scheduler_retry:alpha:downloads', 'not json'],
      ['scheduler_retry:beta:downloads', '{"run":7,"notBefore":"2026-11-13T15:00:00Z"}'],
      ['scheduler_retry:gamma:downloads', '{"run":"x","notBefore":"soon"}'],
      ['scheduler_retry:delta:downloads', 'null'],
      ['scheduler_retry;outside', '{"run":"x","notBefore":"2026-11-13T15:00:00Z"}'],
      ['scheduler_cursor:*:*:*', '1'],
      ['scheduler_retry:valid:downloads', '{"run":"x","notBefore":"2026-11-13T15:00:00Z"}'],
    ] as const)
      await store.setSetting(key, value);
    assert.deepEqual((await store.regularRunHeads()).retryGuidance, [
      { dataset: 'valid:downloads', runId: 'x', notBefore: '2026-11-13T15:00:00Z' },
    ]);
  } finally {
    store.driver.close?.();
  }
});

test('guidance is written only by the call that fails a running run', async () => {
  const config = packages();
  const store = await database(config);
  const resource = config.resources[0]!;
  const window = { from: '2026-11-06', to: '2026-11-12' };
  const retry = { dataset: 'alpha:downloads', notBefore: new Date('2026-11-13T15:00:00Z') };
  try {
    const id = await store.begin(resource, 'downloads', window, now);
    await store.fail(id, 'NETWORK', 'Synthetic first failure', 1, new Date('2026-11-13T12:01:00Z'));
    // The run is already closed: neither the run nor the scheduler row changes.
    await store.fail(
      id,
      'RATE_LIMIT',
      'Synthetic late failure',
      1,
      new Date('2026-11-13T12:02:00Z'),
      'failed',
      retry,
    );
    assert.deepEqual(await retryRows(store), []);
    assert.equal((await store.runHeads()).latest[0]?.code, 'NETWORK');

    const next = await store.begin(resource, 'downloads', window, new Date('2026-11-13T12:05:00Z'));
    await store.fail(
      next,
      'RATE_LIMIT',
      'Synthetic guided failure',
      1,
      new Date('2026-11-13T12:06:00Z'),
      'failed',
      retry,
    );
    // A repeated call, even with the same timestamp, cannot replace the wait.
    await store.fail(
      next,
      'RATE_LIMIT',
      'Synthetic repeated failure',
      1,
      new Date('2026-11-13T12:06:00Z'),
      'failed',
      { ...retry, notBefore: new Date('2026-11-14T09:00:00Z') },
    );
    assert.deepEqual((await store.regularRunHeads()).retryGuidance, [
      { dataset: 'alpha:downloads', runId: next, notBefore: '2026-11-13T15:00:00.000Z' },
    ]);
  } finally {
    store.driver.close?.();
  }
});

test('rotation and explicit windows keep their cursor and write no scheduler guidance', async () => {
  const config = packages();
  const store = await database(config);
  const { fetcher, requested } = npmFetcher(() => ({ 'retry-after': '7200' }));
  const options = { maxJobs: 1, now: new Date(), fetcher, retryRateLimits: false };
  const cursor = 'scheduler_cursor:*:*:*';
  try {
    const [first] = await sync(config, store, {}, { ...options, rotate: true });
    assert.deepEqual([first?.resourceId, first?.code], ['alpha', 'RATE_LIMIT']);
    assert.equal('retryNotBefore' in first!, false);
    assert.equal(await store.getSetting(cursor), '1');
    const [second] = await sync(config, store, {}, { ...options, rotate: true });
    assert.deepEqual([second?.resourceId, second?.status], ['beta', 'success']);
    assert.equal(await store.getSetting(cursor), '0');
    // Rotation returns to the failed dataset immediately, as it always did.
    const [third] = await sync(config, store, {}, { ...options, rotate: true });
    assert.deepEqual([third?.resourceId, third?.code], ['alpha', 'RATE_LIMIT']);
    assert.equal(await store.getSetting(cursor), '1');

    const [backfill] = await sync(
      config,
      store,
      {},
      { ...options, resourceId: 'alpha', window: { from: '2026-10-01', to: '2026-10-07' } },
    );
    assert.deepEqual([backfill?.resourceId, backfill?.code], ['alpha', 'RATE_LIMIT']);
    assert.equal('retryNotBefore' in backfill!, false);
    assert.deepEqual(await retryRows(store), []);
    assert.equal(await store.getSetting(cursor), '1');
    assert.deepEqual(requested, ['alpha', 'beta', 'alpha', 'alpha']);

    // Due-time mode leaves the rotation cursor where rotation left it.
    await sync(config, store, {}, { ...options, dueOnly: true });
    assert.equal(await store.getSetting(cursor), '1');
  } finally {
    store.driver.close?.();
  }
});

test('a newer borderline backfill cannot hide the regular head of a site-timezone source', async () => {
  const config = parseConfig({
    version: 1,
    settings: { lookbackDays: 7, maxRows: 100 },
    connections: [
      { id: 'p', provider: 'plausible', tokenEnv: 'P_TOKEN' },
      { id: 'search', provider: 'gsc', tokenEnv: 'GSC_TOKEN' },
    ],
    resources: [
      {
        id: 'site',
        provider: 'plausible',
        siteId: 'example.org',
        timezone: 'UTC',
        connection: 'p',
      },
      {
        id: 'search',
        provider: 'gsc',
        siteUrl: 'sc-domain:example.org',
        connection: 'search',
        collectPages: false,
      },
    ],
    projects: [
      {
        id: 'project',
        label: 'Project',
        resources: [{ resource: 'site' }, { resource: 'search' }],
      },
    ],
  });
  const store = await database(config);
  const [site, search] = config.resources as [Resource, Resource];
  const record = async (
    resource: Resource,
    group: string,
    to: string,
    startedAt: string,
    outcome: 'success' | 'RATE_LIMIT',
  ) => {
    const key = resource.id + ':' + group,
      owner = crypto.randomUUID(),
      window = { from: to, to },
      started = new Date(startedAt),
      finished = new Date(started.getTime() + 60000);
    const id = await store.begin(resource, group, window, started);
    if (outcome === 'success') {
      assert.equal(await store.acquire(key, owner), true);
      await store.publish(id, resource, group, collected(window, []), key, owner, 1, finished, 100);
      await store.release(key, owner);
    } else await store.fail(id, outcome, 'Synthetic quota failure', 1, finished);
    return id;
  };
  try {
    // Plausible in UTC: the regular run covers 12 November, the last complete day.
    const regular = await record(site, 'traffic', '2026-11-12', '2026-11-13T09:00:00Z', 'success');
    // A newer explicit window ending 11 November is inside the loose SQL band
    // but is not a refresh of the latest complete site day.
    const backfill = await record(site, 'traffic', '2026-11-11', '2026-11-13T10:00:00Z', 'success');
    // Search Console at 09:00 UTC is 01:00 Pacific on 13 November.
    const searchRegular = await record(
      search,
      'totals',
      '2026-11-12',
      '2026-11-13T09:00:00Z',
      'success',
    );
    const searchBackfill = await record(
      search,
      'totals',
      '2026-11-11',
      '2026-11-13T10:00:00Z',
      'RATE_LIMIT',
    );
    assert.equal(
      (await store.runHeads()).latest.find((r) => r.resourceId === 'site')?.id,
      backfill,
    );
    const heads = await store.regularRunHeads();
    const jobs = [
      { resource: site, group: 'traffic' },
      { resource: search, group: 'totals' },
    ];
    // Both were refreshed three hours ago on a 24-hour interval: nothing is due,
    // and the failed backfill adds no retry delay to the regular schedule.
    assert.deepEqual(dueJobs(jobs, heads, now), []);
    const tomorrow = dueJobs(jobs, heads, new Date('2026-11-14T09:01:00Z'));
    assert.deepEqual(
      tomorrow.map((j) => [j.resource.id, j.reason, j.dueAt]),
      [
        ['search', 'refresh_due', Date.parse('2026-11-14T09:01:00Z')],
        ['site', 'refresh_due', Date.parse('2026-11-14T09:01:00Z')],
      ],
    );
    // The store applied the exact source calendar: one regular head each.
    assert.deepEqual(
      heads.latest.map((r) => [r.resourceId, r.id]),
      [
        ['search', searchRegular],
        ['site', regular],
      ],
    );
    assert.deepEqual(
      heads.successful.map((r) => [r.resourceId, r.id]),
      [
        ['search', searchRegular],
        ['site', regular],
      ],
    );
    assert.deepEqual(heads.unresolved, []);
    assert.notEqual(backfill, searchBackfill);

    // More borderline windows than the first page: the scan pages on and still
    // finds the regular run. With `backfill` these make 255 newer rows, so the
    // regular run is the 256th and last row the bounded scan may read.
    const borderline = async (count: number, offset: number) =>
      store.driver.batch(
        Array.from({ length: count }, (_, i) => {
          const at = new Date(
            Date.parse('2026-11-13T10:00:01Z') + (offset + i) * 1000,
          ).toISOString();
          return {
            sql: "INSERT INTO runs(id,resource_id,group_id,from_day,to_day,status,started_at,finished_at) VALUES(?,?,?,?,?,'success',?,?)",
            params: [
              `borderline-${offset + i}`,
              'site',
              'traffic',
              '2026-11-11',
              '2026-11-11',
              at,
              at,
            ],
          };
        }),
      );
    await borderline(40, 0);
    const paged = await store.regularRunHeads();
    assert.equal(paged.latest.find((r) => r.resourceId === 'site')?.id, regular);
    assert.deepEqual(paged.unresolved, []);
    assert.deepEqual(dueJobs(jobs, paged, now), []);
    await borderline(214, 40);
    const edge = await store.regularRunHeads();
    assert.equal(edge.latest.find((r) => r.resourceId === 'site')?.id, regular);
    assert.equal(edge.successful.find((r) => r.resourceId === 'site')?.id, regular);
    assert.deepEqual(edge.unresolved, []);

    // One more and the scan stops undecided. That is reported as unresolved:
    // never as "never collected", and nothing is fetched.
    await borderline(1, 254);
    const overflow = await store.regularRunHeads();
    assert.deepEqual(overflow.unresolved, ['site:traffic']);
    assert.equal(
      overflow.latest.some((r) => r.resourceId === 'site'),
      false,
    );
    assert.equal(overflow.latest.find((r) => r.resourceId === 'search')?.id, searchRegular);
    assert.deepEqual(dueJobs(jobs, overflow, now), []);
    assert.deepEqual(
      dueJobs(jobs, overflow, new Date('2026-12-31T00:00:00Z')).map((j) => j.resource.id),
      ['search'],
    );
    const skipped = await sync(
      config,
      store,
      {},
      {
        dueOnly: true,
        maxJobs: 1,
        now,
        fetcher: async () => {
          throw new Error('An unresolved dataset must not be fetched.');
        },
      },
    );
    assert.deepEqual(
      skipped.map((r) => [r.resourceId, r.group, r.status, r.code, r.requests]),
      [['site', 'traffic', 'skipped', 'CONFLICT', 0]],
    );
    assert.match(skipped[0]!.message!, /ambiguous beyond the bounded scan/);

    // Any newer regular collection resolves it again.
    const recovered = await record(
      site,
      'traffic',
      '2026-11-12',
      '2026-11-13T11:00:00Z',
      'success',
    );
    const resolved = await store.regularRunHeads();
    assert.deepEqual(resolved.unresolved, []);
    assert.equal(resolved.latest.find((r) => r.resourceId === 'site')?.id, recovered);
    assert.deepEqual(dueJobs(jobs, resolved, now), []);
  } finally {
    store.driver.close?.();
  }
});

test('group intervals and a provider wait survive a private export and restore', async () => {
  const config = portfolio([
    {
      id: 'site',
      provider: 'gsc',
      siteUrl: 'sc-domain:example.org',
      connection: 'search',
      collectQueries: true,
      refreshHours: 48,
      refreshHoursByGroup: { totals: 6, pages: 24, queries: 72 },
    },
  ]);
  const original = await database(config);
  const restored = new Store(new SqliteDriver(':memory:'));
  const window = { from: '2026-11-06', to: '2026-11-12' };
  const totals = datasets(config.resources[0]!, ['totals']);
  try {
    // An archive without waits keeps its previous shape.
    assert.equal('retryGuidance' in (await original.export()), false);

    const id = await original.begin(config.resources[0]!, 'totals', window, now);
    await original.fail(id, 'RATE_LIMIT', 'Synthetic quota failure', 1, now, 'failed', {
      dataset: 'site:totals',
      notBefore: new Date('2026-11-15T12:00:00Z'),
    });
    // A row whose run is not a rate-limited failure of that dataset stays home.
    const other = await original.begin(config.resources[0]!, 'pages', window, now);
    await original.fail(other, 'NETWORK', 'Synthetic network failure', 1, now);
    await original.setSetting(
      'scheduler_retry:site:pages',
      JSON.stringify({ run: other, notBefore: '2026-11-15T12:00:00.000Z' }),
    );
    await original.setSetting(
      'scheduler_retry:site:queries',
      JSON.stringify({ run: id, notBefore: '2026-11-15T12:00:00.000Z' }),
    );
    const archive = await original.export();
    const wait = { dataset: 'site:totals', runId: id, notBefore: '2026-11-15T12:00:00.000Z' };
    assert.deepEqual(archive.retryGuidance, [wait]);

    await restored.migrate();
    // Tampered waits are refused before anything is written.
    const refused: unknown[] = [
      'not a list',
      [null],
      [{ ...wait, runId: 'unknown-run' }],
      [{ ...wait, runId: other, dataset: 'site:pages' }], // not a rate limit
      [{ ...wait, dataset: 'site:pages' }], // another dataset's run
      [{ ...wait, notBefore: '2026-11-13T11:59:59.000Z' }], // before the failure
      [{ ...wait, notBefore: '+010000-01-01T00:00:00.000Z' }], // past the hold instant
      [{ ...wait, notBefore: '15 Nov 2026 12:00 UTC' }],
      [{ ...wait, notBefore: 1 }],
      [wait, wait],
      [wait, wait, wait],
    ];
    for (const retryGuidance of refused)
      await assert.rejects(
        restored.import({ ...archive, retryGuidance }),
        /archived retry guidance/,
        JSON.stringify(retryGuidance),
      );
    assert.deepEqual(await restored.driver.all({ sql: 'SELECT id FROM resources' }), []);

    const identity = { sql: 'SELECT id,identity FROM resources' };
    await restored.import(archive);
    assert.deepEqual((await restored.getConfig())?.resources, config.resources);
    assert.deepEqual(await restored.driver.all(identity), await original.driver.all(identity));
    // The restored failure still waits for the provider's instant.
    const heads = await restored.regularRunHeads();
    assert.deepEqual(heads.retryGuidance, [wait]);
    assert.equal(heads.latest.find((r) => r.group === 'totals')?.id, id);
    assert.deepEqual(dueJobs(totals, heads, new Date('2026-11-15T11:59:59Z')), []);
    assert.equal(dueJobs(totals, heads, new Date('2026-11-15T12:00:00Z'))[0]?.reason, 'retry_due');
    assert.deepEqual(await restored.export().then((x) => x.retryGuidance), [wait]);

    // An archive written before this field existed restores as it always did.
    const legacy = new Store(new SqliteDriver(':memory:'));
    try {
      await legacy.migrate();
      const { retryGuidance: _absent, ...older } = archive;
      await legacy.import(older);
      assert.deepEqual((await legacy.regularRunHeads()).retryGuidance, []);
      assert.equal(dueJobs(totals, await legacy.regularRunHeads(), now).length, 0);
      assert.equal(
        dueJobs(totals, await legacy.regularRunHeads(), new Date('2026-11-13T13:00:00Z'))[0]
          ?.reason,
        'retry_due',
      );
    } finally {
      legacy.driver.close?.();
    }
  } finally {
    original.driver.close?.();
    restored.driver.close?.();
  }
});

test('an unrepresentable wait is an indefinite hold that doctor shows and an explicit sync lifts', async () => {
  const config = packages();
  const store = await database(config);
  let headers: Record<string, string> | null = { 'retry-after': '9'.repeat(40) };
  const { fetcher, requested } = npmFetcher(() => headers);
  const start = new Date();
  const due = { dueOnly: true, maxJobs: 2, now: start, fetcher, retryRateLimits: false };
  const state = async (clock: Date) =>
    (await doctor(config, store, {}, clock)).resources.find((r) => r.resourceId === 'alpha')!;
  try {
    const first = await sync(config, store, {}, due);
    assert.deepEqual(
      first.map((r) => [r.resourceId, r.status, r.retryNotBefore]),
      [
        ['alpha', 'failed', '9999-12-31T23:59:59.999Z'],
        ['beta', 'success', undefined],
      ],
    );
    // Not retried a day, a year or a millennium later.
    for (const later of ['2026-12-31T00:00:00Z', '2028-01-01T00:00:00Z', '3026-01-01T00:00:00Z']) {
      const results = await sync(config, store, {}, { ...due, now: new Date(later) });
      assert.equal(
        results.some((r) => r.resourceId === 'alpha'),
        false,
        later,
      );
    }
    assert.equal(requested.filter((name) => name === 'alpha').length, 1);
    // The operator can see the hold while that failure is the latest run.
    const held = await state(start);
    assert.deepEqual(
      [held.status, held.lastRun?.code, held.retryNotBefore],
      ['failed', 'RATE_LIMIT', '9999-12-31T23:59:59.999Z'],
    );
    const beta = (await doctor(config, store, {}, start)).resources.find(
      (r) => r.resourceId === 'beta',
    )!;
    assert.equal('retryNotBefore' in beta, false);

    // An explicit collection is the operator's decision and lifts the hold.
    headers = null;
    const [manual] = await sync(config, store, {}, { now: start, fetcher, resourceId: 'alpha' });
    assert.deepEqual([manual?.resourceId, manual?.status], ['alpha', 'success']);
    assert.equal('retryNotBefore' in (await state(start)), false);
    assert.deepEqual(await sync(config, store, {}, due), []);
    const nextDay = await sync(
      config,
      store,
      {},
      { ...due, now: new Date(Date.now() + 25 * HOUR) },
    );
    // Both are due again on the ordinary interval, oldest refresh first.
    assert.deepEqual(
      nextDay.map((r) => [r.resourceId, r.status]),
      [
        ['beta', 'success'],
        ['alpha', 'success'],
      ],
    );
  } finally {
    store.driver.close?.();
  }
});
