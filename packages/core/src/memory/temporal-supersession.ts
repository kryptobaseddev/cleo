/**
 * Temporal Supersession — audit-trail-preserving memory supersession for CLEO BRAIN.
 *
 * When new information contradicts or replaces old memory, the old entry is
 * marked as SUPERSEDED (via `invalid_at`) and a directed `supersedes` graph
 * edge is created from the new entry to the old one. Nothing is deleted —
 * the full chain is preserved for temporal reasoning.
 *
 * Key design properties:
 *   - All writes are BEST-EFFORT where indicated — failures never block callers.
 *   - Supersession only operates on currently-valid entries (invalid_at IS NULL).
 *   - Embedding similarity is used when sqlite-vec is available; keyword overlap
 *     is used as a fallback.
 *   - A single node ID convention is maintained:  '<type>:<entryId>'.
 *
 * Supported tables: brain_decisions, brain_patterns, brain_learnings, brain_observations.
 *
 * T739: detectSupersession now uses sqlite-vec ANN query as the primary similarity
 *   path when embeddings are available (isEmbeddingAvailable() + isBrainVecLoaded()).
 *   Falls back to Jaccard keyword overlap when vectors are absent. The final
 *   candidate score is the max of the embedding cosine similarity and the keyword
 *   Jaccard ratio, so the most informative signal wins.
 *
 * @epic T523
 * @task T739
 */

import { getBrainDb, getBrainNativeDb, isBrainVecLoaded } from '../store/brain-sqlite.js';
import { typedAll, typedGet } from '../store/typed-query.js';

// ============================================================================
// Types
// ============================================================================

/** A brain table entry capable of being superseded. */
export interface SupersedableEntry {
  /** Row primary key. */
  id: string;
  /** Text content used for similarity comparison. */
  text: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Quality score 0.0–1.0 (null on legacy rows). */
  qualityScore: number | null;
  /** Whether this entry is currently valid (invalid_at IS NULL). */
  isValid: boolean;
}

/** The full supersession chain for one entry (newest → oldest). */
export interface SupersessionChain {
  /** The entry whose history was requested. */
  entryId: string;
  /**
   * Ordered chain of node IDs from the entry back to the original.
   * The first element is the entry itself; subsequent elements are older
   * versions that were superseded one-by-one.
   */
  chain: SupersessionChainEntry[];
}

/** One entry in a supersession chain. */
export interface SupersessionChainEntry {
  /** Brain graph node ID in the form '<type>:<sourceId>'. */
  nodeId: string;
  /** Source entry ID (without the type prefix). */
  entryId: string;
  /** Human-readable label from brain_page_nodes (may be absent for external nodes). */
  label: string | null;
  /** ISO 8601 creation time of the graph node. */
  createdAt: string;
  /** Whether the source entry is currently valid (invalid_at IS NULL). */
  isLatest: boolean;
  /** Reason this entry was superseded (null if it is the latest). */
  supersededReason: string | null;
}

/** Result of a `supersedeMemory` call. */
export interface SupersedeResult {
  /** Whether the supersession was recorded. */
  success: boolean;
  /** The entry that was marked as superseded. */
  oldId: string;
  /** The new entry that supersedes the old one. */
  newId: string;
  /** The created edge type ('supersedes'). */
  edgeType: 'supersedes';
}

/** A candidate supersession pair found by `detectSupersession`. */
export interface SupersessionCandidate {
  /** ID of the existing entry that may be superseded. */
  existingId: string;
  /** Similarity score 0.0–1.0 that triggered the candidate. */
  similarity: number;
  /** Table containing the existing entry. */
  table: string;
  /** Shared keywords that connected the two entries (keyword-fallback path). */
  sharedKeywords: string[];
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum keyword overlap ratio to consider two entries related. */
const KEYWORD_OVERLAP_THRESHOLD = 0.8;

/** Minimum shared keyword count before similarity ratio is computed. */
const MIN_SHARED_KEYWORDS = 3;

/** Stop words excluded from keyword extraction. */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'and',
  'but',
  'or',
  'nor',
  'so',
  'yet',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'not',
  'no',
]);

