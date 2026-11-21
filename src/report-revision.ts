import type { ProjectReport } from './report.js';

export const REPORT_REVISION = /^[a-f0-9]{64}$/;

/** A current-content revision, not a persisted historical snapshot. */
export async function reportRevision(report: ProjectReport): Promise<string> {
  const { generatedAt: _generatedAt, ...evidence } = report;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(evidence)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
