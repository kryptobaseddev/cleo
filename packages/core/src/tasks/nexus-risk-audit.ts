/**
 * IVTR Breaking-Change Gate — audit trail for nexus risk acknowledgments.
 *
 * Records acknowledgments to `.cleo/audit/nexus-risk-ack.jsonl` when a worker
 * bypasses the nexusImpact gate with `--acknowledge-risk "<reason>"`.
 *
 * @task T1073
 * @epic T1042
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getProjectRoot } from '../paths.js';

/**
 * A single entry in the nexus risk acknowledgment audit file.
 */
export interface NexusRiskAckEntry {
  /** Task ID that was completed despite CRITICAL impact risk. */
  taskId: string;
  /** Symbols with CRITICAL risk that were acknowledged. */
  symbols: Array<{
    symbolId: string;
    symbolName?: string;
    risk: string;
  }>;
  /** Reason provided by the worker for acknowledging the risk. */
  reason: string;
  /** ISO timestamp when acknowledgment was recorded. */
  timestamp: string;
  /** Agent ID that performed the completion (e.g., 'cleo', worker name). */
  agent: string;
}

/**
 * Append a nexus risk acknowledgment entry to the audit file.
 *
 * Creates `.cleo/audit/` directory if it does not exist and atomically appends
 * a single-line JSON entry to `.cleo/audit/nexus-risk-ack.jsonl`.
 *
 * @param entry - The acknowledgment entry to audit
 * @param projectRoot - Absolute path to project root (defaults to getProjectRoot())
 */
export async function appendNexusRiskAck(
  entry: NexusRiskAckEntry,
  projectRoot?: string,
): Promise<void> {
  const root = projectRoot ?? getProjectRoot();
  const auditDir = join(root, '.cleo', 'audit');

  // Create audit directory if needed
  try {
    await mkdir(auditDir, { recursive: true });
  } catch (err) {
    // Directory already exists or creation failed for another reason
    if (!(err instanceof Error) || !err.message.includes('EEXIST')) {
      throw err;
    }
  }

  const auditFile = join(auditDir, 'nexus-risk-ack.jsonl');
  const line = JSON.stringify(entry);

  // Append single-line JSON entry
  await appendFile(auditFile, `${line}\n`, { encoding: 'utf8' });
}
