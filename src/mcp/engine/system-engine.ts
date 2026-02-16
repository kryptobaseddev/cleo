/**
 * System Engine
 *
 * Native TypeScript implementation of system-level operations.
 * Provides dashboard, statistics, labels, archive metrics, log queries,
 * context monitoring, sequence state, and MVI injection generation.
 *
 * Read-only queries: dash, stats, labels, archive-stats, log, context, sequence,
 *   metrics, health, diagnostics, help, roadmap, compliance
 * Mutate operations: inject.generate, backup, restore, migrate, cleanup, audit,
 *   sync, safestop, uncancel
 *
 * @task T4631
 */

import { readJsonFile, readLogFileEntries, getDataPath } from './store.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import type { EngineResult, TaskRecord } from './task-engine.js';

/**
 * The full todo.json structure (read-only subset)
 */
interface TodoFile {
  version?: string;
  project?: {
    name: string;
    currentPhase?: string | null;
    phases?: Record<string, unknown>;
    phaseHistory?: unknown[];
    releases?: unknown[];
  };
  lastUpdated?: string;
  focus?: {
    currentTask?: string | null;
    currentPhase?: string | null;
    blockedUntil?: string | null;
    sessionNote?: string | null;
    sessionNotes?: unknown[];
    nextAction?: string | null;
    primarySession?: string | null;
  };
  _meta?: {
    schemaVersion: string;
    specVersion?: string;
    checksum?: string;
    configVersion?: string;
    lastSessionId?: string | null;
    activeSession?: string | null;
    multiSessionEnabled?: boolean;
    activeSessionCount?: number;
    sessionsFile?: string | null;
    generation?: number;
  };
  tasks: TaskRecord[];
  labels?: Record<string, string[]>;
}

/**
 * Archive file structure
 */
interface ArchiveFile {
  _meta?: {
    schemaVersion: string;
    totalArchived: number;
    lastArchived: string | null;
  };
  archivedTasks: Array<TaskRecord & {
    _archive?: {
      archivedAt?: string;
      reason?: string;
    };
  }>;
}

/**
 * Individual log entry
 */
interface LogEntry {
  operation: string;
  taskId?: string;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Sequence file structure
 */
interface SequenceState {
  counter: number;
  lastId: string;
  checksum: string;
}

/**
 * Sessions file structure (for active session info)
 */
interface SessionsFile {
  sessions: Array<{
    id: string;
    status: string;
    name?: string;
    scope: { type: string; rootTaskId: string };
    focus: { currentTask?: string | null };
    startedAt: string;
    lastActivity: string;
    stats?: Record<string, number>;
  }>;
}

// ===== Helper =====

function loadTodoFile(projectRoot: string): TodoFile | null {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  return readJsonFile<TodoFile>(todoPath);
}

function loadArchiveFile(projectRoot: string): ArchiveFile | null {
  const archivePath = getDataPath(projectRoot, 'todo-archive.json');
  return readJsonFile<ArchiveFile>(archivePath);
}

// loadLogFile removed in T4622 - replaced by readLogFileEntries for hybrid format support

// ===== Dashboard =====

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

/**
 * Project dashboard: task counts by status, active session info,
 * current focus, recent completions.
 */
export function systemDash(
  projectRoot: string
): EngineResult<DashboardData> {
  const todo = loadTodoFile(projectRoot);
  if (!todo) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const tasks = todo.tasks || [];

  const pending = tasks.filter(t => t.status === 'pending').length;
  const active = tasks.filter(t => t.status === 'active').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const cancelled = tasks.filter(t => t.status === 'cancelled').length;
  const total = tasks.length;

  const project = todo.project?.name ?? 'Unknown Project';
  const currentPhase = todo.project?.currentPhase ?? null;

  // Focus
  const focusId = todo.focus?.currentTask ?? null;
  let focusTask: TaskRecord | null = null;
  if (focusId) {
    focusTask = tasks.find(t => t.id === focusId) ?? null;
  }

  // Active session
  const activeSession = todo._meta?.activeSession ?? null;

  // High priority open tasks
  const highPriority = tasks.filter(
    t => (t.priority === 'critical' || t.priority === 'high') && t.status !== 'done' && t.status !== 'cancelled'
  );

  // Blocked tasks
  const blockedTasks = tasks.filter(t => t.status === 'blocked');

  // Recent completions (last 5 completed tasks by completedAt)
  const recentCompletions = tasks
    .filter(t => t.status === 'done' && t.completedAt)
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
    .slice(0, 5);

  // Label aggregation
  const labelMap: Record<string, number> = {};
  for (const t of tasks) {
    for (const label of t.labels ?? []) {
      labelMap[label] = (labelMap[label] ?? 0) + 1;
    }
  }
  const topLabels = Object.entries(labelMap)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    success: true,
    data: {
      project,
      currentPhase,
      summary: { pending, active, blocked, done, cancelled, total },
      focus: { currentTask: focusId, task: focusTask },
      activeSession,
      highPriority: { count: highPriority.length, tasks: highPriority.slice(0, 5) },
      blockedTasks: { count: blockedTasks.length, tasks: blockedTasks },
      recentCompletions,
      topLabels,
    },
  };
}

// ===== Stats =====

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

/**
 * Detailed statistics: tasks by status/priority/type/phase,
 * completion rate, average cycle time.
 */
