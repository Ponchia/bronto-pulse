/**
 * Independent local TLS fixture for hostile acceptance of the self-hosted
 * provider transport. It shares no code with the transport under test: keys
 * and certificates are minted by the system `openssl` into a private temporary
 * directory for one test process and are never written to the repository.
 * Servers listen on loopback only and answer with hand-written bytes so a
 * scenario controls every header, length and pause.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

/** A reserved top-level domain: this name never resolves through DNS. */
export const INSTANCE_HOST = 'analytics.pulse-fixture.test';
export const OTHER_HOST = 'elsewhere.pulse-fixture.test';
export const TOKEN = 'synthetic-selfhosted-token-never-a-real-credential';

export type LeafKind =
  'good' | 'wrong-name' | 'address-only' | 'expired' | 'untrusted' | 'self-signed';
export interface Leaf {
  key: string;
  cert: string;
}
export interface Pki {
  /** PEM of the only authority a test may trust. */
  ca: string;
  leaf(kind: LeafKind): Leaf;
  dispose(): void;
}

function openssl(cwd: string, args: string[]): void {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}
const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];

export function createPki(): Pki {
  const dir = mkdtempSync(path.join(tmpdir(), 'pulse-selfhosted-acceptance-'));
  const authority = (name: string) =>
    openssl(dir, [
      'req',
      '-x509',
      ...EC,
      '-sha256',
      '-days',
      '2',
      '-subj',
      `/CN=Pulse synthetic ${name} authority`,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.pem`,
    ]);
  authority('trusted');
  authority('rogue');
  const read = (file: string) => readFileSync(path.join(dir, file), 'utf8');
  const cache = new Map<LeafKind, Leaf>();
  const signed = (kind: LeafKind, san: string, issuer: string, days: string): Leaf => {
    openssl(dir, [
      'req',
      ...EC,
      '-subj',
      '/CN=Pulse synthetic leaf',
      '-keyout',
      `${kind}.key`,
      '-out',
      `${kind}.csr`,
    ]);
    writeFileSync(
      path.join(dir, `${kind}.cnf`),
      `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
    );
    openssl(dir, [
      'x509',
      '-req',
      '-in',
      `${kind}.csr`,
      '-CA',
      `${issuer}.pem`,
      '-CAkey',
      `${issuer}.key`,
      '-CAcreateserial',
      '-days',
      days,
      '-sha256',
      '-extfile',
      `${kind}.cnf`,
      '-out',
      `${kind}.pem`,
    ]);
    return { key: read(`${kind}.key`), cert: read(`${kind}.pem`) };
  };
  const make = (kind: LeafKind): Leaf => {
    switch (kind) {
      case 'good':
        return signed(kind, `DNS:${INSTANCE_HOST}`, 'trusted', '2');
      case 'wrong-name':
        return signed(kind, `DNS:${OTHER_HOST}`, 'trusted', '2');
      case 'address-only':
        return signed(kind, 'IP:127.0.0.1', 'trusted', '2');
      case 'expired':
        // Zero validity: notAfter equals notBefore, already past when used.
        return signed(kind, `DNS:${INSTANCE_HOST}`, 'trusted', '0');
      case 'untrusted':
        return signed(kind, `DNS:${INSTANCE_HOST}`, 'rogue', '2');
      case 'self-signed':
        openssl(dir, [
          'req',
          '-x509',
          ...EC,
          '-sha256',
          '-days',
          '2',
          '-subj',
          '/CN=Pulse synthetic self-signed leaf',
          '-addext',
          `subjectAltName=DNS:${INSTANCE_HOST}`,
          '-keyout',
          `${kind}.key`,
          '-out',
          `${kind}.pem`,
        ]);
        return { key: read(`${kind}.key`), cert: read(`${kind}.pem`) };
    }
  };
  return {
    ca: read('trusted.pem'),
    leaf(kind) {
      let leaf = cache.get(kind);
      if (!leaf) cache.set(kind, (leaf = make(kind)));
      return leaf;
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface SeenRequest {
  method: string;
  target: string;
  version: string;
  /** Header lines in wire order, names as sent. */
  headers: [string, string][];
  body: string;
  remoteAddress: string | undefined;
  servername: string | false | undefined;
  alpn: string | false | null | undefined;
}
export type Responder = (socket: tls.TLSSocket, request: SeenRequest, index: number) => void;

export interface HostileServer {
  port: number;
  /** Completed TLS handshakes, with the server name the client indicated. */
  handshakes: {
    servername: string | false | undefined;
    remoteAddress: string | undefined;
    /** The address the client actually connected to. */
    localAddress: string | undefined;
    alpn: string | false | null | undefined;
  }[];
  /** Handshakes the client abandoned, usually after refusing the certificate. */
  handshakeFailures: number;
  requests: SeenRequest[];
  /** Application bytes received after a handshake: any value above zero means a client spoke. */
  received(): number;
  /** Connections still open. */
  open(): number;
  /** Bytes this server wrote in responses, to show a client stopped early. */
  written(): number;
  header(request: SeenRequest, name: string): string[];
  close(): Promise<void>;
}

export async function hostileServer(
  leaf: Leaf,
  respond: Responder,
  /** Loopback unless a test needs this host's own private address. */
  bind = '127.0.0.1',
): Promise<HostileServer> {
  const sockets = new Set<net.Socket>();
  const state = {
    handshakes: [] as HostileServer['handshakes'],
    handshakeFailures: 0,
    requests: [] as SeenRequest[],
    received: 0,
  };
  const accepted: tls.TLSSocket[] = [];
  const server = tls.createServer(
    { key: leaf.key, cert: leaf.cert, ALPNProtocols: ['h2', 'http/1.1'] },
    (socket) => {
      state.handshakes.push({
        servername: (socket as tls.TLSSocket & { servername?: string | false }).servername,
        remoteAddress: socket.remoteAddress,
        localAddress: socket.localAddress,
        alpn: socket.alpnProtocol,
      });
      accepted.push(socket);
      let buffer = Buffer.alloc(0);
      let head: Omit<SeenRequest, 'body'> | undefined;
      let need = 0;
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        state.received += chunk.byteLength;
        buffer = Buffer.concat([buffer, chunk]);
        if (!head) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
          const [method = '', target = '', version = ''] = lines[0]!.split(' ');
          const headers = lines.slice(1).map((line): [string, string] => {
            const at = line.indexOf(':');
            return [line.slice(0, at), line.slice(at + 1).trim()];
          });
          head = {
            method,
            target,
            version,
            headers,
            remoteAddress: socket.remoteAddress,
            servername: (socket as tls.TLSSocket & { servername?: string | false }).servername,
            alpn: socket.alpnProtocol,
          };
          need = Number(headers.find(([name]) => name.toLowerCase() === 'content-length')?.[1]);
          if (!Number.isFinite(need)) need = 0;
          buffer = buffer.subarray(end + 4);
        }
        if (buffer.length < need) return;
        const complete: Omit<SeenRequest, 'body'> = head;
        const request: SeenRequest = {
          ...complete,
          body: buffer.subarray(0, need).toString('utf8'),
        };
        buffer = buffer.subarray(need);
        head = undefined;
        state.requests.push(request);
        respond(socket, request, state.requests.length - 1);
      });
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => state.handshakeFailures++);
  await new Promise<void>((resolve) => server.listen(0, bind, resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    handshakes: state.handshakes,
    get handshakeFailures() {
      return state.handshakeFailures;
    },
    requests: state.requests,
    received: () => state.received,
    open: () => sockets.size,
    written: () => accepted.reduce((sum, socket) => sum + socket.bytesWritten, 0),
    header: (request, name) =>
      request.headers
        .filter(([key]) => key.toLowerCase() === name.toLowerCase())
        .map(([, value]) => value),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A plain TCP listener standing in for a proxy: any byte it receives is a leak. */
export async function trap(): Promise<{
  port: number;
  connections: () => number;
  bytes: () => string;
  close(): Promise<void>;
}> {
  let connections = 0;
  let bytes = '';
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('data', (chunk) => (bytes += chunk.toString('latin1')));
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => connections,
    bytes: () => bytes,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const head = (status: string, headers: Record<string, string | number>) =>
  `HTTP/1.1 ${status}\r\n${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')}\r\n`;

/** Hand-written responses. Each returns a responder for {@link hostileServer}. */
export const respond = {
  json(value: unknown, extra: Record<string, string | number> = {}): Responder {
    const body = JSON.stringify(value);
    return (socket) =>
      socket.end(
        head('200 OK', {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close',
          ...extra,
        }) + body,
      );
  },
  status(code: number, extra: Record<string, string | number> = {}, body = ''): Responder {
    return (socket) =>
      socket.end(
        head(`${code} Synthetic`, {
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close',
          ...extra,
        }) + body,
      );
  },
  redirect(code: number, location: string): Responder {
    return respond.status(code, { Location: location }, 'synthetic-redirect-body');
  },
  /** Compressed JSON: the client asked for no encoding and must not inflate this blindly. */
  encoded(encoding: string, bytes: Uint8Array): Responder {
    return (socket) => {
      socket.write(
        head('200 OK', {
          'Content-Type': 'application/json',
          'Content-Encoding': encoding,
          'Content-Length': bytes.byteLength,
          Connection: 'close',
        }),
      );
      socket.end(bytes);
    };
  },
  /** Declares a length without sending it: refusal must not need the body. */
  declaredLength(length: number): Responder {
    return (socket) =>
      socket.write(
        head('200 OK', { 'Content-Type': 'application/json', 'Content-Length': length }),
      );
  },
  /** Chunked JSON-looking stream that never ends until the client hangs up. */
  endlessChunks(chunkBytes = 64 * 1024): Responder {
    return (socket) => {
      socket.write(
        head('200 OK', { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }),
      );
      const chunk = `${chunkBytes.toString(16)}\r\n${'7'.repeat(chunkBytes)}\r\n`;
      const pump = () => {
        while (!socket.destroyed && socket.write(chunk));
        if (!socket.destroyed) socket.once('drain', pump);
      };
      socket.write(`1\r\n[\r\n`);
      pump();
    };
  },
  /** Promises more bytes than it sends, then closes cleanly. */
  shortBody(declared: number, sent: string): Responder {
    return (socket) =>
      socket.end(
        head('200 OK', { 'Content-Type': 'application/json', 'Content-Length': declared }) + sent,
      );
  },
  /** Sends part of a chunked body, then resets the connection. */
  resetMidBody(sent: string): Responder {
    return (socket) => {
      socket.write(
        head('200 OK', { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }),
      );
      socket.write(`${Buffer.byteLength(sent).toString(16)}\r\n${sent}\r\n`, () =>
        socket.destroy(),
      );
    };
  },
  /** Accepts the request and never answers. */
  silent(): Responder {
    return () => undefined;
  },
  /** One body byte per interval, forever: defeats an idle-only timeout. */
  trickle(intervalMs: number): Responder {
    return (socket) => {
      socket.write(
        head('200 OK', { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }),
      );
      const timer = setInterval(() => {
        if (socket.destroyed) clearInterval(timer);
        else socket.write('1\r\n \r\n');
      }, intervalMs);
      socket.on('close', () => clearInterval(timer));
    };
  },
  /** One header line per interval, forever, before any body. */
  trickleHeaders(intervalMs: number): Responder {
    return (socket) => {
      socket.write('HTTP/1.1 200 OK\r\n');
      let n = 0;
      const timer = setInterval(() => {
        if (socket.destroyed) clearInterval(timer);
        else socket.write(`X-Synthetic-${n++}: slow\r\n`);
      }, intervalMs);
      socket.on('close', () => clearInterval(timer));
    };
  },
  /** A response head far beyond any reasonable header budget. */
  hugeHeaders(bytes: number): Responder {
    return (socket) => {
      const body = '{}';
      socket.end(
        head('200 OK', {
          'Content-Type': 'application/json',
          'X-Synthetic-Padding': 'p'.repeat(bytes),
          'Content-Length': body.length,
          Connection: 'close',
        }) + body,
      );
    };
  },
  /** Interim responses before the final one. */
  interim(count: number, final: Responder): Responder {
    return (socket, request, index) => {
      for (let i = 0; i < count; i++) socket.write('HTTP/1.1 100 Continue\r\n\r\n');
      final(socket, request, index);
    };
  },
  switchingProtocols(): Responder {
    return (socket) =>
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
  },
  /** Raw bytes for malformed or smuggling-shaped responses. */
  raw(bytes: string, end = true): Responder {
    return (socket) => (end ? socket.end(bytes) : socket.write(bytes));
  },
};
