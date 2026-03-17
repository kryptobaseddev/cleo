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
import { getProjectInfoSync } from '../../core/project-info.js';
import { getConfig } from '../lib/config.js';
import type { DispatchNext, DispatchRequest, DispatchResponse, Middleware } from '../types.js';

const log = getLogger('audit');

/** Cached project hash — read once from project-info.json (immutable at runtime). */
let cachedProjectHash: string | null | undefined;
function resolveProjectHash(): string | null {
  if (cachedProjectHash !== undefined) return cachedProjectHash;
  try {
    const info = getProjectInfoSync();
    cachedProjectHash = info?.projectHash ?? null;
  } catch {
    cachedProjectHash = null;
  }
  return cachedProjectHash;
}

// AuditEntry type re-exported from core (canonical location)
export type { AuditEntry } from '../../core/audit.js';
import type { AuditEntry } from '../../core/audit.js';

/**
 * Check if the current context is a grade session.
 *
 * Now simplified: session-resolver middleware (T4959) populates request.sessionId
 * before audit runs, so we only need to check grade mode flags.
 */
function isGradeMode(): boolean {
  return process.env.CLEO_SESSION_GRADE === 'true';
}

/**
 * Get active session info from SQLite or env vars.
 *
 * Session-resolver middleware (T4959) now populates request.sessionId.
 * This function is retained as a fallback for edge cases where
 * session-resolver is not in the pipeline (e.g., tests, legacy callers).
 */
async function getActiveSessionInfo(): Promise<{ id: string; gradeMode: boolean } | null> {
  const gradeId = process.env.CLEO_SESSION_GRADE_ID;
  if (gradeId && process.env.CLEO_SESSION_GRADE === 'true') {
    return { id: gradeId, gradeMode: true };
  }
  const envId = process.env.CLEO_SESSION_ID;
  if (envId) {
    return { id: envId, gradeMode: false };
  }
  return null;
}

/**
 * Write audit entry to SQLite audit_log table.
 * Validates the payload with Zod before inserting.
 * Fire-and-forget — errors are logged to Pino but never thrown.
 *
 * @task T4848
 */
async function writeToSqlite(entry: AuditEntry, requestId?: string): Promise<void> {
  try {
    const { getDb } = await import('../../store/sqlite.js');
    const { auditLog } = await import('../../store/tasks-schema.js');
    const { AuditLogInsertSchema } = await import('../../store/validation-schemas.js');
    const { randomUUID } = await import('node:crypto');

    const payload = {
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
      // Project correlation (T5337)
      projectHash: resolveProjectHash(),
    };

    // Validate payload before insert (T4848)
    const parsed = AuditLogInsertSchema.safeParse(payload);
    if (!parsed.success) {
      log.warn(
        { issues: parsed.error.issues },
        'Audit payload failed Zod validation; skipping insert',
      );
      return;
    }

    const db = await getDb(process.cwd());
    await db.insert(auditLog).values(parsed.data).run();
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

    // T4959: session-resolver middleware now populates req.sessionId before
    // audit runs. Fall back to legacy lookup only if resolver missed it.
    const currentSessionId: string | null =
      req.sessionId ?? (await getActiveSessionInfo())?.id ?? null;
    const isGradeSession = isGradeMode();

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
        gateway: req.gateway as 'mutate' | 'query',
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

    // SQLite write — await in grade mode to avoid race with grading query;
    // fire-and-forget otherwise for performance.
    if (isGradeSession) {
      await writeToSqlite(entry, req.requestId);
    } else {
      writeToSqlite(entry, req.requestId).catch((err) => {
        log.error({ err }, 'Failed to persist audit entry to SQLite');
      });
    }

    return response;
  };
}

// queryAudit re-exported from core (canonical location)
export { queryAudit } from '../../core/audit.js';
