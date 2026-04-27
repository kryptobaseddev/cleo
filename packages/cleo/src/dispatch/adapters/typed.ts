/**
 * Typed dispatch adapter — single-point compile-time bridge.
 *
 * ## Purpose
 *
 * The canonical {@link DomainHandler} interface accepts `Record<string, unknown>` params
 * on every operation. This forces every handler to hand-cast each field at the call
 * site (`params?.foo as string`). The T910 audit enumerated **579** such casts
 * across 14 domain handlers — latent schema drift with zero compile-time enforcement.
 *
 * This module provides the compile-time "adapter" (Option A in the T910 audit):
 * handlers declare a typed operation record `O extends TypedOpRecord`, and the
 * single `as O[K][0]` cast inside {@link typedDispatch} is the only boundary
 * between the untyped registry and fully-typed per-op params.
 *
 * ## Scope — what this module does and does NOT do
 *
 * - **Does**: Provide a `TypedDomainHandler<O>` interface, a `typedDispatch` helper,
 *   a `defineTypedHandler` builder, and `lafsSuccess` / `lafsError` envelope helpers.
 * - **Does NOT**: Perform runtime validation. A follow-up epic (Wave D Phase 2) will
 *   layer zod schemas on top of this module. Today the cast in `typedDispatch`
 *   trusts the caller — the registry upstream validates that `op` exists in the
 *   handler's operations map, and the contracts in `@cleocode/contracts/src/operations/`
 *   are the typed source of truth for what each op accepts.
 * - **Does NOT**: Replace {@link DomainHandler}. Migrations (T975-T983) wire each
 *   existing handler through this typed layer one domain at a time; the legacy
 *   `DomainHandler` interface remains for back-compat.
 *
 * ## Rationale for the single cast
 *
 * The cast `rawParams as O[K][0]` inside {@link typedDispatch} is the documented
 * "trust boundary". The registry upstream (`registry.ts`) validates the operation
 * name against a known set; the contracts package defines the typed params shape.
 * No other cast is needed because every downstream call site sees the narrowed
 * `O[K][0]` type.
 *
 * @task T974 — Wave D foundation (clean-code SSoT reconciliation epic T962)
 * @see packages/cleo/src/dispatch/domains/diagnostics.ts (gold-standard guard pattern)
 * @see .cleo/agent-outputs/T910-reconciliation/dispatch-cast-audit.md (full audit)
 */

