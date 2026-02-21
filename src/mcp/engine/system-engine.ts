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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readLogFileEntries, getDataPath } from './store.js';
import { getAccessor } from '../../store/data-accessor.js';
import type { EngineResult, TaskRecord } from './task-engine.js';

// Core module imports
import { getDashboard, getProjectStats } from '../../core/stats/index.js';
import { getLabels } from '../../core/system/labels.js';
import { getArchiveStats } from '../../core/system/archive-stats.js';
import { generateInjection } from '../../core/system/inject-generate.js';
import { getSystemMetrics } from '../../core/system/metrics.js';
import { getSystemHealth, getSystemDiagnostics } from '../../core/system/health.js';
import { getRoadmap } from '../../core/roadmap/index.js';
import { createBackup, restoreBackup } from '../../core/system/backup.js';
import { getMigrationStatus } from '../../core/system/migrate.js';
import { cleanupSystem } from '../../core/system/cleanup.js';
import { auditData } from '../../core/system/audit.js';
import { safestop, uncancelTask } from '../../core/system/safestop.js';

// Re-export types for downstream consumers
export type { LabelsResult as LabelsData } from '../../core/system/labels.js';
export type { ArchiveStatsResult as ArchiveStatsData } from '../../core/system/archive-stats.js';
export type { HealthResult as HealthData } from '../../core/system/health.js';
export type { DiagnosticsResult as DiagnosticsData } from '../../core/system/health.js';
export type { BackupResult as BackupData } from '../../core/system/backup.js';
export type { RestoreResult as RestoreData } from '../../core/system/backup.js';
export type { CleanupResult as CleanupData } from '../../core/system/cleanup.js';
export type { AuditResult as AuditData } from '../../core/system/audit.js';
export type { SafestopResult as SafestopData } from '../../core/system/safestop.js';
export type { UncancelResult as UncancelData } from '../../core/system/safestop.js';
export type { MigrateResult as MigrateData } from '../../core/system/migrate.js';
export type { SystemMetricsResult as MetricsData } from '../../core/system/metrics.js';
export type { InjectGenerateResult as InjectGenerateData } from '../../core/system/inject-generate.js';

// ===== Dashboard Data type (re-exported for consumers) =====
export interface DashboardData {
  project: string;
  currentPhase: string | null;
  summary: {
    pending: number;
    active: number;
    blocked: number;
    done: number;
    cancelled: number;
    total: number;
  };
  focus: {
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
    tasks: TaskRecord[];
  };
  recentCompletions: TaskRecord[];
  topLabels: Array<{ label: string; count: number }>;
}

// ===== Stats Data type =====
export interface StatsData {
  currentState: {
    pending: number;
    active: number;
    done: number;
    blocked: number;
    cancelled: number;
    totalActive: number;
  };
  byPriority: Record<string, number>;
  byType: Record<string, number>;
  byPhase: Record<string, number>;
  completionMetrics: {
    periodDays: number;
    completedInPeriod: number;
    createdInPeriod: number;
    completionRate: number;
  };
  activityMetrics: {
    createdInPeriod: number;
    completedInPeriod: number;
    archivedInPeriod: number;
  };
  allTime: {
    totalCreated: number;
    totalCompleted: number;
    totalArchived: number;
  };
  cycleTimes: {
    averageDays: number | null;
    samples: number;
  };
}

