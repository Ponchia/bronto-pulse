import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, database, now, window } from './helpers.js';
import { collected, entry } from '../src/collectors/context.js';
import type { Observation } from '../src/model.js';
import type { Config } from '../src/config.js';
import type { Store } from '../src/storage/store.js';
import { projectReport } from '../src/report.js';
import { projectBrief, markdownBrief } from '../src/brief.js';
import { csvReport, csvCell } from '../src/report-export.js';
import { planCollection } from '../src/plan.js';
import { reportRange } from '../src/time.js';
import { probe, sync, doctor } from '../src/sync.js';
import { validateCollected } from '../src/validation.js';

async function put(
  s: Store,
  c: Config,
  group: string,
  rows: Observation[],
  from = '2026-10-10',
  to = '2026-10-13',
  at = now,
) {
  const resource = c.resources[0]!,
    key = `${resource.id}:${group}`,
    owner = crypto.randomUUID();
  assert.equal(await s.acquire(key, owner), true);
  const id = await s.begin(resource, group, { from, to }, at);
  try {
    await s.publish(id, resource, group, collected({ from, to }, rows), key, owner, 1, at, 1000);
  } finally {
    await s.release(key, owner);
  }
  return id;
}
const four = (metric: string, quality: Observation['quality'] = 'observed') =>
  ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'].map((d, i) =>
    entry(metric, d, 10 + i, {}, i > 1 ? quality : 'observed'),
  );

test('snapshot reports compute net changes using dated baselines, never gross gains', async () => {
  const c = fixture('github', { groups: ['repository'] }),
    s = await database(c);
  try {
    await put(s, c, 'repository', [
      { ...entry('github.stars', '2026-10-11', 15), kind: 'snapshot' },
      { ...entry('github.stars', '2026-10-13', 12), kind: 'snapshot' },
    ]);
    const r = await projectReport(c, s, 'project', window, now),
      card = r.cards.find((x) => x.metric === 'github.stars')!;
    assert.equal(card.comparison.absoluteChange, -3);
    assert.equal(card.comparison.relativeChange, null);
    assert.equal(card.comparison.kind, 'net_change');
    assert.deepEqual(card.comparison.baselinePeriod, { from: '2026-10-11', to: '2026-10-11' });
    assert.match(card.comparison.reason, /not gross/);
    assert.equal(card.coverage.status, 'partial');
    const f = projectBrief(r).findings.find((x) => x.kind === 'change');
    assert.match(f!.message, /decreased by 3/);
    assert.equal(f!.evidence.absoluteChange, -3);
  } finally {
    s.driver.close?.();
  }
});
test('snapshots too far from the requested end do not establish net growth', async () => {
  const c = fixture('github', { groups: ['repository'] }),
    s = await database(c);
  try {
    await put(
      s,
      c,
      'repository',
      [
        { ...entry('github.stars', '2026-10-04', 10), kind: 'snapshot' },
        { ...entry('github.stars', '2026-10-08', 12), kind: 'snapshot' },
      ],
      '2026-10-01',
      '2026-10-14',
    );
    const r = await projectReport(c, s, 'project', { from: '2026-10-08', to: '2026-10-14' }, now);
    assert.equal(r.cards.find((x) => x.metric === 'github.stars')!.comparison.absoluteChange, null);
  } finally {
    s.driver.close?.();
  }
});
for (const quality of ['sampled', 'provisional', 'provider_limited'] as const)
  test(`${quality} data remains visible without an unqualified growth claim`, async () => {
    const c = fixture('github', { groups: ['views'] }),
      s = await database(c);
    try {
      await put(s, c, 'views', four('github.views', quality));
      const r = await projectReport(c, s, 'project', window, now),
        card = r.cards.find((x) => x.metric === 'github.views')!;
      assert.equal(card.value, 25);
      assert.equal(card.comparison.absoluteChange, null);
      assert.match(card.comparison.reason, /Provisional, sampled/);
      assert.ok(projectBrief(r).findings.some((x) => x.kind === 'quality'));
      assert.ok(!projectBrief(r).findings.some((x) => x.kind === 'change'));
    } finally {
      s.driver.close?.();
    }
  });
