/**
 * BRAIN Vector Similarity Search
 *
 * Provides vector-based KNN search against brain_embeddings vec0 table.
 * Falls back gracefully when no embedding provider is registered or
 * sqlite-vec is unavailable.
 *
 * @task T5388
 * @epic T5149
 */

import { getBrainAccessor } from '../../store/brain-accessor.js';
import { getBrainDb, getBrainNativeDb, isBrainVecLoaded } from '../../store/brain-sqlite.js';
import { embedText, isEmbeddingAvailable } from './brain-embedding.js';

// ============================================================================
// Types
// ============================================================================

export interface SimilarityResult {
  id: string;
  distance: number;
  type: string; // 'observation' | 'decision' | 'pattern' | 'learning'
  title: string;
  text: string;
}

// ============================================================================
// ID prefix -> table type
// ============================================================================

function parseIdPrefix(id: string): 'decision' | 'pattern' | 'learning' | 'observation' | null {
  if (id.startsWith('D-') || /^D\d/.test(id)) return 'decision';
  if (id.startsWith('P-') || /^P\d/.test(id)) return 'pattern';
  if (id.startsWith('L-') || /^L\d/.test(id)) return 'learning';
  if (id.startsWith('O-') || id.startsWith('O') || id.startsWith('CM-')) return 'observation';
  return null;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Search for entries similar to a query string using vector similarity.
 *
 * 1. Embeds the query text via the registered embedding provider.
 * 2. Runs KNN query against brain_embeddings vec0 table.
 * 3. Joins with observation/decision/pattern/learning tables for full entries.
 *
 * Returns empty array when embedding is unavailable (graceful fallback).
 *
 * @param query - Text to find similar entries for
 * @param projectRoot - Project root directory
 * @param limit - Maximum results to return (default 10)
 * @returns Array of similar entries ranked by distance (ascending)
 */
export async function searchSimilar(
  query: string,
  projectRoot: string,
  limit?: number,
): Promise<SimilarityResult[]> {
  if (!query || !query.trim()) return [];
  if (!isEmbeddingAvailable()) return [];

  const maxResults = limit ?? 10;

  // Embed the query text
  const queryVector = await embedText(query);
  if (!queryVector) return [];

  // Ensure brain.db is initialized
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return [];

  // Require sqlite-vec for KNN queries
  if (!isBrainVecLoaded()) return [];

  // Run KNN query against vec0 table
  let knnRows: Array<{ id: string; distance: number }>;
  try {
    knnRows = nativeDb
      .prepare(
        'SELECT id, distance FROM brain_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
      )
      .all(
        new Float32Array(queryVector.buffer, queryVector.byteOffset, queryVector.length),
        maxResults,
      ) as Array<{ id: string; distance: number }>;
  } catch {
    // vec0 query failed — table may not exist or extension not loaded
    return [];
  }

  if (knnRows.length === 0) return [];

  // Resolve each ID to its full entry
  const accessor = await getBrainAccessor(projectRoot);
  const results: SimilarityResult[] = [];

  for (const row of knnRows) {
    const entryType = parseIdPrefix(row.id);
    if (!entryType) continue;

    try {
      switch (entryType) {
        case 'observation': {
          const entry = await accessor.getObservation(row.id);
          if (entry) {
            results.push({
              id: row.id,
              distance: row.distance,
              type: 'observation',
              title: entry.title,
              text: entry.narrative ?? entry.title,
            });
          }
          break;
        }
        case 'decision': {
          const entry = await accessor.getDecision(row.id);
          if (entry) {
            results.push({
              id: row.id,
              distance: row.distance,
              type: 'decision',
              title: entry.decision,
              text: `${entry.decision} — ${entry.rationale}`,
            });
          }
          break;
        }
        case 'pattern': {
          const entry = await accessor.getPattern(row.id);
          if (entry) {
            results.push({
              id: row.id,
              distance: row.distance,
              type: 'pattern',
              title: entry.pattern,
              text: `${entry.pattern} — ${entry.context}`,
            });
          }
          break;
        }
        case 'learning': {
          const entry = await accessor.getLearning(row.id);
          if (entry) {
            results.push({
              id: row.id,
              distance: row.distance,
              type: 'learning',
              title: entry.insight,
              text: `${entry.insight} (source: ${entry.source})`,
            });
          }
          break;
        }
      }
    } catch {
      // Skip entries that fail to resolve
    }
  }

  return results;
}
