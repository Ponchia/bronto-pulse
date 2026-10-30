import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const release = read('.github/workflows/release.yml');
const ci = read('.github/workflows/ci.yml');
const docs = read('docs/releasing.md');
const pkg = JSON.parse(read('package.json'));
const slice = (workflow: string, name: string, next?: string) =>
  workflow.slice(
    workflow.indexOf(`  ${name}:\n`),
    next ? workflow.indexOf(`  ${next}:\n`) : undefined,
  );
const job = (name: string, next?: string) => slice(release, name, next);
const sparse = (block: string) =>
  [...block.matchAll(/sparse-checkout: \|\n((?: {12}\S[^\n]*\n)+)/g)].map((m) =>
    m[1]!.trim().split(/\s+/),
  );
const publisherFiles = [
  '/scripts/source-publisher.mjs',
  '/scripts/extract-publisher-source.py',
  '/scripts/audit-publishing-tooling.mjs',
  '/tooling/publisher/',
];

test('npm releases start only from a beta tag on main after the full CI', () => {
  assert.match(release, /on:\n {2}push:\n {4}tags:\n {6}- 'v\*-beta\.\*'\n/);
  assert.doesNotMatch(release, /pull_request|workflow_dispatch|branches:/);
  assert.match(ci, /\n {2}workflow_call:\n/);
  assert.match(job('verify', 'preflight'), /uses: \.\/\.github\/workflows\/ci\.yml/);
  const preflight = job('preflight', 'publish-npm');
  assert.match(preflight, /needs: verify\n/);
  assert.match(
    preflight,
    /git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/,
  );
  assert.match(preflight, /This version already exists in npm/);
  assert.match(preflight, /is not bootstrapped on npm/);
  assert.match(preflight, /npm run package:check/);
  assert.match(preflight, /npm ci --ignore-scripts/);
});

test('every CI run audits the publisher read-only, before any release reaches OIDC', () => {
  const audit = slice(ci, 'publisher');
  assert.match(ci, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(audit, /\n {4}(?:if|needs|permissions|environment):/);
  assert.doesNotMatch(audit, /id-token|secrets\.|\bnpm (?:install|ci|publish)\b/);
  assert.deepEqual(sparse(audit), [publisherFiles]);
  assert.match(audit, /source-publisher\.mjs prepare "\$RUNNER_TEMP\/pulse-publisher"/);
  assert.match(audit, /source-publisher\.mjs audit "\$RUNNER_TEMP\/pulse-publisher"/);
});

test('only the audited source-locked publisher reaches OIDC, never the runner npm', () => {
  assert.doesNotMatch(release, /publisher-readiness:/);
  const publish = job('publish-npm', 'verify-registry');
  assert.match(publish, /needs: preflight\n/);
  assert.match(publish, /environment: npm-publish\n/);
  assert.match(publish, /permissions:\n\s+contents: read\n\s+id-token: write\n/);
  assert.deepEqual(
    sparse(publish),
    [publisherFiles],
    'The OIDC job checks out publisher tooling only',
  );
  assert.equal(publish.match(/actions\/checkout@/g)?.length, 1);
  assert.ok(publish.indexOf('source-publisher.mjs audit') < publish.indexOf('npm-cli.js" publish'));
  assert.match(
    publish,
    /node "\$RUNNER_TEMP\/pulse-publisher\/source\/bin\/npm-cli\.js" publish "\.\/\$TARBALL" --ignore-scripts --provenance --access public --tag beta/,
  );
  assert.doesNotMatch(
    publish,
    /^\s*npm (?:publish|ci|install)\b|node scripts\/|if:|continue-on-error:/m,
  );
  const verify = job('verify-registry');
  assert.doesNotMatch(verify, /id-token:|environment:|npm-cli\.js|npm publish/);
  assert.match(verify, /dist\?\.integrity !== integrity/);
  assert.match(verify, /dist\?\.attestations\?\.provenance/);
});

test('the package publishes publicly under beta, with one version source', () => {
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.publishConfig, { access: 'public', tag: 'beta' });
  assert.match(pkg.version, /^\d+\.\d+\.\d+-beta\.\d+$/);
  assert.equal(pkg.scripts['publisher:readiness'], 'node scripts/source-publisher.mjs readiness');
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), pkg.version);
  assert.match(docs, /## First npm publication/);
  assert.match(docs, /"\$NPM_CLI" publish "\$TARBALL" --ignore-scripts --access public --tag beta/);
  assert.match(docs, /\| Workflow +\| `release\.yml` +\|/);
});
