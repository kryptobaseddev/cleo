/**
 * Orchestrate Handoff Operations
 *
 * orchestrateHandoff and HandoffStep types migrated from
 * packages/cleo/src/dispatch/engines/orchestrate-engine.ts.
 *
 * Session operations (sessionStatus, sessionEnd, sessionContextInject) are
 * injected via DI to avoid a core→cleo import cycle. The domain layer
 * (orchestrate.ts) passes the actual session engine functions.
 *
 * @task T1570
 * @task T4478
 */

import type { Session, TaskWorkState } from '@cleocode/contracts';
import type { OrchestrateHandoffParams } from '@cleocode/contracts/operations/orchestrate';
import { type EngineResult, engineError } from '../engine-result.js';
import { resolveProjectRoot } from '../store/file-utils.js';
import { orchestrateSpawn, sendConduitEvent } from './spawn-ops.js';

export type { EngineResult };

// ---------------------------------------------------------------------------
// HandoffStep types
// ---------------------------------------------------------------------------

/** Status of a single handoff step. */
export type HandoffStepStatus = 'pending' | 'completed' | 'failed' | 'skipped';

/** State of a single handoff step. */
export interface HandoffStepState {
  /** Step completion status. */
  status: HandoffStepStatus;
  /** Operation name for this step. */
  operation: string;
  /** Optional diagnostic message. */
  message?: string;
}

/** Aggregate state of all three handoff steps. */
export interface HandoffState {
  contextInject: HandoffStepState;
  sessionEnd: HandoffStepState;
  spawn: HandoffStepState;
}

/** Detailed failure information for partial handoff. */
export interface HandoffFailureDetails {
  failedStep: 'session.context.inject' | 'session.end' | 'orchestrate.spawn';
  activeSessionId: string | null;
  endedSessionId: string | null;
  idempotency: {
    key: string | null;
    policy: 'non-idempotent';
    safeRetryFrom: 'start' | 'orchestrate.spawn';
    reason: string;
  };
  steps: HandoffState;
}

// ---------------------------------------------------------------------------
// DI types for session operations
// ---------------------------------------------------------------------------

/**
 * Session status result shape (subset used by handoff).
 *
 * Typed as a minimal interface so core does not import from cleo's
 * session-engine.ts. The domain call-site passes the actual function.
 */
interface SessionStatusResult {
  hasActiveSession: boolean;
  session?: Session | null;
  taskWork?: TaskWorkState | null;
  overrideCount: number;
}

/** Context injection data returned by sessionContextInject (opaque to core). */
type ContextInjectionData = unknown;

/**
 * Session operations injected into orchestrateHandoff to avoid a core→cleo import cycle.
 *
 * The actual functions come from `packages/cleo/src/dispatch/engines/session-engine.ts`.
 * Core only knows the shape, not the implementation.
 */
export interface HandoffSessionOps {
  /** Check whether an active session exists and return its state. */
  sessionStatus: (projectRoot: string) => Promise<EngineResult<SessionStatusResult>>;
  /** End the active session and return the ended session id. */
  sessionEnd: (
    projectRoot: string,
    note?: string,
  ) => Promise<EngineResult<{ sessionId: string; ended: boolean; memoryPrompt?: string }>>;
  /** Inject handoff context into the session record. */
  sessionContextInject: (
    protocolType: string,
    params?: { taskId?: string; variant?: string },
    projectRoot?: string,
  ) => EngineResult<ContextInjectionData>;
}

// ---------------------------------------------------------------------------
// orchestrateHandoff
// ---------------------------------------------------------------------------

/**
 * orchestrate.handoff - Composite session handoff + successor spawn
 *
 * Step order is explicit and fixed:
 * 1) session.context.inject
 * 2) session.end
 * 3) orchestrate.spawn
 *
 * Idempotency policy:
 * - Non-idempotent overall. A retry after step 2 can duplicate spawn output.
 * - Failures include exact step state and a safe retry entry point.
 *
 * Session operations are injected via `sessionOps` to avoid a core→cleo
 * import cycle. The domain layer passes the actual cleo session engine functions.
 *
 * @param params - Handoff parameters including taskId, protocolType, etc.
 * @param sessionOps - Injected session operations (from cleo session-engine.ts).
 * @param projectRoot - Optional project root path.
 * @returns Engine result with handoff data or structured failure.
 * @task T4478
 */