// ===== Log Query Data type =====
export interface LogQueryData {
  entries: Array<{ operation: string; taskId?: string; timestamp: string; [key: string]: unknown }>;
  pagination: {
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
}

// ===== Context Data type =====
export interface ContextData {
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

// ===== Sequence Data type =====
export interface SequenceData {
  counter: number;
  lastId: string;
  checksum: string;
  nextId: string;
}

// ===== Roadmap Data type =====
export interface RoadmapData {
  currentVersion: string;
  upcoming: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    phase?: string;
    childCount: number;
    completedChildren: number;
  }>;
  releaseHistory?: Array<{ version: string; date: string }>;
  completedEpics?: number;
  summary: {
    totalUpcoming: number;
    totalTasks: number;
  };
}

// ===== Compliance Data type =====
export interface ComplianceData {
  totalEntries: number;
  averagePassRate: number;
  averageAdherence: number;
  totalViolations: number;
  trend?: string;
  dataPoints?: Array<{
    date: string;
    entries: number;
    avgPassRate: number;
    violations: number;
  }>;
}

// ===== Help Data type =====
export interface HelpData {
  topic?: string;
  content: string;
  relatedCommands?: string[];
}

// ===== Help topics (static data, stays in engine) =====
const HELP_TOPICS: Record<string, HelpData> = {
  session: {
    topic: 'session',
    content: [
      'Session Management',
      '',
      '  ct session list                        - List all sessions',
      '  ct session start --scope epic:T001     - Start session',
      '  ct session end --note "Progress"       - End session',
      '  ct session resume <id>                 - Resume session',
    ].join('\n'),
    relatedCommands: ['ct session list', 'ct session start', 'ct session end'],
  },
  tasks: {
    topic: 'tasks',
    content: [
      'Task Operations',
      '',
      '  ct add "Title" --desc "Description"    - Create task',
      '  ct update T1234 --status active        - Update task',
      '  ct complete T1234                      - Complete task',
      '  ct find "query"                        - Search tasks',
      '  ct show T1234                          - Show task details',
    ].join('\n'),
    relatedCommands: ['ct add', 'ct update', 'ct complete', 'ct find', 'ct show'],
  },
  focus: {
    topic: 'focus',
    content: [
      'Task Work Management',
      '',
      '  ct start T1234    - Start working on task',
      '  ct current        - Show current task',
      '  ct stop           - Stop working on current task',
    ].join('\n'),
    relatedCommands: ['ct start', 'ct current', 'ct stop'],
  },
  labels: {
    topic: 'labels',
    content: [
      'Label Operations',
      '',
      '  ct labels              - List all labels',
      '  ct labels show <name>  - Show tasks with label',
    ].join('\n'),
    relatedCommands: ['ct labels'],
  },
  compliance: {
    topic: 'compliance',
    content: [
      'Compliance Monitoring',
      '',
      '  ct compliance summary     - Compliance overview',
      '  ct compliance violations  - List violations',
      '  ct compliance trend       - Compliance trend',
    ].join('\n'),
    relatedCommands: ['ct compliance summary', 'ct compliance violations'],
  },
};

// ===== Dashboard =====

/**
 * Project dashboard: task counts by status, active session info,
 * current focus, recent completions.
 */
export async function systemDash(
  projectRoot: string,
): Promise<EngineResult<DashboardData>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await getDashboard({ cwd: projectRoot }, accessor);
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
          cancelled: (summary as Record<string, number>).cancelled ?? 0,
          total: summary.total,
        },
        focus: data.focus as DashboardData['focus'],
        activeSession: (data as Record<string, unknown>).activeSession as string | null ?? null,
        highPriority: data.highPriority as DashboardData['highPriority'],
        blockedTasks: data.blockedTasks as DashboardData['blockedTasks'],
        recentCompletions: (data.recentCompletions ?? []) as TaskRecord[],
        topLabels: data.topLabels as DashboardData['topLabels'],
      },
    };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: (err as Error).message } };
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
    const result = await getProjectStats({ period: String(params?.period ?? 30), cwd: projectRoot }, accessor);
    // Core stats lacks byPriority, byType, byPhase, cycleTimes — fill from accessor
    const todoData = await accessor.loadTodoFile();
    const tasks = (todoData as { tasks: TaskRecord[] })?.tasks ?? [];

    const byPriority: Record<string, number> = {};
    for (const t of tasks) {
      byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
    }
    const byType: Record<string, number> = {};
    for (const t of tasks) {
      const type = t.type || 'task';
      byType[type] = (byType[type] ?? 0) + 1;
    }
    const byPhase: Record<string, number> = {};
    for (const t of tasks) {
      const phase = t.phase || 'unassigned';
      byPhase[phase] = (byPhase[phase] ?? 0) + 1;
    }

    // Cycle times
    const completedTasks = tasks.filter(t => t.status === 'done' && t.completedAt && t.createdAt);
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
          cancelled: tasks.filter(t => t.status === 'cancelled').length,
          totalActive: currentState.totalActive,
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
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: (err as Error).message } };
  }
}

