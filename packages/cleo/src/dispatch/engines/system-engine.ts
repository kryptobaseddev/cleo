/**
 * System Engine
 *
 * Thin wrapper layer that delegates to core modules.
 * All business logic lives in src/core/.
 *
 * Read-only queries: dash, stats, labels, archive-stats, log, context, sequence,
 *   metrics, health, diagnostics, help, roadmap, compliance
 * Mutate operations: inject.generate, backup, restore, migrate, cleanup, audit,
 *   sync, safestop, uncancel
 *
 * @task T4631
 * @task T4783
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  type ArchiveReportType,
  analyzeArchive,
  auditData,
  cleanupSystem,
  systemCreateBackup as createBackup,
  ensureCleoOsHub,
  generateInjection,
  getAccessor,
  getArchiveStats,
  getCleoCantWorkflowsDir,
  getCleoConfigDir,
  getCleoGlobalAgentsDir,
  getCleoGlobalJustfilePath,
  getCleoGlobalRecipesDir,
  getCleoHome,
  getCleoPiExtensionsDir,
  getDashboard,
  getLabels,
  getMigrationStatus,
  getProjectStats,
  getRoadmap,
  getRuntimeDiagnostics,
  getSystemDiagnostics,
  getSystemHealth,
  getSystemMetrics,
  listSystemBackups,
  type RuntimeDiagnostics,
  repairSequence,
  restoreBackup,
  safestop,
  uncancelTask,
} from '@cleocode/core/internal';
import { cleoErrorToEngineError, type EngineResult, engineError } from './_error.js';
import type { TaskRecord } from './task-engine.js';

// Re-export types for downstream consumers
export type {
  ArchiveStatsResult as ArchiveStatsData,
  AuditResult as AuditData,
  BackupEntry as BackupEntryData,
  BackupResult as BackupData,
  CleanupResult as CleanupData,
  DiagnosticsResult as DiagnosticsData,
  HealthResult as HealthData,
  InjectGenerateResult as InjectGenerateData,
  LabelsResult as LabelsData,
  MigrateResult as MigrateData,
  RestoreResult as RestoreData,
  SafestopResult as SafestopData,
  SystemMetricsResult as MetricsData,
  UncancelResult as UncancelData,
} from '@cleocode/core/internal';
export type RuntimeData = RuntimeDiagnostics;

/**
 * Dashboard data shape returned by {@link systemDash}.
 *
 * @remarks
 * Contains project overview metrics, active session/task info,
 * high-priority and blocked task lists, and recent completions.
 */
export interface DashboardData {
  /** Project name or directory basename. */
  project: string;
  /** Currently active project phase, or null. */
  currentPhase: string | null;
  /** Task count breakdown by status. */
  summary: {
    /** Pending tasks count. */
    pending: number;
    /** Active tasks count. */
    active: number;
    /** Blocked tasks count. */
    blocked: number;
    /** Completed tasks count. */
    done: number;
    /** Cancelled tasks count. */
    cancelled: number;
    /** Total active (non-archived) tasks. */
    total: number;
    /** Archived tasks count. */
    archived: number;
    /** Active + archived total. */
    grandTotal: number;
  };
  /** Currently focused task work state. */
  taskWork: {
    /** Current task ID, or null. */
    currentTask: string | null;
    /** Full task record for the current task, or null. */
    task: TaskRecord | null;
  };
  /** Active session ID, or null. */
  activeSession: string | null;
  /** High-priority tasks summary. */
  highPriority: {
    /** Number of high-priority tasks. */
    count: number;
    /** High-priority task records. */
    tasks: TaskRecord[];
  };
  /** Blocked tasks summary. */
  blockedTasks: {
    /** Number of blocked tasks. */
    count: number;
    /** Display limit applied. */
    limit: number;
    /** Blocked task records (up to limit). */
    tasks: TaskRecord[];
  };
  /** Recently completed task records. */
  recentCompletions: TaskRecord[];
  /** Most frequently used labels with counts. */
  topLabels: Array<{ /** Label name. */ label: string /** Usage count. */; count: number }>;
}

/**
 * Project statistics data shape returned by {@link systemStats}.
 *
 * @remarks
 * Comprehensive breakdown of task counts by status, priority, type,
 * phase, with completion/activity metrics over a configurable period.
 */
export interface StatsData {
  /** Current task counts by status. */
  currentState: {
    /** Pending tasks. */ pending: number;
    /** Active tasks. */ active: number;
    /** Done tasks. */ done: number;
    /** Blocked tasks. */ blocked: number;
    /** Cancelled tasks. */ cancelled: number;
    /** Total non-archived. */ totalActive: number;
    /** Archived tasks. */ archived: number;
    /** Active + archived. */ grandTotal: number;
  };
  /** Task counts grouped by priority level. */
  byPriority: Record<string, number>;
  /** Task counts grouped by task type. */
  byType: Record<string, number>;
  /** Task counts grouped by project phase. */
  byPhase: Record<string, number>;
  /** Completion rate metrics over the configured period. */
  completionMetrics: {
    /** Number of days in the measurement period. */ periodDays: number;
    /** Tasks completed in the period. */ completedInPeriod: number;
    /** Tasks created in the period. */ createdInPeriod: number;
    /** Completion rate (completed/created). */ completionRate: number;
  };
  /** Activity metrics over the configured period. */
  activityMetrics: {
    /** Tasks created in the period. */ createdInPeriod: number;
    /** Tasks completed in the period. */ completedInPeriod: number;
    /** Tasks archived in the period. */ archivedInPeriod: number;
  };
  /** Lifetime metrics across all time. */
  allTime: {
    /** Total tasks ever created. */ totalCreated: number;
    /** Total tasks ever completed. */ totalCompleted: number;
    /** Total tasks ever cancelled. */ totalCancelled: number;
    /** Total tasks ever archived. */ totalArchived: number;
    /** Completed tasks in archive. */ archivedCompleted: number;
  };
  /** Average time from creation to completion. */
  cycleTimes: {
    /** Average days to complete, or null if insufficient data. */ averageDays: number | null;
    /** Number of completed tasks used for the average. */ samples: number;
  };
}

