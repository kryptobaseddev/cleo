/**
 * System Engine
 *
 * Native TypeScript implementation of system-level operations.
 * Provides dashboard, statistics, labels, archive metrics, log queries,
 * context monitoring, sequence state, and MVI injection generation.
 *
 * Read-only queries: dash, stats, labels, archive-stats, log, context, sequence
 * Mutate operations: inject.generate (generates dynamic MVI injection)
 *
 * Supports: dash, stats, labels, archive-stats, log, context, sequence, inject.generate
 */

import { readJsonFile, getDataPath } from './store.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
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
 * Log file structure
 */
interface LogFile {
  entries: LogEntry[];
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

function loadLogFile(projectRoot: string): LogFile | null {
  const logPath = getDataPath(projectRoot, 'todo-log.json');
  return readJsonFile<LogFile>(logPath);
}

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

  // Log-based metrics
  const logData = loadLogFile(projectRoot);
  const entries = logData?.entries ?? [];

  const createdInPeriod = entries.filter(
    e => e.operation === 'create' && e.timestamp >= cutoff
  ).length;
  const completedInPeriod = entries.filter(
    e => e.operation === 'complete' && e.timestamp >= cutoff
  ).length;
  const archivedInPeriod = entries.filter(
    e => e.operation === 'archive' && e.timestamp >= cutoff
  ).length;

  const completionRate = createdInPeriod > 0
    ? Math.round((completedInPeriod / createdInPeriod) * 10000) / 100
    : 0;

  const totalCreated = entries.filter(e => e.operation === 'create').length;
  const totalCompleted = entries.filter(e => e.operation === 'complete').length;
  const totalArchived = entries.filter(e => e.operation === 'archive').length;

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
 * Query todo-log.json with optional filters.
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
  const logData = loadLogFile(projectRoot);
  let entries = logData?.entries ?? [];

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
