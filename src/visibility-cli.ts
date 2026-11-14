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
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new PulseError('CONFIG', 'Private JSON input needs a positive byte budget.');
  try {
    // Read at most the declared budget even for unexpectedly large files.
    const { open } = await import('node:fs/promises');
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile())
        throw new PulseError('CONFIG', 'Private JSON input must be a regular file.');
      if (info.size > maximumBytes)
        throw new PulseError('ROW_LIMIT', 'Private JSON input exceeds its byte budget.');
      // Allocate for bytes being read, not the entire allowance. The extra byte
      // still detects a file that grows beyond the budget after stat().
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - size));
        const read = await file.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
        if (size > maximumBytes)
          throw new PulseError('ROW_LIMIT', 'Private JSON input exceeds its byte budget.');
        chunks.push(buffer.subarray(0, read.bytesRead));
      }
      const text = new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks, size));
      return JSON.parse(text);
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
