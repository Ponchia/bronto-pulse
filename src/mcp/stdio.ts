import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import {
  createPulseMcpServer,
  MCP_REQUEST_BYTES,
  type PulseMcpOptions,
  type PulseMcpSource,
} from './server.js';

/** Node-only entrypoint. Stdout belongs exclusively to the MCP protocol. */
export function startPulseMcpStdio(
  source: PulseMcpSource,
  options: PulseMcpOptions & { onClose?: () => void } = {},
): StdioServerHandle {
  let closed = false;
  const closeResources = () => {
    if (closed) return;
    closed = true;
    options.onClose?.();
  };
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: MCP_REQUEST_BYTES,
  });
  // Observe transport EOF, not server/discover probe instances that the SDK
  // can discard while negotiating protocol versions.
  const closeTransport = transport.close.bind(transport);
  transport.close = async () => {
    try {
      await closeTransport();
    } finally {
      closeResources();
    }
  };
  return serveStdio(() => createPulseMcpServer(source, options), {
    transport,
    maxSubscriptions: 0,
    // Never print provider/configuration payloads or corrupt protocol stdout.
    onerror: () => {
      process.stderr.write('Pulse MCP protocol error.\n');
    },
  });
}
