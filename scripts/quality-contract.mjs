import { readFile, readdir } from 'node:fs/promises';
const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
for (const name of await readdir(new URL('../.github/workflows/', import.meta.url))) {
  if (!/\.ya?ml$/.test(name)) continue;
  const workflow = await read('.github/workflows/' + name);
  if (/pull_request_target|self-hosted|PULSE_RUNNER|\bsecrets\s*[.\[]/.test(workflow))
    throw Error('Public source workflows must not access private runners or provider secrets.');
  const runners = [...workflow.matchAll(/^\s*runs-on:\s*(.+)$/gm)];
  if (!runners.length || runners.some((match) => match[1].trim() !== 'ubuntu-24.04'))
    throw Error('All workflows must use the standard GitHub-hosted ubuntu-24.04 label.');
  if (!workflow.includes('persist-credentials: false'))
    throw Error('CI must not retain checkout credentials.');
  // A same-repository reusable workflow runs from the same commit, so it has no pin.
  for (const match of workflow.matchAll(/uses:\s+([^\s#]+)/g))
    if (
      !/^\.\/\.github\/workflows\/[\w.-]+\.ya?ml$/.test(match[1]) &&
      !/^[^@]+@[a-f0-9]{40}$/.test(match[1])
    )
      throw Error('Actions must use immutable commit pins.');
  // Reviewed exception: release.yml hands one checked archive to its publish job.
  if (
    /\bactions\/cache\//.test(workflow) ||
    (name !== 'release.yml' && /\bupload-artifact@/.test(workflow))
  )
    throw Error('Public artifacts and custom cache behavior require explicit review.');
}
const pkg = JSON.parse(await read('package.json'));
// npm distribution was decided on 30 Oct 2026: betas only, through the reviewed
// release workflow and the source-locked publisher, never a manual `latest`.
if (pkg.private || pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.tag !== 'beta')
  throw Error('Publish publicly under the beta dist-tag only, through the release workflow.');
const release = await read('.github/workflows/release.yml');
for (const required of [
  'environment: npm-publish',
  'id-token: write',
  'npm-cli.js" publish',
  '--provenance',
  '--tag beta',
])
  if (!release.includes(required)) throw Error('Release workflow lacks: ' + required);
if (/^\s*npm publish\b|NODE_AUTH_TOKEN|NPM_TOKEN/m.test(release))
  throw Error('Only the source-locked publisher may publish, through OIDC.');
for (const check of ['schema:check', 'package:check', 'publication:check'])
  if (!pkg.scripts.check.includes(check)) throw Error('Missing required check: ' + check);
for (const path of [
  'tests/cli-workflows.test.ts',
  'tests/operator-reporting.test.ts',
  'tests/browser/dashboard.spec.ts',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  '.github/SUPPORT.md',
  '.github/workflows/codeql.yml',
])
  await read(path);
console.log(
  'Standard public CI, private-data boundaries, pinned actions and beta-only npm release contracts passed.',
);
