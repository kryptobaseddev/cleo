/**
 * IVTR Dispatch Domain Handler
 *
 * Handles `cleo orchestrate ivtr <taskId> --<action>` operations.
 *
 * Operations (all routed through this handler):
 *
 * QUERY:
 *   status     — return current phase + evidence list + phase history
 *
 * MUTATE:
 *   start      — begin Implement phase (returns resolved prompt)
 *   next       — advance from current phase to next (validates evidence; returns prompt)
 *   release    — FINAL gate: requires I+V+T evidence, marks task done
 *   loop-back  — rewind to specified phase with failure evidence attached
 *
 * All state is persisted via the `ivtr_state` JSON column on `tasks`.
 *
 * Type-safe dispatch via `TypedDomainHandler<IvtrOps>` per ADR-058.
 * Param extraction inferred via `OpsFromCore<typeof ivtrCoreOps>`.
 * Zero `params?.x as Type` casts at call sites.
 *
 * @epic T810
 * @task T811
 * @task T1539 — OpsFromCore migration per ADR-058
 */

import type { IvtrPhase, IvtrPhaseEntry } from '@cleocode/core/internal';
import {
  advanceIvtr,
  autoRunGatesAndRecord,
  E_IVTR_MAX_RETRIES,
  extractTypedGates,
  getIvtrState,
  getLogger,
  getProjectRoot,
  getTask,
  loopBackIvtr,
  releaseIvtr,
  resolvePhasePrompt,
  startIvtr,
} from '@cleocode/core/internal';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
} from '../adapters/typed.js';
import { engineError, engineSuccess } from '../engines/_error.js';
import { releaseIvtrAutoSuggest } from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp } from './_base.js';
import { dispatchMeta } from './_meta.js';

const log = getLogger('domain:ivtr');

// ---------------------------------------------------------------------------
// Local param types for OpsFromCore wrapper functions
// ---------------------------------------------------------------------------

interface IvtrStatusParams {
  taskId: string;
}

interface IvtrStartParams {
  taskId: string;
  agentIdentity?: string;
}

interface IvtrNextParams {
  taskId: string;
  agentIdentity?: string;
  evidence?: string | string[];
  autoRunTests?: boolean;
}

interface IvtrReleaseParams {
  taskId: string;
}

interface IvtrLoopBackParams {
  taskId: string;
  phase: string;
  reason: string;
  agentIdentity?: string;
  evidence?: string | string[];
}

// ---------------------------------------------------------------------------
// Helpers (extracted from handler cases for reuse)
// ---------------------------------------------------------------------------

/** Validate that a string is a legal IvtrPhase (excluding 'released'). */
function isLoopBackTarget(phase: string): phase is Exclude<IvtrPhase, 'released'> {
  return phase === 'implement' || phase === 'validate' || phase === 'test';
}

/** Extract an evidence array from raw value (accepts string[] or comma-separated string). */
function extractEvidenceFromRaw(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.length > 0) return raw.split(',').map((s) => s.trim());
  return [];
}

// ---------------------------------------------------------------------------
// Core op wrappers — single-param functions for OpsFromCore inference
//
// All stateful logic lives in these wrappers (matching the pipeline.ts pattern).
// The typed handler cases become single-line wrapCoreResult calls.
// ---------------------------------------------------------------------------

interface IvtrStatusResult {
  taskId: string;
  started: boolean;
  currentPhase: IvtrPhase | null;
  phaseHistory: IvtrPhaseEntry[];
  message?: string;
  startedAt?: string;
  loopBackCount?: { implement: number; validate: number; test: number; released: number };
  evidenceCount?: number;
}

async function ivtrStatusOp(
  params: IvtrStatusParams,
): Promise<import('@cleocode/core').EngineResult<IvtrStatusResult>> {
  const cwd = getProjectRoot();
  const state = await getIvtrState(params.taskId, { cwd });

  if (!state) {
    return engineSuccess({
      taskId: params.taskId,
      started: false,
      currentPhase: null,
      phaseHistory: [] as IvtrPhaseEntry[],
      message: `Task ${params.taskId} has no active IVTR loop. Run --start to begin.`,
    });
  }

  return engineSuccess({
    taskId: params.taskId,
    started: true,
    currentPhase: state.currentPhase,
    startedAt: state.startedAt,
    phaseHistory: state.phaseHistory,
    loopBackCount: state.loopBackCount ?? {
      implement: 0,
      validate: 0,
      test: 0,
      released: 0,
    },
    evidenceCount: state.phaseHistory.reduce(
      (acc: number, e: IvtrPhaseEntry) => acc + e.evidenceRefs.length,
      0,
    ),
  });
}

