/**
 * Embedding Queue Manager
 *
 * Manages an async queue of embedding requests, processing them in batches
 * via a worker thread to avoid blocking the main Node.js event loop.
 *
 * Architecture:
 *   - {@link EmbeddingQueue} is a singleton — one worker thread per process
 *   - {@link EmbeddingQueue.enqueue} adds items; the drain loop batches them
 *   - Batches up to {@link BATCH_SIZE} items per processing cycle
 *   - Falls back to `setImmediate` + direct embedding when worker threads
 *     are unavailable or the worker script cannot be resolved
 *   - Registers a `process.on('exit')` handler for graceful shutdown
 *
 * @epic T134
 * @task T137
 * @why Non-blocking embedding generation for observeBrain()
 * @what Singleton queue + worker-thread batch processor
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Maximum items processed per worker message cycle. */
const BATCH_SIZE = 10;

/** How long to wait between drain cycles when the queue is non-empty (ms). */
const DRAIN_INTERVAL_MS = 50;

/** Pending queue item. */
interface QueueItem {
  observationId: string;
  text: string;
}

/**
 * Resolve the absolute path to the compiled embedding-worker script.
 *
 * Strategy (cheap-first):
 * 1. Adjacent to this file (tsc dev: `dist/memory/embedding-worker.js`)
 * 2. Falls back to null when the file cannot be found (esbuild bundle context)
 */
