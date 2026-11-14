import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, type LazyApiContext } from '../src/api/handler.js';
import { database, fixture, now } from './helpers.js';

const token = 'synthetic-query-token-long-enough';
function request(path: string, auth = true) {
  return new Request('https://pulse.example' + path, {
    headers: auth ? { Authorization: 'Bearer ' + token } : {},
  });
}
for (const path of [
  '/api/v1/projects/project/report?resource=unselected',
  '/api/v1/projects/project/report?from=2026-10-12&from=2026-10-13',
  '/api/v1/projects/project/report?format=json&format=csv',
  '/api/v1/plan?provider=npm',
  '/api/v1/export?resource=source',
  '/api/v1/health?from=2026-10-01',
  '/api/v1/projects/project/investigation?limit=5&unknown=true',
  '/api/v1/runs?limit=1e2',
  '/api/v1/projects/project/report?format=xml',
  '/api/v1/projects/project/report?days=2&from=2026-10-12',
  '/api/v1/projects/project/report?days=367',
]) {
  test(`API refuses ignored/ambiguous query before private data access: ${path}`, async () => {
    let loads = 0;
    const context: LazyApiContext = {
      apiToken: token,
      secrets: {},
      asset: async () => new Response('static'),
      now: () => now,
      loadData: async () => {
        loads++;
        throw new Error('must not load private state');
      },
    };
    const unauthorized = await handle(request(path, false), context);
    assert.equal(unauthorized.status, 401, 'authentication precedes input diagnostics');
    const response = await handle(request(path), context);
    assert.equal(response.status, 400, await response.text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(loads, 0);
  });
}

test('API days selection uses the same completed-day window as the CLI', async () => {
  const config = fixture('npm');
  const store = await database(config);
  try {
    const response = await handle(request('/api/v1/projects/project/report?days=2'), {
      config,
      store,
      apiToken: token,
      secrets: {},
      asset: async () => new Response('static'),
      now: () => now,
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).window, { from: '2026-10-12', to: '2026-10-13' });
  } finally {
    store.driver.close?.();
  }
});
