import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { sync } from '../src/sync.js';
import { projectReport } from '../src/report.js';
import { days } from '../src/time.js';
import { database } from './helpers.js';

function config(provider: 'plausible' | 'umami') {
  return parseConfig({
    version: 1,
    connections: [{ id: 'auth', provider, tokenEnv: 'TEST_TOKEN' }],
    resources: [
      {
        id: 'site',
        provider,
        connection: 'auth',
        ...(provider === 'plausible'
          ? { siteId: 'example.org', timezone: 'UTC' }
          : { websiteId: '00000000-0000-4000-8000-000000000001' }),
      },
    ],
    projects: [{ id: 'project', label: 'Project', resources: [{ resource: 'site' }] }],
  });
}
const secrets = { TEST_TOKEN: 'synthetic-provider-contract-test-token' };

test('a failed later Umami slice cannot publish the earlier slice or erase successful history', async () => {
  const c = config('umami');
  const store = await database(c);
  const window = { from: '2026-10-01', to: '2026-11-02' };
  const now = new Date('2026-11-13T12:00:00Z');
  let calls = 0;
  const response = (input: RequestInfo | URL, value: number) => {
    const u = new URL(String(input));
    const from = new Date(Number(u.searchParams.get('startAt'))).toISOString().slice(0, 10);
    const to = new Date(Number(u.searchParams.get('endAt'))).toISOString().slice(0, 10);
    return Response.json({
      pageviews: days({ from, to }).map((x) => ({ x, y: value })),
      sessions: days({ from, to }).map((x) => ({ x, y: 1 })),
    });
  };
  try {
    const first = await sync(c, store, secrets, {
      window,
      now,
      fetcher: async (input) => {
        calls++;
        return response(input, 2);
      },
    });
    assert.equal(first[0]?.status, 'success');
    assert.equal(calls, 2);
    const before = await projectReport(c, store, 'project', window, now);
    assert.equal(before.cards.find((card) => card.metric === 'umami.pageviews')?.value, 66);
    calls = 0;
    const failed = await sync(c, store, secrets, {
      window,
      now,
      fetcher: async (input) => {
        calls++;
        return calls === 1
          ? response(input, 999)
          : new Response('untrusted-secret-content', { status: 401 });
      },
    });
    assert.equal(failed[0]?.status, 'failed');
    assert.equal(failed[0]?.code, 'AUTH');
    assert.equal(calls, 2);
    assert.doesNotMatch(failed[0]?.message ?? '', /untrusted-secret-content/);
    const after = await projectReport(c, store, 'project', window, now);
    assert.deepEqual(after.cards, before.cards);
  } finally {
    store.driver.close?.();
  }
});

test('a contradictory Plausible executed query fails without replacing earlier observations', async () => {
  const c = config('plausible');
  const store = await database(c);
  const window = { from: '2026-10-12', to: '2026-10-13' };
  const now = new Date('2026-11-13T12:00:00Z');
  const payload = {
    results: days(window).map((date) => ({ dimensions: [date], metrics: [12, 3] })),
    meta: { imports_included: false },
  };
  try {
    assert.equal(
      (
        await sync(c, store, secrets, {
          window,
          now,
          fetcher: async () => Response.json(payload),
        })
      )[0]?.status,
      'success',
    );
    const before = await projectReport(c, store, 'project', window, now);
    const failed = await sync(c, store, secrets, {
      window,
      now,
      fetcher: async () =>
        Response.json({
          ...payload,
          query: {
            site_id: 'untrusted-secret-site.example.org',
            metrics: ['visitors', 'pageviews'],
            dimensions: ['time:day'],
            date_range: [window.from, window.to],
            filters: [],
          },
        }),
    });
    assert.equal(failed[0]?.status, 'failed');
    assert.equal(failed[0]?.code, 'SCHEMA');
    assert.doesNotMatch(failed[0]?.message ?? '', /untrusted-secret/);
    const after = await projectReport(c, store, 'project', window, now);
    assert.deepEqual(after.cards, before.cards);
  } finally {
    store.driver.close?.();
  }
});
