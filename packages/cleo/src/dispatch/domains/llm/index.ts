/**
 * LLM Domain Handler — `cleo llm` CLI surface.
 *
 * Surfaces the multi-credential pool (`addCredential` / `listCredentials` /
 * `removeCredential` / `getCredentialByLabel`), the role-aware resolver
 * (`resolveLLMForRole`), and the config writer (`setConfigValue`) through
 * the standard CQRS dispatch shape.
 *
 * Mirrors the typed-adapter pattern used by `sentient` (`Wave D · T1421`):
 * the core operation registry is converted to a `TypedDomainHandler` via
 * `OpsFromCore`, and the cast at `typedDispatch` is the single trust
 * boundary between the untyped registry and the typed per-op params.
 *
 * @task T9258
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import {
  llmAdd,
  llmAuxiliaryStatus,
  llmList,
  llmProfile,
  llmRemove,
  llmTest,
  llmUse,
  llmWhoami,
} from '@cleocode/core/internal';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
} from '../../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../../types.js';
import { envelopeToEngineResult, handleErrorResult, unsupportedOp, wrapResult } from '../_base.js';

// ---------------------------------------------------------------------------
// Core operation registry
// ---------------------------------------------------------------------------

const coreOps = {
  list: llmList,
  test: llmTest,
  whoami: llmWhoami,
  'auxiliary-status': llmAuxiliaryStatus,
  add: llmAdd,
  remove: llmRemove,
  use: llmUse,
  profile: llmProfile,
} as const;

type LlmOps = OpsFromCore<typeof coreOps>;

// ---------------------------------------------------------------------------
// Typed inner handler
// ---------------------------------------------------------------------------

/**
 * Unwrap an `EngineResult` into a LAFS envelope. Mirrors the inline pattern
 * used by other domains (sentient, admin) so the typed adapter sees the same
 * shape regardless of whether the core op returns a value or an
 * `EngineResult` discriminated union.
 */
async function wrap<P, R>(
  op: (params: P) => Promise<
    | {
        success: true;
        data: R;
      }
    | {
        success: false;
        error: { code: string | number; message: string };
      }
  >,
  params: P,
  label: string,
): Promise<ReturnType<typeof lafsSuccess<R>> | ReturnType<typeof lafsError>> {
  try {
    const result = await op(params);
    if (result.success) return lafsSuccess(result.data, label);
    return lafsError(String(result.error.code), result.error.message, label);
  } catch (err) {
    return lafsError('E_INTERNAL', err instanceof Error ? err.message : String(err), label);
  }
}

const _llmTypedHandler = defineTypedHandler<LlmOps>('llm', {
  // -------------------------------------------------------------------------
  // Query ops
  // -------------------------------------------------------------------------

  list: async (params) => wrap(coreOps['list'], params, 'list'),
  test: async (params) => wrap(coreOps['test'], params, 'test'),
  whoami: async (params) => wrap(coreOps['whoami'], params, 'whoami'),
  'auxiliary-status': async (params) =>
    wrap(coreOps['auxiliary-status'], params, 'auxiliary-status'),

  // -------------------------------------------------------------------------
  // Mutate ops
  // -------------------------------------------------------------------------

  add: async (params) => wrap(coreOps['add'], params, 'add'),
  remove: async (params) => wrap(coreOps['remove'], params, 'remove'),
  use: async (params) => wrap(coreOps['use'], params, 'use'),
  profile: async (params) => wrap(coreOps['profile'], params, 'profile'),
});

// ---------------------------------------------------------------------------
// Op sets — validated before dispatch
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>(['list', 'test', 'whoami', 'auxiliary-status']);
const MUTATE_OPS = new Set<string>(['add', 'remove', 'use', 'profile']);

// ---------------------------------------------------------------------------
// LlmHandler — DomainHandler-compatible wrapper for the registry
// ---------------------------------------------------------------------------

/**
 * Domain handler for the `llm` domain.
 *
 * Delegates all per-op logic to the typed inner handler `_llmTypedHandler`
 * (a `TypedDomainHandler<LlmOps>`). This satisfies the registry's
 * `DomainHandler` interface while keeping every param access fully
 * type-safe via the Wave D adapter.
 *
 * @task T9258
 */
export class LlmHandler implements DomainHandler {
  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['list', 'test', 'whoami', 'auxiliary-status'],
      mutate: ['add', 'remove', 'use', 'profile'],
    };
  }

  /**
   * Execute a read-only llm query operation.
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'llm', operation, startTime);
    }

    try {
      const envelope = await typedDispatch(
        _llmTypedHandler,
        operation as keyof LlmOps & string,
        params ?? {},
      );
      return wrapResult(envelopeToEngineResult(envelope), 'query', 'llm', operation, startTime);
    } catch (error) {
      return handleErrorResult('query', 'llm', operation, error, startTime);
    }
  }

  /**
   * Execute a state-modifying llm mutate operation.
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'llm', operation, startTime);
    }

    try {
      const envelope = await typedDispatch(
        _llmTypedHandler,
        operation as keyof LlmOps & string,
        params ?? {},
      );
      return wrapResult(envelopeToEngineResult(envelope), 'mutate', 'llm', operation, startTime);
    } catch (error) {
      return handleErrorResult('mutate', 'llm', operation, error, startTime);
    }
  }
}