// ===== Labels =====

/**
 * List all unique labels across tasks with counts and task IDs per label.
 */
export async function systemLabels(
  projectRoot: string,
): Promise<EngineResult<import('../../core/system/labels.js').LabelsResult>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await getLabels(projectRoot, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: (err as Error).message } };
  }
}

// ===== Archive Stats =====

/**
 * Archive metrics: total archived, by reason, average cycle time, archive rate.
 */
export async function systemArchiveStats(
  projectRoot: string,
  params?: { period?: number },
): Promise<EngineResult<import('../../core/system/archive-stats.js').ArchiveStatsResult>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await getArchiveStats({ period: params?.period, cwd: projectRoot }, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: (err as Error).message } };
  }
}

// ===== Log =====

/**
 * Query todo-log.jsonl with optional filters.
 */
export function systemLog(
  projectRoot: string,
  filters?: {
    operation?: string;
    taskId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  },
): EngineResult<LogQueryData> {
  try {
    const logPath = getDataPath(projectRoot, 'todo-log.jsonl');
    const raw = readLogFileEntries(logPath) as Array<{ operation: string; timestamp: string; taskId?: string; [key: string]: unknown }>;
    let entries = raw;

    if (filters?.operation) {
      entries = entries.filter(e => e.operation === filters.operation);
    }
    if (filters?.taskId) {
      entries = entries.filter(e => e.taskId === filters.taskId);
    }
    if (filters?.since) {
      entries = entries.filter(e => e.timestamp >= filters.since!);
    }
    if (filters?.until) {
      entries = entries.filter(e => e.timestamp <= filters.until!);
    }

    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const total = entries.length;
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? 20;
    const paginated = entries.slice(offset, offset + limit);

    return {
      success: true,
      data: {
        entries: paginated,
        pagination: { total, offset, limit, hasMore: offset + limit < total },
      },
    };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_LOG_ERROR', message: (err as Error).message } };
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
          const sessionFile = join(cleoDir, 'context-states', `context-state-${currentSession}.json`);
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
      if ((Date.now() - fileTime) > staleMs) {
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
    return { success: false, error: { code: 'E_CONTEXT_ERROR', message: (err as Error).message } };
  }
}

// ===== Sequence =====

/**
 * Read the .sequence.json file and return current sequence state.
 */
export function systemSequence(
  projectRoot: string,
): EngineResult<SequenceData> {
  try {
    const seqPath = join(projectRoot, '.cleo', '.sequence.json');

    if (!existsSync(seqPath)) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: 'Sequence file not found (.cleo/.sequence.json)' },
      };
    }

    const seq = JSON.parse(readFileSync(seqPath, 'utf-8'));
    return {
      success: true,
      data: {
        counter: seq.counter,
        lastId: seq.lastId,
        checksum: seq.checksum,
        nextId: `T${seq.counter + 1}`,
      },
    };
  } catch {
    return {
      success: false,
      error: { code: 'E_PARSE_ERROR', message: 'Failed to parse sequence file' },
    };
  }
}

// ===== Inject Generate (MVI) =====

/**
 * Generate Minimum Viable Injection (MVI).
 */
export async function systemInjectGenerate(
  projectRoot?: string,
): Promise<EngineResult<import('../../core/system/inject-generate.js').InjectGenerateResult>> {
  try {
    const root = projectRoot || process.cwd();
    const result = await generateInjection(root);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_INJECT_FAILED', message: (err as Error).message } };
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
): Promise<EngineResult<import('../../core/system/metrics.js').SystemMetricsResult>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await getSystemMetrics(projectRoot, params, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_METRICS_FAILED', message: (err as Error).message } };
  }
}

