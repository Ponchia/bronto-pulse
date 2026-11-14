import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

/**
 * Synthetic certificate authority and loopback HTTPS server for the pinned
 * transport tests. Keys and certificates are generated in memory for each
 * run and never written to disk, so the repository carries no key material
 * and no fixture expires. The DER encoder covers exactly what these X.509 v3
 * certificates need.
 */
const length = (n: number) =>
  n < 0x80
    ? Buffer.from([n])
    : n < 0x100
      ? Buffer.from([0x81, n])
      : Buffer.from([0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const oid = (dotted: string) => {
  const arcs = dotted.split('.').map(Number);
  const bytes = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let rest = arc >> 7; rest; rest >>= 7) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const integer = (value: Buffer) =>
  tlv(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const name = (commonName: string) =>
  sequence(tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName)))));
// UTCTime: valid for the years 1950 to 2049.
const time = (at: Date) =>
  tlv(0x17, Buffer.from(at.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const extension = (id: string, critical: boolean, value: Buffer) =>
  sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
const ECDSA_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));
const pem = (der: Buffer) =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd()}\n-----END CERTIFICATE-----\n`;
function certificate(options: {
  subject: string;
  issuer: string;
  subjectKey: KeyObject;
  issuerKey: KeyObject;
  authority: boolean;
  names?: readonly string[];
  addresses?: readonly string[];
  notBefore?: Date;
  notAfter?: Date;
}): string {
  const serial = randomBytes(8);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const alternatives = [
    ...(options.names ?? []).map((value) => tlv(0x82, Buffer.from(value))),
    ...(options.addresses ?? []).map((value) =>
      tlv(0x87, Buffer.from(value.split('.').map(Number))),
    ),
  ];
  const extensions = [
    extension(
      '2.5.29.19',
      true,
      options.authority ? sequence(tlv(0x01, Buffer.from([0xff]))) : sequence(),
    ),
    // keyCertSign and cRLSign for the authority, digitalSignature for a leaf.
    extension(
      '2.5.29.15',
      true,
      tlv(0x03, Buffer.from(options.authority ? [0x01, 0x06] : [0x07, 0x80])),
    ),
    ...(alternatives.length ? [extension('2.5.29.17', false, sequence(...alternatives))] : []),
  ];
  const body = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name(options.issuer),
    sequence(
      time(options.notBefore ?? new Date(Date.now() - 3600_000)),
      time(options.notAfter ?? new Date(Date.now() + 24 * 3600_000)),
    ),
    name(options.subject),
    options.subjectKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, sequence(...extensions)),
  );
  const signature = sign('sha256', body, options.issuerKey);
  return pem(sequence(body, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature)));
}
export interface Leaf {
  cert: string;
  key: string;
}
export interface Authority {
  /** PEM trust anchor to hand to the transport under test. */
  certificate: string;
  issue(options: {
    names?: readonly string[];
    addresses?: readonly string[];
    notBefore?: Date;
    notAfter?: Date;
  }): Leaf;
}
export function authority(label = 'Synthetic Pulse Test Root'): Authority {
  const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    certificate: certificate({
      subject: label,
      issuer: label,
      subjectKey: root.publicKey,
      issuerKey: root.privateKey,
      authority: true,
    }),
    issue(options) {
      const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      return {
        cert: certificate({
          subject: options.names?.[0] ?? 'synthetic leaf',
          issuer: label,
          subjectKey: leaf.publicKey,
          issuerKey: root.privateKey,
          authority: false,
          ...options,
        }),
        key: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      };
    },
  };
}
/** A leaf signed by itself: no authority vouches for it. */
export function selfSigned(hostname: string): Leaf {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    cert: certificate({
      subject: hostname,
      issuer: hostname,
      subjectKey: pair.publicKey,
      issuerKey: pair.privateKey,
      authority: false,
      names: [hostname],
    }),
    key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}
export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaderNames: string[];
  body: string;
  serverName: string | false | null | undefined;
}
export interface Instance {
  port: number;
  /** Every HTTP request that reached the application, in order. */
  seen: Seen[];
  /** TLS handshakes that completed, whether or not a request followed. */
  handshakes: number;
  /** TCP connections accepted, including failed handshakes. */
  connections: number;
  close(): Promise<void>;
}
/** HTTPS server on 127.0.0.1 with an ephemeral port. Loopback only. */
export async function instance(
  leaf: Leaf,
  respond: (request: IncomingMessage, response: ServerResponse, seen: Seen) => void,
): Promise<Instance> {
  const server: Server = createServer({ key: leaf.key, cert: leaf.cert });
  const state: Instance = {
    port: 0,
    seen: [],
    handshakes: 0,
    connections: 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  server.on('connection', () => state.connections++);
  server.on('secureConnection', () => state.handshakes++);
  // A refused handshake is the expected outcome of several tests.
  server.on('tlsClientError', () => {});
  server.on('request', (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const seen: Seen = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        rawHeaderNames: request.rawHeaders.filter((_, index) => index % 2 === 0),
        body: Buffer.concat(chunks).toString('utf8'),
        serverName: (request.socket as TLSSocket).servername,
      };
      state.seen.push(seen);
      respond(request, response, seen);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  return state;
}
