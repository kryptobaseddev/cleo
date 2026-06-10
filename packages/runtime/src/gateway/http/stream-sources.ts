/**
 * Streaming-operation source adapters for the gateway HTTP/SSE transport (T11921).
 *
 * A streaming operation (`OperationDef.streaming === true`, served as
 * `GET /v1/<domain>/<operation>`) needs a *producer*: an async source that tails
 * an event origin (the agent/worker/board lifecycle bus) and feeds
 * {@link GatewayStreamEvent} frames into the shared, abort-safe
 * {@link createSseStream} builder. This module owns ONLY that producer concern —
 * the wire encoding + stream lifecycle live in `./sse.ts`, and the route parsing
 * lives in `./listen.ts`.
 *
 * The runtime is deliberately DB-free (the runtime invariant — no drizzle, no
 * `@cleocode/cleo`), so a source here MUST NOT open a store directly. Instead the
 * listener resolves a source by `<domain>.<operation>` key from the
 * {@link STREAM_SOURCES} registry; an embedder that owns a richer origin (the
 * daemon, a SvelteKit route) can inject its own source into the listener at
 * boot. The default source shipped here is a bounded tick/heartbeat producer that
 * proves the pipe end-to-end without reaching across the package boundary — and
 * is exactly what the in-process test exercises.
 *
 * Secrets never touch the wire: a source emits only the public lifecycle payload
 * it is handed; credential resolution (if any) happens server-side before the
 * frame is built, exactly as it does for a unary dispatch.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway/http/stream-sources
 *
 * @task T11921
 * @epic T11769
 * @saga T10400
 */

import type { GatewayStreamEvent } from '@cleocode/contracts/gateway';
import type { SseEmitter } from './sse.js';

/** Default interval (ms) between emitted stream frames — the keepalive cadence. */
const DEFAULT_TICK_INTERVAL_MS = 1000;

/** Hard upper bound on emitted frames so an unbounded `ticks` cannot run forever. */
const MAX_TICKS = 86_400;

/**
 * The bind coordinates a {@link GatewayStreamSource} receives: the resolved
 * `(domain, operation)` of the streaming route, the already-validated request
 * params, and the request id (so emitted frames correlate back to the origin
 * request).
 */
export interface StreamSourceContext {
  /** The canonical domain segment of the streaming route. */
  domain: string;
  /** The operation segment of the streaming route. */
  operation: string;
  /** The decoded query params for the streaming request. */
  params: Record<string, unknown>;
  /** The request id stamped on every emitted {@link GatewayStreamEvent}. */
  requestId: string;
}

/**
 * A teardown callback a {@link GatewayStreamSource} MAY return; invoked exactly
 * once when the stream ends (client disconnect, terminal frame, completion).
 */
export type StreamSourceTeardown = () => void;

/**
 * A producer for one streaming operation. Receives an {@link SseEmitter}
 * (`sendStreamEvent` emits one canonical {@link GatewayStreamEvent}) plus the
 * resolved {@link StreamSourceContext}, and MAY return a teardown callback.
 *
 * The source is started synchronously inside the stream builder, mirroring the
 * Studio SSE endpoints; it may push frames immediately and/or schedule async
 * work. It MUST drop frames once `emitter.closed` is true (the emitter already
 * guards this) and MUST clean up timers/listeners in its teardown so a client
 * disconnect closes the stream leak-free.
 */
export type GatewayStreamSource = (
  emitter: SseEmitter,
  context: StreamSourceContext,
) => StreamSourceTeardown | undefined;

/**
 * Coerce a `ticks` param into a bounded, non-negative integer frame budget.
 *
 * `undefined` / non-finite → open-ended (`Infinity`, capped at {@link MAX_TICKS}
 * worth of timer fires); a finite value is floored to `[0, MAX_TICKS]`.
 *
 * @param raw - The raw `ticks` param value.
 * @returns The resolved frame budget.
 */
function resolveTickBudget(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return MAX_TICKS;
  if (raw <= 0) return 0;
  return Math.min(Math.floor(raw), MAX_TICKS);
}

/**
 * The default `orchestrate.events` source: a bounded tick/heartbeat producer.
 *
 * Emits a monotonic sequence of `data` {@link GatewayStreamEvent} frames at
 * {@link DEFAULT_TICK_INTERVAL_MS}, then a terminal `done` frame once the
 * `ticks` budget is exhausted; a client disconnect tears the timer down before
 * then. It carries no DB handle and no secret — each frame's payload is a public
 * heartbeat (`{ tick, ts }`) standing in for an agent/worker/board lifecycle
 * event until the daemon injects its real origin-tailing source.
 *
 * A first frame is emitted SYNCHRONOUSLY so a client (and the test) observes a
 * well-formed `data:` frame immediately, without waiting a full interval.
 *
 * @param emitter - The SSE emitter for this stream.
 * @param context - The resolved streaming-route context.
 * @returns A teardown that clears the tick timer.
 */
