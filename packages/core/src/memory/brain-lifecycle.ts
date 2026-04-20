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
import { getBrainAccessor } from '../store/memory-accessor.js';
import { typedAll } from '../store/typed-query.js';
import type { BrainConsolidationObservationRow } from './brain-row-types.js';
import { EDGE_TYPES } from './edge-types.js';

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
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
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

  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
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
        .type as typeof import('../store/memory-schema.js').BRAIN_OBSERVATION_TYPES[number],
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
 * Promotion rules (per spec §1.1–§1.3, relaxed in T614):
 * - short → medium:
 *     A. (citationCount >= 3 AND age > 24h) — citation-based track
 *     B. (qualityScore >= 0.7 AND age > 24h) — quality fast-track
 *     C. (verified = true AND age > 24h) — owner-verified track
 *   Note: `verified` is no longer a hard gate for routes A and B.
 *   Requiring verified=true on all paths caused all 235 short-tier observations
 *   to be permanently stuck (T614 bug).
 * - medium → long:
 *     (citationCount >= 5 AND age > 7 days) OR (verified = true AND age > 7 days)
 *   Verified entries accelerate to long-tier without citation threshold.
 *
 * Eviction rules:
 * - short-term entries older than 7 days with no promotion eligibility are
 *   soft-evicted (invalidAt = now).
 * - long-term entries are NEVER auto-evicted.
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @returns Lists of promoted and evicted entries
 */