export function systemStats(
  projectRoot: string,
  params?: { period?: number }
): EngineResult<StatsData> {
  const todo = loadTodoFile(projectRoot);
  if (!todo) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const tasks = todo.tasks || [];
  const periodDays = params?.period ?? 30;
  const cutoff = new Date(Date.now() - periodDays * 86400000).toISOString();

  // Status counts
  const pending = tasks.filter(t => t.status === 'pending').length;
  const active = tasks.filter(t => t.status === 'active').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const cancelled = tasks.filter(t => t.status === 'cancelled').length;

  // By priority
  const byPriority: Record<string, number> = {};
  for (const t of tasks) {
    byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
  }

  // By type
  const byType: Record<string, number> = {};
  for (const t of tasks) {
    const type = t.type || 'task';
    byType[type] = (byType[type] ?? 0) + 1;
  }

  // By phase
  const byPhase: Record<string, number> = {};
  for (const t of tasks) {
    const phase = t.phase || 'unassigned';
    byPhase[phase] = (byPhase[phase] ?? 0) + 1;
  }

  // Log-based metrics (handles hybrid JSON/JSONL format)
  const logPath = getDataPath(projectRoot, 'todo-log.jsonl');
  const logEntries = readLogFileEntries(logPath) as Array<{ action?: string; operation?: string; timestamp: string; taskId?: string; after?: Record<string, unknown>; [key: string]: unknown }>;

  // Match both legacy action names and any future operation field
  const isCreate = (e: typeof logEntries[number]) => e.action === 'task_created' || e.operation === 'create';
  const isComplete = (e: typeof logEntries[number]) =>
    e.action === 'task_completed' || e.operation === 'complete' ||
    (e.action === 'status_changed' && e.after?.status === 'done');
  const isArchive = (e: typeof logEntries[number]) => e.action === 'task_archived' || e.operation === 'archive';

  const createdInPeriod = logEntries.filter(
    e => isCreate(e) && e.timestamp >= cutoff
  ).length;
  const completedInPeriod = logEntries.filter(
    e => isComplete(e) && e.timestamp >= cutoff
  ).length;
  const archivedInPeriod = logEntries.filter(
    e => isArchive(e) && e.timestamp >= cutoff
  ).length;

  const completionRate = createdInPeriod > 0
    ? Math.round((completedInPeriod / createdInPeriod) * 10000) / 100
    : 0;

  const totalCreated = logEntries.filter(isCreate).length;
  const totalCompleted = logEntries.filter(isComplete).length;
  const totalArchived = logEntries.filter(isArchive).length;

  // Average cycle time for completed tasks
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
  const averageDays = samples > 0
    ? Math.round((totalCycleDays / samples) * 100) / 100
    : null;

  return {
    success: true,
    data: {
      currentState: { pending, active, done, blocked, cancelled, totalActive: tasks.length },
      byPriority,
      byType,
      byPhase,
      completionMetrics: { periodDays, completedInPeriod, createdInPeriod, completionRate },
      activityMetrics: { createdInPeriod, completedInPeriod, archivedInPeriod },
      allTime: { totalCreated, totalCompleted, totalArchived },
      cycleTimes: { averageDays, samples },
    },
  };
}

// ===== Labels =====

export interface LabelsData {
  labels: Array<{ label: string; count: number; tasks: string[] }>;
  totalLabels: number;
  totalTagged: number;
  totalUntagged: number;
}

/**
 * List all unique labels across tasks with counts and task IDs per label.
 */
export function systemLabels(
  projectRoot: string
): EngineResult<LabelsData> {
  const todo = loadTodoFile(projectRoot);
  if (!todo) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const tasks = todo.tasks || [];
  const labelMap: Record<string, string[]> = {};
  let taggedCount = 0;

  for (const t of tasks) {
    const taskLabels = t.labels ?? [];
    if (taskLabels.length > 0) taggedCount++;
    for (const label of taskLabels) {
      if (!labelMap[label]) labelMap[label] = [];
      labelMap[label].push(t.id);
    }
  }

  const labels = Object.entries(labelMap)
    .map(([label, taskIds]) => ({ label, count: taskIds.length, tasks: taskIds }))
    .sort((a, b) => b.count - a.count);

  return {
    success: true,
    data: {
      labels,
      totalLabels: labels.length,
      totalTagged: taggedCount,
      totalUntagged: tasks.length - taggedCount,
    },
  };
}

// ===== Archive Stats =====

export interface ArchiveStatsData {
  totalArchived: number;
  byReason: Record<string, number>;
  averageCycleTimeDays: number | null;
  archiveRate: {
    periodDays: number;
    archivedInPeriod: number;
  };
  lastArchived: string | null;
}

/**
 * Archive metrics: total archived, by reason, average cycle time, archive rate.
 */
export function systemArchiveStats(
  projectRoot: string,
  params?: { period?: number }
): EngineResult<ArchiveStatsData> {
  const archive = loadArchiveFile(projectRoot);
  const periodDays = params?.period ?? 30;
  const cutoff = new Date(Date.now() - periodDays * 86400000).toISOString();

  if (!archive || !archive.archivedTasks) {
    return {
      success: true,
      data: {
        totalArchived: 0,
        byReason: {},
        averageCycleTimeDays: null,
        archiveRate: { periodDays, archivedInPeriod: 0 },
        lastArchived: null,
      },
    };
  }

  const archived = archive.archivedTasks;

  // By reason
  const byReason: Record<string, number> = {};
  for (const t of archived) {
    const reason = t._archive?.reason || 'unknown';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }

  // Average cycle time
  let totalCycleDays = 0;
  let samples = 0;
  for (const t of archived) {
    if (t.createdAt && t.completedAt) {
      const created = new Date(t.createdAt).getTime();
      const completed = new Date(t.completedAt).getTime();
      if (completed > created) {
        totalCycleDays += (completed - created) / 86400000;
        samples++;
      }
    }
  }
  const averageCycleTimeDays = samples > 0
    ? Math.round((totalCycleDays / samples) * 100) / 100
    : null;

  // Archive rate (tasks archived in period)
  const archivedInPeriod = archived.filter(t => {
    const archivedAt = t._archive?.archivedAt;
    return archivedAt && archivedAt >= cutoff;
  }).length;

  const lastArchived = archive._meta?.lastArchived ?? null;

  return {
    success: true,
    data: {
      totalArchived: archived.length,
      byReason,
      averageCycleTimeDays,
      archiveRate: { periodDays, archivedInPeriod },
      lastArchived,
    },
  };
}

// ===== Log =====

export interface LogQueryData {
  entries: LogEntry[];
  pagination: {
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
}

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
  }
): EngineResult<LogQueryData> {
  const logPath = getDataPath(projectRoot, 'todo-log.jsonl');
  const raw = readLogFileEntries(logPath) as Array<{ operation: string; timestamp: string; taskId?: string; [key: string]: unknown }>;
  let entries = raw;

  // Apply filters
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

  // Sort by timestamp descending
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
}

// ===== Context =====

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

/**
 * Context window tracking: estimate token usage from current session/state.
 */
