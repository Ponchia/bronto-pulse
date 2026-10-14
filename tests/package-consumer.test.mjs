import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumerInstallation } from '../scripts/package-consumer-lock.mjs';
const manifest = {
  name: '@example/pulse',
  version: '0.1.0',
  license: 'MIT',
  dependencies: { zod: '4.6.7' },
};
const packed = { integrity: 'sha512-synthetic-fixture-digest' };
const source = {
  lockfileVersion: 3,
  packages: {
    '': { name: manifest.name },
    'node_modules/zod': {
      version: '4.6.7',
      resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.7.tgz',
      integrity: 'sha512-synthetic-runtime',
    },
    'node_modules/typescript': { version: '7.0.2', dev: true },
  },
};
test('offline consumer lock pins the exact local archive and runtime tarball integrity', () => {
  const { consumer, lock } = consumerInstallation(manifest, packed, '/tmp/pulse.tgz', source);
  assert.equal(consumer.private, true);
  assert.equal(consumer.dependencies[manifest.name], 'file:///tmp/pulse.tgz');
  assert.equal(lock.packages['node_modules/@example/pulse'].integrity, packed.integrity);
  assert.deepEqual(lock.packages['node_modules/zod'], source.packages['node_modules/zod']);
  assert.equal(lock.packages['node_modules/typescript'], undefined);
  assert.deepEqual(lock.packages[''].dependencies, consumer.dependencies);
});
test('consumer verification refuses a runtime dependency omitted from its source lock', () => {
  assert.throws(
    () =>
      consumerInstallation(
        { ...manifest, dependencies: { missing: '1.0.0' } },
        packed,
        '/tmp/pulse.tgz',
        source,
      ),
    /Missing locked runtime/,
  );
});
test('consumer verification refuses unverified archive metadata and unsupported lock versions', () => {
  assert.throws(
    () => consumerInstallation(manifest, {}, '/tmp/pulse.tgz', source),
    /integrity digest/,
  );
  assert.throws(
    () =>
      consumerInstallation(manifest, packed, '/tmp/pulse.tgz', { ...source, lockfileVersion: 2 }),
    /version-3/,
  );
});
