import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import {
  MCP_INSTRUCTIONS,
  pulseMcpTools,
  type PulseMcpOptions,
  type PulseMcpSource,
} from './tools.js';

export {
  MCP_REQUEST_BYTES,
  MCP_RESULT_BYTES,
  type PulseMcpContext,
  type PulseMcpOptions,
  type PulseMcpSource,
} from './tools.js';

/** Node-only SDK adapter. The Worker uses the shared tool contracts directly. */
export function createPulseMcpServer(
  source: PulseMcpSource,
  options: PulseMcpOptions = {},
): McpServer {
  const server = new McpServer(
    { name: 'bronto-pulse', version: options.version ?? '1.0.0' },
    { capabilities: { tools: {} }, maxToolInputElements: 32, instructions: MCP_INSTRUCTIONS },
  );
  for (const entry of pulseMcpTools) {
    const { name, inputSchema, ...metadata } = entry.definition();
    server.registerTool(
      name,
      {
        ...metadata,
        // These fixed schemas are emitted as draft-07. Zod and the SDK disagree
        // on the type of newer-draft vocabulary metadata that we never emit.
        inputSchema: fromJsonSchema<Record<string, unknown>>(
          inputSchema as Parameters<typeof fromJsonSchema>[0],
        ),
      },
      (input) => entry.call(source, input),
    );
  }
  return server;
}
