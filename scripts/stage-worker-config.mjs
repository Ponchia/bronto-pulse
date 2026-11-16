#!/usr/bin/env node
/**
 * Generate one atomic Cloudflare "wrangler versions secret bulk" file.
 * No remote requests, no plaintext logging, no overwrite, no shell commands.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, lstatSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseConfig } from '../dist/config.js';

const MAX_TOTAL = 8 * 4096;
const MAX_CHUNK = 4096;
const OUTPUT = 'pulse-worker-config.secrets.json';

function stage(inputFile, outputDir) {
  if (!isAbsolute(inputFile) || !isAbsolute(outputDir))
    throw new Error('Require absolute private file and new directory.');
  const stat = lstatSync(inputFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('Input must be a private regular file (mode 0600).');
  if (stat.size > MAX_TOTAL || stat.size < 1)
    throw new Error('Configuration size is outside bounded limits.');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(inputFile));
  parseConfig(JSON.parse(raw));
  const parts = [];
  let current = '';
  let bytes = 0;
  for (const char of raw) {
    const n = Buffer.byteLength(char, 'utf8');
    if (bytes + n > MAX_CHUNK) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += n;
  }
  if (current) parts.push(current);
  if (parts.length < 2 || parts.length > 8)
    throw new Error(
      'Split secret staging needs 2–8 pieces; use PULSE_CONFIG for a smaller source.',
    );
  const manifest = JSON.stringify({
    version: 1,
    parts: parts.length,
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
  });
  const bundle = Object.fromEntries(parts.map((part, i) => ['PULSE_CONFIG_PART_' + (i + 1), part]));
  // The manifest is written with all chunks in one staged Worker Version,
  // not through a sequence of individually activated secret changes.
  bundle.PULSE_CONFIG_MANIFEST = manifest;
  mkdirSync(outputDir, { mode: 0o700 });
  const destination = outputDir + '/' + OUTPUT;
  writeFileSync(destination, JSON.stringify(bundle), { flag: 'wx', mode: 0o600 });
  if ((statSync(destination).mode & 0o077) !== 0)
    throw new Error('Private bundle permissions are unsafe.');
  return { destination, count: parts.length, bytes: Buffer.byteLength(raw) };
}

if (process.argv[1] && import.meta.url.endsWith('/' + process.argv[1].split('/').at(-1))) {
  try {
    if (process.argv.length !== 4)
      throw new Error('Need private input path and a new private output directory.');
    const result = stage(process.argv[2], process.argv[3]);
    // No source data, credentials, analytics, or secret JSON is printed.
    console.log(
      'Prepared private atomic staging file (mode 0600): ' +
        result.destination +
        '; parts=' +
        result.count +
        '; source bytes=' +
        result.bytes,
    );
  } catch {
    console.error(
      'Could not stage configuration. Check input file, privacy, size, and output directory.',
    );
    process.exitCode = 1;
  }
}
export { stage };