/** Paginated operation log query result. */
export interface LogQueryData {
  /** Log entries matching the query. */
  entries: Array<{
    /** Operation name. */ operation: string /** Task ID if applicable. */;
    taskId?: string /** ISO timestamp. */;
    timestamp: string;
    [key: string]: unknown;
  }>;
  /** Pagination metadata. */
  pagination: {
    /** Total matching entries. */ total: number;
    /** Current offset. */ offset: number;
    /** Page size limit. */ limit: number;
    /** Whether more entries exist beyond this page. */ hasMore: boolean;
  };
}

/** Context window monitoring data. */
export interface ContextData {
  /** Whether context data is available. */ available: boolean;
  /** Status level (ok, warning, caution, critical, emergency). */ status: string;
  /** Usage percentage (0-100). */ percentage: number;
  /** Current token usage. */ currentTokens: number;
  /** Maximum context window size. */ maxTokens: number;
  /** ISO timestamp of last update, or null. */ timestamp: string | null;
  /** Whether the data is stale (older than configured threshold). */ stale: boolean;
  /** Per-session context state entries. */
  sessions: Array<{
    /** State file path. */ file: string;
    /** Session ID, or null. */ sessionId: string | null;
    /** Usage percentage. */ percentage: number;
    /** Status level. */ status: string;
    /** ISO timestamp. */ timestamp: string;
  }>;
}

/** Task ID sequence state. */
export interface SequenceData {
  /** Current counter value. */ counter: number;
  /** Last assigned task ID. */ lastId: string;
  /** Integrity checksum. */ checksum: string;
  /** Next task ID that would be assigned. */ nextId: string;
}

/** Project roadmap data with upcoming epics and release history. */
export interface RoadmapData {
  /** Current project version. */ currentVersion: string;
  /** Upcoming epics and milestones. */
  upcoming: Array<{
    /** Task ID. */ id: string;
    /** Title. */ title: string;
    /** Status. */ status: string;
    /** Priority. */ priority: string;
    /** Phase. */ phase?: string;
    /** Total child tasks. */ childCount: number;
    /** Completed child tasks. */ completedChildren: number;
  }>;
  /** Past releases. */ releaseHistory?: Array<{
    /** Version tag. */ version: string /** Release date. */;
    date: string;
  }>;
  /** Total completed epics. */ completedEpics?: number;
  /** Summary counts. */
  summary: {
    /** Upcoming epics count. */ totalUpcoming: number;
    /** Total tasks across epics. */ totalTasks: number;
  };
}

/** Compliance monitoring data. */
export interface ComplianceData {
  /** Total compliance audit entries. */ totalEntries: number;
  /** Average pass rate (0-100). */ averagePassRate: number;
  /** Average adherence score (0-100). */ averageAdherence: number;
  /** Total violation count. */ totalViolations: number;
  /** Trend direction (improving, declining, stable). */ trend?: string;
  /** Historical data points for charting. */
  dataPoints?: Array<{
    /** Date string. */ date: string;
    /** Entries on this date. */ entries: number;
    /** Average pass rate on this date. */ avgPassRate: number;
    /** Violations on this date. */ violations: number;
  }>;
}

/** Help topic content and related commands. */
export interface HelpData {
  /** Topic identifier. */ topic?: string;
  /** Human-readable help content. */ content: string;
  /** Related CLI commands for cross-reference. */ relatedCommands?: string[];
}

// ===== Help topics (static data, stays in engine) =====
const HELP_TOPICS: Record<string, HelpData> = {
  session: {
    topic: 'session',
    content: [
      'Session Management',
      '',
      '  cleosession list                        - List all sessions',
      '  cleosession start --scope epic:T001     - Start session',
      '  cleosession end --note "Progress"       - End session',
      '  cleosession resume <id>                 - Resume session',
    ].join('\n'),
    relatedCommands: ['cleo session list', 'cleo session start', 'cleo session end'],
  },
  tasks: {
    topic: 'tasks',
    content: [
      'Task Operations',
      '',
      '  cleoadd "Title" --desc "Description"    - Create task',
      '  cleoupdate T1234 --status active        - Update task',
      '  cleocomplete T1234                      - Complete task',
      '  cleofind "query"                        - Search tasks',
      '  cleoshow T1234                          - Show task details',
    ].join('\n'),
    relatedCommands: ['cleo add', 'cleo update', 'cleo complete', 'cleo find', 'cleo show'],
  },
  focus: {
    topic: 'focus',
    content: [
      'Task Work Management',
      '',
      '  cleostart T1234    - Start working on task',
      '  cleocurrent        - Show current task',
      '  cleostop           - Stop working on current task',
    ].join('\n'),
    relatedCommands: ['cleo start', 'cleo current', 'cleo stop'],
  },
  labels: {
    topic: 'labels',
    content: [
      'Label Operations',
      '',
      '  cleolabels              - List all labels',
      '  cleolabels show <name>  - Show tasks with label',
    ].join('\n'),
    relatedCommands: ['cleo labels'],
  },
  compliance: {
    topic: 'compliance',
    content: [
      'Compliance Monitoring',
      '',
      '  cleocompliance summary     - Compliance overview',
      '  cleocompliance violations  - List violations',
      '  cleocompliance trend       - Compliance trend',
    ].join('\n'),
    relatedCommands: ['cleo compliance summary', 'cleo compliance violations'],
  },
};

// ===== Dashboard =====

/**
 * Project dashboard: task counts by status, active session info,
 * current focus, recent completions.
 *
 * @remarks
 * This is the primary overview endpoint for the CLEO CLI `dash` command.
 * It aggregates task counts, current session/focus state, high-priority tasks,
 * blocked tasks, and recent completions into a single response.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional parameters to control blocked tasks display limit
 * @returns EngineResult with comprehensive dashboard data
 *
 * @example
 * ```typescript
 * const result = await systemDash('/project', { blockedTasksLimit: 5 });
 * ```
 */
