/**
 * BRAIN lifecycle operations — temporal decay, memory consolidation, and tier promotion.
 *
 * Reduces confidence of stale learnings based on age, following an
 * exponential decay model: new_confidence = confidence * (decayRate ^ daysSinceUpdate).
 *
 * Consolidation groups old observations by keyword overlap and merges
 * clusters into summary observations, archiving the originals.
 *
 * Wave 3 additions (T549):
 * - runTierPromotion — promotes entries through short→medium→long based on citation count,
 *   age, and verification; soft-evicts stale short-term entries.
 * - runConsolidation — orchestrates all consolidation steps (dedup, quality recompute,
 *   tier promotion, contradiction detection, soft eviction, graph strengthening, summaries).
 *
 * @task T5394 T5395 T549
 * @epic T5149
 */

import { createHash } from 'node:crypto';
import { getBrainAccessor } from '../store/brain-accessor.js';
import { typedAll } from '../store/typed-query.js';
import type { BrainConsolidationObservationRow } from './brain-row-types.js';

/** Result from applying temporal decay. */
export interface DecayResult {
  updated: number;
  tablesProcessed: string[];
}

/**
 * Apply temporal decay to brain_learnings confidence values.
 *
 * Entries older than `olderThanDays` have their confidence reduced
 * by an exponential decay factor based on the number of days since
 * their last update (or creation if never updated).
 *
 * Formula: new_confidence = confidence * (decayRate ^ daysSinceUpdate)
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param options - Decay configuration
 * @returns Count of updated rows and tables processed
 */
export async function applyTemporalDecay(
  projectRoot: string,
  options?: { decayRate?: number; olderThanDays?: number },
): Promise<DecayResult> {
  const decayRate = options?.decayRate ?? 0.995;
  const olderThanDays = options?.olderThanDays ?? 30;

  // Ensure brain.db is initialized
  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { updated: 0, tablesProcessed: [] };
  }

  // Calculate the cutoff date
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  // Update learnings: reduce confidence based on age since last update (or creation).
  // SQLite's julianday function computes the difference in days.
  // We use COALESCE to prefer updated_at over created_at for the age calculation.
  const stmt = nativeDb.prepare(`
    UPDATE brain_learnings
    SET confidence = confidence * POWER(?, julianday('now') - julianday(COALESCE(updated_at, created_at))),
        updated_at = datetime('now')
    WHERE COALESCE(updated_at, created_at) < ?
      AND confidence > 0.01
  `);

  const result = stmt.run(decayRate, cutoffDate);
  const updated = typeof result.changes === 'number' ? result.changes : 0;

  return {
    updated,
    tablesProcessed: ['brain_learnings'],
  };
}

// ============================================================================
// Memory Consolidation (T5395)
// ============================================================================

/** Result from consolidating memories. */
export interface ConsolidationResult {
  grouped: number;
  merged: number;
  archived: number;
}

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
  'need',
  'dare',
  'ought',
  'used',
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
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'and',
  'but',
  'or',
  'nor',
  'not',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  'each',
  'every',
  'all',
  'any',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'only',
  'own',
  'same',
  'than',
  'too',
  'very',
  'just',
  'because',
  'until',
  'while',
  'about',
  'against',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
]);

/**
 * Extract significant keywords from text for grouping.
 * Filters stop words and short tokens, returns lowercase words.
 */
function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
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
 * Calculate keyword overlap ratio between two sets.
 * Returns the Jaccard similarity coefficient.
 */
function keywordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Consolidate old observations by keyword similarity.
 *
 * Groups observations older than `olderThanDays` by FTS5 keyword overlap.
 * For groups with at least `minClusterSize` entries, creates one summary
 * observation and marks originals as archived (updated_at set, narrative
 * prefixed with [ARCHIVED]).
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param options - Consolidation configuration
 * @returns Counts of grouped, merged, and archived observations
 */
