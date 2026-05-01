/**
 * Data integrity audit core module.
 * @task T4783
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAccessor } from '../store/data-accessor.js';
import { getTaskPath } from '../paths.js';

export interface AuditIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  fix?: string;
}

export interface AuditResult {
  scope: string;
  issues: AuditIssue[];
  summary: {
    errors: number;
    warnings: number;
    fixed: number;
  };
}

/** Audit data integrity. */
export async function auditData(
  projectRoot: string,
  opts?: { scope?: string; fix?: boolean },
): Promise<AuditResult> {
  const cleoDir = join(projectRoot, '.cleo');
  const scope = opts?.scope ?? 'all';
  const issues: AuditIssue[] = [];

  if (scope === 'all' || scope === 'tasks') {
    const tasksDbPath = join(cleoDir, 'tasks.db');
    if (existsSync(tasksDbPath)) {
      try {
        const accessor = await getAccessor(projectRoot);
        const queryResult = await accessor.queryTasks({});
        const tasks: Array<{
          id: string;
          status: string;
          title: string;
          parentId?: string | null;
          depends?: string[];
        }> = queryResult.tasks ?? [];

        const idSet = new Set<string>();
        for (const t of tasks) {
          if (idSet.has(t.id)) {
            issues.push({
              severity: 'error',
              category: 'tasks',
              message: `Duplicate task ID: ${t.id}`,
            });
          }
          idSet.add(t.id);
        }

        for (const t of tasks) {
          if (t.parentId && !idSet.has(t.parentId)) {
            issues.push({
              severity: 'warning',
              category: 'tasks',
              message: `Task ${t.id} references non-existent parent: ${t.parentId}`,
            });
          }
        }

        for (const t of tasks) {
          if (!t.title)
            issues.push({
              severity: 'error',
              category: 'tasks',
              message: `Task ${t.id} missing title`,
            });
          if (!t.status)
            issues.push({
              severity: 'error',
              category: 'tasks',
              message: `Task ${t.id} missing status`,
            });
        }

        for (const t of tasks) {
          if (t.depends) {
            for (const dep of t.depends) {
              if (!idSet.has(dep)) {
                issues.push({
                  severity: 'warning',
                  category: 'tasks',
                  message: `Task ${t.id} depends on non-existent: ${dep}`,
                });
              }
            }
          }
        }
      } catch (err) {
        issues.push({
          severity: 'error',
          category: 'tasks',
          message: `Failed to read tasks.db: ${err}`,
        });
      }
    }
  }

  if (scope === 'all' || scope === 'sessions') {
    const sessPath = join(cleoDir, 'sessions.json');
    if (existsSync(sessPath)) {
      try {
        const data = JSON.parse(readFileSync(sessPath, 'utf-8'));
        const sessions: Array<{ id: string; scope?: { rootTaskId?: string } }> =
          data.sessions ?? [];

        const sessionIds = new Set<string>();
        for (const s of sessions) {
          if (sessionIds.has(s.id)) {
            issues.push({
              severity: 'error',
              category: 'sessions',
              message: `Duplicate session ID: ${s.id}`,
            });
          }
          sessionIds.add(s.id);
        }

        for (const s of sessions) {
          if (!s.scope?.rootTaskId) {
            issues.push({
              severity: 'warning',
              category: 'sessions',
              message: `Session ${s.id} missing scope rootTaskId`,
            });
          }
        }
      } catch (err) {
        issues.push({
          severity: 'error',
          category: 'sessions',
          message: `Failed to parse sessions.json: ${err}`,
        });
      }
    }
  }

  if (scope === 'all') {
    const seqPath = join(cleoDir, '.sequence.json');
    if (existsSync(seqPath)) {
      try {
        const seq = JSON.parse(readFileSync(seqPath, 'utf-8'));
        if (typeof seq.counter !== 'number') {
          issues.push({
            severity: 'error',
            category: 'sequence',
            message: 'Sequence counter is not a number',
          });
        }
      } catch {
        issues.push({
          severity: 'error',
          category: 'sequence',
          message: 'Failed to parse .sequence.json',
        });
      }
    }
  }

  return {
    scope,
    issues,
    summary: {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      fixed: 0,
    },
  };
}