export function systemContext(
  projectRoot: string,
  params?: { session?: string }
): EngineResult<ContextData> {
  const cleoDir = join(projectRoot, '.cleo');

  // Resolve state file
  let stateFile: string;

  if (params?.session) {
    const sessionFile = join(cleoDir, 'context-states', `context-state-${params.session}.json`);
    stateFile = existsSync(sessionFile) ? sessionFile : join(cleoDir, '.context-state.json');
  } else {
    // Check for current session binding
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

  // Collect all context session files
  const sessions: ContextData['sessions'] = [];
  const statesDir = join(cleoDir, 'context-states');
  if (existsSync(statesDir)) {
    for (const file of readdirSync(statesDir)) {
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

  // Check singleton fallback
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

  // Read primary state file
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
}

// ===== Sequence =====

export interface SequenceData {
  counter: number;
  lastId: string;
  checksum: string;
  nextId: string;
}

/**
 * Read the .sequence.json file and return current sequence state.
 */
export function systemSequence(
  projectRoot: string
): EngineResult<SequenceData> {
  const seqPath = getDataPath(projectRoot, '.sequence.json');

  if (!existsSync(seqPath)) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: 'Sequence file not found (.cleo/.sequence.json)' },
    };
  }

  try {
    const seq = JSON.parse(readFileSync(seqPath, 'utf-8')) as SequenceState;

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

export interface InjectGenerateData {
  injection: string;
  sizeBytes: number;
  version: string;
}

/**
 * Generate Minimum Viable Injection (MVI) — a compact, dynamic markdown
 * string for inclusion in CLAUDE.md. Replaces the static 34KB injection
 * with a <5KB dynamically-generated payload containing essential commands,
 * session protocol, bootstrap instruction, error handling, storage mode,
 * and current project state.
 */
export function systemInjectGenerate(
  projectRoot?: string
): EngineResult<InjectGenerateData> {
  const root = projectRoot || process.cwd();

  // --- Read project state ---
  let version = 'unknown';
  try {
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version || 'unknown';
    }
  } catch {
    // fallback
  }

  // Active session & focus
  let activeSessionName: string | null = null;
  let focusTask: string | null = null;
  let sessionScope: string | null = null;

  const todo = loadTodoFile(root);
  if (todo) {
    focusTask = todo.focus?.currentTask ?? null;
    activeSessionName = todo._meta?.activeSession ?? null;
  }

  // Try sessions.json for richer session data
  try {
    const sessionsPath = getDataPath(root, 'sessions.json');
    if (existsSync(sessionsPath)) {
      const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as SessionsFile;
      const active = sessionsData.sessions?.find(s => s.status === 'active');
      if (active) {
        activeSessionName = active.name || active.id;
        focusTask = active.focus?.currentTask ?? focusTask;
        sessionScope = `${active.scope?.type}:${active.scope?.rootTaskId}`;
      }
    }
  } catch {
    // fallback to todo.json data
  }

  // Storage engine from config
  let storageEngine = 'json';
  try {
    const configPath = getDataPath(root, 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      storageEngine = config.storage?.engine || 'json';
    }
  } catch {
    // default
  }

  // --- Build MVI markdown ---
  const mvi = buildMviMarkdown({
    version,
    storageEngine,
    activeSessionName,
    focusTask,
    sessionScope,
  });

  const sizeBytes = Buffer.byteLength(mvi, 'utf-8');

  return {
    success: true,
    data: {
      injection: mvi,
      sizeBytes,
      version: '1.0.0',
    },
  };
}

// ===== Metrics =====

export interface MetricsData {
  tokens: {
    input: number;
    output: number;
    cache: number;
    total: number;
  };
  compliance: {
    total: number;
    passed: number;
    failed: number;
    score: number;
  };
  sessions: {
    total: number;
    active: number;
    completed: number;
  };
}

/**
 * System metrics: token usage, compliance summary, session counts.
 * @task T4631
 */
export function systemMetrics(
  projectRoot: string,
  params?: { scope?: string; since?: string }
): EngineResult<MetricsData> {
  const cleoDir = join(projectRoot, '.cleo');

  // Compliance metrics
  const compliancePath = join(cleoDir, 'metrics', 'COMPLIANCE.jsonl');
  let complianceEntries: Record<string, unknown>[] = [];
  if (existsSync(compliancePath)) {
    try {
      const content = readFileSync(compliancePath, 'utf-8').trim();
      if (content) {
        complianceEntries = content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      }
    } catch {
      // skip
    }
  }

  if (params?.since) {
    complianceEntries = complianceEntries.filter(e => (e.timestamp as string) >= params.since!);
  }

  const totalCompliance = complianceEntries.length;
  let passed = 0;
  let failed = 0;
  let scoreSum = 0;
  for (const e of complianceEntries) {
    const c = (e.compliance ?? {}) as Record<string, unknown>;
    const violations = (c.violation_count as number) ?? 0;
    if (violations === 0) passed++;
    else failed++;
    scoreSum += (c.compliance_pass_rate as number) ?? 0;
  }
  const avgScore = totalCompliance > 0 ? Math.round((scoreSum / totalCompliance) * 1000) / 1000 : 0;

  // Session metrics
  let sessionsTotal = 0;
  let sessionsActive = 0;
  let sessionsCompleted = 0;
  const sessionsPath = join(cleoDir, 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as SessionsFile;
      const sessions = sessionsData.sessions ?? [];
      sessionsTotal = sessions.length;
      sessionsActive = sessions.filter(s => s.status === 'active').length;
      sessionsCompleted = sessions.filter(s => s.status === 'ended' || s.status === 'completed').length;
    } catch {
      // skip
    }
  }

  return {
    success: true,
    data: {
      tokens: { input: 0, output: 0, cache: 0, total: 0 },
      compliance: { total: totalCompliance, passed, failed, score: avgScore },
      sessions: { total: sessionsTotal, active: sessionsActive, completed: sessionsCompleted },
    },
  };
}

// ===== Health =====

export interface HealthData {
  overall: 'healthy' | 'warning' | 'error';
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message?: string;
  }>;
  version: string;
  installation: 'ok' | 'degraded';
}

/**
 * System health check: verify core data files exist and are valid.
 * @task T4631
 */
