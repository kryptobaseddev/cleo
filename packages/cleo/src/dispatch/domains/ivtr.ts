/**
 * IVTR Dispatch Domain Handler
 *
 * Handles `cleo orchestrate ivtr <taskId> --<action>` operations.
 *
 * Operations (all routed through this handler):
 *
 * QUERY:
 *   status     — return current phase + evidence list + phase history
 *                (reads the retained `ivtr_state` column via `getIvtrState`)
 *
 * MUTATE (DEPRECATED — T11896 · T11764 state-machine collapse):
 *   start / next / release / loop-back — the hand-rolled per-step phase walk
 *   (`startIvtr`/`advanceIvtr`/`releaseIvtr`/`loopBackIvtr`) has been collapsed
 *   into the cantbook runtime (the survivor state machine). There is no per-step
 *   primitive on the runtime to map these 1:1 onto — `executePlaybook` /
 *   `resumePlaybook` drive an ENTIRE run, not a single phase advance — so each
 *   mutate op now returns a typed {@link E_DEPRECATED_USE_PLAYBOOK} error with
 *   an ADR-086 migration-hint envelope (`fix` + `details.migration` +
 *   `alternatives`) instead of silently breaking. The autonomous IVTR loop is
 *   `cleo go` (T11896 — defaults to `executePlaybook(ivtr.cantbook)`); a manual
 *   run is `cleo playbook run ivtr --context '{"taskId":"T###"}'`.
 *
 * The `status` query stays intact — it backs `cleo show --ivtr-history` and the
 * strict `E_IVTR_INCOMPLETE` completion gate keeps reading the same column.
 *
 * Type-safe dispatch via `TypedDomainHandler<IvtrOps>` per ADR-058.
 * Param extraction inferred via `OpsFromCore<typeof ivtrCoreOps>`.
 * Zero `params?.x as Type` casts at call sites.
 *
 * @epic T810
 * @task T811
 * @task T1539 — OpsFromCore migration per ADR-058
 * @task T11896 — mutate ops redirected onto the cantbook runtime (collapse)
 */

import type { EngineResult } from '@cleocode/core';
import type { IvtrPhase, IvtrPhaseEntry } from '@cleocode/core/internal';
import { getIvtrState, getLogger, getProjectRoot } from '@cleocode/core/internal';
import { engineSuccess } from '@cleocode/runtime/gateway';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
} from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp } from './_base.js';
import { dispatchMeta } from './_meta.js';

const log = getLogger('domain:ivtr');

/**
 * Error code returned by every deprecated IVTR mutate op (`start`/`next`/
 * `release`/`loop-back`) after the T11764 state-machine collapse.
 *
 * The hand-rolled per-step phase walk was folded into the cantbook runtime
 * (the survivor state machine). Because the runtime exposes whole-run
 * primitives (`executePlaybook`/`resumePlaybook`) rather than per-phase steps,
 * the manual ops have no 1:1 redirect target and instead surface this typed
 * error with an ADR-086 migration-hint envelope. Read ops are unaffected.
 *
 * @task T11896
 */
export const E_DEPRECATED_USE_PLAYBOOK = 'E_DEPRECATED_USE_PLAYBOOK' as const;

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
// Deprecation envelope (T11896 · collapse)
// ---------------------------------------------------------------------------

/**
 * Structured `details` payload attached to the {@link E_DEPRECATED_USE_PLAYBOOK}
 * envelope so machine consumers (and `cleo show --human`) can route on the
 * migration metadata rather than parsing prose. Conforms to the ADR-086
 * `DispatchError.details` contract.
 *
 * @task T11896
 */
interface IvtrMigrationDetails {
  /** Always `'T11764-state-machine-collapse'` — the supersession source. */
  deprecatedBy: 'T11764-state-machine-collapse';
  /** The IVTR mutate op the caller invoked (`start`/`next`/`release`/`loop-back`). */
  deprecatedOp: string;
  /** Task the caller was driving, when supplied. */
  taskId?: string;
  /** The survivor state machine the loop now runs on. */
  survivor: 'cantbook-runtime (ivtr.cantbook)';
  /** Autonomous replacement command (default path). */
  autonomous: string;
  /** Manual single-run replacement command. */
  manual: string;
}

