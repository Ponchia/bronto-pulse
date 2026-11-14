import { PulseError } from '../src/errors.js';
import { createPinnedTransport } from '../src/selfhost/node-transport.js';
import {
  SYNTHETIC_LOOPBACK,
  admitDestination,
  type SelfHostedRuntime,
} from '../src/selfhost/policy.js';
import { ADDRESS_SETTING, TOKEN, selfHostedConfig } from './selfhost-helpers.js';

/**
 * Child process for one transport test. The parent starts it with a
 * verification bypass in its environment, which a test must not set for its
 * own process. It attempts one read against the fixture port in argv and
 * prints the outcome as JSON.
 */
const port = Number(process.argv[2]);
const runtime: SelfHostedRuntime = {
  exchange: createPinnedTransport(),
  settings: { [ADDRESS_SETTING]: '127.0.0.1' },
  [SYNTHETIC_LOOPBACK]: ['127.0.0.1'],
};
let outcome: { code: string; message: string };
try {
  await runtime.exchange({
    destination: admitDestination(selfHostedConfig('umami', { port }).connections[0], runtime),
    read: { variant: 'umami-selfhosted', websiteId: 'website-123', startAt: 0, endAt: 1 },
    token: TOKEN,
    timeoutMs: 4000,
    maximumBytes: 4096,
  });
  outcome = { code: 'NONE', message: 'the read was not refused' };
} catch (error) {
  outcome =
    error instanceof PulseError
      ? { code: error.code, message: error.message }
      : { code: 'UNEXPECTED', message: 'not a PulseError' };
}
process.stdout.write(JSON.stringify(outcome));