import { randomUUID } from 'node:crypto';
import type { LafsEnvelope, LafsError, LafsSuccess } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * Infer a `TypedOpRecord` from a Core function registry.
 *
 * Transforms a map of Core functions into a typed operation record by extracting
 * parameter and return types. The inference rule:
 *
 * - **Params**: `Parameters<F>[0]` — the first argument type of the function.
 *   If the function takes no arguments, infers to `Record<string, never>`
 *   (representing a no-op/void-arg operation).
 *
 * - **Result**: `Awaited<ReturnType<F>>` — the resolved type of the function's
 *   return value. If the function returns a `Promise<T>`, unwraps to `T`.
 *   If synchronous, returns the value as-is. This ensures both async and
 *   sync Core functions produce a consistent result type.
 *
 * **Overload Resolution**: TypeScript's `Parameters<F>` and `ReturnType<F>`
 * pick the LAST overload of an overloaded function signature. If a Core function
 * defines multiple overloads, the inferred types correspond to the final overload.
 * This is a known limitation; prefer single-signature Core functions when possible,
 * or manually wire the operation record if overloads have materially different
 * parameter/result shapes.
 *
 * **Escape Hatch**: If `OpsFromCore<C>` inference doesn't fit your needs,
 * you may still hand-write a `TypedOpRecord` — this helper is opt-in and
 * coexists with manual declaration. Both approaches satisfy the same
 * `TypedOpRecord` contract.
 *
 * @typeParam C - A record (often `typeof someModule`) mapping operation names
 *   to Core functions. Each value must be a function matching
 *   `(...args: any[]) => any`.
 *
 * @returns A `TypedOpRecord` (map of operation names to `[Params, Result]`
 *   tuples) suitable for passing to {@link defineTypedHandler}.
 *
 * @example
 * ```ts
 * // Core module defines:
 * export async function nexusList(params: NexusListParams): Promise<NexusListResult> { ... }
 * export async function nexusRegister(params: NexusRegisterParams): Promise<NexusRegisterResult> { ... }
 *
 * // Dispatch adapter creates:
 * import * as nexusCore from '@cleocode/core/nexus';
 *
 * const coreOps = {
 *   'nexus.list':     nexusCore.nexusList,
 *   'nexus.register': nexusCore.nexusRegister,
 * } as const;
 *
 * type NexusOps = OpsFromCore<typeof coreOps>;
 * // Equivalent to:
 * // type NexusOps = {
 * //   'nexus.list':     [NexusListParams, NexusListResult];
 * //   'nexus.register': [NexusRegisterParams, NexusRegisterResult];
 * // };
 *
 * const handler = defineTypedHandler<NexusOps>('nexus', {
 *   'nexus.list': async (params) => { ... },
 *   'nexus.register': async (params) => { ... },
 * });
 * ```
 *
 * **Zero-Argument (Void-Arg) Functions**:
 * ```ts
 * // If Core defines:
 * export async function sessionStatus(): Promise<SessionStatusResult> { ... }
 *
 * // Then:
 * const coreOps = { 'session.status': sessionStatus } as const;
 * type SessionOps = OpsFromCore<typeof coreOps>;
 * // type SessionOps = {
 * //   'session.status': [Record<string, never>, SessionStatusResult];
 * // };
 *
 * // Inside the handler, the params arg is still typed:
 * const handler = defineTypedHandler<SessionOps>('session', {
 *   'session.status': async (_params: Record<string, never>) => {
 *     // _params is empty; safe to ignore.
 *     return lafsSuccess({ ... }, 'session.status');
 *   },
 * });
 * ```
 *
 * @see {@link TypedOpRecord}
 * @see {@link defineTypedHandler}
 * @task T1436 — Wave 0 of T1435 dispatch refactor (eliminate dispatch-vs-contracts drift)
 *
 * **Note on the `any` constraint**: The `(...args: any[]) => any` constraint is REQUIRED
 * for TypeScript to allow generic inference of `Parameters<C[K]>[0]` and `ReturnType<C[K]>`
 * without widening to `unknown`. Tightening this constraint would break the inference.
 * This is a mandatory boundary in the type-system design.
 */
// biome-ignore lint/suspicious/noExplicitAny: mandatory for TS inference
export type OpsFromCore<C extends Record<string, (...args: any[]) => any>> = {
  [K in keyof C]: [
    Parameters<C[K]>[0] extends undefined ? Record<string, never> : Parameters<C[K]>[0],
    Awaited<ReturnType<C[K]>>,
  ];
};

/**
 * Shape of a typed-op record.
 *
 * Each key in the record is an operation name, and each value is a tuple of
 * `[Params, Result]` types. The adapter uses declaration-merging to narrow
 * the handler's operation functions without runtime indirection.
 *
 * @example
 * ```ts
 * import type { SessionStartParams, SessionStartResult } from '@cleocode/contracts';
 *
 * type SessionOps = {
 *   'session.start': [SessionStartParams, SessionStartResult];
 *   'session.status': [Record<string, never>, SessionStatusResult];
 * };
 * ```
 */
export type TypedOpRecord = Record<string, readonly [unknown, unknown]>;

