import type { Config } from './config.js';
import { PulseError } from './errors.js';
import { projectReport, type ProjectReport } from './report.js';
import { REPORT_REVISION, reportRevision } from './report-revision.js';
import type { Store } from './storage/store.js';
import {
  REVIEW_ID,
  assertSameReview,
  evidenceDigest,
  validateReviewInput,
  validateReviewRecord,
  verifyReviewEvidence,
  type ReviewRecord,
} from './review-record.js';

function projectExists(config: Config, projectId: string): void {
  if (!config.projects.some((p) => p.id === projectId))
    throw new PulseError('NOT_FOUND', 'Project was not found.');
}
async function assertReviewedRevision(
  report: ProjectReport,
  expectedRevision?: string,
): Promise<void> {
  if (expectedRevision !== undefined && (await reportRevision(report)) !== expectedRevision)
    throw new PulseError(
      'CONFLICT',
      'Review evidence differs from the expected revision. Read the project evidence again before saving; an existing review is never overwritten.',
    );
}
/** Explicit owner operation. No provider fetches; the supplied id makes retries stable. */
export async function recordReview(
  config: Config,
  store: Store,
  input: unknown,
  now = new Date(),
  expectedRevision?: string,
): Promise<ReviewRecord> {
  if (expectedRevision !== undefined && !REPORT_REVISION.test(expectedRevision))
    throw new PulseError(
      'CONFIG',
      'Expected revision must be a lowercase SHA-256 current-evidence revision.',
    );
  const parsed = validateReviewInput(input);
  projectExists(config, parsed.projectId);
  const existing = await store.reviewRecord(parsed.id);
  if (existing) {
    assertSameReview(existing, parsed);
    await verifyReviewEvidence(existing);
    await assertReviewedRevision(existing.evidence.report, expectedRevision);
    return existing;
  }
  if (parsed.followUpOf) {
    const previous = await store.reviewRecord(parsed.followUpOf);
    if (!previous || previous.projectId !== parsed.projectId)
      throw new PulseError(
        'CONFIG',
        'Follow-up must reference an existing review of this project.',
      );
  }
  const snapshot = await store.reportingSnapshot(
    { ...config, projects: config.projects.filter((project) => project.id === parsed.projectId) },
    parsed.window,
    { required: true },
  );
  try {
    const report = await projectReport(config, snapshot, parsed.projectId, parsed.window, now);
    await assertReviewedRevision(report, expectedRevision);
    const record = validateReviewRecord(
      {
        schemaVersion: 1,
        ...parsed,
        createdAt: now.toISOString(),
        evidence: { sha256: await evidenceDigest(report), report },
      },
      config,
    );
    const stored = await store.addReviewRecord(record);
    // A concurrent writer can have won this id with the same conclusion but
    // another snapshot. The returned frozen record must satisfy this guard too.
    await assertReviewedRevision(stored.evidence.report, expectedRevision);
    return stored;
  } finally {
    snapshot.driver.close?.();
  }
}
/** Bounded read; callers should present summaries and retrieve a snapshot explicitly. */
export async function readReviewHistory(
  config: Config,
  store: Store,
  projectId: string,
  limit = 20,
): Promise<ReviewRecord[]> {
  projectExists(config, projectId);
  return store.reviewRecords(projectId, limit);
}
export async function readReviewRecord(
  config: Config,
  store: Store,
  projectId: string,
  id: string,
): Promise<ReviewRecord> {
  projectExists(config, projectId);
  if (!REVIEW_ID.test(id)) throw new PulseError('CONFIG', 'Invalid review identifier.');
  const record = await store.reviewRecord(id);
  if (!record || record.projectId !== projectId)
    throw new PulseError('NOT_FOUND', 'Review was not found.');
  await verifyReviewEvidence(record);
  return record;
}
export function reviewSummary(record: ReviewRecord) {
  const { evidence, ...summary } = record;
  return { ...summary, evidence: { sha256: evidence.sha256 } };
}
