/**
 * Brain noise detector — T1262 memory-doctor (read-only, parallel to E1).
 *
 * Inspects `.cleo/brain.db` for known noise patterns without modifying any
 * data. The detector is a prerequisite for the W7 shadow-write sweep
 * (T1147 / v2026.4.132) and the M7 assert-clean gate that guards Sentient v1
 * activation (T1148 / v2026.4.133).
 *
 * **Read-only contract** — this module MUST NOT write to brain.db or any
 * other persistent store. All operations are SELECT-only. The sweep
 * (mutation) phase ships in T1147 W7 under a shadow-write envelope.
 *
 * ## Noise pattern catalogue
 *
 * | Pattern | Description | Detectable via |
 * |---------|-------------|----------------|
 * | `duplicate-content` | Entries with identical `content` hash across different IDs | SHA-256 content comparison |
 * | `missing-type` | Entries where `type` is NULL or empty string | NULL/empty check |
 * | `missing-provenance` | Entries where `provenance` is NULL (unverified source) | NULL check |
 * | `orphan-edge` | Brain graph edges pointing to non-existent nodes | JOIN gap |
 * | `low-confidence` | `confidence < 0.1` entries (near-zero signal, likely noise) | threshold check |
 * | `stale-unverified` | Unverified entries older than 90 days with zero retrieval count | age + retrieval join |
 *
 * @module memory/brain-doctor
 * @task T1262 memory-doctor detector (E1-parallel, read-only)
 * @task T1258 E1 canonical naming refactor
 * @see T1147 W7 for the mutator sweep that acts on these findings
 * @see T1148 W8 M7 gate — `cleo memory doctor --assert-clean` must exit 0 before Sentient v1
 */

import type { KnowledgeDiagnostic } from '@cleocode/contracts';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';

// ============================================================================
// Types
// ============================================================================

/** A single detected noise entry. */
export interface BrainNoiseEntry {
  /** Noise pattern identifier. */
  pattern: NoisePattern;
  /** Number of brain entries matching this pattern. */
  count: number;
  /** Sample entry IDs (up to 5) for human inspection. */
  sampleIds: string[];
  /** Human-readable description of the pattern. */
  description: string;
}

/** Union of known noise pattern identifiers. */
export type NoisePattern =
  | 'duplicate-content'
  | 'missing-type'
  | 'missing-provenance'
  | 'orphan-edge'
  | 'low-confidence'
  | 'stale-unverified';

/**
 * Auto-extract pipeline health metrics surfaced in `cleo doctor brain` (T1903).
 *
 * Pulled from the live brain.db — reflects the current state, not a historical
 * run. Shows whether the promotion pipeline is producing learnings at a healthy rate.
 */
export interface AutoExtractHealth {
  /** Total rows in brain_observations (valid only). */
  observationCount: number;
  /** Total rows in brain_learnings (valid only). */
  learningCount: number;
  /** Pending promotion_log rows (not yet fulfilled). */
  pendingPromotions: number;
  /** Fulfilled promotion_log rows (successfully converted to typed entries). */
  fulfilledPromotions: number;
  /** Ratio of learnings to observations (0–1). Values below 0.01 indicate a broken pipeline. */
  extractionRatio: number;
  /** Most recent consolidation event timestamp, or null if none. */
  lastConsolidationAt: string | null;
  /** Whether the extraction pipeline appears healthy (ratio > 0.01 OR no observations). */
  healthy: boolean;
}

