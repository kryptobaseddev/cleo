/**
 * Sentient Domain Handler — Tier-2 proposal management via dispatch.
 *
 * Operations:
 *   propose.list    (query)  — list tasks with status='proposed'
 *   propose.accept  (mutate) — transition proposed → pending (owner action)
 *   propose.reject  (mutate) — transition proposed → cancelled
 *   propose.diff    (query)  — show what a proposal would change (Tier-3 stub)
 *   propose.run     (mutate) — manually trigger a single propose tick in-process
 *   propose.enable  (mutate) — enable Tier-2 proposals (M7 gate)
 *   propose.disable (mutate) — disable Tier-2 proposals
 *   allowlist.list  (query)  — list owner pubkeys
 *   allowlist.add   (mutate) — add a pubkey to the allowlist
 *   allowlist.remove (mutate) — remove a pubkey from the allowlist
 *
 * All operations emit LAFS-compliant envelopes.
 *
 * Handler uses TypedDomainHandler<SentientOps> (Wave D · T975 follow-on)
 * to eliminate param casts. Zero `as string` / `as unknown` param casts in
 * per-op code. Single boundary cast inside typedDispatch (T974 adapter).
 *
 * Core functions live in packages/core/src/sentient/ops.ts (ADR-057 D1).
 *
 * @task T1008
 * @task T1421 — typed narrowing migration (Wave D follow-on)
 * @task T1457 — sentient domain Core API alignment
 * @see ADR-054 — Sentient Loop Tier-2
 * @see ADR-057 — Core API normalization
 */

import type {
  AllowlistAddParams,
  AllowlistListParams,
  AllowlistRemoveParams,
  ProposeAcceptParams,
  ProposeDiffParams,
  ProposeDisableParams,
  ProposeEnableParams,
  ProposeListParams,
  ProposeRejectParams,
  ProposeRunParams,
  SentientOps,
} from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import {
  sentientAllowlistAdd,
  sentientAllowlistList,
  sentientAllowlistRemove,
  sentientProposeAccept,
  sentientProposeDiff,
  sentientProposeDisable,
  sentientProposeEnable,
  sentientProposeList,
  sentientProposeReject,
  sentientProposeRun,
} from '@cleocode/core/sentient';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch } from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// Typed inner handler (Wave D · T1421)
// ---------------------------------------------------------------------------

const _sentientTypedHandler = defineTypedHandler<SentientOps>('sentient', {
  // -------------------------------------------------------------------------
  // Query ops
  // -------------------------------------------------------------------------

  'propose.list': async (params: ProposeListParams) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await sentientProposeList(projectRoot, params);
      return lafsSuccess(data, 'propose.list');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_INTERNAL', message, 'propose.list');
    }
  },

  'propose.diff': async (params: ProposeDiffParams) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await sentientProposeDiff(projectRoot, params);
      return lafsSuccess(data, 'propose.diff');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_INTERNAL', message, 'propose.diff');
    }
  },

  'allowlist.list': async (_params: AllowlistListParams) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await sentientAllowlistList(projectRoot, _params);
      return lafsSuccess(data, 'allowlist.list');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_INTERNAL', message, 'allowlist.list');
    }
  },

  // -------------------------------------------------------------------------
  // Mutate ops
  // -------------------------------------------------------------------------

  'propose.accept': async (params: ProposeAcceptParams) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await sentientProposeAccept(projectRoot, params);
      return lafsSuccess(data, 'propose.accept');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'E_INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      return lafsError(code, message, 'propose.accept');
    }
  },

  'propose.reject': async (params: ProposeRejectParams) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await sentientProposeReject(projectRoot, params);
      return lafsSuccess(data, 'propose.reject');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'E_INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      return lafsError(code, message, 'propose.reject');
    }
  },

  'propose.run': async (_params: ProposeRunParams) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await sentientProposeRun(projectRoot, _params);
      return lafsSuccess(data, 'propose.run');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_INTERNAL', message, 'propose.run');
    }
  },

  'propose.enable': async (_params: ProposeEnableParams) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await sentientProposeEnable(projectRoot, _params);
      return lafsSuccess(data, 'propose.enable');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'E_INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      return lafsError(code, message, 'propose.enable');
    }
  },

  'propose.disable': async (_params: ProposeDisableParams) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await sentientProposeDisable(projectRoot, _params);
      return lafsSuccess(data, 'propose.disable');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_INTERNAL', message, 'propose.disable');
    }
  },

  'allowlist.add': async (params: AllowlistAddParams) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await sentientAllowlistAdd(projectRoot, params);
      return lafsSuccess(data, 'allowlist.add');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_ALLOWLIST_ADD', message, 'allowlist.add');
    }
  },

  'allowlist.remove': async (params: AllowlistRemoveParams) => {
    const projectRoot = getProjectRoot();
    try {
      const data = await sentientAllowlistRemove(projectRoot, params);
      return lafsSuccess(data, 'allowlist.remove');
    } catch (err) {
      const code =
        (err as NodeJS.ErrnoException).code === 'E_ALLOWLIST_KEY_NOT_FOUND'
          ? 'E_ALLOWLIST_KEY_NOT_FOUND'
          : 'E_ALLOWLIST_REMOVE';
      const message = err instanceof Error ? err.message : String(err);
      return lafsError(code, message, 'allowlist.remove');
    }
  },
});