export function systemHealth(
  projectRoot: string,
  params?: { detailed?: boolean }
): EngineResult<HealthData> {
  const cleoDir = join(projectRoot, '.cleo');
  const checks: HealthData['checks'] = [];

  // Check .cleo directory
  if (existsSync(cleoDir)) {
    checks.push({ name: 'cleo_dir', status: 'pass', message: '.cleo directory exists' });
  } else {
    checks.push({ name: 'cleo_dir', status: 'fail', message: '.cleo directory not found' });
  }

  // Check todo.json
  const todoPath = join(cleoDir, 'todo.json');
  if (existsSync(todoPath)) {
    try {
      JSON.parse(readFileSync(todoPath, 'utf-8'));
      checks.push({ name: 'todo_json', status: 'pass', message: 'todo.json is valid JSON' });
    } catch {
      checks.push({ name: 'todo_json', status: 'fail', message: 'todo.json is not valid JSON' });
    }
  } else {
    checks.push({ name: 'todo_json', status: 'fail', message: 'todo.json not found' });
  }

  // Check config.json
  const configPath = join(cleoDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      JSON.parse(readFileSync(configPath, 'utf-8'));
      checks.push({ name: 'config_json', status: 'pass', message: 'config.json is valid JSON' });
    } catch {
      checks.push({ name: 'config_json', status: 'warn', message: 'config.json is not valid JSON' });
    }
  } else {
    checks.push({ name: 'config_json', status: 'warn', message: 'config.json not found' });
  }

  // Check sessions.json
  const sessionsPath2 = join(cleoDir, 'sessions.json');
  if (existsSync(sessionsPath2)) {
    try {
      JSON.parse(readFileSync(sessionsPath2, 'utf-8'));
      checks.push({ name: 'sessions_json', status: 'pass', message: 'sessions.json is valid JSON' });
    } catch {
      checks.push({ name: 'sessions_json', status: 'warn', message: 'sessions.json is not valid JSON' });
    }
  } else {
    checks.push({ name: 'sessions_json', status: 'pass', message: 'sessions.json not present (optional)' });
  }

  // Check .sequence.json
  const seqPath2 = join(cleoDir, '.sequence.json');
  if (existsSync(seqPath2)) {
    try {
      JSON.parse(readFileSync(seqPath2, 'utf-8'));
      checks.push({ name: 'sequence_json', status: 'pass', message: '.sequence.json is valid' });
    } catch {
      checks.push({ name: 'sequence_json', status: 'warn', message: '.sequence.json is not valid JSON' });
    }
  } else {
    checks.push({ name: 'sequence_json', status: 'warn', message: '.sequence.json not found' });
  }

  // Check archive
  const archivePath = join(cleoDir, 'todo-archive.json');
  if (existsSync(archivePath)) {
    try {
      JSON.parse(readFileSync(archivePath, 'utf-8'));
      checks.push({ name: 'archive_json', status: 'pass', message: 'todo-archive.json is valid JSON' });
    } catch {
      checks.push({ name: 'archive_json', status: 'warn', message: 'todo-archive.json is not valid JSON' });
    }
  } else {
    checks.push({ name: 'archive_json', status: 'pass', message: 'todo-archive.json not present (optional)' });
  }

  if (params?.detailed) {
    // Check log file
    const logPath = join(cleoDir, 'todo-log.jsonl');
    if (existsSync(logPath)) {
      checks.push({ name: 'log_file', status: 'pass', message: 'todo-log.jsonl exists' });
    } else {
      checks.push({ name: 'log_file', status: 'warn', message: 'todo-log.jsonl not found' });
    }

    // Check backups directory
    const backupDir = join(cleoDir, '.backups');
    if (existsSync(backupDir)) {
      checks.push({ name: 'backups_dir', status: 'pass', message: '.backups directory exists' });
    } else {
      checks.push({ name: 'backups_dir', status: 'pass', message: 'No backups directory (created on first write)' });
    }
  }

  // Get version
  let version = 'unknown';
  try {
    const pkgPath = join(projectRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version || 'unknown';
    }
  } catch {
    // fallback
  }

  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const overall: HealthData['overall'] = failCount > 0 ? 'error' : warnCount > 0 ? 'warning' : 'healthy';
  const installation: HealthData['installation'] = failCount > 0 ? 'degraded' : 'ok';

  return {
    success: true,
    data: { overall, checks, version, installation },
  };
}

// ===== Diagnostics =====

export interface DiagnosticsData {
  timestamp: string;
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    details?: string;
    fix?: string;
  }>;
  summary: {
    total: number;
    passed: number;
    warned: number;
    failed: number;
  };
}

/**
 * System diagnostics: extended health checks with fix suggestions.
 * @task T4631
 */
export function systemDiagnostics(
  projectRoot: string,
  params?: { checks?: string[] }
): EngineResult<DiagnosticsData> {
  const healthResult = systemHealth(projectRoot, { detailed: true });
  if (!healthResult.success || !healthResult.data) {
    return { success: false, error: { code: 'E_HEALTH_FAILED', message: 'Health check failed' } };
  }

  const diagChecks: DiagnosticsData['checks'] = healthResult.data.checks.map(c => ({
    name: c.name,
    status: c.status,
    details: c.message,
    fix: c.status === 'fail'
      ? c.name === 'cleo_dir' ? 'Run: cleo init' :
        c.name === 'todo_json' ? 'Run: cleo init (or restore from backup)' :
        undefined
      : undefined,
  }));

  // Additional diagnostics
  const cleoDir = join(projectRoot, '.cleo');

  // Check schema version consistency
  const todoPath = join(cleoDir, 'todo.json');
  if (existsSync(todoPath)) {
    try {
      const todo = JSON.parse(readFileSync(todoPath, 'utf-8'));
      const schemaVersion = todo._meta?.schemaVersion;
      if (schemaVersion) {
        diagChecks.push({ name: 'schema_version', status: 'pass', details: `Schema version: ${schemaVersion}` });
      } else {
        diagChecks.push({ name: 'schema_version', status: 'warn', details: 'No schema version in _meta', fix: 'Run: cleo migrate' });
      }
    } catch {
      // already caught in health check
    }
  }

  // Check for stale sessions
  const sessionsPath = join(cleoDir, 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      const activeSessions = (sessionsData.sessions ?? []).filter((s: { status: string }) => s.status === 'active');
      if (activeSessions.length > 3) {
        diagChecks.push({
          name: 'stale_sessions',
          status: 'warn',
          details: `${activeSessions.length} active sessions (may include stale)`,
          fix: 'Run: cleo session gc',
        });
      } else {
        diagChecks.push({ name: 'stale_sessions', status: 'pass', details: `${activeSessions.length} active session(s)` });
      }
    } catch {
      // skip
    }
  }

  // Filter checks if specific ones requested
  let filteredChecks = diagChecks;
  if (params?.checks && params.checks.length > 0) {
    filteredChecks = diagChecks.filter(c => params.checks!.includes(c.name));
  }

  const passedCount = filteredChecks.filter(c => c.status === 'pass').length;
  const warnedCount = filteredChecks.filter(c => c.status === 'warn').length;
  const failedCount = filteredChecks.filter(c => c.status === 'fail').length;

  return {
    success: true,
    data: {
      timestamp: new Date().toISOString(),
      checks: filteredChecks,
      summary: { total: filteredChecks.length, passed: passedCount, warned: warnedCount, failed: failedCount },
    },
  };
}

