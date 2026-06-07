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
 *         → fan-out the injected IVTR runner over readyFrontier tasks
 *         → { action: 'ivtrFanOut', sagaId, epicId, tasks: string[], runIds: string[] }
 *   → return ONE LAFS-compatible EngineResult envelope
 * ```
 *
 * ## IVTR seam (T11805 · E-ORCH-STATE-MACHINE-COLLAPSE / T11764)
 *
 * The implementation+ branch is flag-gated by {@link CLEO_GO_VIA_PLAYBOOK_ENV}
 * (defaulting **OFF** — Risk #1 mitigation, `cleo go` is the shipped autopilot
 * hot path):
 *
 * - **Flag OFF (default)** — seed each ready task via the legacy `startIvtr`
 *   phase walk (byte-identical to the pre-T11805 behaviour); the seam is a
 *   no-op. This keeps a regression in the cantbook path from ever blocking
 *   autopilot and is retained as the fallback for one release.
 * - **Flag ON** — fan out an injected {@link IvtrRunner} — supplied by the CLI
 *   `cleo go` handler — that drives each task through
 *   `executePlaybook(ivtr.cantbook)` (the cantbook runtime, the survivor state
 *   machine) AND mirrors the run's terminal status back into `ivtr_state`
 *   (`finalizeIvtrFromPlaybook`) so the strict `E_IVTR_INCOMPLETE` completion
 *   gate reflects the cantbook run. The runtime's
 *   `on_failure.inject_into: implement` edge reproduces the IVTR loop-back walk.
 *
 * The driver stays in `@cleocode/core` and must NOT import `@cleocode/playbooks`
 * (that would invert the package dependency), so the runtime call is injected
 * as a callback rather than referenced directly.
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
import { armGoalLoop } from '../goal/arm.js';
import { startIvtr } from '../lifecycle/ivtr-loop.js';
import { orchestrateReady } from '../orchestrate/query-ops.js';
import { getProjectRoot } from '../paths.js';
import { sagaNext } from '../sagas/next.js';

/**
 * Feature-flag env var gating the cantbook IVTR seam (T11805 · collapse-plan
 * Risk Register §7 row #1).
 *
 * `cleo go` is the shipped SG-AUTOPILOT hot path, so the seam lands behind a
 * flag that defaults **OFF**. When unset/`'0'`/`'false'`, the
 * implementation-stage branch falls back to the legacy {@link startIvtr} phase
 * seed (byte-identical to the pre-T11805 behaviour) so a regression in the
 * cantbook path never blocks autopilot. Set `CLEO_GO_VIA_PLAYBOOK=1` to drive
 * the injected {@link IvtrRunner} (`executePlaybook(ivtr.cantbook)`). The
 * fallback is retained for one release per the collapse-plan mitigation.
 */
export const CLEO_GO_VIA_PLAYBOOK_ENV = 'CLEO_GO_VIA_PLAYBOOK' as const;

/**
 * Resolve whether the cantbook IVTR seam is enabled for this `cleo go` turn.
 *
 * @returns `true` only when {@link CLEO_GO_VIA_PLAYBOOK_ENV} is an explicit
 *   truthy value (`'1'` | `'true'`, case-insensitive). Default OFF.
 */
function isPlaybookSeamEnabled(): boolean {
  const raw = process.env[CLEO_GO_VIA_PLAYBOOK_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outcome of a single IVTR playbook run started by the seam (T11805).
 *
 * Returned by {@link IvtrRunner} so the driver can both report the started
 * task and surface the `playbook_runs.run_id` for resume-on-next-turn.
 *
 * @task T11805 — E-ORCH-STATE-MACHINE-COLLAPSE / T11764
 */
export interface IvtrRunResult {
  /** The task whose `ivtr.cantbook` run was started. */
  taskId: string;
  /**
   * The `playbook_runs.run_id` of the started run, when the runtime created
   * one. Absent only when the runner cannot reach a run id (e.g. a pre-flight
   * failure before the run row is written).
   */
  runId?: string;
  /**
   * Terminal status reported by the cantbook runtime for this turn, when the
   * run reached a terminal node (`completed | failed | pending_approval |
   * exceeded_iteration_cap`). Absent when the runner only seeded the run.
   */
  terminalStatus?: string;
}

/**
 * Options handed to an {@link IvtrRunner} for a single task.
 *
 * @task T11805
 */
export interface IvtrRunnerOptions {
  /** Resolved project root for playbook resolution + audit writes. */
  projectRoot: string;
  /**
   * Session id persisted onto `playbook_runs.session_id` (evidence/provenance
   * gate parameter). Absent when no session is active.
   */
  sessionId?: string;
  /** Parent epic id persisted onto `playbook_runs.epic_id` for dashboards. */
  epicId?: string;
}

/**
 * Injected callback that drives one task's IVTR loop through the cantbook
 * runtime (`executePlaybook(ivtr.cantbook)`).
 *
 * The driver lives in `@cleocode/core`, which must not depend on
 * `@cleocode/playbooks`; the runtime call is therefore injected by the CLI
 * `cleo go` handler (which already imports `@cleocode/playbooks`). The runner
 * is responsible for:
 *   - resolving + parsing `ivtr.cantbook`,
 *   - seeding `initialContext = { taskId }`,
 *   - calling `executePlaybook` with `taskId` (via context) + `sessionId` +
 *     the evidence-gate parameters the cantbook encodes,
 *   - keeping `tasks.ivtr_state` populated so the strict `E_IVTR_INCOMPLETE`
 *     completion gate stays load-bearing (collapse-plan §3 item 4).
 *
 * @task T11805
 */
export type IvtrRunner = (taskId: string, options: IvtrRunnerOptions) => Promise<IvtrRunResult>;

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
  /**
   * Drives each ready task through `executePlaybook(ivtr.cantbook)` when the
   * cantbook seam is enabled via {@link CLEO_GO_VIA_PLAYBOOK_ENV} (T11805).
   * Injected by the CLI handler so the core driver never imports the playbooks
   * runtime. When the flag is OFF (default) or this is omitted, the driver
   * falls back to the legacy `startIvtr` seed for the implementation+ branch
   * (no behaviour is silently skipped).
   */
  ivtrRunner?: IvtrRunner;
  /**
   * Session id forwarded to {@link IvtrRunner} for `playbook_runs.session_id`
   * provenance. Best-effort; absent when no session is active.
   */
  sessionId?: string;
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
      /**
       * Fan-out: an IVTR cantbook run was started for each task on the ready
       * frontier (T11805 — `executePlaybook(ivtr.cantbook)`, no longer
       * `startIvtr`).
       */
      action: 'ivtrFanOut';
      sagaId: string;
      epicId: string;
      currentStage: TaskViewPipelineStage;
      /** Task IDs for which an IVTR playbook run was initiated. */
      tasks: string[];
      /**
       * `playbook_runs.run_id` for each started run, positionally aligned to
       * the tasks that produced one. Lets the autopilot resume paused runs on
       * the next turn.
       *
       * @task T11805
       */
      runIds: string[];
    }
  | {
      /** No non-terminal sagas remain — the workgraph is complete. */
      action: 'complete';
    };

/**
 * Result payload for {@link cleoGo}.
 *
 * @task T11494
 * @task T11496 E4-GOAL-LOOP
 */
export interface CleoGoResult {
  /** The action taken by the driver in this turn. */
  outcome: CleoGoAction;
  /**
   * Structured diagnostics for display / logging. Always present; may be empty.
   */
  diagnostics: string[];
  /**
   * The id of the goal that was armed (or reused) for the Stop-hook loop.
   *
   * `null` when no saga was selected (workgraph `complete` action) — there is
   * nothing to arm when the workgraph is already done.
   *
   * @task T11496
   */
  armedGoalId: string | null;
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
 * {@link CleoGoResult}. Each call is stateless (side effects — IVTR cantbook
 * runs via the injected {@link IvtrRunner}, lifecycle progression — happen
 * inside the called engines); the driver itself carries no mutable state.
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
      armedGoalId: null,
    });
  }

  const sagaId = next.sagaId;
  diagnostics.push(
    `active saga: ${sagaId}${next.sagaTitle ? ` (${next.sagaTitle})` : ''} — ${next.completionPct ?? 0}% complete`,
  );

  // 2b. Arm the goal loop (AC3 of T11496): create/reuse a per-saga goal that
  //     the Stop-hook advances each turn to self-renudge until satisfied.
  //     Best-effort: failure is non-fatal (diagnostics only).
  let armedGoalId: string | null = null;
  try {
    const armedGoal = await armGoalLoop({
      sagaId,
      sagaTitle: next.sagaTitle,
      cwd: root,
    });
    armedGoalId = armedGoal.id;
    diagnostics.push(`goal loop armed: ${armedGoalId}`);
  } catch (err: unknown) {
    diagnostics.push(`goal loop arm failed (non-fatal): ${(err as Error).message}`);
  }

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
      armedGoalId,
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
      armedGoalId,
    });
  }

  // 7. Implementation+ → fan-out the IVTR loop over the ready frontier.
  //
  //    Two paths, gated by the CLEO_GO_VIA_PLAYBOOK feature flag (Risk #1
  //    mitigation — the seam lands behind a flag defaulting OFF, keeping the
  //    legacy `startIvtr` seed as the fallback for one release):
  //
  //    - Flag OFF (default) OR no runner injected → seed each ready task via
  //      the hand-rolled `startIvtr` phase walk (byte-identical to the
  //      pre-T11805 behaviour). This is the shipped autopilot hot path.
  //    - Flag ON AND a runner injected → drive each ready task through
  //      `executePlaybook(ivtr.cantbook)` via the injected runner, which also
  //      mirrors the terminal status back into `ivtr_state`. The runner is
  //      injected by the CLI handler so the core driver never imports
  //      `@cleocode/playbooks`.
  const ivtrStarted: string[] = [];
  const ivtrRunIds: string[] = [];

  const seamEnabled = isPlaybookSeamEnabled();

  if (!seamEnabled || !params.ivtrRunner) {
    // Fallback path: legacy `startIvtr` seed (flag OFF or no runner injected).
    if (params.ivtrRunner && !seamEnabled) {
      diagnostics.push(
        `IVTR cantbook seam disabled (${CLEO_GO_VIA_PLAYBOOK_ENV} not set) — using legacy startIvtr seed`,
      );
    } else if (!params.ivtrRunner) {
      diagnostics.push('IVTR runner not provided — using legacy startIvtr seed');
    }

    for (const taskId of readyFrontier) {
      try {
        await startIvtr(taskId, { cwd: root });
        ivtrStarted.push(taskId);
        diagnostics.push(`IVTR started for ${taskId} (startIvtr seed)`);
      } catch (err: unknown) {
        diagnostics.push(`IVTR start failed for ${taskId}: ${(err as Error).message}`);
      }
    }

    if (ivtrStarted.length === 0 && readyFrontier.length > 0) {
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
        runIds: ivtrRunIds,
      },
      diagnostics,
      armedGoalId,
    });
  }

  // Seam path: drive each ready task through `executePlaybook(ivtr.cantbook)`.
  const runnerOptions: IvtrRunnerOptions = { projectRoot: root, epicId };
  if (params.sessionId !== undefined) runnerOptions.sessionId = params.sessionId;

  for (const taskId of readyFrontier) {
    try {
      const runResult = await params.ivtrRunner(taskId, runnerOptions);
      ivtrStarted.push(runResult.taskId);
      if (runResult.runId !== undefined) ivtrRunIds.push(runResult.runId);
      diagnostics.push(
        `IVTR cantbook started for ${runResult.taskId}` +
          `${runResult.runId ? ` (run ${runResult.runId})` : ''}` +
          `${runResult.terminalStatus ? ` → ${runResult.terminalStatus}` : ''}`,
      );
    } catch (err: unknown) {
      diagnostics.push(`IVTR start failed for ${taskId}: ${(err as Error).message}`);
    }
  }

  if (ivtrStarted.length === 0 && readyFrontier.length > 0) {
    // All IVTR starts failed — surface the errors but return gracefully.
    diagnostics.push(`All ${readyFrontier.length} IVTR starts failed — see diagnostics`);
  } else {
    diagnostics.push(
      `IVTR cantbook started for ${ivtrStarted.length} task(s): ${ivtrStarted.join(', ')}`,
    );
  }

  return engineSuccess<CleoGoResult>({
    outcome: {
      action: 'ivtrFanOut',
      sagaId,
      epicId,
      currentStage,
      tasks: ivtrStarted,
      runIds: ivtrRunIds,
    },
    diagnostics,
    armedGoalId,
  });
}
