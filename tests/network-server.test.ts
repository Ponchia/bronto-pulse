import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startServer } from '../src/server.js';
import { fixture, database } from './helpers.js';

const token = 'portable-server-test-strong-token-0123456789';

function call(
  port: number,
  host: string,
  path = '/health',
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { Host: host, ...(options.headers ?? {}) },
      },
      (res) => {
        const buffers: Buffer[] = [];
        res.on('data', (x: Buffer) => buffers.push(x));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(buffers).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

test('wildcard listener is opt-in and rejects invalid origins and tokens before binding', async () => {
  const config = fixture('npm');
  const store = await database(config);
  try {
    await assert.rejects(
      startServer(config, store, {}, { host: '0.0.0.0', token }),
      /HTTPS public origin/,
    );
    await assert.rejects(
      startServer(
        config,
        store,
        {},
        { host: '0.0.0.0', publicOrigin: 'http://pulse.example.test', token },
      ),
      /external HTTPS origin/,
    );
    await assert.rejects(
      startServer(
        config,
        store,
        {},
        { host: '0.0.0.0', publicOrigin: 'https://pulse.example.test/', token: 'short' },
      ),
      /PULSE_API_TOKEN/,
    );
    await assert.rejects(
      startServer(
        config,
        store,
        {},
        { host: '192.0.2.3', publicOrigin: 'https://pulse.example.test/', token },
      ),
      /Server bind host/,
    );
  } finally {
    store.driver.close?.();
  }
});

test('reverse-proxy mode pins HTTPS authority, signed sessions and same-origin writes', async () => {
  const config = fixture('npm');
  const store = await database(config);
  const server = await startServer(
    config,
    store,
    {},
    {
      host: '0.0.0.0',
      port: 0,
      publicOrigin: 'https://pulse.example.test',
      token,
    },
  );
  try {
    const addr = server.address() as AddressInfo;
    const port = addr.port;
    assert.equal((await call(port, 'pulse.example.test')).status, 200);
    assert.equal((await call(port, 'wrong.example.test')).status, 403);
    assert.equal(
      (
        await call(port, 'wrong.example.test', '/', {
          headers: { 'x-forwarded-host': 'pulse.example.test' },
        })
      ).status,
      403,
    );
    assert.equal((await call(port, 'pulse.example.test', '//evil.invalid/')).status, 403);
    assert.equal((await call(port, 'pulse.example.test', '/api/v1/projects')).status, 401);
    const body = new URLSearchParams({ token }).toString();
    const login = await call(port, 'pulse.example.test', '/login', {
      method: 'POST',
      headers: {
        Origin: 'https://pulse.example.test',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(login.status, 303);
    assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.match(String(login.headers['set-cookie']), /; Secure/);
    assert.equal(
      (
        await call(port, 'pulse.example.test', '/login', {
          method: 'POST',
          headers: {
            Origin: 'https://evil.example.test',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        })
      ).status,
      403,
    );
    const session = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const protectedData = await call(port, 'pulse.example.test', '/api/v1/projects', {
      headers: { Cookie: session },
    });
    assert.equal(protectedData.status, 200);
    assert.match(protectedData.body, /Example project/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.driver.close?.();
  }
});
