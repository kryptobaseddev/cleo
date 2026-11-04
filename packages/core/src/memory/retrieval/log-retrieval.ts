/**
 * How long a retrieval-log write waits for the write lock (T14202). Past it
 * the row is dropped, never queued or retried: a search (and the CLI's exit,
 * which settles this background write) never waits on another writer.
 */
export const RETRIEVAL_LOG_BUSY_TIMEOUT_MS = 250;

/**
 * Log a retrieval event to brain_retrieval_log for co-retrieval analysis.
 *
 * Creates the table on first use if it doesn't exist (self-healing).
 * Best-effort: errors are swallowed. When another writer holds the store past
 * {@link RETRIEVAL_LOG_BUSY_TIMEOUT_MS}, the row is dropped with a debug log
 * line (T14202).
 *
 * @param projectRoot - Project root directory
 * @param query - The search query or fetch IDs
 * @param entryIds - Array of entry IDs returned in this retrieval
 * @param source - Retrieval source ('find', 'fetch', 'hybrid', 'timeline', 'budget')
 * @param tokensUsed - Estimated tokens consumed (optional)
 * @param sessionId - Session ID for grouping retrievals by session (optional, soft FK to tasks.db)
 */
export async function logRetrieval(
  projectRoot: string,
  query: string,
  entryIds: string[],
  source: string,
  tokensUsed?: number,
  sessionId?: string,
): Promise<void> {
  if (entryIds.length === 0) return;

  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb(projectRoot);
  if (!nativeDb) return;

  // Self-healing: create table if not exists (includes session_id column)
  const createSql =
    'CREATE TABLE IF NOT EXISTS brain_retrieval_log (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'query TEXT NOT NULL,' +
    'entry_ids TEXT NOT NULL,' +
    'entry_count INTEGER NOT NULL,' +
    'source TEXT NOT NULL,' +
    'tokens_used INTEGER,' +
    'session_id TEXT,' +
    "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')';
  // Synchronous between the two PRAGMAs: no other work on this connection
  // runs under the short timeout.
  let dropped: Error | null = null;
  let prior: number | undefined;
  try {
    prior = (nativeDb.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)
      ?.timeout;
    nativeDb.exec(`PRAGMA busy_timeout = ${RETRIEVAL_LOG_BUSY_TIMEOUT_MS}`);
    nativeDb.prepare(createSql).run();
    nativeDb
      .prepare(
        'INSERT INTO brain_retrieval_log (query, entry_ids, entry_count, source, tokens_used, session_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        query,
        JSON.stringify(entryIds),
        entryIds.length,
        source,
        tokensUsed ?? null,
        sessionId ?? null,
      );
  } catch (err) {
    dropped = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (typeof prior === 'number') nativeDb.exec(`PRAGMA busy_timeout = ${prior}`);
  }
  if (dropped !== null) {
    const { getLogger } = await import('../../logger.js');
    getLogger('retrieval-log').debug(
      { err: dropped, source, entryCount: entryIds.length },
      'retrieval log row dropped (store busy or unwritable)',
    );
  }
}
