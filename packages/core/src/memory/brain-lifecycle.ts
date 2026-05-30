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
import { getLogger } from '../logger.js';
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
// Typed Promotion (T1001) — composite 6-signal scorer
// ============================================================================

/** One promoted observation record from promoteObservationsToTyped. */
export interface TypedPromotionRecord {
  /** brain_observations.id */
  observationId: string;
  /** Observation type (e.g. 'discovery', 'decision', 'feature') */
  observationType: string;
  /** Target typed table tier ('learning' | 'pattern') */
  toTier: string;
  /** Composite score that crossed the threshold */
  score: number;
  /** ID of the row written to brain_promotion_log */
  logId: string;
}

/** Result from promoteObservationsToTyped. */
export interface TypedPromotionResult {
  /** Observations that crossed the threshold and were logged for promotion */
  promoted: TypedPromotionRecord[];
  /** Observations that were evaluated but did not cross the threshold */
  skippedCount: number;
  /** Observations already logged in brain_promotion_log (skipped for idempotency) */
  alreadyPromotedCount: number;
}

/**
 * Scan unpromoted brain_observations and promote eligible entries via composite scoring.
 *
 * Uses a 6-signal composite scorer (promotion-score.ts) instead of the legacy 3-rule
 * OR union. Entries that cross the threshold get an audit row in brain_promotion_log.
 * Re-running is idempotent — observations already in brain_promotion_log are skipped.
 *
 * Signal weights (see promotion-score.ts for exact values):
 *  1. citation_count    — normalised retrieval frequency
 *  2. quality_score     — content richness at insert time
 *  3. stability_score   — biological-analog consolidation metric
 *  4. recency           — inverse age decay
 *  5. user_verified     — hard boost for owner-verified entries
 *  6. outcome_correlated — tied to a completed task outcome
 *
 * This function writes to brain_promotion_log only — it does NOT insert rows
 * into brain_learnings or brain_patterns. The actual typed-table insert is
 * the responsibility of a downstream step (e.g. a nightly consolidation pass
 * that reads brain_promotion_log rows with decided_by='composite-scorer').
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param limit - Maximum number of observations to scan per run (default 100)
 * @param threshold - Minimum composite score to trigger promotion (default 0.6)
 * @returns Summary of promoted, skipped, and already-promoted observations
 *
 * @task T1001
 * @epic T1000
 */
