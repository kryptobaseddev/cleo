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
  pending: number;
  active: number;
  blocked: number;
  done: number;
  cancelled: number;
  total: number;
  archived: number;
  grandTotal: number;
}

/** Label frequency entry. */
export interface LabelCount {
  label: string;
  count: number;
}

/** Dashboard result from system.dash query. */
export interface DashboardResult {
  project: string;
  currentPhase: string | null;
  summary: TaskSummary;
  taskWork: {
    currentTask: string | null;
    task: TaskRecord | null;
  };
  activeSession: string | null;
  highPriority: {
    count: number;
    tasks: TaskRecord[];
  };
  blockedTasks: {
    count: number;
    limit: number;
    tasks: TaskRecord[];
  };
  recentCompletions: TaskRecord[];
  topLabels: LabelCount[];
}

/** Current state counts used in stats results. */
export interface StatsCurrentState {
  pending: number;
  active: number;
  done: number;
  blocked: number;
  cancelled: number;
  totalActive: number;
  archived: number;
  grandTotal: number;
}

/** Completion metrics for a given time period. */
export interface StatsCompletionMetrics {
  periodDays: number;
  completedInPeriod: number;
  createdInPeriod: number;
  completionRate: number;
}

/** Activity metrics for a given time period. */
export interface StatsActivityMetrics {
  createdInPeriod: number;
  completedInPeriod: number;
  archivedInPeriod: number;
}

/** All-time cumulative statistics. */
export interface StatsAllTime {
  totalCreated: number;
  totalCompleted: number;
  totalCancelled: number;
  totalArchived: number;
  archivedCompleted: number;
}

/** Cycle time statistics. */
export interface StatsCycleTimes {
  averageDays: number | null;
  samples: number;
}

/** Stats result from system.stats query. */
export interface StatsResult {
  currentState: StatsCurrentState;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
  byPhase: Record<string, number>;
  completionMetrics: StatsCompletionMetrics;
  activityMetrics: StatsActivityMetrics;
  allTime: StatsAllTime;
  cycleTimes: StatsCycleTimes;
}

/** Log query result from system.log query. */
export interface LogQueryResult {
  entries: Array<{
    operation: string;
    taskId?: string;
    timestamp: string;
    [key: string]: unknown;
  }>;
  pagination: {
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
}

/** Context monitoring data from system.context query. */
export interface ContextResult {
  available: boolean;
  status: string;
  percentage: number;
  currentTokens: number;
  maxTokens: number;
  timestamp: string | null;
  stale: boolean;
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
  counter: number;
  lastId: string;
  checksum: string;
  nextId: string;
}

// ============================================================================
// Task Analysis & Dependency Result Types
// ============================================================================

/** Compact task reference used across analysis and dependency results. */
export interface TaskRef {
  id: string;
  title: string;
  status: string;
}

/** Task with leverage score for prioritization. */
export interface LeveragedTask {
  id: string;
  title: string;
  leverage: number;
  reason?: string;
}

/** Bottleneck task — blocks other tasks. */
export interface BottleneckTask {
  id: string;
  title: string;
  blocksCount: number;
}

/** Task analysis result from tasks.analyze. */
export interface TaskAnalysisResult {
  recommended: (LeveragedTask & { reason: string }) | null;
  bottlenecks: BottleneckTask[];
  tiers: {
    critical: LeveragedTask[];
    high: LeveragedTask[];
    normal: LeveragedTask[];
  };
  metrics: {
    totalTasks: number;
    actionable: number;
    blocked: number;
    avgLeverage: number;
  };
}

/** Single task dependency result from tasks.deps. */
export interface TaskDepsResult {
  taskId: string;
  dependsOn: TaskRef[];
  dependedOnBy: TaskRef[];
  unresolvedDeps: string[];
  allDepsReady: boolean;
}

/** Completion result — unblocked tasks after completing a task. */
export interface CompleteTaskUnblocked {
  unblockedTasks?: TaskRef[];
}
