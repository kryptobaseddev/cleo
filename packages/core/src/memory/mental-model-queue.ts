/**
 * Async reinforcement queue for non-blocking mental-model writes.
 *
 * ULTRAPLAN L5 compliance: observations tagged with an `agent` provenance and a
 * mental-model-relevant type ('discovery', 'change', 'feature', 'decision') are
 * routed through this queue instead of writing synchronously to brain.db. This
 * decouples the hot path (agent execution) from I/O latency.
 *
 * The queue is drained to brain.db either:
 *   1. Promptly — every `enqueue` schedules a drain on the next macrotask
 *      (`setImmediate`, NOT unref'd), so observations enqueued in the same tick
 *      are written as one batch and the caller's promise always settles (T12817).
 *   2. Periodically — every {@link FLUSH_INTERVAL_MS} milliseconds via a timer
 *      (backstop; unref'd).
 *   3. On high watermark — when the queue exceeds {@link FLUSH_WATERMARK} entries.
 *   4. On process exit — SIGINT, SIGTERM, and 'exit' hooks perform a best-effort
 *      flush.
 *
 * T12817: before the prompt drain existed, the ONLY drain a one-shot process
 * could reach was the unref'd 5 s timer. `enqueue()` returned a promise that
 * only that timer could settle, so an awaited `cleo memory observe --agent X`
 * left the event loop empty: Node exited 0 with zero bytes on stdout and the
 * `'exit'` hook's async drain never ran — the observation was silently lost.
 *
 * Observations without an `agent` field continue to use the existing synchronous
 * path in observeBrain() and are never routed here.
 *
 * @task T383/T419
 * @epic T377
 */

import type { ObserveBrainParams, ObserveBrainResult } from './brain-retrieval.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Drain interval in milliseconds. */
const FLUSH_INTERVAL_MS = 5_000;

/** Drain when queue exceeds this many entries, regardless of timer. */
const FLUSH_WATERMARK = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Queued observation entry with its write callback. */
interface QueuedObservation {
  /** Project root the observation is scoped to. */
  projectRoot: string;
  /** Full observation parameters, including the required `agent` field. */
  params: ObserveBrainParams & { agent: string };
  /** Resolve callback — called with the persisted result after flush. */
  resolve: (result: ObserveBrainResult) => void;
  /** Reject callback — called if the observation cannot be persisted. */
  reject: (err: Error) => void;
}

/**
 * Public interface for the mental-model queue singleton.
 *
 * @example
 * ```ts
 * const q = getMentalModelQueue();
 * await q.enqueue(projectRoot, { text: 'Agent learned X', agent: 'my-agent', ... });
 * const remaining = q.size();
 * await q.flush();
 * ```
 */
export interface MentalModelQueue {
  /**
   * Enqueue a mental-model observation for async write.
   *
   * Returns a Promise that resolves with the persisted {@link ObserveBrainResult}
   * once the batch flush runs. Non-blocking for the caller.
   *
   * @param projectRoot - Project root directory for the brain.db path.
   * @param params - Observation parameters. MUST include `agent`.
   */
  enqueue(
    projectRoot: string,
    params: ObserveBrainParams & { agent: string },
  ): Promise<ObserveBrainResult>;

  /**
   * Drain the queue immediately.
   *
   * Writes all pending observations to brain.db.
   * Safe to call concurrently — duplicate calls are serialised internally.
   *
   * @returns The number of observations successfully drained.
   */
  flush(): Promise<number>;

  /** Current number of pending observations in the queue. */
  size(): number;
}

// ---------------------------------------------------------------------------
// Observation types that route through the mental-model queue.
// ---------------------------------------------------------------------------

/**
 * Observation types that are considered mental-model relevant and therefore
 * eligible for async queuing when produced by a named agent.
 */
const MENTAL_MODEL_TYPES = new Set<string>([
  'discovery',
  'change',
  'feature',
  'decision',
  'bugfix',
  'refactor',
]);

// ---------------------------------------------------------------------------
// Queue implementation
// ---------------------------------------------------------------------------

/** In-memory queue of pending mental-model observations. */
const _queue: QueuedObservation[] = [];

/** Whether process-exit hooks have been registered. */
let _hooksRegistered = false;

/** Handle for the periodic flush timer (undefined = no active timer). */
let _timer: ReturnType<typeof setInterval> | undefined;

/** Handle for the pending prompt drain (undefined = none scheduled). T12817 */
let _immediate: ReturnType<typeof setImmediate> | undefined;

/**
 * Tail of the serialized drain chain. Every drain runs after the previous one
 * settles, so entries enqueued while a drain is in flight are picked up by the
 * next link instead of waiting for the unref'd timer. T12817
 */
let _drainTail: Promise<unknown> = Promise.resolve();

/**
 * Drain the queue synchronously where possible, or fall back to async writes.
 * Returns when all observations in the current batch have been persisted.
 */
async function drainQueue(): Promise<number> {
  if (_queue.length === 0) return 0;

  // Snapshot current batch and clear the queue
  const batch = _queue.splice(0, _queue.length);
  let count = 0;

  // Import observeBrain lazily to avoid circular dependencies at module load
  const { observeBrain } = await import('./brain-retrieval.js');

  for (const entry of batch) {
    try {
      const result = await observeBrain(entry.projectRoot, entry.params);
      entry.resolve(result);
      count++;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      entry.reject(error);
    }
  }

  return count;
}

