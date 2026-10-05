/**
 * Bounded background embedding backfill (T13126).
 *
 * A one-shot process stores observations unembedded (see `brain-host.ts`).
 * This helper embeds a bounded batch of them, loading the model once for the
 * batch instead of once per observe. It runs from:
 * - the detached `cleo session end` worker, once per session;
 * - the sentient tick, in an opted-in long-lived host.
 *
 * It does nothing when no observation is pending: the pending count is a plain
 * SQL read, so the model is never loaded for an empty backlog. It runs under
 * the governor's `background-autonomous` class, which grants a slot only when
 * memory pressure is `ok`. A deferral skips the batch, and the next session end
 * or tick retries.
 *
 * @module
 * @task T13126
 */

import { getLogger } from '../logger.js';

/** Set after the first pending-count failure is logged at warn. */
let countFailureWarned = false;

/** Observations embedded per bounded batch unless the caller says otherwise. */
export const DEFAULT_EMBEDDING_BACKFILL_LIMIT = 50;

/** Outcome of {@link runBoundedEmbeddingBackfill}. */
export interface BoundedEmbeddingBackfillResult {
  /** Whether a batch ran (the model was asked to embed). */
  readonly ran: boolean;
  /** Why no batch ran, when {@link ran} is `false`. */
  readonly skipped?: 'none-pending' | 'deferred' | 'unavailable';
  /** Unembedded observations found before the batch. */
  readonly pending: number;
  /** Observations embedded by this batch. */
  readonly processed: number;
  /** Observations that failed to embed in this batch. */
  readonly errors: number;
}

/** Options for {@link runBoundedEmbeddingBackfill}. */
export interface BoundedEmbeddingBackfillOptions {
  /**
   * Maximum observations to embed, newest first.
   * @defaultValue {@link DEFAULT_EMBEDDING_BACKFILL_LIMIT}
   */
  readonly limit?: number;
}

/**
 * Count observations that have a narrative but no embedding yet.
 *
 * A plain SQL read: it never loads the embedding model.
 *
 * @param projectRoot - Project root directory.
 * @returns The pending count, or `0` when the brain store or its vector table
 *   is unavailable.
 */
export async function countUnembeddedObservations(projectRoot: string): Promise<number> {
  try {
    const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb(projectRoot);
    if (!nativeDb) return 0;
    const { typedGet } = await import('../store/typed-query.js');
    const row = typedGet<{ n: number }>(
      nativeDb.prepare(`
        SELECT COUNT(*) AS n
        FROM main.brain_observations o
        LEFT JOIN main.brain_embeddings e ON o.id = e.id
        WHERE e.id IS NULL AND o.narrative IS NOT NULL
      `),
    );
    return row?.n ?? 0;
  } catch (err) {
    // Warn once per process so a permanently broken vector table is visible,
    // then stay at debug (the backfill runs every tick and session end).
    const log = getLogger('embedding-backfill');
    const record = { err, projectRoot };
    const msg = 'Unembedded observation count unavailable; skipping the backfill';
    if (countFailureWarned) log.debug(record, msg);
    else {
      countFailureWarned = true;
      log.warn(record, msg);
    }
    return 0;
  }
}

/**
 * Embed a bounded batch of unembedded observations, when any exist and the
 * governor admits background work.
 *
 * Never throws: the backfill is best-effort enrichment of rows that are already
 * stored and findable by BM25.
 *
 * @param projectRoot - Project root directory.
 * @param options - Batch bound.
 * @returns What ran and how many rows were embedded.
 *
 * @example
 * ```ts
 * const r = await runBoundedEmbeddingBackfill('/my/project', { limit: 50 });
 * if (r.ran) console.log(`embedded ${r.processed} of ${r.pending}`);
 * ```
 */
export async function runBoundedEmbeddingBackfill(
  projectRoot: string,
  options: BoundedEmbeddingBackfillOptions = {},
): Promise<BoundedEmbeddingBackfillResult> {
  const log = getLogger('embedding-backfill');
  const pending = await countUnembeddedObservations(projectRoot);
  if (pending === 0)
    return { ran: false, skipped: 'none-pending', pending, processed: 0, errors: 0 };

  const { admitFailOpen, governor } = await import('../resources/governor.js');
  const { admission } = await admitFailOpen('background-autonomous', () =>
    governor.tryAcquire('background-autonomous'),
  );
  if (admission.deferred) {
    log.debug(
      { projectRoot, pending, retryAfterMs: admission.retryAfterMs },
      'Embedding backfill deferred by the governor',
    );
    return { ran: false, skipped: 'deferred', pending, processed: 0, errors: 0 };
  }
  try {
    const { populateEmbeddings } = await import('./retrieval/observe.js');
    const result = await populateEmbeddings(projectRoot, {
      limit: options.limit ?? DEFAULT_EMBEDDING_BACKFILL_LIMIT,
    });
    if (result.inactiveReason !== undefined) {
      return { ran: false, skipped: 'unavailable', pending, processed: 0, errors: 0 };
    }
    return { ran: true, pending, processed: result.processed, errors: result.errors };
  } catch (err) {
    log.warn({ err, projectRoot }, 'Embedding backfill failed; rows stay BM25-only');
    return { ran: true, pending, processed: 0, errors: 1 };
  } finally {
    await admission.release();
  }
}
