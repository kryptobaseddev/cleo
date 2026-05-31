/**
 * Server-Sent Events (SSE) wire primitives for the `@cleocode/runtime/gateway/http`
 * adapter.
 *
 * The HTTP transport is the only gateway transport that streams: long-running
 * and subscription operations emit a sequence of {@link GatewayStreamEvent}
 * frames terminated by a `done` or `error` frame. This module owns ONLY the SSE
 * wire encoding + the `ReadableStream` lifecycle plumbing; the actual frame
 * production (polling a DB, tailing a job, etc.) lives in the caller's async
 * source. Keeping the encode/stream concern here lets BOTH the gateway-routed
 * streaming ops AND the existing Studio SSE endpoints (which carry their own
 * domain event shapes) share one tested, leak-free stream builder.
 *
 * Two encoders are provided so an existing stream can adopt this plumbing
 * WITHOUT changing its observed bytes:
 *  - {@link encodeStreamEvent} — the canonical `data: <json>\n\n` form for
 *    {@link GatewayStreamEvent} frames (gateway-routed streaming ops).
 *  - {@link encodeSseFrame} — a generic `event:`/`id:`/`data:` writer for any
 *    payload, so endpoints with a bespoke wire (a named `event:` field, a
 *    `data:`-only frame) keep an IDENTICAL byte stream while still routing their
 *    lifecycle through the shared, abort-safe builder.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway/http/sse
 *
 * @task T11450
 * @epic T11254
 * @saga T11243
 */

import type { GatewayStreamEvent } from '@cleocode/contracts/gateway';

/** SSE field/record delimiter constants (the SSE wire is line-oriented). */
const LF = '\n';
/** A blank line terminates an SSE record (`\n\n`). */
const RECORD_END = '\n\n';

/**
 * One generic SSE frame: an optional named `event`, an optional `id`, and a
 * `data` payload that is JSON-serialized.
 *
 * This is intentionally NOT {@link GatewayStreamEvent} — it is the raw wire
 * shape so a bespoke endpoint can reproduce its exact existing bytes (e.g. a
 * named `event: task-updated` line, or a `data:`-only frame with no `event`).
 */
export interface SseFrame {
  /** Optional SSE `event:` field name (omitted → a `data:`-only frame). */
  event?: string;
  /** Optional SSE `id:` field for client-side last-event-id resumption. */
  id?: string;
  /** The frame payload; JSON-serialized into the `data:` field. */
  data: unknown;
}

/**
 * Encode a generic {@link SseFrame} to its SSE wire bytes.
 *
 * Field order is `event:` (if present) → `id:` (if present) → `data:`, matching
 * the SSE spec record layout, then a blank line. When `event` is omitted the
 * frame is a `data:`-only record — byte-identical to a handwritten
 * `data: <json>\n\n`.
 *
 * @param frame - The frame to serialize.
 * @returns The SSE record as a string (UTF-8 caller-encoded).
 */
export function encodeSseFrame(frame: SseFrame): string {
  let out = '';
  if (frame.event !== undefined) out += `event: ${frame.event}${LF}`;
  if (frame.id !== undefined) out += `id: ${frame.id}${LF}`;
  out += `data: ${JSON.stringify(frame.data)}${RECORD_END}`;
  return out;
}

/**
 * Encode a canonical {@link GatewayStreamEvent} as a `data:`-only SSE record.
 *
 * Gateway-routed streaming ops carry the discriminator + sequence inside the
 * JSON payload (`{ kind, seq, data, error, requestId }`), so no named SSE
 * `event:` field is used — the client demultiplexes on `kind`/`seq`. The
 * monotonic `seq` is also surfaced as the SSE `id:` so a reconnecting client can
 * send `Last-Event-ID`.
 *
 * @param frame - The gateway stream event to serialize.
 * @returns The SSE record as a string.
 */
export function encodeStreamEvent(frame: GatewayStreamEvent): string {
  return encodeSseFrame({ id: String(frame.seq), data: frame });
}

/** The standard SSE response headers (no caching, no proxy buffering). */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

/**
 * A push-style SSE controller handed to an {@link SseSource} so it can emit
 * frames and close the stream without touching the underlying
 * `ReadableStreamDefaultController`.
 */
