import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { consumerInstallation } from './package-consumer-lock.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'pulse-package-contract-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
}
try {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const result = JSON.parse(
    run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', dir]),
  )[0];
  const files = result.files.map((f) => f.path);
  for (const path of files) {
    if (
      !/^(dist\/|web\/|migrations\/|examples\/|schemas\/|docs\/|SECURITY\.md$|CHANGELOG\.md$|CONTRIBUTING\.md$|README\.md$|LICENSE$|package\.json$)/.test(
        path,
      )
    )
      throw Error('Unexpected package entry: ' + path);
    if (
      /(^|\/)(\.pulse|\.env|node_modules|reports|artifacts|test-results)(\/|$)|\.(db|sqlite|pem|key)$/.test(
        path,
      )
    )
      throw Error('Private runtime material in package.');
  }
  for (const path of [
    'dist/cli.js',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/worker.js',
    'web/index.html',
    'examples/quickstart.json',
    'migrations/0001_initial.sql',
    'schemas/config.schema.json',
  ])
    if (!files.includes(path)) throw Error('Package is missing ' + path);
  const sourceLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const { consumer, lock } = consumerInstallation(
    manifest,
    result,
    join(dir, result.filename),
    sourceLock,
  );
  await writeFile(join(dir, 'package.json'), JSON.stringify(consumer));
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock));
  // npm ci populated integrity-checked tarballs, but need not have cached the
  // registry packument. A locked install avoids that hidden warm-cache dependency.
  run(npm, ['ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], dir);
  const installed = resolve(dir, 'node_modules', manifest.name);
  const exports = JSON.parse(
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const p=await import(${JSON.stringify(manifest.name)}); console.log(JSON.stringify(Object.keys(p)))`,
      ],
      dir,
    ),
  );
  for (const key of ['projectBrief', 'csvReport', 'planCollection'])
    if (!exports.includes(key)) throw Error('Missing installed API: ' + key);
  const help = run(process.execPath, [join(installed, 'dist/cli.js'), '--help'], dir);
  for (const command of ['pulse plan', 'pulse brief', 'pulse backfill'])
    if (!help.includes(command)) throw Error('Installed CLI help is incomplete.');
  run(process.execPath, [join(installed, 'dist/cli.js'), 'init'], dir);
  run(process.execPath, [join(installed, 'dist/cli.js'), 'validate', '--json'], dir);
  console.log(
    `Package verified: ${files.length} allowlisted files; clean offline consumer imports and CLI init/validate pass. No registry publication.`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
