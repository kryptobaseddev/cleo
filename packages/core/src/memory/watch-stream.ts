/**
 * Memory watch stream — business logic extracted from `cleo memory watch --follow`.
 *
 * Provides an `AsyncIterable` of brain write events that the CLI handler
 * can consume and format as SSE-style stdout events. The non-follow (single
 * poll) path stays thin in the CLI handler via `dispatchFromCli`.
 *
 * @module memory/watch-stream
 * @epic T9833
 * @task T10062
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single brain write event. */
export interface MemoryWatchEvent {
  [key: string]: unknown;
  created_at?: string;
}

/** Options for {@link streamMemoryWatchEvents}. */
export interface MemoryWatchStreamOptions {
  /** Resume cursor (created_at lower bound from a previous watch call). */
  cursor?: string;
  /** Maximum events per poll (default: 10). */
  limit?: number;
  /** Poll interval in milliseconds (default: 1 000). */
  intervalMs?: number;
  /**
   * Raw dispatch function — matches `dispatchRaw` from the CLI adapter.
   * Injected to keep this module decoupled from the CLI layer.
   */
  dispatchRaw: (
    gateway: 'mutate' | 'query',
    domain: string,
    operation: string,
    params: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    data?: unknown;
    error?: { message?: string; code?: string };
  }>;
  /** AbortSignal for stopping the stream cleanly. */
  signal?: AbortSignal;
}

/** A yielded item from the watch stream. */
export type MemoryWatchYield =
  | { kind: 'ping'; ts: string }
  | { kind: 'events'; events: MemoryWatchEvent[]; nextCursor: string | null }
  | { kind: 'error'; message: string; code: string }
  | { kind: 'close'; ts: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stream brain write events as an `AsyncIterable`.
 *
 * Yields a `ping` item immediately, then polls `memory.watch` on every
 * `intervalMs` tick. Yields `events` items (potentially empty) on each poll,
 * an `error` item on dispatch failure, and a `close` item when the signal
 * fires or the caller's `for await` loop breaks.
 *
 * The caller is responsible for process signal wiring and stdout emission.
 *
 * @param opts - Stream configuration
 */
export async function* streamMemoryWatchEvents(
  opts: MemoryWatchStreamOptions,
): AsyncIterable<MemoryWatchYield> {
  const { cursor: initialCursor, limit, intervalMs = 1_000, dispatchRaw, signal } = opts;

  // Initial ping
  yield { kind: 'ping', ts: new Date().toISOString() };

  let cursor = initialCursor;

  while (!signal?.aborted) {
    const params: Record<string, unknown> = {};
    if (cursor !== undefined) params['cursor'] = cursor;
    if (limit !== undefined) params['limit'] = limit;

    const response = await dispatchRaw('query', 'memory', 'watch', params);

    if (!response.success) {
      yield {
        kind: 'error',
        message: response.error?.message ?? 'Unknown error',
        code: response.error?.code ?? 'E_WATCH_FAILED',
      };
      return;
    }

    const data = response.data as {
      events?: MemoryWatchEvent[];
      nextCursor?: string | null;
    };

    yield {
      kind: 'events',
      events: data.events ?? [],
      nextCursor: data.nextCursor ?? null,
    };

    if (typeof data.nextCursor === 'string') {
      cursor = data.nextCursor;
    }

    if (signal?.aborted) break;

    // Fixed-interval sleep — resolves early on abort
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      timer.unref?.();
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  yield { kind: 'close', ts: new Date().toISOString() };
}
