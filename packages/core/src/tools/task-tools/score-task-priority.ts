/**
 * scoreTask — pure-functional task priority scorer.
 *
 * Computes a numeric score for a task given its attributes and project context.
 * Pure functional — no I/O, no DB access, no async.
 *
 * @arch SDK Tool (Category B) — pure, no side effects, contracts-typed
 * @task T10068
 * @epic T9835
 */

import type {
  ScoreFactor,
  ScoreTaskContext,
  ScoreTaskInput,
  ScoreTaskResult,
} from '@cleocode/contracts';

const PRIORITY_SCORE: Record<string, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

const SATISFIED_STATUSES = new Set<string>(['done', 'cancelled']);

function areDepsReady(
  depends: string[] | undefined,
  taskStatuses: Map<string, string> | undefined,
): boolean {
  if (!depends?.length) return true;
  if (!taskStatuses) return false;
  return depends.every((depId) => {
    const status = taskStatuses.get(depId);
    return status !== undefined && SATISFIED_STATUSES.has(status);
  });
}

/**
 * Compute a priority score for a single task.
 *
 * Scoring formula:
 * - **Priority** (+25/+50/+75/+100 depending on level)
 * - **Phase alignment** (+20 when task phase matches `ctx.currentPhase`)
 * - **Dependency readiness** (+10 when all deps are done/cancelled)
 * - **Age bonus** (+1 per week over 7 days, capped at +15)
 * - **Brain success pattern** (+10 for first matching success pattern)
 * - **Brain failure pattern** (-5 for first matching failure pattern)
 *
 * @param task - Task to score
 * @param ctx - Scoring context (phase, dep statuses, patterns)
 * @returns Score and individual factors
 *
 * @example
 * ```typescript
 * const result = scoreTask(
 *   { id: 'T1', title: 'Auth', priority: 'high', phase: 'v2', depends: ['T0'] },
 *   { currentPhase: 'v2', taskStatuses: new Map([['T0', 'done']]) },
 * );
 * // result.score === 75 (priority) + 20 (phase) + 10 (deps) = 105
 * ```
 */
export function scoreTask(task: ScoreTaskInput, ctx: ScoreTaskContext): ScoreTaskResult {
  const factors: ScoreFactor[] = [];
  let score = 0;

  // Priority
  const priorityDelta = PRIORITY_SCORE[task.priority] ?? 50;
  score += priorityDelta;
  factors.push({ name: 'priority', delta: priorityDelta, detail: `${task.priority}` });

  // Phase alignment
  if (ctx.currentPhase && task.phase === ctx.currentPhase) {
    score += 20;
    factors.push({
      name: 'phaseAlignment',
      delta: 20,
      detail: `matches current phase "${ctx.currentPhase}"`,
    });
  }

  // Dependency readiness
  if (areDepsReady(task.depends, ctx.taskStatuses)) {
    score += 10;
    factors.push({ name: 'depsReady', delta: 10, detail: 'all dependencies satisfied' });
  }

  // Age bonus
  if (task.createdAt) {
    const nowMs = ctx.nowMs ?? Date.now();
    const ageMs = nowMs - new Date(task.createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > 7) {
      const ageBonus = Math.min(15, Math.floor(ageDays / 7));
      score += ageBonus;
      factors.push({
        name: 'age',
        delta: ageBonus,
        detail: `${Math.floor(ageDays)} days old`,
      });
    }
  }

  // Brain pattern scoring
  if (ctx.successPatterns?.length || ctx.failurePatterns?.length) {
    const titleLower = task.title.toLowerCase();
    const labels = (task.labels ?? []).map((l) => l.toLowerCase());
    const matchText = [titleLower, ...labels].join(' ');

    for (const sp of ctx.successPatterns ?? []) {
      if (matchText.includes(sp.pattern.toLowerCase())) {
        score += 10;
        factors.push({
          name: 'brainSuccess',
          delta: 10,
          detail: `success pattern "${sp.pattern}"`,
        });
        break;
      }
    }

    for (const fp of ctx.failurePatterns ?? []) {
      if (matchText.includes(fp.pattern.toLowerCase())) {
        score -= 5;
        factors.push({
          name: 'brainFailure',
          delta: -5,
          detail: `failure pattern "${fp.pattern}"`,
        });
        break;
      }
    }
  }

  return { score, factors };
}
