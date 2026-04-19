/**
 * Orchestrator session startup protocol.
 * Ports lib/skills/orchestrator-startup.sh.
 *
 * Implements the session startup sequence, context monitoring,
 * dependency analysis, task spawning, and HITL summary generation.
 *
 * @epic T4454
 * @task T4519
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, TaskRef, TaskRefPriority, TaskWorkState } from '@cleocode/contracts';
import { getCleoDirAbsolute } from '../../paths.js';
import { getAccessor } from '../../store/data-accessor.js';
import type {
  DependencyAnalysis,
  DependencyWave,
  HitlSummary,
  OrchestratorThresholds,
} from '../types.js';

// ============================================================================
// Configuration
// ============================================================================

/** Default context thresholds. */
const DEFAULT_THRESHOLDS: OrchestratorThresholds = { warning: 70, critical: 80 };

/**
 * Get orchestrator context thresholds from config or defaults.
 * @task T4519
 */
export function getThresholds(config?: Record<string, unknown>): OrchestratorThresholds {
  const orc = (config as Record<string, Record<string, Record<string, unknown>>>)?.orchestrator
    ?.contextThresholds;
  const warning = typeof orc?.warning === 'number' ? orc.warning : DEFAULT_THRESHOLDS.warning;
  const critical = typeof orc?.critical === 'number' ? orc.critical : DEFAULT_THRESHOLDS.critical;

  // Validate warning < critical
  if (warning >= critical) {
    return DEFAULT_THRESHOLDS;
  }

  return { warning, critical };
}

// ============================================================================
// Context State
// ============================================================================

interface ContextState {
  percentage: number;
  currentTokens: number;
  maxTokens: number;
  status: string;
  stale: boolean;
}

/**
 * Read the current context state from session-aware files.
 * @task T4519
 */
export function getContextState(sessionId?: string, cwd?: string): ContextState {
  const cleoDirAbs = getCleoDirAbsolute(cwd);
  const defaultState: ContextState = {
    percentage: 0,
    currentTokens: 0,
    maxTokens: 200000,
    status: 'unknown',
    stale: true,
  };

  // Try session-specific state file
  let stateFile = '';
  if (sessionId) {
    stateFile = join(cleoDirAbs, 'sessions', sessionId, '.context-state.json');
    if (!existsSync(stateFile)) {
      stateFile = join(cleoDirAbs, `.context-state-${sessionId}.json`);
    }
  }

  // Fallback to singleton
  if (!stateFile || !existsSync(stateFile)) {
    stateFile = join(cleoDirAbs, '.context-state.json');
  }

  if (!existsSync(stateFile)) {
    return defaultState;
  }

  try {
    const data = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const cw = data.contextWindow ?? data;
    const timestamp = data.timestamp as string | undefined;
    const staleAfterMs = (data.staleAfterMs ?? 5000) as number;

    let isStale = false;
    if (timestamp) {
      const ageMs = Date.now() - new Date(timestamp).getTime();
      isStale = ageMs > staleAfterMs;
    }

    return {
      percentage: cw.percentage ?? 0,
      currentTokens: cw.currentTokens ?? 0,
      maxTokens: cw.maxTokens ?? 200000,
      status: isStale ? 'stale' : (data.status ?? 'unknown'),
      stale: isStale,
    };
  } catch {
    return defaultState;
  }
}

// ============================================================================
// Session Init
// ============================================================================

/** Session init result. */
export interface SessionInitResult {
  activeSessions: number;
  activeSessionId: string | null;
  activeScope: string | null;
  hasFocus: boolean;
  focusedTask: string | null;
  hasPending: boolean;
  recommendedAction: 'resume' | 'spawn_followup' | 'create_and_spawn' | 'request_direction';
  actionReason: string;
}

/**
 * Initialize orchestrator session state.
 * Determines the recommended action based on current state.
 * @task T4519
 */