export const tickStreamSource: GatewayStreamSource = (emitter, context) => {
  const budget = resolveTickBudget(context.params.ticks);
  let seq = 0;

  /** Emit one `data` frame; the emitter drops it after close (never throws). */
  const emitData = (): void => {
    const frame: GatewayStreamEvent = {
      kind: 'data',
      seq,
      data: { tick: seq, ts: new Date().toISOString() },
      requestId: context.requestId,
    };
    emitter.sendStreamEvent(frame);
    seq += 1;
  };

  /** Emit the terminal `done` frame and close the stream. */
  const emitDone = (): void => {
    const frame: GatewayStreamEvent = {
      kind: 'done',
      seq,
      data: { ticks: seq, ts: new Date().toISOString() },
      requestId: context.requestId,
    };
    emitter.sendStreamEvent(frame);
    emitter.close();
  };

  // Emit the first frame synchronously so a consumer sees a frame immediately.
  if (budget <= 0) {
    emitDone();
    return undefined;
  }
  emitData();

  const interval = setInterval(() => {
    if (emitter.closed) {
      clearInterval(interval);
      return;
    }
    if (seq >= budget) {
      clearInterval(interval);
      emitDone();
      return;
    }
    emitData();
  }, DEFAULT_TICK_INTERVAL_MS);

  // Teardown: stop the timer when the stream ends (disconnect, done, close).
  return () => clearInterval(interval);
};

/**
 * The default `tasks.subscribe` source: a bounded board-event heartbeat producer
 * (T11785 · epic T11556).
 *
 * Emits `data` {@link GatewayStreamEvent} frames standing in for task/board
 * lifecycle events (`created`/`updated`/`deleted`) until the `ticks` budget is
 * exhausted, then a terminal `done` frame; a client disconnect tears the timer
 * down before then. Each frame carries the optional `root` scope (a saga/parent
 * task ID) so a consumer can correlate the stream to the board slice it
 * subscribed to. Like {@link tickStreamSource} it carries NO DB handle and NO
 * secret — it proves the SSE pipe end-to-end without reaching across the runtime
 * package boundary, and the daemon injects its real store-tailing source via
 * {@link registerStreamSource} at boot.
 *
 * @param emitter - The SSE emitter for this stream.
 * @param context - The resolved streaming-route context (carries `params.root`).
 * @returns A teardown that clears the heartbeat timer.
 */
export const taskBoardStreamSource: GatewayStreamSource = (emitter, context) => {
  const budget = resolveTickBudget(context.params.ticks);
  const root = typeof context.params.root === 'string' ? context.params.root : null;
  let seq = 0;

  /** Emit one board-event `data` frame; dropped after close (never throws). */
  const emitData = (): void => {
    const frame: GatewayStreamEvent = {
      kind: 'data',
      seq,
      data: { scope: 'tasks.board', root, event: 'heartbeat', ts: new Date().toISOString() },
      requestId: context.requestId,
    };
    emitter.sendStreamEvent(frame);
    seq += 1;
  };

  /** Emit the terminal `done` frame and close the stream. */
  const emitDone = (): void => {
    const frame: GatewayStreamEvent = {
      kind: 'done',
      seq,
      data: { scope: 'tasks.board', root, frames: seq, ts: new Date().toISOString() },
      requestId: context.requestId,
    };
    emitter.sendStreamEvent(frame);
    emitter.close();
  };

  if (budget <= 0) {
    emitDone();
    return undefined;
  }
  // Emit the first frame synchronously so a consumer sees a frame immediately.
  emitData();

  const interval = setInterval(() => {
    if (emitter.closed) {
      clearInterval(interval);
      return;
    }
    if (seq >= budget) {
      clearInterval(interval);
      emitDone();
      return;
    }
    emitData();
  }, DEFAULT_TICK_INTERVAL_MS);

  return () => clearInterval(interval);
};

/**
 * The registry of streaming-operation sources, keyed by `<domain>.<operation>`.
 *
 * The listener resolves a source from this map when a `GET /v1/<domain>/<operation>`
 * matches a registered streaming op. An embedder MAY override an entry (or add a
 * domain-specific origin-tailing source) via {@link registerStreamSource} before
 * starting the server; until then `orchestrate.events` (and `tasks.subscribe`)
 * are served by their default tick sources so the pipe is exercisable with zero
 * injection.
 */
const STREAM_SOURCES = new Map<string, GatewayStreamSource>([
  ['orchestrate.events', tickStreamSource],
  // T11785 (epic T11556) — the FIRST streaming task op; default board heartbeat.
  ['tasks.subscribe', taskBoardStreamSource],
]);

/**
 * Build the `<domain>.<operation>` registry key for a streaming source.
 *
 * @param domain - The canonical domain.
 * @param operation - The operation name.
 * @returns The composite registry key.
 */
function streamSourceKey(domain: string, operation: string): string {
  return `${domain}.${operation}`;
}

/**
 * Register (or override) the {@link GatewayStreamSource} for a streaming op.
 *
 * Lets an embedder that owns a richer event origin (the daemon tailing the
 * agent/worker/board lifecycle bus, a SvelteKit route reading a store) replace
 * the default tick source for a given `(domain, operation)` without changing the
 * listener. Idempotent — a later call wins.
 *
 * @param domain - The canonical domain of the streaming op.
 * @param operation - The operation name of the streaming op.
 * @param source - The producer to serve this streaming route with.
 */
export function registerStreamSource(
  domain: string,
  operation: string,
  source: GatewayStreamSource,
): void {
  STREAM_SOURCES.set(streamSourceKey(domain, operation), source);
}

/**
 * Resolve the {@link GatewayStreamSource} registered for a streaming op.
 *
 * @param domain - The canonical domain of the streaming op.
 * @param operation - The operation name of the streaming op.
 * @returns The registered source, or `undefined` when none is registered (the
 *   listener then closes the stream with a single terminal `error` frame).
 */
export function resolveStreamSource(
  domain: string,
  operation: string,
): GatewayStreamSource | undefined {
  return STREAM_SOURCES.get(streamSourceKey(domain, operation));
}
