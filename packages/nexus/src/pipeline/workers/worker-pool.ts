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
import type {
  ParserExecutionLimits,
  ParserExecutionPort,
  ParserProcessHandle,
} from '@cleocode/contracts';
import {
  PARSER_WORKER_HEAP_DEFAULT_MB,
  PARSER_WORKER_HEAP_MAX_MB,
  PARSER_WORKER_HEAP_MIN_MB,
} from '@cleocode/contracts';

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
  | { type: 'ready'; heapBytes: number }
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
 * Per-file wall budget for a parse worker, in milliseconds.
 *
 * `SUB_BATCH_SIZE` is 1, so this is the time allowed for ONE file — and an
 * overrun rejects the whole dispatch, discarding every file already parsed
 * ("generation not published"). Measured 2026-09-23 on a fuseblk mount under
 * concurrent load from other builds: `cleo nexus analyze` over 4 498 files died
 * with `E_PARSE_WORKER_TIMEOUT: Worker 0 file timed out after 5000ms`, naming
 * no file and no remedy, after 212 s of work.
 *
 * A normal parse is milliseconds; this budget exists to bound a pathological
 * file, not to race a loaded machine. It is generous for that reason, and
 * overridable per {@link PARSE_TIMEOUT_ENV}.
 *
 * @task T12312
 */
const SUB_BATCH_TIMEOUT_MS = 30_000;

/** Operator override for the per-file parse budget, in milliseconds. */
export const PARSE_TIMEOUT_ENV = 'CLEO_NEXUS_PARSE_TIMEOUT_MS';

/** Operator override for each parse worker's V8 old-space cap, in MiB. */
export const WORKER_HEAP_ENV = 'CLEO_NEXUS_WORKER_HEAP_MB';

/** Default V8 old-space cap per parse worker, in MiB. */
const DEFAULT_WORKER_HEAP_MB = PARSER_WORKER_HEAP_DEFAULT_MB;

// T12313: 128MiB was measured insufficient on a real repository — a worker
// reached 162MiB of live old-space after Mark-Compact and died with
// "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of
// memory", which surfaced only as a broken pipe. The cap is a CEILING, not an
// allocation: a worker that does not need the headroom never takes it.

/** Highest cap an operator may request; the default stays conservative. */
const MAX_WORKER_HEAP_MB = PARSER_WORKER_HEAP_MAX_MB;

/**
 * V8 old-space cap for one parse worker, honouring the operator override.
 *
 * A worker that exceeds its cap exits with a null code and the dispatch
 * rejects, discarding every file parsed in the run. Measured 2026-09-23 over
 * 4 498 files: workers died both inside CLEO's `cleo-tool-*.scope` (a memcg
 * kill at 251 MB RSS, confirmed in the kernel log) and outside it with no
 * kernel OOM at all — the second being the V8 cap itself. The default is
 * unchanged; what was missing was any way to raise it without editing source.
 *
 * @task T12312
 */
