import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
const root = resolve(new URL('..', import.meta.url).pathname);
async function walk(dir) {
  const results = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (
      [
        'node_modules',
        '.git',
        'dist',
        '.pulse',
        'artifacts',
        'test-results',
        'playwright-report',
      ].includes(e.name)
    )
      continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) results.push(...(await walk(p)));
    else results.push(p);
  }
  return results;
}
const files = await walk(root);
if (files.some((x) => /CLAUDE\.md$/.test(x))) throw Error('Use AGENTS.md only.');
for (const required of ['README.md', 'AGENTS.md', 'SECURITY.md', 'docs/README.md'])
  await stat(resolve(root, required));
for (const file of files.filter((x) => x.endsWith('.md'))) {
  const text = await readFile(file, 'utf8');
  const name = relative(root, file);
  if (
    name.startsWith('docs/') &&
    !/Lifecycle: (current|proposal|archive|generated\/reference|tombstone)/.test(text)
  )
    throw Error(`Missing lifecycle: ${name}`);
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const path = match[1].split('#')[0];
    if (!path || /^(https?:|mailto:)/.test(path)) continue;
    const target = resolve(dirname(file), path);
    if (!target.startsWith(root + '/')) throw Error(`Link leaves repository: ${name}`);
    await stat(target).catch(() => {
      throw Error(`Missing target ${path} in ${name}`);
    });
  }
}
const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
for (const m of workflow.matchAll(/uses:\s+([^\s#]+)/g))
  if (!/^[^@]+@[a-f0-9]{40}$/.test(m[1]))
    throw Error('GitHub Actions must be pinned to immutable commits.');
console.log('Documentation lifecycle, local links, agent contract and workflow pin checks passed.');
