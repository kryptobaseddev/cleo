/**
 * Audit Trail Middleware for CQRS Dispatch Layer.
 *
 * Dual-writes every audited operation to:
 *   1. Pino structured log (subsystem: 'audit') -> .cleo/logs/cleo.log
 *   2. SQLite audit_log table -> .cleo/tasks.db
 *
 * Legacy JSON file logging (.cleo/audit-log.json + rotated audit-log-*.json)
 * has been removed per ADR-019.
 *
 * @task T2920
 * @task T2929
 * @task T4844
 */

import { getLogger } from '../../core/logger.js';
import { getConfig } from '../lib/config.js';
import type { DispatchRequest, DispatchResponse, Middleware, DispatchNext } from '../types.js';

const log = getLogger('audit');

/**
 * Audit entry interface.
 * Retained for type compatibility with session-grade and system-engine.
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
    gateway?: 'cleo_mutate' | 'cleo_query';
  };
  error?: string;
}

/**
 * Get active session info from SQLite or env vars.
 */
async function getActiveSessionInfo(): Promise<{ id: string; gradeMode: boolean } | null> {
  const envId = process.env.CLEO_SESSION_ID;
  if (envId) {
    return { id: envId, gradeMode: process.env.CLEO_SESSION_GRADE === 'true' };
  }
  try {
    const { getAccessor } = await import('../../store/data-accessor.js');
    const accessor = await getAccessor(process.cwd());
    const sessionsData = await accessor.loadSessions();
    const sessions = (sessionsData as unknown as {
      sessions?: Array<{ id: string; status: string; gradeMode?: boolean }>;
    }).sessions ?? [];
    const active = sessions.find(s => s.status === 'active');
    if (active) {
      return { id: active.id, gradeMode: active.gradeMode === true };
    }
  } catch {
    // best-effort
  }
  return null;
}

/**
 * Write audit entry to SQLite audit_log table.
 * Fire-and-forget — errors are logged to Pino but never thrown.
 */
async function writeToSqlite(entry: AuditEntry, requestId?: string): Promise<void> {
  try {
    const { getDb } = await import('../../store/sqlite.js');
    const { auditLog } = await import('../../store/schema.js');
    const { randomUUID } = await import('node:crypto');

    const db = await getDb(process.cwd());
    await db.insert(auditLog).values({
      id: randomUUID(),
      timestamp: entry.timestamp,
      action: entry.operation,
      taskId: entry.metadata.taskId ?? 'system',
      actor: entry.metadata.userId ?? 'agent',
      detailsJson: JSON.stringify(entry.params),
      // Dispatch-level columns (ADR-019)
      domain: entry.domain,
      operation: entry.operation,
      sessionId: entry.sessionId,
      requestId: requestId ?? null,
      durationMs: entry.result.duration,
      success: entry.result.success ? 1 : 0,
      source: entry.metadata.source,
      gateway: entry.metadata.gateway ?? null,
      errorMessage: entry.error ?? null,
    }).run();
  } catch (err) {
    log.warn({ err }, 'Failed to write audit entry to SQLite');
  }
}

/**
 * Creates an audit middleware that logs all mutate operations
 * (and query operations during grade sessions) to Pino + SQLite.
 */
export function createAudit(): Middleware {
  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    const startTime = Date.now();
    const response = await next();

    // Determine session context
    const sessionInfo = await getActiveSessionInfo();
    const currentSessionId: string | null = req.sessionId || sessionInfo?.id || null;
    const isGradeSession = sessionInfo?.gradeMode === true || process.env.CLEO_SESSION_GRADE === 'true';

    // Audit mutations always; audit queries only during grade sessions
    const shouldAudit = req.gateway === 'mutate' || (req.gateway === 'query' && isGradeSession);
    if (!shouldAudit) return response;

    // Check if audit logging is enabled
    const config = getConfig();
    if (!config.auditLog) return response;

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: currentSessionId,
      domain: req.domain,
      operation: req.operation,
      params: req.params || {},
      result: {
        success: response.success,
        exitCode: response.error?.exitCode || 0,
        duration: Date.now() - startTime,
      },
      metadata: {
        taskId: (req.params?.taskId as string) || (req.params?.parent as string),
        source: req.source as 'mcp' | 'cli',
        gateway: req.gateway as 'cleo_mutate' | 'cleo_query',
      },
      error: response.error?.message,
    };

    // Pino structured log (immediate, non-blocking)
    log.info(
      {
        domain: entry.domain,
        operation: entry.operation,
        sessionId: entry.sessionId,
        taskId: entry.metadata.taskId,
        gateway: entry.metadata.gateway,
        success: entry.result.success,
        exitCode: entry.result.exitCode,
        durationMs: entry.result.duration,
      },
      `${entry.metadata.gateway ?? 'dispatch'} ${entry.domain}.${entry.operation}`,
    );

    // SQLite write (fire-and-forget)
    writeToSqlite(entry, req.requestId).catch(err => {
      log.error({ err }, 'Failed to persist audit entry to SQLite');
    });

    return response;
  };
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
    const { getDb } = await import('../../store/sqlite.js');
    const { auditLog } = await import('../../store/schema.js');
    const { sql } = await import('drizzle-orm');

    const db = await getDb(process.cwd());

    const conditions: ReturnType<typeof sql>[] = [];
    if (options?.sessionId) {
      conditions.push(sql`${auditLog.sessionId} = ${options.sessionId}`);
    }
    if (options?.domain) {
      conditions.push(sql`${auditLog.domain} = ${options.domain}`);
    }
    if (options?.operation) {
      conditions.push(sql`(${auditLog.operation} = ${options.operation} OR ${auditLog.action} = ${options.operation})`);
    }
    if (options?.taskId) {
      conditions.push(sql`${auditLog.taskId} = ${options.taskId}`);
    }
    if (options?.since) {
      conditions.push(sql`${auditLog.timestamp} >= ${options.since}`);
    }

    const whereClause = conditions.length > 0
      ? sql.join(conditions, sql` AND `)
      : sql`1=1`;

    const limit = options?.limit ?? 1000;

    const rows = await db.all<{
      timestamp: string;
      action: string;
      task_id: string;
      domain: string | null;
      operation: string | null;
      session_id: string | null;
      duration_ms: number | null;
      success: number | null;
      source: string | null;
      gateway: string | null;
      error_message: string | null;
      details_json: string | null;
    }>(
      sql`SELECT * FROM ${auditLog}
          WHERE ${whereClause}
          ORDER BY ${auditLog.timestamp} ASC
          LIMIT ${limit}`,
    );

    return rows.map(row => ({
      timestamp: row.timestamp,
      sessionId: row.session_id,
      domain: row.domain ?? 'unknown',
      operation: row.operation ?? row.action,
      params: row.details_json ? JSON.parse(row.details_json) : {},
      result: {
        success: row.success === 1,
        exitCode: row.success === 1 ? 0 : 1,
        duration: row.duration_ms ?? 0,
      },
      metadata: {
        taskId: row.task_id !== 'system' && row.task_id !== 'unknown' ? row.task_id : undefined,
        source: (row.source as 'mcp' | 'cli') ?? 'mcp',
        gateway: row.gateway as 'cleo_mutate' | 'cleo_query' | undefined,
      },
      error: row.error_message ?? undefined,
    }));
  } catch {
    return [];
  }
}
