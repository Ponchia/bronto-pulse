import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, stat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseVisibilitySuite,
  visibilityTemplate,
  visibilityReport,
  parseVisibilityRuns,
  targetUrlMatches,
  promptfooConfig,
} from '../src/visibility.js';
import { main } from '../src/cli.js';

const session = {
  id: 'synthetic',
  provider: 'synthetic-provider',
  product: 'synthetic-consumer-ui',
  model: 'unknown',
  date: '2026-10-23',
  searchMode: 'on',
  context: 'fresh',
  repeats: 1,
};
async function suite() {
  return parseVisibilitySuite(
    JSON.parse(
      await readFile(new URL('../examples/visibility-suite.json', import.meta.url), 'utf8'),
    ),
  );
}
test('frozen suite has 12 unbranded prompts and 3 identity controls, with English, Italian and Spanish', async () => {
  const s = await suite();
  assert.equal(s.version, '1.1.0');
  const discovery = s.prompts.filter((p) => p.kind === 'unbranded');
  assert.equal(discovery.length, 12);
  assert.equal(discovery.filter((p) => p.targetIds.includes('sense6')).length, 6);
  assert.deepEqual(
    discovery.filter((p) => p.targetIds.includes('sense6')).map((p) => p.id),
    [
      'perception-browser',
      'reaction-time',
      'tetrachromacy-limits',
      'hearing-device-limits',
      'perception-it',
      'perception-es',
    ],
  );
  for (const target of ['ui', 'annotations', 'layout'])
    assert.equal(discovery.filter((p) => p.targetIds.includes(target)).length, 2);
  assert.equal(discovery.filter((p) => p.targetIds.includes('portfolio')).length, 6);
  assert.deepEqual(
    s.prompts.filter((p) => p.kind === 'branded').map((p) => p.id),
    ['sense6-control', 'owner-portfolio-control', 'package-responsibilities-control'],
  );
  assert.deepEqual(s.targets.find((t) => t.id === 'portfolio')?.urls, [
    'https://brontolotto.observer/',
  ]);
  assert.deepEqual([...new Set(s.prompts.map((p) => p.language))].sort(), ['en', 'es', 'it']);
  for (const p of discovery) assert.doesNotMatch(p.text, /sense6|bronto|ponchia|zeno/i);
});
test('hostname and path boundaries reject lookalikes, sibling projects and unsafe URL credentials', () => {
  const target = 'https://github.com/Ponchia/bronto-ui';
  for (const candidate of [
    'https://github.com/Ponchia/bronto-ui',
    'https://github.com/Ponchia/bronto-ui/docs?a=1',
    'http://github.com/Ponchia/bronto-ui/',
  ])
    assert.equal(targetUrlMatches(candidate, target), true, candidate);
  for (const candidate of [
    'https://github.com.evil/Ponchia/bronto-ui',
    'https://evilgithub.com/Ponchia/bronto-ui',
    'https://github.com/Ponchia/bronto-ui-other',
    'https://github.com/Ponchia/bronto-annotations',
    'https://user:secret@github.com/Ponchia/bronto-ui',
    'https://github.com:8443/Ponchia/bronto-ui',
    'https://github.com/Ponchia/bronto-ui%2fevil',
    'javascript:https://github.com/Ponchia/bronto-ui',
  ])
    assert.equal(targetUrlMatches(candidate, target), false, candidate);
  assert.equal(
    targetUrlMatches(
      'https://brontolotto.observer/projects/bronto-ui/',
      'https://brontolotto.observer/',
    ),
    true,
  );
  assert.equal(
    targetUrlMatches('https://brontolotto.observer.evil/', 'https://brontolotto.observer/'),
    false,
  );
  assert.equal(targetUrlMatches('https://sense6.net/', 'https://brontolotto.observer/'), false);
});
test('offline template and promptfoo export do not execute models and carry prompt hashes', async () => {
  const s = await suite(),
    data = await visibilityTemplate(s, session);
  assert.equal(data.runs.length, 15);
  assert.ok(
    data.runs.every(
      (r) =>
        r.status === 'unrun' &&
        r.rawAnswer === null &&
        r.citations === null &&
        r.promptHash.length === 64,
    ),
  );
  const adapter = await promptfooConfig(s);
  assert.deepEqual(adapter.providers, []);
  assert.equal(adapter.tests.length, 15);
  assert.equal(adapter.tests[0]?.vars.promptHash, data.runs[0]?.promptHash);
  assert.equal(await parseVisibilityRuns(data, s).then((r) => r.runs.length), 15);
});
test('missing, unrun and error are unknown, and reports separate branded, language and product context', async () => {
  const s = await suite(),
    data = await visibilityTemplate(s, session);
  data.runs[0] = {
    ...data.runs[0]!,
    status: 'completed',
    rawAnswer: 'Try Sense6: https://sense6.net/en/',
    citations: [],
    reviews: [],
  };
  data.runs[1] = { ...data.runs[1]!, status: 'error' };
  data.runs.splice(12, 1); // Branded Sense6 control is missing, never counted as failure/zero.
  const other = await visibilityTemplate(s, {
    ...session,
    id: 'other',
    product: 'synthetic-api',
    searchMode: 'off',
  });
  data.sessions.push(...other.sessions);
  data.runs.push(...other.runs);
  const report = await visibilityReport(s, data);
  const sense6 = report.groups.find(
    (g) =>
      g.session.id === 'synthetic' &&
      g.targetId === 'sense6' &&
      g.kind === 'unbranded' &&
      g.language === 'en',
  )!;
  assert.equal(sense6.expected, 4);
  assert.equal(sense6.completed, 1);
  assert.equal(sense6.errors, 1);
  assert.deepEqual(sense6.signals.mention, { positive: 1, observed: 1, unknown: 3 });
  assert.deepEqual(sense6.signals.link, { positive: 1, observed: 1, unknown: 3 });
  assert.deepEqual(sense6.signals.citation, { positive: 0, observed: 1, unknown: 3 });
  assert.deepEqual(sense6.signals.recommendation, { positive: 0, observed: 0, unknown: 4 });
  const portfolio = report.groups.find(
    (g) => g.session.id === 'synthetic' && g.targetId === 'portfolio' && g.kind === 'unbranded',
  )!;
  assert.equal(portfolio.expected, 6);
  assert.equal(portfolio.unrun, 6);
  const branded = report.groups.find(
    (g) => g.session.id === 'synthetic' && g.targetId === 'sense6' && g.kind === 'branded',
  )!;
  assert.equal(branded.missing, 1);
  assert.equal(branded.signals.mention.observed, 0);
  assert.ok(
    report.groups.some(
      (g) => g.session.product === 'synthetic-api' && g.session.searchMode === 'off',
    ),
  );
  assert.ok(report.groups.some((g) => g.language === 'it'));
});
test('citations and reviewed labels remain distinct from mention and answer links', async () => {
  const s = await suite(),
    data = await visibilityTemplate(s, session);
  data.runs[0] = {
    ...data.runs[0]!,
    status: 'completed',
    rawAnswer: 'One option is Sense6.',
    citations: [
      { url: 'https://sense6.net/en/', evidence: 'Synthetic provider source-panel citation #1' },
    ],
    reviews: [
      {
        targetId: 'sense6',
        reviewer: 'fixture reviewer',
        reviewedAt: '2026-10-23T12:00:00Z',
        recommendation: true,
        misrepresentation: false,
        notes: 'Synthetic explicit recommendation with correct limitations.',
      },
    ],
  };
  const report = await visibilityReport(s, data);
  const g = report.groups.find(
    (g) => g.targetId === 'sense6' && g.kind === 'unbranded' && g.language === 'en',
  )!;
  assert.equal(g.signals.mention.positive, 1);
  assert.equal(g.signals.link.positive, 0);
  assert.equal(g.signals.citation.positive, 1);
  assert.equal(g.signals.recommendation.positive, 1);
  assert.equal(g.signals.misrepresentation.observed, 1);
  assert.equal(g.signals.misrepresentation.positive, 0);
});
test('portfolio discovery records the owner website without crediting an unrelated package link', async () => {
  const s = await suite(),
    data = await visibilityTemplate(s, session);
  const run = data.runs.find((r) => r.promptId === 'ui-css')!;
  run.status = 'completed';
  run.rawAnswer = 'See Zeno Trevisan at https://brontolotto.observer/ for independent projects.';
  run.citations = [];
  const report = await visibilityReport(s, data);
  const portfolio = report.groups.find(
    (g) => g.targetId === 'portfolio' && g.kind === 'unbranded',
  )!;
  const ui = report.groups.find((g) => g.targetId === 'ui' && g.kind === 'unbranded')!;
  assert.equal(portfolio.signals.mention.positive, 1);
  assert.equal(portfolio.signals.link.positive, 1);
  assert.equal(ui.signals.link.positive, 0);
});
test('a bare answer URL is a link, and alias suffixes do not become text mentions', async () => {
  const s = await suite(),
    data = await visibilityTemplate(s, session);
  data.runs[0] = {
    ...data.runs[0]!,
    status: 'completed',
    rawAnswer: 'https://sense6.net/en/ and NotSense6 are strings.',
    citations: null,
  };
  const g = (await visibilityReport(s, data)).groups.find(
    (g) => g.targetId === 'sense6' && g.kind === 'unbranded' && g.language === 'en',
  )!;
  assert.equal(g.signals.mention.positive, 0);
  assert.equal(g.signals.link.positive, 1);
  assert.equal(g.signals.citation.observed, 0);
});
test('hash drift, inconsistent metadata, duplicates and contradictory manual labels refuse scoring', async () => {
  const s = await suite(),
    base = await visibilityTemplate(s, session);
  const modified = structuredClone(base);
  modified.runs[0]!.promptHash = '0'.repeat(64);
  await assert.rejects(visibilityReport(s, modified), /hash mismatch/);
  const changedSuite = structuredClone(s);
  changedSuite.prompts[0]!.text += 'Changed.';
  await assert.rejects(visibilityReport(changedSuite, base), /hash mismatch/);
  const wrongLanguage = structuredClone(base);
  wrongLanguage.runs[0]!.language = 'es';
  await assert.rejects(visibilityReport(s, wrongLanguage), /metadata/);
  const duplicate = structuredClone(base);
  duplicate.runs.push(duplicate.runs[0]!);
  await assert.rejects(visibilityReport(s, duplicate), /Duplicate/);
  const manual = structuredClone(base);
  manual.runs[0] = {
    ...manual.runs[0]!,
    status: 'completed',
    rawAnswer: 'No suitable project was found.',
    citations: [],
    reviews: [
      {
        targetId: 'sense6',
        reviewer: 'fixture',
        reviewedAt: '2026-10-23T12:00:00Z',
        recommendation: true,
        misrepresentation: null,
        notes: 'Contradictory synthetic label.',
      },
    ],
  };
  await assert.rejects(visibilityReport(s, manual), /Positive manual labels/);
  manual.runs[0]!.rawAnswer = 'Try Sense6.';
  manual.runs[0]!.reviews.push({ ...manual.runs[0]!.reviews[0]!, recommendation: false });
  await assert.rejects(visibilityReport(s, manual), /Duplicate visibility manual review/);
  const wrongStatus = structuredClone(base);
  wrongStatus.runs[0]!.rawAnswer = 'Unrun with answer';
  await assert.rejects(visibilityReport(s, wrongStatus), /Contradictory/);
});
test('operator CLI works without project config/database, writes privately and refuses overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-visibility-'));
  try {
    const metadata = join(dir, 'session.json'),
      out = join(dir, 'runs.json'),
      report = join(dir, 'report.json');
    await writeFile(metadata, JSON.stringify(session));
    const suitePath = new URL('../examples/visibility-suite.json', import.meta.url).pathname;
    assert.equal(
      await main([
        'visibility',
        'template',
        '--suite',
        suitePath,
        '--session',
        metadata,
        '--out',
        out,
        '--config',
        join(dir, 'absent.json'),
        '--db',
        join(dir, 'absent.db'),
      ]),
      0,
    );
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    await assert.rejects(stat(join(dir, 'absent.db')), /ENOENT/);
    assert.equal(
      await main(['visibility', 'report', '--suite', suitePath, '--input', out, '--out', report]),
      0,
    );
    await assert.rejects(
      main(['visibility', 'template', '--suite', suitePath, '--session', metadata, '--out', out]),
      /EEXIST/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
