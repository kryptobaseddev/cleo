/**
 * Premature-close audit trail.
 *
 * Records override entries to `.cleo/audit/premature-close.jsonl` when a caller
 * bypasses the `E_EPIC_HAS_PENDING_CHILDREN` guard via `--override-reason`.
 *
 * Pattern mirrors `nexus-risk-audit.ts` (T1073) — one JSONL file per audit
 * concern, created on demand, appended atomically.
 *
 * @epic T1627
 * @task T1632
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectRoot } from '../paths.js';

/**
 * A single entry in the premature-close audit file.
 *
 * Written whenever `cleo complete <epicId>` is called with pending children
 * AND the caller supplies `--override-reason` to bypass the guard.
 */
export interface PrematureCloseAuditEntry {
  /** Epic ID that was completed despite having pending children. */
  epicId: string;
  /**
   * IDs of the children that were still pending/active at completion time.
   * Captured for post-mortem traceability.
   */
  pendingChildIds: string[];
  /** Human-readable reason supplied by the caller for overriding the guard. */
  overrideReason: string;
  /** ISO-8601 timestamp of the override. */
  timestamp: string;
  /** Agent / user identity that performed the completion. */
  agent: string;
}

/**
 * Append a premature-close override entry to the audit file.
 *
 * Creates `.cleo/audit/` if it does not exist and atomically appends a
 * single-line JSON record to `.cleo/audit/premature-close.jsonl`.
 *
 * @param entry - The audit entry to append.
 * @param projectRoot - Absolute path to the project root (defaults to `getProjectRoot()`).
 */
export async function appendPrematureCloseAudit(
  entry: PrematureCloseAuditEntry,
  projectRoot?: string,
): Promise<void> {
  const root = projectRoot ?? getProjectRoot();
  const auditDir = join(root, '.cleo', 'audit');

  await mkdir(auditDir, { recursive: true });

  const auditFile = join(auditDir, 'premature-close.jsonl');
  const line = JSON.stringify(entry);
  await appendFile(auditFile, `${line}\n`, { encoding: 'utf8' });
}