export async function sessionInit(epicId?: string, cwd?: string): Promise<SessionInitResult> {
  const acc = await getAccessor(cwd);

  // Check active sessions from SQLite (ADR-006/ADR-020)
  let activeSessions = 0;
  let activeSessionId: string | null = null;
  let activeScope: string | null = null;

  try {
    const sessions = await acc.loadSessions();
    let active = sessions.filter((s) => s.status === 'active');

    // If epicId provided, prefer sessions scoped to that epic
    if (epicId && active.length > 0) {
      const epicScoped = active.filter(
        (s) => s.scope?.rootTaskId === epicId || s.scope?.epicId === epicId,
      );
      if (epicScoped.length > 0) {
        active = epicScoped;
      }
    }

    activeSessions = active.length;
    if (activeSessions > 0) {
      activeSessionId = active[0].id ?? null;
      activeScope = active[0].scope?.rootTaskId ?? active[0].scope?.epicId ?? null;
    }
  } catch {
    // DB unavailable
  }

  // If epicId provided and no active session found, set activeScope to the epic
  if (epicId && !activeScope) {
    activeScope = epicId;
  }

  // Check focus state from SQLite meta KV
  let hasFocus = false;
  let focusedTask: string | null = null;

  try {
    const focus = await acc.getMetaValue<TaskWorkState>('focus_state');
    focusedTask = focus?.currentTask ?? null;
    hasFocus = !!focusedTask;
  } catch {
    // Focus unavailable
  }

  // Determine pending work: check if the epic has ready tasks via DataAccessor
  let hasPending = false;
  if (epicId) {
    try {
      const children = await acc.getChildren(epicId);
      hasPending = children.some((t) => t.status === 'pending');
    } catch {
      // Tasks unavailable
    }
  }

  // Decision matrix
  let recommendedAction: SessionInitResult['recommendedAction'];
  let actionReason: string;

  if (activeSessions > 0 && hasFocus) {
    recommendedAction = 'resume';
    actionReason = 'Active session with focus - continue focused task';
  } else if (activeSessions > 0) {
    recommendedAction = 'spawn_followup';
    actionReason = 'Active session without focus - query manifest and spawn next agent';
  } else if (hasPending) {
    recommendedAction = 'create_and_spawn';
    actionReason = epicId
      ? `No session but epic ${epicId} has pending tasks - create session and spawn`
      : 'No session but manifest has followups - create session and spawn';
  } else {
    recommendedAction = 'request_direction';
    actionReason = 'No session, no pending work - await user direction';
  }

  return {
    activeSessions,
    activeSessionId,
    activeScope,
    hasFocus,
    focusedTask,
    hasPending,
    recommendedAction,
    actionReason,
  };
}

// ============================================================================
// Context Checks
// ============================================================================

/** Pause status result. */
export interface PauseStatus {
  pauseStatus: 'ok' | 'warning' | 'critical';
  pauseCode: 0 | 1 | 2;
  shouldPause: boolean;
  shouldWrapUp: boolean;
  contextPercentage: number;
  recommendation: string;
}

/**
 * Check if orchestrator should pause based on context usage.
 * @task T4519
 */
export function shouldPause(
  config?: Record<string, unknown>,
  sessionId?: string,
  cwd?: string,
): PauseStatus {
  const thresholds = getThresholds(config);
  const ctx = getContextState(sessionId, cwd);

  if (ctx.percentage >= thresholds.critical) {
    return {
      pauseStatus: 'critical',
      pauseCode: 2,
      shouldPause: true,
      shouldWrapUp: true,
      contextPercentage: ctx.percentage,
      recommendation: 'STOP immediately. Delegate all remaining work to subagents.',
    };
  }

  if (ctx.percentage >= thresholds.warning) {
    return {
      pauseStatus: 'warning',
      pauseCode: 1,
      shouldPause: false,
      shouldWrapUp: true,
      contextPercentage: ctx.percentage,
      recommendation: 'Wrap up current work. Spawn final subagents and prepare handoff.',
    };
  }

  return {
    pauseStatus: 'ok',
    pauseCode: 0,
    shouldPause: false,
    shouldWrapUp: false,
    contextPercentage: ctx.percentage,
    recommendation: 'Continue orchestration. Context usage is healthy.',
  };
}

// ============================================================================
// Dependency Analysis
// ============================================================================

