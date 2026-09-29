/**
 * scoreTask — THE task priority scorer (T12661).
 *
 * Computes a numeric score for a task given its attributes and project context.
 * Pure functional — no I/O, no DB access, no async.
 *
 * Every ranker ranks through this module: `cleo next` (`coreTaskNext`), the
 * briefing's `nextTasks`, and `cleo analyze`. Before T12661 each kept its own
 * weights, so the three disagreed on the same store, and a fresh P1-grade bug
 * with no severity set ranked 136th of 385 behind 90-day-old medium features.
 *
 * @arch SDK Tool (Category B) — pure, no side effects, contracts-typed
 * @task T10068
 * @task T12661
 * @epic T9835
 */

import type {
  ScoreFactor,
  ScoreTaskContext,
  ScoreTaskInput,
  ScoreTaskResult,
  TaskSeverity,
} from '@cleocode/contracts';
import { isReadinessDependencySatisfied } from '../tasks/dependency-check.js';

/** Priority weight — the dominant axis. */
export const PRIORITY_SCORE: Readonly<Record<string, number>> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

/**
 * Severity weight, orthogonal to priority (T9905). Conservative, so
 * `priority='critical'` still wins ties, but a P0/P1 row decisively outranks
 * any `priority='medium'` peer with no severity set.
 */
export const SEVERITY_SCORE: Readonly<Record<TaskSeverity, number>> = {
  P0: 30,
  P1: 15,
  P2: 10,
  P3: 5,
};

/**
 * Severity a `kind=bug` task is scored at when no severity was set (T12661).
 * Severity is owner-set and often missing on a freshly filed bug; scoring it
 * as zero let old features bury it.
 */
export const DEFAULT_BUG_SEVERITY: TaskSeverity = 'P2';

/** Bonus when the task's phase matches the current phase. */
export const PHASE_ALIGNMENT_SCORE = 20;

/** Bonus when every dependency is satisfied. */
export const DEPS_READY_SCORE = 10;

/** Bonus per open task this task unblocks. */
export const LEVERAGE_PER_DEPENDENT = 5;

/** Cap on the leverage bonus, so a hub task cannot outrank urgent work on fan-out alone. */
export const MAX_LEVERAGE_SCORE = 20;

/**
 * Cap on the anti-starvation age bonus (+1 per week after the first). Bounded
 * so age only breaks near-ties: a fresh high-priority bug always outranks an
 * old medium task (T12661).
 */
export const MAX_AGE_SCORE = 10;

/**
 * Parse a task timestamp to epoch milliseconds, normalised to UTC.
 *
 * Stores hold both ISO-8601 with a zone (`2026-09-01T10:00:00Z`) and SQLite's
 * zone-less `YYYY-MM-DD HH:MM:SS`. `Date.parse` reads the zone-less form as
 * LOCAL time, so the same instant scored and sorted differently by machine
 * (T12661 review). A timestamp without a zone is taken as UTC.
 *
 * @param value - Timestamp text.
 * @returns Epoch milliseconds, or `NaN` when unparseable.
 */
export function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const text = value.trim();
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  if (hasZone || !/\d{2}:\d{2}/.test(text)) return Date.parse(text);
  return Date.parse(`${text.replace(' ', 'T')}Z`);
}

/**
 * Whether every dependency of a task is satisfied, under the same readiness
 * policy as `depsReady` (cancelled work still blocks).
 */
function areDepsReady(
  depends: string[] | undefined,
  taskStatuses: Map<string, string> | undefined,
): boolean {
  if (!depends?.length) return true;
  if (!taskStatuses) return false;
  return depends.every((depId) => isReadinessDependencySatisfied(taskStatuses.get(depId)));
}

/**
 * Compute a priority score for a single task.
 *
 * Every factor is reported in `factors` (the `--explain` output):
 * - **priority** — critical 100, high 75, medium 50, low 25
 * - **severity** — P0 +30, P1 +15, P2 +10, P3 +5; a `kind=bug` task with no
 *   severity is scored at {@link DEFAULT_BUG_SEVERITY}
 * - **phaseAlignment** — +20 when the phase matches `ctx.currentPhase`
 * - **depsReady** — +10 when every dependency is satisfied
 * - **leverage** — +5 per open dependent, capped at +20
 * - **age** — anti-starvation, +1 per week after the first, capped at +10
 * - **brainSuccess / brainFailure** — +10 / -5 for the first matching pattern
 *
 * @param task - Task to score
 * @param ctx - Scoring context (phase, dep statuses, leverage, patterns)
 * @returns Score and individual factors
 *
 * @example
 * ```typescript
 * const result = scoreTask({ id: 'T1', title: 'Auth', priority: 'high', kind: 'bug' }, {});
 * // result.score === 75 (priority) + 10 (bug at default P2) + 10 (deps) = 95
 * ```
 */