/**
 * A fully-typed domain handler.
 *
 * Callers supply an `OPS extends TypedOpRecord` mapping each op name to its
 * typed `[Params, Result]` tuple. Every function in `operations` receives the
 * narrowed `Params` type and returns a `LafsEnvelope<Result>`.
 *
 * @typeParam O - The typed operation record. Each entry is `[Params, Result]`.
 *
 * @example
 * ```ts
 * const handler: TypedDomainHandler<SessionOps> = {
 *   domain: 'session',
 *   operations: {
 *     'session.start': async (params) => lafsSuccess({...}, 'session.start'),
 *     'session.status': async (_params) => lafsSuccess({...}, 'session.status'),
 *   },
 * };
 * ```
 */
export interface TypedDomainHandler<O extends TypedOpRecord> {
  /** Canonical domain name (matches the registry key). */
  readonly domain: string;
  /**
   * Per-operation function map. Each op receives its typed params and returns
   * a `LafsEnvelope<Result>` built with {@link lafsSuccess} or {@link lafsError}.
   */
  readonly operations: {
    // T1432-followup: Widened to LafsEnvelope<unknown> so engine `?? defaultObj`
    // patterns infer cleanly. Runtime data shape is enforced by O[K][1] in the
    // contract; consuming wrappers (NexusHandler.query, TasksHandler.query,
    // typedDispatch) narrow at the gateway boundary.
    readonly [K in keyof O]: (params: O[K][0]) => Promise<LafsEnvelope<unknown>>;
  };
}

// ---------------------------------------------------------------------------
// Dispatch helper
// ---------------------------------------------------------------------------

/**
 * Dispatch a typed op on a typed handler.
 *
 * Given a `TypedDomainHandler<O>`, dispatches `op` with `rawParams` and returns
 * the handler's `LafsEnvelope<O[K][1]>`. The single `as O[K][0]` cast inside
 * this function is the **documented trust boundary**: the registry upstream
 * guarantees that `op` exists in the handler's operations map and that
 * `rawParams` was constructed from the CLI adapter's validated input.
 *
 * No runtime validation is performed here. Runtime schema validation (zod) is
 * the subject of a separate follow-up epic; inserting it into this function
 * will be a localized change (see the `// Future` comment in the implementation).
 *
 * @typeParam O - The handler's typed operation record.
 * @typeParam K - The specific op key being dispatched.
 * @param handler - The typed handler produced by {@link defineTypedHandler}.
 * @param op - The operation name (must exist in `handler.operations`).
 * @param rawParams - Raw params from the dispatcher middleware. Type-narrowed
 *   to `O[K][0]` by the single boundary cast below.
 * @returns A `LafsEnvelope<O[K][1]>` from the handler's per-op function.
 *
 * @throws Propagates any error thrown by the handler's op function. Callers
 *   that need LAFS-shaped errors should wrap with {@link lafsError} at the
 *   op-fn level; {@link typedDispatch} itself does not catch.
 *
 * @example
 * ```ts
 * const envelope = await typedDispatch(sessionHandler, 'session.start', rawParams);
 * if (envelope.success) console.log(envelope.data); // SessionStartResult
 * ```
 */
