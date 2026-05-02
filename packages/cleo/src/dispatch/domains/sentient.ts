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
 * Handler uses TypedDomainHandler<OpsFromCore<typeof coreOps>> (Wave D · T975 follow-on)
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
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
} from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { envelopeToEngineResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// Core operation registry
// ---------------------------------------------------------------------------

const coreOps = {
  'propose.list': (params: Parameters<typeof sentientProposeList>[1]) =>
    sentientProposeList(getProjectRoot(), params),
  'propose.diff': (params: Parameters<typeof sentientProposeDiff>[1]) =>
    sentientProposeDiff(getProjectRoot(), params),
  'allowlist.list': (params: Parameters<typeof sentientAllowlistList>[1]) =>
    sentientAllowlistList(getProjectRoot(), params),
  'propose.accept': (params: Parameters<typeof sentientProposeAccept>[1]) =>
    sentientProposeAccept(getProjectRoot(), params),
  'propose.reject': (params: Parameters<typeof sentientProposeReject>[1]) =>
    sentientProposeReject(getProjectRoot(), params),
  'propose.run': (params: Parameters<typeof sentientProposeRun>[1]) =>
    sentientProposeRun(getProjectRoot(), params),
  'propose.enable': (params: Parameters<typeof sentientProposeEnable>[1]) =>
    sentientProposeEnable(getProjectRoot(), params),
  'propose.disable': (params: Parameters<typeof sentientProposeDisable>[1]) =>
    sentientProposeDisable(getProjectRoot(), params),
  'allowlist.add': (params: Parameters<typeof sentientAllowlistAdd>[1]) =>
    sentientAllowlistAdd(getProjectRoot(), params),
  'allowlist.remove': (params: Parameters<typeof sentientAllowlistRemove>[1]) =>
    sentientAllowlistRemove(getProjectRoot(), params),
} as const;

type SentientOps = OpsFromCore<typeof coreOps>;

// ---------------------------------------------------------------------------
// Typed inner handler (Wave D · T1421)
// ---------------------------------------------------------------------------

const _sentientTypedHandler = defineTypedHandler<SentientOps>('sentient', {
  // -------------------------------------------------------------------------
  // Query ops
  // -------------------------------------------------------------------------

  'propose.list': async (params) => {
    try {
      const data = await coreOps['propose.list'](params);
      return lafsSuccess(data, 'propose.list');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_INTERNAL', message, 'propose.list');
    }
  },

  'propose.diff': async (params) => {
    try {
      const data = await coreOps['propose.diff'](params);
      return lafsSuccess(data, 'propose.diff');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_INTERNAL', message, 'propose.diff');
    }
  },

  'allowlist.list': async (_params) => {
    try {
      const data = await coreOps['allowlist.list'](_params);
      return lafsSuccess(data, 'allowlist.list');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_INTERNAL', message, 'allowlist.list');
    }
  },

  // -------------------------------------------------------------------------
  // Mutate ops
  // -------------------------------------------------------------------------

  'propose.accept': async (params) => {
    try {
      const data = await coreOps['propose.accept'](params);
      return lafsSuccess(data, 'propose.accept');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'E_INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      return lafsError(code, message, 'propose.accept');
    }
  },

  'propose.reject': async (params) => {
    try {
      const data = await coreOps['propose.reject'](params);
      return lafsSuccess(data, 'propose.reject');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'E_INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      return lafsError(code, message, 'propose.reject');
    }
  },

  'propose.run': async (_params) => {
    try {
      const data = await coreOps['propose.run'](_params);
      return lafsSuccess(data, 'propose.run');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_INTERNAL', message, 'propose.run');
    }
  },

  'propose.enable': async (_params) => {
    try {
      const data = await coreOps['propose.enable'](_params);
      return lafsSuccess(data, 'propose.enable');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'E_INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      return lafsError(code, message, 'propose.enable');
    }
  },

  'propose.disable': async (_params) => {
    try {
      const data = await coreOps['propose.disable'](_params);
      return lafsSuccess(data, 'propose.disable');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_INTERNAL', message, 'propose.disable');
    }
  },

  'allowlist.add': async (params) => {
    try {
      const data = await coreOps['allowlist.add'](params);
      return lafsSuccess(data, 'allowlist.add');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return lafsError('E_ALLOWLIST_ADD', message, 'allowlist.add');
    }
  },

  'allowlist.remove': async (params) => {
    try {
      const data = await coreOps['allowlist.remove'](params);
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
