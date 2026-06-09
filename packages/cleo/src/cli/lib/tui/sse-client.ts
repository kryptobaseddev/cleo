/**
 * Minimal SSE consumer for the gateway streaming surface (T11936 · M5).
 *
 * The generated gateway SDK client ({@link import('@cleocode/core/gateway-client')})
 * covers only the UNARY operations — streaming ops (`OperationDef.streaming`,
 * served as `GET /v1/<domain>/<operation>`, T11921) are deliberately NOT in the
 * flat SDK because a `text/event-stream` response is not a single JSON envelope.
 * This module is the thin, dependency-free SSE reader the cockpit uses to tail
 * `GET /v1/orchestrate/events` and feed decoded
 * {@link import('@cleocode/contracts/gateway').GatewayStreamEvent} frames into
 * the pure {@link import('./worker-stream.js') | worker-stream fold}.
 *
 * ## Wire format (mirrors the gateway encoder)
 *
 * The gateway encodes each frame as a `data:`-only SSE record —
 * `id: <seq>\ndata: <json-of-GatewayStreamEvent>\n\n` (see
 * `packages/runtime/src/gateway/http/sse.ts` `encodeStreamEvent`). The client
 * demultiplexes on the decoded frame's `kind`/`seq`; no named `event:` field is
 * used. We buffer the chunked body, split on the blank-line record terminator,
 * extract the `data:` payload, `JSON.parse` it, and hand each frame to the
 * caller's `onFrame`.
 *
 * ## Lifecycle + graceful degrade
 *
 * {@link subscribeOrchestrateEvents} opens ONE `http.get` request and returns a
 * {@link SseSubscription} with an `unsubscribe()` that aborts the request and
 * detaches all listeners — so the cockpit can subscribe on Running-card focus
 * and tear down cleanly on blur / quit, leak-free. A connection failure (daemon
 * down) is reported via `onError` and NEVER thrown — the cockpit already keys
 * daemon-down off `res.response == null` for the unary path, and the worker
 * panel degrades to a "daemon not reachable" line rather than crashing.
 *
 * Uses `node:http` directly (not `fetch`/`EventSource`) so it works on the Node
 * 24 baseline with zero new dependency and gives us a synchronous `req.destroy()`
 * for deterministic teardown.
 *
 * @packageDocumentation
 * @task T11936
 * @epic T11916
 */

import http from 'node:http';
import https from 'node:https';
import type { GatewayStreamEvent } from '@cleocode/contracts/gateway';

/** A live SSE subscription handle. */
export interface SseSubscription {
  /**
   * Abort the underlying request and detach every listener. Idempotent — a
   * second call is a no-op. Called on Running-card blur, on a switch to another
   * card, and on cockpit quit.
   */
  unsubscribe(): void;
}

/** Callbacks for {@link subscribeOrchestrateEvents}. */
export interface SseSubscribeHandlers {
  /** Invoked once per decoded {@link GatewayStreamEvent} frame. */
  onFrame(frame: GatewayStreamEvent): void;
  /**
   * Invoked when the connection fails or the socket errors. NON-FATAL — the
   * cockpit renders a degraded panel line; the TUI never crashes.
   */
  onError?(reason: string): void;
  /** Invoked once when the stream closes (terminal frame or socket end). */
  onClose?(): void;
}

/** Options for {@link subscribeOrchestrateEvents}. */
export interface SseSubscribeOptions {
  /** Gateway base URL (the `cleo daemon serve` listener). */
  readonly baseUrl: string;
  /**
   * Task id to scope the worker stream to, forwarded as the `taskId` query
   * param. The default tick source ignores it; a daemon-injected origin-tailing
   * source filters its frames by it.
   */
  readonly taskId?: string;
  /** Default headers (e.g. an `Authorization` bearer) merged into the request. */
  readonly headers?: Record<string, string>;
}

/**
 * A no-op subscription (already torn down). Returned when the base URL cannot be
 * parsed, so the caller always gets a stable `unsubscribe()` to call.
 */
