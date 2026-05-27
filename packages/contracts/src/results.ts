/**
 * Result types for system engine queries: dashboard, stats, log, context, sequence.
 *
 * These replace ad-hoc Record<string, unknown> patterns in system-engine.ts.
 *
 * @task T4631
 * @task T4783
 */

import type { TaskRecord } from './task-record.js';

/** Task summary counts used in dashboard and stats views. */
export interface TaskSummary {
  /** Number of tasks in `pending` status. */
  pending: number;
  /** Number of tasks in `active` status. */
  active: number;
  /** Number of tasks in `blocked` status. */
  blocked: number;
  /** Number of tasks in `done` status. */
  done: number;
  /** Number of tasks in `cancelled` status. */
  cancelled: number;
  /** Total non-archived tasks (pending + active + blocked + done + cancelled). */
  total: number;
  /** Number of archived tasks. */
  archived: number;
  /** Grand total including archived tasks. */
  grandTotal: number;
}

/** Label frequency entry. */
export interface LabelCount {
  /** Label string value. */
  label: string;
  /** Number of tasks tagged with this label. */
  count: number;
}

/** Dashboard result from system.dash query. */
export interface DashboardResult {
  /** Project name. */
  project: string;
  /** Currently active phase slug, or `null` if no phase is active. */
  currentPhase: string | null;
  /** Aggregate task status counts. */
  summary: TaskSummary;
  /** Current task work focus state. */
  taskWork: {
    currentTask: string | null;
    task: TaskRecord | null;
  };
  /** Currently active session ID, or `null`. */
  activeSession: string | null;
  /** High-priority tasks requiring attention. */
  highPriority: {
    count: number;
    tasks: TaskRecord[];
  };
  /** Blocked tasks that need unblocking. */
  blockedTasks: {
    count: number;
    limit: number;
    tasks: TaskRecord[];
  };
  /** Recently completed tasks. */
  recentCompletions: TaskRecord[];
  /** Most frequently used labels with counts. */
  topLabels: LabelCount[];
}

/** Current state counts used in stats results. */
export interface StatsCurrentState {
  /** Number of tasks in `pending` status. */
  pending: number;
  /** Number of tasks in `active` status. */
  active: number;
  /** Number of tasks in `done` status. */
  done: number;
  /** Number of tasks in `blocked` status. */
  blocked: number;
  /** Number of tasks in `cancelled` status. */
  cancelled: number;
  /** Total active (non-done, non-cancelled) tasks. */
  totalActive: number;
  /** Number of archived tasks. */
  archived: number;
  /** Grand total including archived tasks. */
  grandTotal: number;
}

/** Completion metrics for a given time period. */
export interface StatsCompletionMetrics {
  /** Number of days in the measurement period. */
  periodDays: number;
  /** Tasks completed within the period. */
  completedInPeriod: number;
  /** Tasks created within the period. */
  createdInPeriod: number;
  /** Completion rate as a ratio (0.0 to 1.0). */
  completionRate: number;
}

/** Activity metrics for a given time period. */
export interface StatsActivityMetrics {
  /** Tasks created within the period. */
  createdInPeriod: number;
  /** Tasks completed within the period. */
  completedInPeriod: number;
  /** Tasks archived within the period. */
  archivedInPeriod: number;
}

/** All-time cumulative statistics. */
export interface StatsAllTime {
  /** Total tasks ever created. */
  totalCreated: number;
  /** Total tasks ever completed. */
  totalCompleted: number;
  /** Total tasks ever cancelled. */
  totalCancelled: number;
  /** Total tasks ever archived. */
  totalArchived: number;
  /** Archived tasks that were in `done` status when archived. */
  archivedCompleted: number;
}

/** Cycle time statistics. */
export interface StatsCycleTimes {
  /** Average days from creation to completion, or `null` if no samples. */
  averageDays: number | null;
  /** Number of completed tasks used to compute the average. */
  samples: number;
}

