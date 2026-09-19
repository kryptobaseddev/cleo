/**
 * Worker pool for parallel multi-file parsing.
 *
 * Ported from GitNexus `src/core/ingestion/workers/worker-pool.ts` and
 * adapted for the CLEO nexus pipeline (TypeScript/JavaScript only, CLEO
 * node types, ESM-compatible URL-based worker loading).
 *
 * Key design decisions:
 * - Pool size: `os.cpus().length - 1` (leave 1 core for main thread), max 8
 * - Files sent one at a time per worker to bound IPC
 *   memory per message (structured clone is O(data))
 * - Per-file wall deadline terminates a stuck worker
 * - Falls back to sequential if worker script is not found (e.g. running
 *   from source without a build)
 *
 * @task T540
 * @module pipeline/workers/worker-pool
 */

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ParserExecutionLimits } from '@cleocode/contracts';

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
const SUB_BATCH_SIZE = 1;

/**
 * Per sub-batch timeout in milliseconds.
 * If a sub-batch takes longer than this, likely a pathological file.
 */
const SUB_BATCH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a pool of worker threads for parallel file parsing.
 *
 * @param workerUrl - `import.meta.resolve(...)` URL pointing to the worker
 *   script. The file must exist (checked synchronously before spawning).
 * @param poolSize - Override pool size. Defaults to `cpu count - 1` (max 8).
 * @param limits - Per-file wall deadline, caller cancellation and V8 heap bound.
 * @returns A WorkerPool instance.
 * @throws If the worker script file is not found on disk.
 */
export function createWorkerPool(
  workerUrl: URL,
  poolSize?: number,
  limits: ParserExecutionLimits = {},
): WorkerPool {
  // Validate worker script exists before spawning — avoids uncaught
  // MODULE_NOT_FOUND crashes inside worker threads when running from src/.
  const workerPath = fileURLToPath(workerUrl);
  if (!fs.existsSync(workerPath)) {
    throw new Error(`Worker script not found: ${workerPath}`);
  }

  const size = poolSize ?? Math.min(8, Math.max(1, os.cpus().length - 1));
  const timeoutMs = limits.timeoutMs ?? SUB_BATCH_TIMEOUT_MS;
  const workerHeapMb = limits.workerHeapMb ?? 128;
  if (!Number.isSafeInteger(size) || size < 1 || size > 8) {
    throw new RangeError('Parser pool size must be an integer from 1 to 8');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Parser worker timeout must be positive and finite');
  }
  if (!Number.isSafeInteger(workerHeapMb) || workerHeapMb < 8 || workerHeapMb > 512) {
    throw new RangeError('Parser worker heap must be an integer from 8 to 512 MiB');
  }
  // V8's process-level flags silently override Worker.resourceLimits. A claimed
  // per-worker ceiling would otherwise be false even when resourceLimits reports it.
  const inheritedFlags = `${process.env['NODE_OPTIONS'] ?? ''} ${process.execArgv.join(' ')}`;
  if (/--max[-_]old[-_]space[-_]size|--max[-_]semi[-_]space[-_]size/.test(inheritedFlags)) {
    throw new Error('E_PARSE_WORKER_HEAP_OVERRIDE: inherited V8 heap flags override worker limits');
  }
  limits.signal?.throwIfAborted();
  const workers: Worker[] = [];
  let active = false;
  let terminated = false;
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    terminated = true;
    termination ??= Promise.all(workers.map((worker) => worker.terminate())).then(() => undefined);
    return termination;
  };

  for (let i = 0; i < size; i++) {
    workers.push(
      new Worker(workerUrl, {
        resourceLimits: {
          maxOldGenerationSizeMb: workerHeapMb,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      }),
    );
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
        limits.signal?.removeEventListener('abort', abortHandler);
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
                `E_PARSE_WORKER_TIMEOUT: Worker ${workerIndex} file timed out after ${timeoutMs}ms.`,
              ),
            );
          }
        }, timeoutMs);
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

      const abortHandler = () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('E_PARSE_CANCELLED: caller cancelled parser work'));
        }
      };
      limits.signal?.addEventListener('abort', abortHandler, { once: true });
      if (limits.signal?.aborted) {
        abortHandler();
        return;
      }
      worker.on('message', handler);
      worker.once('error', errorHandler);
      worker.once('exit', exitHandler);

      sendNextSubBatch();
    });
  }

  const dispatch = async <TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult[]> => {
    limits.signal?.throwIfAborted();
    if (terminated) throw new Error('Parser worker pool is terminated');
    if (active) throw new Error('Parser worker pool already has an active dispatch');
    if (items.length === 0) return [];
    active = true;

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

    try {
      return await Promise.all(promises);
    } catch (error) {
      // Do not return while another worker can still mutate or allocate.
      await terminate();
      throw error;
    } finally {
      active = false;
    }
  };

  return { dispatch, terminate, size };
}