function resolveWorkerPath(): string | null {
  try {
    // In ESM, __dirname is not available — use import.meta.url
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidate = join(currentDir, 'embedding-worker.js');
    if (existsSync(candidate)) {
      return candidate;
    }
    // Also try ../ for cases where the queue is loaded from a subdirectory
    const parentCandidate = join(currentDir, '..', 'memory', 'embedding-worker.js');
    if (existsSync(parentCandidate)) {
      return parentCandidate;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Singleton embedding queue.
 *
 * Batches embedding requests and processes them via a worker thread,
 * keeping heavy model inference off the main event loop.
 *
 * Use {@link getEmbeddingQueue} to obtain the shared instance.
 */
export class EmbeddingQueue {
  private readonly queue: QueueItem[] = [];
  private worker: import('node:worker_threads').Worker | null = null;
  private workerAvailable = false;
  private draining = false;
  private shutdownPromise: Promise<void> | null = null;

  /**
   * Store the observation ID → DB write callback so the worker result
   * can be persisted back to brain_embeddings without coupling to SQLite here.
   */
  private readonly callbacks = new Map<
    string,
    (observationId: string, embedding: Float32Array) => Promise<void>
  >();

  /** Initialise the worker thread if possible. Called lazily on first enqueue. */
  private async initWorker(): Promise<void> {
    if (this.workerAvailable || this.worker !== null) return;

    const workerPath = resolveWorkerPath();
    if (!workerPath) {
      // esbuild bundle context — worker file not available, use fallback
      this.workerAvailable = false;
      return;
    }

    try {
      const { Worker } = await import('node:worker_threads');
      const worker = new Worker(workerPath);

      worker.on('message', (msg: { id: string; embedding?: number[]; error?: string }) => {
        const cb = this.callbacks.get(msg.id);
        if (!cb) return;
        this.callbacks.delete(msg.id);

        if (msg.embedding) {
          const vector = Float32Array.from(msg.embedding);
          cb(msg.id, vector).catch(() => {
            // Persistence is best-effort; observation already saved without vector
          });
        }
        // On error, skip silently — observation exists without embedding
      });

      worker.on('error', () => {
        // Worker crashed — disable worker path, drain remaining via fallback
        this.worker = null;
        this.workerAvailable = false;
        this.callbacks.clear();
      });

      worker.on('exit', () => {
        this.worker = null;
        this.workerAvailable = false;
      });

      this.worker = worker;
      this.workerAvailable = true;
    } catch {
      // worker_threads unavailable (rare)
      this.workerAvailable = false;
    }
  }

  /**
   * Add an observation to the embedding queue.
   *
   * The observation must already be persisted in brain_observations before
   * calling this method. `onComplete` is called asynchronously with the
   * generated vector once the worker finishes.
   *
   * @param observationId - The brain observation ID (e.g. `O-abc123-0`)
   * @param text - Raw text to embed
   * @param onComplete - Callback to persist the embedding vector
   */
  enqueue(
    observationId: string,
    text: string,
    onComplete: (observationId: string, embedding: Float32Array) => Promise<void>,
  ): void {
    if (this.shutdownPromise) return; // queue is shutting down
    this.callbacks.set(observationId, onComplete);
    this.queue.push({ observationId, text });
    if (!this.draining) {
      this.scheduleDrain();
    }
  }

  /** Schedule the next drain cycle via setImmediate. */
  private scheduleDrain(): void {
    setImmediate(() => {
      this.drain().catch(() => {
        // Drain errors are non-fatal
        this.draining = false;
      });
    });
  }

  /**
   * Process up to {@link BATCH_SIZE} items from the queue.
   * Uses the worker thread when available, falls back to inline setImmediate.
   */
  private async drain(): Promise<void> {
    this.draining = true;

    // Ensure worker is initialised (no-op after first call)
    await this.initWorker();

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH_SIZE);

      if (this.workerAvailable && this.worker) {
        // Dispatch to worker thread — results arrive via 'message' event
        for (const item of batch) {
          this.worker.postMessage({ id: item.observationId, text: item.text });
        }
      } else {
        // Fallback: process inline via setImmediate to yield to event loop
        for (const item of batch) {
          setImmediate(() => {
            this.fallbackEmbed(item).catch(() => {
              // Silently skip — observation already persisted without embedding
              this.callbacks.delete(item.observationId);
            });
          });
        }
      }

      if (this.queue.length > 0) {
        // Yield to event loop between batches
        await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_INTERVAL_MS));
      }
    }

    this.draining = false;
  }

  /**
   * Inline fallback embedding — used when worker thread is unavailable.
   * Runs directly on the main thread (but inside setImmediate to yield first).
   */
  private async fallbackEmbed(item: QueueItem): Promise<void> {
    const cb = this.callbacks.get(item.observationId);
    if (!cb) return;
    this.callbacks.delete(item.observationId);

    const { getLocalEmbeddingProvider } = await import('./embedding-local.js');
    const provider = getLocalEmbeddingProvider();
    const vector = await provider.embed(item.text);
    await cb(item.observationId, vector);
  }

  /**
   * Flush the queue and terminate the worker thread.
   *
   * Waits for in-flight worker messages to drain, then terminates.
   * Safe to call multiple times — subsequent calls return the same promise.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    // Drain remaining queue items
    if (this.queue.length > 0) {
      await this.drain();
    }

    // Terminate the worker
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // Worker may already be gone
      }
      this.worker = null;
    }

    this.callbacks.clear();
  }
}

/** Module-level singleton. */
let _instance: EmbeddingQueue | null = null;

/**
 * Get or create the shared EmbeddingQueue singleton.
 *
 * Registers a process `exit` handler on first call to flush and
 * terminate the worker thread cleanly.
 *
 * @returns The shared EmbeddingQueue instance.
 */
export function getEmbeddingQueue(): EmbeddingQueue {
  if (!_instance) {
    _instance = new EmbeddingQueue();
    // Best-effort flush on process exit (synchronous handlers only get ~50ms)
    process.on('exit', () => {
      _instance?.shutdown().catch(() => {
        // exit handler — cannot await
      });
    });
    // For SIGTERM/SIGINT give the queue time to flush
    const gracefulShutdown = (): void => {
      if (_instance) {
        _instance
          .shutdown()
          .catch(() => {})
          .finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    };
    process.once('SIGTERM', gracefulShutdown);
    process.once('SIGINT', gracefulShutdown);
  }
  return _instance;
}

/**
 * Reset the singleton (for testing only).
 * Shuts down the existing queue before clearing the reference.
 *
 * @internal
 */
export async function resetEmbeddingQueue(): Promise<void> {
  if (_instance) {
    await _instance.shutdown();
    _instance = null;
  }
}