/**
 * Build the typed {@link E_DEPRECATED_USE_PLAYBOOK} LAFS error envelope for a
 * deprecated IVTR mutate op.
 *
 * Carries an ADR-086 migration-hint payload: a copy-paste `fix`, a structured
 * `details.migration` object, and `alternatives` so no behaviour is orphaned
 * silently — the caller is told exactly which command replaces the manual walk.
 *
 * @param op - The deprecated mutate op name (`start`/`next`/`release`/`loop-back`).
 * @param taskId - Task the caller was driving (for the migration command), or
 *   `undefined` when the caller omitted it.
 * @returns A `LafsError` envelope with `code`, `message`, `fix`, and `details`.
 * @task T11896
 */
function deprecatedMutateEnvelope(op: string, taskId: string | undefined) {
  const id = taskId ?? 'T####';
  const manual = `cleo playbook run ivtr --context '{"taskId":"${id}"}'`;
  const autonomous = 'cleo go';
  const migration: IvtrMigrationDetails = {
    deprecatedBy: 'T11764-state-machine-collapse',
    deprecatedOp: op,
    survivor: 'cantbook-runtime (ivtr.cantbook)',
    autonomous,
    manual,
    ...(taskId !== undefined ? { taskId } : {}),
  };
  return lafsError(
    E_DEPRECATED_USE_PLAYBOOK,
    `'cleo orchestrate ivtr --${op}' is deprecated. The hand-rolled IVTR phase ` +
      `walk was collapsed into the cantbook runtime (T11764). Drive IVTR through ` +
      `the playbook runtime instead: '${autonomous}' (autonomous, default) or ` +
      `'${manual}' (single manual run).`,
    op,
    manual,
    {
      migration: migration as unknown as Record<string, unknown>,
      alternatives: [
        { action: 'Autonomous IVTR loop (default)', command: autonomous },
        { action: 'Manual single IVTR run', command: manual },
      ],
    },
  );
}

/** A single ADR-086 `DispatchError.alternatives` entry. */
interface AlternativeAction {
  action: string;
  command: string;
}

/**
 * Type guard for an {@link AlternativeAction} list — used to narrow the
 * `details.alternatives` value lifted off the deprecation envelope before it is
 * forwarded onto the typed `DispatchError.alternatives` field (zero `any`).
 *
 * @task T11896
 */
function isAlternativesList(value: unknown): value is AlternativeAction[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v): v is AlternativeAction =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as { action?: unknown }).action === 'string' &&
        typeof (v as { command?: unknown }).command === 'string',
    )
  );
}

// ---------------------------------------------------------------------------
// Core op wrappers — single-param functions for OpsFromCore inference
//
// `status` reads the retained `ivtr_state` column; the four mutate ops are
// DEPRECATED stubs (T11896) whose typed handler returns the migration envelope.
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