export async function promoteObservationsToTyped(
  projectRoot: string,
  limit = 100,
  threshold?: number,
): Promise<TypedPromotionResult> {
  const {
    computePromotionScore,
    computePromotionRationale,
    mapObservationTypeToTier,
    PROMOTION_THRESHOLD,
  } = await import('./promotion-score.js');

  const effectiveThreshold = threshold ?? PROMOTION_THRESHOLD;

  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { promoted: [], skippedCount: 0, alreadyPromotedCount: 0 };
  }

  const promoted: TypedPromotionRecord[] = [];
  let skippedCount = 0;
  let alreadyPromotedCount = 0;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Fetch candidates: observations not yet in brain_promotion_log, not in 'long' tier.
  interface ObsRow {
    id: string;
    type: string;
    citation_count: number;
    quality_score: number | null;
    stability_score: number | null;
    created_at: string;
    verified: number;
    memory_tier: string | null;
    invalid_at: string | null;
  }

  let candidates: ObsRow[] = [];
  try {
    candidates = typedAll<ObsRow>(
      nativeDb.prepare(`
        SELECT
          o.id,
          o.type,
          o.citation_count,
          o.quality_score,
          o.stability_score,
          o.created_at,
          o.verified,
          o.memory_tier,
          o.invalid_at
        FROM brain_observations o
        WHERE o.invalid_at IS NULL
          AND (o.memory_tier IS NULL OR o.memory_tier != 'long')
          AND NOT EXISTS (
            SELECT 1 FROM brain_promotion_log p
            WHERE p.observation_id = o.id
          )
        ORDER BY o.created_at DESC
        LIMIT ?
      `),
      limit,
    );
  } catch {
    // Table or column may not exist yet on older DBs — best-effort
    return { promoted: [], skippedCount: 0, alreadyPromotedCount: 0 };
  }

  for (const row of candidates) {
    // Check idempotency: skip if already logged (shouldn't reach here due to NOT EXISTS above,
    // but guards concurrent callers)
    let alreadyLogged = false;
    try {
      const existing = nativeDb
        .prepare('SELECT id FROM brain_promotion_log WHERE observation_id = ? LIMIT 1')
        .get(row.id) as { id: string } | undefined;
      if (existing) {
        alreadyPromotedCount++;
        alreadyLogged = true;
      }
    } catch {
      /* brain_promotion_log may not exist yet — continue */
    }
    if (alreadyLogged) continue;

    const signals = {
      citationCount: row.citation_count ?? 0,
      qualityScore: row.quality_score,
      stabilityScore: row.stability_score,
      createdAt: row.created_at,
      userVerified: row.verified ?? 0,
      outcomeCorrelated: 0, // future: wire to task outcome correlation
    };

    const score = computePromotionScore(signals);

    if (score < effectiveThreshold) {
      skippedCount++;
      continue;
    }

    const toTier = mapObservationTypeToTier(row.type);
    const rationale = computePromotionRationale(signals, effectiveThreshold);
    const logId = `promo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      nativeDb
        .prepare(
          `INSERT OR IGNORE INTO brain_promotion_log
            (id, observation_id, from_tier, to_tier, score, decided_at, decided_by, rationale_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          logId,
          row.id,
          'observation',
          toTier,
          score,
          now,
          'composite-scorer',
          JSON.stringify(rationale),
        );

      promoted.push({
        observationId: row.id,
        observationType: row.type,
        toTier,
        score,
        logId,
      });
    } catch {
      /* best-effort — brain_promotion_log may not exist yet on older installs */
    }
  }

  return { promoted, skippedCount, alreadyPromotedCount };
}

// ============================================================================
// Extended Consolidation (T549 Wave 3-D)
// ============================================================================

/**
 * Metrics from the auto-extract promotion pipeline (T1903).
 *
 * Tracks how many brain_promotion_log entries were fulfilled (converted
 * to actual brain_learnings/brain_patterns rows) during a consolidation
 * cycle. Surfaced in `cleo doctor brain` for observability.
 */
