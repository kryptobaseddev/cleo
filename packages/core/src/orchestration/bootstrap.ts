/**
 * Bootstrap brain state loading for agent startup.
 * Calls other core modules directly (not engine functions).
 * @task T4784
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainState } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import {
  getReadinessDependencyBlockers,
  loadReadinessDependencyLookup,
} from '../tasks/dependency-check.js';

/**
 * Build startup state from selected project tasks and explicit dependency evidence.
 * @param projectRoot - Owning project root captured by the caller.
 * @param opts - Existing bootstrap speed and optional detail selection.
 * @param accessor - Optional canonical accessor bound to that project.
 * @returns Startup state with archive-excluded progress and unresolved dependency IDs.
 * @throws Error when task selection or required dependency evidence cannot be read.
 * @remarks Dependency-only archived rows satisfy readiness without expanding the
 * progress population. Stored blocked status is distinct from dependency state.
 * Existing optional session and auxiliary-file handling is unchanged.
 * @example
 * ```ts
 * const state = await buildBrainState(projectRoot, { speed: 'full' }, accessor);
 * ```
 */
export async function buildBrainState(
  projectRoot: string,
  opts?: { speed?: 'fast' | 'full' | 'complete' },
  accessor?: DataAccessor,
): Promise<BrainState> {
  const speed = opts?.speed || 'fast';
  const brain: BrainState = {
    _meta: {
      speed,
      generatedAt: new Date().toISOString(),
      version: '1.0.0',
    },
  };

  // --- Session (from SQLite, ADR-006/ADR-020) ---
  const acc = accessor ?? (await getTaskAccessor(projectRoot));
  try {
    const sessions = await acc.loadSessions();
    const activeSession = sessions.find((s) => s.status === 'active');
    if (activeSession) {
      brain.session = {
        id: activeSession.id,
        name: activeSession.name || activeSession.id,
        status: activeSession.status,
        startedAt: activeSession.startedAt,
      };
    }
  } catch {
    // skip
  }

  // --- Tasks & Progress ---
  const { tasks } = await acc.queryTasks({});

  brain.progress = {
    total: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    active: tasks.filter((t) => t.status === 'active').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    pending: tasks.filter((t) => t.status === 'pending').length,
  };

  // --- Current Task (from focus or session) ---
  const focus = await acc.getMetaValue<import('@cleocode/contracts').TaskWorkState>('focus_state');
  const focusTaskId = focus?.currentTask ?? null;
  if (focusTaskId) {
    const task = tasks.find((t) => t.id === focusTaskId);
    if (task) {
      brain.currentTask = { id: task.id, title: task.title, status: task.status };
    }
  }

  // --- Next Suggestion (simple: pick first pending task with all deps met) ---
  const dependencyLookup = await loadReadinessDependencyLookup(tasks, acc);
  const blockersByTask = new Map(
    tasks.map((task) => [task.id, getReadinessDependencyBlockers(task.depends, dependencyLookup)]),
  );
  const readyTasks = tasks.filter(
    (task) => task.status === 'pending' && blockersByTask.get(task.id)!.length === 0,
  );

  if (readyTasks.length > 0) {
    // Sort by priority
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    readyTasks.sort((a, b) => {
      const aPri = priorityOrder[a.priority ?? 'medium'] ?? 2;
      const bPri = priorityOrder[b.priority ?? 'medium'] ?? 2;
      return aPri - bPri;
    });
    const next = readyTasks[0]!;
    brain.nextSuggestion = { id: next.id, title: next.title, score: 1 };
  }

  // --- Full tier: decisions, blockers, contextDrift ---
  if (speed === 'full' || speed === 'complete') {
    // Blockers
    const blockedTasks = tasks.filter(
      (task) => task.status === 'blocked' || blockersByTask.get(task.id)!.length > 0,
    );
    brain.blockers = blockedTasks.slice(0, 10).map((b) => ({
      taskId: b.id,
      title: b.title,
      blockedBy: blockersByTask.get(b.id)!,
    }));

    // Recent decisions (from decision-log in .cleo)
    try {
      const decisionLogPath = join(projectRoot, '.cleo', 'decision-log.jsonl');
      if (existsSync(decisionLogPath)) {
        const content = readFileSync(decisionLogPath, 'utf-8').trim();
        if (content) {
          const entries = content
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          const recent = entries.slice(-5);
          brain.recentDecisions = recent.map((d: Record<string, unknown>) => ({
            id: (d.id as string) ?? '',
            decision: (d.decision as string) ?? '',
            timestamp: (d.timestamp as string) ?? '',
          }));
        }
      }
    } catch {
      // skip
    }

    // Context drift (from context state file)
    try {
      const contextStatePath = join(projectRoot, '.cleo', '.context-state.json');
      if (existsSync(contextStatePath)) {
        const state = JSON.parse(readFileSync(contextStatePath, 'utf-8'));
        const percentage = state.contextWindow?.percentage ?? 0;
        const factors: string[] = [];
        if (percentage > 80) factors.push('high_context_usage');
        if (percentage > 50) factors.push('moderate_context_usage');
        brain.contextDrift = { score: percentage, factors };
      }
    } catch {
      // skip
    }
  }

  return brain;
}
