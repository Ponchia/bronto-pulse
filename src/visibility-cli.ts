import { writeFile } from 'node:fs/promises';
import { PulseError } from './errors.js';
import {
  parseVisibilitySuite,
  visibilityTemplate,
  visibilityReport,
  promptfooConfig,
} from './visibility.js';

export async function privateJson(
  path: string | undefined,
  maximumBytes = 32 * 1024 * 1024,
): Promise<unknown> {
  if (!path) throw new PulseError('CONFIG', 'Pass the required JSON input file.');
  try {
    // Read at most the declared budget even for unexpectedly large files.
    const { open } = await import('node:fs/promises');
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(maximumBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > maximumBytes)
        throw new PulseError('ROW_LIMIT', 'Private JSON input exceeds its byte budget.');
      return JSON.parse(buffer.subarray(0, size).toString('utf8'));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof PulseError) throw error;
    throw new PulseError('CONFIG', 'Cannot read private JSON input. Contents were not echoed.');
  }
}
export async function visibilityCli(
  action: string | undefined,
  options: { suite?: string; session?: string; input?: string; out?: string },
): Promise<number> {
  if (!['template', 'report', 'promptfoo'].includes(action ?? ''))
    throw new PulseError('CONFIG', 'Choose visibility template, report or promptfoo.');
  const suite = parseVisibilitySuite(await privateJson(options.suite, 1024 * 1024));
  const result =
    action === 'template'
      ? await visibilityTemplate(suite, await privateJson(options.session, 16384))
      : action === 'report'
        ? await visibilityReport(suite, await privateJson(options.input))
        : await promptfooConfig(suite);
  const encoded = JSON.stringify(result, null, 2) + '\n';
  if (options.out) {
    await writeFile(options.out, encoded, { flag: 'wx', mode: 0o600 });
    console.log('Private visibility output written without overwriting any existing file.');
  } else console.log(encoded);
  return 0;
}
