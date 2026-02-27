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
  // Grade mode fast path: CLEO_SESSION_GRADE_ID is immune to subagent session.start overwrites.
  // A subagent starting their own session sets CLEO_SESSION_ID (overwriting it), but never
  // touches CLEO_SESSION_GRADE_ID, so grade attribution stays correct throughout the scenario.
  const gradeId = process.env.CLEO_SESSION_GRADE_ID;
  if (gradeId && process.env.CLEO_SESSION_GRADE === 'true') {
    return { id: gradeId, gradeMode: true };
  }
  const envId = process.env.CLEO_SESSION_ID;
  if (envId) {
    return { id: envId, gradeMode: false };
  }
  try {
    const { getAccessor } = await import('../../store/data-accessor.js');
    const accessor = await getAccessor(process.cwd());
    const sessionsData = await accessor.loadSessions();
    const sessions = (sessionsData as unknown as {
      sessions?: Array<{ id: string; status: string; gradeMode?: boolean; startedAt?: string }>;
    }).sessions ?? [];
    const activeSessions = sessions.filter(s => s.status === 'active');
    // Prefer grade sessions; otherwise pick the most recently started active session
    const gradeSession = activeSessions.find(s => s.gradeMode === true);
    const active = gradeSession ?? activeSessions.sort((a, b) =>
      (b.startedAt ?? '').localeCompare(a.startedAt ?? '')
    )[0];
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

    // Capture session context BEFORE calling next() — session.end clears grade vars
    // inside next(), so reading after would lose the grade session attribution.
    const sessionInfo = await getActiveSessionInfo();
    const currentSessionId: string | null = req.sessionId || sessionInfo?.id || null;
    const isGradeSession = sessionInfo?.gradeMode === true || process.env.CLEO_SESSION_GRADE === 'true';

    const response = await next();

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
    const { and, eq, gte, or } = await import('drizzle-orm');

    const db = await getDb(process.cwd());

    // Use typed ORM query (not raw SQL) so drizzle returns named-field objects,
    // not positional arrays (node:sqlite setReturnArrays causes raw SQL to lose field names).
    const conditions = [];
    if (options?.sessionId) conditions.push(eq(auditLog.sessionId, options.sessionId));
    if (options?.domain) conditions.push(eq(auditLog.domain, options.domain));
    if (options?.operation) conditions.push(or(eq(auditLog.operation, options.operation), eq(auditLog.action, options.operation))!);
    if (options?.taskId) conditions.push(eq(auditLog.taskId, options.taskId));
    if (options?.since) conditions.push(gte(auditLog.timestamp, options.since));

    const limit = options?.limit ?? 1000;

    const rows = await db
      .select()
      .from(auditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(auditLog.timestamp)
      .limit(limit);

    return rows.map(row => ({
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
        gateway: row.gateway as 'cleo_mutate' | 'cleo_query' | undefined,
      },
      error: row.errorMessage ?? undefined,
    }));
  } catch {
    return [];
  }
}