/**
 * Analyze dependency graph and compute execution waves.
 * @task T4519
 */
export async function analyzeDependencies(
  epicId: string,
  cwd?: string,
): Promise<DependencyAnalysis> {
  const acc = await getAccessor(cwd);
  const epicTasks = await acc.getChildren(epicId);

  if (epicTasks.length === 0) {
    return {
      epicId,
      totalTasks: 0,
      completedTasks: 0,
      pendingTasks: 0,
      activeTasks: 0,
      waves: [],
      readyToSpawn: [],
      blockedTasks: [],
    };
  }

  // Need full task set to resolve cross-epic dependency status
  const { tasks: allTasks } = await acc.queryTasks({});
  const doneIds = new Set(allTasks.filter((t) => t.status === 'done').map((t) => t.id));
  const epicIds = new Set(epicTasks.map((t) => t.id));

  // Compute waves iteratively
  const waveMap = new Map<string, number>();

  for (let iteration = 0; iteration < 10; iteration++) {
    for (const task of epicTasks) {
      if (waveMap.has(task.id)) continue;

      const depsInEpic = (task.depends ?? []).filter((d) => epicIds.has(d));

      if (depsInEpic.length === 0) {
        waveMap.set(task.id, 0);
      } else if (depsInEpic.every((d) => waveMap.has(d))) {
        const maxDepWave = Math.max(...depsInEpic.map((d) => waveMap.get(d)!));
        waveMap.set(task.id, maxDepWave + 1);
      }
    }
  }

  // Build waves
  const waveGroups = new Map<number, DependencyWave['tasks']>();
  for (const task of epicTasks) {
    const wave = waveMap.get(task.id) ?? 0;
    if (!waveGroups.has(wave)) {
      waveGroups.set(wave, []);
    }
    waveGroups.get(wave)!.push({
      id: task.id,
      title: task.title,
      priority: task.priority,
      status: task.status,
      depends: task.depends ?? [],
    });
  }

  const waves: DependencyWave[] = [...waveGroups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([wave, tasks]) => ({ wave, tasks }));

  // Find ready tasks (pending with all deps done or outside epic).
  // The `status === 'pending'` check implicitly excludes the Tier-2 proposal
  // queue ('proposed') — those tasks are not part of the Tier-1 execution set
  // (T946 / Round 2 audit §8). See also dependency-check.ts:getReadyTasks.
  const readyToSpawn = epicTasks
    .filter((t) => {
      if (t.status !== 'pending') return false;
      const deps = t.depends ?? [];
      return deps.length === 0 || deps.every((d) => doneIds.has(d) || !epicIds.has(d));
    })
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      wave: waveMap.get(t.id) ?? 0,
    }));

  // Find blocked tasks (pending-only; 'proposed' Tier-2 queue implicitly excluded).
  const blockedTasks = epicTasks
    .filter((t) => {
      if (t.status !== 'pending') return false;
      const deps = t.depends ?? [];
      return deps.some((d) => epicIds.has(d) && !doneIds.has(d));
    })
    .map((t) => ({
      id: t.id,
      title: t.title,
      depends: t.depends ?? [],
      wave: waveMap.get(t.id) ?? 0,
    }));

  return {
    epicId,
    totalTasks: epicTasks.length,
    completedTasks: epicTasks.filter((t) => t.status === 'done').length,
    pendingTasks: epicTasks.filter((t) => t.status === 'pending').length,
    activeTasks: epicTasks.filter((t) => t.status === 'active').length,
    waves,
    readyToSpawn,
    blockedTasks,
  };
}

/**
 * Get the next task ready to spawn for an epic.
 * @task T4519
 */
export async function getNextTask(
  epicId: string,
  cwd?: string,
): Promise<{ task: Task | null; readyCount: number }> {
  const analysis = await analyzeDependencies(epicId, cwd);

  if (analysis.readyToSpawn.length === 0) {
    return { task: null, readyCount: 0 };
  }

  // Load full task details from SQLite
  const acc = await getAccessor(cwd);
  const nextId = analysis.readyToSpawn[0].id;
  const task = await acc.loadSingleTask(nextId);

  return { task, readyCount: analysis.readyToSpawn.length };
}