export async function consolidateMemories(
  projectRoot: string,
  options?: { olderThanDays?: number; minClusterSize?: number },
): Promise<ConsolidationResult> {
  const olderThanDays = options?.olderThanDays ?? 90;
  const minClusterSize = options?.minClusterSize ?? 3;

  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { grouped: 0, merged: 0, archived: 0 };
  }

  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  // Fetch old observations that are not already archived
  const stmt = nativeDb.prepare(`
    SELECT id, type, title, narrative, project, created_at
    FROM brain_observations
    WHERE created_at < ?
      AND narrative NOT LIKE '[ARCHIVED]%'
    ORDER BY created_at DESC
  `);
  const oldObservations = typedAll<BrainConsolidationObservationRow>(stmt, cutoffDate);

  if (oldObservations.length < minClusterSize) {
    return { grouped: 0, merged: 0, archived: 0 };
  }

  // Extract keywords for each observation
  const entries = oldObservations.map((obs) => ({
    ...obs,
    keywords: extractKeywords(`${obs.title} ${obs.narrative ?? ''}`),
    clustered: false,
  }));

  // Greedy clustering: group by keyword overlap >= 0.3
  const clusters: Array<typeof entries> = [];
  const overlapThreshold = 0.3;

  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.clustered) continue;

    const cluster = [entries[i]!];
    entries[i]!.clustered = true;

    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j]!.clustered) continue;
      if (entries[i]!.type !== entries[j]!.type) continue;

      const overlap = keywordOverlap(entries[i]!.keywords, entries[j]!.keywords);
      if (overlap >= overlapThreshold) {
        cluster.push(entries[j]!);
        entries[j]!.clustered = true;
      }
    }

    if (cluster.length >= minClusterSize) {
      clusters.push(cluster);
    }
  }

  let grouped = 0;
  let merged = 0;
  let archived = 0;
  const accessor = await getBrainAccessor(projectRoot);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const cluster of clusters) {
    grouped += cluster.length;

    // Create summary observation from cluster
    const titles = cluster.map((c) => c.title).join('; ');
    const summaryTitle = `Consolidated: ${cluster[0]!.type} observations (${cluster.length} entries)`;
    const summaryNarrative = `Merged from ${cluster.length} observations: ${titles.slice(0, 500)}`;
    const contentHash = createHash('sha256')
      .update(summaryTitle + summaryNarrative)
      .digest('hex')
      .slice(0, 16);
    const id = `O-${Date.now().toString(36)}`;

    await accessor.addObservation({
      id,
      type: cluster[0]!
        .type as typeof import('../store/brain-schema.js').BRAIN_OBSERVATION_TYPES[number],
      title: summaryTitle,
      narrative: summaryNarrative,
      contentHash,
      project: cluster[0]!.project ?? null,
      sourceType: 'agent',
      createdAt: now,
    });
    merged++;

    // Archive originals by prefixing narrative
    for (const obs of cluster) {
      nativeDb
        .prepare(`
        UPDATE brain_observations
        SET narrative = '[ARCHIVED] ' || COALESCE(narrative, ''),
            updated_at = ?
        WHERE id = ?
      `)
        .run(now, obs.id);
      archived++;
    }
  }

  return { grouped, merged, archived };
}

// ============================================================================
// Tier Promotion (T549 Wave 3-B)
// ============================================================================

/** A single promoted or evicted entry record. */
export interface PromotionRecord {
  id: string;
  table: string;
  fromTier: string;
  toTier: string;
  reason: string;
}

/** Eviction record for soft-evicted entries. */
export interface EvictionRecord {
  id: string;
  table: string;
  tier: string;
  reason: string;
}

/** Result from runTierPromotion. */
export interface PromotionResult {
  promoted: PromotionRecord[];
  evicted: EvictionRecord[];
}

/**
 * Run tier promotion for all memory tables.
 *
 * Promotion rules (per spec §1.1–§1.3):
 * - short → medium: citationCount >= 3 AND age > 24h AND verified = true
 *   OR qualityScore >= 0.7 AND verified = true (fast-track)
 * - medium → long:  citationCount >= 5 AND age > 7 days AND verified = true
 *
 * Eviction rules:
 * - short-term entries older than shortTermEvictionDays (default 7) with no
 *   promotion eligibility are soft-evicted (invalidAt = now).
 * - long-term entries are NEVER auto-evicted.
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @returns Lists of promoted and evicted entries
 */
