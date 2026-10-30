import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHistory, pendingHistory } from '../src/history.js';
import { sync } from '../src/sync.js';
import { addDays, daysBetween } from '../src/time.js';
import { database, fixture } from './helpers.js';

const now = new Date('2026-10-30T12:00:00Z');
const downloads = [{ resourceId: 'source', group: 'downloads' }];

function npmConfig(history: Record<string, unknown> | undefined, extra = {}) {
  return fixture('npm', { ...(history ? { history } : {}), ...extra });
}

test('history extends published coverage backwards in bounded chunks', () => {
  const config = npmConfig({ from: '2026-05-15', chunkDays: 120 });
  const [job] = pendingHistory(config, new Map([['source:downloads', '2026-10-02']]), {}, now);
  assert.equal(job?.window.to, '2026-10-01');
  assert.equal(daysBetween(job!.window.from, job!.window.to), 120);
  const [last] = pendingHistory(config, new Map([['source:downloads', '2026-05-20']]), {}, now);
  assert.deepEqual(last?.window, { from: '2026-05-15', to: '2026-05-19' });
  assert.deepEqual(
    pendingHistory(config, new Map([['source:downloads', '2026-05-15']]), {}, now),
    [],
    'coverage that reaches the start has nothing left to collect',
  );
});

test('history leaves unpublished, disabled and unselected datasets to the regular rotation', () => {
  const config = npmConfig({ from: '2026-05-15' });
  assert.deepEqual(pendingHistory(config, new Map(), {}, now), []);
  const disabled = npmConfig({ from: '2026-05-15' }, { enabled: false });
  assert.deepEqual(
    pendingHistory(disabled, new Map([['source:downloads', '2026-10-02']]), {}, now),
    [],
  );
  assert.deepEqual(
    pendingHistory(config, new Map([['source:downloads', '2026-10-02']]), {}, now, 'gsc'),
    [],
  );
  assert.deepEqual(
    pendingHistory(npmConfig(undefined), new Map([['source:downloads', '2026-10-02']]), {}, now),
    [],
  );
});

test('a stored budget override narrows only its own dataset', () => {
  const config = npmConfig({ from: '2026-01-01', chunkDays: 8 });
  const [job] = pendingHistory(
    config,
    new Map([['source:downloads', '2026-10-02']]),
    { 'source:downloads': 2, 'other:downloads': 1 },
    now,
  );
  assert.deepEqual(job?.window, { from: '2026-09-30', to: '2026-10-01' });
  assert.equal(job?.chunkDays, 2);
});

test('Search Console history stays inside the provider retention window', () => {
  const config = fixture('gsc', { history: { from: '2020-01-01', chunkDays: 7 } });
  const earliest = new Map(
    ['totals', 'pages'].map((group) => [`source:${group}`, addDays('2026-10-30', -478)] as const),
  );
  const jobs = pendingHistory(config, earliest, {}, now);
  assert.equal(jobs.length, 2);
  for (const job of jobs) assert.equal(job.window.from, addDays('2026-10-30', -480));
});

test('history is accepted only by sources that serve past dates on request', () => {
  for (const provider of ['github', 'cloudflare'])
    assert.throws(() => fixture(provider, { history: { from: '2026-01-01' } }));
  assert.throws(() => npmConfig({ from: '2026-01-01', chunkDays: 0 }));
  assert.throws(() => npmConfig({ from: '2026-02-30' }));
  const resource = npmConfig({ from: '2026-01-01' }).resources[0]!;
  assert.ok(resource.provider === 'npm' && resource.history?.chunkDays === 7);
});

function npmFetcher(requests: string[]) {
  return async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url.pathname);
    const [, start, end] = url.pathname.match(/\/range\/([0-9-]+):([0-9-]+)\//)!;
    const downloads = [];
    for (let day = start!; day <= end!; day = addDays(day, 1))
      downloads.push({ day, downloads: 3 });
    return Response.json({ package: '@example/package', start, end, downloads });
  };
}

test('collectHistory publishes older chunks through the regular path, then stops', async () => {
  const config = npmConfig({ from: '2026-10-10', chunkDays: 5 });
  const store = await database(config);
  const requests: string[] = [];
  const fetcher = npmFetcher(requests);
  await sync(config, store, {}, { now, fetcher, window: { from: '2026-10-20', to: '2026-10-29' } });
  const earliest = async () => (await store.earliestPublished(downloads))[0]?.date;
  assert.equal(await earliest(), '2026-10-20');
  const first = await collectHistory(config, store, {}, { now, fetcher });
  assert.equal(first.pending, 1);
  assert.equal(first.results[0]?.status, 'success');
  assert.equal(await earliest(), '2026-10-15');
  await collectHistory(config, store, {}, { now, fetcher });
  assert.equal(await earliest(), '2026-10-10');
  const done = await collectHistory(config, store, {}, { now, fetcher });
  assert.deepEqual(done, { pending: 0, results: [] });
  assert.equal(requests.length, 3, 'a finished history makes no provider request');
});

test('a budget failure halves later chunks for that dataset and keeps history', async () => {
  const config = npmConfig({ from: '2026-10-01', chunkDays: 8 });
  const store = await database(config);
  const requests: string[] = [];
  await sync(
    config,
    store,
    {},
    {
      now,
      fetcher: npmFetcher(requests),
      window: { from: '2026-10-20', to: '2026-10-29' },
    },
  );
  const failed = await collectHistory(
    config,
    store,
    {},
    {
      now,
      fetcher: npmFetcher(requests),
      maximumRows: 4,
    },
  );
  assert.equal(failed.results[0]?.code, 'ROW_LIMIT');
  assert.equal((await store.earliestPublished(downloads))[0]?.date, '2026-10-20');
  assert.equal(await store.getSetting('history_chunks'), JSON.stringify({ 'source:downloads': 4 }));
  const retried = await collectHistory(
    config,
    store,
    {},
    {
      now,
      fetcher: npmFetcher(requests),
      maximumRows: 4,
    },
  );
  assert.equal(retried.results[0]?.status, 'success');
  assert.equal((await store.earliestPublished(downloads))[0]?.date, '2026-10-16');
});
