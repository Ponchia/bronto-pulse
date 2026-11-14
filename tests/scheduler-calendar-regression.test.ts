import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { database } from './helpers.js';
import { collected } from '../src/collectors/context.js';
import { dueJobs } from '../src/due-schedule.js';

test('a borderline timezone backfill cannot hide an older valid regular success', async () => {
  const config = parseConfig({
    version: 1,
    connections: [{ id: 'auth', provider: 'plausible', tokenEnv: 'TEST_TOKEN' }],
    resources: [
      {
        id: 'source',
        provider: 'plausible',
        siteId: 'example.invalid',
        timezone: 'UTC',
        connection: 'auth',
        refreshHours: 24,
      },
    ],
    projects: [{ id: 'project', label: 'Synthetic', resources: [{ resource: 'source' }] }],
  });
  const resource = config.resources[0]!;
  const store = await database(config);
  const key = 'source:traffic';
  const owner = crypto.randomUUID();
  try {
    assert.equal(await store.acquire(key, owner), true);
    for (const [at, day] of [
      ['2026-11-13T09:00:00Z', '2026-11-12'],
      ['2026-11-13T10:00:00Z', '2026-11-11'],
    ] as const) {
      const window = { from: day, to: day };
      const id = await store.begin(resource, 'traffic', window, new Date(at));
      await store.publish(
        id,
        resource,
        'traffic',
        collected(window, []),
        key,
        owner,
        1,
        new Date(at),
        100,
      );
    }
    const heads = await store.regularRunHeads();
    assert.deepEqual(
      dueJobs([{ resource, group: 'traffic' }], heads, new Date('2026-11-13T12:00:00Z')),
      [],
      'The November 12 regular collection succeeded three hours ago; a November 11 backfill cannot reset its 24-hour refresh policy',
    );
  } finally {
    await store.release(key, owner);
    store.driver.close?.();
  }
});