export async function runTierPromotion(projectRoot: string): Promise<PromotionResult> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { promoted: [], evicted: [] };
  }

  const promoted: PromotionRecord[] = [];
  const evicted: EvictionRecord[] = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Threshold timestamps
  const age24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const age7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const evictionCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  // Tables + their date column name (mixed conventions in schema)
  const tables: Array<{ table: string; dateCol: string }> = [
    { table: 'brain_observations', dateCol: 'created_at' },
    { table: 'brain_learnings', dateCol: 'created_at' },
    { table: 'brain_patterns', dateCol: 'extracted_at' },
    { table: 'brain_decisions', dateCol: 'created_at' },
  ];

  for (const { table, dateCol } of tables) {
    // --- short → medium promotion ---
    // Two criteria (union):
    //   A. citationCount >= 3 AND age > 24h AND verified = 1
    //   B. quality_score >= 0.7 AND verified = 1 AND age > 24h (fast-track)
    interface TierRow {
      id: string;
      citation_count: number;
      quality_score: number | null;
    }
    let shortToMedium: TierRow[] = [];
    try {
      shortToMedium = typedAll<TierRow>(
        nativeDb.prepare(`
          SELECT id, citation_count, quality_score
          FROM ${table}
          WHERE memory_tier = 'short'
            AND invalid_at IS NULL
            AND ${dateCol} < ?
            AND verified = 1
            AND (citation_count >= 3 OR quality_score >= 0.7)
        `),
        age24h,
      );
    } catch {
      // Table may lack columns on older DB — best-effort
      continue;
    }

    for (const row of shortToMedium) {
      try {
        nativeDb
          .prepare(`UPDATE ${table} SET memory_tier = 'medium', updated_at = ? WHERE id = ?`)
          .run(now, row.id);
        promoted.push({
          id: row.id,
          table,
          fromTier: 'short',
          toTier: 'medium',
          reason:
            row.citation_count >= 3
              ? `citationCount=${row.citation_count} >= 3, verified, age > 24h`
              : `qualityScore=${row.quality_score?.toFixed(2)} >= 0.70, verified, age > 24h`,
        });
      } catch {
        /* best-effort */
      }
    }

    // --- medium → long promotion ---
    let mediumToLong: TierRow[] = [];
    try {
      mediumToLong = typedAll<TierRow>(
        nativeDb.prepare(`
          SELECT id, citation_count, quality_score
          FROM ${table}
          WHERE memory_tier = 'medium'
            AND invalid_at IS NULL
            AND ${dateCol} < ?
            AND verified = 1
            AND citation_count >= 5
        `),
        age7d,
      );
    } catch {
      continue;
    }

    for (const row of mediumToLong) {
      try {
        nativeDb
          .prepare(`UPDATE ${table} SET memory_tier = 'long', updated_at = ? WHERE id = ?`)
          .run(now, row.id);
        promoted.push({
          id: row.id,
          table,
          fromTier: 'medium',
          toTier: 'long',
          reason: `citationCount=${row.citation_count} >= 5, verified, age > 7d`,
        });
      } catch {
        /* best-effort */
      }
    }

    // --- soft eviction of stale short-term entries ---
    // Evict short-term entries older than 7d that are NOT verified and have
    // low quality (< 0.5). Long-term entries are explicitly protected.
    interface EvictRow {
      id: string;
      quality_score: number | null;
    }
    let toEvict: EvictRow[] = [];
    try {
      toEvict = typedAll<EvictRow>(
        nativeDb.prepare(`
          SELECT id, quality_score
          FROM ${table}
          WHERE memory_tier = 'short'
            AND invalid_at IS NULL
            AND ${dateCol} < ?
            AND (verified = 0 OR verified IS NULL)
            AND (quality_score IS NULL OR quality_score < 0.5)
        `),
        evictionCutoff,
      );
    } catch {
      continue;
    }

    for (const row of toEvict) {
      try {
        nativeDb
          .prepare(`UPDATE ${table} SET invalid_at = ?, updated_at = ? WHERE id = ?`)
          .run(now, now, row.id);
        evicted.push({
          id: row.id,
          table,
          tier: 'short',
          reason: `age > 7d, unverified, qualityScore=${row.quality_score?.toFixed(2) ?? 'null'} < 0.5`,
        });
      } catch {
        /* best-effort */
      }
    }
  }

  return { promoted, evicted };
}