/**
 * Get all tasks ready to spawn in parallel (no inter-dependencies).
 * @task T4519
 */
export async function getReadyTasks(epicId: string, cwd?: string): Promise<TaskRefPriority[]> {
  const analysis = await analyzeDependencies(epicId, cwd);
  const readyIds = new Set(analysis.readyToSpawn.map((t) => t.id));

  // Load full task details from SQLite to check inter-ready dependencies
  const acc = await getAccessor(cwd);
  const readyTasksFull = await acc.loadTasks([...readyIds]);

  return analysis.readyToSpawn
    .filter((ready) => {
      const task = readyTasksFull.find((t) => t.id === ready.id);
      if (!task) return false;
      const deps = task.depends ?? [];
      // Only include if no deps are also in the ready set
      return !deps.some((d) => readyIds.has(d));
    })
    .map((t) => ({ id: t.id, title: t.title, priority: t.priority }));
}

// ============================================================================
// HITL Summary
// ============================================================================

/**
 * Generate a Human-in-the-Loop summary for session handoff.
 * @task T4519
 */
export async function generateHitlSummary(
  epicId?: string,
  stopReason: string = 'context-limit',
  cwd?: string,
): Promise<HitlSummary> {
  const acc = await getAccessor(cwd);

  // Session info from SQLite (ADR-006/ADR-020)
  let sessionId: string | null = null;
  try {
    const activeSession = await acc.getActiveSession();
    sessionId = activeSession?.id ?? null;
  } catch {
    // DB unavailable
  }

  // Focus info from SQLite meta KV
  let focusedTask: string | null = null;
  let progressNote: string | null = null;
  try {
    const focus = await acc.getMetaValue<TaskWorkState>('focus_state');
    focusedTask = focus?.currentTask ?? null;
    progressNote = focus?.sessionNote ?? null;
  } catch {
    // Focus unavailable
  }

  // Task statistics from SQLite via DataAccessor
  let completed = 0,
    pending = 0,
    active = 0,
    blocked = 0;
  let completedTasks: Array<Pick<TaskRef, 'id' | 'title'>> = [];
  let remainingTasks: Array<TaskRef & { priority?: string }> = [];
  let readyToSpawn: TaskRefPriority[] = [];

  if (epicId) {
    const tasks = await acc.getChildren(epicId);

    completed = tasks.filter((t) => t.status === 'done').length;
    pending = tasks.filter((t) => t.status === 'pending').length;
    active = tasks.filter((t) => t.status === 'active').length;
    blocked = tasks.filter((t) => t.status === 'blocked').length;

    completedTasks = tasks
      .filter((t) => t.status === 'done')
      .map((t) => ({ id: t.id, title: t.title }));

    remainingTasks = tasks
      .filter((t) => t.status !== 'done')
      .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority }));

    readyToSpawn = await getReadyTasks(epicId, cwd);
  }

  const total = completed + pending + active + blocked;
  const percentComplete = total > 0 ? Math.floor((completed * 100) / total) : 0;

  // Resume command
  let resumeCommand = '';
  if (sessionId) {
    resumeCommand = `cleo session resume ${sessionId}`;
  } else if (epicId) {
    resumeCommand = `cleo session start --scope epic:${epicId} --auto-start`;
  } else {
    resumeCommand = 'cleo session list  # Resume appropriate session';
  }

  return {
    timestamp: new Date().toISOString(),
    stopReason,
    session: {
      id: sessionId,
      epicId: epicId ?? null,
      focusedTask,
      progressNote,
    },
    progress: {
      completed,
      pending,
      active,
      blocked,
      total,
      percentComplete,
    },
    completedTasks,
    remainingTasks: remainingTasks.sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
    ),
    readyToSpawn,
    handoff: {
      resumeCommand,
      nextSteps: [
        `Run: ${resumeCommand}`,
        `Check progress: cleo list --parent ${epicId ?? '<epic-id>'}`,
        'Review dashboard: cleo dash',
      ],
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function priorityRank(priority?: string): number {
  switch (priority) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    default:
      return 3;
  }
}
