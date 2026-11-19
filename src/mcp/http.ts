import {
  MCP_INSTRUCTIONS,
  MCP_REQUEST_BYTES,
  listPulseMcpTools,
  pulseMcpTools,
  type PulseMcpOptions,
  type PulseMcpSource,
} from './tools.js';

export const MCP_HTTP_PROTOCOL_VERSION = '2025-11-25';
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function failure(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { ...responseHeaders, ...(status === 405 ? { Allow: 'POST' } : {}) } },
  );
}
function rpcResult(id: string | number, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: responseHeaders });
}
function rpcError(id: string | number, code: number, message: string, status = 200): Response {
  return Response.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status, headers: responseHeaders },
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
function acceptsMcp(value: string | null): boolean {
  const types = new Set(
    (value ?? '').split(',').flatMap((entry) => {
      const [type, ...parameters] = entry
        .trim()
        .toLowerCase()
        .split(';')
        .map((part) => part.trim());
      const weights = parameters.filter((part) => /^q\s*=/.test(part));
      if (weights.length > 1) return [];
      if (weights.length === 1) {
        const weight = weights[0]!.slice(weights[0]!.indexOf('=') + 1).trim();
        if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(weight) || Number(weight) === 0) return [];
      }
      return type ? [type] : [];
    }),
  );
  return types.has('application/json') && types.has('text/event-stream');
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
interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}
function validEnvelope(value: unknown): value is RpcMessage {
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
      params.protocolVersion.length === 0 ||
      params.protocolVersion.length > 64 ||
      !object(params.capabilities) ||
      !implementation(params.clientInfo))
  )
    return false;
  const meta = params._meta;
  if (meta !== undefined && !object(meta)) return false;
  // Validate implementation metadata even on an unsupported modern discovery probe.
  if (
    object(meta) &&
    meta['io.modelcontextprotocol/clientInfo'] !== undefined &&
    !implementation(meta['io.modelcontextprotocol/clientInfo'])
  )
    return false;
  return true;
}
function onlyKeys(params: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(params).every((key) => keys.includes(key));
}
/**
 * Private, stateless MCP 2025-11-25 Streamable HTTP, with JSON responses only.
 * The caller MUST authenticate the installation owner before every request.
 * No SDK runtime, sessions, provider refreshes, or server-initiated messages.
 */
export async function handlePulseMcp(
  request: Request,
  source: PulseMcpSource,
  options: PulseMcpOptions = {},
): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== new URL(request.url).origin)
    return failure(403, 'Origin is not allowed.');
  if (request.method !== 'POST') return failure(405, 'Use POST for stateless MCP requests.');
  if (
    request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/json'
  )
    return failure(415, 'MCP requests require application/json.');
  if (!acceptsMcp(request.headers.get('Accept')))
    return failure(406, 'MCP requires Accept: application/json, text/event-stream.');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MCP_REQUEST_BYTES))
    return failure(413, 'MCP request exceeds the 32 KiB body limit.');
  let message: unknown;
  try {
    message = await body(request);
  } catch {
    return failure(400, 'Malformed MCP request.');
  }
  if (message instanceof Response) return message;
  if (!validEnvelope(message)) return failure(400, 'Malformed MCP request envelope.');
  const { id, method } = message;
  const params = message.params ?? {};
  const version = request.headers.get('MCP-Protocol-Version');
  if (
    (version !== null && version !== MCP_HTTP_PROTOCOL_VERSION) ||
    (version === null && method !== 'initialize')
  ) {
    // An explicit method-not-found reply lets current SDK auto negotiation fall
    // back to initialize, while the HTTP 400 also rejects its unsupported header.
    if (method === 'server/discover' && id !== undefined)
      return rpcError(id, -32601, 'Method not found.', 400);
    return failure(
      400,
      'Use the supported MCP-Protocol-Version: 2025-11-25 header after initialization.',
    );
  }
  if (id === undefined) {
    if (!method.startsWith('notifications/')) return failure(400, 'MCP requests require an id.');
    // No sessions or server requests exist to update or cancel. Ignore optional
    // notifications without executing a tool or touching private storage.
    return new Response(null, { status: 202, headers: responseHeaders });
  }
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: MCP_HTTP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'bronto-pulse', version: options.version ?? '1.0.0' },
        instructions: MCP_INSTRUCTIONS,
      });
    case 'ping':
      if (!onlyKeys(params, ['_meta'])) return rpcError(id, -32602, 'Invalid ping parameters.');
      return rpcResult(id, {});
    case 'tools/list':
      if (!onlyKeys(params, ['_meta']))
        return rpcError(id, -32602, 'Tool discovery does not accept a cursor or other parameters.');
      return rpcResult(id, { tools: listPulseMcpTools() });
    case 'tools/call': {
      if (
        !onlyKeys(params, ['name', 'arguments', '_meta']) ||
        typeof params.name !== 'string' ||
        params.name.length === 0 ||
        params.name.length > 128 ||
        (params.arguments !== undefined && !object(params.arguments))
      )
        return rpcError(id, -32602, 'Invalid tool call parameters.');
      const entry = pulseMcpTools.find((candidate) => candidate.name === params.name);
      if (!entry) return rpcError(id, -32602, 'Unknown tool.');
      return rpcResult(id, await entry.call(source, params.arguments ?? {}));
    }
    default:
      return rpcError(id, -32601, 'Method not found.');
  }
}
