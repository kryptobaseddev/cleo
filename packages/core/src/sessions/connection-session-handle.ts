/**
 * Connection-scoped session handle registry (T11640 · Epic T11638).
 *
 * The single-process CLI binds exactly one session per process via the dispatch
 * `session-context` singleton — but a warm **daemon** serves many concurrent
 * clients over one long-lived process, so a module singleton would collapse
 * every connection's identity onto "whoever bound last". This module gives the
 * daemon a per-connection identity surface WITHOUT changing the dependency
 * direction (`runtime` → `core`):
 *
 *  1. An in-memory `Map<connId, sessionId>` registry the RPC transport writes at
 *     **accept-time** (the moment a connection first declares its session) and
 *     clears on socket close. Bind/unbind/lookup are O(1) and synchronous.
 *  2. An {@link AsyncLocalStorage} "current connection" channel so that, while a
 *     request frame is being dispatched, ANY code in `core` (notably
 *     {@link resolveCurrentSession}) can ask "which connection am I serving?"
 *     and resolve that connection's bound session — with zero parameter
 *     threading through the dispatch call graph.
 *
 * Because this lives in `core`, the identity resolver
 * (`store/session-store.ts:resolveCurrentSession`) can consult it directly while
 * `runtime` (which depends on `core`) writes to it from the transport boundary.
 * The CLI single-process path never binds a connection, so
 * {@link getCurrentConnectionSessionId} returns `null` there and resolution
 * transparently falls through to the env-first + `getActiveSession()` fallback.
 *
 * This module is import-time side-effect-free: it constructs only an empty `Map`
 * and an `AsyncLocalStorage` instance (both inert), never touching the DB, the
 * filesystem, the network, or any logger at import time.
 *
 * @packageDocumentation
 * @module @cleocode/core/sessions/connection-session-handle
 *
 * @task T11640
 * @epic T11638
 * @saga T11243
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The in-flight connection context threaded through {@link AsyncLocalStorage}.
 *
 * Carries the connection id and, when the dispatched frame declared one, a
 * per-frame `sessionId` SNAPSHOT.
 *
 * Resolution precedence inside {@link getCurrentConnectionSessionId}:
 *  1. the per-frame `sessionId` snapshot, when present — this is what dissolves
 *     INTRA-connection session bleed. Frames are dispatched concurrently on one
 *     connection and binding into {@link connectionSessionRegistry} is
 *     last-write-wins, so a still-in-flight Frame A must resolve the session it
 *     was dispatched WITH, not the session a later Frame B just bound. Snapshotting
 *     the frame's own session at dispatch entry makes Frame A immune to Frame B.
 *  2. otherwise an on-demand registry lookup by `connId` — so a frame that
 *     declared NO session of its own still honours a {@link bindConnectionSession}
 *     made (even late) on the connection.
 */
export interface ConnectionHandleContext {
  /** Opaque per-connection identifier (stable for the life of the socket). */
  readonly connId: string;
  /**
   * Per-frame session-id snapshot, captured at dispatch entry. When set it is
   * authoritative for this dispatch and shields it from concurrent last-write-wins
   * re-bindings of the same `connId` by sibling frames. `undefined` for frames
   * that declared no session (those fall through to the registry lookup).
   */
  readonly sessionId?: string;
}

/**
 * Process-local `connId → sessionId` map.
 *
 * Module-private; mutated only through {@link bindConnectionSession} /
 * {@link unbindConnectionSession} so the lifecycle stays auditable and the map
 * can never leak across the public surface.
 */
const connectionSessionRegistry = new Map<string, string>();

/**
 * The async-context channel carrying the {@link ConnectionHandleContext} for the
 * request currently being dispatched on a connection.
 */
const connectionHandleStore = new AsyncLocalStorage<ConnectionHandleContext>();

/**
 * Bind a connection to its session id (accept-time, daemon transport).
 *
 * Idempotent and last-write-wins: re-binding the same `connId` with a new
 * `sessionId` updates the mapping (e.g. a client that switches sessions over a
 * persistent connection). An empty `sessionId` is rejected as a no-op so a
 * blank value cannot shadow a previously-bound real session.
 *
 * @param connId - Opaque per-connection identifier.
 * @param sessionId - The session id this connection is acting as.
 * @task T11640
 */