// ===== Health =====

/**
 * System health check: verify core data files exist and are valid.
 * @task T4631
 */
export function systemHealth(
  projectRoot: string,
  params?: { detailed?: boolean },
): EngineResult<import('../../core/system/health.js').HealthResult> {
  try {
    const result = getSystemHealth(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_HEALTH_FAILED', message: (err as Error).message } };
  }
}

// ===== Diagnostics =====

/**
 * System diagnostics: extended health checks with fix suggestions.
 * @task T4631
 */
export function systemDiagnostics(
  projectRoot: string,
  params?: { checks?: string[] },
): EngineResult<import('../../core/system/health.js').DiagnosticsResult> {
  try {
    const result = getSystemDiagnostics(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_DIAGNOSTICS_FAILED', message: (err as Error).message } };
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
    return {
      success: false,
      error: {
        code: 'E_NOT_FOUND',
        message: `Unknown help topic: ${topic}. Available topics: ${Object.keys(HELP_TOPICS).join(', ')}`,
      },
    };
  }

  return {
    success: true,
    data: {
      content: [
        'CLEO Task Management System',
        '',
        'Essential Commands:',
        '  ct find "query"    - Fuzzy search tasks',
        '  ct show T1234      - Full task details',
        '  ct add "Task"      - Create task',
        '  ct done <id>       - Complete task',
        '  ct start <id>      - Start working on task',
        '  ct dash            - Project overview',
        '  ct session list    - List sessions',
        '',
        'Help Topics: session, tasks, focus, labels, compliance',
      ].join('\n'),
      relatedCommands: ['ct find', 'ct show', 'ct add', 'ct done', 'ct dash'],
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
): Promise<EngineResult<RoadmapData>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await getRoadmap(
      { includeHistory: params?.includeHistory, upcomingOnly: params?.upcomingOnly, cwd: projectRoot },
      accessor,
    );
    return { success: true, data: result as unknown as RoadmapData };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: (err as Error).message } };
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
          entries = content.split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
        }
      }

      if (params.epic) {
        entries = entries.filter(e => {
          const ctx = (e._context ?? {}) as Record<string, unknown>;
          return ctx.epic_id === params.epic || ctx.task_id === params.epic;
        });
      }
      if (params.days) {
        const cutoff = new Date(Date.now() - params.days * 86400000).toISOString();
        entries = entries.filter(e => (e.timestamp as string) >= cutoff);
      }

      const totalEntries = entries.length;
      const compliance = entries.map(e => (e.compliance ?? {}) as Record<string, unknown>);
      const avgPassRate = totalEntries > 0
        ? Math.round(compliance.reduce((sum, c) => sum + ((c.compliance_pass_rate as number) ?? 0), 0) / totalEntries * 1000) / 1000
        : 0;
      const avgAdherence = totalEntries > 0
        ? Math.round(compliance.reduce((sum, c) => sum + ((c.rule_adherence_score as number) ?? 0), 0) / totalEntries * 1000) / 1000
        : 0;
      const totalViolations = compliance.reduce(
        (sum, c) => sum + ((c.violation_count as number) ?? 0), 0,
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
          const dayCompliance = dayEntries.map(de => (de.compliance ?? {}) as Record<string, unknown>);
          return {
            date,
            entries: dayEntries.length,
            avgPassRate: dayCompliance.reduce((s, c) => s + ((c.compliance_pass_rate as number) ?? 0), 0) / dayEntries.length,
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
        data: { totalEntries, averagePassRate: avgPassRate, averageAdherence: avgAdherence, totalViolations, trend, dataPoints },
      };
    }

    // Default: summary (possibly filtered by epic/days)
    const compliancePath = join(projectRoot, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
    let entries: Record<string, unknown>[] = [];

    if (existsSync(compliancePath)) {
      const content = readFileSync(compliancePath, 'utf-8').trim();
      if (content) {
        entries = content.split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
      }
    }

    if (params?.epic) {
      entries = entries.filter(e => {
        const ctx = (e._context ?? {}) as Record<string, unknown>;
        return ctx.epic_id === params.epic || ctx.task_id === params.epic;
      });
    }
    if (params?.days) {
      const cutoff = new Date(Date.now() - params.days * 86400000).toISOString();
      entries = entries.filter(e => (e.timestamp as string) >= cutoff);
    }

    const totalEntries = entries.length;
    const compliance = entries.map(e => (e.compliance ?? {}) as Record<string, unknown>);
    const avgPassRate = totalEntries > 0
      ? Math.round(compliance.reduce((sum, c) => sum + ((c.compliance_pass_rate as number) ?? 0), 0) / totalEntries * 1000) / 1000
      : 0;
    const avgAdherence = totalEntries > 0
      ? Math.round(compliance.reduce((sum, c) => sum + ((c.rule_adherence_score as number) ?? 0), 0) / totalEntries * 1000) / 1000
      : 0;
    const totalViolations = compliance.reduce(
      (sum, c) => sum + ((c.violation_count as number) ?? 0), 0,
    );

    return {
      success: true,
      data: { totalEntries, averagePassRate: avgPassRate, averageAdherence: avgAdherence, totalViolations },
    };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_COMPLIANCE_FAILED', message: (err as Error).message } };
  }
}

