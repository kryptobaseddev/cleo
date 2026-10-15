/**
 * Background embedding: the write-time embed of a new memory row (T5387) and
 * the bounded backfill of rows without a current vector (T13126).
 *
 * A one-shot process stores memory rows unembedded (see `brain-host.ts`).
 * This helper embeds a bounded batch of them, loading the model once for the
 * batch instead of once per observe. It runs from:
 * - the detached `cleo session end` worker, once per session;
 * - the sentient tick, in an opted-in long-lived host.
 *
 * It does nothing when no row is pending: the pending count is a plain
 * SQL read, so the model is never loaded for an empty backlog. It runs under
 * the governor's `background-autonomous` class, which grants a slot only when
 * memory pressure is `ok`. A deferral skips the batch, and the next session end
 * or tick retries.
 *
 * @module
 * @task T13126
 */

import { getLogger } from '../logger.js';
import { embedText, ensureEmbeddingProvider, getEmbeddingProvider } from './brain-embedding.js';
import { isBrainWriterIsolate, isLongLivedBrainHost } from './brain-host.js';

/** Set after the first pending-count failure is logged at warn. */
let countFailureWarned = false;

/** Memory rows embedded per bounded batch unless the caller says otherwise. */
export const DEFAULT_EMBEDDING_BACKFILL_LIMIT = 50;

/** Outcome of {@link runBoundedEmbeddingBackfill}. */
export interface BoundedEmbeddingBackfillResult {
  /** Whether a batch ran (the model was asked to embed). */
  readonly ran: boolean;
  /** Why no batch ran, when {@link ran} is `false`. */
  readonly skipped?: 'none-pending' | 'deferred' | 'unavailable';
  /** Memory rows without a current vector found before the batch. */
  readonly pending: number;
  /** Rows embedded by this batch. */
  readonly processed: number;
  /** Rows that failed to embed in this batch. */
  readonly errors: number;
}

/** Options for {@link runBoundedEmbeddingBackfill}. */
export interface BoundedEmbeddingBackfillOptions {
  /**
   * Maximum memory rows to embed, newest first.
   * @defaultValue {@link DEFAULT_EMBEDDING_BACKFILL_LIMIT}
   */
  readonly limit?: number;
}

/**
 * SQL selecting every current memory row that needs a vector: observations,
 * decisions, learnings and patterns with no embedding, or one from a model
 * other than the bound `?` (T13740). Columns: `id`, `text`, `created_at`.
 *
 * The texts match what `searchSimilar` shows for each kind, so a hit is
 * judged on the text it was embedded from.
 *
 * @returns The SELECT, with one `?` parameter: the current model tag.
 * @task T13740
 */
export function pendingEmbeddingsSql(): string {
  const sources: ReadonlyArray<readonly [table: string, text: string, createdAt: string]> = [
    // An observation without a narrative stays FTS-only; an empty one embeds its title.
    [
      'brain_observations',
      "CASE WHEN t.narrative IS NOT NULL THEN coalesce(nullif(t.narrative, ''), t.title) END",
      't.created_at',
    ],
    ['brain_decisions', "t.decision || ' — ' || coalesce(t.rationale, '')", 't.created_at'],
    ['brain_learnings', 't.insight', 't.created_at'],
    ['brain_patterns', "t.pattern || ' — ' || coalesce(t.context, '')", 't.extracted_at'],
  ];
  const parts = sources.map(
    ([table, text, createdAt]) => `
      SELECT t.id AS id, ${text} AS text, ${createdAt} AS created_at
      FROM main.${table} t CROSS JOIN m
      LEFT JOIN main.brain_embeddings e ON e.id = t.id
      WHERE t.invalid_at IS NULL AND ${text} IS NOT NULL AND (e.id IS NULL OR e.model IS NOT m.model)`,
  );
  return `WITH m(model) AS (SELECT ?) ${parts.join(' UNION ALL ')}`;
}

/**
 * Count current memory rows that have no embedding from the current model.
 *
 * A plain SQL read: registering the provider is free, and the model is never
 * loaded here.
 *
 * @param projectRoot - Project root directory.
 * @returns The pending count, or `0` when the brain store or its vector table
 *   is unavailable.
 */
export async function countUnembeddedMemories(projectRoot: string): Promise<number> {
  try {
    const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb(projectRoot);
    if (!nativeDb) return 0;
    await ensureEmbeddingProvider(projectRoot);
    const { typedGet } = await import('../store/typed-query.js');
    const row = typedGet<{ n: number }>(
      nativeDb.prepare(`SELECT COUNT(*) AS n FROM (${pendingEmbeddingsSql()})`),
      getEmbeddingProvider()?.model ?? '',
    );
    return row?.n ?? 0;
  } catch (err) {
    // Warn once per process so a permanently broken vector table is visible,
    // then stay at debug (the backfill runs every tick and session end).
    const log = getLogger('embedding-backfill');
    const record = { err, projectRoot };
    const msg = 'Unembedded memory count unavailable; skipping the backfill';
    if (countFailureWarned) log.debug(record, msg);
    else {
      countFailureWarned = true;
      log.warn(record, msg);
    }
    return 0;
  }
}

/**
 * Embed a bounded batch of memory rows without a current vector, when any exist and the
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
  const pending = await countUnembeddedMemories(projectRoot);
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

/**
 * Embed one freshly written memory row in the background — long-lived hosts only.
 *
 * T13126: loading the local embedding model costs ~280 MB, and a one-shot
 * process paid it on every write for a single vector. A one-shot process
 * leaves the row unembedded; `populateEmbeddings` fills it later (an opted-in
 * host's tick, the `cleo session end` background batch, or `cleo backfill`).
 * Until then the row is found by BM25/FTS5 only.
 *
 * @param projectRoot - Project whose brain holds the row.
 * @param id - Row id (`O-…`, `D…`, `L-…`, `P-…`).
 * @param text - Text to embed.
 * @task T5387
 * @task T13740
 */
export function scheduleEmbedding(projectRoot: string, id: string, text: string): void {
  if (!isLongLivedBrainHost()) return;
  setImmediate(() => {
    void (async () => {
      try {
        // T12314: registration is free; availability is checked by embedText.
        if (!(await ensureEmbeddingProvider(projectRoot))) return;
        const model = getEmbeddingProvider()?.model;
        const vector = await embedText(text);
        if (!vector || !model) return;
        // T13230: inside the writer isolate the open handle IS the chokepoint's,
        // so write directly (enqueueBrainWrite there would start a nested
        // manager). Anywhere else (a main thread whose host ran the write
        // inline, or any other worker thread, T13246) the op has already
        // released the lease and the mutex, so the write goes back through
        // the chokepoint.
        if (isBrainWriterIsolate()) {
          const { getBrainNativeDb } = await import('../store/memory-sqlite.js');
          const { upsertEmbeddingRowsNative } = await import('../store/memory-accessor.js');
          const nativeDb = getBrainNativeDb(projectRoot);
          if (nativeDb) upsertEmbeddingRowsNative(nativeDb, model, [{ id, vector }]);
          return;
        }
        const { enqueueBrainWrite } = await import('./brain-writer-thread.js');
        await enqueueBrainWrite({ kind: 'embed', projectRoot, model, rows: [{ id, vector }] });
      } catch {
        // Embedding is enrichment — the row is already persisted.
      }
    })();
  });
}