async function ivtrStartOp(params: IvtrStartParams) {
  const cwd = getProjectRoot();
  const task = await getTask(params.taskId, cwd);
  if (!task) {
    return engineError('E_NOT_FOUND', `Task ${params.taskId} not found`);
  }

  const state = await startIvtr(params.taskId, { cwd, agentIdentity: params.agentIdentity });
  const prompt = resolvePhasePrompt(
    params.taskId,
    state,
    task.title,
    task.description ?? '(no description)',
  );

  return engineSuccess({
    taskId: params.taskId,
    currentPhase: state.currentPhase,
    startedAt: state.startedAt,
    resolvedPrompt: prompt,
    message: `IVTR loop started. Implement phase is now active for task ${params.taskId}.`,
  });
}

async function ivtrNextOp(params: IvtrNextParams) {
  const cwd = getProjectRoot();
  const task = await getTask(params.taskId, cwd);
  if (!task) {
    return engineError('E_NOT_FOUND', `Task ${params.taskId} not found`);
  }

  const evidence = extractEvidenceFromRaw(params.evidence);
  const autoRunTests = params.autoRunTests === true;

  const state = await advanceIvtr(params.taskId, evidence, {
    cwd,
    agentIdentity: params.agentIdentity,
  });

  // --auto-run-tests: when the new phase is 'test', invoke runGates atomically.
  let autoRunResult: Awaited<ReturnType<typeof autoRunGatesAndRecord>> | undefined;
  if (autoRunTests && state.currentPhase === 'test') {
    const acceptanceItems = (task.acceptance ?? []) as (string | object)[];
    const typedGateEntries = extractTypedGates(
      acceptanceItems as Parameters<typeof extractTypedGates>[0],
    );
    const gates = typedGateEntries.map((e) => e.gate);
    autoRunResult = await autoRunGatesAndRecord(params.taskId, gates, params.agentIdentity, cwd);
  }

  const acceptanceItems = (task.acceptance ?? []) as (string | object)[];
  const typedGates =
    state.currentPhase === 'test'
      ? extractTypedGates(acceptanceItems as Parameters<typeof extractTypedGates>[0]).map(
          (e) => e.gate,
        )
      : undefined;

  const prompt = resolvePhasePrompt(
    params.taskId,
    state,
    task.title,
    task.description ?? '(no description)',
    typedGates,
    [],
  );

  return engineSuccess({
    taskId: params.taskId,
    previousPhase: state.phaseHistory[state.phaseHistory.length - 2]?.phase ?? null,
    currentPhase: state.currentPhase,
    evidenceRecorded: evidence.length,
    resolvedPrompt: prompt,
    ...(autoRunResult
      ? {
          autoRunTests: {
            attachmentSha256: autoRunResult.attachmentSha256,
            testsPassed: autoRunResult.testsPassed,
            testsFailed: autoRunResult.testsFailed,
            exitCode: autoRunResult.exitCode,
            evidenceRecord: autoRunResult.evidenceRecord,
          },
        }
      : {}),
    message: `Phase advanced to '${state.currentPhase}' for task ${params.taskId}.${autoRunResult ? ` Auto-run gates: ${autoRunResult.testsPassed} passed, ${autoRunResult.testsFailed} failed.` : ''}`,
  });
}

async function ivtrReleaseOp(params: IvtrReleaseParams) {
  const cwd = getProjectRoot();
  const result = await releaseIvtr(params.taskId, { cwd });

  if (!result.released) {
    return {
      success: false,
      error: {
        code: 'E_IVTR_GATE_FAILED',
        message: `Release gate failed for task ${params.taskId}: ${result.failures?.join('; ')}`,
        details: { failures: result.failures },
      },
    };
  }

  // T820 RELEASE-07: Check sibling task release status for auto-suggestion.
  let autoSuggest: {
    epicId: string | null;
    epicFullyReleased: boolean;
    suggestedCommand: string | null;
    message: string;
  } | null = null;

  try {
    const suggestResult = await releaseIvtrAutoSuggest(params.taskId, cwd);
    if (suggestResult.success && suggestResult.data) {
      const d = suggestResult.data as {
        epicId: string | null;
        epicFullyReleased: boolean;
        suggestedCommand: string | null;
        message: string;
      };
      autoSuggest = {
        epicId: d.epicId,
        epicFullyReleased: d.epicFullyReleased,
        suggestedCommand: d.suggestedCommand,
        message: d.message,
      };
    }
  } catch {
    // Auto-suggest is best-effort; never block the release on its failure.
  }

  return {
    success: true,
    data: {
      taskId: params.taskId,
      released: true,
      message: `Task ${params.taskId} has been released. All IVTR phases passed. Status set to done.`,
      ...(autoSuggest ? { autoSuggest } : {}),
    },
  };
}

