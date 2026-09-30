/**
 * Next-task selection logic — coreTaskNext.
 * @task T10064
 * @epic T9834
 */

import type { ProjectMeta, ScoreTaskContext, Task } from '@cleocode/contracts';
import { readFocusState, resolveFocusSessionId } from '../sessions/focus-state-store.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import {
  buildRankingContext,
  formatScoreFactor,
  type RankedTask,
  rankTasks,
} from '../task-tools/score-task-priority.js';
import { loadReadinessDependencyLookup } from './dependency-check.js';
import { depsReady } from './deps-ready.js';

/**
 * Suggest next task to work on based on priority, phase, age, and deps.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param params - Optional scoring configuration
 * @param params.count - Number of suggestions to return (default: 1)
 * @param params.explain - When true, include scoring reasons in each suggestion
 * @param params.brain - Brain pattern scoring (default true). A one-line
 *   "next ready task" hint (stale `cleo current`, a completion's
 *   `nextSuggested`) passes false: no brain store is opened (T12689).
 * @returns Ranked suggestions with scores and the total number of eligible candidates
 *
 * @remarks
 * Ranks through the shared {@link scoreTask} (via {@link rankReadyTasks}):
 * the lexicographic D11161 key — priority band, then attested severity (an
 * unset severity is unknown; nothing is imputed from `kind`), then a bounded
 * tiebreak (dependency readiness, phase alignment, leverage, age), then
 * `createdAt`, then id. BRAIN patterns are informational factors only.
 * `explain` returns every factor. The briefing's `nextTasks` uses the same ranking (T12661).
 * Candidates retain the active query population; a separate canonical lookup
 * resolves explicit dependencies, including archived records. Missing/cancelled
 * prerequisites block selection, and required dependency-read failures propagate.
 *
 * @throws Error when required task or dependency evidence cannot be read.
 *
 * @example
 * ```typescript
 * const { suggestions } = await coreTaskNext('/project', { count: 3, explain: true });
 * console.log(suggestions[0].id, suggestions[0].score);
 * ```
 *
 * @task T4790
 */
export async function coreTaskNext(
  projectRoot: string,
  params?: { count?: number; explain?: boolean; brain?: boolean },
): Promise<{
  suggestions: Array<{
    id: string;
    title: string;
    priority: string;
    phase: string | null;
    score: number;
    reasons?: string[];
  }>;
  totalCandidates: number;
}> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks: allTasks } = await accessor.queryTasks({});
  const { ranked, totalCandidates } = await rankReadyTasks(accessor, allTasks, {
    currentPhase: await resolveRankingPhase(accessor, projectRoot),
    // T12689: a one-line hint (`brain: false`) opens no brain store.
    ...(params?.brain !== false && { projectRoot }),
  });

  const count = Math.min(params?.count || 1, ranked.length);
  const explain = params?.explain ?? false;

  const suggestions = ranked.slice(0, count).map(({ task, score, factors }) => ({
    id: task.id,
    title: task.title,
    priority: task.priority,
    phase: task.phase ?? null,
    score,
    ...(explain && { reasons: factors.map(formatScoreFactor) }),
  }));

  return { suggestions, totalCandidates };
}

/**
 * The phase that earns the phase-alignment bonus: the caller's session focus
 * phase, else the project's current phase. `cleo next` and the briefing both
 * resolve it here so they rank identically (T12661).
 *
 * @param accessor - Task data accessor.
 * @returns The phase slug, or null.
 * @task T12661
 */
export async function resolveRankingPhase(
  accessor: DataAccessor,
  cwd?: string,
): Promise<string | null> {
  // Only the focus PHASE is read here, never the task pointer, so the stale-
  // pointer check in readLiveFocus (and its task load) does not apply.
  const focus = await readFocusState(accessor, await resolveFocusSessionId(cwd));
  if (focus?.currentPhase) return focus.currentPhase;
  const projectMeta = await accessor.getMetaValue<ProjectMeta>('project_meta');
  return projectMeta?.currentPhase ?? null;
}