export async function typedDispatch<O extends TypedOpRecord, K extends keyof O & string>(
  handler: TypedDomainHandler<O>,
  op: K,
  rawParams: unknown,
): Promise<LafsEnvelope<O[K][1]>> {
  // ------------------------------------------------------------------------
  // Trust boundary (single-point cast).
  //
  // `rawParams` is `unknown` at the registry boundary. The CLI adapter
  // (`packages/cleo/src/dispatch/adapters/cli.ts`) has already unpacked the
  // wire format via `params-resolver`, and the registry's `resolveOperation`
  // guarantees that `op` exists in `handler.operations`. This cast is the
  // ONLY point in the typed adapter where `unknown` becomes a concrete params
  // type; every downstream call site sees the narrowed `O[K][0]`.
  //
  // Future (Wave D Phase 2, separate epic): insert zod parsing here to gate
  // drift at runtime as well as at compile time. The shape would be:
  //
  //   const schema = OpSchemas[handler.domain][op];
  //   const parsed = schema.safeParse(rawParams);
  //   if (!parsed.success) {
  //     return lafsError('E_VALIDATION', parsed.error.message, `${handler.domain}.${op}`);
  //   }
  //   return handler.operations[op](parsed.data);
  //
  // See packages/contracts/src/operations/*.ts for the typed Params contracts
  // that would back these schemas.
  // ------------------------------------------------------------------------
  return handler.operations[op](rawParams as O[K][0]);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a {@link TypedDomainHandler} from a domain name and op map.
 *
 * Convenience factory that keeps the domain name and operations record visible
 * at a single call site. Equivalent to writing out the object literal, but
 * makes the generic parameter explicit at the point of construction.
 *
 * @typeParam O - The handler's typed operation record.
 * @param domain - Canonical domain name (matches the registry key).
 * @param operations - Per-op function map produced in user code.
 * @returns A typed handler ready to pass to {@link typedDispatch}.
 *
 * @example
 * ```ts
 * const sessionHandler = defineTypedHandler<SessionOps>('session', {
 *   'session.start': async (params) => lafsSuccess({...}, 'session.start'),
 *   'session.status': async (_params) => lafsSuccess({...}, 'session.status'),
 * });
 * ```
 */
export function defineTypedHandler<O extends TypedOpRecord>(
  domain: string,
  operations: TypedDomainHandler<O>['operations'],
): TypedDomainHandler<O> {
  return { domain, operations };
}

// ---------------------------------------------------------------------------
// LAFS envelope helpers
// ---------------------------------------------------------------------------

/**
 * Generate a stable request id for envelope correlation.
 *
 * @internal
 */
function generateRequestId(): string {
  return randomUUID();
}

/**
 * Build a LAFS success envelope around `data`.
 *
 * Produces a `LafsSuccess<T>` (the CLI envelope variant from
 * `@cleocode/contracts/src/lafs.ts`). The `operation` argument is accepted
 * for parity with {@link lafsError} but is not persisted on the CLI variant
 * — upstream middleware writes it onto the gateway-enriched envelope
 * (`GatewaySuccess._meta.operation`) when the response crosses the dispatcher
 * boundary.
 *
 * @typeParam T - The data payload type.
 * @param data - The successful result payload.
 * @param _operation - Operation name (accepted for parity; not persisted on
 *   the CLI envelope variant — it is written by the gateway middleware).
 * @returns A `LafsSuccess<T>` envelope.
 *
 * @example
 * ```ts
 * return lafsSuccess({ sessionId: 'ses_…', scope: 'global' }, 'session.start');
 * ```
 */
export function lafsSuccess<T>(
  data: T,
  _operation: string,
  extra?: { page?: import('@cleocode/contracts').LAFSPage },
): LafsSuccess<T> & { page?: import('@cleocode/contracts').LAFSPage } {
  return {
    success: true,
    data,
    ...(extra?.page ? { page: extra.page } : {}),
  };
}

/**
 * Build a LAFS error envelope.
 *
 * Produces a `LafsError` (the CLI envelope variant from
 * `@cleocode/contracts/src/lafs.ts`). The `operation` argument is accepted
 * for parity with {@link lafsSuccess} but is not persisted on the CLI variant
 * — upstream middleware writes it onto the gateway-enriched envelope
 * (`GatewayError._meta.operation`).
 *
 * @param code - Stable machine-readable error code (e.g. `'E_NOT_FOUND'`).
 * @param message - Human-readable error description.
 * @param _operation - Operation name (accepted for parity; not persisted on
 *   the CLI envelope variant — it is written by the gateway middleware).
 * @param fix - Optional copy-paste fix hint for the caller.
 * @returns A `LafsError` envelope. Typed as `LafsEnvelope<never>` so it
 *   composes with any `LafsEnvelope<T>` return type.
 *
 * @example
 * ```ts
 * return lafsError('E_NOT_FOUND', `task ${id} not found`, 'tasks.show', `cleo find ${id}`);
 * ```
 */
export function lafsError(
  code: string,
  message: string,
  _operation: string,
  fix?: string,
): LafsEnvelope<never> {
  const error: LafsError['error'] = { code, message };
  if (fix !== undefined) error.fix = fix;
  return {
    success: false,
    error,
  };
}

// ---------------------------------------------------------------------------
// Thin-dispatch helpers (T1484 · ADR-057 D3)
// ---------------------------------------------------------------------------

/**
 * Wrap a Core engine result into a LAFS envelope.
 *
 * Eliminates the repetitive 8-12 line pattern:
 * ```ts
 * const result = await coreOps.foo(params);
 * if (!result.success) return lafsError(String(result.error?.code ?? 'E_INTERNAL'), ...);
 * return lafsSuccess(result.data ?? fallback, opName);
 * ```
 *
 * Usage:
 * ```ts
 * return wrapCoreResult(await coreOps.foo(params), 'foo', fallback);
 * ```
 *
 * @param result   - Result returned by a Core op wrapper function.
 * @param opName   - Operation name forwarded to {@link lafsError} / {@link lafsSuccess}.
 * @param fallback - Optional default when `result.data` is `null`/`undefined` on success.
 * @returns A `LafsEnvelope` for the operation.
 *
 * @task T1484
 */
// biome-ignore lint/suspicious/noExplicitAny: fallback must accept any data shape
export function wrapCoreResult<T = any>(
  result: {
    success: boolean;
    data?: T;
    error?: { code?: string | number; message?: string };
  },
  opName: string,
  fallback?: T,
): LafsEnvelope<T> {
  if (!result.success) {
    return lafsError(
      String(result.error?.code ?? 'E_INTERNAL'),
      result.error?.message ?? 'Unknown error',
      opName,
    ) as LafsEnvelope<T>;
  }
  return lafsSuccess((result.data ?? fallback) as T, opName);
}

/**
 * Wrap a conduit `*Impl` call in a standardised try/catch returning a LAFS envelope.
 *
 * All conduit typed-handler ops follow an identical 15-25 line try/catch pattern:
 * ```ts
 * try {
 *   const result = await fooImpl(...params);
 *   if (!result.success) return lafsError(result.error?.code ?? 'E_CONDUIT', ...);
 *   return lafsSuccess(result.data ?? {}, opName);
 * } catch (error) {
 *   return lafsError('E_CONDUIT', error instanceof Error ? error.message : String(error), opName);
 * }
 * ```
 *
 * Usage:
 * ```ts
 * return wrapConduitImpl(() => fooImpl(params.bar, params.baz), 'foo');
 * ```
 *
 * @param fn     - Zero-argument async factory that calls the impl function.
 * @param opName - Operation name forwarded to {@link lafsError} / {@link lafsSuccess}.
 * @returns A `Promise<LafsEnvelope<T>>` for the operation.
 *
 * @task T1484
 */
export async function wrapConduitImpl(
  fn: () => Promise<unknown>,
  opName: string,
): Promise<LafsEnvelope<unknown>> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: conduit impl types are heterogeneous
    const result = (await fn()) as any;
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_CONDUIT'),
        result.error?.message ?? 'Unknown error',
        opName,
      );
    }
    return lafsSuccess(result.data ?? {}, opName);
  } catch (error) {
    return lafsError('E_CONDUIT', error instanceof Error ? error.message : String(error), opName);
  }
}

// ---------------------------------------------------------------------------
// Internal exports for testing
// ---------------------------------------------------------------------------

/**
 * Internal request-id generator, exposed for deterministic assertions in unit
 * tests. Production callers should never import this directly.
 *
 * @internal
 */
export const __typedInternals = { generateRequestId };
