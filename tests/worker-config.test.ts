import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  workerConfigSource,
  verifyWorkerConfigSource,
  type WorkerConfigEnvironment,
} from '../src/worker-config.js';

const legacy = '{"version":1,"name":"Legacy","resources":[],"projects":[]}';
const raw =
  JSON.stringify({
    version: 1,
    resources: Array.from({ length: 16 }, (_, i) => ({ id: 'source-' + i })),
  }) + ' '.repeat(5500);
const splitAt = Math.floor(raw.length / 2);
const part1 = raw.slice(0, splitAt);
const part2 = raw.slice(splitAt);
const sha256 = (source: string) => createHash('sha256').update(source).digest('hex');
const manifest = (content: string) =>
  JSON.stringify({ version: 1, parts: 2, sha256: sha256(content) });
const fixture = (): WorkerConfigEnvironment => ({
  PULSE_CONFIG: legacy,
  PULSE_CONFIG_MANIFEST: manifest(raw),
  PULSE_CONFIG_PART_1: part1,
  PULSE_CONFIG_PART_2: part2,
});

test('legacy configuration remains authoritative while parts are staged without a manifest', async () => {
  const env = fixture();
  delete env.PULSE_CONFIG_MANIFEST;
  assert.deepEqual(workerConfigSource(env), { raw: legacy, expectedSha256: null });
  await verifyWorkerConfigSource(workerConfigSource(env));
});

test('a staged split source is reconstructed and verified before use', async () => {
  const source = workerConfigSource(fixture());
  assert.equal(source.raw, raw);
  assert.equal(source.expectedSha256, sha256(raw));
  await verifyWorkerConfigSource(source);
});

test('a stale or inconsistent chunk refuses without leaking values', async () => {
  const env = fixture();
  env.PULSE_CONFIG_PART_2 = part2 + 'private-secret-canary';
  const source = workerConfigSource(env);
  await assert.rejects(verifyWorkerConfigSource(source), (error: Error) => {
    assert.doesNotMatch(error.message, /canary|source|Legacy|private/);
    return error.message.includes('integrity');
  });
});

test('manifest is the only activation switch; missing or invalid layouts are refused', () => {
  const cases: WorkerConfigEnvironment[] = [
    {},
    { PULSE_CONFIG: '' },
    { ...fixture(), PULSE_CONFIG_MANIFEST: '' },
    { ...fixture(), PULSE_CONFIG_MANIFEST: '{"version":1,"parts":2}' },
    {
      ...fixture(),
      PULSE_CONFIG_MANIFEST: '{"version":2,"parts":2,"sha256":"' + 'a'.repeat(64) + '"}',
    },
    {
      ...fixture(),
      PULSE_CONFIG_MANIFEST: '{"version":1,"parts":1,"sha256":"' + 'a'.repeat(64) + '"}',
    },
    {
      ...fixture(),
      PULSE_CONFIG_MANIFEST: '{"version":1,"parts":9,"sha256":"' + 'a'.repeat(64) + '"}',
    },
    {
      ...fixture(),
      PULSE_CONFIG_MANIFEST: '{"version":1,"parts":2.5,"sha256":"' + 'a'.repeat(64) + '"}',
    },
    { ...fixture(), PULSE_CONFIG_MANIFEST: '{"version":1,"parts":2,"sha256":"INVALID"}' },
    { ...fixture(), PULSE_CONFIG_MANIFEST: manifest(raw) + 'x' },
    {
      ...fixture(),
      PULSE_CONFIG_MANIFEST:
        '{"version":1,"parts":2,"sha256":"' + sha256(raw) + '","insecure":true}',
    },
    { ...fixture(), PULSE_CONFIG_PART_1: '' },
    { ...fixture(), PULSE_CONFIG_PART_2: undefined },
    { ...fixture(), PULSE_CONFIG_PART_2: 'x'.repeat(4097) },
    { ...fixture(), PULSE_CONFIG_PART_2: '€'.repeat(1500) },
    { PULSE_CONFIG: 'x'.repeat(8 * 4096 + 1) },
  ];
  for (const [i, env] of cases.entries()) {
    assert.throws(
      () => workerConfigSource(env),
      (error: Error) => {
        assert.match(error.message, /configuration|layout/);
        assert.doesNotMatch(error.message, /canary|Legacy|source-0/);
        return true;
      },
      'rejected input ' + i,
    );
  }
});

test('one config may transition across manifests without accepting mixed parts', async () => {
  const a = fixture();
  await verifyWorkerConfigSource(workerConfigSource(a));
  const b = { ...a, PULSE_CONFIG_PART_1: 'changed' };
  await assert.rejects(verifyWorkerConfigSource(workerConfigSource(b)), /integrity/);
  const c = { ...b, PULSE_CONFIG_MANIFEST: manifest('changed' + part2) };
  await verifyWorkerConfigSource(workerConfigSource(c));
});

test('surplus old chunk is ignored after a shorter manifest transition', async () => {
  const env = { ...fixture(), PULSE_CONFIG_PART_3: 'old-stage-do-not-use' };
  const source = workerConfigSource(env);
  assert.equal(source.raw, raw);
  await verifyWorkerConfigSource(source);
});