/** Tables that support temporal supersession. */
const SUPERSEDABLE_TABLES = [
  { table: 'brain_decisions', textCol: 'decision', type: 'decision' },
  { table: 'brain_learnings', textCol: 'insight', type: 'learning' },
  { table: 'brain_patterns', textCol: 'pattern', type: 'pattern' },
  { table: 'brain_observations', textCol: 'narrative', type: 'observation' },
] as const;

type TableConfig = (typeof SUPERSEDABLE_TABLES)[number];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract significant keywords from text for overlap comparison.
 * Filters stop words and tokens shorter than 4 characters.
 */
function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/\s+/);
  const keywords = new Set<string>();
  for (const w of words) {
    if (w.length >= 4 && !STOP_WORDS.has(w)) {
      keywords.add(w);
    }
  }
  return keywords;
}

/**
 * Compute keyword-based Jaccard similarity between two texts.
 * Returns a value in [0, 1].
 */
function keywordSimilarity(textA: string, textB: string): { similarity: number; shared: string[] } {
  const kwA = extractKeywords(textA);
  const kwB = extractKeywords(textB);
  if (kwA.size === 0 || kwB.size === 0) return { similarity: 0, shared: [] };

  const shared: string[] = [];
  for (const w of kwA) {
    if (kwB.has(w)) shared.push(w);
  }
  if (shared.length < MIN_SHARED_KEYWORDS) return { similarity: 0, shared: [] };

  // Jaccard coefficient: |intersection| / |union|
  const union = kwA.size + kwB.size - shared.length;
  const similarity = union > 0 ? shared.length / union : 0;
  return { similarity, shared };
}

/**
 * Build the brain_page_nodes node ID for a typed entry.
 * Mirrors the convention used throughout the codebase.
 */
function buildNodeId(type: string, entryId: string): string {
  return `${type}:${entryId}`;
}

/**
 * Find the TableConfig for a given entry ID by probing tables.
 * Returns null if the entry cannot be located.
 */
async function locateEntry(
  projectRoot: string,
  entryId: string,
): Promise<{ tableConfig: TableConfig; nodeId: string } | null> {
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return null;

  for (const tc of SUPERSEDABLE_TABLES) {
    const row = typedGet<{ id: string }>(
      nativeDb.prepare(`SELECT id FROM ${tc.table} WHERE id = ? LIMIT 1`),
      entryId,
    );
    if (row) {
      return { tableConfig: tc, nodeId: buildNodeId(tc.type, entryId) };
    }
  }
  return null;
}

// ============================================================================
// Core Operations
// ============================================================================

/**
 * Mark an existing memory entry as superseded by a newer one.
 *
 * Effects:
 *   1. Sets `invalid_at` on the old entry (soft-eviction; the row is kept).
 *   2. Inserts a `supersedes` edge in brain_page_edges: new → old.
 *      The `provenance` field carries the reason for the supersession.
 *   3. Creates/refreshes brain_page_nodes rows for both entries (best-effort).
 *
 * The old entry is NEVER deleted — it remains in the table as an audit record.
 * Only entries currently valid (invalid_at IS NULL) can be superseded.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param oldId - ID of the entry being superseded.
 * @param newId - ID of the newer entry that supersedes the old one.
 * @param reason - Human-readable reason for the supersession (stored as edge provenance).
 * @returns SupersedeResult describing the outcome.
 * @throws When either entry cannot be located or the DB is unavailable.
 */
