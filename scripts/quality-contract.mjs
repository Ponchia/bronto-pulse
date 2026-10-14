import { readFile } from 'node:fs/promises';
const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const workflow = await read('.github/workflows/ci.yml');
if (/pull_request_target/.test(workflow))
  throw Error('Untrusted code must not use elevated pull_request_target.');
if (!workflow.includes('persist-credentials: false'))
  throw Error('CI must not retain checkout credentials.');
if (
  !workflow.includes('github.event.repository.private') ||
  !workflow.includes('github.event.pull_request.head.repo.full_name == github.repository')
)
  throw Error('Trusted runner selection must check private visibility and PR origin.');
const pkg = JSON.parse(await read('package.json'));
if (pkg.private !== true) throw Error('Publication remains an explicit release decision.');
if (!pkg.scripts.check.includes('schema:check') || !pkg.scripts.check.includes('package:check'))
  throw Error('Generated and installed consumer contracts must be required checks.');
for (const path of [
  'tests/cli-workflows.test.ts',
  'tests/operator-reporting.test.ts',
  'tests/browser/dashboard.spec.ts',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
])
  await read(path);
console.log(
  'Repository privacy, trusted-runner routing, consumer packaging and test-suite contracts passed.',
);
