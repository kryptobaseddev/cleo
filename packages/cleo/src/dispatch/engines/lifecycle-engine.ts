/**
 * Lifecycle Engine — Thin EngineResult Wrapper
 *
 * Delegates all business logic to src/core/lifecycle/index.ts.
 * This file only wraps core function calls in EngineResult format
 * for the dispatch domain handlers.
 *
 * @task T4785
 * @task T4800 - Updated to canonical full-form stage names
 * @task T1162 - Lifecycle scope guard (subagent bypass prevention)
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  checkGate,
  checkStagePrerequisites,
  failGate,
  getActiveSession,
  getLifecycleGates,
  getLifecycleHistory,
  getLifecycleStatus,
  getStagePrerequisites,
  listEpicsWithLifecycle,
  passGate,
  recordStageProgress,
  resetStage,
  resolveStageAlias,
  skipStageWithReason,
} from '@cleocode/core/internal';
import { type EngineResult, engineError, engineSuccess } from './_error.js';

// ============================================================================
// Lifecycle Scope Guard (T1162)
//
// Prevents subagents from unilaterally advancing a parent epic's lifecycle
// stages to bypass gate checks. A lifecycle mutation on epic <epicId> is only
// allowed when:
//   (a) the active session is scoped to that epic itself, OR
//   (b) the active session is a global scope (owner-level access), OR
//   (c) CLEO_OWNER_OVERRIDE=1 env var is set (audited escape hatch).
//
// A subagent whose session is scoped to a child task (e.g. epic:T1150 with
// rootTaskId=T1162) is NOT authorised to advance T1150's lifecycle stages
// and will receive E_LIFECYCLE_SCOPE_DENIED.
//
// Root incident: during T1150 orchestration a subagent advanced all 9 lifecycle
// stages of T1150 within 75 seconds (17:59:17→18:00:32, 2026-04-21) to bypass
// E_LIFECYCLE_GATE_FAILED. This guard closes that vector.
//
// @adr ADR-054 (scope-guard addendum)
// @task T1162
// ============================================================================

/** Path to the force-bypass audit log. */
function getForceBypassPath(projectRoot: string): string {
  return resolvePath(projectRoot, '.cleo', 'audit', 'force-bypass.jsonl');
}

/** Append a lifecycle-scope-bypass entry to the force-bypass audit trail. */
async function appendLifecycleScopeBypassLine(
  projectRoot: string,
  epicId: string,
  sessionScope: string,
  reason: string,
): Promise<void> {
  const path = getForceBypassPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    type: 'lifecycle_scope_bypass',
    epicId,
    sessionScope,
    overrideReason: reason,
    pid: process.pid,
    command: (process.argv.slice(1).join(' ') || 'cleo').slice(0, 512),
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf-8' });
}

/**
 * Enforce that the active session is authorised to mutate lifecycle stages for
 * the given epic.
 *
 * Returns `null` on success. Returns an `EngineResult` error when the caller
 * is denied and should immediately return that result to the caller.
 *
 * @param epicId      - The epic whose lifecycle stage is being mutated.
 * @param projectRoot - Absolute project root (used for DB + audit I/O).
 *
 * @task T1162
 */