test('complete observed counts compare equal periods while a single missing date withholds change', async () => {
  const c = fixture('github', { groups: ['views'] }),
    s = await database(c);
  try {
    await put(s, c, 'views', four('github.views'));
    let r = await projectReport(c, s, 'project', window, now);
    assert.equal(r.cards.find((x) => x.metric === 'github.views')!.comparison.absoluteChange, 4);
    assert.equal(
      r.cards.find((x) => x.metric === 'github.views')!.comparison.kind,
      'period_change',
    );
    await put(
      s,
      c,
      'views',
      four('github.views').filter((x) => x.from !== '2026-10-13'),
    );
    r = await projectReport(c, s, 'project', window, now);
    assert.equal(r.cards.find((x) => x.metric === 'github.views')!.comparison.absoluteChange, null);
    assert.ok(projectBrief(r).findings.some((x) => x.kind === 'coverage'));
  } finally {
    s.driver.close?.();
  }
});
test('a mapping effective mid-period cannot claim equal-period growth', async () => {
  const c = fixture('github', { groups: ['views'] });
  c.projects[0]!.resources[0]!.effectiveFrom = '2026-10-11';
  const s = await database(c);
  try {
    await put(s, c, 'views', four('github.views'));
    const r = await projectReport(c, s, 'project', window, now);
    assert.equal(r.cards.find((x) => x.metric === 'github.views')!.comparison.absoluteChange, null);
    const future = structuredClone(c);
    future.projects[0]!.resources[0]!.effectiveFrom = '2026-10-15';
    assert.equal((await projectReport(future, s, 'project', window, now)).cards.length, 0);
  } finally {
    s.driver.close?.();
  }
});
test('unavailable data is not mislabeled as sampled, and briefing has a bounded fallback', async () => {
  const c = fixture(),
    s = await database(c);
  try {
    const r = await projectReport(c, s, 'project', window, now);
    assert.ok(r.cards.every((c) => !c.comparison.reason.startsWith('Provisional')));
    const b = projectBrief(r, 1);
    assert.equal(b.findings.length, 1);
    assert.ok(b.omittedFindings > 0);
    assert.throws(() => projectBrief(r, 0));
    assert.match(markdownBrief(projectBrief(r)), /No supported non-zero change/);
  } finally {
    s.driver.close?.();
  }
});
test('briefings are deterministic and escape unsafe Markdown labels', async () => {
  const c = fixture(),
    s = await database(c);
  try {
    const r = await projectReport(c, s, 'project', window, now);
    r.project.label = '<script>\n[bad](data:evil)';
    assert.deepEqual(projectBrief(r), projectBrief(r));
    const md = markdownBrief(projectBrief(r));
    assert.ok(!md.includes('<script>'));
    assert.ok(!md.includes('[bad]'));
  } finally {
    s.driver.close?.();
  }
});
test('CSV preserves unknown cells, metric units, quality and scope', async () => {
  const c = fixture(),
    s = await database(c);
  try {
    const r = await projectReport(c, s, 'project', window, now);
    const csv = csvReport(r);
    assert.match(csv, /"timezone","scope","methodology","value"/);
    assert.match(csv, /"unavailable"/);
    assert.ok(csv.endsWith('\r\n'));
  } finally {
    s.driver.close?.();
  }
});
for (const value of ['=SUM(A1:A9)', '+cmd', '-danger', '@formula', ' \t=SUM(1)', '\r=bad'])
  test(`CSV neutralizes formula-leading text ${JSON.stringify(value)}`, () =>
    assert.ok(csvCell(value).startsWith('"\'')));
