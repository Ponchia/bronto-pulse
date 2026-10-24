import { z } from 'zod';
import { pathMatches } from './config.js';
import { PulseError } from './errors.js';

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const label = z.string().trim().min(1).max(200);
const url = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      return false;
    }
  });
export const visibilitySuiteSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    version: label,
    targets: z
      .array(
        z
          .object({ id, aliases: z.array(label).min(1).max(20), urls: z.array(url).min(1).max(20) })
          .strict(),
      )
      .min(1)
      .max(20),
    prompts: z
      .array(
        z
          .object({
            id,
            kind: z.enum(['unbranded', 'branded']),
            language: z.enum(['en', 'it', 'es']),
            text: z.string().min(1).max(10000),
            targetIds: z.array(id).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type VisibilitySuite = z.infer<typeof visibilitySuiteSchema>;
const sessionSchema = z
  .object({
    id,
    provider: label,
    product: label,
    model: label,
    date: z.iso.date(),
    searchMode: z.enum(['on', 'off', 'unknown']),
    context: z.enum(['fresh', 'continuing', 'unknown']),
    repeats: z.number().int().min(1).max(10),
  })
  .strict();
const runSchema = z
  .object({
    sessionId: id,
    promptId: id,
    promptHash: z.string().regex(/^[a-f0-9]{64}$/),
    language: z.enum(['en', 'it', 'es']),
    repeat: z.number().int().min(1).max(10),
    status: z.enum(['completed', 'unrun', 'error']),
    rawAnswer: z.string().max(200000).nullable(),
    citations: z
      .array(z.object({ url: z.url().max(2048), evidence: z.string().min(1).max(2000) }).strict())
      .max(200)
      .nullable(),
    reviews: z
      .array(
        z
          .object({
            targetId: id,
            reviewer: label,
            reviewedAt: z.iso.datetime(),
            recommendation: z.boolean().nullable(),
            misrepresentation: z.boolean().nullable(),
            notes: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export const visibilityRunsSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteId: id,
    suiteVersion: label,
    sessions: z.array(sessionSchema).min(1).max(100),
    runs: z.array(runSchema).max(10000),
  })
  .strict();
export type VisibilityRuns = z.infer<typeof visibilityRunsSchema>;
export type VisibilitySession = z.infer<typeof sessionSchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown, kind: string): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new PulseError(
      'CONFIG',
      `Invalid visibility ${kind}; consult its versioned schema. No input content was echoed.`,
    );
  return result.data;
}
function unique(values: string[], kind: string): void {
  if (new Set(values).size !== values.length)
    throw new PulseError('CONFIG', `Duplicate visibility ${kind}.`);
}
export function parseVisibilitySuite(input: unknown): VisibilitySuite {
  const suite = parse(visibilitySuiteSchema, input, 'suite');
  unique(
    suite.targets.map((t) => t.id),
    'target',
  );
  unique(
    suite.prompts.map((p) => p.id),
    'prompt',
  );
  for (const prompt of suite.prompts) {
    unique(prompt.targetIds, 'prompt target');
    if (prompt.targetIds.some((id) => !suite.targets.some((t) => t.id === id)))
      throw new PulseError('CONFIG', 'Unknown visibility prompt target.');
  }
  return suite;
}
/** Includes classification/language/targets, so editing a control cannot silently reuse old runs. */
export async function promptHash(prompt: VisibilitySuite['prompts'][number]): Promise<string> {
  const value = JSON.stringify([
    prompt.id,
    prompt.kind,
    prompt.language,
    prompt.text,
    prompt.targetIds,
  ]);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
export function targetUrlMatches(candidate: string, target: string): boolean {
  try {
    const u = new URL(candidate),
      t = new URL(target);
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      u.hostname === t.hostname &&
      u.port === t.port &&
      !/%(?:2f|5c|2e)/i.test(u.pathname) &&
      pathMatches(u.pathname, t.pathname)
    );
  } catch {
    return false;
  }
}
function mentions(answer: string, aliases: string[]): boolean {
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(answer);
  });
}
function links(answer: string): string[] {
  return [...answer.matchAll(/https?:\/\/[^\s<>"'`\])}]+/g)].map((m) =>
    m[0].replace(/[.,;:!?]+$/, ''),
  );
}
function signals(
  run: VisibilityRuns['runs'][number] | undefined,
  target: VisibilitySuite['targets'][number],
) {
  if (!run || run.status !== 'completed')
    return {
      mention: null,
      link: null,
      citation: null,
      recommendation: null,
      misrepresentation: null,
    };
  const answer = run.rawAnswer!;
  const matches = (candidate: string) => target.urls.some((t) => targetUrlMatches(candidate, t));
  const review = run.reviews.find((r) => r.targetId === target.id);
  const visibleText = answer.replace(/https?:\/\/[^\s<>"'`\])}]+/g, '');
  return {
    mention: mentions(visibleText, target.aliases),
    link: links(answer).some(matches),
    citation: run.citations === null ? null : run.citations.some((c) => matches(c.url)),
    recommendation: review?.recommendation ?? null,
    misrepresentation: review?.misrepresentation ?? null,
  };
}
export async function parseVisibilityRuns(
  input: unknown,
  suite: VisibilitySuite,
): Promise<VisibilityRuns> {
  const data = parse(visibilityRunsSchema, input, 'runs');
  if (data.suiteId !== suite.id || data.suiteVersion !== suite.version)
    throw new PulseError('CONFLICT', 'Visibility suite identity/version mismatch.');
  unique(
    data.sessions.map((s) => s.id),
    'session',
  );
  unique(
    data.runs.map((r) => JSON.stringify([r.sessionId, r.promptId, r.repeat])),
    'run',
  );
  for (const run of data.runs) {
    const session = data.sessions.find((s) => s.id === run.sessionId),
      prompt = suite.prompts.find((p) => p.id === run.promptId);
    if (!session || !prompt || run.repeat > session.repeats || run.language !== prompt.language)
      throw new PulseError('CONFIG', 'Visibility run metadata does not match its session/prompt.');
    if (run.promptHash !== (await promptHash(prompt)))
      throw new PulseError(
        'CONFLICT',
        'Visibility prompt hash mismatch; preserve the original suite or rerun the changed prompt.',
      );
    if (
      (run.status === 'completed' && !run.rawAnswer?.trim()) ||
      (run.status !== 'completed' &&
        (run.rawAnswer !== null || run.citations !== null || run.reviews.length))
    )
      throw new PulseError('CONFIG', 'Contradictory visibility run status/evidence.');
    unique(
      run.reviews.map((r) => r.targetId),
      'manual review',
    );
    for (const review of run.reviews) {
      const target = suite.targets.find((t) => t.id === review.targetId);
      if (!target || !prompt.targetIds.includes(target.id))
        throw new PulseError('CONFIG', 'Manual review target is outside the prompt.');
      const evidence = signals(run, target);
      if (
        (review.recommendation === true || review.misrepresentation === true) &&
        !evidence.mention &&
        !evidence.link &&
        !evidence.citation
      )
        throw new PulseError(
          'CONFIG',
          'Positive manual labels require target mention, link or provider citation evidence.',
        );
    }
  }
  return data;
}
export async function visibilityTemplate(
  suite: VisibilitySuite,
  sessionInput: unknown,
): Promise<VisibilityRuns> {
  const session = parse(sessionSchema, sessionInput, 'session');
  const runs: VisibilityRuns['runs'] = [];
  for (const prompt of suite.prompts)
    for (let repeat = 1; repeat <= session.repeats; repeat++)
      runs.push({
        sessionId: session.id,
        promptId: prompt.id,
        promptHash: await promptHash(prompt),
        language: prompt.language,
        repeat,
        status: 'unrun',
        rawAnswer: null,
        citations: null,
        reviews: [],
      });
  return {
    schemaVersion: 1,
    suiteId: suite.id,
    suiteVersion: suite.version,
    sessions: [session],
    runs,
  };
}
/** No execution providers: the operator must explicitly choose and configure any external runner. */
export async function promptfooConfig(suite: VisibilitySuite) {
  return {
    description: `${suite.id} ${suite.version} — offline prompt export; configure providers explicitly`,
    prompts: ['{{prompt}}'],
    providers: [],
    tests: await Promise.all(
      suite.prompts.map(async (p) => ({
        vars: {
          prompt: p.text,
          promptId: p.id,
          promptHash: await promptHash(p),
          language: p.language,
          kind: p.kind,
        },
      })),
    ),
  };
}
type Signal = 'mention' | 'link' | 'citation' | 'recommendation' | 'misrepresentation';
export async function visibilityReport(suite: VisibilitySuite, input: unknown) {
  const data = await parseVisibilityRuns(input, suite);
  const groups = new Map<
    string,
    {
      session: VisibilitySession;
      kind: 'branded' | 'unbranded';
      language: string;
      targetId: string;
      expected: number;
      completed: number;
      missing: number;
      unrun: number;
      errors: number;
      signals: Record<Signal, { positive: number; observed: number; unknown: number }>;
    }
  >();
  const runs = new Map(
    data.runs.map((r) => [JSON.stringify([r.sessionId, r.promptId, r.repeat]), r]),
  );
  for (const session of data.sessions)
    for (const prompt of suite.prompts)
      for (const targetId of prompt.targetIds) {
        const key = JSON.stringify([session.id, prompt.kind, prompt.language, targetId]);
        let group = groups.get(key);
        if (!group) {
          group = {
            session,
            kind: prompt.kind,
            language: prompt.language,
            targetId,
            expected: 0,
            completed: 0,
            missing: 0,
            unrun: 0,
            errors: 0,
            signals: Object.fromEntries(
              ['mention', 'link', 'citation', 'recommendation', 'misrepresentation'].map((k) => [
                k,
                { positive: 0, observed: 0, unknown: 0 },
              ]),
            ) as Record<Signal, { positive: number; observed: number; unknown: number }>,
          };
          groups.set(key, group);
        }
        const target = suite.targets.find((t) => t.id === targetId)!;
        for (let repeat = 1; repeat <= session.repeats; repeat++) {
          const run = runs.get(JSON.stringify([session.id, prompt.id, repeat]));
          group.expected++;
          if (!run) group.missing++;
          else if (run.status === 'completed') group.completed++;
          else if (run.status === 'error') group.errors++;
          else group.unrun++;
          for (const [signal, value] of Object.entries(signals(run, target))) {
            const counts = group.signals[signal as Signal];
            if (value === null) counts.unknown++;
            else {
              counts.observed++;
              if (value) counts.positive++;
            }
          }
        }
      }
  return {
    schemaVersion: 1 as const,
    suiteId: suite.id,
    suiteVersion: suite.version,
    groups: [...groups.values()],
    caveats: [
      'Unknown, unrun, missing and failed evidence is excluded from observed denominators.',
      'Branded controls and unbranded discovery are separate. Text mentions and links do not prove provider citations or recommendations.',
      'API/CLI models do not stand in for consumer products. Product, model, language, search mode, context and date remain explicit.',
      'Provider citations are operator-captured evidence; recommendations and misrepresentations require human review.',
    ],
  };
}
