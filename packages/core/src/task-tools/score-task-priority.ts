/**
 * scoreTask — THE task ranker (T12661, tiered per council verdict D11161 / T12691).
 *
 * Pure functional — no I/O, no DB access, no async.
 *
 * `cleo next`, the briefing's `nextTasks` and both `cleo analyze` paths rank
 * through this module. The order is LEXICOGRAPHIC, never an additive sum:
 *
 * 1. **Priority band** — the owner's priority: critical > high > medium > low.
 * 2. **Severity** — attested severity: P0 > P1 > P2 > P3 > unknown. An unset
 *    severity is `unknown`; nothing is imputed (not even for a bug).
 * 3. **Bounded tiebreak** — computed graph facts: dependencies ready (+10),
 *    phase alignment (+20), leverage (+5 per open dependent, capped at +20),
 *    anti-starvation age (+1 per week after the first, capped at +10).
 * 4. **createdAt** — older first (parsed and normalised to UTC).
 * 5. **id**.
 *
 * Computed signals therefore never cross a band: a plain ready critical task
 * always outranks a low-priority P0 bug carrying every bonus. The additive
 * scorer this replaces let that bug win 115 to 110. BRAIN success/failure
 * patterns are informational factors only; they are not part of the order.
 *
 * @arch SDK Tool (Category B) — pure, no side effects, contracts-typed
 * @task T10068
 * @task T12661
 * @task T12691
 * @epic T9835
 */

import type {
  ScoreFactor,
  ScoreTaskContext,
  ScoreTaskInput,
  ScoreTaskKey,
  ScoreTaskResult,
  TaskSeverity,
} from '@cleocode/contracts';
import { isReadinessDependencySatisfied } from '../tasks/dependency-check.js';

/** Tier 1 — owner priority band rank (higher first). */
export const PRIORITY_BAND: Readonly<Record<string, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Tier 2 — attested severity rank (higher first); `unknown` is 0. */
export const SEVERITY_RANK: Readonly<Record<TaskSeverity, number>> = {
  P0: 4,
  P1: 3,
  P2: 2,
  P3: 1,
};

/** Tier 3 — bonus when every dependency is satisfied. */
export const DEPS_READY_SCORE = 10;

/** Tier 3 — bonus when the task's phase matches the current phase. */
export const PHASE_ALIGNMENT_SCORE = 20;

/** Tier 3 — bonus per open task this task unblocks. */
export const LEVERAGE_PER_DEPENDENT = 5;

/** Tier 3 — cap on the leverage bonus. */
export const MAX_LEVERAGE_SCORE = 20;

/** Tier 3 — cap on the anti-starvation age bonus (+1 per week after the first). */
export const MAX_AGE_SCORE = 10;

/** Weights that fold the key into one sortable number (tiebreak stays below 1000). */
const BAND_WEIGHT = 10000;
const SEVERITY_WEIGHT = 1000;

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
 * Score a single task: its lexicographic key, every factor tagged with its
 * comparator tier, and the key folded into one number that sorts identically.
 *
 * @param task - Task to score
 * @param ctx - Scoring context (phase, dep statuses, leverage, `nowMs`, patterns)
 * @returns Score, key and factors
 *
 * @example
 * ```typescript
 * scoreTask({ id: 'T1', title: 'Auth', priority: 'high', kind: 'bug' }, {}).key;
 * // { band: 3, severity: 0, tiebreak: 10 } — severity unknown, deps ready
 * ```
 */
export function scoreTask(task: ScoreTaskInput, ctx: ScoreTaskContext): ScoreTaskResult {
  const factors: ScoreFactor[] = [];

  const priority = task.priority ?? 'medium';
  // Own-property lookups only: an unvalidated value such as `toString` must
  // fall back, never yield a prototype member (which would fold to NaN).
  const band = Object.hasOwn(PRIORITY_BAND, priority)
    ? PRIORITY_BAND[priority]!
    : PRIORITY_BAND['medium']!;
  factors.push({
    name: 'band',
    delta: band * BAND_WEIGHT,
    detail: `priority ${priority}`,
    tier: 1,
  });

  const severity =
    task.severity && Object.hasOwn(SEVERITY_RANK, task.severity) ? SEVERITY_RANK[task.severity] : 0;
  factors.push({
    name: 'severity',
    delta: severity * SEVERITY_WEIGHT,
    detail: task.severity ?? 'unknown (not set)',
    tier: 2,
  });

  let tiebreak = 0;
  const bonus = (name: string, delta: number, detail: string): void => {
    tiebreak += delta;
    factors.push({ name, delta, detail, tier: 3 });
  };
  if (areDepsReady(task.depends, ctx.taskStatuses)) {
    bonus('depsReady', DEPS_READY_SCORE, 'all dependencies satisfied');
  }
  if (ctx.currentPhase && task.phase === ctx.currentPhase) {
    bonus('phaseAlignment', PHASE_ALIGNMENT_SCORE, `matches current phase "${ctx.currentPhase}"`);
  }
  const dependents = ctx.leverage?.get(task.id) ?? 0;
  if (dependents > 0) {
    bonus(
      'leverage',
      Math.min(MAX_LEVERAGE_SCORE, dependents * LEVERAGE_PER_DEPENDENT),
      `unblocks ${dependents} open task(s) (capped at +${MAX_LEVERAGE_SCORE})`,
    );
  }
  if (task.createdAt) {
    const nowMs = ctx.nowMs ?? Date.now();
    const ageDays = (nowMs - parseTimestampMs(task.createdAt)) / (1000 * 60 * 60 * 24);
    if (ageDays > 7) {
      bonus(
        'age',
        Math.min(MAX_AGE_SCORE, Math.floor(ageDays / 7)),
        `anti-starvation: ${Math.floor(ageDays)} days old (capped at +${MAX_AGE_SCORE})`,
      );
    }
  }

  // BRAIN patterns: informational only — not part of the order (D11161).
  if (ctx.successPatterns?.length || ctx.failurePatterns?.length) {
    const matchText = [task.title, ...(task.labels ?? [])].join(' ').toLowerCase();
    const success = ctx.successPatterns?.find((p) => matchText.includes(p.pattern.toLowerCase()));
    if (success)
      factors.push({
        name: 'brainSuccess',
        delta: 0,
        detail: `success pattern "${success.pattern}"`,
        tier: null,
      });
    const failure = ctx.failurePatterns?.find((p) => matchText.includes(p.pattern.toLowerCase()));
    if (failure)
      factors.push({
        name: 'brainFailure',
        delta: 0,
        detail: `failure pattern "${failure.pattern}"`,
        tier: null,
      });
  }

  const key: ScoreTaskKey = { band, severity, tiebreak };
  return { score: band * BAND_WEIGHT + severity * SEVERITY_WEIGHT + tiebreak, factors, key };
}

