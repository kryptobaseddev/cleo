/**
 * Brain Consolidator — contradiction detection for the CLEO BRAIN memory system.
 *
 * Implements heuristic contradiction detection based on keyword polarity flip.
 * No LLM required — uses negation markers to identify entries that assert
 * opposing claims about the same subject.
 *
 * When a contradiction is detected:
 *   1. A 'contradicts' edge is created in brain_page_edges (both directions).
 *   2. The lower-quality entry's qualityScore is reduced by 0.15.
 *
 * All operations are BEST-EFFORT — failures never crash the consolidator.
 *
 * @task T549 Wave 3-C
 * @epic T549
 */

import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { typedAll } from '../store/typed-query.js';

// ============================================================================
// Types
// ============================================================================

/** A detected contradiction between two memory entries. */
export interface ContradictionResult {
  /** ID of the first entry in the contradiction pair. */
  entryAId: string;
  /** ID of the second entry in the contradiction pair. */
  entryBId: string;
  /** Which entry was considered the "contradicted" one (lower quality). */
  contradictedId: string;
  /** Table name where the entries live. */
  table: string;
  /** Shared keywords that connected the two entries. */
  sharedKeywords: string[];
  /** Negation markers found in one of the entries. */
  negationMarkers: string[];
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum number of shared keywords to consider two entries related. */
const MIN_SHARED_KEYWORDS = 3;

/**
 * Negation markers that, when present in one entry but not the other,
 * indicate a potential contradiction.
 */
const NEGATION_MARKERS = [
  'not',
  'never',
  'deprecated',
  'removed',
  'replaced',
  'avoid',
  'no longer',
  'do not',
  "don't",
  'disabled',
  'deleted',
  'dropped',
  'broken',
  'invalid',
  'obsolete',
  'reverted',
  'undone',
  'superseded',
] as const;

/** Stop words excluded from keyword extraction (matches brain-lifecycle stop words). */
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
 * Find negation markers present in the text.
 */
function findNegationMarkers(text: string): string[] {
  const lower = text.toLowerCase();
  return NEGATION_MARKERS.filter((marker) => lower.includes(marker));
}

/**
 * Return the intersection of two keyword sets.
 */
function keywordIntersection(a: Set<string>, b: Set<string>): string[] {
  const result: string[] = [];
  for (const w of a) {
    if (b.has(w)) result.push(w);
  }
  return result;
}

// ============================================================================
// Row types for raw SQL queries
// ============================================================================

interface EntryRow {
  id: string;
  text: string;
  quality_score: number | null;
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Detect contradiction pairs across all verified memory entries.
 *
 * For each verified entry:
 *   1. Find entries with >= MIN_SHARED_KEYWORDS shared keywords.
 *   2. Check for negation markers in one but not the other.
 *   3. If contradiction detected: create 'contradicts' graph edges.
 *   4. Lower quality score of the contradicted (lower quality) entry by 0.15.
 *
 * Only considers entries where invalid_at IS NULL (currently valid).
 * Short-circuits after 50 contradiction pairs to limit consolidation cost.
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @returns List of contradiction pairs found
 */
export async function detectContradictions(projectRoot: string): Promise<ContradictionResult[]> {
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return [];

  const results: ContradictionResult[] = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Process each table that holds verified entries
  const tables: Array<{ table: string; textCol: string }> = [
    { table: 'brain_observations', textCol: 'narrative' },
    { table: 'brain_learnings', textCol: 'insight' },
    { table: 'brain_patterns', textCol: 'pattern' },
    { table: 'brain_decisions', textCol: 'decision' },
  ];

  for (const { table, textCol } of tables) {
    if (results.length >= 50) break;

    let entries: EntryRow[] = [];
    try {
      // Only examine verified, valid entries for contradiction scanning
      entries = typedAll<EntryRow>(
        nativeDb.prepare(`
          SELECT id, COALESCE(${textCol}, '') AS text, quality_score
          FROM ${table}
          WHERE invalid_at IS NULL
            AND verified = 1
          LIMIT 200
        `),
      );
    } catch {
      // Table or column may not exist — best-effort
      continue;
    }

    if (entries.length < 2) continue;

    // Extract keywords for all entries up front
    const keywordMap = new Map<string, Set<string>>();
    const negationMap = new Map<string, string[]>();
    for (const entry of entries) {
      keywordMap.set(entry.id, extractKeywords(entry.text));
      negationMap.set(entry.id, findNegationMarkers(entry.text));
    }

    // Compare all pairs — O(n²) but capped at 200 entries (40k ops max)
    for (let i = 0; i < entries.length; i++) {
      if (results.length >= 50) break;
      const entryA = entries[i]!;
      const keywordsA = keywordMap.get(entryA.id)!;
      const negationsA = negationMap.get(entryA.id)!;

      for (let j = i + 1; j < entries.length; j++) {
        if (results.length >= 50) break;
        const entryB = entries[j]!;
        const keywordsB = keywordMap.get(entryB.id)!;
        const negationsB = negationMap.get(entryB.id)!;

        // Step 1: Need sufficient shared keywords to be "about the same thing"
        const shared = keywordIntersection(keywordsA, keywordsB);
        if (shared.length < MIN_SHARED_KEYWORDS) continue;

        // Step 2: Check for negation polarity flip — one entry negates the other
        // A contradiction occurs when one entry has negation markers that the other lacks
        const negationsOnlyInA = negationsA.filter((m) => !negationsB.includes(m));
        const negationsOnlyInB = negationsB.filter((m) => !negationsA.includes(m));
        const negationFlip = negationsOnlyInA.length > 0 || negationsOnlyInB.length > 0;

        if (!negationFlip) continue;

        // Found a contradiction pair
        const negMarkers = [...negationsOnlyInA, ...negationsOnlyInB];

        // The contradicted entry is the lower-quality one
        const qualA = entryA.quality_score ?? 0.5;
        const qualB = entryB.quality_score ?? 0.5;
        const contradictedId = qualA <= qualB ? entryA.id : entryB.id;
        const winningId = contradictedId === entryA.id ? entryB.id : entryA.id;

        results.push({
          entryAId: entryA.id,
          entryBId: entryB.id,
          contradictedId,
          table,
          sharedKeywords: shared.slice(0, 10),
          negationMarkers: negMarkers.slice(0, 5),
        });

        // Step 3: Create 'contradicts' graph edges (best-effort)
        const nodeA = buildNodeId(table, entryA.id);
        const nodeB = buildNodeId(table, entryB.id);

        try {
          nativeDb
            .prepare(`
              INSERT OR IGNORE INTO brain_page_edges
                (from_id, to_id, edge_type, weight, provenance, created_at)
              VALUES (?, ?, 'contradicts', 0.8, 'consolidation:contradiction', ?)
            `)
            .run(nodeA, nodeB, now);
          nativeDb
            .prepare(`
              INSERT OR IGNORE INTO brain_page_edges
                (from_id, to_id, edge_type, weight, provenance, created_at)
              VALUES (?, ?, 'contradicts', 0.8, 'consolidation:contradiction', ?)
            `)
            .run(nodeB, nodeA, now);
        } catch {
          /* graph population is best-effort */
        }

        // Step 4: Lower quality of the contradicted entry by 0.15
        try {
          nativeDb
            .prepare(`
              UPDATE ${table}
              SET quality_score = MAX(0.0, COALESCE(quality_score, 0.5) - 0.15),
                  updated_at = ?
              WHERE id = ?
            `)
            .run(now, contradictedId);
          // Also ensure the winning entry's quality is noted
          void winningId; // used above for clarity
        } catch {
          /* best-effort */
        }
      }
    }
  }

  return results;
}

/**
 * Build the graph node ID for a given table + entry ID combination.
 * Mirrors the convention used in graph-auto-populate.ts.
 */
function buildNodeId(table: string, entryId: string): string {
  const typeMap: Record<string, string> = {
    brain_observations: 'observation',
    brain_learnings: 'learning',
    brain_patterns: 'pattern',
    brain_decisions: 'decision',
  };
  const type = typeMap[table] ?? 'entry';
  return `${type}:${entryId}`;
}
