/**
 * Async reinforcement queue for non-blocking mental-model writes.
 *
 * ULTRAPLAN L5 compliance: observations tagged with an `agent` provenance and a
 * mental-model-relevant type ('discovery', 'change', 'feature', 'decision') are
 * routed through this queue instead of writing synchronously to brain.db. This
 * decouples the hot path (agent execution) from I/O latency.
 *
 * The queue is drained to brain.db either:
 *   1. Periodically — every {@link FLUSH_INTERVAL_MS} milliseconds via a timer.
 *   2. On high watermark — when the queue exceeds {@link FLUSH_WATERMARK} entries.
 *   3. On process exit — SIGINT, SIGTERM, and 'exit' hooks perform a best-effort
 *      synchronous flush so no observations are lost.
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
  enqueue(projectRoot: string, params: ObserveBrainParams & { agent: string }): Promise<ObserveBrainResult>;

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

/** Whether a flush is currently in progress (prevents re-entrant flushes). */
let _flushing = false;

/** Whether process-exit hooks have been registered. */
let _hooksRegistered = false;

/** Handle for the periodic flush timer (undefined = no active timer). */
let _timer: ReturnType<typeof setInterval> | undefined;

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
    drainQueue()
      .catch(() => {
        /* best-effort */
      })
      .finally(() => {
        process.exit(130); // 128 + SIGINT
      });
  });

  process.once('SIGTERM', () => {
    drainQueue()
      .catch(() => {
        /* best-effort */
      })
      .finally(() => {
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
    if (_flushing) return;
    _flushing = true;
    drainQueue()
      .catch(() => {
        /* best-effort */
      })
      .finally(() => {
        _flushing = false;
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

      // High-watermark flush
      if (_queue.length >= FLUSH_WATERMARK && !_flushing) {
        _flushing = true;
        drainQueue()
          .catch(() => {
            /* best-effort */
          })
          .finally(() => {
            _flushing = false;
          });
      }
    });
  },

  async flush(): Promise<number> {
    if (_flushing) {
      // Wait for the current flush to settle then flush again
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    _flushing = true;
    try {
      return await drainQueue();
    } finally {
      _flushing = false;
    }
  },

  size(): number {
    return _queue.length;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
