import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateJson } from '../src/visibility-cli.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-private-json-'));
  return {
    dir,
    path: join(dir, 'input.json'),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test('small JSON input does not preallocate its 100 MiB allowance', async (t) => {
  const f = await fixture();
  try {
    await writeFile(f.path, '{"value":1}');
    const allocations: number[] = [];
    const alloc = Buffer.alloc,
      unsafe = Buffer.allocUnsafe;
    t.mock.method(Buffer, 'alloc', (size: number) => {
      allocations.push(size);
      return alloc(size);
    });
    t.mock.method(Buffer, 'allocUnsafe', (size: number) => {
      allocations.push(size);
      return unsafe(size);
    });
    assert.deepEqual(await privateJson(f.path, 100 * 1024 * 1024), { value: 1 });
    assert.ok(allocations.every((size) => size <= 64 * 1024));
  } finally {
    await f.close();
  }
});

test('byte budget is exact across chunk boundaries and multibyte text', async () => {
  const f = await fixture();
  try {
    const value = { text: 'x'.repeat(65525) + 'é😀' };
    const encoded = JSON.stringify(value);
    await writeFile(f.path, encoded);
    const bytes = Buffer.byteLength(encoded);
    assert.deepEqual(await privateJson(f.path, bytes), value);
    await assert.rejects(privateJson(f.path, bytes - 1), { code: 'ROW_LIMIT' });
  } finally {
    await f.close();
  }
});

test('invalid UTF-8 and malformed JSON are refused without echoing private content', async () => {
  const f = await fixture();
  try {
    for (const bytes of [
      Buffer.from([123, 34, 255, 34, 58, 49, 125]),
      Buffer.from('private-data: invalid'),
    ]) {
      await writeFile(f.path, bytes);
      await assert.rejects(privateJson(f.path), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Contents were not echoed/);
        assert.doesNotMatch(error.message, /private-data/);
        return true;
      });
    }
    await assert.rejects(privateJson(f.dir), { code: 'CONFIG' });
    await assert.rejects(privateJson(f.path, 0), { code: 'CONFIG' });
  } finally {
    await f.close();
  }
});

test('a file growing after stat is read completely or refused, never truncated', async (t) => {
  const f = await fixture();
  const handle = await open(f.path, 'w+');
  const prototype = Object.getPrototypeOf(handle);
  const original = prototype.stat;
  await handle.close();
  let replacement = '{"value":2}';
  t.mock.method(prototype, 'stat', async function (this: object, ...args: unknown[]) {
    const info = await original.apply(this, args);
    await writeFile(f.path, replacement);
    return info;
  });
  try {
    await writeFile(f.path, '1');
    assert.deepEqual(await privateJson(f.path, 32), { value: 2 });
    await writeFile(f.path, '1');
    replacement = '1' + ' '.repeat(32);
    await assert.rejects(privateJson(f.path, 32), { code: 'ROW_LIMIT' });
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});
