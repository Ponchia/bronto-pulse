import test from 'node:test';
import assert from 'node:assert/strict';
import { D1HttpDriver } from '../src/storage/d1-http.js';
import { SqliteDriver } from '../src/storage/sqlite.js';
import type { Statement } from '../src/storage/driver.js';

const identifiers = {
  accountId: 'a'.repeat(32),
  databaseId: '00000000-0000-4000-8000-000000000001',
  apiToken: 'synthetic-private-operator-token',
};
test('operator D1 adapter uses one fixed-origin parameterized batch and preserves native scalar types', async () => {
  const native = new SqliteDriver(':memory:');
  const calls: RequestInit[] = [];
  try {
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://api.cloudflare.com/client/v4/accounts/' +
          identifiers.accountId +
          '/d1/database/' +
          identifiers.databaseId +
          '/query',
      );
      assert.equal(init?.redirect, 'error');
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer ' + identifiers.apiToken,
      );
      calls.push(init!);
      const body = JSON.parse(String(init!.body)) as { batch: Statement[] };
      try {
        const rows = await native.readBatch(body.batch);
        return Response.json({
          success: true,
          result: rows.map((results) => ({ success: true, results })),
        });
      } catch {
        return Response.json({ success: false, errors: [{ message: 'private SQL content' }] });
      }
    };
    const driver = new D1HttpDriver({ ...identifiers, fetcher });
    await driver.batch([{ sql: 'CREATE TABLE sample(id TEXT PRIMARY KEY,n REAL,empty TEXT)' }]);
    await driver.batch([
      { sql: 'INSERT INTO sample VALUES(?,?,?)', params: ["a'; DROP TABLE sample;--", 3.5, null] },
    ]);
    assert.deepEqual(await driver.all({ sql: 'SELECT * FROM sample' }), [
      { id: "a'; DROP TABLE sample;--", n: 3.5, empty: null },
    ]);
    const before = calls.length;
    assert.deepEqual(
      await driver.readBatch([
        { sql: 'SELECT n FROM sample' },
        { sql: 'SELECT count(*) AS total FROM sample' },
      ]),
      [[{ n: 3.5 }], [{ total: 1 }]],
    );
    assert.equal(calls.length, before + 1);
    await assert.rejects(
      driver.batch([
        { sql: "INSERT INTO sample VALUES('second',2,NULL)" },
        { sql: 'INSERT INTO missing_table VALUES(1)' },
      ]),
      /complete successful result/,
    );
    assert.deepEqual(await driver.all({ sql: 'SELECT count(*) AS total FROM sample' }), [
      { total: 1 },
    ]);
  } finally {
    native.close();
  }
});
test('D1 failures never echo SQL, provider bodies or credentials and uncertain writes are not retried', async () => {
  let calls = 0;
  const driver = new D1HttpDriver({
    ...identifiers,
    fetcher: async () => {
      calls++;
      throw new Error('private SQL token ' + identifiers.apiToken);
    },
  });
  await assert.rejects(
    driver.batch([{ sql: 'INSERT INTO private_table VALUES(?)', params: ['private-value'] }]),
    (error) => {
      const message = String(error);
      assert.match(message, /outcome is unknown/);
      assert.doesNotMatch(message, /private-value|private_table|synthetic-private/);
      return true;
    },
  );
  assert.equal(calls, 1);
  const denied = new D1HttpDriver({
    ...identifiers,
    fetcher: async () => new Response('private provider payload', { status: 403 }),
  });
  await assert.rejects(denied.all({ sql: 'SELECT 1' }), /rejected/);
});
test('D1 rejects malformed or incomplete batch responses and unsafe identifiers', async () => {
  for (const response of [
    { success: true, result: [] },
    { success: true, result: [{ success: false, results: [] }] },
    { success: true, result: [{ success: true, results: [null] }] },
    null,
  ]) {
    const driver = new D1HttpDriver({
      ...identifiers,
      fetcher: async () => Response.json(response),
    });
    await assert.rejects(driver.all({ sql: 'SELECT 1' }), /complete successful result/);
  }
  assert.throws(
    () => new D1HttpDriver({ ...identifiers, accountId: '../elsewhere' }),
    /identifiers/,
  );
  const driver = new D1HttpDriver({
    ...identifiers,
    fetcher: async () => {
      throw new Error('must not fetch');
    },
  });
  await assert.rejects(
    driver.batch(Array.from({ length: 101 }, () => ({ sql: 'SELECT 1' }))),
    /100 statements/,
  );
});