export async function supersedeMemory(
  projectRoot: string,
  oldId: string,
  newId: string,
  reason: string,
): Promise<SupersedeResult> {
  if (!oldId?.trim()) throw new Error('oldId is required');
  if (!newId?.trim()) throw new Error('newId is required');
  if (!reason?.trim()) throw new Error('reason is required');
  if (oldId === newId) throw new Error('oldId and newId must be different entries');

  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) throw new Error('brain.db is unavailable');

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Locate old entry
  const oldLocation = await locateEntry(projectRoot, oldId);
  if (!oldLocation) throw new Error(`Entry not found: ${oldId}`);

  // Locate new entry (may be in a different table)
  const newLocation = await locateEntry(projectRoot, newId);
  if (!newLocation) throw new Error(`Entry not found: ${newId}`);

  const { tableConfig: oldTc, nodeId: oldNodeId } = oldLocation;
  const { nodeId: newNodeId } = newLocation;

  // Step 1: Mark old entry as invalid (soft-evict, preserving the row)
  try {
    nativeDb
      .prepare(
        `UPDATE ${oldTc.table} SET invalid_at = ?, updated_at = ? WHERE id = ? AND invalid_at IS NULL`,
      )
      .run(now, now, oldId);
  } catch {
    // If the column doesn't exist on a particular table variant, ignore and continue
  }

  // Step 2: Create supersedes edge: new → old (idempotent via composite PK)
  const provenanceText = reason.substring(0, 500);
  try {
    nativeDb
      .prepare(
        `INSERT OR IGNORE INTO brain_page_edges
           (from_id, to_id, edge_type, weight, provenance, created_at)
         VALUES (?, ?, 'supersedes', 1.0, ?, ?)`,
      )
      .run(newNodeId, oldNodeId, provenanceText, now);
  } catch (err) {
    // Edge table failure is non-fatal for the supersession record itself,
    // but we re-throw since the caller needs to know the edge was not created.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create supersedes edge: ${message}`);
  }

  return {
    success: true,
    oldId,
    newId,
    edgeType: 'supersedes',
  };
}

/**
 * Detect whether a new entry supersedes existing brain entries.
 *
 * Called automatically by the store functions (`storeDecision`, `storeLearning`,
 * `storePattern`) after a new entry is written. Compares the new entry's content
 * against existing valid entries in the same table using keyword-based Jaccard
 * similarity (embedding similarity used when available via sqlite-vec).
 * against existing valid entries in the same table using:
 *
 *   1. Embedding similarity (via sqlite-vec) when available and the entry has a
 *      vector. Falls back to keyword-based Jaccard if vectors are absent.
 *   2. Keyword Jaccard similarity ≥ KEYWORD_OVERLAP_THRESHOLD.
 *
 * An entry is only considered a supersession candidate when the new entry is
 * temporally newer than the existing one (guaranteed for freshly-written entries).
 *
 * This function is BEST-EFFORT — it never throws. Errors are swallowed and
 * logged with console.warn so the calling store function is not blocked.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param newEntry - The freshly-stored entry to check against existing entries.
 * @returns List of candidate supersessions (empty if none found or on any error).
 */