test('CSV quotes delimiters and newlines while preserving signed numeric cells', () => {
  assert.equal(csvCell('one,"two"\nthree'), '"one,""two""\nthree"');
  assert.equal(csvCell(-3), '"-3"');
  assert.equal(csvCell(null), '""');
  assert.throws(() => csvCell(Infinity));
});
test('report period defaults exclude today and anchor days to the requested end', () => {
  assert.deepEqual(reportRange({ days: 2 }, now), window);
  assert.deepEqual(reportRange({ to: '2026-09-14', days: 2 }, now), {
    from: '2026-09-13',
    to: '2026-09-14',
  });
  assert.throws(() => reportRange({ days: 367 }, now));
  assert.throws(() => reportRange({ to: '2026-02-31' }, now));
});
test('planning clips GitHub history and snapshots are planned once, not per historical chunk', () => {
  const c = fixture();
  const plan = planCollection(c, {
    now,
    window: { from: '2026-09-01', to: '2026-10-13' },
    chunkDays: 7,
    maxJobs: 100,
  });
  assert.equal(plan.jobs.filter((x) => x.group === 'repository').length, 1);
  assert.equal(plan.jobs.filter((x) => x.group === 'referrers').length, 1);
  assert.ok(
    plan.jobs.filter((x) => x.group === 'views').every((x) => x.window.from >= '2026-10-01'),
  );
  assert.ok(plan.notices.some((x) => x.includes('cannot be recovered')));
  assert.equal(plan.readOnly, true);
});
test('plans have no duplicate boundaries and report omitted work explicitly', () => {
  const c = fixture('npm');
  const plan = planCollection(c, {
    now,
    window: { from: '2026-10-01', to: '2026-10-20' },
    chunkDays: 3,
    maxJobs: 2,
  });
  assert.equal(plan.totalJobs, 5);
  assert.equal(plan.omittedJobs, 3);
  assert.deepEqual(
    plan.jobs.map((x) => x.window),
    [
      { from: '2026-10-01', to: '2026-10-03' },
      { from: '2026-10-04', to: '2026-10-06' },
    ],
  );
  assert.ok(plan.notices.some((x) => x.includes('unpublished')));
});
test('planning respects Pacific dates and rejects invalid filters and budgets', () => {
  const c = fixture('gsc'),
    p = planCollection(c, { now: new Date('2026-10-14T01:00:00Z'), maxJobs: 1 });
  assert.equal(p.jobs[0]!.timezone, 'America/Los_Angeles');
  assert.ok(p.jobs[0]!.window.to <= '2026-10-12');
  for (const bad of [
    { resourceId: 'missing' },
    { group: 'bogus' },
    { maxJobs: 0 },
    { chunkDays: -1 },
    { chunkDays: 367 },
  ])
    assert.throws(() => planCollection(c, { now, ...bad }));
});
test('out-of-retention plan returns no invented GitHub backfill jobs', () => {
  const p = planCollection(fixture('github', { groups: ['views'] }), {
    now,
    window: { from: '2025-10-01', to: '2025-10-02' },
  });
  assert.equal(p.jobs.length, 0);
  assert.ok(p.notices.some((x) => x.includes('no provider-retrievable')));
});
test('probe exercises the configured groups independently without claiming whole-resource access', async () => {
  const c = fixture('github', { groups: ['repository', 'views'] });
  const paths: string[] = [];
  const result = await probe(
    c,
    { TEST_TOKEN: 'synthetic' },
    {
      now,
      fetcher: async (input) => {
        paths.push(String(input));
        return String(input).includes('/traffic/')
          ? new Response('{}', { status: 403 })
          : Response.json({ id: 1, stargazers_count: 2, forks_count: 0, open_issues_count: 0 });
      },
    },
  );
  assert.deepEqual(
    result.results.map((x) => [x.testedGroup, x.status]),
    [
      ['repository', 'available'],
      ['views', 'unavailable'],
    ],
  );
  assert.equal(paths.length, 2);
  const limited = await probe(
    c,
    { TEST_TOKEN: 'synthetic' },
    {
      now,
      maxJobs: 1,
      fetcher: async () =>
        Response.json({ id: 1, stargazers_count: 2, forks_count: 0, open_issues_count: 0 }),
    },
  );
  assert.equal(limited.omittedJobs, 1);
});
test('invalid sync job budget is rejected before a source request', async () => {
  const c = fixture(),
    s = await database(c);
  let calls = 0;
  try {
    await assert.rejects(
      sync(
        c,
        s,
        {},
        {
          maxJobs: -1,
          fetcher: async () => {
            calls++;
            return Response.json({});
          },
        },
      ),
      /bound/,
    );
    assert.equal(calls, 0);
    assert.equal((await s.runs()).length, 0);
  } finally {
    s.driver.close?.();
  }
});
test('a begin-run failure releases its lease rather than blocking future collection', async () => {
  const c = fixture('github', { groups: ['repository'] }),
    s = await database(c);
  const begin = s.begin.bind(s);
  try {
    s.begin = async () => {
      throw new Error('synthetic DB write failure');
    };
    const result = await sync(c, s, {}, { now });
    assert.equal(result[0]!.status, 'failed');
    assert.equal(await s.acquire('source:repository', 'next'), true);
    await s.release('source:repository', 'next');
    s.begin = begin;
  } finally {
    s.driver.close?.();
  }
});
test('health separates successful fetch time from data lag and gives a targeted next action', async () => {
  const c = fixture('github', { groups: ['views'] }),
    s = await database(c);
  try {
    await put(s, c, 'views', [entry('github.views', '2026-10-10', 10)]);
    const h = await doctor(c, s, { TEST_TOKEN: 'synthetic' }, now),
      row = h.resources[0]!;
    assert.equal(row.status, 'lagging');
    assert.equal(row.observedThrough, '2026-10-10');
    assert.equal(row.dataLagDays, 4);
    assert.match(row.nextAction.message, /Requests are succeeding/);
  } finally {
    s.driver.close?.();
  }
});
test('never-completed skipped runs cannot be labeled healthy and old runs are interrupted', async () => {
  const c = fixture('npm'),
    s = await database(c);
  try {
    const id = await s.begin(c.resources[0]!, 'downloads', window, now);
    await s.fail(id, 'CONFLICT', 'skipped', 0, now, 'skipped');
    assert.equal((await doctor(c, s, {}, now)).resources[0]!.status, 'never_collected');
    await s.begin(c.resources[0]!, 'downloads', window, new Date('2026-10-14T13:00:00Z'));
    assert.equal(
      (await doctor(c, s, {}, new Date('2026-10-14T15:00:00Z'))).resources[0]!.status,
      'interrupted',
    );
  } finally {
    s.driver.close?.();
  }
});
test('public GitHub metadata does not demand traffic credentials', async () => {
  const c = fixture('github', { connection: undefined, groups: ['repository'] }),
    s = await database(c);
  try {
    assert.equal((await doctor(c, s, {}, now)).resources[0]!.credentials.available, true);
  } finally {
    s.driver.close?.();
  }
});
test('weighted observation contracts reject absent or inconsistent denominators', () => {
  const base = entry('gsc.ctr', '2026-10-12', 0.1);
  assert.throws(() => validateCollected(collected(window, [base]), 'gsc', 10));
  assert.throws(() =>
    validateCollected(collected(window, [{ ...base, numerator: 1, denominator: 2 }]), 'gsc', 10),
  );
  assert.doesNotThrow(() =>
    validateCollected(collected(window, [{ ...base, numerator: 1, denominator: 10 }]), 'gsc', 10),
  );
});