// ===== Help =====

export interface HelpData {
  topic?: string;
  content: string;
  relatedCommands?: string[];
}

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
      'Focus Management',
      '',
      '  ct focus set T1234    - Set focus to task',
      '  ct focus show         - Show current focus',
      '  ct focus clear        - Clear focus',
    ].join('\n'),
    relatedCommands: ['ct focus set', 'ct focus show', 'ct focus clear'],
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

/**
 * Return help text for the system.
 * @task T4631
 */
export function systemHelp(
  _projectRoot: string,
  params?: { topic?: string }
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
        '  ct focus set <id>  - Set active task',
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

/**
 * Generate roadmap from pending epics and optional CHANGELOG history.
 * @task T4631
 */
export function systemRoadmap(
  projectRoot: string,
  params?: { includeHistory?: boolean; upcomingOnly?: boolean }
): EngineResult<RoadmapData> {
  const todo = loadTodoFile(projectRoot);
  if (!todo) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const tasks = todo.tasks || [];

  // Get current version
  let currentVersion = 'unknown';
  try {
    const versionPath = join(projectRoot, 'VERSION');
    if (existsSync(versionPath)) {
      currentVersion = readFileSync(versionPath, 'utf-8').trim();
    } else {
      const pkgPath = join(projectRoot, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        currentVersion = pkg.version || 'unknown';
      }
    }
  } catch {
    // fallback
  }

  // Find epics (tasks that are parents of other tasks)
  const childParentIds = new Set(tasks.filter(t => t.parentId).map(t => t.parentId!));
  const epics = tasks.filter(t => childParentIds.has(t.id));

  const pending = epics.filter(e => e.status !== 'done');
  const completed = epics.filter(e => e.status === 'done');

  // Parse CHANGELOG if requested
  let releaseHistory: Array<{ version: string; date: string }> | undefined;
  if (params?.includeHistory) {
    releaseHistory = [];
    try {
      const changelogPath = join(projectRoot, 'CHANGELOG.md');
      if (existsSync(changelogPath)) {
        const content = readFileSync(changelogPath, 'utf-8');
        const versionRegex = /^##\s+\[?v?(\d+\.\d+\.\d+[^\]]*)\]?\s*[-\(]?\s*(\d{4}-\d{2}-\d{2})?/gm;
        let match;
        while ((match = versionRegex.exec(content)) !== null) {
          releaseHistory.push({ version: match[1]!, date: match[2] ?? 'unknown' });
        }
      }
    } catch {
      // skip
    }
  }

  const upcoming = pending.map(e => ({
    id: e.id,
    title: e.title,
    status: e.status,
    priority: e.priority,
    phase: e.phase,
    childCount: tasks.filter(t => t.parentId === e.id).length,
    completedChildren: tasks.filter(t => t.parentId === e.id && t.status === 'done').length,
  }));

  const result: RoadmapData = {
    currentVersion,
    upcoming,
    summary: {
      totalUpcoming: upcoming.length,
      totalTasks: tasks.length,
    },
  };

  if (params?.includeHistory) {
    result.releaseHistory = releaseHistory;
    result.completedEpics = completed.length;
  }

  return { success: true, data: result };
}

// ===== Compliance =====

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

/**
 * System compliance report from COMPLIANCE.jsonl.
 * @task T4631
 */
export function systemCompliance(
  projectRoot: string,
  params?: { subcommand?: string; days?: number; epic?: string }
): EngineResult<ComplianceData> {
  const compliancePath = join(projectRoot, '.cleo', 'metrics', 'COMPLIANCE.jsonl');
  let entries: Record<string, unknown>[] = [];

  if (existsSync(compliancePath)) {
    try {
      const content = readFileSync(compliancePath, 'utf-8').trim();
      if (content) {
        entries = content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      }
    } catch {
      // skip
    }
  }

  // Filter by epic if specified
  if (params?.epic) {
    entries = entries.filter(e => {
      const ctx = (e._context ?? {}) as Record<string, unknown>;
      return ctx.epic_id === params.epic || ctx.task_id === params.epic;
    });
  }

  // Filter by days if specified
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

  // Trend data for 'trend' subcommand
  let trend: string | undefined;
  let dataPoints: ComplianceData['dataPoints'] | undefined;

  if (params?.subcommand === 'trend') {
    const byDate: Record<string, Record<string, unknown>[]> = {};
    for (const e of entries) {
      const date = (e.timestamp as string).split('T')[0]!;
      if (!byDate[date]) byDate[date] = [];
      byDate[date]!.push(e);
    }

    dataPoints = Object.entries(byDate)
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

    if (dataPoints.length >= 2) {
      const first = dataPoints[0]!.avgPassRate;
      const last = dataPoints[dataPoints.length - 1]!.avgPassRate;
      trend = last > first ? 'improving' : last < first ? 'declining' : 'stable';
    } else {
      trend = 'insufficient_data';
    }
  }

  return {
    success: true,
    data: { totalEntries, averagePassRate: avgPassRate, averageAdherence: avgAdherence, totalViolations, trend, dataPoints },
  };
}

// ===== Backup =====

export interface BackupData {
  backupId: string;
  path: string;
  timestamp: string;
  type: string;
  files: string[];
}

/**
 * Create a backup of CLEO data files.
 * @task T4631
 */
export function systemBackup(
  projectRoot: string,
  params?: { type?: string; note?: string }
): EngineResult<BackupData> {
  const cleoDir = join(projectRoot, '.cleo');
  const btype = params?.type || 'snapshot';
  const timestamp = new Date().toISOString();
  const backupId = `${btype}-${timestamp.replace(/[:.]/g, '-')}`;
  const backupDir = join(cleoDir, 'backups', btype);

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const filesToBackup = ['todo.json', 'todo-archive.json', 'sessions.json', 'config.json', 'todo-log.jsonl'];
  const backedUp: string[] = [];

  for (const file of filesToBackup) {
    const src = join(cleoDir, file);
    if (existsSync(src)) {
      const dest = join(backupDir, `${file}.${backupId}`);
      try {
        const content = readFileSync(src, 'utf-8');
        writeFileSync(dest, content, 'utf-8');
        backedUp.push(file);
      } catch {
        // skip files that fail to copy
      }
    }
  }

  // Write metadata
  const metaPath = join(backupDir, `${backupId}.meta.json`);
  try {
    writeFileSync(metaPath, JSON.stringify({
      backupId,
      type: btype,
      timestamp,
      note: params?.note,
      files: backedUp,
    }, null, 2), 'utf-8');
  } catch {
    // non-fatal
  }

  return {
    success: true,
    data: { backupId, path: backupDir, timestamp, type: btype, files: backedUp },
  };
}

// ===== Restore =====

export interface RestoreData {
  restored: boolean;
  backupId: string;
  timestamp: string;
  filesRestored: string[];
}

/**
 * Restore from a backup.
 * @task T4631
 */
export function systemRestore(
  projectRoot: string,
  params: { backupId: string; force?: boolean }
): EngineResult<RestoreData> {
  if (!params?.backupId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'backupId is required' } };
  }

  const cleoDir = join(projectRoot, '.cleo');
  const backupTypes = ['snapshot', 'safety', 'migration'];
  let metaPath: string | null = null;
  let backupDir: string | null = null;

  for (const btype of backupTypes) {
    const candidateMeta = join(cleoDir, 'backups', btype, `${params.backupId}.meta.json`);
    if (existsSync(candidateMeta)) {
      metaPath = candidateMeta;
      backupDir = join(cleoDir, 'backups', btype);
      break;
    }
  }

  if (!metaPath || !backupDir) {
    return { success: false, error: { code: 'E_NOT_FOUND', message: `Backup not found: ${params.backupId}` } };
  }

  let meta: { files: string[]; timestamp: string };
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    return { success: false, error: { code: 'E_PARSE_ERROR', message: 'Failed to read backup metadata' } };
  }

  const restored: string[] = [];
  for (const file of meta.files ?? []) {
    const backupFile = join(backupDir, `${file}.${params.backupId}`);
    if (existsSync(backupFile)) {
      try {
        const content = readFileSync(backupFile, 'utf-8');
        writeFileSync(join(cleoDir, file), content, 'utf-8');
        restored.push(file);
      } catch {
        // skip files that fail to restore
      }
    }
  }

  return {
    success: true,
    data: {
      restored: restored.length > 0,
      backupId: params.backupId,
      timestamp: meta.timestamp ?? new Date().toISOString(),
      filesRestored: restored,
    },
  };
}

