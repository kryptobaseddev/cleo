/**
 * `cleo go` autopilot driver — the thin orchestration sequencer.
 *
 * This is the canonical entry point for `cleo go` (SG-AUTOPILOT / T11492).
 * It is PURE GLUE: it sequences existing core engines without adding new
 * orchestration math.
 *
 * ## Pipeline (AC1)
 *
 * ```
 * briefing (optional context anchor)
 *   → sagaNext() — pick highest-priority non-terminal saga
 *   → orchestrateReady(sagaId) — fetch readyFrontier
 *   → branch on pipelineStage of the active epic:
 *       AC-only (no children, research stage)
 *         → { action: 'needsDecomposition', sagaId, epicId }
 *       research | specification | decomposition
 *         → { action: 'lifecycleHop', sagaId, epicId, currentStage }
 *       implementation | validation | testing | release | contribution
 *         → fan-out startIvtr over readyFrontier tasks
 *         → { action: 'ivtrFanOut', sagaId, epicId, tasks: string[] }
 *   → return ONE LAFS-compatible EngineResult envelope
 * ```
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

import type { TaskViewPipelineStage } from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { startIvtr } from '../lifecycle/ivtr-loop.js';
import { orchestrateReady } from '../orchestrate/query-ops.js';
import { getProjectRoot } from '../paths.js';
import { sagaNext } from '../sagas/next.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
 * Discriminated union of the four action outcomes `cleoGo` can produce.
 *
 * Consumers pattern-match on `action` to route further processing.
 *
 * @task T11494
 */
export type CleoGoAction =
  | {
      /** No children + research stage — the epic needs decomposition before IVTR. */
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
      /** Fan-out: IVTR started for each task on the ready frontier. */
      action: 'ivtrFanOut';
      sagaId: string;
      epicId: string;
      currentStage: TaskViewPipelineStage;
      /** Task IDs for which IVTR was initiated (non-empty). */
      tasks: string[];
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
 * Pipeline stages that require a lifecycle hop before spawning IVTR workers.
 *
 * Tasks whose parent epic is still in one of these stages are not yet
 * implementation-ready; the driver signals `lifecycleHop` instead of fanning
 * out IVTR.
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
 * {@link CleoGoResult}. Each call is stateless (side effects — IVTR writes,
 * lifecycle progression — happen inside the called engines); the driver itself
 * carries no mutable state.
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
      `epic ${epicId} is at stage '${currentStage}' — lifecycle hop required before IVTR`,
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

  // 7. Implementation+ → fan-out IVTR over the ready frontier.
  const ivtrStarted: string[] = [];
  for (const taskId of readyFrontier) {
    try {
      await startIvtr(taskId, { cwd: root });
      ivtrStarted.push(taskId);
    } catch (err: unknown) {
      diagnostics.push(`IVTR start failed for ${taskId}: ${(err as Error).message}`);
    }
  }

  if (ivtrStarted.length === 0 && readyFrontier.length > 0) {
    // All IVTR starts failed — surface the errors but return gracefully.
    diagnostics.push(`All ${readyFrontier.length} IVTR starts failed — see diagnostics`);
  } else {
    diagnostics.push(`IVTR started for ${ivtrStarted.length} task(s): ${ivtrStarted.join(', ')}`);
  }

  return engineSuccess<CleoGoResult>({
    outcome: {
      action: 'ivtrFanOut',
      sagaId,
      epicId,
      currentStage,
      tasks: ivtrStarted,
    },
    diagnostics,
  });
}
