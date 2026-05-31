/**
 * BRAIN single-writer chokepoint — main-thread queue manager.
 *
 * All hot-path writes to `brain.db` MUST route through `enqueueBrainWrite` so
 * that a single Node.js `worker_threads.Worker` owns the only write handle and
 * serializes every INSERT/UPDATE through one consumer. This eliminates the
 * within-process race documented in the T10301 RCA (page-1 sqlite_schema
 * B-tree corruption caused by concurrent setImmediate writers + dialectic-hook
 * + propose-tick reconciler + STDP plasticity loop all opening their own
 * `getBrainDb` singletons).
 *
 * ## Architecture
 *
 *  Main thread                         Worker thread
 *  ───────────                         ─────────────
 *  enqueueBrainWrite(op)               (owns getBrainDb handle)
 *        │                                    ▲
 *        ▼                                    │ MessagePort
 *  pendingRequests[seq] = {resolve, reject}   │
 *        │                                    │
 *        └──── postMessage({seq, op}) ────────┘
 *                                             │
 *                                             ▼
 *                                       handleWriteOp(op)
 *                                       (SQL INSERT/UPDATE)
 *                                             │
 *        ┌──── postMessage({seq, ok, ...})────┘
 *        ▼
 *  resolve(...) → caller's await
 *
 * Reads continue to use `getBrainDb` / `getBrainNativeDb` directly. SQLite WAL
 * permits concurrent readers; only writes must be funneled.
 *
 * ## Bypass mechanism
 *
 * Forensic / one-shot scripts that need a direct write handle can set
 * `CLEO_BRAIN_BYPASS_WRITER_THREAD=1`. Each call to `enqueueBrainWrite` then
 * executes the op inline on the main thread. **A Pino warn is emitted on every
 * bypass** (audit trail per AC #5).
 *
 * @task T10351
 * @epic T10286
 * @saga T10281
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ObserveBrainParams, ObserveBrainResult } from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import type { NewBrainDecisionRow, NewBrainLearningRow } from '../store/schema/memory-schema.js';

// ============================================================================
// Discriminated union — BrainWriteOp
// ============================================================================

/**
 * Discriminated union of all hot-path brain.db write operations.
 *
 * Adding a new op kind:
 *  1. Add the variant here.
 *  2. Implement the corresponding handler in `brain-writer-worker.ts`.
 *  3. Update the BrainWriteResult union to mirror the return shape.
 */
export type BrainWriteOp =
  | BrainObserveOp
  | BrainDecisionOp
  | BrainLearningOp
  | BrainPlasticityEventOp
  | BrainWeightUpdateOp
  | BrainDialecticOp;

/** Insert a new observation row via the canonical `observeBrain` pipeline. */
export interface BrainObserveOp {
  kind: 'observe';
  projectRoot: string;
  params: ObserveBrainParams;
}

/** Insert a new decision row. */
export interface BrainDecisionOp {
  kind: 'decision';
  projectRoot: string;
  /** Fully-prepared NewBrainDecisionRow shape (serializable). */
  row: NewBrainDecisionRow;
}

/** Insert a new learning row. */
export interface BrainLearningOp {
  kind: 'learning';
  projectRoot: string;
  /** Fully-prepared NewBrainLearningRow shape (serializable). */
  row: NewBrainLearningRow;
}

/** Insert a brain_plasticity_events row (raw SQL params, T679 ordering). */
export interface BrainPlasticityEventOp {
  kind: 'plasticity_event';
  projectRoot: string;
  sourceNode: string;
  targetNode: string;
  deltaW: number;
  eventKind: 'ltp' | 'ltd' | 'hebbian';
  timestamp: string;
  sessionId: string | null;
  retrievalLogId: number | null;
  weightBefore: number | null;
  weightAfter: number;
  deltaTms: number;
}

/** Insert a brain_weight_history row (T679 spec §2.1.4). */
export interface BrainWeightUpdateOp {
  kind: 'weight_update';
  projectRoot: string;
  edgeFromId: string;
  edgeToId: string;
  edgeType: 'co_retrieved' | 'related' | 'depends_on' | 'caused_by';
  weightBefore: number | null;
  weightAfter: number;
  deltaWeight: number;
  eventKind: 'ltp' | 'ltd' | 'hebbian';
  sourcePlasticityEventId: number | null;
  retrievalLogId: number | null;
  rewardSignal: number | null;
  changedAt: string;
}

/**
 * Dialectic composite op — fires the full `applyInsights` pipeline on the
 * worker (calls into `observeBrain` and `appendNarrativeDelta`).
 */
export interface BrainDialecticOp {
  kind: 'dialectic';
  projectRoot: string;
  sessionId: string;
  activePeerId: string;
  insights: SerializedDialecticInsights;
}

/**
 * Serializable copy of `DialecticInsights` (the `applyInsights` callers pass
 * objects already shaped by the evaluator; we re-declare the shape here so the
 * writer-thread layer does not depend on the evaluator module).
 */
