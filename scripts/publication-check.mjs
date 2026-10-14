import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
for (const path of tracked) {
  if (
    /(^|\/)(\.pulse|\.wrangler|node_modules|reports|artifacts|test-results|playwright-report)(\/|$)/.test(
      path,
    ) ||
    (/(^|\/)\.env(?:\.|$)/.test(path) && path !== '.env.example') ||
    /(^|\/)pulse\.(?:config|private)\.json$/.test(path) ||
    /(^|\/)wrangler\.(?:private|local)\./.test(path) ||
    /\.(?:db(?:-wal|-shm)?|sqlite\w*|pem|key|bundle|tgz|age)$/.test(path)
  )
    throw Error('Private/runtime artifact must not be tracked: ' + path);
}
const env = await read('.env.example');
for (const line of env.split(/\r?\n/)) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  if (!/^[A-Z][A-Z0-9_]*=$/.test(line))
    throw Error('Environment examples must contain empty named variables only.');
}
const config = JSON.parse((await read('wrangler.jsonc')).replace(/,\s*([}\]])/g, '$1'));
if (
  config.workers_dev !== false ||
  config.preview_urls !== false ||
  config.triggers?.crons?.length !== 0
)
  throw Error('Checked-in deployment must not enable public routes or recurring collection.');
if (config.d1_databases?.some((db) => db.database_id !== '00000000-0000-4000-8000-000000000000'))
  throw Error('Real deployment database identifiers belong in ignored local configuration.');
const lock = JSON.parse(await read('package-lock.json'));
for (const dependency of Object.values(lock.packages ?? {})) {
  if (dependency.resolved && new URL(dependency.resolved).hostname !== 'registry.npmjs.org')
    throw Error('Lockfile uses a non-public npm registry URL; review before publication.');
}
console.log(
  `Publication boundary checked: ${tracked.length} tracked source files, empty credential examples, public npm registry and inactive deployment defaults.`,
);
