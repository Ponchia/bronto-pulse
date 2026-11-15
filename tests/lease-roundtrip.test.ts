import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import type { Statement } from '../src/storage/driver.js';

class Counted extends SqliteDriver {
  reads = 0;
  batches = 0;
  override async all<T extends Record<string, unknown>>(statement: Statement): Promise<T[]> {
    this.reads++;
    return super.all<T>(statement);
  }
  override async batch(statements: Statement[]): Promise<void> {
    this.batches++;
    return super.batch(statements);
  }
}

test('lease acquisition is atomic and uses one DB call without weakening ownership', async () => {
  const driver = new Counted(':memory:');
  const store = new Store(driver);
  try {
    await store.migrate();
    driver.reads = 0;
    driver.batches = 0;

    assert.equal(await store.acquire('dataset', 'owner-1'), true);
    assert.equal(driver.reads, 1);
    assert.equal(driver.batches, 0, 'acquire must not require a preceding write batch');
    assert.equal(await store.acquire('dataset', 'owner-2'), false);
    assert.equal(driver.reads, 2);
    assert.equal(driver.batches, 0);
    assert.equal(
      (
        await driver.all<{ owner: string }>({
          sql: 'SELECT owner FROM leases WHERE key=?',
          params: ['dataset'],
        })
      )[0]?.owner,
      'owner-1',
      'a denied contender must not replace the active lease',
    );
    await store.release('dataset', 'owner-2');
    assert.equal(await store.acquire('dataset', 'owner-3'), false);
    await store.release('dataset', 'owner-1');
    assert.equal(await store.acquire('dataset', 'owner-3'), true);
    await store.release('dataset', 'owner-3');

    assert.equal(await store.acquire('expired', 'owner-stale', -1), true);
    assert.equal(await store.acquire('expired', 'owner-new'), true);
    assert.equal(
      (
        await driver.all<{ owner: string }>({
          sql: 'SELECT owner FROM leases WHERE key=?',
          params: ['expired'],
        })
      )[0]?.owner,
      'owner-new',
    );
    await store.release('expired', 'owner-stale');
    assert.equal(await store.acquire('expired', 'owner-late'), false);
  } finally {
    driver.close();
  }
});