export async function orchestrateHandoff(
  params: OrchestrateHandoffParams,
  sessionOps: HandoffSessionOps,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.taskId) {
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  if (!params.protocolType) {
    return engineError('E_INVALID_INPUT', 'protocolType is required');
  }

  const root = projectRoot || resolveProjectRoot();

  const steps: HandoffState = {
    contextInject: { status: 'pending', operation: 'session.context.inject' },
    sessionEnd: { status: 'pending', operation: 'session.end' },
    spawn: { status: 'pending', operation: 'orchestrate.spawn' },
  };

  const idempotency = {
    key: params.idempotencyKey ?? null,
    policy: 'non-idempotent' as const,
    safeRetryFrom: 'start' as 'start' | 'orchestrate.spawn',
    reason:
      'session.end and orchestrate.spawn mutate state and may be executed independently on retry',
  };

  let activeSessionId: string | null = null;
  let endedSessionId: string | null = null;

  const failWithStep = (
    code: string,
    message: string,
    failedStep: HandoffFailureDetails['failedStep'],
    safeRetryFrom: 'start' | 'orchestrate.spawn',
  ): EngineResult => {
    idempotency.safeRetryFrom = safeRetryFrom;
    return engineError(code, message, {
      details: {
        failedStep,
        activeSessionId,
        endedSessionId,
        idempotency,
        steps,
      } satisfies HandoffFailureDetails,
      fix:
        safeRetryFrom === 'orchestrate.spawn'
          ? 'Retry only step 3 with mutate orchestrate spawn'
          : 'Retry from step 1 with mutate orchestrate handoff',
      alternatives: [
        {
          action: 'Run canonical multi-op fallback manually',
          command:
            'mutate session context.inject -> mutate session end -> mutate orchestrate spawn',
        },
      ],
    });
  };

  const preflight = await sessionOps.sessionStatus(root);
  if (!preflight.success) {
    return failWithStep(
      preflight.error?.code ?? 'E_NOT_INITIALIZED',
      preflight.error?.message ?? 'Unable to load session status',
      'session.context.inject',
      'start',
    );
  }

  if (!preflight.data?.hasActiveSession || !preflight.data.session?.id) {
    steps.contextInject.status = 'skipped';
    steps.contextInject.message = 'No active session available for handoff';
    steps.sessionEnd.status = 'skipped';
    steps.sessionEnd.message = 'No active session available for handoff';
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'No active session available for handoff';
    return failWithStep(
      'E_SESSION_REQUIRED',
      'orchestrate.handoff requires an active session',
      'session.end',
      'start',
    );
  }

  activeSessionId = preflight.data.session.id;

  const injectResult = sessionOps.sessionContextInject(
    params.protocolType,
    { taskId: params.taskId, variant: params.variant },
    root,
  );

  if (!injectResult.success) {
    steps.contextInject.status = 'failed';
    steps.contextInject.message = injectResult.error?.message;
    steps.sessionEnd.status = 'skipped';
    steps.sessionEnd.message = 'Blocked by session.context.inject failure';
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'Blocked by session.context.inject failure';
    return failWithStep(
      injectResult.error?.code ?? 'E_GENERAL',
      injectResult.error?.message ?? 'Failed to inject handoff context',
      'session.context.inject',
      'start',
    );
  }

  steps.contextInject.status = 'completed';
  steps.contextInject.message = 'Handoff context injected';

  const endResult = await sessionOps.sessionEnd(root, params.note);
  if (!endResult.success) {
    steps.sessionEnd.status = 'failed';
    steps.sessionEnd.message = endResult.error?.message;
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'Blocked by session.end failure';
    return failWithStep(
      endResult.error?.code ?? 'E_GENERAL',
      endResult.error?.message ?? 'Failed to end predecessor session',
      'session.end',
      'start',
    );
  }

  endedSessionId = endResult.data?.sessionId ?? null;
  if (endedSessionId !== activeSessionId) {
    steps.sessionEnd.status = 'failed';
    steps.sessionEnd.message = `Ended session '${endedSessionId ?? 'null'}' does not match active session '${activeSessionId}'`;
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'Blocked by session mismatch';
    return failWithStep(
      'E_CONCURRENT_SESSION',
      'Active session changed during orchestrate.handoff',
      'session.end',
      'start',
    );
  }

  steps.sessionEnd.status = 'completed';
  steps.sessionEnd.message = `Ended session ${endedSessionId}`;

  const spawnResult = await orchestrateSpawn(params.taskId, params.protocolType, root, params.tier);
  if (!spawnResult.success) {
    steps.spawn.status = 'failed';
    steps.spawn.message = spawnResult.error?.message;
    return failWithStep(
      spawnResult.error?.code ?? 'E_GENERAL',
      spawnResult.error?.message ?? 'Failed to prepare successor spawn context',
      'orchestrate.spawn',
      'orchestrate.spawn',
    );
  }

  steps.spawn.status = 'completed';
  steps.spawn.message = `Spawn prepared for ${params.taskId}`;

  // Best-effort: record handoff event in conduit.db so orchestrators and
  // observers can track session transitions. Never blocks the return.
  void sendConduitEvent(root, 'cleo-core', {
    event: 'orchestrate.handoff',
    taskId: params.taskId,
    protocolType: params.protocolType,
    predecessorSessionId: activeSessionId,
    endedSessionId,
    note: params.note ?? null,
    nextAction: params.nextAction ?? null,
    handoffAt: new Date().toISOString(),
  });

  return {
    success: true,
    data: {
      taskId: params.taskId,
      predecessorSessionId: activeSessionId,
      endedSessionId,
      protocolType: params.protocolType,
      note: params.note ?? null,
      nextAction: params.nextAction ?? null,
      idempotency,
      steps,
      contextInject: injectResult.data,
      spawn: spawnResult.data,
    },
  };
}
