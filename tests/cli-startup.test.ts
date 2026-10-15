import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-startup-'));
  writeFileSync(join(dir, 'pulse.config.json'), JSON.stringify(fixture('npm')));
  return dir;
}
async function availablePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
for (const configured of [false, true]) {
  test(
    `local startup ${configured ? 'never logs a configured reporting token' : 'shows only its freshly generated local token'}`,
    { timeout: 25000 },
    async () => {
      const dir = directory(),
        port = await availablePort();
      const supplied = 'synthetic-configured-reporting-token-for-test';
      const env = {
        PATH: process.env.PATH,
        HOME: dir,
        TZ: 'UTC',
        ...(configured ? { PULSE_API_TOKEN: supplied } : {}),
      };
      const child = spawn(
        process.execPath,
        ['--import', loader, cli, 'serve', '--port', String(port)],
        { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (value) => {
        stdout += value.toString();
      });
      child.stderr.on('data', (value) => {
        stderr += value.toString();
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Local test server did not start.')),
            15000,
          );
          const cleanup = () => {
            clearTimeout(timer);
            child.stdout.off('data', inspect);
            child.off('exit', exited);
            child.off('error', errored);
          };
          const inspect = () => {
            if (stdout.includes(`dashboard: http://127.0.0.1:${port}`)) {
              cleanup();
              resolve();
            }
          };
          const exited = () => {
            cleanup();
            reject(new Error('Local test server exited before startup.'));
          };
          const errored = (error: Error) => {
            cleanup();
            reject(error);
          };
          child.stdout.on('data', inspect);
          child.once('exit', exited);
          child.once('error', errored);
          inspect();
        });
        assert.ok(!stdout.includes(supplied));
        assert.ok(!stderr.includes(supplied));
        const displayed = /One-session local access token: ([a-f0-9]{64})/.exec(stdout)?.[1];
        if (configured) assert.equal(displayed, undefined);
        else assert.ok(displayed, 'The interactive local token should still be available.');
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
          headers: { Authorization: `Bearer ${configured ? supplied : displayed}` },
        });
        assert.equal(response.status, 200);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            child.kill('SIGTERM');
          });
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
test('an explicitly configured invalid token fails without printing or generating a replacement', () => {
  const dir = directory();
  try {
    const response = spawnSync(process.execPath, ['--import', loader, cli, 'serve'], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, TZ: 'UTC', PULSE_API_TOKEN: '' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(response.status, 1);
    assert.match(response.stderr, /AUTH/);
    assert.ok(!response.stdout.includes('One-session local access token:'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