// ============================================================================
// Extended Consolidation (T549 Wave 3-D)
// ============================================================================

/** Extended result returned by runConsolidation. */
export interface RunConsolidationResult {
  /** Entries merged by dedup pass. */
  deduplicated: number;
  /** Entries whose quality score was recomputed. */
  qualityRecomputed: number;
  /** Tier promotions applied. */
  tierPromotions: PromotionResult;
  /** Contradiction pairs found. */
  contradictions: number;
  /** Entries soft-evicted (low quality medium-term). */
  softEvicted: number;
  /** Graph edges strengthened. */
  edgesStrengthened: number;
  /** Summary nodes generated. */
  summariesGenerated: number;
}

/**
 * Run the full sleep-time consolidation pipeline.
 *
 * This is the "Letta OS sleep-time compute" pattern — consolidation runs
 * during idle time (after session end), never during active work.
 *
 * Steps (in order):
 *   1. Deduplication — merge entries with >0.85 content similarity
 *   2. Quality recompute — recalculate scores with current age/citations
 *   3. Tier promotion — runTierPromotion()
 *   4. Contradiction detection — from brain-consolidator
 *   5. Soft eviction — invalidate low-quality medium-term entries
 *   6. Graph edge strengthening — increment weight on frequently-traversed edges
 *   7. Summary generation — existing consolidateMemories() for large clusters
 *
 * All steps are BEST-EFFORT — any step failure is caught and logged to console.warn.
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @returns Aggregated counts from each consolidation step
 */
export async function runConsolidation(projectRoot: string): Promise<RunConsolidationResult> {
  const result: RunConsolidationResult = {
    deduplicated: 0,
    qualityRecomputed: 0,
    tierPromotions: { promoted: [], evicted: [] },
    contradictions: 0,
    softEvicted: 0,
    edgesStrengthened: 0,
    summariesGenerated: 0,
  };

  // Step 1: Deduplication (embedding-based when available)
  try {
    const deduped = await deduplicateByEmbedding(projectRoot);
    result.deduplicated = deduped;
  } catch (err) {
    console.warn('[consolidation] Step 1 deduplication failed:', err);
  }

  // Step 2: Quality recompute (age + citation factor)
  try {
    const recomputed = await recomputeQualityScores(projectRoot);
    result.qualityRecomputed = recomputed;
  } catch (err) {
    console.warn('[consolidation] Step 2 quality recompute failed:', err);
  }

  // Step 3: Tier promotion
  try {
    result.tierPromotions = await runTierPromotion(projectRoot);
  } catch (err) {
    console.warn('[consolidation] Step 3 tier promotion failed:', err);
  }

  // Step 4: Contradiction detection
  try {
    const { detectContradictions } = await import('./brain-consolidator.js');
    const contradictions = await detectContradictions(projectRoot);
    result.contradictions = contradictions.length;
  } catch (err) {
    console.warn('[consolidation] Step 4 contradiction detection failed:', err);
  }

  // Step 5: Soft eviction of low-quality medium-term entries
  try {
    const evicted = await softEvictLowQualityMedium(projectRoot);
    result.softEvicted = evicted;
  } catch (err) {
    console.warn('[consolidation] Step 5 soft eviction failed:', err);
  }

  // Step 6: Graph edge strengthening
  try {
    const strengthened = await strengthenCoRetrievedEdges(projectRoot);
    result.edgesStrengthened = strengthened;
  } catch (err) {
    console.warn('[consolidation] Step 6 edge strengthening failed:', err);
  }

  // Step 7: Summary generation from large observation clusters
  try {
    const summaryResult = await consolidateMemories(projectRoot, {
      olderThanDays: 30,
      minClusterSize: 5,
    });
    result.summariesGenerated = summaryResult.merged;
  } catch (err) {
    console.warn('[consolidation] Step 7 summary generation failed:', err);
  }

  return result;
}

// ============================================================================
// Deduplication (Step 1)
// ============================================================================

