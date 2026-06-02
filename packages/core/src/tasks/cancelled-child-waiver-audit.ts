/**
 * Cancelled-child-waiver audit trail.
 *
 * Records waiver entries to `.cleo/audit/cancelled-child-waiver.jsonl` when a
 * caller completes a parent that has `cancelled` children by supplying
 * `--waive-cancelled-children "<reason>"` to bypass the
 * `E_CANCELLED_CHILD_NO_WAIVER` gate.
 *
 * Pattern mirrors `premature-close-audit.ts` (T1632) — one JSONL file per audit
 * concern, created on demand, appended atomically.
 *
 * @saga T10538 (PM-Core V2 agent-trust)
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectRoot } from '../paths.js';

/**
 * A single entry in the cancelled-child-waiver audit file.
 *
 * Written whenever `cleo complete <parentId>` is called while the parent has
 * one or more `cancelled` children AND the caller supplies
 * `--waive-cancelled-children` to bypass the gate.
 */
export interface CancelledChildWaiverAuditEntry {
  /** Parent task ID that was completed despite having cancelled children. */
  parentId: string;
  /**
   * IDs of the cancelled children whose abandoned work was waived. Captured
   * for post-mortem traceability so a reviewer can confirm the cancelled work
   * was genuinely waivable or replaced.
   */
  cancelledChildIds: string[];
  /** Human-readable reason supplied by the caller for waiving the cancelled children. */
  waiverReason: string;
  /** ISO-8601 timestamp of the waiver. */
  timestamp: string;
  /** Agent / user identity that performed the completion. */
  agent: string;
}

/**
 * Append a cancelled-child-waiver entry to the audit file.
 *
 * Creates `.cleo/audit/` if it does not exist and atomically appends a
 * single-line JSON record to `.cleo/audit/cancelled-child-waiver.jsonl`.
 *
 * @param entry - The audit entry to append.
 * @param projectRoot - Absolute path to the project root (defaults to `getProjectRoot()`).
 */
export async function appendCancelledChildWaiverAudit(
  entry: CancelledChildWaiverAuditEntry,
  projectRoot?: string,
): Promise<void> {
  const root = projectRoot ?? getProjectRoot();
  const auditDir = join(root, '.cleo', 'audit');

  await mkdir(auditDir, { recursive: true });

  const auditFile = join(auditDir, 'cancelled-child-waiver.jsonl');
  const line = JSON.stringify(entry);
  await appendFile(auditFile, `${line}\n`, { encoding: 'utf8' });
}
