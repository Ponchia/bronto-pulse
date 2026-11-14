/**
 * One pinned exchange in a fresh process, so process-wide settings that Node
 * reads only at startup (proxy selection, TLS verification defaults) are
 * really in force. Input: JSON `{ port, ca }` on argv. Output: one JSON line.
 */
import { PulseError } from '../../src/errors.js';
import { createPinnedTransport } from '../../src/selfhost/node-transport.js';
import { SYNTHETIC_LOOPBACK, admitDestination } from '../../src/selfhost/policy.js';
import { INSTANCE_HOST, TOKEN } from './fixture.js';

const { port, ca } = JSON.parse(process.argv[2]!) as { port: number; ca: string };
const exchange = createPinnedTransport({ ca });
try {
  const destination = admitDestination(
    {
      id: 'analytics',
      provider: 'plausible',
      tokenEnv: 'TEST_TOKEN',
      selfHosted: {
        instance: 'fixture',
        hostname: INSTANCE_HOST,
        port,
        addressEnv: 'FIXTURE_ADDRESS',
      },
    },
    { exchange, settings: { FIXTURE_ADDRESS: '127.0.0.1' }, [SYNTHETIC_LOOPBACK]: ['127.0.0.1'] },
  );
  const reply = await exchange({
    destination,
    read: {
      variant: 'plausible-ce',
      siteId: 'site.example.org',
      from: '2026-10-12',
      to: '2026-10-13',
      limit: 10,
    },
    token: TOKEN,
    timeoutMs: 5000,
    maximumBytes: 65536,
  });
  console.log(
    JSON.stringify({ ok: true, status: reply.status, body: Buffer.from(reply.body).toString() }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      pulse: error instanceof PulseError,
      code: error instanceof PulseError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
