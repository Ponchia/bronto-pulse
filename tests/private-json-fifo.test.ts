import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test(
  'a POSIX FIFO without a writer is refused instead of blocking input validation',
  {
    skip: process.platform === 'win32' ? 'POSIX named-pipe admission' : false,
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-input-fifo-'));
    try {
      const path = join(dir, 'not-json.pipe');
      const created = spawnSync('mkfifo', ['-m', '600', path], { encoding: 'utf8' });
      assert.equal(created.status, 0, created.stderr);
      const module = new URL('../src/visibility-cli.ts', import.meta.url).href;
      const script = `import { privateJson } from ${JSON.stringify(module)};
      await privateJson(process.argv[1], 1024).then(
        () => { process.exitCode = 2; },
        error => { if (error.code !== 'CONFIG') throw error; console.log('CONFIG'); }
      );`;
      const result = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script, path],
        {
          encoding: 'utf8',
          timeout: 5000,
          killSignal: 'SIGKILL',
          env: { PATH: process.env.PATH, HOME: dir },
        },
      );
      assert.equal(result.error, undefined, 'opening a named pipe must not wait for a writer');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'CONFIG');
      assert.doesNotMatch(result.stderr, /not-json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