async function enforceScopeForLifecycleMutation(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult | null> {
  // Resolve the active session. If there is no active session, allow the
  // operation — session enforcement is handled separately by requireActiveSession().
  let session: Awaited<ReturnType<typeof getActiveSession>>;
  try {
    session = await getActiveSession(projectRoot);
  } catch {
    // DB not available or not initialised — let the downstream operation
    // surface its own error rather than blocking here.
    return null;
  }

  if (!session) {
    // No active session — defer to session enforcement middleware.
    return null;
  }

  const scope = session.scope;

  // (b) Global scope — owner-level access, always allowed.
  if (scope.type === 'global') {
    return null;
  }

  // (a) Session is scoped directly to this epic — allowed.
  //
  // The critical check is `rootTaskId === epicId`. The `epicId` field on the
  // scope records which epic the session belongs to, but a subagent working on
  // a CHILD task has `rootTaskId = <child>` while `epicId = <parent epic>`.
  // Matching on `epicId` alone would allow any child-task session to advance
  // the parent epic's lifecycle — exactly the T1150 bypass vector we are
  // closing. We therefore require that the session is rooted at the epic
  // itself (rootTaskId = epicId), OR that the session has no rootTaskId set
  // (implicit: session was started with `--scope epic:<epicId>` directly).
  if (scope.type === 'epic') {
    const rootId = scope.rootTaskId ?? scope.epicId;
    if (rootId === epicId) {
      return null;
    }
  }

  // Any other scope (child task, different epic, custom, etc.) is denied
  // unless the owner override env var is set.
  const overrideRaw = process.env['CLEO_OWNER_OVERRIDE'];
  const overrideActive = overrideRaw === '1' || overrideRaw === 'true';

  // T1118 L4b — restricted agent roles cannot use owner override.
  const agentRole = process.env['CLEO_AGENT_ROLE'];
  const forbiddenRoles = new Set(['worker', 'lead', 'subagent']);
  const overrideAllowed = overrideActive && !(agentRole && forbiddenRoles.has(agentRole));

  if (overrideAllowed) {
    // Emit audit trail entry and allow — best-effort, non-blocking.
    const reason = (process.env['CLEO_OWNER_OVERRIDE_REASON'] ?? '').trim() || 'unspecified';
    const scopeStr = scope.epicId ? `epic:${scope.epicId}` : scope.type;
    try {
      const root = projectRoot ?? process.cwd();
      await appendLifecycleScopeBypassLine(root, epicId, scopeStr, reason);
    } catch {
      // Audit write failure must not block the operation.
    }
    return null;
  }

  // Build a human-readable description of the current scope.
  const scopeDesc =
    scope.type === 'epic' && scope.epicId
      ? `epic:${scope.epicId}${scope.rootTaskId && scope.rootTaskId !== scope.epicId ? ` (rootTaskId: ${scope.rootTaskId})` : ''}`
      : scope.type;

  return engineError(
    'E_LIFECYCLE_SCOPE_DENIED',
    `Lifecycle stage advancement for epic ${epicId} requires a session scoped to that epic or an owner override. ` +
      `Current session scope: ${scopeDesc}. ` +
      `Use CLEO_OWNER_OVERRIDE=1 (with CLEO_OWNER_OVERRIDE_REASON) if this is an authorized operation.`,
    {
      fix: `Start a session scoped to the target epic: cleo session start --scope epic:${epicId}`,
      alternatives: [
        {
          action: 'Start an epic-scoped session',
          command: `cleo session start --scope epic:${epicId} --name "Lifecycle work"`,
        },
        {
          action: 'Emergency override (audited)',
          command: `CLEO_OWNER_OVERRIDE=1 CLEO_OWNER_OVERRIDE_REASON="..." cleo lifecycle complete ${epicId} <stage>`,
        },
      ],
    },
  );
}

// ============================================================================
// Exported engine functions (thin wrappers)
// ============================================================================

/**
 * List all epic IDs that have RCASD pipeline data.
 */
export async function listRcsdEpics(projectRoot?: string): Promise<string[]> {
  return listEpicsWithLifecycle(projectRoot);
}

/**
 * lifecycle.check / lifecycle.status - Get lifecycle status for epic.
 * @task T4785
 */
export async function lifecycleStatus(epicId: string, projectRoot?: string): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }
  try {
    const data = await getLifecycleStatus(epicId, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_STATUS', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.history - Stage transition history.
 * @task T4785
 */
export async function lifecycleHistory(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const data = await getLifecycleHistory(taskId, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_HISTORY', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.gates - Get all gate statuses for an epic.
 * @task T4785
 */
export async function lifecycleGates(taskId: string, projectRoot?: string): Promise<EngineResult> {
  try {
    const data = await getLifecycleGates(taskId, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_GATES', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.prerequisites - Get required prior stages for a target stage.
 * @task T4785
 */
export async function lifecyclePrerequisites(
  targetStage: string,
  _projectRoot?: string,
): Promise<EngineResult> {
  if (!targetStage) {
    return engineError('E_INVALID_INPUT', 'targetStage is required');
  }
  try {
    const data = await getStagePrerequisites(targetStage);
    return engineSuccess({ targetStage, ...data });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_PREREQUISITES', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.check - Check if a stage's prerequisites are met.
 * @task T4785
 */
export async function lifecycleCheck(
  epicId: string,
  targetStage: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId || !targetStage) {
    return engineError('E_INVALID_INPUT', 'epicId and targetStage are required');
  }
  try {
    const data = await checkStagePrerequisites(epicId, targetStage, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_CHECK', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.progress / lifecycle.record - Record stage completion.
 *
 * @task T4785
 * @task T1162 - Scope guard: subagents may not advance a parent epic's lifecycle.
 */
export async function lifecycleProgress(
  taskId: string,
  stage: string,
  status: string,
  notes?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !stage || !status) {
    return engineError('E_INVALID_INPUT', 'taskId, stage, and status are required');
  }

  // T1162: Enforce that the active session is authorised to mutate this epic's
  // lifecycle stages. Subagents scoped to a child task are rejected.
  const scopeDenied = await enforceScopeForLifecycleMutation(taskId, projectRoot);
  if (scopeDenied) return scopeDenied;

  // T929: resolve shorthand aliases (e.g. 'architecture' → 'architecture_decision')
  // before any validation or forward-only checks so the full RCASD chain can be
  // advanced in one call per stage without knowing internal canonical names.
  stage = resolveStageAlias(stage);

  try {
    // Enforce forward-only stage progression
    if (status === 'in_progress' || status === 'completed') {
      const { getLifecycleStatus } = await import('@cleocode/core/internal');
      const current = await getLifecycleStatus(taskId, projectRoot);
      if (current.currentStage) {
        const { isPipelineTransitionForward, getPipelineStageOrder } = await import(
          '@cleocode/core/internal'
        );
        if (!isPipelineTransitionForward(current.currentStage, stage)) {
          const currentOrder = getPipelineStageOrder(current.currentStage);
          const newOrder = getPipelineStageOrder(stage);
          return engineError(
            'E_LIFECYCLE_BACKWARD',
            `Cannot move backward from "${current.currentStage}" (stage ${currentOrder}) to "${stage}" (stage ${newOrder}). Pipeline stages are forward-only.`,
          );
        }
      }

      // Enforce lifecycle gates for stage transitions (T5698)
      const gateResult = await checkGate(taskId, stage, projectRoot);
      if (!gateResult.allowed) {
        return engineError('E_LIFECYCLE_GATE_FAILED', gateResult.message);
      }
    }

    const data = await recordStageProgress(taskId, stage, status, notes, projectRoot);
    return engineSuccess({ ...data, recorded: true });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_PROGRESS', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.skip - Skip a stage with reason.
 *
 * @task T4785
 * @task T1162 - Scope guard: subagents may not skip a parent epic's lifecycle stages.
 */
export async function lifecycleSkip(
  taskId: string,
  stage: string,
  reason: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !stage || !reason) {
    return engineError('E_INVALID_INPUT', 'taskId, stage, and reason are required');
  }

  // T1162: Enforce scope — a subagent scoped to a child task cannot skip
  // lifecycle stages on the parent epic.
  const scopeDenied = await enforceScopeForLifecycleMutation(taskId, projectRoot);
  if (scopeDenied) return scopeDenied;

  try {
    const data = await skipStageWithReason(taskId, stage, reason, projectRoot);
    return engineSuccess({ ...data, skipped: true });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_SKIP', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.reset - Reset a stage (emergency).
 *
 * @task T4785
 * @task T1162 - Scope guard: subagents may not reset a parent epic's lifecycle stages.
 */
export async function lifecycleReset(
  taskId: string,
  stage: string,
  reason: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !stage || !reason) {
    return engineError('E_INVALID_INPUT', 'taskId, stage, and reason are required');
  }

  // T1162: Enforce scope — a subagent scoped to a child task cannot reset
  // lifecycle stages on the parent epic.
  const scopeDenied = await enforceScopeForLifecycleMutation(taskId, projectRoot);
  if (scopeDenied) return scopeDenied;

  try {
    const data = await resetStage(taskId, stage, reason, projectRoot);
    return engineSuccess({ ...data, reset: 'pending' });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_RESET', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.gate.pass - Mark gate as passed.
 * @task T4785
 */
export async function lifecycleGatePass(
  taskId: string,
  gateName: string,
  agent?: string,
  notes?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !gateName) {
    return engineError('E_INVALID_INPUT', 'taskId and gateName are required');
  }
  try {
    const data = await passGate(taskId, gateName, agent, notes, projectRoot);
    return engineSuccess({ ...data, status: 'passed' });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_GATE_PASS', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.gate.fail - Mark gate as failed.
 * @task T4785
 */
export async function lifecycleGateFail(
  taskId: string,
  gateName: string,
  reason?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !gateName) {
    return engineError('E_INVALID_INPUT', 'taskId and gateName are required');
  }
  try {
    const data = await failGate(taskId, gateName, reason, projectRoot);
    return engineSuccess({ ...data, status: 'failed' });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_GATE_FAIL', err.message);
    }
    throw err;
  }
}