async function ivtrStatusOp(params: IvtrStatusParams): Promise<EngineResult<IvtrStatusResult>> {
  const cwd = getProjectRoot();
  const state = await getIvtrState(params.taskId, { cwd });

  if (!state) {
    return engineSuccess({
      taskId: params.taskId,
      started: false,
      currentPhase: null,
      phaseHistory: [] as IvtrPhaseEntry[],
      message:
        `Task ${params.taskId} has no IVTR state. The IVTR loop now runs on the ` +
        `cantbook runtime (T11764) — drive it with 'cleo go' (autonomous) or ` +
        `'cleo playbook run ivtr --context '{"taskId":"${params.taskId}"}''.`,
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

/**
 * Result shape shared by the four deprecated mutate stubs.
 *
 * The stubs exist purely to carry the `OpsFromCore` param typing for the typed
 * handler — the actual deprecation envelope is built in {@link _ivtrTypedHandler}
 * via {@link deprecatedMutateEnvelope}, so the stub bodies are never invoked on
 * the success path. They return a frozen {@link E_DEPRECATED_USE_PLAYBOOK}
 * failure so a stray direct call (e.g. a test) still fails closed rather than
 * resolving an empty success.
 *
 * @task T11896
 */
type IvtrDeprecatedResult = EngineResult<never>;

/** Frozen failure result returned by the four deprecated mutate stubs. */
const DEPRECATED_OP_RESULT: IvtrDeprecatedResult = {
  success: false,
  error: { code: E_DEPRECATED_USE_PLAYBOOK, message: 'IVTR mutate ops are deprecated (T11764).' },
};

/**
 * `start` op — DEPRECATED. The IVTR loop now runs on the cantbook runtime
 * (T11764). Param typing is retained for `OpsFromCore` inference; the handler
 * returns the {@link E_DEPRECATED_USE_PLAYBOOK} migration envelope.
 *
 * @task T11896
 */
function ivtrStartOp(_params: IvtrStartParams): Promise<IvtrDeprecatedResult> {
  return Promise.resolve(DEPRECATED_OP_RESULT);
}

/**
 * `next` op — DEPRECATED (see {@link ivtrStartOp}).
 * @task T11896
 */
function ivtrNextOp(_params: IvtrNextParams): Promise<IvtrDeprecatedResult> {
  return Promise.resolve(DEPRECATED_OP_RESULT);
}

/**
 * `release` op — DEPRECATED (see {@link ivtrStartOp}).
 * @task T11896
 */
function ivtrReleaseOp(_params: IvtrReleaseParams): Promise<IvtrDeprecatedResult> {
  return Promise.resolve(DEPRECATED_OP_RESULT);
}

/**
 * `loop-back` op — DEPRECATED (see {@link ivtrStartOp}).
 * @task T11896
 */
function ivtrLoopBackOp(_params: IvtrLoopBackParams): Promise<IvtrDeprecatedResult> {
  return Promise.resolve(DEPRECATED_OP_RESULT);
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

  // ── DEPRECATED mutate ops (T11896 · T11764 collapse) ────────────────────
  // The per-step phase walk has no 1:1 mapping onto the whole-run cantbook
  // primitives (`executePlaybook`/`resumePlaybook`), so each op returns the
  // typed E_DEPRECATED_USE_PLAYBOOK migration envelope (ADR-086) rather than
  // silently breaking. `params.taskId` is woven into the migration command.
  start: async (params) => deprecatedMutateEnvelope('start', params.taskId),
  next: async (params) => deprecatedMutateEnvelope('next', params.taskId),
  release: async (params) => deprecatedMutateEnvelope('release', params.taskId),
  'loop-back': async (params) => deprecatedMutateEnvelope('loop-back', params.taskId),
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
   * Handle state-modifying IVTR mutations — all DEPRECATED (T11896).
   *
   * `start`/`next`/`release`/`loop-back` are no longer driven by the hand-rolled
   * phase walk; each returns the typed {@link E_DEPRECATED_USE_PLAYBOOK}
   * migration envelope (carrying `fix`, `details.migration`, and `alternatives`
   * per ADR-086) so the caller is routed onto the cantbook runtime. The full
   * migration-hint payload is forwarded onto the `DispatchResponse.error` —
   * nothing is orphaned silently.
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    const mutateOps = new Set<string>(['start', 'next', 'release', 'loop-back']);

    if (!mutateOps.has(operation)) {
      return unsupportedOp('mutate', 'ivtr', operation, startTime);
    }

    try {
      // NOTE (T11896): unlike the pre-collapse handler, taskId is NOT required
      // up front — the deprecation migration envelope is returned regardless so
      // even a malformed `cleo orchestrate ivtr --next` surfaces the migration
      // hint rather than a generic E_INVALID_INPUT.
      const envelope = await typedDispatch(
        _ivtrTypedHandler,
        operation as keyof IvtrOps & string,
        params ?? {},
      );

      if (envelope.success) {
        return {
          meta: dispatchMeta('mutate', 'ivtr', operation, startTime),
          success: true,
          data: envelope.data as unknown,
        };
      }

      // Forward the full ADR-086 migration-hint payload (fix + details +
      // alternatives) onto the dispatch error so the CLI renderer surfaces it.
      const err = envelope.error;
      const error: NonNullable<DispatchResponse['error']> = {
        code: err?.code !== undefined ? String(err.code) : 'E_INTERNAL',
        message: err?.message ?? 'Unknown error',
      };
      if (err?.fix !== undefined) error.fix = err.fix;
      if (err?.details !== undefined) error.details = err.details;
      const alternatives = err?.details?.['alternatives'];
      if (isAlternativesList(alternatives)) error.alternatives = alternatives;
      return {
        meta: dispatchMeta('mutate', 'ivtr', operation, startTime),
        success: false,
        error,
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
