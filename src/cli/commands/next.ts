/**
 * CLI next command - suggest next task to work on.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { readJson } from '../../store/json.js';
import { getTodoPath } from '../../core/paths.js';
import type { Task, TodoFile } from '../../types/task.js';

const PRIORITY_SCORE: Record<string, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

interface ScoredTask {
  task: Task;
  score: number;
  reasons: string[];
}

/**
 * Check if all dependencies of a task are satisfied (done/cancelled).
 */
function depsReady(task: Task, taskMap: Map<string, Task>): boolean {
  if (!task.depends || task.depends.length === 0) return true;
  return task.depends.every((depId) => {
    const dep = taskMap.get(depId);
    return dep && (dep.status === 'done' || dep.status === 'cancelled');
  });
}

/**
 * Score a task for suggestion ranking.
 */
function scoreTask(task: Task, currentPhase: string | null | undefined, taskMap: Map<string, Task>): ScoredTask {
  const reasons: string[] = [];
  let score = 0;

  // Priority score
  score += PRIORITY_SCORE[task.priority] ?? 50;
  reasons.push(`priority: ${task.priority} (+${PRIORITY_SCORE[task.priority] ?? 50})`);

  // Phase alignment bonus
  if (currentPhase && task.phase === currentPhase) {
    score += 20;
    reasons.push(`phase alignment: ${currentPhase} (+20)`);
  }

  // Dependencies ready bonus
  if (depsReady(task, taskMap)) {
    score += 10;
    reasons.push('all dependencies satisfied (+10)');
  }

  // Age bonus (older tasks get slight priority)
  if (task.createdAt) {
    const ageMs = Date.now() - new Date(task.createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > 7) {
      score += Math.min(15, Math.floor(ageDays / 7));
      reasons.push(`age: ${Math.floor(ageDays)} days (+${Math.min(15, Math.floor(ageDays / 7))})`);
    }
  }

  return { task, score, reasons };
}

export function registerNextCommand(program: Command): void {
  program
    .command('next')
    .description('Suggest next task to work on based on priority and dependencies')
    .option('--explain', 'Show detailed reasoning for suggestion')
    .option('-n, --count <n>', 'Show top N suggestions', '1')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const todoPath = getTodoPath();
        const data = await readJson<TodoFile>(todoPath);
        if (!data) {
          throw new CleoError(ExitCode.NOT_FOUND, 'No todo.json found. Run: cleo init');
        }

        const taskMap = new Map(data.tasks.map((t) => [t.id, t]));
        const currentPhase = data.project?.currentPhase;

        // Filter candidates: pending, not blocked, deps ready
        const candidates = data.tasks.filter((t) =>
          t.status === 'pending' &&
          depsReady(t, taskMap),
        );

        if (candidates.length === 0) {
          console.log(formatSuccess({
            suggestion: null,
            reason: 'No pending tasks with satisfied dependencies',
          }));
          process.exit(ExitCode.NO_DATA);
          return;
        }

        // Score and sort
        const scored = candidates
          .map((t) => scoreTask(t, currentPhase, taskMap))
          .sort((a, b) => b.score - a.score);

        const count = Math.min(parseInt(opts['count'] as string, 10) || 1, scored.length);
        const suggestions = scored.slice(0, count);

        const explain = !!opts['explain'];

        if (count === 1) {
          const { task, score, reasons } = suggestions[0]!;
          console.log(formatSuccess({
            suggestion: {
              id: task.id,
              title: task.title,
              priority: task.priority,
              phase: task.phase ?? null,
              score,
              ...(explain && { reasons }),
            },
            totalCandidates: candidates.length,
          }));
        } else {
          console.log(formatSuccess({
            suggestions: suggestions.map(({ task, score, reasons }) => ({
              id: task.id,
              title: task.title,
              priority: task.priority,
              phase: task.phase ?? null,
              score,
              ...(explain && { reasons }),
            })),
            totalCandidates: candidates.length,
          }));
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
