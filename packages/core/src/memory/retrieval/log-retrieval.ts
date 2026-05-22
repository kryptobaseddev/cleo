/**
 * Log a retrieval event to brain_retrieval_log for co-retrieval analysis.
 *
 * Creates the table on first use if it doesn't exist (self-healing).
 * Best-effort: errors are silently swallowed.
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
  const nativeDb = getBrainNativeDb();
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
  try {
    nativeDb.prepare(createSql).run();
  } catch {
    return;
  }

  try {
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
  } catch {
    /* best-effort */
  }
}
