import { CLIENT_INFO_META_KEY, createMcpHandler } from '@modelcontextprotocol/server';
import {
  createPulseMcpServer,
  MCP_REQUEST_BYTES,
  type PulseMcpOptions,
  type PulseMcpSource,
} from './server.js';

function failure(status: number, message: string): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(status === 405 ? { Allow: 'POST' } : {}),
      },
    },
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function implementation(value: unknown): boolean {
  return (
    object(value) &&
    ['name', 'version'].every(
      (field) =>
        typeof value[field] === 'string' && value[field].length > 0 && value[field].length <= 256,
    )
  );
}
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid request');
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MCP_REQUEST_BYTES) {
        await reader.cancel();
        return failure(413, 'MCP request exceeds the 32 KiB body limit.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function validEnvelope(value: unknown): boolean {
  if (
    !object(value) ||
    value.jsonrpc !== '2.0' ||
    typeof value.method !== 'string' ||
    value.method.length === 0 ||
    value.method.length > 128
  )
    return false;
  if (
    value.id !== undefined &&
    !(typeof value.id === 'string' && value.id.length <= 256) &&
    !(typeof value.id === 'number' && Number.isSafeInteger(value.id))
  )
    return false;
  if (value.params !== undefined && !object(value.params)) return false;
  const params = object(value.params) ? value.params : {};
  if (
    value.method === 'initialize' &&
    (typeof params.protocolVersion !== 'string' ||
      params.protocolVersion.length > 64 ||
      !object(params.capabilities) ||
      !implementation(params.clientInfo))
  )
    return false;
  const meta = params._meta;
  if (meta !== undefined && !object(meta)) return false;
  if (
    object(meta) &&
    meta[CLIENT_INFO_META_KEY] !== undefined &&
    !implementation(meta[CLIENT_INFO_META_KEY])
  )
    return false;
  return true;
}
/**
 * Private, stateless Streamable HTTP transport. The caller MUST authenticate
 * the installation owner before calling this function (including discovery).
 * This module never accepts a cookie or bearer token as proof of identity.
 */
export async function handlePulseMcp(
  request: Request,
  source: PulseMcpSource,
  options: PulseMcpOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== url.origin) return failure(403, 'Origin is not allowed.');
  if (request.method !== 'POST') return failure(405, 'Use POST for stateless MCP requests.');
  if (
    request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/json'
  )
    return failure(415, 'MCP requests require application/json.');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MCP_REQUEST_BYTES))
    return failure(413, 'MCP request exceeds the 32 KiB body limit.');
  let parsedBody: unknown;
  try {
    parsedBody = await body(request);
  } catch {
    return failure(400, 'Malformed MCP request.');
  }
  if (parsedBody instanceof Response) return parsedBody;
  if (!validEnvelope(parsedBody)) return failure(400, 'Malformed MCP request envelope.');
  const handler = createMcpHandler(() => createPulseMcpServer(source, options), {
    maxRequestBodySize: MCP_REQUEST_BYTES,
    maxSubscriptions: 0,
    keepAliveMs: 0,
  });
  try {
    const response = await handler.fetch(request, { parsedBody });
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return failure(500, 'MCP request could not be served.');
  } finally {
    await handler.close();
  }
}
