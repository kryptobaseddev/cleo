/**
 * Self-improvement scenario replay via an injected dispatch port (T11889-B).
 *
 * `replayScenario` replays a scenario's ordered ops through an injected
 * {@link ReplayDispatch} port — it captures ONE LAFS envelope per op. CORE owns
 * the PORT TYPE only; the real adapter (a thin closure over the cleo-resident
 * `Dispatcher`) is supplied by `packages/cleo` at the call site (dependency
 * inversion — `core` MUST NOT import the cleo dispatcher, and `dispatchFromCore`
 * does not exist; see the P5 self-improvement spec §B.0.1).
 *
 * This module is PURE — no DB, no native handle, no `cleo` mutation. Tests inject
 * a mocked `ReplayDispatch`. Import-time side-effect-free: the logger is resolved
 * lazily on first use.
 *
 * Read-only guarantee: in the in-process fallback (no VM isolation) a `mutate` op
 * could touch a live handle, so {@link replayScenario} HARD-REJECTS any
 * `gateway:'mutate'` op when `allowMutate` is not explicitly set, throwing
 * {@link MutateInFallbackError} (code `E_SELFIMPROVE_MUTATE_IN_FALLBACK`). The
 * canned dogfood scenario is `query`-only, so the default replay never mutates.
 *
 * @module @cleocode/core/selfimprove/replay
 * @epic T11889
 * @task T11912
 */

import type { DispatchResponse } from '@cleocode/contracts/gateway';
import type { Logger } from 'pino';
import type { Scenario, ScenarioOp } from './scenario.js';

/**
 * The captured envelope shape per replayed op.
 *
 * This is the canonical {@link DispatchResponse} the cleo-side `Dispatcher`
 * returns (a `meta` block + `success` + optional `data`/`error`/`page`/`partial`).
 * The diff layer (see {@link "./envelope-diff.js"}) normalizes this by stripping
 * the volatile `meta` fields before comparing against the golden.
 */
export type ReplayEnvelope = DispatchResponse;

/**
 * Narrow dispatch port the replay engine calls — CORE owns this TYPE, NOT the impl.
 *
 * The cleo dispatch handler supplies the concrete adapter by closing over its
 * already-instantiated `Dispatcher` (`dispatcher.dispatch({ gateway, domain,
 * operation, params, source, requestId })`, where `source` is a valid
 * `GatewaySource` — e.g. `'rpc'`) and returning the resulting envelope. Injecting
 * the port keeps the engine + diff + budget logic
 * in `core` while the dispatcher binding lives in `cleo` (CORE-first, no
 * package-boundary inversion).
 */
/**
 * The dispatch coordinate handed to a {@link ReplayDispatch} port for one op.
 */
export interface ReplayDispatchOp {
  /** CQRS gateway. */
  gateway: ScenarioOp['gateway'];
  /** Registered domain handler key (plural, e.g. `'tasks'`). */
  domain: string;
  /** Operation name within the domain. */
  operation: string;
  /** Optional operation parameters. */
  params?: Record<string, unknown>;
}

/**
 * Dispatch a single op and return its captured envelope.
 *
 * @param op - The dispatch coordinate (gateway, domain, operation, params).
 * @returns The captured {@link ReplayEnvelope}.
 */
export type ReplayDispatch = (op: ReplayDispatchOp) => Promise<ReplayEnvelope>;

/** Options controlling a replay run. */
export interface ReplayOptions {
  /**
   * When `true`, permit `gateway:'mutate'` ops (VM-isolated execution path).
   *
   * Defaults to `false`: in the in-process fallback there is no VM boundary, so a
   * mutate op is HARD-REJECTED with {@link MutateInFallbackError}. The canned
   * dogfood scenario is `query`-only and never sets this.
   *
   * @defaultValue false
   */
  allowMutate?: boolean;
}

/**
 * Thrown when a `gateway:'mutate'` op is replayed without `allowMutate`.
 *
 * In the in-process fallback the replay runs in the host process, which DOES hold
 * live-DB handles; a mutate op there could corrupt a live `tasks.db`/`brain.db`
 * (the T5158 vector). The hard guard ensures no mutate path can fire without an
 * explicit VM-isolation opt-in.
 */
export class MutateInFallbackError extends Error {
  /** Stable machine-readable error code. */
  public readonly code = 'E_SELFIMPROVE_MUTATE_IN_FALLBACK' as const;

  /** The op coordinate (`domain.operation`) that was rejected. */
  public readonly opCoord: string;

  /**
   * @param op - The rejected mutate op.
   */
  constructor(op: ScenarioOp) {
    const opCoord = `${op.domain}.${op.operation}`;
    super(
      `Refusing to replay mutate op '${opCoord}' without VM isolation ` +
        '(set allowMutate only when running in a sandbox VM)',
    );
    this.name = 'MutateInFallbackError';
    this.opCoord = opCoord;
  }
}

/**
 * Lazily-resolved module logger.
 *
 * Resolved on first use rather than at import time so importing this module never
 * triggers logger initialization. The cached instance is reused across calls.
 */
let cachedLogger: Logger | undefined;

/**
 * Resolve the module logger, initializing it lazily on first call.
 *
 * @returns The `selfimprove-replay` subsystem logger.
 */
async function getModuleLogger(): Promise<Logger> {
  if (cachedLogger === undefined) {
    const { getLogger } = await import('../logger.js');
    cachedLogger = getLogger('selfimprove-replay');
  }
  return cachedLogger;
}

/**
 * Replay a scenario's ordered ops through the injected dispatch port.
 *
 * Captures ONE envelope per op, in op order. Read-only by default: every
 * `gateway:'mutate'` op is HARD-REJECTED with {@link MutateInFallbackError}
 * unless `options.allowMutate` is set (the VM-isolation path).
 *
 * PURE — no DB, no mutation. The `dispatch` port is the only external dependency;
 * tests inject a mock.
 *
 * @param scenario - The validated scenario whose ops are replayed.
 * @param dispatch - The injected dispatch port (cleo supplies the real adapter).
 * @param options - Replay options; see {@link ReplayOptions}.
 * @returns The captured envelopes, one per op, in scenario order.
 * @throws {@link MutateInFallbackError} On a `mutate` op without `allowMutate`.
 *
 * @example
 * ```ts
 * const envelopes = await replayScenario(scenario, dispatch);
 * // envelopes.length === scenario.ops.length
 * ```
 */
export async function replayScenario(
  scenario: Scenario,
  dispatch: ReplayDispatch,
  options: ReplayOptions = {},
): Promise<ReplayEnvelope[]> {
  const allowMutate = options.allowMutate ?? false;
  const logger = await getModuleLogger();

  const captured: ReplayEnvelope[] = [];
  for (const op of scenario.ops) {
    if (op.gateway === 'mutate' && !allowMutate) {
      throw new MutateInFallbackError(op);
    }
    const envelope = await dispatch({
      gateway: op.gateway,
      domain: op.domain,
      operation: op.operation,
      ...(op.params !== undefined ? { params: op.params } : {}),
    });
    captured.push(envelope);
  }

  logger.debug(
    { scenario: scenario.name, captured: captured.length },
    'replayed self-improvement scenario',
  );

  return captured;
}
