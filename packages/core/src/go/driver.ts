/**
 * `cleo go` autopilot driver — the thin orchestration sequencer.
 *
 * This is the canonical entry point for `cleo go` (SG-AUTOPILOT / T11492).
 * It is PURE GLUE: it sequences existing core engines without adding new
 * orchestration math.
 *
 * ## Pipeline
 *
 * ```
 *   sagaNext() — pick highest-priority non-terminal saga
 *   → orchestrateReady(sagaId) — fetch readyFrontier
 *   → branch on pipelineStage of the active epic:
 *       AC-only (no children, research stage)
 *         → { action: 'needsDecomposition', sagaId, epicId }
 *       research | specification | decomposition
 *         → { action: 'lifecycleHop', sagaId, epicId, currentStage }
 *       implementation | validation | testing | release | contribution
 *         → draft a goal/v1 contract for the ready wave and hand it to the
 *           goal runtime (CLEO Goal) in the current harness
 *         → { action: 'goalHandoff', sagaId, epicId, tasks, goal, runtime }
 *   → return ONE LAFS-compatible EngineResult envelope
 * ```
 *
 * ## Goal handoff (T13821 · owner decision 2026-10-16 · ADR-097)
 *
 * CLEO owns the goal protocol; CLEO Goal is the goal runtime. `cleo go`
 * no longer drives an IVTR loop itself: for implementation-stage work it runs
 * `cleo goal draft` over the ready wave (reusing a draft that already exists,
 * never overwriting it) and returns the exact next step: `/goal start <slug>`
 * when the CLEO Goal bin (`cleo-goal`, then `ocg`) resolves, otherwise the
 * commands that install it (project-scoped; never user-global harness config).
 *
 * ## Design constraints
 *
 * - AC2: ONE LAFS envelope per call — all branching produces a single return.
 * - AC3: empty ready-set + zero children → `needsDecomposition` (typed, not silent []).
 * - No new orchestration math — only sequences ops from `sagas`, `orchestrate`,
 *   and `lifecycle` modules.
 * - CORE-FIRST: all logic here in `packages/core/src/go/`; CLI is a thin dispatch.
 *
 * @module @cleocode/core/go
 *
 * @task T11494 — E2-CLEO-GO
 * @saga T11492 — SG-AUTOPILOT
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GoalRuntimeHandoff, TaskViewPipelineStage } from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { GOAL_INSTALL_COMMAND, resolveGoalBin } from '../goal/runtime.js';
import { orchestrateReady } from '../orchestrate/query-ops.js';
import { getProjectRoot } from '../paths.js';
import { sagaNext } from '../sagas/next.js';

/**
 * Input parameters for {@link cleoGo}.
 *
 * @task T11494
 */
export interface CleoGoParams {
  /**
   * Optional saga ID to scope the autopilot run. When omitted, `sagaNext`
   * auto-selects the highest-priority non-terminal Saga in canonical order.
   */
  sagaId?: string;
  /**
   * When true, suppress any interactive output suitable for daemon / unattended
   * runs. The result shape is identical; only side-channel logging is affected.
   */
  headless?: boolean;
  /** Override project root (useful in tests). */
  projectRoot?: string;
}

/**
 * Discriminated union of the action outcomes `cleoGo` can produce.
 *
 * Consumers pattern-match on `action` to route further processing.
 *
 * @task T11494
 */
export type CleoGoAction =
  | {
      /** No children + research stage — the epic needs decomposition first. */
      action: 'needsDecomposition';
      sagaId: string;
      /** The AC-only epic that needs task children added. */
      epicId: string;
      /** Current pipelineStage (always `'research'` for AC-only epics). */
      currentStage: TaskViewPipelineStage;
    }
  | {
      /** Pre-implementation stage — lifecycle must hop before IVTR is valid. */
      action: 'lifecycleHop';
      sagaId: string;
      epicId: string;
      currentStage: TaskViewPipelineStage;
      /** All ready-frontier task IDs (may be empty while lifecycle hops). */
      readyFrontier: string[];
    }
  | {
      /**
       * Implementation-stage work handed to the goal runtime: a goal/v1
       * contract drafted for the ready wave (T13821).
       */
      action: 'goalHandoff';
      sagaId: string;
      epicId: string;
      currentStage: TaskViewPipelineStage;
      /** The ready wave the goal serves. */
      tasks: string[];
      /** The drafted (or already drafted) goal, or null when none could be drafted. */
      goal: { slug: string; path: string; reused: boolean } | null;
      /** The goal runtime and the exact next step in the current harness. */
      runtime: GoalRuntimeHandoff;
    }
  | {
      /** No non-terminal sagas remain — the workgraph is complete. */
      action: 'complete';
    };