/** Stats result from system.stats query. */
export interface StatsResult {
  /** Current task status distribution. */
  currentState: StatsCurrentState;
  /** Task count grouped by priority level. */
  byPriority: Record<string, number>;
  /** Task count grouped by task type. */
  byType: Record<string, number>;
  /** Task count grouped by phase slug. */
  byPhase: Record<string, number>;
  /** Completion throughput for the measurement period. */
  completionMetrics: StatsCompletionMetrics;
  /** Creation/completion/archive activity for the period. */
  activityMetrics: StatsActivityMetrics;
  /** Cumulative all-time statistics. */
  allTime: StatsAllTime;
  /** Average time from task creation to completion. */
  cycleTimes: StatsCycleTimes;
}

/** Log query result from system.log query. */
export interface LogQueryResult {
  /** Audit log entries matching the query. */
  entries: Array<{
    operation: string;
    taskId?: string;
    timestamp: string;
    [key: string]: unknown;
  }>;
  /** Pagination metadata for the query result. */
  pagination: {
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
}

/** Context monitoring data from system.context query. */
export interface ContextResult {
  /** Whether context monitoring is available for the current provider. */
  available: boolean;
  /** Human-readable context usage status (e.g. `"healthy"`, `"warning"`). */
  status: string;
  /** Context usage as a percentage (0-100). */
  percentage: number;
  /** Estimated current token count. */
  currentTokens: number;
  /** Maximum token capacity for the provider. */
  maxTokens: number;
  /** ISO 8601 timestamp of the last context measurement. */
  timestamp: string | null;
  /** Whether the context data is stale (older than threshold). */
  stale: boolean;
  /** Per-session context usage breakdown. */
  sessions: Array<{
    file: string;
    sessionId: string | null;
    percentage: number;
    status: string;
    timestamp: string;
  }>;
}

/** Sequence counter data from system.sequence query. */
export interface SequenceResult {
  /** Current sequence counter value. */
  counter: number;
  /** Last task ID generated. */
  lastId: string;
  /** Integrity checksum of the sequence state. */
  checksum: string;
  /** Next task ID that will be generated. */
  nextId: string;
}

// ============================================================================
// Task Analysis & Dependency Result Types
// ============================================================================

/** Compact task reference used across analysis and dependency results. */
export interface TaskRef {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** Current task status string. */
  status: string;
}

/** Task reference with optional priority (used in orchestrator/HITL contexts). */
export type TaskRefPriority = Pick<TaskRef, 'id' | 'title'> & { priority?: string };

/** Task with leverage score for prioritization. */
export interface LeveragedTask {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** Leverage score (higher = more impactful to work on). */
  leverage: number;
  /**
   * Explanation of why this task has high leverage.
   * @defaultValue undefined
   */
  reason?: string;
}

/** Bottleneck task — blocks other tasks. */
export interface BottleneckTask {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** Number of other tasks blocked by this task. */
  blocksCount: number;
}

/** Task analysis result from tasks.analyze. */
export interface TaskAnalysisResult {
  /** Top recommended task to work on next, or `null` if none available. */
  recommended: (LeveragedTask & { reason: string }) | null;
  /** Tasks that block the most other tasks. */
  bottlenecks: BottleneckTask[];
  /** Tasks grouped by priority tier. */
  tiers: {
    critical: LeveragedTask[];
    high: LeveragedTask[];
    normal: LeveragedTask[];
  };
  /** Aggregate analysis metrics. */
  metrics: {
    totalTasks: number;
    actionable: number;
    blocked: number;
    avgLeverage: number;
  };
}

/** Single task dependency result from tasks.deps. */
export interface TaskDepsResult {
  /** ID of the task whose dependencies were analyzed. */
  taskId: string;
  /** Tasks that this task depends on. */
  dependsOn: TaskRef[];
  /** Tasks that depend on this task. */
  dependedOnBy: TaskRef[];
  /** Dependency IDs that reference non-existent tasks. */
  unresolvedDeps: string[];
  /** Whether all dependencies are in a terminal status. */
  allDepsReady: boolean;
}

/** Completion result — unblocked tasks after completing a task. */
export interface CompleteTaskUnblocked {
  /**
   * Tasks that became unblocked as a result of the completion.
   * @defaultValue undefined
   */
  unblockedTasks?: TaskRef[];
}
