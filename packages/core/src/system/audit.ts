/**
 * Data integrity audit core module.
 * @task T4783
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTaskAccessor } from '../store/data-accessor.js';

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
  const { dbExists } = await import('../store/sqlite.js');
  const hasStore = dbExists(projectRoot);

  if (scope === 'all' || scope === 'tasks') {
    if (hasStore) {
      try {
        const accessor = await getTaskAccessor(projectRoot);
        const queryResult = await accessor.queryTasks({});
        const tasks = queryResult.tasks;

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
          message: `Failed to read task data from cleo.db: ${err}`,
        });
      }
    } else {
      issues.push({
        severity: 'error',
        category: 'tasks',
        message: 'Project store cleo.db not found',
      });
    }
  }

  if (scope === 'all' || scope === 'sessions') {
    if (hasStore) {
      try {
        const accessor = await getTaskAccessor(projectRoot);
        const sessions = await accessor.loadSessions();

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
          const requiredScopeField =
            s.scope.type === 'epic' ? 'epicId' : s.scope.type === 'task' ? 'rootTaskId' : undefined;
          if (requiredScopeField && !s.scope[requiredScopeField]) {
            issues.push({
              severity: 'warning',
              category: 'sessions',
              message: `Session ${s.id} missing scope ${requiredScopeField}`,
            });
          }
        }
      } catch (err) {
        issues.push({
          severity: 'error',
          category: 'sessions',
          message: `Failed to read session data from cleo.db: ${err}`,
        });
      }
    } else {
      issues.push({
        severity: 'error',
        category: 'sessions',
        message: 'Project store cleo.db not found',
      });
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
 * Reads from the canonical project cleo.db task audit table. Includes dispatch-level
 * fields (domain, requestId, durationMs, success, source, gateway, errorMessage)
 * when present.
 *
 * @param projectRoot - Absolute path to the project root
 * @param filters - Optional filter and pagination parameters
 * @returns Paginated log entries with metadata
 * @throws Propagates database and malformed audit-payload errors to the caller.
 *
 * @task T4837
 * @task T4844
 * @task T1571
 */
// SSoT-EXEMPT:engine-migration-T1571
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

  const { dbExists, getDb } = await import('../store/sqlite.js');
  if (!dbExists(projectRoot)) return emptyResult;
  const { sql } = await import('drizzle-orm');
  // Missing history is distinct from a failed read. Let DB and JSON errors
  // reach the dispatch error envelope instead of claiming an empty result.
  const db = await getDb(projectRoot);

  // T12306: read the CANONICAL receipt table, and keep legacy history reachable.
  //
  // The writer moved to `tasks_audit_log` with the E6 prefixed-store cutover,
  // while this public reader still selected from the bare `audit_log` relic. The
  // two never diverged loudly — they diverged SILENTLY: every new receipt was
  // written correctly and committed, and `cleo log` reported an empty history
  // for it. An empty successful read is the worst possible shape for an audit
  // surface, because it is indistinguishable from "nothing happened".
  //
  // Legacy rows are NOT migrated, rewritten or hidden here. Both tables are read
  // and combined, so authentic pre-cutover history stays addressable by the same
  // public query. `UNION` (not `UNION ALL`) collapses a row that exists
  // byte-identically in both after a copy-forward, while two rows sharing an id
  // but differing in content are BOTH surfaced rather than silently picking a
  // winner — conflicting provenance is a finding, not something to resolve here.
  const auditColumns = [
    'id',
    'timestamp',
    'action',
    'task_id',
    'actor',
    'details_json',
    'before_json',
    'after_json',
    'domain',
    'operation',
    'session_id',
    'request_id',
    'duration_ms',
    'success',
    'source',
    'gateway',
    'error_message',
  ].join(', ');

  // A store created after the cutover legitimately has no legacy table. Its
  // ABSENCE is normal and must not be read as a failure; a failure to ASK is
  // still propagated, because that is a broken read, not a missing table.
  const legacyPresence = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'`,
  );
  const hasLegacy = legacyPresence.length > 0;

  const auditSource = hasLegacy
    ? sql.raw(
        `(SELECT ${auditColumns} FROM tasks_audit_log UNION SELECT ${auditColumns} FROM audit_log)`,
      )
    : sql.raw(`(SELECT ${auditColumns} FROM tasks_audit_log)`);

  const conditions: ReturnType<typeof sql>[] = [];
  if (filters?.operation) {
    conditions.push(sql`(action = ${filters.operation} OR operation = ${filters.operation})`);
  }
  if (filters?.taskId) {
    conditions.push(sql`task_id = ${filters.taskId}`);
  }
  if (filters?.since) {
    conditions.push(sql`timestamp >= ${filters.since}`);
  }
  if (filters?.until) {
    conditions.push(sql`timestamp <= ${filters.until}`);
  }

  const whereClause = conditions.length > 0 ? sql.join(conditions, sql` AND `) : sql`1=1`;

  const countResult = await db.all<{ cnt: number }>(
    sql`SELECT count(*) as cnt FROM ${auditSource} AS audit_entries WHERE ${whereClause}`,
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
    sql`SELECT * FROM ${auditSource} AS audit_entries
        WHERE ${whereClause}
        ORDER BY timestamp DESC
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
}
