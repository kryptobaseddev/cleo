/**
 * Core audit types and query functions.
 *
 * AuditEntry interface and queryAudit function moved here from
 * src/dispatch/middleware/audit.ts so core modules (session-grade.ts)
 * can use them without importing from the dispatch layer.
 *
 * @task T5715
 * @epic T5701
 */

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
    source: 'mcp' | 'cli';
    gateway?: 'mutate' | 'query';
  };
  error?: string;
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
        source: (row.source as 'mcp' | 'cli') ?? 'mcp',
        gateway: row.gateway as 'mutate' | 'query' | undefined,
      },
      error: row.errorMessage ?? undefined,
    }));
  } catch (err) {
    log.warn({ err }, 'Failed to query audit entries from SQLite');
    return [];
  }
}