export interface SseEmitter {
  /** Emit one generic SSE frame; a no-op once the stream is closed. */
  send(frame: SseFrame): void;
  /** Emit one canonical {@link GatewayStreamEvent}; a no-op once closed. */
  sendStreamEvent(frame: GatewayStreamEvent): void;
  /**
   * Emit a pre-encoded SSE record verbatim; a no-op once closed. For endpoints
   * that own their own wire encoder (e.g. a bespoke `data: <json>\n\n`) and want
   * to keep emitting byte-identical records while still routing lifecycle
   * through this builder.
   */
  sendRaw(record: string): void;
  /** Whether the stream has been closed (client disconnect or `close()`). */
  readonly closed: boolean;
  /** Close the stream; idempotent. */
  close(): void;
}

/**
 * A teardown callback returned by an {@link SseSource}, invoked exactly once when
 * the stream ends (client disconnect, `emitter.close()`, or producer completion).
 */
export type SseTeardown = () => void;

/**
 * A frame source for {@link createSseStream}. Receives an {@link SseEmitter} and
 * MAY return an {@link SseTeardown} callback (return nothing to skip teardown).
 *
 * The source is started SYNCHRONOUSLY inside `ReadableStream.start`, mirroring
 * the existing Studio endpoints (which schedule timers inside `start`). A source
 * may push frames immediately and/or schedule async work.
 */
export type SseSource = (emitter: SseEmitter) => SseTeardown | undefined;

/**
 * Build a `text/event-stream` {@link ReadableStream} driven by an
 * {@link SseSource}.
 *
 * This is the shared, abort-safe stream builder every SSE endpoint routes
 * through. It guarantees:
 *  - frames are dropped (never throw) after the stream closes;
 *  - the source's teardown callback runs exactly once;
 *  - an optional {@link AbortSignal} (the request's) closes the stream on client
 *    disconnect, with its listener removed on teardown.
 *
 * The byte output is fully controlled by what the source emits — so an endpoint
 * adopting this builder reproduces its prior wire exactly by emitting the same
 * frames in the same order.
 *
 * @param source - The frame producer.
 * @param signal - Optional request abort signal that closes the stream on
 *   client disconnect.
 * @returns A ReadableStream of UTF-8 SSE bytes for a `Response` body.
 */
export function createSseStream(
  source: SseSource,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller): void {
      let closed = false;
      /** Set once the source returns; invoked exactly once when the stream ends. */
      let teardown: (() => void) | undefined;
      /** Guards against running the source teardown more than once. */
      let teardownDone = false;
      /** True while `source(emitter)` is still executing synchronously. */
      let sourceRunning = false;

      const onAbort = (): void => emitter.close();

      /** Invoke the source teardown at most once (no-op until the source returns). */
      const runTeardown = (): void => {
        if (teardownDone) return;
        teardownDone = true;
        if (typeof teardown === 'function') teardown();
      };

      const emitter: SseEmitter = {
        get closed(): boolean {
          return closed;
        },
        send(frame: SseFrame): void {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(encodeSseFrame(frame)));
          } catch {
            emitter.close();
          }
        },
        sendStreamEvent(frame: GatewayStreamEvent): void {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(encodeStreamEvent(frame)));
          } catch {
            emitter.close();
          }
        },
        sendRaw(record: string): void {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(record));
          } catch {
            emitter.close();
          }
        },
        close(): void {
          if (closed) return;
          closed = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          // If the source closed synchronously mid-body, it has not yet returned
          // its teardown — defer it to the post-return reconciliation below.
          if (!sourceRunning) runTeardown();
          try {
            controller.close();
          } catch {
            // already closed by the runtime — nothing to do.
          }
        },
      };

      if (signal) {
        if (signal.aborted) {
          // Client already gone before we started — close immediately. The
          // source is never invoked, so there is no teardown to run.
          closed = true;
          teardownDone = true;
          try {
            controller.close();
          } catch {
            // already closed.
          }
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      sourceRunning = true;
      const returned = source(emitter);
      teardown = typeof returned === 'function' ? returned : undefined;
      sourceRunning = false;

      // The source may have called `emitter.close()` synchronously before
      // returning its teardown; run it now that the callback is in hand.
      if (closed) runTeardown();
    },
  });
}