export async function runTierPromotion(projectRoot: string): Promise<PromotionResult> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
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
    // Three criteria (union — verified is no longer a hard gate for A/B paths):
    //   A. citationCount >= 3 AND age > 24h  (citation track — no verified requirement)
    //   B. quality_score >= 0.7 AND age > 24h (quality fast-track — no verified requirement)
    //   C. verified = 1 AND age > 24h         (owner-verified track)
    interface TierRow {
      id: string;
      citation_count: number;
      quality_score: number | null;
      verified: number;
    }
    let shortToMedium: TierRow[] = [];
    try {
      shortToMedium = typedAll<TierRow>(
        nativeDb.prepare(`
          SELECT id, citation_count, quality_score, verified
          FROM ${table}
          WHERE memory_tier = 'short'
            AND invalid_at IS NULL
            AND ${dateCol} < ?
            AND (
              citation_count >= 3
              OR quality_score >= 0.7
              OR verified = 1
            )
        `),
        age24h,
      );
    } catch {
      // Table may lack columns on older DB — best-effort
      continue;
    }

    for (const row of shortToMedium) {
      try {
        let reason: string;
        if (row.citation_count >= 3) {
          reason = `citationCount=${row.citation_count} >= 3, age > 24h`;
        } else if ((row.quality_score ?? 0) >= 0.7) {
          reason = `qualityScore=${row.quality_score?.toFixed(2)} >= 0.70, age > 24h`;
        } else {
          reason = `verified=true, age > 24h`;
        }
        // T743: persist tier_promoted_at + tier_promotion_reason for audit trail
        nativeDb
          .prepare(
            `UPDATE ${table} SET memory_tier = 'medium', updated_at = ?, tier_promoted_at = ?, tier_promotion_reason = ? WHERE id = ?`,
          )
          .run(now, now, reason, row.id);
        promoted.push({ id: row.id, table, fromTier: 'short', toTier: 'medium', reason });
      } catch {
        /* best-effort */
      }
    }

    // --- medium → long promotion ---
    // Two criteria (union — verified accelerates to long without citation threshold):
    //   A. citationCount >= 5 AND age > 7d
    //   B. verified = 1 AND age > 7d (owner-verified accelerated track)
    let mediumToLong: TierRow[] = [];
    try {
      mediumToLong = typedAll<TierRow>(
        nativeDb.prepare(`
          SELECT id, citation_count, quality_score, verified
          FROM ${table}
          WHERE memory_tier = 'medium'
            AND invalid_at IS NULL
            AND ${dateCol} < ?
            AND (citation_count >= 5 OR verified = 1)
        `),
        age7d,
      );
    } catch {
      continue;
    }

    for (const row of mediumToLong) {
      try {
        const reason =
          row.citation_count >= 5
            ? `citationCount=${row.citation_count} >= 5, age > 7d`
            : `verified=true, age > 7d`;
        // T743: persist tier_promoted_at + tier_promotion_reason for audit trail
        nativeDb
          .prepare(
            `UPDATE ${table} SET memory_tier = 'long', updated_at = ?, tier_promoted_at = ?, tier_promotion_reason = ? WHERE id = ?`,
          )
          .run(now, now, reason, row.id);
        promoted.push({ id: row.id, table, fromTier: 'medium', toTier: 'long', reason });
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
  /** Graph edges strengthened (BRAIN brain_page_edges, Step 6). */
  edgesStrengthened: number;
  /** NEXUS nexus_relations edges strengthened by co-access (Step 6b, T998). */
  nexusEdgesStrengthened: number;
  /** Summary nodes generated. */
  summariesGenerated: number;
  /** Code↔memory graph links created. */
  graphLinksCreated?: number;
  /** R-STDP reward backfill result from step 9a (T681). */
  rewardBackfilled?: {
    rowsLabeled: number;
    rowsSkipped: number;
  };
  /** STDP plasticity result from step 9b. */
  stdpPlasticity?: {
    ltpEvents: number;
    ltdEvents: number;
    edgesCreated: number;
    pairsExamined: number;
  };
  /**
   * Homeostatic decay result from step 9c (T690).
   * Counts edges that had their weight reduced (decayed) and edges deleted (pruned).
   */
  homeostaticDecay?: {
    edgesDecayed: number;
    edgesPruned: number;
  };
  /**
   * Outcome correlation result from Step 9a.5 (T994).
   * Populated when correlateOutcomes ran during consolidation.
   */
  outcomeCorrelation?: {
    boosted: number;
    penalized: number;
    flaggedForPruning: number;
  };
  /**
   * LLM-driven sleep consolidation result from Step 10 (T734).
   * Populated when sleep consolidation ran. Absent when skipped (disabled or no LLM).
   */
  sleepConsolidation?: {
    ran: boolean;
    merged: number;
    pruned: number;
    patternsGenerated: number;
    insightsStored: number;
  };
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
 *   8. Code↔memory graph linking
 *   9a. R-STDP reward backfill — assign reward_signal from task outcomes (T681)
 *   9a.5. Outcome correlation — correlateOutcomes quality adjustments (T994)
 *   9b. STDP timing-dependent plasticity — apply Δw using reward_signal (T679)
 *   9c. Homeostatic decay — synaptic scaling + pruning (T690)
 *   9e. Consolidation event log — INSERT into brain_consolidation_events (T694)
 *
 * All steps are BEST-EFFORT — any step failure is caught and logged to console.warn.
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param sessionId - Active session ID, passed to backfillRewardSignals (Step 9a).
 *   If null/undefined, Step 9a is a no-op (no task correlation available).
 * @param trigger - What triggered this consolidation run (for observability).
 *   Defaults to 'session_end'. Written to brain_consolidation_events.
 * @returns Aggregated counts from each consolidation step
 */
export async function runConsolidation(
  projectRoot: string,
  sessionId?: string | null,
  trigger: 'session_end' | 'maintenance' | 'scheduled' | 'manual' = 'session_end',
): Promise<RunConsolidationResult> {
  const consolidationStartMs = Date.now();

  const result: RunConsolidationResult = {
    deduplicated: 0,
    qualityRecomputed: 0,
    tierPromotions: { promoted: [], evicted: [] },
    contradictions: 0,
    softEvicted: 0,
    edgesStrengthened: 0,
    nexusEdgesStrengthened: 0,
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

  // Step 6b: NEXUS edge plasticity — co-access strengthening (T998)
  // Extracts co-retrieved node pairs from brain_retrieval_log and strengthens
  // the corresponding nexus_relations edges (Hebbian "fire together wire together").
  // Runs after Step 6 (BRAIN graph edge strengthening) so the two passes are
  // complementary: Step 6 strengthens brain_page_edges, Step 6b nexus_relations.
  try {
    const { extractNexusPairsFromRetrievalLog, strengthenNexusCoAccess } = await import(
      './nexus-plasticity.js'
    );
    const nexusPairs = await extractNexusPairsFromRetrievalLog(projectRoot);
    if (nexusPairs.length > 0) {
      const nexusResult = await strengthenNexusCoAccess(nexusPairs);
      result.nexusEdgesStrengthened = nexusResult.strengthened;
    } else {
      result.nexusEdgesStrengthened = 0;
    }
  } catch (err) {
    console.warn('[consolidation] Step 6b nexus plasticity failed:', err);
    result.nexusEdgesStrengthened = 0;
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

  // Step 8: Link memory nodes to code graph (graph-memory-bridge, T555)
  // Scans brain entries for entity references and creates code_reference
  // edges connecting memory to nexus-indexed symbols.
  try {
    const { autoLinkMemories } = await import('./graph-memory-bridge.js');
    const bridgeResult = await autoLinkMemories(projectRoot);
    result.graphLinksCreated = bridgeResult.linked;
  } catch (err) {
    console.warn('[consolidation] Step 8 graph memory bridge failed:', err);
  }

  // Step 9a: R-STDP reward backfill (T681)
  // Derives reward_signal for brain_retrieval_log rows from task outcomes in tasks.db.
  // Runs BEFORE Step 9b so that STDP can read reward signals during Δw computation.
  // No-op when sessionId is null (no task correlation available) or synthetic session.
  try {
    const { backfillRewardSignals } = await import('./brain-stdp.js');
    const rewardResult = await backfillRewardSignals(projectRoot, sessionId ?? null);
    result.rewardBackfilled = rewardResult;
  } catch (err) {
    console.warn('[consolidation] Step 9a reward backfill failed:', err);
  }

  // Step 9a.5: Outcome correlation — quality feedback loop (T994)
  // Applies +0.05/-0.05 quality adjustments based on brain_usage_log outcomes,
  // and flags stale zero-citation entries as prune candidates.
  // Runs AFTER Step 9a (reward backfill) so that any task outcomes just labeled
  // are visible to correlateOutcomes during this run.
  // The setImmediate fire-and-forget in task-hooks.ts remains as defense-in-depth.
  try {
    const { correlateOutcomes } = await import('./quality-feedback.js');
    const correlateResult = await correlateOutcomes(projectRoot);
    result.outcomeCorrelation = {
      boosted: correlateResult.boosted,
      penalized: correlateResult.penalized,
      flaggedForPruning: correlateResult.flaggedForPruning,
    };
  } catch (err) {
    console.warn('[consolidation] Step 9a.5 outcome correlation failed:', err);
  }

  // Step 9b: STDP timing-dependent plasticity (T626 phase 5)
  // Refines co_retrieved edge weights using retrieval temporal order.
  // Runs after Hebbian strengthening (step 6) and reward backfill (step 9a).
  // T714: Minimum-pair gate — skip if fewer than 2 new retrievals since last event.
  try {
    const { applyStdpPlasticity, shouldRunPlasticity } = await import('./brain-stdp.js');
    const shouldRun = await shouldRunPlasticity(projectRoot, sessionId ?? null, 2);
    if (shouldRun) {
      const stdpResult = await applyStdpPlasticity(projectRoot);
      result.stdpPlasticity = stdpResult;
    } else {
      // Gate blocked execution — default result
      result.stdpPlasticity = {
        ltpEvents: 0,
        ltdEvents: 0,
        edgesCreated: 0,
        pairsExamined: 0,
      };
    }
  } catch (err) {
    console.warn('[consolidation] Step 9b STDP plasticity failed:', err);
  }

  // Step 9c: Homeostatic decay — synaptic scaling + pruning (T690)
  // Applies exponential weight decay to hebbian/stdp edges idle beyond grace period.
  // Prunes edges whose post-decay weight falls below min_weight=0.05.
  // Runs AFTER Step 9b so that fresh LTP events are never immediately decayed.
  try {
    const { applyHomeostaticDecay } = await import('./brain-stdp.js');
    const decayResult = await applyHomeostaticDecay(projectRoot);
    result.homeostaticDecay = decayResult;
  } catch (err) {
    console.warn('[consolidation] Step 9c homeostatic decay failed:', err);
  }

  // Step 9e: Log this consolidation run to brain_consolidation_events (T694)
  // Captures trigger, session_id, per-step stats, duration for pipeline observability.
  // Best-effort — a logging failure MUST NOT abort the pipeline or throw.
  try {
    const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();

    if (nativeDb) {
      // Guard: brain_consolidation_events must exist (M4 migration)
      let consolidationEventsExist = false;
      try {
        nativeDb.prepare('SELECT 1 FROM brain_consolidation_events LIMIT 1').get();
        consolidationEventsExist = true;
      } catch {
        // table not yet created — skip
      }

      if (consolidationEventsExist) {
        const durationMs = Date.now() - consolidationStartMs;
        const stepResultsJson = JSON.stringify(result);

        nativeDb
          .prepare(
            `INSERT INTO brain_consolidation_events
               (trigger, session_id, step_results_json, duration_ms, succeeded)
             VALUES (?, ?, ?, ?, 1)`,
          )
          .run(trigger, sessionId ?? null, stepResultsJson, durationMs);
      }
    }
  } catch (err) {
    console.warn('[consolidation] Step 9e consolidation event log failed:', err);
  }

  // Step 10: LLM-driven sleep consolidation (T734)
  // Runs the 4-step LLM pipeline: merge duplicates, prune stale, strengthen
  // patterns, generate insights. Enabled by default when an LLM API key is
  // available. Graceful no-op when disabled or LLM is unavailable — never
  // blocks or throws.
  try {
    const { runSleepConsolidation } = await import('./sleep-consolidation.js');
    const sleepResult = await runSleepConsolidation(projectRoot);
    result.sleepConsolidation = {
      ran: sleepResult.ran,
      merged: sleepResult.mergeDuplicates.merged,
      pruned: sleepResult.pruneStale.pruned,
      patternsGenerated: sleepResult.strengthenPatterns.patternsGenerated,
      insightsStored: sleepResult.generateInsights.insightsStored,
    };
    if (sleepResult.ran) {
      // Roll up LLM-generated summaries into the top-level summariesGenerated
      // counter so that `cleo memory dream` output shows non-zero "Summaries gen"
      // when the LLM pipeline ran successfully.
      result.summariesGenerated +=
        sleepResult.strengthenPatterns.patternsGenerated +
        sleepResult.generateInsights.insightsStored;
    } else {
      console.warn('[consolidation] Step 10 sleep consolidation skipped (disabled or no LLM)');
    }
  } catch (err) {
    console.warn('[consolidation] Step 10 sleep consolidation failed:', err);
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
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
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
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
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
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
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
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
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
    query: string;
  }

  let logRows: LogRow[] = [];
  try {
    logRows = typedAll<LogRow>(
      nativeDb.prepare(
        `SELECT entry_ids, query FROM brain_retrieval_log WHERE created_at >= ? LIMIT 1000`,
      ),
      age30d,
    );
  } catch {
    return 0;
  }

  // Build co-occurrence tracking: Map<pair, Set<distinct queries>>
  const coOccurrence = new Map<string, Set<string>>();
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
        const querySet = coOccurrence.get(key) ?? new Set<string>();
        querySet.add(row.query);
        coOccurrence.set(key, querySet);
      }
    }
  }

  let strengthened = 0;
  for (const [pair, querySet] of coOccurrence) {
    if (querySet.size < 3) continue;
    const [fromId, toId] = pair.split('|');
    if (!fromId || !toId) continue;

    const nodeFrom = `observation:${fromId}`;
    const nodeTo = `observation:${toId}`;

    try {
      // Try to update existing edge — set plasticity_class='hebbian' on UPDATE (T693)
      const updateStmt = nativeDb.prepare(`
        UPDATE brain_page_edges
        SET weight = MIN(1.0, weight + 0.1),
            plasticity_class = 'hebbian'
        WHERE from_id = ? AND to_id = ? AND edge_type = ?
      `);
      const updateResult = updateStmt.run(nodeFrom, nodeTo, EDGE_TYPES.CO_RETRIEVED);
      const changes = typeof updateResult.changes === 'number' ? updateResult.changes : 0;

      if (changes === 0) {
        // Edge doesn't exist; insert it with plasticity_class='hebbian' (T693)
        nativeDb
          .prepare(`
            INSERT OR IGNORE INTO brain_page_edges
              (from_id, to_id, edge_type, weight, provenance, plasticity_class, created_at)
            VALUES (?, ?, ?, 0.3, 'consolidation:co-retrieval', 'hebbian', ?)
          `)
          .run(nodeFrom, nodeTo, EDGE_TYPES.CO_RETRIEVED, now);
      }
      strengthened++;
    } catch {
      /* best-effort */
    }
  }

  return strengthened;
}

/**
 * Test export of strengthenCoRetrievedEdges for vitest (T790).
 * @internal for testing only
 */
export const strengthenCoRetrievedEdgesForTest = strengthenCoRetrievedEdges;