/** Result of a brain noise scan. */
export interface BrainDoctorResult {
  /**
   * Total number of brain entries scanned.
   * Covers all typed tables: observations, decisions, patterns, learnings.
   */
  totalScanned: number;
  /** All detected noise entries, grouped by pattern. */
  findings: BrainNoiseEntry[];
  /**
   * `true` when zero noise patterns were detected across all tables.
   * This is the condition checked by `cleo memory doctor --assert-clean`.
   */
  isClean: boolean;
  /** Structural scan completeness, independent of extraction and semantic authority. */
  structure?: KnowledgeDiagnostic;
  /** Semantic reconciliation is not performed by this structural scanner. */
  semantics?: KnowledgeDiagnostic;
  /** Extraction health is reported separately and does not establish semantic correctness. */
  extraction?: KnowledgeDiagnostic;
  /** ISO 8601 timestamp when the scan completed. */
  scannedAt: string;
  /**
   * Auto-extract pipeline health (T1903).
   * Shows whether observations are being promoted to learnings at a healthy rate.
   */
  autoExtractHealth?: AutoExtractHealth;
  /**
   * Provenance distribution counts (T1897).
   * Shows how many observations have each origin value (manual, auto-extract, etc.)
   * and how many have been ground-truth verified via validated_at.
   */
  provenanceDistribution?: ProvenanceDistribution;
}