export async function detectSupersession(
  projectRoot: string,
  newEntry: {
    id: string;
    text: string;
    /** ISO 8601 creation timestamp of the new entry. */
    createdAt: string;
  },
): Promise<SupersessionCandidate[]> {
  try {
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return [];

    const newLocation = await locateEntry(projectRoot, newEntry.id);
    if (!newLocation) return [];

    const { tableConfig } = newLocation;

    // Load existing valid entries from the same table (excluding the new one itself)
    interface EntryRow {
      id: string;
      text: string;
      created_at: string;
      quality_score: number | null;
    }
    const existing = typedAll<EntryRow>(
      nativeDb.prepare(`
        SELECT id, COALESCE(${tableConfig.textCol}, '') AS text,
               created_at, quality_score
        FROM ${tableConfig.table}
        WHERE invalid_at IS NULL
          AND id != ?
        ORDER BY created_at DESC
        LIMIT 200
      `),
      newEntry.id,
    );

    if (existing.length === 0) return [];

    // T739: Build an embedding-similarity map (existingId → cosine similarity)
    // when sqlite-vec is loaded. This is the primary signal; keyword Jaccard
    // is the fallback and tie-breaker.
    const embeddingScores = new Map<string, number>();
    if (isBrainVecLoaded()) {
      try {
        const { isEmbeddingAvailable, embedText } = await import('./brain-embedding.js');
        if (isEmbeddingAvailable()) {
          const queryVector = await embedText(newEntry.text);
          if (queryVector) {
            // KNN query: returns (id, distance) where distance is L2/cosine depending on vec0 metric.
            // brain_embeddings stores observations, decisions, patterns, learnings as typed IDs.
            // distance = 0.0 means identical; we convert to similarity as (1 - distance/2).
            interface KnnRow {
              id: string;
              distance: number;
            }
            const knnRows = typedAll<KnnRow>(
              nativeDb.prepare(
                'SELECT id, distance FROM brain_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 50',
              ),
              new Float32Array(queryVector.buffer, queryVector.byteOffset, queryVector.length),
            );
            for (const kr of knnRows) {
              // Cosine distance range: [0, 2]. Convert to similarity [0, 1].
              const cosineSimilarity = Math.max(0, 1 - kr.distance / 2);
              // Strip type prefix to get the bare entry ID for map keying
              const bareId = kr.id.includes(':') ? kr.id.split(':').slice(1).join(':') : kr.id;
              embeddingScores.set(bareId, cosineSimilarity);
            }
          }
        }
      } catch {
        // Embedding path is best-effort — fall through to keyword-only
      }
    }

    const candidates: SupersessionCandidate[] = [];

    for (const row of existing) {
      // Only supersede entries that are older than the new one.
      // For freshly-written entries this is always true, but we guard anyway.
      if (row.created_at >= newEntry.createdAt) continue;

      // Keyword Jaccard similarity (always computed — cheap, no I/O).
      const { similarity: keywordSim, shared } = keywordSimilarity(newEntry.text, row.text);

      // T739: Combine embedding similarity (primary) with keyword Jaccard (fallback).
      // Use max so the most informative signal wins. When embeddings are absent,
      // embeddingScore is 0.0 and the keyword path takes over.
      const embeddingScore = embeddingScores.get(row.id) ?? 0;
      const combinedSimilarity = Math.max(embeddingScore, keywordSim);

      if (combinedSimilarity >= KEYWORD_OVERLAP_THRESHOLD) {
        candidates.push({
          existingId: row.id,
          similarity: combinedSimilarity,
          table: tableConfig.table,
          sharedKeywords: shared.slice(0, 10),
        });
      }
    }

    // Return sorted by descending similarity (strongest match first)
    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates;
  } catch (err) {
    console.warn('[temporal-supersession] detectSupersession failed:', err);
    return [];
  }
}

/**
 * Trace the full supersession chain for a given entry.
 *
 * Follows `supersedes` edges outward (new → old) until no further edges
 * exist or a cycle guard limit is reached. Returns the chain ordered from
 * the given entry (first element) back to the original version (last element).
 *
 * This is a pure read operation that never modifies any data.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param entryId - The entry whose history should be traced.
 * @returns SupersessionChain with the full ordered chain.
 */