export async function systemDash(
  projectRoot: string,
  params?: { blockedTasksLimit?: number },
): Promise<EngineResult<DashboardData>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await getDashboard(
      { cwd: projectRoot, blockedTasksLimit: params?.blockedTasksLimit },
      accessor,
    );
    // Add missing fields that core doesn't produce
    const data = result as Record<string, unknown>;
    const summary = data.summary as Record<string, number>;
    return {
      success: true,
      data: {
        project: data.project as string,
        currentPhase: data.currentPhase as string | null,
        summary: {
          pending: summary.pending,
          active: summary.active,
          blocked: summary.blocked,
          done: summary.done,
          cancelled: summary.cancelled ?? 0,
          total: summary.total,
          archived: summary.archived ?? 0,
          grandTotal: summary.grandTotal ?? summary.total,
        },
        taskWork: (data.focus ?? data.taskWork) as DashboardData['taskWork'],
        activeSession: ((data as Record<string, unknown>).activeSession as string | null) ?? null,
        highPriority: data.highPriority as DashboardData['highPriority'],
        blockedTasks: data.blockedTasks as DashboardData['blockedTasks'],
        recentCompletions: (data.recentCompletions ?? []) as TaskRecord[],
        topLabels: data.topLabels as DashboardData['topLabels'],
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'System not initialized');
  }
}

// ===== Stats =====

/**
 * Detailed statistics: tasks by status/priority/type/phase,
 * completion rate, average cycle time.
 */
export async function systemStats(
  projectRoot: string,
  params?: { period?: number },
): Promise<EngineResult<StatsData>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await getProjectStats(
      { period: String(params?.period ?? 30), cwd: projectRoot },
      accessor,
    );
    // Core stats lacks byPriority, byType, byPhase, cycleTimes — fill from accessor
    const queryResult = await accessor.queryTasks({});
    const tasks = (queryResult?.tasks as TaskRecord[]) ?? [];

    // Distribution breakdowns: active tasks only (exclude cancelled — not actionable work)
    const activeTasks = tasks.filter((t) => t.status !== 'cancelled');
    const byPriority: Record<string, number> = {};
    for (const t of activeTasks) {
      byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
    }
    const byType: Record<string, number> = {};
    for (const t of activeTasks) {
      const type = t.type || 'task';
      byType[type] = (byType[type] ?? 0) + 1;
    }
    // byPhase tracks RCASD-IVTR+C pipeline stages (pipelineStage), not project phases (phase).
    // t.phase is a legacy project-phase field (e.g. "Phase 1"); t.pipelineStage is RCASD.
    const byPhase: Record<string, number> = {};
    for (const t of activeTasks) {
      const phase = t.pipelineStage || 'unassigned';
      byPhase[phase] = (byPhase[phase] ?? 0) + 1;
    }

    // Cycle times
    const completedTasks = tasks.filter((t) => t.status === 'done' && t.completedAt && t.createdAt);
    let totalCycleDays = 0;
    let samples = 0;
    for (const t of completedTasks) {
      const created = new Date(t.createdAt).getTime();
      const completed = new Date(t.completedAt!).getTime();
      if (completed > created) {
        totalCycleDays += (completed - created) / 86400000;
        samples++;
      }
    }
    const averageDays = samples > 0 ? Math.round((totalCycleDays / samples) * 100) / 100 : null;

    const coreData = result as Record<string, unknown>;
    const currentState = coreData.currentState as Record<string, number>;
    const completionMetrics = coreData.completionMetrics as Record<string, number>;
    const activityMetrics = coreData.activityMetrics as Record<string, number>;
    const allTime = coreData.allTime as Record<string, number>;

    return {
      success: true,
      data: {
        currentState: {
          pending: currentState.pending,
          active: currentState.active,
          done: currentState.done,
          blocked: currentState.blocked,
          cancelled: tasks.filter((t) => t.status === 'cancelled').length,
          totalActive: currentState.totalActive,
          archived: currentState.archived ?? 0,
          grandTotal: currentState.grandTotal ?? currentState.totalActive,
        },
        byPriority,
        byType,
        byPhase,
        completionMetrics: completionMetrics as StatsData['completionMetrics'],
        activityMetrics: activityMetrics as StatsData['activityMetrics'],
        allTime: allTime as StatsData['allTime'],
        cycleTimes: { averageDays, samples },
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to get stats');
  }
}

// ===== Labels =====

/**
 * List all unique labels across tasks with counts and task IDs per label.
 */
export async function systemLabels(
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/core/internal').LabelsResult>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await getLabels(projectRoot, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to get labels');
  }
}

// ===== Archive Stats =====

/**
 * Archive metrics: total archived, by reason, average cycle time, archive rate.
 * When a report type is specified, delegates to analyzeArchive for detailed analytics.
 */