export function scoreTask(task: ScoreTaskInput, ctx: ScoreTaskContext): ScoreTaskResult {
  const factors: ScoreFactor[] = [];
  let score = 0;
  const add = (name: string, delta: number, detail: string): void => {
    score += delta;
    factors.push({ name, delta, detail });
  };

  const priority = task.priority ?? 'medium';
  add('priority', PRIORITY_SCORE[priority] ?? 50, priority);

  if (task.severity) {
    add('severity', SEVERITY_SCORE[task.severity] ?? 0, task.severity);
  } else if (task.kind === 'bug') {
    add(
      'severity',
      SEVERITY_SCORE[DEFAULT_BUG_SEVERITY],
      `kind=bug with no severity, scored as ${DEFAULT_BUG_SEVERITY}`,
    );
  }

  if (ctx.currentPhase && task.phase === ctx.currentPhase) {
    add('phaseAlignment', PHASE_ALIGNMENT_SCORE, `matches current phase "${ctx.currentPhase}"`);
  }

  if (areDepsReady(task.depends, ctx.taskStatuses)) {
    add('depsReady', DEPS_READY_SCORE, 'all dependencies satisfied');
  }

  const dependents = ctx.leverage?.get(task.id) ?? 0;
  if (dependents > 0) {
    add(
      'leverage',
      Math.min(MAX_LEVERAGE_SCORE, dependents * LEVERAGE_PER_DEPENDENT),
      `unblocks ${dependents} open task(s) (capped at +${MAX_LEVERAGE_SCORE})`,
    );
  }

  if (task.createdAt) {
    const nowMs = ctx.nowMs ?? Date.now();
    const ageDays = (nowMs - parseTimestampMs(task.createdAt)) / (1000 * 60 * 60 * 24);
    if (ageDays > 7) {
      add(
        'age',
        Math.min(MAX_AGE_SCORE, Math.floor(ageDays / 7)),
        `anti-starvation: ${Math.floor(ageDays)} days old (capped at +${MAX_AGE_SCORE})`,
      );
    }
  }

  if (ctx.successPatterns?.length || ctx.failurePatterns?.length) {
    const matchText = [task.title, ...(task.labels ?? [])].join(' ').toLowerCase();
    const success = ctx.successPatterns?.find((p) => matchText.includes(p.pattern.toLowerCase()));
    if (success) add('brainSuccess', 10, `success pattern "${success.pattern}"`);
    const failure = ctx.failurePatterns?.find((p) => matchText.includes(p.pattern.toLowerCase()));
    if (failure) add('brainFailure', -5, `failure pattern "${failure.pattern}"`);
  }

  return { score, factors };
}

/**
 * Render one factor as an `--explain` reason line.
 *
 * @param factor - Scored factor.
 * @returns e.g. `severity: kind=bug with no severity, scored as P2 (+10)`.
 */
export function formatScoreFactor(factor: ScoreFactor): string {
  const sign = factor.delta >= 0 ? '+' : '';
  return `${factor.name}: ${factor.detail} (${sign}${factor.delta})`;
}

/**
 * Count, for every task id, the OPEN tasks that depend on it — the leverage
 * input of {@link scoreTask}. Done, archived and cancelled dependents are not
 * work this task unblocks.
 *
 * @param tasks - Tasks with `depends` and `status`.
 * @returns Map of task id to number of open dependents.
 */
export function computeLeverage(
  tasks: ReadonlyArray<{ depends?: string[]; status?: string }>,
): Map<string, number> {
  const leverage = new Map<string, number>();
  for (const task of tasks) {
    if (isReadinessDependencySatisfied(task.status) || task.status === 'cancelled') continue;
    for (const dep of task.depends ?? []) leverage.set(dep, (leverage.get(dep) ?? 0) + 1);
  }
  return leverage;
}

/** A task with its score and factors, as {@link rankTasks} returns it. */
export interface RankedTask<T extends ScoreTaskInput> {
  /** The task. */
  task: T;
  /** Final score. */
  score: number;
  /** Every contributing factor. */
  factors: ScoreFactor[];
}

/**
 * Score and order tasks: highest score first, ties broken by older
 * `createdAt` (parsed and normalised to UTC by {@link parseTimestampMs}), then
 * id — deterministic, so every ranker returns the same order for the same input.
 *
 * @param tasks - Candidate tasks.
 * @param ctx - Shared scoring context.
 * @returns Ranked tasks.
 */
export function rankTasks<T extends ScoreTaskInput>(
  tasks: readonly T[],
  ctx: ScoreTaskContext,
): RankedTask<T>[] {
  // Missing or unparseable timestamps sort after every dated task.
  const created = (task: T): number => {
    const ms = parseTimestampMs(task.createdAt);
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  };
  return tasks
    .map((task) => ({ task, ...scoreTask(task, ctx), createdMs: created(task) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.createdMs === b.createdMs ? 0 : a.createdMs < b.createdMs ? -1 : 1) ||
        a.task.id.localeCompare(b.task.id),
    )
    .map(({ createdMs: _createdMs, ...rest }) => rest);
}
