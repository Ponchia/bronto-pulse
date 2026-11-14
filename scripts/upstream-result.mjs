import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A conformance run requires every declared test to pass, not only process exit zero. */
export function assertCompleteTap(text) {
  const counters = Object.fromEntries(
    ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((name) => {
      const matches = [...text.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))];
      if (matches.length !== 1) throw new Error('Missing or ambiguous test summary.');
      const value = Number(matches[0][1]);
      if (!Number.isSafeInteger(value)) throw new Error('Invalid test summary count.');
      return [name, value];
    }),
  );
  if (
    counters.tests < 1 ||
    counters.pass !== counters.tests ||
    ['fail', 'cancelled', 'skipped', 'todo'].some((name) => counters[name] !== 0)
  )
    throw new Error('Every required upstream acceptance case must pass without skips or TODOs.');
  return counters;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = assertCompleteTap(readFileSync(process.argv[2], 'utf8'));
    console.log(`Verified ${result.tests} required upstream tests with no omissions.`);
  } catch {
    console.error('Upstream acceptance did not produce a complete passing test summary.');
    process.exitCode = 1;
  }
}
