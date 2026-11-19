import * as z from 'zod/mini';
import type { Config } from './config.js';
import { PulseError, invariant } from './errors.js';
import type { ProjectReport } from './report.js';
import { range, type DateRange } from './time.js';

export const REVIEW_ID = /^[a-z0-9][a-z0-9_-]{7,95}$/;
export const MAX_REVIEW_BYTES = 256 * 1024;
const id = z.string().check(z.regex(REVIEW_ID));
const projectId = z.string().check(z.regex(/^[a-z][a-z0-9_-]{0,63}$/));
const text = (maximum: number) =>
  z
    .string()
    .check(
      z.minLength(1),
      z.maxLength(maximum),
      z.regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/),
    );
const inputFields = {
  id,
  projectId,
  window: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  question: text(1000),
  conclusion: text(5000),
  actionUrl: z.optional(z.string().check(z.maxLength(2048))),
  followUpOf: z.optional(id),
};
const inputSchema = z.strictObject(inputFields);
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...inputFields,
  createdAt: z.iso.datetime(),
  evidence: z.strictObject({
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
    report: z.record(z.string(), z.unknown()),
  }),
});
export interface ReviewInput {
  id: string;
  projectId: string;
  window: DateRange;
  question: string;
  conclusion: string;
  actionUrl?: string;
  followUpOf?: string;
}
export interface ReviewRecord extends ReviewInput {
  schemaVersion: 1;
  createdAt: string;
  evidence: { sha256: string; report: ProjectReport };
}
export function validateReviewInput(input: unknown): ReviewInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new PulseError(
      'CONFIG',
      'Invalid review. Supply an id, projectId, window, question and conclusion; optional actionUrl and followUpOf.',
    );
  const value = parsed.data;
  range(value.window.from, value.window.to);
  invariant(
    value.question.trim().length > 0 && value.conclusion.trim().length > 0,
    'Review text must not be blank.',
  );
  invariant(value.followUpOf !== value.id, 'A review cannot follow itself.');
  if (value.actionUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(value.actionUrl);
    } catch {
      throw new PulseError('CONFIG', 'Review action link must be an absolute HTTPS URL.');
    }
    invariant(
      url.protocol === 'https:' && !url.username && !url.password,
      'Unsafe review action link.',
    );
  }
  return value;
}
export function reviewInput(record: ReviewRecord): ReviewInput {
  return {
    id: record.id,
    projectId: record.projectId,
    window: record.window,
    question: record.question,
    conclusion: record.conclusion,
    ...(record.actionUrl !== undefined ? { actionUrl: record.actionUrl } : {}),
    ...(record.followUpOf !== undefined ? { followUpOf: record.followUpOf } : {}),
  };
}
export function validateReviewRecord(input: unknown, config?: Config): ReviewRecord {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) throw new PulseError('CONFIG', 'Invalid stored review record.');
  const value = parsed.data;
  validateReviewInput(reviewInput(value as unknown as ReviewRecord));
  if (config)
    invariant(
      config.projects.some((p) => p.id === value.projectId),
      'Review project is unknown.',
    );
  const report = value.evidence.report;
  const project = report.project as Record<string, unknown> | undefined;
  const window = report.window as Record<string, unknown> | undefined;
  invariant(
    report.schemaVersion === 1 &&
      project?.id === value.projectId &&
      window?.from === value.window.from &&
      window?.to === value.window.to &&
      typeof report.generatedAt === 'string' &&
      Number.isFinite(Date.parse(report.generatedAt)) &&
      typeof report.demo === 'boolean' &&
      (!config || report.demo === config.demo) &&
      ['cards', 'breakdowns', 'annotations', 'inspections', 'warnings'].every((k) =>
        Array.isArray(report[k]),
      ) &&
      report.evidence !== null &&
      typeof report.evidence === 'object',
    'Stored review evidence does not match its project or window.',
  );
  invariant(
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_REVIEW_BYTES,
    'Review evidence exceeds its private snapshot budget. Choose a shorter window.',
  );
  return value as unknown as ReviewRecord;
}
export async function evidenceDigest(report: ProjectReport): Promise<string> {
  // JSON object order is part of this frozen representation; copies and archives retain it.
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(report))),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
export async function verifyReviewEvidence(record: ReviewRecord): Promise<void> {
  invariant(
    (await evidenceDigest(record.evidence.report)) === record.evidence.sha256,
    'Stored review evidence digest does not match.',
  );
}
export function assertSameReview(record: ReviewRecord, input: ReviewInput): void {
  if (JSON.stringify(reviewInput(record)) !== JSON.stringify(input))
    throw new PulseError(
      'CONFLICT',
      'Review id is already used by a different conclusion. Use a new id for a follow-up.',
    );
}