export async function systemArchiveStats(
  projectRoot: string,
  params?: { period?: number; report?: ArchiveReportType; since?: string; until?: string },
): Promise<EngineResult> {
  try {
    const accessor = await getAccessor(projectRoot);

    // If a non-default report type is requested, use the full analytics engine
    if (params?.report && params.report !== 'summary') {
      const result = await analyzeArchive(
        {
          report: params.report,
          since: params.since,
          until: params.until,
          cwd: projectRoot,
        },
        accessor,
      );
      return { success: true, data: result };
    }

    const result = await getArchiveStats({ period: params?.period, cwd: projectRoot }, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to get archive stats');
  }
}

// ===== Log =====

/**
 * Query audit log with optional filters.
 * Reads from SQLite audit_log table.
 *
 * @task T4837
 */
export async function systemLog(
  projectRoot: string,
  filters?: {
    operation?: string;
    taskId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  },
): Promise<EngineResult<LogQueryData>> {
  try {
    // Canonical path: SQLite audit_log table.
    const entries = await queryAuditLogSqlite(projectRoot, filters);
    return { success: true, data: entries };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_FILE_ERROR', 'Failed to read audit log');
  }
}

/**
 * Query audit_log from SQLite.
 * Includes dispatch-level fields (domain, requestId, durationMs, success,
 * source, gateway, errorMessage) when present (T4844).
 *
 * @task T4837
 * @task T4844
 */
async function queryAuditLogSqlite(
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
  try {
    const { join } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const dbPath = join(projectRoot, '.cleo', 'tasks.db');
    if (!existsSync(dbPath)) {
      const offset = filters?.offset ?? 0;
      const limit = filters?.limit ?? 20;
      return {
        entries: [],
        pagination: { total: 0, offset, limit, hasMore: false },
      };
    }

    const { getDb } = await import('@cleocode/core/internal');
    const { auditLog } = await import('@cleocode/core/internal');
    const { sql } = await import('drizzle-orm');

    const db = await getDb(projectRoot);

    // Check if audit_log table exists and has data
    try {
      // Build dynamic WHERE conditions
      const conditions: ReturnType<typeof sql>[] = [];
      if (filters?.operation) {
        // Match against both legacy 'action' column and new 'operation' column
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

      // Count total matching entries
      const countResult = await db.all<{ cnt: number }>(
        sql`SELECT count(*) as cnt FROM ${auditLog} WHERE ${whereClause}`,
      );
      const total = countResult[0]?.cnt ?? 0;

      if (total === 0) {
        return {
          entries: [],
          pagination: {
            total: 0,
            offset: filters?.offset ?? 0,
            limit: filters?.limit ?? 20,
            hasMore: false,
          },
        };
      }

      const offset = filters?.offset ?? 0;
      const limit = filters?.limit ?? 20;

      // Fetch paginated results (includes dispatch-level columns)
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
        // Dispatch-level fields (may be null for legacy task-only entries)
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

      return {
        entries,
        pagination: { total, offset, limit, hasMore: offset + limit < total },
      };
    } catch {
      const offset = filters?.offset ?? 0;
      const limit = filters?.limit ?? 20;
      return {
        entries: [],
        pagination: { total: 0, offset, limit, hasMore: false },
      };
    }
  } catch {
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? 20;
    return {
      entries: [],
      pagination: { total: 0, offset, limit, hasMore: false },
    };
  }
}

// ===== Context =====

/**
 * Context window tracking: estimate token usage from current session/state.
 */
export function systemContext(
  projectRoot: string,
  params?: { session?: string },
): EngineResult<ContextData> {
  try {
    const cleoDir = join(projectRoot, '.cleo');

    // Resolve state file
    let stateFile: string;
    if (params?.session) {
      const sessionFile = join(cleoDir, 'context-states', `context-state-${params.session}.json`);
      stateFile = existsSync(sessionFile) ? sessionFile : join(cleoDir, '.context-state.json');
    } else {
      const currentSessionPath = join(cleoDir, '.current-session');
      if (existsSync(currentSessionPath)) {
        const currentSession = readFileSync(currentSessionPath, 'utf-8').trim();
        if (currentSession) {
          const sessionFile = join(
            cleoDir,
            'context-states',
            `context-state-${currentSession}.json`,
          );
          stateFile = existsSync(sessionFile) ? sessionFile : join(cleoDir, '.context-state.json');
        } else {
          stateFile = join(cleoDir, '.context-state.json');
        }
      } else {
        stateFile = join(cleoDir, '.context-state.json');
      }
    }

    // Collect session files
    const sessions: ContextData['sessions'] = [];
    const statesDir = join(cleoDir, 'context-states');
    if (existsSync(statesDir)) {
      for (const file of readdirSync(statesDir) as string[]) {
        if (file.startsWith('context-state-') && file.endsWith('.json')) {
          try {
            const state = JSON.parse(readFileSync(join(statesDir, file), 'utf-8'));
            sessions.push({
              file: basename(file),
              sessionId: state.sessionId ?? null,
              percentage: state.contextWindow?.percentage ?? 0,
              status: state.status ?? 'unknown',
              timestamp: state.timestamp,
            });
          } catch {
            // skip invalid files
          }
        }
      }
    }

    const singletonFile = join(cleoDir, '.context-state.json');
    if (existsSync(singletonFile)) {
      try {
        const state = JSON.parse(readFileSync(singletonFile, 'utf-8'));
        sessions.push({
          file: '.context-state.json',
          sessionId: state.sessionId ?? 'global',
          percentage: state.contextWindow?.percentage ?? 0,
          status: state.status ?? 'unknown',
          timestamp: state.timestamp,
        });
      } catch {
        // skip
      }
    }

    if (!existsSync(stateFile)) {
      return {
        success: true,
        data: {
          available: false,
          status: 'unavailable',
          percentage: 0,
          currentTokens: 0,
          maxTokens: 0,
          timestamp: null,
          stale: true,
          sessions,
        },
      };
    }

    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      const timestamp = state.timestamp;
      const staleMs = state.staleAfterMs ?? 5000;
      const percentage = state.contextWindow?.percentage ?? 0;
      const current = state.contextWindow?.currentTokens ?? 0;
      const max = state.contextWindow?.maxTokens ?? 0;
      let status = state.status ?? 'unknown';

      const fileTime = new Date(timestamp).getTime();
      if (Date.now() - fileTime > staleMs) {
        status = 'stale';
      }

      return {
        success: true,
        data: {
          available: true,
          status,
          percentage,
          currentTokens: current,
          maxTokens: max,
          timestamp,
          stale: status === 'stale',
          sessions,
        },
      };
    } catch {
      return {
        success: true,
        data: {
          available: false,
          status: 'error',
          percentage: 0,
          currentTokens: 0,
          maxTokens: 0,
          timestamp: null,
          stale: true,
          sessions,
        },
      };
    }
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'System operation failed');
  }
}

// ===== Sequence =====

/**
 * Read task ID sequence state from canonical SQLite metadata.
 * Supports 'show' and 'check' actions.
 * @task T4815
 */