const NOOP_SUBSCRIPTION: SseSubscription = { unsubscribe: () => {} };

/**
 * Decode one SSE record (the text between blank-line terminators) into a
 * {@link GatewayStreamEvent}. Extracts the `data:` field (joining multi-line
 * `data:` continuations per the SSE spec) and `JSON.parse`s it. Returns `null`
 * for a comment/keepalive record or an unparseable payload, so a malformed frame
 * is skipped rather than crashing the reader.
 *
 * @param record - One SSE record (no trailing blank line).
 * @returns The decoded frame, or `null` to skip.
 */
export function decodeSseRecord(record: string): GatewayStreamEvent | null {
  const dataLines: string[] = [];
  for (const rawLine of record.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith(':')) continue; // SSE comment / keepalive.
    if (line.startsWith('data:')) {
      // Strip `data:` and at most one leading space (SSE field-value rule).
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.kind !== 'data' && obj.kind !== 'done' && obj.kind !== 'error') return null;
    if (typeof obj.seq !== 'number') return null;
    return parsed as GatewayStreamEvent;
  } catch {
    return null;
  }
}

/**
 * Subscribe to the gateway `orchestrate.events` SSE stream and forward each
 * decoded {@link GatewayStreamEvent} to `handlers.onFrame`.
 *
 * Opens `GET <baseUrl>/v1/orchestrate/events[?taskId=…]` with an
 * `Accept: text/event-stream` header, streams the chunked body, splits it into
 * SSE records, and decodes each into a frame. A connection error (daemon down)
 * is reported through `handlers.onError` — NEVER thrown — and the returned
 * subscription is a clean teardown either way.
 *
 * @param options - {@link SseSubscribeOptions} (at minimum the gateway base URL).
 * @param handlers - {@link SseSubscribeHandlers} for frames / errors / close.
 * @returns An {@link SseSubscription} whose `unsubscribe()` aborts the request.
 */
export function subscribeOrchestrateEvents(
  options: SseSubscribeOptions,
  handlers: SseSubscribeHandlers,
): SseSubscription {
  let url: URL;
  try {
    url = new URL('/v1/orchestrate/events', options.baseUrl);
  } catch {
    handlers.onError?.('invalid gateway base URL');
    return NOOP_SUBSCRIPTION;
  }
  if (typeof options.taskId === 'string' && options.taskId.length > 0) {
    url.searchParams.set('taskId', options.taskId);
  }

  const transport = url.protocol === 'https:' ? https : http;

  let buffer = '';
  let closed = false;
  let request: http.ClientRequest | null = null;

  /** Tear down exactly once: abort the request, detach listeners, fire onClose. */
  const teardown = (fireClose: boolean): void => {
    if (closed) return;
    closed = true;
    if (request !== null) {
      request.removeAllListeners();
      // `destroy()` aborts the in-flight request synchronously (no late frames).
      request.destroy();
      request = null;
    }
    if (fireClose) handlers.onClose?.();
  };

  request = transport.get(
    url,
    {
      headers: {
        Accept: 'text/event-stream',
        ...(options.headers ?? {}),
      },
    },
    (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume(); // drain so the socket can free.
        handlers.onError?.(`gateway stream returned HTTP ${status}`);
        teardown(true);
        return;
      }

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (closed) return;
        buffer += chunk;
        // SSE records are separated by a blank line (`\n\n`). Process every
        // complete record; keep the trailing partial in the buffer.
        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const record = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const frame = decodeSseRecord(record);
          if (frame !== null) {
            handlers.onFrame(frame);
            if (frame.kind === 'done' || frame.kind === 'error') {
              teardown(true);
              return;
            }
          }
          sep = buffer.indexOf('\n\n');
        }
      });
      res.on('end', () => teardown(true));
      res.on('error', (e: Error) => {
        handlers.onError?.(e.message);
        teardown(true);
      });
    },
  );

  request.on('error', (e: Error) => {
    handlers.onError?.(e.message);
    teardown(true);
  });

  return {
    unsubscribe: () => teardown(false),
  };
}