/**
 * Run {@link drainQueue} after every earlier drain has settled.
 *
 * @returns The number of observations this drain persisted.
 */
function serialDrain(): Promise<number> {
  const next = _drainTail.then(() => drainQueue());
  _drainTail = next.catch(() => undefined);
  return next;
}

/**
 * Schedule a prompt drain on the next macrotask (T12817).
 *
 * The handle is deliberately NOT unref'd: an enqueued observation is pending
 * I/O the process owes its caller, so it must keep the event loop alive until
 * written. Entries enqueued in the same tick share one drain.
 */
function schedulePromptDrain(): void {
  if (_immediate !== undefined) return;
  _immediate = setImmediate(() => {
    _immediate = undefined;
    serialDrain().catch(() => {
      /* per-entry errors already rejected their callers */
    });
  });
}

/**
 * Best-effort synchronous exit flush.
 * Used in 'exit' event handler where async I/O is not guaranteed.
 * Falls back to fire-and-forget if the environment does not support
 * synchronous-style promises (i.e., in environments where the event
 * loop may already be draining).
 */
function exitFlush(): void {
  if (_queue.length === 0) return;
  // We can't reliably await in a synchronous exit handler. The best we
  // can do is trigger the drain and hope the pending writes complete.
  drainQueue().catch(() => {
    // Silently swallow — process is terminating anyway
  });
}

/**
 * Register process-exit hooks once.
 * Ensures that no observations are silently dropped on graceful shutdown.
 */
function registerExitHooks(): void {
  if (_hooksRegistered) return;
  _hooksRegistered = true;

  process.on('exit', exitFlush);

  process.once('SIGINT', () => {
    // Enforce a 2s hard deadline so tests/CI are never blocked by a stuck drain.
    const deadline = setTimeout(() => process.exit(130), 2_000);
    deadline.unref();
    drainQueue()
      .catch(() => {
        /* best-effort */
      })
      .finally(() => {
        clearTimeout(deadline);
        process.exit(130); // 128 + SIGINT
      });
  });

  process.once('SIGTERM', () => {
    // Enforce a 2s hard deadline so tests/CI are never blocked by a stuck drain.
    const deadline = setTimeout(() => process.exit(143), 2_000);
    deadline.unref();
    drainQueue()
      .catch(() => {
        /* best-effort */
      })
      .finally(() => {
        clearTimeout(deadline);
        process.exit(143); // 128 + SIGTERM
      });
  });
}

/**
 * Start the periodic flush timer if it isn't already running.
 */
function ensureTimer(): void {
  if (_timer !== undefined) return;
  _timer = setInterval(() => {
    if (_queue.length === 0) return;
    serialDrain().catch(() => {
      /* best-effort */
    });
  }, FLUSH_INTERVAL_MS);
  // Unref so the timer doesn't prevent process exit when queue is idle
  if (typeof _timer.unref === 'function') {
    _timer.unref();
  }
}

// ---------------------------------------------------------------------------
// Public singleton
// ---------------------------------------------------------------------------

/**
 * Mental-model queue singleton.
 *
 * Use this instead of calling observeBrain() directly when writing agent-tagged
 * observations that should be queued for async persistence (ULTRAPLAN L5).
 */
export const mentalModelQueue: MentalModelQueue = {
  enqueue(
    projectRoot: string,
    params: ObserveBrainParams & { agent: string },
  ): Promise<ObserveBrainResult> {
    registerExitHooks();
    ensureTimer();

    return new Promise<ObserveBrainResult>((resolve, reject) => {
      _queue.push({ projectRoot, params, resolve, reject });

      if (_queue.length >= FLUSH_WATERMARK) {
        // High-watermark flush
        serialDrain().catch(() => {
          /* best-effort */
        });
      } else {
        // T12817: guarantee the caller's promise settles in a one-shot process.
        schedulePromptDrain();
      }
    });
  },

  flush(): Promise<number> {
    return serialDrain();
  },

  size(): number {
    return _queue.length;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reset in-process queue state.
 *
 * Stops the flush timer, rejects any pending observations with a cancellation
 * error, and clears internal flags. Intended for test teardown only — never
 * call this in production code.
 *
 * @internal
 */
export function _resetMentalModelQueueForTests(): void {
  // Stop the periodic flush timer.
  if (_timer !== undefined) {
    clearInterval(_timer);
    _timer = undefined;
  }
  if (_immediate !== undefined) {
    clearImmediate(_immediate);
    _immediate = undefined;
  }
  _drainTail = Promise.resolve();

  // Reject all pending observations so test assertions can proceed.
  const pending = _queue.splice(0, _queue.length);
  const cancelErr = new Error('[test teardown] mental-model queue reset');
  for (const entry of pending) {
    entry.reject(cancelErr);
  }

  _hooksRegistered = false;
}

/**
 * Determine whether an observation should be routed through the mental-model
 * queue rather than written synchronously.
 *
 * Returns `true` when the observation has a non-empty `agent` field AND a
 * mental-model-relevant type.
 *
 * @param params - Observation parameters to evaluate.
 */
export function isMentalModelObservation(params: ObserveBrainParams): boolean {
  if (!params.agent) return false;
  const type = params.type ?? 'discovery';
  return MENTAL_MODEL_TYPES.has(type);
}