export interface SerializedDialecticInsights {
  globalTraits: Array<{ key: string; value: string; confidence: number }>;
  peerInsights: Array<{ key: string; value: string; confidence: number }>;
  sessionNarrativeDelta: string | null;
}

// ============================================================================
// Result shapes (worker → main)
// ============================================================================

/** Successful result of a write op (shape varies by op kind). */
export type BrainWriteResult =
  | { kind: 'observe'; result: ObserveBrainResult }
  | { kind: 'decision'; id: string }
  | { kind: 'learning'; id: string }
  | { kind: 'plasticity_event'; lastInsertRowid: number | null }
  | { kind: 'weight_update'; ok: true }
  | { kind: 'dialectic'; ok: true };

// ============================================================================
// Wire protocol — main ↔ worker
// ============================================================================

/** Outbound message envelope (main → worker). */
export interface WriterRequestEnvelope {
  seq: number;
  op: BrainWriteOp;
}

/** Inbound message envelope (worker → main). */
export type WriterResponseEnvelope =
  | { seq: number; ok: true; result: BrainWriteResult }
  | { seq: number; ok: false; error: string };

// ============================================================================
// Bypass mode (CLEO_BRAIN_BYPASS_WRITER_THREAD=1)
// ============================================================================

/**
 * Check whether the bypass env var is set. Emits a Pino warn on every call
 * so the audit trail is preserved (AC #5).
 */
function bypassEnabled(): boolean {
  const flag = process.env['CLEO_BRAIN_BYPASS_WRITER_THREAD'];
  if (flag === '1') {
    getLogger('brain-writer').warn(
      { event: 'bypass-active', envVar: 'CLEO_BRAIN_BYPASS_WRITER_THREAD' },
      'Brain writer-thread chokepoint bypassed via env var — direct main-thread write',
    );
    return true;
  }
  return false;
}

// ============================================================================
// Main-thread queue manager
// ============================================================================

/**
 * Resolve the absolute path to the compiled brain-writer-worker script.
 *
 * Strategy:
 *  1. Adjacent to this file (`memory/brain-writer-worker.js`)
 *  2. Fallback null when not found (esbuild bundle context, tests, etc.)
 */
function resolveWorkerPath(): string | null {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidate = join(currentDir, 'brain-writer-worker.js');
    if (existsSync(candidate)) return candidate;
    return null;
  } catch {
    return null;
  }
}

interface PendingRequest {
  resolve: (result: BrainWriteResult) => void;
  reject: (err: Error) => void;
}

/**
 * Singleton writer-thread manager. One worker per process, owns the only
 * brain.db write handle. Reads remain on the main thread via `getBrainDb`.
 */
class BrainWriterManager {
  private worker: import('node:worker_threads').Worker | null = null;
  private workerReady = false;
  private workerInitError: Error | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private seqCounter = 0;
  private shuttingDown = false;

  /** Lazy-initialize the worker thread on first enqueue. */
  private async ensureWorker(): Promise<void> {
    if (this.workerReady || this.shuttingDown) return;
    if (this.workerInitError) throw this.workerInitError;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInit(): Promise<void> {
    const workerPath = resolveWorkerPath();
    if (!workerPath) {
      // Worker file unavailable (test sandbox, esbuild bundle). Fall back to
      // inline mode — the public API still serializes via an async mutex.
      this.workerInitError = new Error(
        'brain-writer-worker.js not found adjacent to brain-writer-thread.js',
      );
      throw this.workerInitError;
    }

    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(workerPath);

    worker.on('message', (msg: WriterResponseEnvelope) => {
      this.handleWorkerMessage(msg);
    });

    worker.on('error', (err) => {
      // Reject every in-flight request — caller decides how to retry.
      for (const [, req] of this.pending) {
        req.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.pending.clear();
      this.worker = null;
      this.workerReady = false;
      this.workerInitError = err instanceof Error ? err : new Error(String(err));
      getLogger('brain-writer').error({ err }, 'Brain writer-thread crashed');
    });

    worker.on('exit', (code) => {
      this.worker = null;
      this.workerReady = false;
      if (code !== 0 && !this.shuttingDown) {
        const err = new Error(`brain-writer-worker exited with code ${code}`);
        for (const [, req] of this.pending) {
          req.reject(err);
        }
        this.pending.clear();
        this.workerInitError = err;
      }
    });

    this.worker = worker;
    this.workerReady = true;
  }

  private handleWorkerMessage(msg: WriterResponseEnvelope): void {
    const pending = this.pending.get(msg.seq);
    if (!pending) return; // request was already resolved/rejected (timeout, etc.)
    this.pending.delete(msg.seq);

    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error));
    }
  }

  /**
   * Enqueue a write op. Returns a promise that resolves with the worker's
   * result envelope payload (shape depends on op kind).
   */
  async enqueue(op: BrainWriteOp): Promise<BrainWriteResult> {
    if (this.shuttingDown) {
      throw new Error('brain-writer is shutting down — no new writes accepted');
    }

    await this.ensureWorker();
    const worker = this.worker;
    if (!worker) {
      throw new Error('brain-writer worker is not available');
    }

    const seq = ++this.seqCounter;
    const envelope: WriterRequestEnvelope = { seq, op };

    return new Promise<BrainWriteResult>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      try {
        worker.postMessage(envelope);
      } catch (err) {
        this.pending.delete(seq);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Drain pending work and terminate the worker. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Wait a short grace period for in-flight requests
    const grace = 250;
    const started = Date.now();
    while (this.pending.size > 0 && Date.now() - started < grace) {
      await new Promise((r) => setTimeout(r, 25));
    }

    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // ignore — worker may already be gone
      }
      this.worker = null;
    }
    this.workerReady = false;
    this.pending.clear();
  }

  /** @internal — test helper */
  _hasInFlight(): number {
    return this.pending.size;
  }
}

