/**
 * Bootstrap brain state loading for agent startup.
 * Calls other core modules directly (not engine functions).
 * @task T4784
 */

import { readJson } from '../../store/json.js';
import { getTaskPath, getSessionsPath } from '../paths.js';
import type { TaskFile } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import type { BrainState } from '../../types/operations/orchestrate.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Build brain state for agent bootstrapping. */
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

  // --- Session (from sessions.json) ---
  try {
    const sessionsPath = getSessionsPath(projectRoot);
    if (existsSync(sessionsPath)) {
      const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      const activeSession = (sessionsData.sessions ?? []).find(
        (s: { status: string }) => s.status === 'active',
      );
      if (activeSession) {
        brain.session = {
          id: activeSession.id,
          name: activeSession.name || activeSession.id,
          status: activeSession.status,
          startedAt: activeSession.startedAt,
        };
      }
    }
  } catch {
    // skip
  }

  // --- Tasks & Progress ---
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJson<TaskFile>(getTaskPath(projectRoot));

  const tasks = data?.tasks ?? [];
  brain.progress = {
    total: tasks.length,
    done: tasks.filter(t => t.status === 'done').length,
    active: tasks.filter(t => t.status === 'active').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
    pending: tasks.filter(t => t.status === 'pending').length,
  };

  // --- Current Task (from focus or session) ---
  const focusTaskId = data?.focus?.currentTask ?? null;
  if (focusTaskId) {
    const task = tasks.find(t => t.id === focusTaskId);
    if (task) {
      brain.currentTask = { id: task.id, title: task.title, status: task.status };
    }
  }

  // --- Next Suggestion (simple: pick first pending task with all deps met) ---
  const completedIds = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));
  const readyTasks = tasks.filter(t => {
    if (t.status !== 'pending') return false;
    const deps = t.depends ?? [];
    return deps.every(d => completedIds.has(d));
  });

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
    const blockedTasks = tasks.filter(t => t.status === 'blocked' || (
      t.depends && t.depends.some(d => !completedIds.has(d))
    ));
    brain.blockers = blockedTasks.slice(0, 10).map(b => ({
      taskId: b.id,
      title: b.title,
      blockedBy: b.depends || [],
    }));

    // Recent decisions (from decision-log in .cleo)
    try {
      const decisionLogPath = join(projectRoot, '.cleo', 'decision-log.jsonl');
      if (existsSync(decisionLogPath)) {
        const content = readFileSync(decisionLogPath, 'utf-8').trim();
        if (content) {
          const entries = content.split('\n').filter(l => l.trim()).map(l => {
            try { return JSON.parse(l); } catch { return null; }
          }).filter(Boolean);
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