// ===== Backup =====

/**
 * Create a backup of CLEO data files.
 * @task T4631
 */
export function systemBackup(
  projectRoot: string,
  params?: { type?: string; note?: string },
): EngineResult<import('../../core/system/backup.js').BackupResult> {
  try {
    const result = createBackup(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_BACKUP_FAILED', message: (err as Error).message } };
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
): EngineResult<import('../../core/system/backup.js').RestoreResult> {
  try {
    const result = restoreBackup(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_RESTORE_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

// ===== Migrate =====

/**
 * Check/run schema migrations.
 * @task T4631
 */
export function systemMigrate(
  projectRoot: string,
  params?: { target?: string; dryRun?: boolean },
): EngineResult<import('../../core/system/migrate.js').MigrateResult> {
  try {
    const result = getMigrationStatus(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_MIGRATE_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

// ===== Cleanup =====

/**
 * Cleanup stale data (sessions, backups, logs).
 * @task T4631
 */
export function systemCleanup(
  projectRoot: string,
  params: { target: string; olderThan?: string; dryRun?: boolean },
): EngineResult<import('../../core/system/cleanup.js').CleanupResult> {
  try {
    const result = cleanupSystem(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_CLEANUP_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

// ===== Audit =====

/**
 * Audit data integrity.
 * @task T4631
 */
export function systemAudit(
  projectRoot: string,
  params?: { scope?: string; fix?: boolean },
): EngineResult<import('../../core/system/audit.js').AuditResult> {
  try {
    const result = auditData(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_AUDIT_FAILED', message: (err as Error).message } };
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
export function systemSafestop(
  projectRoot: string,
  params?: { reason?: string; commit?: boolean; handoff?: string; noSessionEnd?: boolean; dryRun?: boolean },
): EngineResult<import('../../core/system/safestop.js').SafestopResult> {
  try {
    const result = safestop(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_SAFESTOP_FAILED', message: (err as Error).message } };
  }
}

// ===== Uncancel =====

/**
 * Uncancel a cancelled task (restore to pending).
 * @task T4631
 */
export function systemUncancel(
  projectRoot: string,
  params: { taskId: string; cascade?: boolean; notes?: string; dryRun?: boolean },
): EngineResult<import('../../core/system/safestop.js').UncancelResult> {
  try {
    const result = uncancelTask(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_UNCANCEL_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}