export interface AutoExtractMetrics {
  /** Total promotion_log rows processed in this run. */
  invocations: number;
  /** Rows that passed dedup and were eligible for storage. */
  candidates: number;
  /** Rows successfully written to brain_learnings or brain_patterns. */
  promoted: number;
  /** Per-reason rejection counts. */
  rejected: {
    already_fulfilled: number;
    store_error: number;
    no_narrative: number;
    dedup_hash: number;
    other: number;
  };
}

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
  /** NEXUS nexus_relations edges decayed by plasticity time-decay (Step 6c, T1072). */
  nexusEdgesDecayed?: number;
  /** Summary nodes generated. */
  summariesGenerated: number;
  /** Code↔memory graph links created. */
  graphLinksCreated?: number;
  /**
   * Auto-extract promotion result from Step 3b (T1903).
   * Counts how many promotion_log entries were fulfilled (written to brain_learnings/brain_patterns).
   */
  autoExtractPromotion?: AutoExtractMetrics;
  /**
   * Pattern dedup result from Step 4b (T1896).
   * Counts near-duplicate brain_patterns rows removed in this consolidation cycle.
   */
  patternDeduped?: number;
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
   * Retention prune result from step 9d (T10348).
   * Counts rows deleted from brain_plasticity_events and brain_weight_history.
   * Populated when retention pruning ran. `skipped:true` indicates the
   * operator-override env var (`CLEO_BRAIN_HISTORY_RETENTION_DAYS=0`)
   * disabled the step.
   */
  historyRetention?: {
    plasticityEventsDeleted: number;
    weightHistoryDeleted: number;
    skipped: boolean;
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
  /**
   * Hard-sweeper result from Step 9f (T995).
   * Deletes confirmed noise: prune_candidate=1 AND quality<0.2 AND citations=0 AND age>30d.
   * Populated when the step ran (always in runConsolidation — best-effort).
   */
  pruneSweep?: {
    deleted: number;
    wouldDelete: number;
    dryRun: boolean;
  };
  /**
   * Tier-2 attention consolidation result from Step 9g (T11382 · Epic T11289).
   *
   * The dream-cycle's review of the `brain_attention` working-memory buffer:
   * salient entries promoted to durable memory via the sticky-convert conduit,
   * noise/expired entries discarded via the homeostatic sweep, mid-salience
   * entries kept open. Populated when the step ran (always in runConsolidation —
   * best-effort). See `attention-consolidate.ts`.
   */
  attentionConsolidation?: {
    /** Live attention entries reviewed this cycle. */
    reviewed: number;
    /** Entries promoted to durable memory via the conduit. */
    promoted: number;
    /** Entries left `open` for the next cycle. */
    kept: number;
    /** Entries swept to `discarded` (TTL/decay). */
    discarded: number;
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
 *   9d. History retention — prune brain_plasticity_events + brain_weight_history (T10348)
 *   9e. Consolidation event log — INSERT into brain_consolidation_events (T694)
 *   9f. Hard-sweeper — DELETE prune_candidate=1 + quality<0.2 + citations=0 + age>30d (T995)
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

  // Step 3b: Fulfil promotion log — write promotion_log entries into brain_learnings/brain_patterns (T1903)
  // promoteObservationsToTyped (Step 3) only writes audit rows; this step performs the actual inserts.
  try {
    result.autoExtractPromotion = await fulfillPromotionLog(projectRoot);
  } catch (err) {
    console.warn('[consolidation] Step 3b promotion fulfillment failed:', err);
  }

  // Step 4: Contradiction detection
  try {
    const { detectContradictions } = await import('./brain-consolidator.js');
    const contradictions = await detectContradictions(projectRoot);
    result.contradictions = contradictions.length;
  } catch (err) {
    console.warn('[consolidation] Step 4 contradiction detection failed:', err);
  }

  // Step 4b: Pattern near-duplicate dedup (T1896)
  // Collapse rows with identical normalized title + same peer_id within a 1hr window.
  try {
    const { dedupePatterns } = await import('./brain-consolidator.js');
    result.patternDeduped = await dedupePatterns(projectRoot);
  } catch (err) {
    console.warn('[consolidation] Step 4b pattern dedup failed:', err);
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

  // Step 6c: Plasticity decay (T1072)
  // Applies time-based weight reduction to nexus_relations edges based on
  // the plasticity half-life. Edges unused for the half-life period see their
  // weight halved. This implements the "cold symbol" detection mechanism that
  // identifies code that has become less relevant over time.
  try {
    const { applyPlasticityDecay } = await import('./nexus-plasticity.js');
    // nexus.db is global (resolved via getCleoHome()), not per-project
    const decayResult = await applyPlasticityDecay();
    result.nexusEdgesDecayed = decayResult.updated;
  } catch (err) {
    console.warn('[consolidation] Step 6c plasticity decay failed:', err);
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

  // Step 9d: History retention — bound brain_plasticity_events + brain_weight_history (T10348)
  // Prevents unbounded growth of STDP-driven append-only event logs that, per the
  // T10301 RCA, grew 19K → 3.57M rows (182×) in 19 days and pushed brain.db to 1.7 GB.
  // Two-stage prune: (1) age-based (rows older than retentionDays), (2) row-cap fallback
  // if the table is still over its hard cap. Operator-overridable via
  // CLEO_BRAIN_HISTORY_RETENTION_DAYS=0 (disable) or any positive integer (override window).
  // Best-effort — never blocks the pipeline.
  try {
    const { pruneStaleHistory } = await import('./brain-stdp.js');
    const retentionResult = await pruneStaleHistory(projectRoot);
    result.historyRetention = retentionResult;
  } catch (err) {
    console.warn('[consolidation] Step 9d history retention failed:', err); // json-stream-hygiene-allowed: matches Step 9a-9f best-effort console.warn pattern in this file
  }

  // Step 9f: Hard-sweeper — autonomous DELETE for prune candidates (T995)
  // Deletes rows satisfying ALL: prune_candidate=1 AND quality_score<0.2
  // AND citation_count=0 AND age>30d. Runs BEFORE Step 9e so that the
  // consolidation event log captures the sweep result in step_results_json.
  // Best-effort — never blocks.
  try {
    const { runPruneSweep } = await import('./brain-maintenance.js');
    const sweepResult = await runPruneSweep(projectRoot);
    result.pruneSweep = {
      deleted: sweepResult.deleted,
      wouldDelete: sweepResult.wouldDelete,
      dryRun: sweepResult.dryRun,
    };
  } catch (err) {
    console.warn('[consolidation] Step 9f prune sweep failed:', err);
  }

  // Step 9g: Tier-2 attention consolidation — review the brain_attention
  // working-memory buffer (T11382 · Epic T11289 · Saga T11283).
  //
  // The dream-cycle reviews every live jot, applies one promote|keep|discard
  // verdict from the SAME composite 6-signal scorer used for observations,
  // promotes salient entries to durable memory via the sticky-convert conduit
  // (carrying scope provenance so cross-agent leakage cannot occur), and sweeps
  // noise/expired entries via the homeostatic decay sweep. Runs BEFORE Step 9e
  // so the consolidation event log captures the Tier-2 outcome in
  // step_results_json. Best-effort — never blocks the pipeline.
  try {
    const { consolidateAttention } = await import('./attention-consolidate.js');
    const attentionResult = await consolidateAttention(projectRoot);
    result.attentionConsolidation = {
      reviewed: attentionResult.reviewed,
      promoted: attentionResult.promoted,
      kept: attentionResult.kept,
      discarded: attentionResult.discarded,
    };
  } catch (err) {
    getLogger('consolidation').warn({ err }, 'Step 9g attention consolidation failed');
  }

  // Step 9e: Log this consolidation run to brain_consolidation_events (T694)
  // Captures trigger, session_id, per-step stats, duration for pipeline observability.
  // Runs AFTER Step 9f so the event JSON includes the sweep result.
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
// Promotion Log Fulfillment (Step 3b — T1903)
// ============================================================================

/**
 * Fulfill pending entries in brain_promotion_log by inserting them into
 * brain_learnings or brain_patterns.
 *
 * `promoteObservationsToTyped` (Step 3 of runConsolidation) only writes audit
 * rows to brain_promotion_log — it does NOT insert into the typed tables.
 * This step reads those pending log rows and performs the actual inserts.
 *
 * Idempotent: rows that have already been fulfilled (fulfilled_at IS NOT NULL)
 * are skipped.
 *
 * @param projectRoot - Project root for brain.db resolution
 * @returns AutoExtractMetrics describing what happened
 *
 * @task T1903
 */
export async function fulfillPromotionLog(projectRoot: string): Promise<AutoExtractMetrics> {
  const metrics: AutoExtractMetrics = {
    invocations: 0,
    candidates: 0,
    promoted: 0,
    rejected: {
      already_fulfilled: 0,
      store_error: 0,
      no_narrative: 0,
      dedup_hash: 0,
      other: 0,
    },
  };

  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return metrics;

  // Guard: brain_promotion_log must exist
  try {
    nativeDb.prepare('SELECT 1 FROM brain_promotion_log LIMIT 1').get();
  } catch {
    return metrics;
  }

  interface PromotionLogRow {
    id: string;
    observation_id: string;
    to_tier: string;
    score: number;
    fulfilled_at: string | null;
  }

  // Fetch unfulfilled promotion log rows
  let pending: PromotionLogRow[] = [];
  try {
    pending = typedAll<PromotionLogRow>(
      nativeDb.prepare(`
        SELECT id, observation_id, to_tier, score, fulfilled_at
        FROM brain_promotion_log
        WHERE fulfilled_at IS NULL
          AND decided_by = 'composite-scorer'
        ORDER BY score DESC
        LIMIT 200
      `),
    );
  } catch {
    return metrics;
  }

  metrics.invocations = pending.length;

  if (pending.length === 0) return metrics;

  // Fetch observation rows for all pending log entries in one query
  const obsIds = pending.map((r) => r.observation_id);
  const placeholders = obsIds.map(() => '?').join(', ');

  interface ObsDetailRow {
    id: string;
    type: string;
    title: string;
    narrative: string | null;
    created_at: string;
    citation_count: number;
  }

  const obsMap = new Map<string, ObsDetailRow>();
  try {
    const rows = typedAll<ObsDetailRow>(
      nativeDb.prepare(
        `SELECT id, type, title, narrative, created_at, citation_count
         FROM brain_observations
         WHERE id IN (${placeholders}) AND invalid_at IS NULL`,
      ),
      ...obsIds,
    );
    for (const row of rows) {
      obsMap.set(row.id, row);
    }
  } catch {
    // If we can't fetch observations, nothing to promote
    return metrics;
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const { checkHashDedup } = await import('./extraction-gate.js');

  for (const logRow of pending) {
    const obs = obsMap.get(logRow.observation_id);
    if (!obs) {
      metrics.rejected.other++;
      continue;
    }

    const content = obs.narrative ?? obs.title;
    if (!content?.trim()) {
      metrics.rejected.no_narrative++;
      // Mark as fulfilled with a rejection note so it won't be retried
      try {
        nativeDb
          .prepare(
            `UPDATE brain_promotion_log SET fulfilled_at = ?, fulfillment_note = 'no-narrative' WHERE id = ?`,
          )
          .run(now, logRow.id);
      } catch {
        /* column may not exist — skip */
      }
      continue;
    }

    metrics.candidates++;

    // Hash dedup: skip if identical content already in the target table
    const targetTable =
      logRow.to_tier === 'pattern' ? ('brain_patterns' as const) : ('brain_learnings' as const);

    const dedupResult = await checkHashDedup(projectRoot, content, targetTable);
    if (dedupResult.matched) {
      metrics.rejected.dedup_hash++;
      try {
        nativeDb
          .prepare(
            `UPDATE brain_promotion_log SET fulfilled_at = ?, fulfillment_note = 'dedup-hash' WHERE id = ?`,
          )
          .run(now, logRow.id);
      } catch {
        /* best-effort */
      }
      continue;
    }

    // Store in the appropriate typed table
    try {
      if (logRow.to_tier === 'pattern') {
        const { storePattern } = await import('./patterns.js');
        await storePattern(projectRoot, {
          type: 'workflow',
          pattern: content,
          context: obs.title,
          _skipGate: true,
        });
      } else {
        // learning (includes 'learning' and 'decision' → brain_learnings)
        const { storeLearning } = await import('./learnings.js');
        await storeLearning(projectRoot, {
          insight: content,
          source: `promotion-log:${logRow.id}`,
          confidence: Math.min(logRow.score, 1.0),
          actionable: obs.type === 'bugfix' || obs.type === 'discovery',
          _skipGate: true,
        });
      }

      metrics.promoted++;

      // Mark log row as fulfilled
      try {
        nativeDb
          .prepare(
            `UPDATE brain_promotion_log SET fulfilled_at = ?, fulfillment_note = 'stored' WHERE id = ?`,
          )
          .run(now, logRow.id);
      } catch {
        /* best-effort — fulfilled_at column may not exist in older schema */
      }
    } catch {
      metrics.rejected.store_error++;
      // Do NOT mark as fulfilled so it can be retried
    }
  }

  return metrics;
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
/**
 * Parse entry_ids which may be either JSON array or comma-separated string (BUG-2 fix).
 *
 * @param raw - Raw entry_ids value from brain_retrieval_log
 * @returns Parsed array of entry IDs, or empty array if parse fails
 */
function parseEntryIds(raw: string): string[] {
  const trimmed = raw.trim();
  // Try JSON array first
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  // Fall back to comma-separated (legacy format from pre-migration data)
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

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
    // BUG-2 fix: handle both JSON array and comma-separated formats
    const ids = parseEntryIds(row.entry_ids);
    if (ids.length < 2) continue;

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
