import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleOptions } from '../src/worker-schedule.js';
import { parseConfig } from '../src/config.js';
import { selectCollectionJobs } from '../src/plan.js';
import worker, { type WorkerEnv } from '../src/worker.js';

test('scheduled provider selection is opt-in and retains the existing default bound', () => {
  assert.deepEqual(scheduleOptions({}), { maxJobs: 8 });
  assert.deepEqual(scheduleOptions({ PULSE_MAX_JOBS: '1' }), { maxJobs: 1 });
  for (const provider of ['github', 'npm', 'cloudflare', 'gsc', 'sense6'])
    assert.deepEqual(scheduleOptions({ PULSE_PROVIDER: provider, PULSE_MAX_JOBS: '32' }), {
      maxJobs: 32,
      provider,
    });
});

test('invalid scheduling values fail closed without echoing their values', () => {
  for (const max of ['0', '33', '-1', '1.2', '', 'Infinity', 'NaN'])
    assert.throws(() => scheduleOptions({ PULSE_MAX_JOBS: max }), /Invalid scheduled job bound/);
  for (const provider of ['', 'all', 'npm,github', 'NPM', ' npm', 'private-input']) {
    assert.throws(
      () => scheduleOptions({ PULSE_PROVIDER: provider }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Invalid scheduled provider selection.');
        return true;
      },
    );
  }
});

test('npm-only activation never schedules configured GitHub traffic jobs', () => {
  const config = parseConfig({
    version: 1,
    resources: [
      { id: 'repo', provider: 'github', repository: 'owner/repo' },
      { id: 'package', provider: 'npm', package: 'example' },
    ],
    projects: [
      {
        id: 'project',
        label: 'Example',
        resources: [{ resource: 'repo' }, { resource: 'package' }],
      },
    ],
  });
  const selected = selectCollectionJobs(config, scheduleOptions({ PULSE_PROVIDER: 'npm' }));
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.resource.id, 'package');
});

test('Worker rejects invalid scheduling controls before accessing configuration or D1', async () => {
  let accessed = 0;
  const env: WorkerEnv = {
    DB: {
      prepare() {
        accessed++;
        throw new Error('Unexpected D1 access');
      },
      async batch() {
        accessed++;
        return [];
      },
    },
    ASSETS: {
      async fetch() {
        return new Response('');
      },
    },
    PULSE_CONFIG: 'not valid private configuration',
    PULSE_API_TOKEN: '',
    PULSE_PROVIDER: 'private-input',
  };
  await assert.rejects(
    worker.scheduled({ scheduledTime: Date.now() }, env),
    /Invalid scheduled provider selection/,
  );
  assert.equal(accessed, 0);
});
