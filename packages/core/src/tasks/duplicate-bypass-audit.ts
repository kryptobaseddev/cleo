/**
 * Duplicate-bypass audit trail.
 *
 * Records entries to `.cleo/audit/duplicate-bypass.jsonl` when a caller
 * passes `--force-duplicate` to bypass the E_DUPLICATE_TASK_LIKELY guard.
 *
 * Pattern mirrors `premature-close-audit.ts` (T1632) and
 * `nexus-risk-audit.ts` (T1073) — one JSONL file per audit concern,
 * created on demand, appended atomically.
 *
 * @epic T1627
 * @task T1633
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuplicateCandidate } from './duplicate-detector.js';

/**
 * A single entry in the duplicate-bypass audit file.
 *
 * Written whenever `cleo add` is called with `--force-duplicate` to bypass
 * the E_DUPLICATE_TASK_LIKELY rejection guard.
 */
export interface DuplicateBypassAuditEntry {
  /** Title of the task being added despite similarity. */
  incomingTitle: string;
  /** Description of the task being added (may be empty). */
  incomingDescription: string;
  /**
   * Top matching candidates that triggered (or would have triggered) rejection.
   * Captured for post-mortem traceability.
   */
  matchedCandidates: DuplicateCandidate[];
  /**
   * Maximum similarity score observed at bypass time.
   * Lets auditors understand how strong the duplicate signal was.
   */
  maxScore: number;
  /** ISO-8601 timestamp of the bypass. */
  timestamp: string;
  /** Agent / user identity that performed the override. Always 'system' for CLI. */
  agent: string;
}

/** Relative path within project root for the duplicate-bypass audit log. */
export const DUPLICATE_BYPASS_AUDIT_FILE = '.cleo/audit/duplicate-bypass.jsonl';

/**
 * Append a duplicate-bypass entry to the audit file.
 *
 * Creates `.cleo/audit/` if it does not exist and atomically appends a
 * single-line JSON record to `.cleo/audit/duplicate-bypass.jsonl`.
 *
 * @param entry - The audit entry to append.
 * @param projectRoot - Absolute path to the project root.
 */
export async function appendDuplicateBypassAudit(
  entry: DuplicateBypassAuditEntry,
  projectRoot: string,
): Promise<void> {
  try {
    const auditDir = join(projectRoot, '.cleo', 'audit');
    await mkdir(auditDir, { recursive: true });

    const auditFile = join(auditDir, 'duplicate-bypass.jsonl');
    const line = JSON.stringify(entry);
    await appendFile(auditFile, `${line}\n`, { encoding: 'utf8' });
  } catch {
    // Audit writes must never block task creation — swallow errors silently.
  }
}