/**
 * Render one factor as an `--explain` line naming its comparator tier.
 *
 * @param factor - Scored factor.
 * @returns e.g. `tier 1 band: priority high`, `tier 3 depsReady: all dependencies satisfied (+10)`,
 *   or `info brainSuccess: … (not in the order)`.
 */
export function formatScoreFactor(factor: ScoreFactor): string {
  if (factor.tier === null) return `info ${factor.name}: ${factor.detail} (not in the order)`;
  if (factor.tier === 1 || factor.tier === 2)
    return `tier ${factor.tier} ${factor.name}: ${factor.detail}`;
  const sign = factor.delta >= 0 ? '+' : '';
  return `tier 3 ${factor.name}: ${factor.detail} (${sign}${factor.delta})`;
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

/** A task with its score, key and factors, as {@link rankTasks} returns it. */
export interface RankedTask<T extends ScoreTaskInput> {
  /** The task. */
  task: T;
  /** The key folded into one sortable number. */
  score: number;
  /** Every factor, tagged with its comparator tier. */
  factors: ScoreFactor[];
  /** The lexicographic key. */
  key?: ScoreTaskKey;
}

/**
 * Order tasks by the tiered key: band, severity, tiebreak (all higher first),
 * then older `createdAt` (parsed, UTC), then id — deterministic, so every
 * ranker returns the same order for the same input.
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
  const zero: ScoreTaskKey = { band: 0, severity: 0, tiebreak: 0 };
  return tasks
    .map((task) => ({ task, ...scoreTask(task, ctx), createdMs: created(task) }))
    .sort((a, b) => {
      const ka = a.key ?? zero;
      const kb = b.key ?? zero;
      return (
        kb.band - ka.band ||
        kb.severity - ka.severity ||
        kb.tiebreak - ka.tiebreak ||
        (a.createdMs === b.createdMs ? 0 : a.createdMs < b.createdMs ? -1 : 1) ||
        a.task.id.localeCompare(b.task.id)
      );
    })
    .map(({ createdMs: _createdMs, ...rest }) => rest);
}

/**
 * Build the {@link ScoreTaskContext} every ordering surface shares (T12692):
 * dependency statuses from the canonical readiness lookup, leverage over the
 * population, the ranking phase and one clock instant. `cleo next`,
 * `cleo orchestrate ready`, the focus ready wave and the wave listing all
 * build their context here, so the same tasks rank the same way everywhere.
 *
 * @param population - Tasks whose open dependents count as leverage.
 * @param dependencyLookup - Canonical dependency records (archived included).
 * @param opts - Ranking phase and optional clock.
 * @returns The scoring context.
 * @task T12692
 */
export function buildRankingContext(
  population: Iterable<{ depends?: string[]; status?: string }>,
  dependencyLookup: ReadonlyMap<string, { id: string; status: string }>,
  opts: { currentPhase: string | null; nowMs?: number },
): ScoreTaskContext & { leverage: ReadonlyMap<string, number> } {
  return {
    currentPhase: opts.currentPhase,
    nowMs: opts.nowMs ?? Date.now(),
    taskStatuses: new Map(
      [...dependencyLookup.values()].map((task) => [task.id, task.status] as const),
    ),
    leverage: computeLeverage([...population]),
  };
}

/**
 * Reorder items by THE comparator ({@link rankTasks}, D11161): band,
 * severity, bounded tiebreak, createdAt, id. Items whose task record is not
 * in `tasksById` keep their input order after every ranked item.
 *
 * @param items - Items to order (not mutated).
 * @param idOf - Task id of an item.
 * @param tasksById - Task records to rank the items by.
 * @param ctx - Shared scoring context (see {@link buildRankingContext}).
 * @returns A new array in ranked order.
 * @task T12692
 */
export function orderByRanking<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  tasksById: ReadonlyMap<string, ScoreTaskInput>,
  ctx: ScoreTaskContext,
): T[] {
  const known: ScoreTaskInput[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = idOf(item);
    const task = tasksById.get(id);
    if (task && !seen.has(id)) {
      seen.add(id);
      known.push(task);
    }
  }
  const position = new Map(rankTasks(known, ctx).map((r, index) => [r.task.id, index] as const));
  const rank = (item: T): number => position.get(idOf(item)) ?? Number.POSITIVE_INFINITY;
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank < b.rank ? -1 : 1))
    .map(({ item }) => item);
}