/** Paginated operation log query result. */
export interface LogQueryData {
  /** Log entries matching the query. */
  entries: Array<{
    /** Operation name. */
    operation: string;
    /** Task ID if applicable. */
    taskId?: string;
    /** ISO timestamp. */
    timestamp: string;
    [key: string]: unknown;
  }>;
  /** Pagination metadata. */
  pagination: {
    /** Total matching entries. */
    total: number;
    /** Current offset. */
    offset: number;
    /** Page size limit. */
    limit: number;
    /** Whether more entries exist beyond this page. */
    hasMore: boolean;
  };
}

/**
 * Query audit_log from SQLite with optional filters and pagination.
 *
 * Reads from the canonical tasks.db audit_log table. Includes dispatch-level
 * fields (domain, requestId, durationMs, success, source, gateway, errorMessage)
 * when present.
 *
 * @param projectRoot - Absolute path to the project root
 * @param filters - Optional filter and pagination parameters
 * @returns Paginated log entries with metadata
 *
 * @task T4837
 * @task T4844
 * @task T1571
 */
export async function queryAuditLog(
  projectRoot: string,
  filters?: {
    operation?: string;
    taskId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  },
): Promise<LogQueryData> {
  const offset = filters?.offset ?? 0;
  const limit = filters?.limit ?? 20;
  const emptyResult: LogQueryData = {
    entries: [],
    pagination: { total: 0, offset, limit, hasMore: false },
  };

  try {
    const dbPath = getTaskPath(projectRoot);
    if (!existsSync(dbPath)) return emptyResult;

    const { getDb } = await import('../store/sqlite.js');
    const { auditLog } = await import('../store/tasks-schema.js');
    const { sql } = await import('drizzle-orm');

    const db = await getDb(projectRoot);

    try {
      const conditions: ReturnType<typeof sql>[] = [];
      if (filters?.operation) {
        conditions.push(
          sql`(${auditLog.action} = ${filters.operation} OR ${auditLog.operation} = ${filters.operation})`,
        );
      }
      if (filters?.taskId) {
        conditions.push(sql`${auditLog.taskId} = ${filters.taskId}`);
      }
      if (filters?.since) {
        conditions.push(sql`${auditLog.timestamp} >= ${filters.since}`);
      }
      if (filters?.until) {
        conditions.push(sql`${auditLog.timestamp} <= ${filters.until}`);
      }

      const whereClause = conditions.length > 0 ? sql.join(conditions, sql` AND `) : sql`1=1`;

      const countResult = await db.all<{ cnt: number }>(
        sql`SELECT count(*) as cnt FROM ${auditLog} WHERE ${whereClause}`,
      );
      const total = countResult[0]?.cnt ?? 0;

      if (total === 0) {
        return { entries: [], pagination: { total: 0, offset, limit, hasMore: false } };
      }

      const rows = await db.all<{
        id: string;
        timestamp: string;
        action: string;
        task_id: string;
        actor: string;
        details_json: string | null;
        before_json: string | null;
        after_json: string | null;
        domain: string | null;
        operation: string | null;
        session_id: string | null;
        request_id: string | null;
        duration_ms: number | null;
        success: number | null;
        source: string | null;
        gateway: string | null;
        error_message: string | null;
      }>(
        sql`SELECT * FROM ${auditLog}
            WHERE ${whereClause}
            ORDER BY ${auditLog.timestamp} DESC
            LIMIT ${limit} OFFSET ${offset}`,
      );

      const entries = rows.map((row) => ({
        operation: row.operation ?? row.action,
        taskId: row.task_id,
        timestamp: row.timestamp,
        actor: row.actor,
        details: row.details_json ? JSON.parse(row.details_json) : {},
        before: row.before_json ? JSON.parse(row.before_json) : undefined,
        after: row.after_json ? JSON.parse(row.after_json) : undefined,
        ...(row.domain != null && {
          domain: row.domain,
          sessionId: row.session_id,
          requestId: row.request_id,
          durationMs: row.duration_ms,
          success: row.success === 1,
          source: row.source,
          gateway: row.gateway,
          error: row.error_message,
        }),
      }));

      return { entries, pagination: { total, offset, limit, hasMore: offset + limit < total } };
    } catch {
      return emptyResult;
    }
  } catch {
    return emptyResult;
  }
}
