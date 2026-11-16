import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stage } from '../scripts/stage-worker-config.mjs';

const fixture = () => ({
  version: 1,
  resources: Array.from({ length: 42 }, (_, index) => ({
    id: 'group' + index,
    provider: 'npm',
    package: '@example/public-package-' + index,
  })),
  projects: Array.from({ length: 42 }, (_, index) => ({
    id: 'group' + index,
    label: 'Group ' + index,
    resources: [{ resource: 'group' + index }],
  })),
});

test('atomic bundle retains Unicode JSON and checks each Cloudflare secret bound', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-chunks-'));
  try {
    const input = join(dir, 'private.json'),
      out = join(dir, 'stage');
    const config = fixture();
    config.name = 'Sítio pubblico — 空間 🌍';
    const raw = JSON.stringify(config, null, 2);
    assert.ok(Buffer.byteLength(raw) > 4096);
    writeFileSync(input, raw, { mode: 0o600 });
    const result = stage(input, out);
    const bundle = JSON.parse(readFileSync(result.destination, 'utf8'));
    assert.equal(statSync(result.destination).mode & 0o077, 0);
    assert.equal(statSync(out).mode & 0o077, 0);
    assert.equal(result.count, Object.keys(bundle).length - 1);
    const source = Array.from(
      { length: result.count },
      (_, i) => bundle['PULSE_CONFIG_PART_' + (i + 1)],
    ).join('');
    assert.equal(source, raw);
    assert.ok(
      Array.from({ length: result.count }, (_, i) => bundle['PULSE_CONFIG_PART_' + (i + 1)]).every(
        (part) => Buffer.byteLength(part, 'utf8') <= 4096,
      ),
    );
    assert.deepEqual(JSON.parse(bundle.PULSE_CONFIG_MANIFEST), {
      version: 1,
      parts: result.count,
      sha256: createHash('sha256').update(raw).digest('hex'),
    });
    assert.throws(() => stage(input, out), /EEXIST/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses non-private sources, symlinks and too-small configs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-chunks-'));
  try {
    const source = join(dir, 'input.json');
    writeFileSync(source, JSON.stringify(fixture()), { mode: 0o600 });
    chmodSync(source, 0o644);
    assert.throws(() => stage(source, join(dir, 'out1')), /private regular/);
    chmodSync(source, 0o600);
    const alias = join(dir, 'alias.json');
    symlinkSync(source, alias);
    assert.throws(() => stage(alias, join(dir, 'out2')), /private regular/);
    writeFileSync(
      source,
      JSON.stringify({
        version: 1,
        resources: [{ id: 'one', provider: 'npm', package: 'one' }],
        projects: [{ id: 'p', label: 'P', resources: [{ resource: 'one' }] }],
      }),
      { mode: 0o600 },
    );
    assert.throws(() => stage(source, join(dir, 'out3')), /2–8 pieces/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
