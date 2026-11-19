import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

function refuse(message) {
  process.stderr.write('Bronto Pulse Review: ' + message + '\n');
  process.exitCode = 1;
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    refuse('Node.js 24.15 or newer is required.');
    return;
  }
  if (process.argv.length !== 2) {
    refuse('Set the three PULSE path environment variables; no launcher arguments are accepted.');
    return;
  }

  const names = ['PULSE_CLI_PATH', 'PULSE_CONFIG_PATH', 'PULSE_DB_PATH'];
  const paths = [];
  for (const name of names) {
    const path = process.env[name];
    if (!path || !isAbsolute(path)) {
      refuse(name + ' must be an absolute path to an existing file.');
      return;
    }
    try {
      if (!(await stat(path)).isFile()) throw new Error('Not a file');
    } catch {
      refuse(name + ' must identify an accessible existing file.');
      return;
    }
    paths.push(path);
  }

  // The reporting process does not need provider credentials or Node preload
  // hooks from the agent client's environment. Keep only runtime essentials.
  const env = {};
  for (const name of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'TZ',
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const [cli, config, db] = paths;
  const child = spawn(process.execPath, [cli, 'mcp', '--config', config, '--db', db], {
    shell: false,
    stdio: 'inherit',
    env,
  });

  child.once('error', () => {
    refuse('Could not start the configured Pulse CLI.');
  });
  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardTerminate = () => child.kill('SIGTERM');
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTerminate);
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', forwardInterrupt);
    process.removeListener('SIGTERM', forwardTerminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
}

await main();
