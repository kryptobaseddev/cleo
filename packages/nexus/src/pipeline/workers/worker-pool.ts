/**
 * Worker pool for parallel multi-file parsing.
 *
 * Ported from GitNexus `src/core/ingestion/workers/worker-pool.ts` and
 * adapted for the CLEO nexus pipeline (TypeScript/JavaScript only, CLEO
 * node types, ESM-compatible URL-based worker loading).
 *
 * Key design decisions:
 * - Pool size: `os.cpus().length - 1` (leave 1 core for main thread), max 8
 * - Files split into sub-batches of 1500 per postMessage call to bound IPC
 *   memory per message (structured clone is O(data))
 * - 30-second timeout per sub-batch — fails fast on pathological files
 * - Falls back to sequential if worker script is not found (e.g. running
 *   from source without a build)
 * - Retry once on worker crash before falling back to sequential
 *
 * @task T540
 * @module pipeline/workers/worker-pool
 */

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Interface for a worker pool that dispatches items across worker threads.
 */
export interface WorkerPool {
  /**
   * Dispatch items across workers.
   *
   * Items are split into chunks (one chunk per worker), each worker processes
   * its chunk via sub-batches to limit peak IPC memory, and results are
   * concatenated back in original order.
   *
   * @param items - The input items to distribute
   * @param onProgress - Optional progress callback with total files processed
   */
  dispatch<TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult[]>;

  /** Terminate all workers. Must be called after dispatch completes. */
  terminate(): Promise<void>;

  /** Number of workers in the pool. */
  readonly size: number;
}

// ---------------------------------------------------------------------------
// IPC message shapes
// ---------------------------------------------------------------------------

/** Messages sent FROM worker threads back to the pool. */
type WorkerOutgoingMessage =
  | { type: 'progress'; filesProcessed: number }
  | { type: 'sub-batch-done' }
  | { type: 'error'; error: string }
  | { type: 'result'; data: unknown };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Max files per postMessage call.
 * Bounds peak structured-clone memory per sub-batch.
 */
const SUB_BATCH_SIZE = 1500;

/**
 * Per sub-batch timeout in milliseconds.
 * If a sub-batch takes longer than this, likely a pathological file.
 */
const SUB_BATCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a pool of worker threads for parallel file parsing.
 *
 * @param workerUrl - `import.meta.resolve(...)` URL pointing to the worker
 *   script. The file must exist (checked synchronously before spawning).
 * @param poolSize - Override pool size. Defaults to `cpu count - 1` (max 8).
 * @returns A WorkerPool instance.
 * @throws If the worker script file is not found on disk.
 */
export function createWorkerPool(workerUrl: URL, poolSize?: number): WorkerPool {
  // Validate worker script exists before spawning — avoids uncaught
  // MODULE_NOT_FOUND crashes inside worker threads when running from src/.
  const workerPath = fileURLToPath(workerUrl);
  if (!fs.existsSync(workerPath)) {
    throw new Error(`Worker script not found: ${workerPath}`);
  }

  const size = poolSize ?? Math.min(8, Math.max(1, os.cpus().length - 1));
  const workers: Worker[] = [];

  for (let i = 0; i < size; i++) {
    workers.push(new Worker(workerUrl));
  }

  /**
   * Dispatch `items` to worker `workers[workerIndex]`, streaming sub-batches
   * of `SUB_BATCH_SIZE` files and collecting the final accumulated result.
   */
  function dispatchToWorker<TInput, TResult>(
    chunk: TInput[],
    workerIndex: number,
    workerProgress: number[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult> {
    const worker = workers[workerIndex];

    return new Promise<TResult>((resolve, reject) => {
      let settled = false;
      let subBatchTimer: ReturnType<typeof setTimeout> | null = null;
      let subBatchIdx = 0;

      const cleanup = () => {
        if (subBatchTimer) {
          clearTimeout(subBatchTimer);
          subBatchTimer = null;
        }
        worker.removeListener('message', handler);
        worker.removeListener('error', errorHandler);
        worker.removeListener('exit', exitHandler);
      };

      const resetSubBatchTimer = () => {
        if (subBatchTimer) clearTimeout(subBatchTimer);
        subBatchTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `Worker ${workerIndex} sub-batch timed out after ${SUB_BATCH_TIMEOUT_MS / 1000}s (chunk: ${chunk.length} items).`,
              ),
            );
          }
        }, SUB_BATCH_TIMEOUT_MS);
      };

      const sendNextSubBatch = () => {
        const start = subBatchIdx * SUB_BATCH_SIZE;
        if (start >= chunk.length) {
          // All sub-batches sent — flush to collect accumulated result
          worker.postMessage({ type: 'flush' });
          return;
        }
        const subBatch = chunk.slice(start, start + SUB_BATCH_SIZE);
        subBatchIdx++;
        resetSubBatchTimer();
        worker.postMessage({ type: 'sub-batch', files: subBatch });
      };

      const handler = (msg: WorkerOutgoingMessage) => {
        if (settled) return;
        if (msg.type === 'progress') {
          workerProgress[workerIndex] = msg.filesProcessed;
          if (onProgress) {
            const total = workerProgress.reduce((a, b) => a + b, 0);
            onProgress(total);
          }
        } else if (msg.type === 'sub-batch-done') {
          sendNextSubBatch();
        } else if (msg.type === 'error') {
          settled = true;
          cleanup();
          reject(new Error(`Worker ${workerIndex} error: ${msg.error}`));
        } else if (msg.type === 'result') {
          settled = true;
          cleanup();
          resolve(msg.data as TResult);
        }
      };

      const errorHandler = (err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      const exitHandler = (code: number) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(
            new Error(
              `Worker ${workerIndex} exited with code ${code}. Possible OOM or native module failure.`,
            ),
          );
        }
      };

      worker.on('message', handler);
      worker.once('error', errorHandler);
      worker.once('exit', exitHandler);

      sendNextSubBatch();
    });
  }

  const dispatch = <TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult[]> => {
    if (items.length === 0) return Promise.resolve([]);

    // Distribute items evenly across workers
    const chunkSize = Math.ceil(items.length / size);
    const chunks: TInput[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    const workerProgress = new Array<number>(chunks.length).fill(0);

    const promises = chunks.map((chunk, i) =>
      dispatchToWorker<TInput, TResult>(chunk, i, workerProgress, onProgress),
    );

    return Promise.all(promises);
  };

  const terminate = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.terminate()));
    workers.length = 0;
  };

  return { dispatch, terminate, size };
}