// ===== Migrate =====

export interface MigrateData {
  from: string;
  to: string;
  migrations: Array<{ name: string; applied: boolean }>;
  dryRun: boolean;
}

/**
 * Check/run schema migrations. Reports current state;
 * full migration logic lives in CLI for complex transformations.
 * @task T4631
 */
export function systemMigrate(
  projectRoot: string,
  params?: { target?: string; dryRun?: boolean }
): EngineResult<MigrateData> {
  const todoPath = join(projectRoot, '.cleo', 'todo.json');

  let currentVersion = 'unknown';
  if (existsSync(todoPath)) {
    try {
      const todo = JSON.parse(readFileSync(todoPath, 'utf-8'));
      currentVersion = todo._meta?.schemaVersion ?? todo.version ?? 'unknown';
    } catch {
      return { success: false, error: { code: 'E_PARSE_ERROR', message: 'Failed to read todo.json' } };
    }
  } else {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const targetVersion = params?.target ?? currentVersion;

  return {
    success: true,
    data: {
      from: currentVersion,
      to: targetVersion,
      migrations: currentVersion === targetVersion
        ? []
        : [{ name: `${currentVersion} -> ${targetVersion}`, applied: false }],
      dryRun: params?.dryRun ?? false,
    },
  };
}

// ===== Cleanup =====

export interface CleanupData {
  target: string;
  deleted: number;
  items: string[];
  dryRun: boolean;
}

/**
 * Cleanup stale data (sessions, backups, logs).
 * @task T4631
 */
export function systemCleanup(
  projectRoot: string,
  params: { target: string; olderThan?: string; dryRun?: boolean }
): EngineResult<CleanupData> {
  if (!params?.target) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'target is required (sessions|backups|logs|archive)' } };
  }

  const cleoDir = join(projectRoot, '.cleo');
  const dryRun = params.dryRun ?? false;
  const items: string[] = [];

  switch (params.target) {
    case 'sessions': {
      const sessPath = join(cleoDir, 'sessions.json');
      if (existsSync(sessPath)) {
        try {
          const data = JSON.parse(readFileSync(sessPath, 'utf-8'));
          const sessions = data.sessions ?? [];
          const stale = sessions.filter((s: { status: string; lastActivity?: string }) => {
            if (s.status !== 'active') return false;
            if (params.olderThan && s.lastActivity) {
              return s.lastActivity < params.olderThan;
            }
            const cutoff = new Date(Date.now() - 86400000).toISOString();
            return s.lastActivity && s.lastActivity < cutoff;
          });
          for (const s of stale) {
            items.push((s as { id: string }).id);
          }
          if (!dryRun && stale.length > 0) {
            const staleIds = new Set(stale.map((s: { id: string }) => s.id));
            data.sessions = sessions.filter((s: { id: string }) => !staleIds.has(s.id));
            writeFileSync(sessPath, JSON.stringify(data, null, 2), 'utf-8');
          }
        } catch {
          // skip
        }
      }
      break;
    }
    case 'backups': {
      const backupBaseDir = join(cleoDir, 'backups');
      if (existsSync(backupBaseDir)) {
        for (const typeDir of readdirSync(backupBaseDir)) {
          const fullDir = join(backupBaseDir, typeDir);
          try {
            for (const file of readdirSync(fullDir)) {
              if (file.endsWith('.meta.json')) {
                const metaFilePath = join(fullDir, file);
                try {
                  const meta = JSON.parse(readFileSync(metaFilePath, 'utf-8'));
                  if (params.olderThan && meta.timestamp < params.olderThan) {
                    items.push(file.replace('.meta.json', ''));
                    if (!dryRun) {
                      unlinkSync(metaFilePath);
                      for (const bf of readdirSync(fullDir)) {
                        if (bf.includes(meta.backupId)) {
                          try { unlinkSync(join(fullDir, bf)); } catch { /* skip */ }
                        }
                      }
                    }
                  }
                } catch { /* skip */ }
              }
            }
          } catch { /* skip */ }
        }
      }
      break;
    }
    case 'logs': {
      const auditPattern = /^audit-log-.*\.json$/;
      if (existsSync(cleoDir)) {
        for (const file of readdirSync(cleoDir)) {
          if (auditPattern.test(file)) {
            items.push(file);
            if (!dryRun) {
              try { unlinkSync(join(cleoDir, file)); } catch { /* skip */ }
            }
          }
        }
      }
      break;
    }
    default:
      return { success: false, error: { code: 'E_INVALID_INPUT', message: `Invalid cleanup target: ${params.target}` } };
  }

  return {
    success: true,
    data: { target: params.target, deleted: dryRun ? 0 : items.length, items, dryRun },
  };
}

