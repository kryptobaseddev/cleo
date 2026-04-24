/**
 * Core audit types and query functions.
 *
 * AuditEntry interface and queryAudit function moved here from
 * src/dispatch/middleware/audit.ts so core modules (session-grade.ts)
 * can use them without importing from the dispatch layer.
 *
 * @task T5715
 * @epic T5701
 * @task T1261 PSYCHE E4 — appendContractViolation for contract-violations.jsonl
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContractViolationRecord } from '@cleocode/contracts';
import { getLogger } from './logger.js';

const log = getLogger('audit');

/**
 * Audit entry interface.
 * Used by session-grade and system-engine for behavioral analysis.
 */
export interface AuditEntry {
  timestamp: string;
  sessionId: string | null;
  domain: string;
  operation: string;
  params: Record<string, unknown>;
  result: {
    success: boolean;
    exitCode: number;
    duration: number;
  };
  metadata: {
    taskId?: string;
    userId?: string;
    source: 'dispatch' | 'cli';
    gateway?: 'mutate' | 'query';
  };
  error?: string;
}

/** Relative path within project root for contract violation audit log. */
export const CONTRACT_VIOLATIONS_FILE = '.cleo/audit/contract-violations.jsonl';

/**
 * Append a {@link ContractViolationRecord} to the project's contract-violations
 * audit log at `.cleo/audit/contract-violations.jsonl`.
 *
 * Follows the same append-only pattern as force-bypass.jsonl (ADR-039): each
 * line is standalone JSON; the file is created on first write. Errors are
 * swallowed so audit writes never block playbook execution.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param record - Violation data (timestamp is set automatically when omitted).
 *
 * @example
 * ```ts
 * import { appendContractViolation } from '@cleocode/core/audit.js';
 *
 * appendContractViolation('/project', {
 *   runId: 'run_abc123',
 *   nodeId: 'validate',
 *   field: 'requires',
 *   key: 'diff',
 *   message: 'requires.fields[diff] not present in context',
 *   playbookName: 'ivtr',
 * });
 * ```
 *
 * @task T1261 PSYCHE E4
 */
export function appendContractViolation(
  projectRoot: string,
  record: Omit<ContractViolationRecord, 'timestamp'> & { timestamp?: string },
): void {
  try {
    const filePath = join(projectRoot, CONTRACT_VIOLATIONS_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    const entry: ContractViolationRecord = {
      timestamp: record.timestamp ?? new Date().toISOString(),
      runId: record.runId,
      nodeId: record.nodeId,
      field: record.field,
      key: record.key,
      message: record.message,
      playbookName: record.playbookName,
    };
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
  } catch {
    // non-fatal — audit writes must never block the operation
  }
}

/**
 * Query audit entries from SQLite audit_log table.
 * Used by session-grade.ts for behavioral analysis.
 *
 * Returns entries ordered chronologically (ASC) to preserve
 * behavioral sequence for grading analysis.
 */
export async function queryAudit(options?: {
  sessionId?: string;
  domain?: string;
  operation?: string;
  taskId?: string;
  since?: string;
  limit?: number;
}): Promise<AuditEntry[]> {
  try {
    const { getDb } = await import('./store/sqlite.js');
    const { auditLog } = await import('./store/tasks-schema.js');
    const { and, eq, gte, or } = await import('drizzle-orm');

    const db = await getDb(process.cwd());

    const conditions = [];
    if (options?.sessionId) conditions.push(eq(auditLog.sessionId, options.sessionId));
    if (options?.domain) conditions.push(eq(auditLog.domain, options.domain));
    if (options?.operation)
      conditions.push(
        or(eq(auditLog.operation, options.operation), eq(auditLog.action, options.operation))!,
      );
    if (options?.taskId) conditions.push(eq(auditLog.taskId, options.taskId));
    if (options?.since) conditions.push(gte(auditLog.timestamp, options.since));

    const limit = options?.limit ?? 1000;

    const rows = await db
      .select()
      .from(auditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(auditLog.timestamp)
      .limit(limit);

    return rows.map((row) => ({
      timestamp: row.timestamp,
      sessionId: row.sessionId,
      domain: row.domain ?? 'unknown',
      operation: row.operation ?? row.action,
      params: row.detailsJson ? JSON.parse(row.detailsJson) : {},
      result: {
        success: row.success === 1,
        exitCode: row.success === 1 ? 0 : 1,
        duration: row.durationMs ?? 0,
      },
      metadata: {
        taskId: row.taskId !== 'system' && row.taskId !== 'unknown' ? row.taskId : undefined,
        source: (row.source as 'dispatch' | 'cli') ?? 'cli',
        gateway: row.gateway as 'mutate' | 'query' | undefined,
      },
      error: row.errorMessage ?? undefined,
    }));
  } catch (err) {
    log.warn({ err }, 'Failed to query audit entries from SQLite');
    return [];
  }
}
