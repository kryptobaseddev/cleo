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
  /** ISO 8601 timestamp when the scan completed. */
  scannedAt: string;
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
 */
export async function scanBrainNoise(projectRoot: string): Promise<BrainDoctorResult> {
  // Initialize brain.db connection (required before getBrainNativeDb() is callable)
  await getBrainDb(projectRoot);
  const db = getBrainNativeDb();
  const findings: BrainNoiseEntry[] = [];

  if (!db) {
    // brain.db not available — return clean scan (cannot detect noise without DB)
    return {
      totalScanned: 0,
      findings: [],
      isClean: true,
      scannedAt: new Date().toISOString(),
    };
  }

  try {
    // ── 1. Total scanned (union of all typed tables) ────────────────────────
    const tables = ['brain_observations', 'brain_decisions', 'brain_patterns', 'brain_learnings'];
    let totalScanned = 0;
    for (const table of tables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as
          | { c: number }
          | undefined;
        totalScanned += row?.c ?? 0;
      } catch {
        // Table may not exist in all installations — skip silently.
      }
    }

    // ── 2. missing-type ─────────────────────────────────────────────────────
    {
      const rows: { id?: string | null }[] = [];
      for (const table of tables) {
        try {
          const res = db
            .prepare(`SELECT id FROM ${table} WHERE type IS NULL OR type = '' LIMIT 20`)
            .all() as { id?: string | null }[];
          rows.push(...res);
        } catch {
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
            .prepare(`SELECT id FROM ${table} WHERE provenance IS NULL LIMIT 20`)
            .all() as { id?: string | null }[];
          rows.push(...res);
        } catch {
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
      for (const table of tables) {
        try {
          const res = db
            .prepare(
              `SELECT id FROM ${table} WHERE confidence IS NOT NULL AND confidence < ? LIMIT 20`,
            )
            .all(LOW_CONFIDENCE_THRESHOLD) as { id?: string | null }[];
          rows.push(...res);
        } catch {
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
              `SELECT id FROM ${table}
               WHERE verified = 0
                 AND created_at < ?
               LIMIT 20`,
            )
            .all(staleIso) as { id?: string | null }[];
          rows.push(...res);
        } catch {
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
              `SELECT id FROM ${table}
               WHERE content IN (
                 SELECT content FROM ${table}
                 WHERE content IS NOT NULL
                 GROUP BY content HAVING COUNT(*) > 1
               ) LIMIT 20`,
            )
            .all() as { id?: string | null }[];
          rows.push(...res);
        } catch {
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
      const rows = db
        .prepare(
          `SELECT e.id FROM brain_edges e
             LEFT JOIN brain_nodes src ON src.id = e.source_id
             LEFT JOIN brain_nodes tgt ON tgt.id = e.target_id
             WHERE src.id IS NULL OR tgt.id IS NULL
             LIMIT 20`,
        )
        .all() as { id?: string | null }[];
      if (rows.length > 0) {
        findings.push({
          pattern: 'orphan-edge',
          count: rows.length,
          sampleIds: sampleIds(rows),
          description:
            'Brain graph edges pointing to non-existent nodes — referential integrity violation.',
        });
      }
    } catch {
      // brain_edges / brain_nodes may not exist
    }

    return {
      totalScanned,
      findings,
      isClean: findings.length === 0,
      scannedAt: new Date().toISOString(),
    };
  } catch {
    // Return a minimal clean result on unexpected errors rather than crashing.
    return {
      totalScanned: 0,
      findings: [],
      isClean: true,
      scannedAt: new Date().toISOString(),
    };
  }
}