/**
 * Result payload for {@link cleoGo}.
 *
 * @task T11494
 */
export interface CleoGoResult {
  /** The action taken by the driver in this turn. */
  outcome: CleoGoAction;
  /**
   * Structured diagnostics for display / logging. Always present; may be empty.
   */
  diagnostics: string[];
}

// ---------------------------------------------------------------------------
// Pre-implementation stage set
// ---------------------------------------------------------------------------

/**
 * Pipeline stages that require a lifecycle hop before implementation.
 *
 * Tasks whose parent epic is still in one of these stages are not yet
 * implementation-ready; the driver signals `lifecycleHop` instead of handing
 * a goal to the runtime.
 */
const PRE_IMPLEMENTATION_STAGES = new Set<TaskViewPipelineStage>([
  'research',
  'specification',
  'decomposition',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run one turn of the `cleo go` autopilot pipeline.
 *
 * Returns a single LAFS-compatible {@link EngineResult} wrapping a
 * {@link CleoGoResult}. Its only side effect is drafting a goal/v1 contract for
 * the ready wave (never overwriting one); the driver carries no mutable state.
 *
 * @param params - Input parameters controlling the saga scope and mode.
 * @returns EngineResult with {@link CleoGoResult}.
 *
 * @task T11494
 * @saga T11492
 */
export async function cleoGo(params: CleoGoParams = {}): Promise<EngineResult<CleoGoResult>> {
  const root = getProjectRoot(params.projectRoot);
  const diagnostics: string[] = [];

  // 1. sagaNext — pick the next actionable saga (or the explicit one).
  const nextResult = await sagaNext(root, { sagaId: params.sagaId });
  if (!nextResult.success) {
    return engineError(
      nextResult.error?.code ?? 'E_GENERAL',
      nextResult.error?.message ?? 'sagaNext failed',
    );
  }

  const next = nextResult.data;

  // 2. Workgraph complete guard: no active sagas.
  if (!next.sagaId) {
    return engineSuccess<CleoGoResult>({
      outcome: { action: 'complete' },
      diagnostics: ['No non-terminal sagas remain — workgraph is complete.'],
    });
  }

  const sagaId = next.sagaId;
  diagnostics.push(
    `active saga: ${sagaId}${next.sagaTitle ? ` (${next.sagaTitle})` : ''} — ${next.completionPct ?? 0}% complete`,
  );

  // 3. orchestrateReady — get the ready frontier for the saga.
  const readyResult = await orchestrateReady(sagaId, root);
  if (!readyResult.success) {
    return engineError(
      readyResult.error?.code ?? 'E_GENERAL',
      `orchestrateReady failed for saga ${sagaId}: ${readyResult.error?.message ?? 'unknown'}`,
    );
  }

  const readyData = readyResult.data as {
    readyTasks?: Array<{ id: string; pipelineStage?: string; parentId?: string }>;
  };
  const readyTasks = readyData.readyTasks ?? [];
  const readyFrontier = readyTasks.map((t) => t.id);

  // 4. Identify the "active epic" — the first ready task's parent, or the first
  //    saga member if the frontier is empty.
  //
  //    We need the epicId to read its pipelineStage and decide the branch action.
  const epicId = readyTasks[0]?.parentId ?? next.memberEpics?.[0]?.id ?? sagaId;
  const rawStage =
    (readyTasks[0] as { pipelineStage?: string } | undefined)?.pipelineStage ??
    next.memberEpics?.[0]?.status ?? // fallback: treat member epic status as a proxy
    'research';

  // Normalise to a valid TaskViewPipelineStage, defaulting to 'research'.
  const currentStage = (rawStage as TaskViewPipelineStage) ?? 'research';

  // 5. AC-only detection: empty ready frontier + no descendant tasks under the
  //    active epic signals that the epic has acceptance criteria only and needs
  //    to be decomposed into subtasks (AC3 — fixes the silent [] dead-end).
  const totalDescendants = next.memberEpics?.find((e) => e.id === epicId)?.descendantTaskCount ?? 0;
  if (readyFrontier.length === 0 && totalDescendants === 0) {
    diagnostics.push(`epic ${epicId} has no children and no ready tasks — needs decomposition`);
    return engineSuccess<CleoGoResult>({
      outcome: {
        action: 'needsDecomposition',
        sagaId,
        epicId,
        currentStage,
      },
      diagnostics,
    });
  }

  // 6. Pre-implementation stage check → lifecycle hop signal.
  if (PRE_IMPLEMENTATION_STAGES.has(currentStage)) {
    diagnostics.push(
      `epic ${epicId} is at stage '${currentStage}' — lifecycle hop required before implementation`,
    );
    return engineSuccess<CleoGoResult>({
      outcome: {
        action: 'lifecycleHop',
        sagaId,
        epicId,
        currentStage,
        readyFrontier,
      },
      diagnostics,
    });
  }

  // 7. Implementation+ → draft a goal for the ready wave and hand it to the runtime.
  const runtime = goalRuntimeHandoff(null);
  if (readyFrontier.length === 0) {
    diagnostics.push(`epic ${epicId} has no ready tasks — nothing to hand to the goal runtime`);
    return engineSuccess<CleoGoResult>({
      outcome: {
        action: 'goalHandoff',
        sagaId,
        epicId,
        currentStage,
        tasks: [],
        goal: null,
        runtime,
      },
      diagnostics,
    });
  }
  const goal = await draftForWave(readyFrontier, root, diagnostics);
  const handoff = goal ? goalRuntimeHandoff(goal.slug) : runtime;
  diagnostics.push(handoff.next);
  return engineSuccess<CleoGoResult>({
    outcome: {
      action: 'goalHandoff',
      sagaId,
      epicId,
      currentStage,
      tasks: readyFrontier,
      goal,
      runtime: handoff,
    },
    diagnostics,
  });
}

/**
 * The CLEO Goal runtime and the next step: `/goal start <slug>` when its bin
 * resolves, else the install commands (`cleo goal install` writes only the
 * project's harness config).
 */
function goalRuntimeHandoff(slug: string | null): GoalRuntimeHandoff {
  const bin = resolveGoalBin();
  const start = slug ? `/goal start ${slug}` : null;
  if (bin !== null) {
    return {
      installed: true,
      bin,
      next: start ? `In your harness, run: ${start}` : 'CLEO Goal is installed.',
    };
  }
  const install = [GOAL_INSTALL_COMMAND, 'cleo goal install --harness opencode'];
  return {
    installed: false,
    install,
    next: `CLEO Goal is not installed: run ${install.join(', then ')}${start ? `; then in your harness run: ${start}` : ''}`,
  };
}

/** Draft the wave's goal, or reuse the draft already there (a draft never overwrites). */
async function draftForWave(
  tasks: readonly string[],
  root: string,
  diagnostics: string[],
): Promise<{ slug: string; path: string; reused: boolean } | null> {
  const { draftGoal, goalSlug } = await import('../goal/draft.js');
  const slug = goalSlug(tasks);
  const path = join(root, '.opencode', 'goals', slug, 'goal.yaml');
  if (existsSync(path)) {
    diagnostics.push(`goal ${slug} is already drafted at ${path}`);
    return { slug, path, reused: true };
  }
  const drafted = await draftGoal(tasks, { projectRoot: root });
  if (!drafted.success) {
    diagnostics.push(`goal draft failed for ${tasks.join(', ')}: ${drafted.error.message}`);
    return null;
  }
  diagnostics.push(`goal ${drafted.data.slug} drafted at ${drafted.data.path}`);
  return { slug: drafted.data.slug, path: drafted.data.path, reused: false };
}
