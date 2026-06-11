/**
 * Depends-waiver audit trail.
 *
 * Records waiver entries to `.cleo/audit/depends-waiver.jsonl` when a caller
 * completes a task whose own work is done but whose `depends` edges point at
 * tasks that are not yet in a terminal state, by supplying
 * `--waive-depends "<reason>"` to bypass the `E_CLEO_DEPENDENCY` gate.
 *
 * Pattern mirrors `cancelled-child-waiver-audit.ts` (T10538) and
 * `premature-close-audit.ts` (T1632) — one JSONL file per audit concern,
 * created on demand, appended atomically.
 *
 * @task T11954 — DHQ-071: complete hard-blocks on stale/over-specified depends
 * @epic T11679
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectRoot } from '../paths.js';

/**
 * A single entry in the depends-waiver audit file.
 *
 * Written whenever `cleo complete <taskId>` is called while the task has one or
 * more non-terminal `depends` edges AND the caller supplies `--waive-depends`
 * to bypass the dependency gate.
 */
export interface DependsWaiverAuditEntry {
  /** Task ID that was completed despite having unresolved depends edges. */
  taskId: string;
  /**
   * IDs (and their then-current status) of the unresolved dependencies that
   * were waived. Captured for post-mortem traceability so a reviewer can
   * confirm the over-specified edge was genuinely waivable.
   */
  unresolvedDeps: Array<{ id: string; status: string }>;
  /** Human-readable reason supplied by the caller for waiving the depends edges. */
  waiverReason: string;
  /** ISO-8601 timestamp of the waiver. */
  timestamp: string;
  /** Agent / user identity that performed the completion. */
  agent: string;
}

/**
 * Append a depends-waiver entry to the audit file.
 *
 * Creates `.cleo/audit/` if it does not exist and atomically appends a
 * single-line JSON record to `.cleo/audit/depends-waiver.jsonl`.
 *
 * @param entry - The audit entry to append.
 * @param projectRoot - Absolute path to the project root (defaults to `getProjectRoot()`).
 */
export async function appendDependsWaiverAudit(
  entry: DependsWaiverAuditEntry,
  projectRoot?: string,
): Promise<void> {
  const root = projectRoot ?? getProjectRoot();
  const auditDir = join(root, '.cleo', 'audit');

  await mkdir(auditDir, { recursive: true });

  const auditFile = join(auditDir, 'depends-waiver.jsonl');
  const line = JSON.stringify(entry);
  await appendFile(auditFile, `${line}\n`, { encoding: 'utf8' });
}