async function ivtrLoopBackOp(params: IvtrLoopBackParams) {
  const cwd = getProjectRoot();

  if (!isLoopBackTarget(params.phase)) {
    return {
      success: false,
      error: {
        code: 'E_INVALID_INPUT',
        message: `--phase must be one of: implement, validate, test. Got: '${params.phase}'`,
      },
    };
  }
  if (!params.reason) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: '--reason is required for loop-back' },
    };
  }

  const task = await getTask(params.taskId, cwd);
  if (!task) {
    return engineError('E_NOT_FOUND', `Task ${params.taskId} not found`);
  }

  const evidence = extractEvidenceFromRaw(params.evidence);

  let state: Awaited<ReturnType<typeof loopBackIvtr>>;
  try {
    state = await loopBackIvtr(params.taskId, params.phase, params.reason, evidence, {
      cwd,
      agentIdentity: params.agentIdentity,
    });
  } catch (loopBackErr) {
    const msg = loopBackErr instanceof Error ? loopBackErr.message : String(loopBackErr);
    if (msg.startsWith(E_IVTR_MAX_RETRIES)) {
      log.warn({ taskId: params.taskId, phase: params.phase }, 'IVTR max retries reached');
      return {
        success: false,
        error: {
          code: E_IVTR_MAX_RETRIES,
          message: msg,
          details: {
            taskId: params.taskId,
            phase: params.phase,
            hitlEscalation: true,
            escalationNote:
              'Maximum loop-backs reached. A human must inspect the loop-back history and resolve the root cause before the IVTR loop can continue.',
          },
        },
      };
    }
    throw loopBackErr;
  }

  const prompt = resolvePhasePrompt(
    params.taskId,
    state,
    task.title,
    task.description ?? '(no description)',
  );

  return {
    success: true,
    data: {
      taskId: params.taskId,
      loopedBackTo: params.phase,
      reason: params.reason,
      currentPhase: state.currentPhase,
      loopBackCount: state.loopBackCount ?? {
        implement: 0,
        validate: 0,
        test: 0,
        released: 0,
      },
      resolvedPrompt: prompt,
      message: `IVTR loop-back recorded. Phase rewound to '${params.phase}' for task ${params.taskId}.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Core op registry — OpsFromCore inference source
// ---------------------------------------------------------------------------

/**
 * IVTR operation registry used by the dispatch layer for
 * `OpsFromCore<typeof ivtrCoreOps>` inference.
 *
 * @task T1539 — ivtr dispatch OpsFromCore migration
 */
const ivtrCoreOps = {
  status: ivtrStatusOp,
  start: ivtrStartOp,
  next: ivtrNextOp,
  release: ivtrReleaseOp,
  'loop-back': ivtrLoopBackOp,
} as const;

// ---------------------------------------------------------------------------
// Typed operation record
// ---------------------------------------------------------------------------

/** Inferred typed operation record for the ivtr domain (ADR-058 · T1539). */
export type IvtrOps = OpsFromCore<typeof ivtrCoreOps>;

// ---------------------------------------------------------------------------
// Typed inner handler
// ---------------------------------------------------------------------------

/**
 * Typed inner handler for the IVTR domain.
 *
 * All per-op logic lives in the core op wrapper functions above.
 * Each case here is a single-line `wrapCoreResult` delegation (≤5 LOC).
 * The outer {@link IvtrHandler} class delegates to this via `typedDispatch`.
 *
 * @see ADR-058 — typed-dispatch migration
 * @task T1539 — ivtr OpsFromCore migration
 */
const _ivtrTypedHandler = defineTypedHandler<IvtrOps>('ivtr', {
  status: async (params) => {
    const result = await ivtrCoreOps.status(params);
    return result.success
      ? lafsSuccess(result.data, 'status')
      : lafsError(result.error?.code ?? 'E_INTERNAL', result.error?.message ?? '', 'status');
  },

  start: async (params) => {
    if (!params.taskId) return lafsError('E_INVALID_INPUT', 'taskId is required', 'start');
    const result = await ivtrCoreOps.start(params);
    return result.success
      ? lafsSuccess(result.data, 'start')
      : lafsError(result.error?.code ?? 'E_INTERNAL', result.error?.message ?? '', 'start');
  },

  next: async (params) => {
    if (!params.taskId) return lafsError('E_INVALID_INPUT', 'taskId is required', 'next');
    const result = await ivtrCoreOps.next(params);
    return result.success
      ? lafsSuccess(result.data, 'next')
      : lafsError(result.error?.code ?? 'E_INTERNAL', result.error?.message ?? '', 'next');
  },

  release: async (params) => {
    if (!params.taskId) return lafsError('E_INVALID_INPUT', 'taskId is required', 'release');
    const result = await ivtrCoreOps.release(params);
    return result.success
      ? lafsSuccess(result.data, 'release')
      : lafsError(result.error?.code ?? 'E_INTERNAL', result.error?.message ?? '', 'release');
  },

  'loop-back': async (params) => {
    if (!params.taskId) return lafsError('E_INVALID_INPUT', 'taskId is required', 'loop-back');
    const result = await ivtrCoreOps['loop-back'](params);
    return result.success
      ? lafsSuccess(result.data, 'loop-back')
      : lafsError(result.error?.code ?? 'E_INTERNAL', result.error?.message ?? '', 'loop-back');
  },
});

// ---------------------------------------------------------------------------
// IvtrHandler
// ---------------------------------------------------------------------------

/**
 * Standalone domain handler for IVTR orchestration operations.
 *
 * Designed to be instantiated by the `OrchestrateHandler` and delegated to
 * for all `ivtr.*` sub-operations. Not registered as a top-level domain name
 * in the domain registry — accessed via `orchestrate.ivtr.*`.
 *
 * Delegates all operations to the typed inner handler via `typedDispatch`.
 * Zero `params?.x as Type` casts — all param access is type-safe.
 *
 * @task T1539 — OpsFromCore migration per ADR-058
 */
export class IvtrHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // query — read-only
  // -----------------------------------------------------------------------

  /**
   * Handle read-only IVTR queries.
   *
   * Supported operations:
   * - `status` — return IvtrState + resolved summary for a task
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    const queryOps = new Set<string>(['status']);

    if (!queryOps.has(operation)) {
      return unsupportedOp('query', 'ivtr', operation, startTime);
    }

    try {
      // Validate taskId before dispatching — gives correct E_INVALID_INPUT error code.
      if (!params?.['taskId']) {
        return {
          meta: dispatchMeta('query', 'ivtr', operation, startTime),
          success: false,
          error: { code: 'E_INVALID_INPUT', message: 'taskId is required' },
        };
      }

      const envelope = await typedDispatch(
        _ivtrTypedHandler,
        operation as keyof IvtrOps & string,
        params ?? {},
      );

      return {
        meta: dispatchMeta('query', 'ivtr', operation, startTime),
        success: envelope.success,
        ...(envelope.success
          ? { data: envelope.data as unknown }
          : {
              error: {
                code:
                  envelope.error?.code !== undefined ? String(envelope.error.code) : 'E_INTERNAL',
                message: envelope.error?.message ?? 'Unknown error',
              },
            }),
      };
    } catch (err) {
      log.error({ err, operation }, 'IvtrHandler query error');
      return handleErrorResult('query', 'ivtr', operation, err, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // mutate — state-modifying
  // -----------------------------------------------------------------------

  /**
   * Handle state-modifying IVTR mutations.
   *
   * Supported operations:
   * - `start`     — begin Implement phase, return resolved prompt
   * - `next`      — advance from current phase to next, return prompt for next phase
   * - `release`   — run final gate, mark task done
   * - `loop-back` — rewind to specified phase with failure evidence
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    const mutateOps = new Set<string>(['start', 'next', 'release', 'loop-back']);

    if (!mutateOps.has(operation)) {
      return unsupportedOp('mutate', 'ivtr', operation, startTime);
    }

    try {
      // Validate taskId before dispatching — gives correct E_INVALID_INPUT error code.
      if (!params?.['taskId']) {
        return {
          meta: dispatchMeta('mutate', 'ivtr', operation, startTime),
          success: false,
          error: { code: 'E_INVALID_INPUT', message: 'taskId is required' },
        };
      }

      const envelope = await typedDispatch(
        _ivtrTypedHandler,
        operation as keyof IvtrOps & string,
        params ?? {},
      );

      return {
        meta: dispatchMeta('mutate', 'ivtr', operation, startTime),
        success: envelope.success,
        ...(envelope.success
          ? { data: envelope.data as unknown }
          : {
              error: {
                code:
                  envelope.error?.code !== undefined ? String(envelope.error.code) : 'E_INTERNAL',
                message: envelope.error?.message ?? 'Unknown error',
              },
            }),
      };
    } catch (err) {
      log.error({ err, operation }, 'IvtrHandler mutate error');
      return handleErrorResult('mutate', 'ivtr', operation, err, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  /** Return declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['status'],
      mutate: ['start', 'next', 'release', 'loop-back'],
    };
  }
}