export async function systemSequence(
  projectRoot: string,
  params?: { action?: 'show' | 'check' },
): Promise<EngineResult<SequenceData | Record<string, unknown>>> {
  const { showSequence, checkSequence } = await import('@cleocode/core/internal');
  try {
    const action = params?.action ?? 'show';
    if (action === 'check') {
      const check = await checkSequence(projectRoot);
      return { success: true, data: check };
    }

    const seq = await showSequence(projectRoot);
    return {
      success: true,
      data: {
        counter: Number(seq.counter ?? 0),
        lastId: String(seq.lastId ?? ''),
        checksum: String(seq.checksum ?? ''),
        nextId: String(seq.nextId ?? ''),
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_FOUND', 'Sequence not found');
  }
}

// ===== Inject Generate (MVI) =====

/**
 * Generate Minimum Viable Injection (MVI).
 */
export async function systemInjectGenerate(
  projectRoot?: string,
): Promise<EngineResult<import('@cleocode/core/internal').InjectGenerateResult>> {
  try {
    const root = projectRoot || process.cwd();
    const accessor = await getAccessor(root);
    const result = await generateInjection(root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to generate injection');
  }
}

// ===== Metrics =====

/**
 * System metrics: token usage, compliance summary, session counts.
 * @task T4631
 */
export async function systemMetrics(
  projectRoot: string,
  params?: { scope?: string; since?: string },
): Promise<EngineResult<import('@cleocode/core/internal').SystemMetricsResult>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await getSystemMetrics(projectRoot, params, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to get metrics');
  }
}

// ===== Health =====

/**
 * System health check: verify core data files exist and are valid.
 * @task T4631
 */
export async function systemHealth(
  projectRoot: string,
  params?: { detailed?: boolean },
): Promise<EngineResult<import('@cleocode/core/internal').HealthResult>> {
  try {
    const result = await getSystemHealth(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to get health');
  }
}

// ===== Diagnostics =====

/**
 * System diagnostics: extended health checks with fix suggestions.
 * @task T4631
 */
export async function systemDiagnostics(
  projectRoot: string,
  params?: { checks?: string[] },
): Promise<EngineResult<import('@cleocode/core/internal').DiagnosticsResult>> {
  try {
    const result = await getSystemDiagnostics(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to get diagnostics');
  }
}

// ===== Help =====

/**
 * Return help text for the system.
 * @task T4631
 */
export function systemHelp(
  _projectRoot: string,
  params?: { topic?: string },
): EngineResult<HelpData> {
  const topic = params?.topic;

  if (topic) {
    const topicHelp = HELP_TOPICS[topic];
    if (topicHelp) {
      return { success: true, data: topicHelp };
    }
    return engineError(
      'E_NOT_FOUND',
      `Unknown help topic: ${topic}. Available topics: ${Object.keys(HELP_TOPICS).join(', ')}`,
    );
  }

  return {
    success: true,
    data: {
      content: [
        'CLEO Task Management System',
        '',
        'Essential Commands:',
        '  cleofind "query"    - Fuzzy search tasks',
        '  cleoshow T1234      - Full task details',
        '  cleoadd "Task"      - Create task',
        '  cleodone <id>       - Complete task',
        '  cleostart <id>      - Start working on task',
        '  cleodash            - Project overview',
        '  cleosession list    - List sessions',
        '',
        'Help Topics: session, tasks, focus, labels, compliance',
      ].join('\n'),
      relatedCommands: ['cleo find', 'cleo show', 'cleo add', 'cleo done', 'cleo dash'],
    },
  };
}

// ===== Roadmap =====

/**
 * Generate roadmap from pending epics and optional CHANGELOG history.
 * @task T4631
 */
export async function systemRoadmap(
  projectRoot: string,
  params?: { includeHistory?: boolean; upcomingOnly?: boolean },
): Promise<EngineResult> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await getRoadmap(
      {
        includeHistory: params?.includeHistory,
        upcomingOnly: params?.upcomingOnly,
        cwd: projectRoot,
      },
      accessor,
    );
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'System not initialized');
  }
}

// ===== Compliance =====

/**
 * System compliance report from COMPLIANCE.jsonl.
 * @task T4631
 */
export function systemCompliance(
  projectRoot: string,
  params?: { subcommand?: string; days?: number; epic?: string },
): EngineResult<ComplianceData> {
  try {
    if (params?.subcommand === 'trend') {
      const compliancePath = join(projectRoot, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
      let entries: Record<string, unknown>[] = [];

      if (existsSync(compliancePath)) {
        const content = readFileSync(compliancePath, 'utf-8').trim();
        if (content) {
          entries = content
            .split('\n')
            .filter((l: string) => l.trim())
            .map((l: string) => JSON.parse(l));
        }
      }

      if (params.epic) {
        entries = entries.filter((e) => {
          const ctx = (e._context ?? {}) as Record<string, unknown>;
          return ctx.epic_id === params.epic || ctx.task_id === params.epic;
        });
      }
      if (params.days) {
        const cutoff = new Date(Date.now() - params.days * 86400000).toISOString();
        entries = entries.filter((e) => (e.timestamp as string) >= cutoff);
      }

      const totalEntries = entries.length;
      const compliance = entries.map((e) => (e.compliance ?? {}) as Record<string, unknown>);
      const avgPassRate =
        totalEntries > 0
          ? Math.round(
              (compliance.reduce((sum, c) => sum + ((c.compliance_pass_rate as number) ?? 0), 0) /
                totalEntries) *
                1000,
            ) / 1000
          : 0;
      const avgAdherence =
        totalEntries > 0
          ? Math.round(
              (compliance.reduce((sum, c) => sum + ((c.rule_adherence_score as number) ?? 0), 0) /
                totalEntries) *
                1000,
            ) / 1000
          : 0;
      const totalViolations = compliance.reduce(
        (sum, c) => sum + ((c.violation_count as number) ?? 0),
        0,
      );

      const byDate: Record<string, Record<string, unknown>[]> = {};
      for (const e of entries) {
        const date = (e.timestamp as string).split('T')[0]!;
        if (!byDate[date]) byDate[date] = [];
        byDate[date]!.push(e);
      }

      const dataPoints = Object.entries(byDate)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, dayEntries]) => {
          const dayCompliance = dayEntries.map(
            (de) => (de.compliance ?? {}) as Record<string, unknown>,
          );
          return {
            date,
            entries: dayEntries.length,
            avgPassRate:
              dayCompliance.reduce((s, c) => s + ((c.compliance_pass_rate as number) ?? 0), 0) /
              dayEntries.length,
            violations: dayCompliance.reduce((s, c) => s + ((c.violation_count as number) ?? 0), 0),
          };
        });

      let trend: string;
      if (dataPoints.length >= 2) {
        const first = dataPoints[0]!.avgPassRate;
        const last = dataPoints[dataPoints.length - 1]!.avgPassRate;
        trend = last > first ? 'improving' : last < first ? 'declining' : 'stable';
      } else {
        trend = 'insufficient_data';
      }

      return {
        success: true,
        data: {
          totalEntries,
          averagePassRate: avgPassRate,
          averageAdherence: avgAdherence,
          totalViolations,
          trend,
          dataPoints,
        },
      };
    }

    // Default: summary (possibly filtered by epic/days)
    const compliancePath = join(projectRoot, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
    let entries: Record<string, unknown>[] = [];

    if (existsSync(compliancePath)) {
      const content = readFileSync(compliancePath, 'utf-8').trim();
      if (content) {
        entries = content
          .split('\n')
          .filter((l: string) => l.trim())
          .map((l: string) => JSON.parse(l));
      }
    }

    if (params?.epic) {
      entries = entries.filter((e) => {
        const ctx = (e._context ?? {}) as Record<string, unknown>;
        return ctx.epic_id === params.epic || ctx.task_id === params.epic;
      });
    }
    if (params?.days) {
      const cutoff = new Date(Date.now() - params.days * 86400000).toISOString();
      entries = entries.filter((e) => (e.timestamp as string) >= cutoff);
    }

    const totalEntries = entries.length;
    const compliance = entries.map((e) => (e.compliance ?? {}) as Record<string, unknown>);
    const avgPassRate =
      totalEntries > 0
        ? Math.round(
            (compliance.reduce((sum, c) => sum + ((c.compliance_pass_rate as number) ?? 0), 0) /
              totalEntries) *
              1000,
          ) / 1000
        : 0;
    const avgAdherence =
      totalEntries > 0
        ? Math.round(
            (compliance.reduce((sum, c) => sum + ((c.rule_adherence_score as number) ?? 0), 0) /
              totalEntries) *
              1000,
          ) / 1000
        : 0;
    const totalViolations = compliance.reduce(
      (sum, c) => sum + ((c.violation_count as number) ?? 0),
      0,
    );

    return {
      success: true,
      data: {
        totalEntries,
        averagePassRate: avgPassRate,
        averageAdherence: avgAdherence,
        totalViolations,
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to get roadmap');
  }
}

// ===== Backup =====

/**
 * Create a backup of CLEO data files.
 *
 * Async because `createBackup` (T5158) now opens tasks.db + brain.db via
 * their drizzle accessors before snapshotting so both databases are
 * captured even when the current CLI command path hasn't already opened
 * them (e.g. `cleo backup add` in a fresh process).
 *
 * @task T4631
 * @task T5158
 */
export async function systemBackup(
  projectRoot: string,
  params?: { type?: string; note?: string },
): Promise<EngineResult<import('@cleocode/core/internal').BackupResult>> {
  try {
    const result = await createBackup(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to create backup');
  }
}

/**
 * List available system backups (read-only).
 * @task T4783
 */
export function systemListBackups(
  projectRoot: string,
): EngineResult<import('@cleocode/core/internal').BackupEntry[]> {
  try {
    const result = listSystemBackups(projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to list backups');
  }
}

// ===== Restore =====

/**
 * Restore from a backup.
 * @task T4631
 */
export function systemRestore(
  projectRoot: string,
  params: { backupId: string; force?: boolean },
): EngineResult<import('@cleocode/core/internal').RestoreResult> {
  try {
    const result = restoreBackup(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_RESTORE_FAILED', 'Failed to restore');
  }
}

/**
 * Restore an individual file from backup.
 * @task T5329
 */
export async function backupRestore(
  projectRoot: string,
  fileName: string,
  options?: { dryRun?: boolean },
): Promise<
  EngineResult<{
    restored: boolean;
    file: string;
    from: string;
    targetPath: string;
    dryRun?: boolean;
  }>
> {
  try {
    const { getBackupDir, getTaskPath, getConfigPath } = await import('@cleocode/core/internal');
    const { restoreFromBackup, listBackups } = await import('@cleocode/core/internal');

    const backupDir = getBackupDir(projectRoot);

    const targetPathMap: Record<string, () => string> = {
      'tasks.db': getTaskPath,
      'config.json': getConfigPath,
    };

    const pathGetter = targetPathMap[fileName];
    if (!pathGetter) {
      return engineError(
        'E_INVALID_INPUT',
        `Unknown file: ${fileName}. Valid files: tasks.db, config.json`,
      );
    }

    const targetPath = pathGetter();

    const backups = await listBackups(fileName, backupDir);
    if (backups.length === 0) {
      return engineError('E_NOT_FOUND', `No backups found for ${fileName}`);
    }

    if (options?.dryRun) {
      return {
        success: true,
        data: {
          restored: false,
          file: fileName,
          from: backups[0]!,
          targetPath,
          dryRun: true,
        },
      };
    }

    const restoredFrom = await restoreFromBackup(fileName, backupDir, targetPath);

    return {
      success: true,
      data: {
        restored: true,
        file: fileName,
        from: restoredFrom,
        targetPath,
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Backup restore failed');
  }
}

// ===== Migrate =====

/**
 * Check/run schema migrations.
 * @task T4631
 */
export async function systemMigrate(
  projectRoot: string,
  params?: { target?: string; dryRun?: boolean },
): Promise<EngineResult<import('@cleocode/core/internal').MigrateResult>> {
  try {
    const result = await getMigrationStatus(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_MIGRATE_FAILED', 'Failed to migrate');
  }
}

// ===== Cleanup =====

/**
 * Cleanup stale data (sessions, backups, logs).
 * @task T4631
 */
export async function systemCleanup(
  projectRoot: string,
  params: { target: string; olderThan?: string; dryRun?: boolean },
): Promise<EngineResult<import('@cleocode/core/internal').CleanupResult>> {
  try {
    const result = await cleanupSystem(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_CLEANUP_FAILED', 'Failed to cleanup');
  }
}

// ===== Audit =====

/**
 * Audit data integrity.
 * @task T4631
 */
export async function systemAudit(
  projectRoot: string,
  params?: { scope?: string; fix?: boolean },
): Promise<EngineResult<import('@cleocode/core/internal').AuditResult>> {
  try {
    const result = await auditData(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to audit');
  }
}

// ===== Sync =====

export interface SyncData {
  direction: string;
  synced: number;
  conflicts: number;
  message: string;
}

/**
 * Sync check (no external sync targets in native mode).
 * @task T4631
 */
export function systemSync(
  _projectRoot: string,
  params?: { direction?: string },
): EngineResult<SyncData> {
  return {
    success: true,
    data: {
      direction: params?.direction ?? 'up',
      synced: 0,
      conflicts: 0,
      message: 'Sync is a no-op in native mode (no external sync targets configured)',
    },
  };
}

// ===== Safestop =====

/**
 * Safe stop: signal clean shutdown for agents.
 * @task T4631
 */
export async function systemSafestop(
  projectRoot: string,
  params?: {
    reason?: string;
    commit?: boolean;
    handoff?: string;
    noSessionEnd?: boolean;
    dryRun?: boolean;
  },
): Promise<EngineResult<import('@cleocode/core/internal').SafestopResult>> {
  try {
    const result = await safestop(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Sync failed');
  }
}

// ===== Uncancel =====

/**
 * Uncancel a cancelled task (restore to pending).
 * @task T4631
 */
export async function systemUncancel(
  projectRoot: string,
  params: { taskId: string; cascade?: boolean; notes?: string; dryRun?: boolean },
): Promise<EngineResult<import('@cleocode/core/internal').UncancelResult>> {
  try {
    const result = await uncancelTask(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_UNCANCEL_FAILED', 'Failed to uncancel');
  }
}

// ===== Doctor Report =====

/**
 * Run comprehensive doctor diagnostics.
 * @task T4795
 */
export async function systemDoctor(
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/core/internal').DoctorReport>> {
  const { coreDoctorReport } = await import('@cleocode/core/internal');
  try {
    const result = await coreDoctorReport(projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Doctor check failed');
  }
}

// ===== Doctor Fix =====

/**
 * Run auto-fix for failed doctor checks.
 * @task T4795
 */
export async function systemFix(
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/core/internal').FixResult[]>> {
  const { runDoctorFixes } = await import('@cleocode/core/internal');
  try {
    const result = await runDoctorFixes(projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Doctor fix failed');
  }
}

/**
 * Runtime/channel diagnostics for CLI installation mode checks.
 * @task T4815
 */
export async function systemRuntime(
  _projectRoot: string,
  params?: { detailed?: boolean },
): Promise<EngineResult<RuntimeData>> {
  try {
    const data = await getRuntimeDiagnostics({ detailed: params?.detailed ?? false });
    return { success: true, data };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_RUNTIME_ERROR', 'Runtime check failed');
  }
}

/** Summary of all resolved CleoOS paths (project + global hub). */
export interface PathsData {
  /** Project-local .cleo directory (absolute). */
  projectCleoDir: string;
  /** XDG-compliant global data root (Linux: ~/.local/share/cleo). */
  cleoHome: string;
  /** XDG config dir (Linux: ~/.config/cleo). */
  configDir: string;
  /** CleoOS Hub subdirectories under cleoHome. */
  hub: {
    globalRecipes: string;
    globalJustfile: string;
    piExtensions: string;
    cantWorkflows: string;
    globalAgents: string;
  };
  /** Scaffolding status — true if hub directories + seed files exist. */
  scaffolded: {
    globalRecipes: boolean;
    globalJustfile: boolean;
    piExtensions: boolean;
    cantWorkflows: boolean;
    globalAgents: boolean;
  };
}

/**
 * Report all resolved CleoOS paths (project + global hub).
 *
 * Backs the `cleo admin paths` CLI command. Read-only: reports current state
 * without mutating the filesystem. Use `systemScaffoldHub()` to create
 * missing hub directories and seed the starter justfile.
 *
 * @task Phase 1 — XDG Foundation + Justfile Hub Skeleton
 */
export async function systemPaths(projectRoot: string): Promise<EngineResult<PathsData>> {
  try {
    const cleoHome = getCleoHome();
    const configDir = getCleoConfigDir();
    const globalRecipes = getCleoGlobalRecipesDir();
    const globalJustfile = getCleoGlobalJustfilePath();
    const piExtensions = getCleoPiExtensionsDir();
    const cantWorkflows = getCleoCantWorkflowsDir();
    const globalAgents = getCleoGlobalAgentsDir();

    return {
      success: true,
      data: {
        projectCleoDir: join(projectRoot, '.cleo'),
        cleoHome,
        configDir,
        hub: {
          globalRecipes,
          globalJustfile,
          piExtensions,
          cantWorkflows,
          globalAgents,
        },
        scaffolded: {
          globalRecipes: existsSync(globalRecipes),
          globalJustfile: existsSync(globalJustfile),
          piExtensions: existsSync(piExtensions),
          cantWorkflows: existsSync(cantWorkflows),
          globalAgents: existsSync(globalAgents),
        },
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_PATHS_RESOLVE_FAILED', 'Failed to resolve paths');
  }
}

/** Result of scaffolding the CleoOS Hub. */
export interface ScaffoldHubData {
  action: 'created' | 'repaired' | 'skipped';
  path: string;
  details?: string;
}

/**
 * Create the CleoOS Hub directories and seed the starter justfile if absent.
 *
 * Idempotent: safe to call repeatedly. Never overwrites existing user-edited
 * justfile or README content. Backs the `cleo admin scaffold-hub` CLI
 * command and is invoked automatically by `cleo init` (Phase 5).
 *
 * @task Phase 1 — XDG Foundation + Justfile Hub Skeleton
 */
export async function systemScaffoldHub(): Promise<EngineResult<ScaffoldHubData>> {
  try {
    const result = await ensureCleoOsHub();
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_SCAFFOLD_HUB_FAILED', 'Failed to scaffold hub');
  }
}

/**
 * Repair task ID sequence using canonical core implementation.
 * @task T4815
 */
export async function systemSequenceRepair(
  projectRoot: string,
): Promise<EngineResult<Record<string, unknown>>> {
  try {
    const repair = await repairSequence(projectRoot);
    return {
      success: true,
      data: {
        repaired: repair.repaired,
        message: repair.message,
        counter: repair.counter,
        oldCounter: repair.oldCounter,
        newCounter: repair.newCounter,
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_SEQUENCE_REPAIR_FAILED', 'Failed to repair sequence');
  }
}

// ===== Smoke Test (cleo doctor --full) =====

/** Result for a single domain smoke probe. */
export interface SmokeProbe {
  domain: string;
  operation: string;
  status: 'pass' | 'fail' | 'skip';
  timeMs: number;
  error?: string;
}

/** Aggregate smoke test result. */
export interface SmokeResult {
  probes: SmokeProbe[];
  dbChecks: SmokeProbe[];
  passed: number;
  failed: number;
  skipped: number;
  totalMs: number;
}

/**
 * Smoke-test definitions: one lightweight read-only query per domain.
 * Each probe exercises the full dispatch pipeline (middleware, handler, engine, core).
 *
 * T511: includes an `adapter` probe so adapter health is covered by smoke tests,
 * consistent with its inclusion in the doctor report via `checkAdapterHealth()`.
 */
const SMOKE_PROBES: Array<{ domain: string; operation: string; params?: Record<string, unknown> }> =
  [
    { domain: 'admin', operation: 'version' },
    { domain: 'tasks', operation: 'find', params: { query: '__smoke_probe__', limit: 1 } },
    { domain: 'session', operation: 'status' },
    { domain: 'memory', operation: 'find', params: { query: '__smoke_probe__' } },
    { domain: 'pipeline', operation: 'list' },
    { domain: 'check', operation: 'schema' },
    { domain: 'tools', operation: 'list', params: { limit: 1 } },
    { domain: 'sticky', operation: 'list', params: { limit: 1 } },
    { domain: 'nexus', operation: 'status' },
    { domain: 'orchestrate', operation: 'status' },
    { domain: 'adapter', operation: 'list' },
  ];

/**
 * Run operational smoke tests across all domains.
 *
 * Dispatches one read-only query per domain through the full CLI dispatch
 * pipeline and reports pass/fail with timing. Catches crashes (TypeError,
 * ReferenceError, etc.) not just structured error responses.
 *
 * @task T130
 */
export async function systemSmoke(): Promise<EngineResult<SmokeResult>> {
  const { dispatchRaw } = await import('../adapters/cli.js');
  const totalStart = Date.now();
  const probes: SmokeProbe[] = [];

  for (const probe of SMOKE_PROBES) {
    const start = Date.now();
    try {
      const response = await dispatchRaw('query', probe.domain, probe.operation, probe.params);
      const elapsed = Date.now() - start;

      if (response.success) {
        probes.push({
          domain: probe.domain,
          operation: probe.operation,
          status: 'pass',
          timeMs: elapsed,
        });
      } else {
        // Structured error responses that are domain-specific (like "no session") are still valid
        // operational results — the dispatch pipeline worked. Only treat E_INTERNAL / E_NO_HANDLER as failures.
        const code = response.error?.code ?? '';
        const isCrash = code === 'E_INTERNAL' || code === 'E_NO_HANDLER';
        probes.push({
          domain: probe.domain,
          operation: probe.operation,
          status: isCrash ? 'fail' : 'pass',
          timeMs: elapsed,
          ...(isCrash ? { error: response.error?.message } : {}),
        });
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      probes.push({
        domain: probe.domain,
        operation: probe.operation,
        status: 'fail',
        timeMs: elapsed,
        error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err),
      });
    }
  }

  // --- DB connectivity and migration state checks ---
  const dbChecks: SmokeProbe[] = [];

  // tasks.db connectivity + integrity
  {
    const start = Date.now();
    try {
      const { getDb, getNativeDb } = await import('@cleocode/core/internal');
      const projectRoot = (await import('@cleocode/core/internal')).getProjectRoot();
      await getDb(projectRoot);
      const nativeDb = getNativeDb();
      if (nativeDb) {
        const result = nativeDb.prepare('PRAGMA integrity_check').get() as
          | Record<string, unknown>
          | undefined;
        const ok = result?.integrity_check === 'ok';
        dbChecks.push({
          domain: 'db',
          operation: 'tasks.db',
          status: ok ? 'pass' : 'fail',
          timeMs: Date.now() - start,
          ...(!ok ? { error: 'SQLite integrity check failed' } : {}),
        });
      } else {
        dbChecks.push({
          domain: 'db',
          operation: 'tasks.db',
          status: 'fail',
          timeMs: Date.now() - start,
          error: 'Native DB handle unavailable',
        });
      }
    } catch (err) {
      dbChecks.push({
        domain: 'db',
        operation: 'tasks.db',
        status: 'fail',
        timeMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // brain.db connectivity
  {
    const start = Date.now();
    try {
      const { getBrainDb } = await import('@cleocode/core/internal');
      const projectRoot = (await import('@cleocode/core/internal')).getProjectRoot();
      const brainDb = await getBrainDb(projectRoot);
      if (brainDb) {
        dbChecks.push({
          domain: 'db',
          operation: 'brain.db',
          status: 'pass',
          timeMs: Date.now() - start,
        });
      } else {
        dbChecks.push({
          domain: 'db',
          operation: 'brain.db',
          status: 'fail',
          timeMs: Date.now() - start,
          error: 'brain.db not initialized',
        });
      }
    } catch (err) {
      dbChecks.push({
        domain: 'db',
        operation: 'brain.db',
        status: 'fail',
        timeMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Migration state validation (detect stale journals)
  {
    const start = Date.now();
    try {
      const migrationStatus = await getMigrationStatus(
        (await import('@cleocode/core/internal')).getProjectRoot(),
      );
      const hasPending = migrationStatus.migrations.some((m) => !m.applied);
      dbChecks.push({
        domain: 'db',
        operation: 'migrations',
        status: hasPending ? 'fail' : 'pass',
        timeMs: Date.now() - start,
        ...(hasPending
          ? {
              error: `Unapplied migrations detected (${migrationStatus.from} → ${migrationStatus.to}). Run: cleo upgrade`,
            }
          : {}),
      });
    } catch (err) {
      dbChecks.push({
        domain: 'db',
        operation: 'migrations',
        status: 'fail',
        timeMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const allProbes = [...probes, ...dbChecks];
  const totalMs = Date.now() - totalStart;
  const passed = allProbes.filter((p) => p.status === 'pass').length;
  const failed = allProbes.filter((p) => p.status === 'fail').length;
  const skipped = allProbes.filter((p) => p.status === 'skip').length;

  return {
    success: failed === 0,
    data: { probes, dbChecks, passed, failed, skipped, totalMs },
    ...(failed > 0
      ? {
          error: {
            code: 'E_SMOKE_FAILURES',
            message: `${failed} probe(s) failed smoke test`,
            exitCode: 1,
          },
        }
      : {}),
  };
}