/** Provenance distribution in brain_observations (T1897). */
export interface ProvenanceDistribution {
  /** Total observations (valid only). */
  total: number;
  /** Count by origin value (null = legacy rows without origin). */
  byOrigin: Record<string, number>;
  /** Count with validated_at set (ground-truth verified). */
  verifiedCount: number;
  /** Count with provenance_chain set (derived rows). */
  derivedCount: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Entries older than this (in days) with zero retrievals are flagged as stale. */
const STALE_AGE_DAYS = 90;

/** Entries with confidence below this threshold are flagged as low-confidence noise. */
const LOW_CONFIDENCE_THRESHOLD = 0.1;

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Collect sample IDs (up to 5) from a SQLite query result.
 *
 * @param rows - Array of SQLite row objects with at least an `id` field.
 * @returns Array of up to 5 id strings.
 */
function sampleIds(rows: readonly { id?: string | null }[]): string[] {
  return rows
    .slice(0, 5)
    .map((r) => r.id ?? 'unknown')
    .filter((id) => id !== 'unknown');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Count all graph edges with a missing endpoint while retaining a bounded sample.
 * @param db - Canonical native brain handle for the explicitly selected project.
 * @returns An exact orphan-edge finding, or null when both endpoints exist for every edge.
 * @remarks A single statement keeps the total and sample consistent. Query failures propagate;
 * this read-only assessment neither removes history nor invents missing records.
 * @example
 * ```ts
 * const finding = scanBrainGraphOrphans(nativeDb);
 * ```
 */
export function scanBrainGraphOrphans(
  db: NonNullable<ReturnType<typeof getBrainNativeDb>>,
): BrainNoiseEntry | null {
  const rows = db
    .prepare(`
    SELECT e.from_id || '->' || e.to_id AS id, COUNT(*) OVER () AS total
    FROM main.brain_page_edges e
    LEFT JOIN main.brain_page_nodes src ON src.id = e.from_id
    LEFT JOIN main.brain_page_nodes dst ON dst.id = e.to_id
    LEFT JOIN main.tasks_tasks task_source
      ON e.edge_type = 'task_touches_symbol' AND e.from_id = 'task:' || task_source.id
    LEFT JOIN main.nexus_nodes code_target
      ON e.edge_type IN ('code_reference', 'task_touches_symbol', 'mentions', 'documents', 'conduit_mentions_symbol') AND code_target.id = e.to_id
    LEFT JOIN main.nexus_nodes code_source
      ON e.edge_type = 'modified_by' AND code_source.id = e.from_id
    WHERE (src.id IS NULL AND task_source.id IS NULL AND code_source.id IS NULL)
       OR (dst.id IS NULL AND code_target.id IS NULL)
    ORDER BY e.from_id, e.to_id
    LIMIT 5
  `)
    .all();
  if (rows.length === 0) return null;
  const count = rows[0]?.total;
  if (typeof count !== 'number') throw new Error('Invalid graph orphan count');
  const samples = rows.map((row) => {
    if (typeof row.id !== 'string') throw new Error('Invalid graph orphan identifier');
    return row.id;
  });
  return {
    pattern: 'orphan-edge',
    count,
    sampleIds: samples,
    description: `${count} brain graph edges have a missing source or target node; inspect backed records before reconstructing derived nodes. Preserve unresolved historical edges.`,
  };
}

/**
 * Run a read-only noise scan over `.cleo/brain.db` and return a structured
 * findings report.
 *
 * This function is intentionally side-effect-free: it opens brain.db in
 * read-only mode (via `getBrainNativeDb`) and only runs SELECT queries.
 * The caller bears responsibility for surfacing or acting on the findings.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns A {@link BrainDoctorResult} describing all detected noise.
 *
 * @example
 * ```typescript
 * const result = await scanBrainNoise('/mnt/projects/cleocode');
 * if (!result.isClean) {
 *   console.warn(`Brain noise detected: ${result.findings.length} patterns`);
 *   for (const f of result.findings) {
 *     console.warn(`  ${f.pattern}: ${f.count} entries — ${f.description}`);
 *   }
 * }
 * ```
 *
 * @task T1262
 * @remarks Structural failures remain explicit; semantic authority is not inferred from structural cleanliness.
 */
export async function scanBrainNoise(projectRoot: string): Promise<BrainDoctorResult> {
  // Initialize brain.db connection (required before getBrainNativeDb() is callable)
  await getBrainDb(projectRoot);
  const db = getBrainNativeDb(projectRoot);
  const findings: BrainNoiseEntry[] = [];
  const errors: string[] = [];

  if (!db) throw new Error('BRAIN database unavailable: structural health was not assessed');

  try {
    // ── 1. Total scanned (union of all typed tables) ────────────────────────
    const tables = ['brain_observations', 'brain_decisions', 'brain_patterns', 'brain_learnings'];
    let totalScanned = 0;
    for (const table of tables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as c FROM main.${table}`).get() as
          | { c: number }
          | undefined;
        totalScanned += row?.c ?? 0;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        // Table may not exist in all installations — skip silently.
      }
    }

    // ── 2. missing-type ─────────────────────────────────────────────────────
    {
      const rows: { id?: string | null }[] = [];
      for (const table of tables.filter((table) => table !== 'brain_learnings')) {
        try {
          const res = db
            .prepare(`SELECT id FROM main.${table} WHERE type IS NULL OR type = '' LIMIT 20`)
            .all() as { id?: string | null }[];
          rows.push(...res);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          // skip
        }
      }
      if (rows.length > 0) {
        findings.push({
          pattern: 'missing-type',
          count: rows.length,
          sampleIds: sampleIds(rows),
          description:
            'Entries with NULL or empty type field — type is required for retrieval routing.',
        });
      }
    }

    // ── 3. missing-provenance ────────────────────────────────────────────────
    {
      const rows: { id?: string | null }[] = [];
      for (const table of tables) {
        try {
          const res = db
            .prepare(`SELECT id FROM main.${table} WHERE provenance_class IS NULL LIMIT 20`)
            .all() as { id?: string | null }[];
          rows.push(...res);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          // skip — provenance column may not exist in all schema versions
        }
      }
      if (rows.length > 0) {
        findings.push({
          pattern: 'missing-provenance',
          count: rows.length,
          sampleIds: sampleIds(rows),
          description:
            'Entries with NULL provenance — source cannot be verified for retrieval integrity.',
        });
      }
    }

    // ── 4. low-confidence ────────────────────────────────────────────────────
    {
      const rows: { id?: string | null }[] = [];
      for (const table of ['brain_learnings']) {
        try {
          const res = db
            .prepare(
              `SELECT id FROM main.${table} WHERE confidence IS NOT NULL AND confidence < ? LIMIT 20`,
            )
            .all(LOW_CONFIDENCE_THRESHOLD) as { id?: string | null }[];
          rows.push(...res);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          // skip — confidence column may not exist
        }
      }
      if (rows.length > 0) {
        findings.push({
          pattern: 'low-confidence',
          count: rows.length,
          sampleIds: sampleIds(rows),
          description: `Entries with confidence < ${LOW_CONFIDENCE_THRESHOLD} — near-zero signal, likely noise.`,
        });
      }
    }

    // ── 5. stale-unverified ──────────────────────────────────────────────────
    {
      const staleThreshold = new Date();
      staleThreshold.setDate(staleThreshold.getDate() - STALE_AGE_DAYS);
      const staleIso = staleThreshold.toISOString();
      const rows: { id?: string | null }[] = [];
      for (const table of tables) {
        try {
          const res = db
            .prepare(
              `SELECT id FROM main.${table}
               WHERE verified = 0
                 AND ${table === 'brain_patterns' ? 'extracted_at' : 'created_at'} < ? AND citation_count = 0
               LIMIT 20`,
            )
            .all(staleIso) as { id?: string | null }[];
          rows.push(...res);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          // skip — schema may differ
        }
      }
      if (rows.length > 0) {
        findings.push({
          pattern: 'stale-unverified',
          count: rows.length,
          sampleIds: sampleIds(rows),
          description: `Unverified entries older than ${STALE_AGE_DAYS} days — likely outdated observations.`,
        });
      }
    }

    // ── 6. duplicate-content ─────────────────────────────────────────────────
    {
      const rows: { id?: string | null }[] = [];
      for (const table of tables) {
        try {
          const res = db
            .prepare(
              `SELECT id FROM main.${table}
               WHERE content_hash IN (
                 SELECT content_hash FROM main.${table}
                 WHERE content_hash IS NOT NULL
                 GROUP BY content_hash HAVING COUNT(*) > 1
               ) LIMIT 20`,
            )
            .all() as { id?: string | null }[];
          rows.push(...res);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          // skip — content column may not exist in all tables
        }
      }
      if (rows.length > 0) {
        findings.push({
          pattern: 'duplicate-content',
          count: rows.length,
          sampleIds: sampleIds(rows),
          description: 'Entries sharing identical content — duplicates inflate retrieval scores.',
        });
      }
    }
    try {
      const orphanFinding = scanBrainGraphOrphans(db);
      if (orphanFinding) findings.push(orphanFinding);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      // brain_edges / brain_nodes may not exist
    }

    // ── 7. Auto-extract pipeline health (T1903) ──────────────────────────────
    const autoExtractHealth = computeAutoExtractHealth(db);

    // ── 8. Provenance distribution (T1897) ───────────────────────────────────
    const provenanceDistribution = computeProvenanceDistribution(db);

    return {
      totalScanned,
      findings,
      isClean: findings.length === 0 && errors.length === 0,
      structure: {
        status: errors.length ? 'failed' : findings.length ? 'findings' : 'clean',
        reasons: [...errors, ...findings.map((finding) => finding.description)],
        evidence: [],
      },
      semantics: {
        status: 'unavailable',
        reasons: [
          'Structural scans do not establish semantic authority; inspect explicit conflicts and sourced replacements.',
        ],
        evidence: [],
      },
      extraction: {
        status: !autoExtractHealth
          ? 'unavailable'
          : autoExtractHealth.healthy
            ? 'clean'
            : 'findings',
        reasons: !autoExtractHealth
          ? ['Extraction metrics could not be assessed.']
          : autoExtractHealth.healthy
            ? []
            : [
                'Extraction production is below the expected ratio; this does not mean the structural scan failed.',
              ],
        evidence: [],
      },
      scannedAt: new Date().toISOString(),
      autoExtractHealth,
      provenanceDistribution,
    };
  } catch (error) {
    throw new Error('BRAIN structural assessment failed', { cause: error });
  }
}

// ============================================================================
// Auto-extract health helpers (T1903)
// ============================================================================

/**
 * Compute auto-extract pipeline health from a live brain.db connection.
 *
 * Queries observation/learning counts plus brain_promotion_log fulfillment stats.
 * Returns undefined when the required tables are not available.
 *
 * @param db - Native database instance from getBrainNativeDb (accepts DatabaseSync or compatible)
 */
function computeAutoExtractHealth(db: unknown): AutoExtractHealth | undefined {
  if (!db) return undefined;
  const nativeDb = db as {
    prepare: (sql: string) => { get: () => unknown; all: (...args: unknown[]) => unknown[] };
  };
  try {
    const obsRow = nativeDb
      .prepare(`SELECT COUNT(*) AS cnt FROM brain_observations WHERE invalid_at IS NULL`)
      .get() as { cnt: number } | undefined;
    const observationCount = obsRow?.cnt ?? 0;

    const lrnRow = nativeDb
      .prepare(`SELECT COUNT(*) AS cnt FROM brain_learnings WHERE invalid_at IS NULL`)
      .get() as { cnt: number } | undefined;
    const learningCount = lrnRow?.cnt ?? 0;

    let pendingPromotions = 0;
    let fulfilledPromotions = 0;
    try {
      const pending = nativeDb
        .prepare(`SELECT COUNT(*) AS cnt FROM brain_promotion_log WHERE fulfilled_at IS NULL`)
        .get() as { cnt: number } | undefined;
      pendingPromotions = pending?.cnt ?? 0;

      const fulfilled = nativeDb
        .prepare(`SELECT COUNT(*) AS cnt FROM brain_promotion_log WHERE fulfilled_at IS NOT NULL`)
        .get() as { cnt: number } | undefined;
      fulfilledPromotions = fulfilled?.cnt ?? 0;
    } catch {
      // brain_promotion_log may not exist or lack fulfilled_at column
    }

    let lastConsolidationAt: string | null = null;
    try {
      const consolRow = nativeDb
        .prepare(
          `SELECT started_at FROM brain_consolidation_events ORDER BY started_at DESC LIMIT 1`,
        )
        .get() as { started_at?: string } | undefined;
      lastConsolidationAt = consolRow?.started_at ?? null;
    } catch {
      // table may not exist
    }

    const extractionRatio = observationCount > 0 ? learningCount / observationCount : 1;
    const healthy = observationCount === 0 || extractionRatio >= 0.01;

    return {
      observationCount,
      learningCount,
      pendingPromotions,
      fulfilledPromotions,
      extractionRatio,
      lastConsolidationAt,
      healthy,
    };
  } catch {
    return undefined;
  }
}

// ============================================================================
// Provenance distribution helpers (T1897)
// ============================================================================

/**
 * Compute provenance distribution counts from brain_observations.
 *
 * Returns counts by origin value, validated_at non-null count, and provenance_chain non-null count.
 * Returns undefined when the columns do not exist (pre-T1897 database).
 */
function computeProvenanceDistribution(db: unknown): ProvenanceDistribution | undefined {
  if (!db) return undefined;
  const nativeDb = db as { prepare: (sql: string) => { all: () => unknown[]; get: () => unknown } };
  try {
    const totalRow = nativeDb
      .prepare(`SELECT COUNT(*) AS cnt FROM brain_observations WHERE invalid_at IS NULL`)
      .get() as { cnt: number } | undefined;
    const total = totalRow?.cnt ?? 0;

    const byOrigin: Record<string, number> = {};
    try {
      const rows = nativeDb
        .prepare(
          `SELECT COALESCE(origin, '__null__') AS origin_val, COUNT(*) AS cnt
           FROM brain_observations WHERE invalid_at IS NULL
           GROUP BY origin_val`,
        )
        .all() as Array<{ origin_val: string; cnt: number }>;
      for (const row of rows) {
        byOrigin[row.origin_val === '__null__' ? '(unset)' : row.origin_val] = row.cnt;
      }
    } catch {
      // origin column not yet added
    }

    let verifiedCount = 0;
    try {
      const vRow = nativeDb
        .prepare(
          `SELECT COUNT(*) AS cnt FROM brain_observations WHERE invalid_at IS NULL AND validated_at IS NOT NULL`,
        )
        .get() as { cnt: number } | undefined;
      verifiedCount = vRow?.cnt ?? 0;
    } catch {
      // validated_at not yet added
    }

    let derivedCount = 0;
    try {
      const dRow = nativeDb
        .prepare(
          `SELECT COUNT(*) AS cnt FROM brain_observations WHERE invalid_at IS NULL AND provenance_chain IS NOT NULL`,
        )
        .get() as { cnt: number } | undefined;
      derivedCount = dRow?.cnt ?? 0;
    } catch {
      // provenance_chain not yet added
    }

    return { total, byOrigin, verifiedCount, derivedCount };
  } catch {
    return undefined;
  }
}
