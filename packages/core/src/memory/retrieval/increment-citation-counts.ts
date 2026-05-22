/**
 * Increment citationCount for a list of entry IDs.
 *
 * Routes each ID to the correct table based on its ID prefix. All updates
 * are best-effort — errors are silently swallowed.
 *
 * @param projectRoot - Project root for brain.db resolution
 * @param ids - Entry IDs whose citation counts should be incremented
 */
export async function incrementCitationCounts(projectRoot: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const id of ids) {
    let table: string;
    if (id.startsWith('D-') || /^D\d/.test(id)) {
      table = 'brain_decisions';
    } else if (id.startsWith('P-') || /^P\d/.test(id)) {
      table = 'brain_patterns';
    } else if (id.startsWith('L-') || /^L\d/.test(id)) {
      table = 'brain_learnings';
    } else {
      table = 'brain_observations';
    }

    try {
      nativeDb
        .prepare(
          `UPDATE ${table} SET citation_count = citation_count + 1, updated_at = ? WHERE id = ?`,
        )
        .run(now, id);
    } catch {
      /* best-effort — column may not exist in older schemas */
    }
  }
}