/**
 * Rank every READY task — pending, not cancelled, all dependencies satisfied
 * under the canonical lookup (archived dependencies included) — through the
 * shared {@link scoreTask}. The single ranking behind `cleo next` and the
 * briefing's `nextTasks` (T12661).
 *
 * @param accessor - Task data accessor (for dependency records outside `allTasks`).
 * @param allTasks - The active task population.
 * @param opts - Current phase, optional id scope, `nowMs`, and `projectRoot`
 *   to attach BRAIN success/failure patterns as informational factors
 *   (best-effort; they are not part of the order).
 * @returns Ranked candidates, how many there were, and the leverage map used.
 * @task T12661
 */
export async function rankReadyTasks(
  accessor: DataAccessor,
  allTasks: readonly Task[],
  opts: {
    currentPhase: string | null;
    scopeTaskIds?: ReadonlySet<string>;
    projectRoot?: string;
    /** Clock for the age tiebreak; one instant for the whole ranking. */
    nowMs?: number;
  },
): Promise<{
  ranked: RankedTask<Task>[];
  totalCandidates: number;
  leverage: ReadonlyMap<string, number>;
}> {
  const dependencyLookup = await loadReadinessDependencyLookup(allTasks, accessor);
  const candidates = allTasks.filter(
    (t) =>
      t.status === 'pending' &&
      !t.cancelledAt &&
      (!opts.scopeTaskIds || opts.scopeTaskIds.has(t.id)) &&
      depsReady(t.depends, dependencyLookup),
  );
  const ctx = buildRankingContext(allTasks, dependencyLookup, {
    currentPhase: opts.currentPhase,
    nowMs: opts.nowMs,
  });
  const { leverage } = ctx;
  if (candidates.length === 0) return { ranked: [], totalCandidates: 0, leverage };

  if (opts.projectRoot) {
    try {
      const { searchPatterns } = await import('../memory/patterns.js');
      const [success, failure] = await Promise.all([
        searchPatterns(opts.projectRoot, { type: 'success', limit: 20 }),
        searchPatterns(opts.projectRoot, { type: 'failure', limit: 20 }),
      ]);
      ctx.successPatterns = success;
      ctx.failurePatterns = failure;
    } catch {
      // Brain pattern scoring is best-effort
    }
  }
  return { ranked: rankTasks(candidates, ctx), totalCandidates: candidates.length, leverage };
}

/**
 * The ranking context of the live project (T12692): the SAME context
 * {@link rankReadyTasks} ranks `cleo next` with — dependency statuses from the
 * canonical lookup, leverage over the active population and the ranking phase
 * from {@link resolveRankingPhase}. `cleo orchestrate ready` (and so the focus
 * ready wave), `cleo orchestrate next`, the wave listing, the bootstrap
 * suggestion, `cleo plan` and the handoff build theirs here, so one fixture
 * ranks identically on every surface.
 *
 * @param accessor - Task data accessor.
 * @param population - The active task population (`queryTasks({})`); loaded when omitted.
 * @param opts - Optional phase override, clock, and the project root whose
 *   caller's focus phase ranks (T12501: always pass it — without it the focus
 *   session is resolved from the process cwd, which in a git worktree is the
 *   main checkout).
 * @returns The scoring context and the dependency lookup it was built from.
 * @task T12692
 */
export async function loadRankingContext(
  accessor: DataAccessor,
  population?: readonly Task[],
  opts?: { currentPhase?: string | null; nowMs?: number; cwd?: string },
): Promise<{
  ctx: ScoreTaskContext;
  dependencyLookup: Map<string, Task>;
  population: readonly Task[];
}> {
  const tasks = population ?? (await accessor.queryTasks({})).tasks;
  const dependencyLookup = await loadReadinessDependencyLookup(tasks, accessor);
  const currentPhase =
    opts?.currentPhase !== undefined
      ? opts.currentPhase
      : await resolveRankingPhase(accessor, opts?.cwd);
  const ctx = buildRankingContext(tasks, dependencyLookup, { currentPhase, nowMs: opts?.nowMs });
  return { ctx, dependencyLookup, population: tasks };
}