// ============================================================================
// Inline-mode fallback (bypass + worker-unavailable cases)
// ============================================================================

/**
 * Async mutex used by the inline fallback path so that bypass-mode writes
 * (and the test-env path where the worker file is unavailable) still
 * serialize within the process. Without this guard, the bypass would
 * reintroduce the very race condition the chokepoint exists to eliminate.
 */
let inlineQueueTail: Promise<unknown> = Promise.resolve();

function runInline(op: BrainWriteOp): Promise<BrainWriteResult> {
  const next = inlineQueueTail.then(() => executeInline(op));
  // Swallow rejection in the chain marker so failures don't break later writes.
  inlineQueueTail = next.catch(() => undefined);
  return next;
}

/**
 * Inline executor — imports the worker's handler module dynamically and runs
 * the op on the main thread. Used by:
 *  - bypass mode (`CLEO_BRAIN_BYPASS_WRITER_THREAD=1`)
 *  - worker-unavailable contexts (tests, esbuild bundle context)
 *
 * The handler module is shared between the worker thread and this fallback,
 * so behaviour is identical except for the thread of execution.
 */
async function executeInline(op: BrainWriteOp): Promise<BrainWriteResult> {
  const { handleWriteOp } = await import('./brain-writer-handlers.js');
  return handleWriteOp(op);
}

// ============================================================================
// Public API
// ============================================================================

let _manager: BrainWriterManager | null = null;

function getManager(): BrainWriterManager {
  if (!_manager) {
    _manager = new BrainWriterManager();
    // Best-effort flush on process exit.
    process.on('exit', () => {
      _manager?.shutdown().catch(() => undefined);
    });
    const gracefulShutdown = (): void => {
      const deadline = setTimeout(() => process.exit(0), 2_000);
      deadline.unref();
      _manager
        ?.shutdown()
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(deadline);
        });
    };
    process.once('SIGTERM', gracefulShutdown);
    process.once('SIGINT', gracefulShutdown);
  }
  return _manager;
}

/**
 * Enqueue a brain.db write op through the single-writer chokepoint.
 *
 * Resolves with the typed result for the op's `kind`. Rejects when:
 *  - the op fails inside the worker (worker forwards the error message)
 *  - the worker crashes (the in-flight promise rejects with the worker error)
 *  - bypass mode is on AND the inline execution fails
 *
 * @example
 * ```ts
 * const result = await enqueueBrainWrite({
 *   kind: 'observe',
 *   projectRoot: '/path/to/project',
 *   params: { text: 'Decided X over Y', sourceType: 'manual' },
 * });
 * if (result.kind === 'observe') {
 *   console.log('Stored observation', result.result.id);
 * }
 * ```
 *
 * @param op - The write op (discriminated by `kind`).
 * @returns Worker result for the op.
 */
export async function enqueueBrainWrite(op: BrainWriteOp): Promise<BrainWriteResult> {
  // Bypass mode — log audit warn and run inline.
  if (bypassEnabled()) {
    return runInline(op);
  }

  try {
    return await getManager().enqueue(op);
  } catch (err) {
    // Worker was unavailable (tests, esbuild bundle, etc.). Fall back to
    // inline mode — still serialized via the inline mutex.
    const msg = err instanceof Error ? err.message : String(err);
    getLogger('brain-writer').debug(
      { err: msg },
      'Brain writer-thread unavailable — falling back to inline serialized executor',
    );
    return runInline(op);
  }
}

/**
 * Shutdown the writer-thread singleton (mostly used by tests).
 * @internal
 */
export async function shutdownBrainWriter(): Promise<void> {
  if (_manager) {
    await _manager.shutdown();
    _manager = null;
  }
  inlineQueueTail = Promise.resolve();
}

/**
 * Test helper — reset internal state without shutting the worker down.
 * @internal
 */
export function _resetBrainWriterForTests(): void {
  _manager = null;
  inlineQueueTail = Promise.resolve();
}