// ===== Audit =====

export interface AuditData {
  scope: string;
  issues: Array<{
    severity: 'error' | 'warning' | 'info';
    category: string;
    message: string;
    fix?: string;
  }>;
  summary: {
    errors: number;
    warnings: number;
    fixed: number;
  };
}

/**
 * Audit data integrity.
 * @task T4631
 */
export function systemAudit(
  projectRoot: string,
  params?: { scope?: string; fix?: boolean }
): EngineResult<AuditData> {
  const cleoDir = join(projectRoot, '.cleo');
  const scope = params?.scope ?? 'all';
  const issues: AuditData['issues'] = [];

  if (scope === 'all' || scope === 'tasks') {
    const todoPath = join(cleoDir, 'todo.json');
    if (existsSync(todoPath)) {
      try {
        const todo = JSON.parse(readFileSync(todoPath, 'utf-8'));
        const tasks = todo.tasks ?? [];

        const idSet = new Set<string>();
        for (const t of tasks) {
          if (idSet.has(t.id)) {
            issues.push({ severity: 'error', category: 'tasks', message: `Duplicate task ID: ${t.id}` });
          }
          idSet.add(t.id);
        }

        for (const t of tasks) {
          if (t.parentId && !idSet.has(t.parentId)) {
            issues.push({ severity: 'warning', category: 'tasks', message: `Task ${t.id} references non-existent parent: ${t.parentId}` });
          }
        }

        for (const t of tasks) {
          if (!t.title) issues.push({ severity: 'error', category: 'tasks', message: `Task ${t.id} missing title` });
          if (!t.status) issues.push({ severity: 'error', category: 'tasks', message: `Task ${t.id} missing status` });
        }

        for (const t of tasks) {
          if (t.depends) {
            for (const dep of t.depends) {
              if (!idSet.has(dep)) {
                issues.push({ severity: 'warning', category: 'tasks', message: `Task ${t.id} depends on non-existent: ${dep}` });
              }
            }
          }
        }
      } catch (err) {
        issues.push({ severity: 'error', category: 'tasks', message: `Failed to parse todo.json: ${err}` });
      }
    }
  }

  if (scope === 'all' || scope === 'sessions') {
    const sessPath = join(cleoDir, 'sessions.json');
    if (existsSync(sessPath)) {
      try {
        const data = JSON.parse(readFileSync(sessPath, 'utf-8'));
        const sessions = data.sessions ?? [];

        const sessionIds = new Set<string>();
        for (const s of sessions) {
          if (sessionIds.has(s.id)) {
            issues.push({ severity: 'error', category: 'sessions', message: `Duplicate session ID: ${s.id}` });
          }
          sessionIds.add(s.id);
        }

        for (const s of sessions) {
          if (!s.scope?.rootTaskId) {
            issues.push({ severity: 'warning', category: 'sessions', message: `Session ${s.id} missing scope rootTaskId` });
          }
        }
      } catch (err) {
        issues.push({ severity: 'error', category: 'sessions', message: `Failed to parse sessions.json: ${err}` });
      }
    }
  }

  if (scope === 'all') {
    const seqPath3 = join(cleoDir, '.sequence.json');
    if (existsSync(seqPath3)) {
      try {
        const seq = JSON.parse(readFileSync(seqPath3, 'utf-8'));
        if (typeof seq.counter !== 'number') {
          issues.push({ severity: 'error', category: 'sequence', message: 'Sequence counter is not a number' });
        }
      } catch {
        issues.push({ severity: 'error', category: 'sequence', message: 'Failed to parse .sequence.json' });
      }
    }
  }

  return {
    success: true,
    data: {
      scope,
      issues,
      summary: { errors: issues.filter(i => i.severity === 'error').length, warnings: issues.filter(i => i.severity === 'warning').length, fixed: 0 },
    },
  };
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
  params?: { direction?: string }
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

export interface SafestopData {
  stopped: boolean;
  reason: string;
  sessionEnded: boolean;
  handoff?: string;
  dryRun: boolean;
}

/**
 * Safe stop: signal clean shutdown for agents.
 * @task T4631
 */
export function systemSafestop(
  projectRoot: string,
  params?: { reason?: string; commit?: boolean; handoff?: string; noSessionEnd?: boolean; dryRun?: boolean }
): EngineResult<SafestopData> {
  const dryRun = params?.dryRun ?? false;
  const reason = params?.reason ?? 'Manual safestop';
  let sessionEnded = false;

  if (!dryRun && !params?.noSessionEnd) {
    const sessPath = join(projectRoot, '.cleo', 'sessions.json');
    if (existsSync(sessPath)) {
      try {
        const data = JSON.parse(readFileSync(sessPath, 'utf-8'));
        const sessions = data.sessions ?? [];
        let changed = false;
        for (const s of sessions) {
          if (s.status === 'active') {
            s.status = 'ended';
            s.endedAt = new Date().toISOString();
            s.endNote = `Safestop: ${reason}`;
            changed = true;
            sessionEnded = true;
          }
        }
        if (changed) {
          writeFileSync(sessPath, JSON.stringify(data, null, 2), 'utf-8');
        }
      } catch {
        // non-fatal
      }
    }
  }

  return {
    success: true,
    data: { stopped: !dryRun, reason, sessionEnded, handoff: params?.handoff, dryRun },
  };
}

// ===== Uncancel =====

export interface UncancelData {
  taskId: string;
  uncancelled: boolean;
  previousStatus: string;
  newStatus: string;
  cascadeCount: number;
  dryRun: boolean;
}

/**
 * Uncancel a cancelled task (restore to pending).
 * @task T4631
 */
export function systemUncancel(
  projectRoot: string,
  params: { taskId: string; cascade?: boolean; notes?: string; dryRun?: boolean }
): EngineResult<UncancelData> {
  if (!params?.taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  const todoPath = join(projectRoot, '.cleo', 'todo.json');
  if (!existsSync(todoPath)) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  let todo: { tasks: Array<{ id: string; status: string; parentId?: string; notes?: Array<{ text: string; timestamp: string }> }> };
  try {
    todo = JSON.parse(readFileSync(todoPath, 'utf-8'));
  } catch {
    return { success: false, error: { code: 'E_PARSE_ERROR', message: 'Failed to parse todo.json' } };
  }

  const task = todo.tasks.find(t => t.id === params.taskId);
  if (!task) {
    return { success: false, error: { code: 'E_NOT_FOUND', message: `Task not found: ${params.taskId}` } };
  }
  if (task.status !== 'cancelled') {
    return { success: false, error: { code: 'E_INVALID_STATUS', message: `Task ${params.taskId} is not cancelled (status: ${task.status})` } };
  }

  const dryRun = params.dryRun ?? false;
  let cascadeCount = 0;

  if (!dryRun) {
    task.status = 'pending';
    if (params.notes) {
      if (!task.notes) task.notes = [];
      task.notes.push({ text: params.notes, timestamp: new Date().toISOString() });
    }
    if (params.cascade) {
      for (const t of todo.tasks) {
        if (t.parentId === params.taskId && t.status === 'cancelled') {
          t.status = 'pending';
          cascadeCount++;
        }
      }
    }
    writeFileSync(todoPath, JSON.stringify(todo, null, 2), 'utf-8');
  } else if (params.cascade) {
    cascadeCount = todo.tasks.filter(t => t.parentId === params.taskId && t.status === 'cancelled').length;
  }

  return {
    success: true,
    data: {
      taskId: params.taskId,
      uncancelled: !dryRun,
      previousStatus: 'cancelled',
      newStatus: dryRun ? 'cancelled' : 'pending',
      cascadeCount,
      dryRun,
    },
  };
}

/**
 * Build the MVI markdown string from current project state.
 */
function buildMviMarkdown(state: {
  version: string;
  storageEngine: string;
  activeSessionName: string | null;
  focusTask: string | null;
  sessionScope: string | null;
}): string {
  const sessionLine = state.activeSessionName
    ? `| Session | \`${state.activeSessionName}\` (${state.sessionScope || 'unknown'}) |`
    : '| Session | none |';
  const focusLine = state.focusTask
    ? `| Focus | \`${state.focusTask}\` |`
    : '| Focus | none |';

  return `## CLEO Task Management (MVI)

> **Bootstrap**: Call \`orchestrate.bootstrap\` with \`speed=fast\` at session start.

| Key | Value |
|-----|-------|
| Version | \`${state.version}\` |
| Storage | \`${state.storageEngine}\` |
${sessionLine}
${focusLine}

### Essential Commands

| Command | Description |
|---------|-------------|
| \`ct find "query"\` | Fuzzy search tasks (minimal context) |
| \`ct show T1234\` | Full task details |
| \`ct add "Title" --desc "..."\` | Create task |
| \`ct done <id>\` | Complete task |
| \`ct focus set <id>\` | Set active task |
| \`ct focus show\` | Current focus |
| \`ct next\` | Suggest next task |
| \`ct session list\` | List sessions |
| \`ct session start --scope epic:T### --auto-focus --name "..."\` | Start session |
| \`ct session end --note "..."\` | End session |
| \`ct dash\` | Project overview |
| \`ct context\` | Context window usage |

### Session Protocol

1. **START**: \`ct session list\` then \`ct session resume <id>\` or \`ct session start --scope epic:T### --auto-focus --name "Work"\`
2. **WORK**: \`ct focus show\` / \`ct next\` / \`ct complete <id>\` / \`ct focus set <id>\`
3. **END**: \`ct complete <id>\` then \`ct session end --note "Progress"\`

### Error Handling

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | \`E_NOT_FOUND\` | Use \`ct find\` or \`ct list\` to verify |
| 6 | \`E_VALIDATION\` | Check field lengths, escape \`$\` as \`\\$\` |
| 10 | \`E_PARENT_NOT_FOUND\` | Verify with \`ct exists <parent-id>\` |
| 11 | \`E_DEPTH_EXCEEDED\` | Max depth 3 (epic->task->subtask) |
| 12 | \`E_SIBLING_LIMIT\` | Max 7 siblings per parent |

**After EVERY command**: Check exit code (\`0\` = success), check \`"success"\` in JSON output, execute \`error.fix\` if provided.
`;
}