function resolveWorkerHeapMb(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (explicit !== undefined) return explicit;
  const override = Number.parseInt(env[WORKER_HEAP_ENV] ?? '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_WORKER_HEAP_MB;
}

/** Per-file parse budget, honouring the operator override. */
function resolveParseTimeoutMs(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (explicit !== undefined) return explicit;
  const override = Number.parseInt(env[PARSE_TIMEOUT_ENV] ?? '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  return SUB_BATCH_TIMEOUT_MS;
}

/**
 * The worker's own account of its death, when the transport retained one.
 *
 * A thread-based worker has no separate stderr, and a child that said nothing
 * yields nothing — both return an empty string rather than inventing a cause.
 */
function workerStderr(owned: Worker | ParserProcessHandle): string {
  if (owned instanceof Worker) return '';
  const tail = owned.stderrTail().trim();
  return tail.length === 0 ? '' : ` The worker's own output was:\n${tail}`;
}

/**
 * How the child actually ended, which the parent knows and never reported.
 *
 * A signal means something KILLED it — the pool's own abort, a memory cgroup,
 * or the kernel — and no amount of raising a heap ceiling addresses that. A
 * numeric code means it exited under its own control. Reporting the broken
 * pipe without this left both indistinguishable (T12313).
 */
function workerExitCause(owned: Worker | ParserProcessHandle): string {
  if (owned instanceof Worker) return '';
  const { exitCode, signalCode } = owned.child;
  if (signalCode !== null && signalCode !== undefined)
    return ` The worker was KILLED by ${signalCode}, so it did not fail on its own — look for an abort, a deadline, or a memory ceiling rather than a parser defect.`;
  if (exitCode !== null && exitCode !== undefined)
    return ` The worker exited with code ${exitCode} under its own control.`;
  return ' The worker had not recorded an exit code when the write failed.';
}

/** Best-effort path of a dispatched work item, for diagnostics only. */
function describeWorkItem(item: unknown): string {
  if (typeof item === 'object' && item !== null && 'path' in item) {
    const { path } = item as { path: unknown };
    if (typeof path === 'string' && path.length > 0) return path;
  }
  return '<unknown file>';
}

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
 * @param execution - Runtime process port; avoids inherited worker heap overrides.
 * @returns A WorkerPool instance.
 * @throws If the worker script file is not found on disk.
 */
export function createWorkerPool(
  workerUrl: URL,
  poolSize?: number,
  limits: ParserExecutionLimits = {},
  execution?: ParserExecutionPort,
): WorkerPool {
  // Validate worker script exists before spawning — avoids uncaught
  // MODULE_NOT_FOUND crashes inside worker threads when running from src/.
  const workerPath = fileURLToPath(workerUrl);
  if (!fs.existsSync(workerPath)) {
    throw new Error(`Worker script not found: ${workerPath}`);
  }

  const size = poolSize ?? Math.min(8, Math.max(1, os.cpus().length - 1));
  const timeoutMs = resolveParseTimeoutMs(limits.timeoutMs);
  const workerHeapMb = resolveWorkerHeapMb(limits.workerHeapMb);
  if (!Number.isSafeInteger(size) || size < 1 || size > 8) {
    throw new RangeError('Parser pool size must be an integer from 1 to 8');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Parser worker timeout must be positive and finite');
  }
  if (
    !Number.isSafeInteger(workerHeapMb) ||
    workerHeapMb < PARSER_WORKER_HEAP_MIN_MB ||
    workerHeapMb > MAX_WORKER_HEAP_MB
  ) {
    throw new RangeError(
      `Parser worker heap must be an integer from ${PARSER_WORKER_HEAP_MIN_MB} to ${MAX_WORKER_HEAP_MB} MiB`,
    );
  }
  // V8's process-level flags silently override Worker.resourceLimits. A claimed
  // per-worker ceiling would otherwise be false even when resourceLimits reports it.
  const inheritedFlags = `${process.env['NODE_OPTIONS'] ?? ''} ${process.execArgv.join(' ')}`;
  if (
    !execution &&
    /--max[-_]old[-_]space[-_]size|--max[-_]semi[-_]space[-_]size/.test(inheritedFlags)
  ) {
    throw new Error('E_PARSE_WORKER_HEAP_OVERRIDE: inherited V8 heap flags override worker limits');
  }
  limits.signal?.throwIfAborted();
  const workers: Array<Worker | ParserProcessHandle> = [];
  let active = false;
  let terminated = false;
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    terminated = true;
    termination ??= Promise.all(
      workers.map((worker) => (worker instanceof Worker ? worker.terminate() : worker.stop())),
    ).then(() => undefined);
    return termination;
  };

  /**
   * Retire the worker in `index` and put a fresh one in its place.
   *
   * A worker that has died cannot be written to again, so retrying its chunk
   * requires a new process. Stopping the old one first keeps the accounting
   * honest: a slot never holds two live workers (T12313).
   *
   * @param index - Slot to replace.
   */
  async function replaceWorker(index: number): Promise<void> {
    const dead = workers[index];
    if (dead !== undefined) {
      try {
        if (dead instanceof Worker) await dead.terminate();
        else await dead.stop();
      } catch {
        // Already gone — which is the case this exists to handle.
      }
    }
    workers[index] = execution
      ? execution.spawn(workerPath, { ...limits, workerHeapMb })
      : new Worker(workerUrl, {
          resourceLimits: {
            maxOldGenerationSizeMb: workerHeapMb,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
        });
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
    const owned = workers[workerIndex];
    const worker = owned instanceof Worker ? owned : owned.child;
    return new Promise<TResult>((resolve, reject) => {
      const send = (message: object) => {
        if (owned instanceof Worker) owned.postMessage(message);
        else
          owned.child.send(message, (error) => {
            if (!error) return;
            // A write error means the worker is already gone. Reporting EPIPE
            // verbatim names the pipe, not the death — and settles the promise
            // before the 'exit' handler can supply the actual reason (T12312).
            const broken = /EPIPE|ERR_IPC_CHANNEL_CLOSED/.test(error.message);
            errorHandler(
              broken
                ? new Error(
                    `Parse worker ${workerIndex} closed its channel while handling ` +
                      `${inFlightDescription} (${error.message}); it had just finished ` +
                      `${previousDescription}. The write failed because the ` +
                      `worker had already exited; the pipe is the symptom, not the cause. ` +
                      `Every file parsed so far is discarded. Check the kernel log for an ` +
                      `oom-kill naming this process, then raise ${WORKER_HEAP_ENV}=<MiB> or the ` +
                      `cgroup ceiling (CLEO_TOOL_MEMORY_MAX_MB); a native parser crash on one ` +
                      `file presents the same way.${workerExitCause(owned)}${workerStderr(owned)}`,
                    { cause: error },
                  )
                : error,
            );
          });
      };
      let settled = false;
      let ready = owned instanceof Worker;
      let subBatchTimer: ReturnType<typeof setTimeout> | null = null;
      let subBatchIdx = 0;
      // Retained for diagnostics: a timeout that cannot name the file it was
      // parsing sends the reader looking through 4 498 of them.
      let inFlightDescription = '<not yet dispatched>';
      // The send that FAILS names the file we were about to hand over — the
      // one that killed the worker is the one it had just finished (T12313).
      let previousDescription = '<none>';

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
                `E_PARSE_WORKER_TIMEOUT: worker ${workerIndex} exceeded ${timeoutMs}ms parsing ` +
                  `${inFlightDescription}. Every file parsed so far in this run is discarded, so ` +
                  `one slow file fails the whole index. Raise the per-file budget with ` +
                  `${PARSE_TIMEOUT_ENV}=<ms> — a loaded machine or a network/FUSE mount can ` +
                  `exceed the default, and a genuinely pathological file will still be bounded.`,
              ),
            );
          }
        }, timeoutMs);
      };

      const sendNextSubBatch = () => {
        const start = subBatchIdx * SUB_BATCH_SIZE;
        if (start >= chunk.length) {
          // All sub-batches sent — flush to collect accumulated result
          send({ type: 'flush' });
          return;
        }
        const subBatch = chunk.slice(start, start + SUB_BATCH_SIZE);
        previousDescription = inFlightDescription;
        inFlightDescription = subBatch.map(describeWorkItem).join(', ');
        subBatchIdx++;
        resetSubBatchTimer();
        send({ type: 'sub-batch', files: subBatch });
      };

      const handler = (msg: WorkerOutgoingMessage) => {
        if (settled) return;
        if (msg.type === 'ready') {
          ready = true;
          if (
            !Number.isFinite(msg.heapBytes) ||
            msg.heapBytes > (workerHeapMb + 32) * 1024 * 1024
          ) {
            errorHandler(
              new Error('E_PARSE_WORKER_HEAP_OVERRIDE: actual V8 heap exceeds requested bound'),
            );
          }
        } else if (msg.type === 'progress') {
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
          if (!ready) {
            errorHandler(new Error('Parser did not verify its effective heap limit'));
            return;
          }
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
              `Parse worker ${workerIndex} exited with code ${code} while handling ` +
                `${inFlightDescription}. Every file parsed so far is discarded. ` +
                (code === null
                  ? `A null code means it was KILLED rather than returning — most often the ` +
                    `${workerHeapMb}MiB V8 old-space cap, or a memory-cgroup ceiling when CLEO ` +
                    `confines the run. Raise ${WORKER_HEAP_ENV}=<MiB>; if the kernel log shows ` +
                    `an oom-kill with constraint=CONSTRAINT_MEMCG, raise CLEO_TOOL_MEMORY_MAX_MB ` +
                    `or disable confinement with CLEO_NO_TOOL_CGROUP=1.`
                  : `A non-null code means the worker THREW rather than being killed, so memory ` +
                    `limits are not the cause and raising them will not help. The named file is ` +
                    `the one dispatched to this worker; re-run with a single worker to confirm ` +
                    `it is the trigger rather than a coincidence of timing.`) +
                workerStderr(owned),
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
    try {
      for (let i = workers.length; i < Math.min(size, items.length); i++) {
        workers.push(
          execution
            ? execution.spawn(workerPath, { ...limits, workerHeapMb })
            : new Worker(workerUrl, {
                resourceLimits: {
                  maxOldGenerationSizeMb: workerHeapMb,
                  maxYoungGenerationSizeMb: 16,
                  stackSizeMb: 4,
                },
              }),
        );
      }
    } catch (error) {
      await terminate();
      active = false;
      throw error;
    }

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
      // T12313: one worker dying used to discard EVERY file the others had
      // already parsed — 3 499 of them in a measured run — because
      // `Promise.all` rejects on the first failure and the generation is then
      // never published. A worker that dies before it has processed anything
      // is not evidence that the work is unparseable, so its chunk is retried
      // once on a fresh worker before the run is abandoned.
      const settled = await Promise.allSettled(promises);
      const failures = settled.flatMap((outcome, index) =>
        outcome.status === 'rejected' ? [{ index, reason: outcome.reason }] : [],
      );
      if (failures.length === 0)
        return settled.map((outcome) =>
          outcome.status === 'fulfilled' ? outcome.value : (undefined as unknown as TResult),
        );

      const results = settled.map((outcome) =>
        outcome.status === 'fulfilled' ? outcome.value : (undefined as unknown as TResult),
      );
      for (const failure of failures) {
        const chunk = chunks[failure.index];
        if (chunk === undefined) throw failure.reason;
        // Replace the dead slot; reusing it would fail the same way.
        await replaceWorker(failure.index);
        // A second death is a real defect, not a transient one — let it throw
        // with its own diagnostic rather than silently publishing a partial
        // index that reads as complete.
        results[failure.index] = await dispatchToWorker<TInput, TResult>(
          chunk,
          failure.index,
          workerProgress,
          onProgress,
        );
      }
      return results;
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
