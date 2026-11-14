/**
 * Proves the hostile fixture itself: a refusal observed later must come from
 * the transport under test, not from a broken certificate or server here.
 * Uses a bare `node:tls` client, deliberately unrelated to the transport.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import tls from 'node:tls';
import {
  INSTANCE_HOST,
  createPki,
  hostileServer,
  respond,
  type LeafKind,
  type Pki,
} from './fixture.js';

let pki: Pki;
before(() => {
  pki = createPki();
});
after(() => pki.dispose());

function handshake(port: number, ca: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername: INSTANCE_HOST, ca }, () => {
      socket.destroy();
      resolve('authorized');
    });
    socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}

const expected: Record<LeafKind, string> = {
  good: 'authorized',
  'wrong-name': 'ERR_TLS_CERT_ALTNAME_INVALID',
  'address-only': 'ERR_TLS_CERT_ALTNAME_INVALID',
  expired: 'CERT_HAS_EXPIRED',
  untrusted: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'self-signed': 'DEPTH_ZERO_SELF_SIGNED_CERT',
};
for (const [kind, outcome] of Object.entries(expected) as [LeafKind, string][]) {
  test(`fixture leaf "${kind}" yields ${outcome} for a strict client`, async () => {
    const server = await hostileServer(pki.leaf(kind), respond.json({}));
    try {
      assert.equal(await handshake(server.port, pki.ca), outcome);
    } finally {
      await server.close();
    }
  });
}

test('fixture records server name, request line, headers and body exactly', async () => {
  const server = await hostileServer(pki.leaf('good'), respond.json({ ok: true }));
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = tls.connect(
        { host: '127.0.0.1', port: server.port, servername: INSTANCE_HOST, ca: pki.ca },
        () =>
          socket.write(
            `POST /api/v2/query HTTP/1.1\r\nHost: ${INSTANCE_HOST}\r\nContent-Length: 2\r\n\r\n{}`,
          ),
      );
      let text = '';
      socket.on('data', (chunk) => (text += chunk));
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(reply, /\{"ok":true\}$/);
    assert.equal(server.handshakes[0]?.servername, INSTANCE_HOST);
    assert.equal(server.requests.length, 1);
    const [request] = server.requests;
    assert.equal(request?.method, 'POST');
    assert.equal(request?.target, '/api/v2/query');
    assert.deepEqual(server.header(request!, 'host'), [INSTANCE_HOST]);
    assert.equal(request?.body, '{}');
    assert.ok(server.written() > 0);
  } finally {
    await server.close();
  }
});