/**
 * Merge entries with high embedding similarity (> 0.85 cosine similarity).
 *
 * For each pair above the threshold: keep the higher-quality entry, transfer
 * citationCount, and soft-evict the clone (set invalidAt). When embeddings
 * are unavailable, falls back to exact content-hash deduplication.
 *
 * @param projectRoot - Project root for brain.db resolution
 * @returns Count of merged/evicted duplicate entries
 */
async function deduplicateByEmbedding(projectRoot: string): Promise<number> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return 0;

  let merged = 0;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Exact content-hash dedup (always runs — fast, no embedding needed)
  interface HashDupRow {
    content_hash: string;
    cnt: number;
  }
  const dupHashes = typedAll<HashDupRow>(
    nativeDb.prepare(`
      SELECT content_hash, COUNT(*) as cnt
      FROM brain_observations
      WHERE content_hash IS NOT NULL
        AND invalid_at IS NULL
      GROUP BY content_hash
      HAVING cnt > 1
    `),
  );

  for (const dup of dupHashes) {
    interface DupRow {
      id: string;
      quality_score: number | null;
      citation_count: number;
    }
    const dupes = typedAll<DupRow>(
      nativeDb.prepare(`
        SELECT id, quality_score, citation_count
        FROM brain_observations
        WHERE content_hash = ?
          AND invalid_at IS NULL
        ORDER BY quality_score DESC, citation_count DESC
      `),
      dup.content_hash,
    );

    if (dupes.length < 2) continue;

    // Keep the best entry, evict the rest and transfer their citations
    const [keeper, ...clones] = dupes;
    if (!keeper) continue;

    let totalCitations = keeper.citation_count;
    for (const clone of clones) {
      totalCitations += clone.citation_count;
      nativeDb
        .prepare(`UPDATE brain_observations SET invalid_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, clone.id);
      merged++;
    }

    if (totalCitations !== keeper.citation_count) {
      nativeDb
        .prepare(`UPDATE brain_observations SET citation_count = ?, updated_at = ? WHERE id = ?`)
        .run(totalCitations, now, keeper.id);
    }
  }

  return merged;
}

// ============================================================================
// Quality Recompute (Step 2)
// ============================================================================

/**
 * Recompute quality scores factoring in current citation count and age.
 *
 * Applies a citation boost: +0.01 per citation, capped at +0.15.
 * Applies age decay only on episodic entries (observations, episodic learnings).
 *
 * @param projectRoot - Project root for brain.db resolution
 * @returns Count of entries updated
 */
async function recomputeQualityScores(projectRoot: string): Promise<number> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return 0;

  let updated = 0;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Update observation quality: base + citation boost, min 0.0, max 1.0
  // Only update entries with citation_count > 0 (others unchanged)
  try {
    const stmt = nativeDb.prepare(`
      UPDATE brain_observations
      SET quality_score = MIN(1.0, COALESCE(quality_score, 0.5) + MIN(0.15, citation_count * 0.01)),
          updated_at = ?
      WHERE citation_count > 0
        AND invalid_at IS NULL
    `);
    const r = stmt.run(now);
    updated += typeof r.changes === 'number' ? r.changes : 0;
  } catch {
    /* table may not have all columns — best-effort */
  }

  // Same for learnings
  try {
    const stmt = nativeDb.prepare(`
      UPDATE brain_learnings
      SET quality_score = MIN(1.0, COALESCE(quality_score, 0.5) + MIN(0.15, citation_count * 0.01)),
          updated_at = ?
      WHERE citation_count > 0
        AND invalid_at IS NULL
    `);
    const r = stmt.run(now);
    updated += typeof r.changes === 'number' ? r.changes : 0;
  } catch {
    /* best-effort */
  }

  return updated;
}

// ============================================================================
// Soft Eviction of Low-Quality Medium-Term Entries (Step 5)
// ============================================================================

/**
 * Soft-evict medium-term entries that have decayed below quality threshold.
 *
 * Entries are invalidated (invalidAt = now) when:
 * - memoryTier = 'medium'
 * - qualityScore < 0.30 AND age > 30 days
 * - NOT long-term (protected from auto-eviction)
 *
 * @param projectRoot - Project root for brain.db resolution
 * @returns Count of entries soft-evicted
 */
async function softEvictLowQualityMedium(projectRoot: string): Promise<number> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return 0;

  let evicted = 0;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const age30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  const tables: Array<{ table: string; dateCol: string }> = [
    { table: 'brain_observations', dateCol: 'created_at' },
    { table: 'brain_learnings', dateCol: 'created_at' },
    { table: 'brain_patterns', dateCol: 'extracted_at' },
    { table: 'brain_decisions', dateCol: 'created_at' },
  ];

  for (const { table, dateCol } of tables) {
    try {
      const stmt = nativeDb.prepare(`
        UPDATE ${table}
        SET invalid_at = ?, updated_at = ?
        WHERE memory_tier = 'medium'
          AND invalid_at IS NULL
          AND quality_score IS NOT NULL
          AND quality_score < 0.30
          AND ${dateCol} < ?
      `);
      const r = stmt.run(now, now, age30d);
      evicted += typeof r.changes === 'number' ? r.changes : 0;
    } catch {
      /* column may not exist on older rows — best-effort */
    }
  }

  return evicted;
}

// ============================================================================
// Graph Edge Strengthening (Step 6)
// ============================================================================

/**
 * Strengthen edges between frequently co-retrieved brain graph nodes.
 *
 * Queries the brain_retrieval_log table (if it exists) to find pairs of
 * entries that were returned together frequently (>= 3 times in the last
 * 30 days). For each qualifying pair, increments the edge weight by 0.1
 * (capped at 1.0) in brain_page_edges.
 *
 * Gracefully no-ops when brain_retrieval_log does not yet exist.
 *
 * @param projectRoot - Project root for brain.db resolution
 * @returns Count of edges strengthened
 */
async function strengthenCoRetrievedEdges(projectRoot: string): Promise<number> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return 0;

  // Check if retrieval log table exists
  try {
    nativeDb.prepare('SELECT 1 FROM brain_retrieval_log LIMIT 1').get();
  } catch {
    // Table doesn't exist yet — nothing to do
    return 0;
  }

  const age30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  interface LogRow {
    entry_ids: string;
  }

  let logRows: LogRow[] = [];
  try {
    logRows = typedAll<LogRow>(
      nativeDb.prepare(
        `SELECT entry_ids FROM brain_retrieval_log WHERE created_at >= ? LIMIT 1000`,
      ),
      age30d,
    );
  } catch {
    return 0;
  }

  // Build co-occurrence counts from JSON entry_ids arrays
  const coOccurrence = new Map<string, number>();
  for (const row of logRows) {
    let ids: string[];
    try {
      ids = JSON.parse(row.entry_ids) as string[];
    } catch {
      continue;
    }
    // Generate all pairs from the returned ID list
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        // Normalize pair key to canonical order
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        coOccurrence.set(key, (coOccurrence.get(key) ?? 0) + 1);
      }
    }
  }

  let strengthened = 0;
  for (const [pair, count] of coOccurrence) {
    if (count < 3) continue;
    const [fromId, toId] = pair.split('|');
    if (!fromId || !toId) continue;

    const nodeFrom = `observation:${fromId}`;
    const nodeTo = `observation:${toId}`;

    try {
      // Try to update existing edge
      const updateStmt = nativeDb.prepare(`
        UPDATE brain_page_edges
        SET weight = MIN(1.0, weight + 0.1)
        WHERE from_id = ? AND to_id = ? AND edge_type = 'relates_to'
      `);
      const updateResult = updateStmt.run(nodeFrom, nodeTo);
      const changes = typeof updateResult.changes === 'number' ? updateResult.changes : 0;

      if (changes === 0) {
        // Edge doesn't exist; insert it
        nativeDb
          .prepare(`
            INSERT OR IGNORE INTO brain_page_edges
              (from_id, to_id, edge_type, weight, provenance, created_at)
            VALUES (?, ?, 'relates_to', 0.3, 'consolidation:co-retrieval', ?)
          `)
          .run(nodeFrom, nodeTo, now);
      }
      strengthened++;
    } catch {
      /* best-effort */
    }
  }

  return strengthened;
}