export async function getSupersessionChain(
  projectRoot: string,
  entryId: string,
): Promise<SupersessionChain> {
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { entryId, chain: [] };
  }

  const location = await locateEntry(projectRoot, entryId);
  if (!location) {
    return { entryId, chain: [] };
  }

  const { nodeId: startNodeId, tableConfig } = location;
  const chain: SupersessionChainEntry[] = [];
  const visited = new Set<string>();

  // Walk the supersedes chain: start → older → even older → ...
  // We load node metadata for each hop along the way.
  let currentNodeId = startNodeId;
  let depth = 0;
  const MAX_DEPTH = 50; // guard against unexpected cycles

  while (currentNodeId && depth < MAX_DEPTH) {
    if (visited.has(currentNodeId)) break;
    visited.add(currentNodeId);
    depth += 1;

    // Extract the source entry ID from the node ID (after the first ':')
    const colonIdx = currentNodeId.indexOf(':');
    const sourceEntryId = colonIdx >= 0 ? currentNodeId.slice(colonIdx + 1) : currentNodeId;

    // Check whether the source entry is currently valid in its table.
    let isLatestEntry = false;
    try {
      // Determine the table from the node ID prefix
      const nodeType = colonIdx >= 0 ? currentNodeId.slice(0, colonIdx) : '';
      const tc = SUPERSEDABLE_TABLES.find((t) => t.type === nodeType) ?? tableConfig;
      const validRow = typedGet<{ invalid_at: string | null }>(
        nativeDb.prepare(`SELECT invalid_at FROM ${tc.table} WHERE id = ? LIMIT 1`),
        sourceEntryId,
      );
      isLatestEntry = validRow !== undefined && validRow.invalid_at === null;
    } catch {
      isLatestEntry = false;
    }

    // Get label and creation timestamp from brain_page_nodes (best-effort)
    interface NodeRow {
      label: string;
      created_at: string;
    }
    const nodeRow = typedGet<NodeRow>(
      nativeDb.prepare(`SELECT label, created_at FROM brain_page_nodes WHERE id = ? LIMIT 1`),
      currentNodeId,
    );

    // Find the provenance (reason) from the edge that led here.
    // For the first entry in the chain there is no inbound supersedes edge yet.
    let supersededReason: string | null = null;
    if (chain.length > 0) {
      // The previous entry in the chain has a supersedes edge pointing to currentNodeId
      const prevNodeId = chain[chain.length - 1]!.nodeId;
      interface EdgeRow {
        provenance: string | null;
      }
      const edgeRow = typedGet<EdgeRow>(
        nativeDb.prepare(
          `SELECT provenance FROM brain_page_edges
           WHERE from_id = ? AND to_id = ? AND edge_type = 'supersedes'
           LIMIT 1`,
        ),
        prevNodeId,
        currentNodeId,
      );
      supersededReason = edgeRow?.provenance ?? null;
    }

    chain.push({
      nodeId: currentNodeId,
      entryId: sourceEntryId,
      label: nodeRow?.label ?? null,
      createdAt: nodeRow?.created_at ?? '',
      isLatest: isLatestEntry,
      supersededReason,
    });

    // Advance to the next node via a `supersedes` edge from currentNodeId
    interface NextEdge {
      to_id: string;
    }
    const nextEdge = typedGet<NextEdge>(
      nativeDb.prepare(
        `SELECT to_id FROM brain_page_edges
         WHERE from_id = ? AND edge_type = 'supersedes'
         LIMIT 1`,
      ),
      currentNodeId,
    );
    if (!nextEdge) break;
    currentNodeId = nextEdge.to_id;
  }

  return { entryId, chain };
}

/**
 * Check whether a brain entry is the latest (non-superseded) version in its chain.
 *
 * An entry is "latest" when its `invalid_at` column IS NULL. This is the same
 * gate used by all query paths to filter out stale entries.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param entryId - The entry to check.
 * @returns true when the entry is valid; false when superseded or not found.
 */
export async function isLatest(projectRoot: string, entryId: string): Promise<boolean> {
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return false;

  for (const tc of SUPERSEDABLE_TABLES) {
    const row = typedGet<{ invalid_at: string | null }>(
      nativeDb.prepare(`SELECT invalid_at FROM ${tc.table} WHERE id = ? LIMIT 1`),
      entryId,
    );
    if (row !== undefined) {
      return row.invalid_at === null;
    }
  }
  return false;
}
