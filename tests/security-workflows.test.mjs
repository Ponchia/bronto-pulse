import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) =>
  readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
const codeql = read('codeql.yml');
const review = read('dependency-review.yml');

function assertReadOnlySource(workflow) {
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(
    workflow,
    /pull_request_target:|workflow_run:|secrets\.|write-all|contents: write|id-token: write|packages: write/,
  );
  assert.doesNotMatch(workflow, /^\s+(?:-\s+)?(?:run|continue-on-error|paths|paths-ignore):/m);
  assert.match(workflow, /persist-credentials: false/);
  for (const line of workflow.split('\n').filter((line) => /\buses:/.test(line))) {
    assert.match(line, /uses: [A-Za-z0-9_./-]+@[a-f0-9]{40}(?:\s|$)/, line);
  }
}

test('scheduled source and workflow scans retain the existing required source-check name', () => {
  assertReadOnlySource(codeql);
  assert.match(codeql, /name: CodeQL source scan/);
  assert.match(codeql, /name: CodeQL workflow scan/);
  assert.match(codeql, /languages: javascript-typescript/);
  assert.match(codeql, /languages: actions/);
  assert.match(codeql, /category: \/language:actions/);
  assert.match(codeql, /schedule:\n {4}- cron:/);
  assert.equal((codeql.match(/codeql-action\/analyze@/g) ?? []).length, 2);
  assert.equal((codeql.match(/build-mode: none/g) ?? []).length, 2);
});

test('dependency review blocks known high/critical changes in all scopes without private access', () => {
  assertReadOnlySource(review);
  assert.match(review, /pull_request:\n {4}branches: \[main\]/);
  assert.match(review, /name: Review dependency changes/);
  assert.match(review, /fail-on-severity: high/);
  assert.match(review, /warn-only: false/);
  assert.doesNotMatch(review, /allow-ghsas|fail-on-scopes|security-events: write/);
});

test('security-policy negative controls reject elevated triggers, scripts and floating action refs', () => {
  assert.throws(() =>
    assertReadOnlySource(review.replace('pull_request:', 'pull_request_target:')),
  );
  assert.throws(() => assertReadOnlySource(review.replace('contents: read', 'contents: write')));
  assert.throws(() => assertReadOnlySource(`${review}\n      - run: npm ci\n`));
  assert.throws(() =>
    assertReadOnlySource(review.replace(/@a1d282b36b6f3519aa1f3fc636f609c47dddb294/, '@v5')),
  );
});
