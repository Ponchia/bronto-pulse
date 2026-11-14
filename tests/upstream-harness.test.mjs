import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertCompleteTap } from '../scripts/upstream-result.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const summary = (patch = {}) =>
  Object.entries({
    tests: 12,
    pass: 12,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...patch,
  })
    .map(([name, value]) => `# ${name} ${value}`)
    .join('\n');

test('upstream acceptance requires an unambiguous complete passing TAP summary', () => {
  assert.equal(assertCompleteTap(summary()).tests, 12);
  for (const text of [
    '',
    '# tests 12',
    summary({ tests: 0, pass: 0 }),
    summary({ pass: 11 }),
    summary({ fail: 1 }),
    summary({ skipped: 1 }),
    summary({ todo: 1 }),
    summary({ cancelled: 1 }),
    summary() + '\n# pass 12',
    summary({ tests: '999999999999999999999999' }),
  ])
    assert.throws(() => assertCompleteTap(text));
});

test("a same-name Podman collision never authorizes deleting another run's objects", () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-upstream-contract-'));
  const log = join(dir, 'calls.log');
  const podman = join(dir, 'podman');
  writeFileSync(join(dir, 'curl'), '#!/bin/sh\nexit 87\n', { mode: 0o700 });
  writeFileSync(
    podman,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$PULSE_MOCK_LOG"
case "$1 $2" in
  "info --format") printf 'true\\n'; exit 0 ;;
  "container exists") exit 0 ;;
  "container inspect"|"network inspect") printf 'not-this-run\\n'; exit 0 ;;
  "ps -a"|"network ls") exit 0 ;;
  *) exit 87 ;;
esac
`,
    { mode: 0o700 },
  );
  try {
    const result = spawnSync('bash', ['scripts/upstream-umami-acceptance.sh'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${dir}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        PULSE_MOCK_LOG: log,
      },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Refusing to reuse existing/);
    const calls = readFileSync(log, 'utf8').split('\n');
    assert.ok(calls.some((line) => line.startsWith('container exists ')));
    assert.ok(
      calls.every((line) => !/^(rm |network rm |image rm |run |pull )/.test(line)),
      calls.join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