test('pinned repository identity is checked before accepting traffic from a reused name', async () => {
  const { collectGithub } = await import('../src/collectors/github.js');
  const { ctx } = await import('./helpers.js');
  const c = fixture('github', { repositoryId: 123, groups: ['views'] });
  await assert.rejects(
    collectGithub(
      c.resources[0] as Extract<(typeof c.resources)[number], { provider: 'github' }>,
      'views',
      ctx(c, [{ id: 456 }]),
    ),
    /pinned resource/,
  );
});
test('same-timestamp health events use insertion order rather than random run IDs', async () => {
  const c = fixture('npm'),
    s = await database(c);
  try {
    await put(s, c, 'downloads', [entry('npm.downloads', '2026-10-13', 1)]);
    const id = await s.begin(c.resources[0]!, 'downloads', window, now);
    await s.fail(id, 'RATE_LIMIT', 'synthetic rate limit', 1, now);
    const health = await doctor(c, s, {}, now);
    assert.equal(health.resources[0]!.status, 'failed');
    assert.match(health.resources[0]!.nextAction.message, /reset window/);
  } finally {
    s.driver.close?.();
  }
});

test('portable recovery preserves latest-run ordering when timestamps coincide', async () => {
  const { Store } = await import('../src/storage/store.js');
  const { SqliteDriver } = await import('../src/storage/sqlite.js');
  const c = fixture('npm'),
    a = await database(c),
    b = new Store(new SqliteDriver(':memory:'));
  try {
    await put(a, c, 'downloads', [entry('npm.downloads', '2026-10-13', 3)]);
    const id = await a.begin(c.resources[0]!, 'downloads', window, now);
    await a.fail(id, 'RATE_LIMIT', 'synthetic', 1, now);
    const archive = await a.export();
    await b.migrate();
    await b.import(archive);
    assert.deepEqual(await doctor(c, a, {}, now), await doctor(c, b, {}, now));
  } finally {
    a.driver.close?.();
    b.driver.close?.();
  }
});