// ---------------------------------------------------------------------------
// Envelope-to-EngineResult adapter
// ---------------------------------------------------------------------------

/**
 * Convert a LAFS envelope into the minimal EngineResult shape expected by
 * {@link wrapResult}.
 *
 * T1434: accept the canonical LafsEnvelope shape from contracts where
 * `error.code` is `string | number`. The dispatch wire format requires a
 * string `code`; stringify on the boundary.
 *
 * @internal
 */
function envelopeToEngineResult(envelope: {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string | number; readonly message: string };
}): {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
} {
  if (envelope.success) {
    return { success: true, data: envelope.data };
  }
  return {
    success: false,
    error: {
      code: envelope.error?.code !== undefined ? String(envelope.error.code) : 'E_INTERNAL',
      message: envelope.error?.message ?? 'Unknown error',
    },
  };
}

// ---------------------------------------------------------------------------
// Op sets
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>(['propose.list', 'propose.diff', 'allowlist.list']);

const MUTATE_OPS = new Set<string>([
  'propose.accept',
  'propose.reject',
  'propose.run',
  'propose.enable',
  'propose.disable',
  'allowlist.add',
  'allowlist.remove',
]);

// ---------------------------------------------------------------------------
// SentientHandler — DomainHandler-compatible wrapper for the registry
// ---------------------------------------------------------------------------

/**
 * Domain handler for the `sentient` domain.
 *
 * Delegates all per-op logic to the typed inner handler
 * `_sentientTypedHandler` (a `TypedDomainHandler<SentientOps>`). This
 * satisfies the registry's `DomainHandler` interface while keeping every
 * param access fully type-safe via the Wave D adapter.
 */
export class SentientHandler implements DomainHandler {
  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['propose.list', 'propose.diff', 'allowlist.list'],
      mutate: [
        'propose.accept',
        'propose.reject',
        'propose.run',
        'propose.enable',
        'propose.disable',
        'allowlist.add',
        'allowlist.remove',
      ],
    };
  }

  /**
   * Execute a read-only sentient query operation.
   *
   * @param operation - The sentient query op name (e.g. 'propose.list').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'sentient', operation, startTime);
    }

    try {
      const envelope = await typedDispatch(
        _sentientTypedHandler,
        operation as keyof SentientOps & string,
        params ?? {},
      );
      return wrapResult(
        envelopeToEngineResult(envelope),
        'query',
        'sentient',
        operation,
        startTime,
      );
    } catch (error) {
      return handleErrorResult('query', 'sentient', operation, error, startTime);
    }
  }

  /**
   * Execute a state-modifying sentient mutation operation.
   *
   * @param operation - The sentient mutate op name (e.g. 'propose.accept').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'sentient', operation, startTime);
    }

    try {
      const envelope = await typedDispatch(
        _sentientTypedHandler,
        operation as keyof SentientOps & string,
        params ?? {},
      );
      return wrapResult(
        envelopeToEngineResult(envelope),
        'mutate',
        'sentient',
        operation,
        startTime,
      );
    } catch (error) {
      return handleErrorResult('mutate', 'sentient', operation, error, startTime);
    }
  }
}