export function bindConnectionSession(connId: string, sessionId: string): void {
  if (!connId || !sessionId) return;
  connectionSessionRegistry.set(connId, sessionId);
}

/**
 * Unbind a connection from its session id (socket-close, daemon transport).
 *
 * Idempotent — unbinding an unknown `connId` is a no-op. MUST be called on
 * connection teardown so the registry does not grow unbounded across a
 * long-lived daemon process.
 *
 * @param connId - The connection id to drop.
 * @returns `true` when an entry was removed, `false` when none existed.
 * @task T11640
 */
export function unbindConnectionSession(connId: string): boolean {
  return connectionSessionRegistry.delete(connId);
}

/**
 * Look up the session id bound to a specific connection id.
 *
 * @param connId - The connection id to resolve.
 * @returns The bound session id, or `null` when the connection is unbound.
 * @task T11640
 */
export function getConnectionSessionId(connId: string): string | null {
  return connectionSessionRegistry.get(connId) ?? null;
}

/**
 * Number of live connection bindings — for daemon health/observability only.
 *
 * @returns The current registry size.
 * @task T11640
 */
export function connectionRegistrySize(): number {
  return connectionSessionRegistry.size;
}

/**
 * Run `fn` with `connId` installed as the current connection handle.
 *
 * The daemon transport wraps each request-frame dispatch in this so that any
 * `core` code reached during the dispatch can resolve the connection's session
 * via {@link getCurrentConnectionSessionId}. The handle is scoped to the async
 * execution of `fn` and torn down automatically when `fn` settles — concurrent
 * dispatches on different connections never see each other's handle.
 *
 * When `sessionId` is supplied it is SNAPSHOTTED into the per-frame handle so the
 * dispatch resolves THAT session regardless of any later last-write-wins re-bind
 * of the same `connId` by a sibling frame — the fix for intra-connection session
 * bleed (see {@link ConnectionHandleContext}). Omit it for frames that declared
 * no session of their own; those fall through to the registry lookup, preserving
 * the late-binding path.
 *
 * @typeParam T - The return type of `fn`.
 * @param connId - The connection id to install for the duration of `fn`.
 * @param fn - The work to run within the connection-handle scope.
 * @param sessionId - Optional per-frame session-id snapshot for this dispatch.
 * @returns Whatever `fn` returns.
 * @task T11640
 */
export function runWithConnectionHandle<T>(connId: string, fn: () => T, sessionId?: string): T {
  return connectionHandleStore.run({ connId, sessionId: sessionId || undefined }, fn);
}

/**
 * Resolve the session id of the connection currently being served, if any.
 *
 * Reads the {@link AsyncLocalStorage} channel to find the in-flight connection
 * handle, then resolves the session in this precedence:
 *  1. the handle's per-frame `sessionId` snapshot, when present — authoritative
 *     for this dispatch and immune to concurrent re-binds of the same `connId`
 *     by sibling frames (the intra-connection bleed fix);
 *  2. an on-demand registry lookup by `connId` — so a frame that declared no
 *     session of its own still honours a (possibly late) connection binding.
 * Returns `null` outside any connection-handle scope (the single-process CLI
 * path, or daemon code running outside a request frame), so callers
 * transparently fall through to their next resolution tier.
 *
 * This NEVER reads the database — it is synchronous and safe in hot identity
 * paths, mirroring {@link resolveSessionIdFromEnv}.
 *
 * @returns The current connection's session id, or `null`.
 * @task T11640
 */
export function getCurrentConnectionSessionId(): string | null {
  const ctx = connectionHandleStore.getStore();
  if (!ctx) return null;
  if (ctx.sessionId) return ctx.sessionId;
  return getConnectionSessionId(ctx.connId);
}

/**
 * Test-only: clear every connection binding.
 *
 * Lets unit tests reset the process-local registry between cases without
 * exposing the underlying `Map`. NOT part of the runtime contract.
 *
 * @internal
 * @task T11640
 */
export function resetConnectionSessionRegistry(): void {
  connectionSessionRegistry.clear();
}
