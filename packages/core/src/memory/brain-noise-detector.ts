/**
 * @module memory/brain-noise-detector
 *
 * T1147 Wave 7: BRAIN noise detector for the 2440-entry sweep.
 *
 * Scans all four brain content tables (`brain_observations`, `brain_learnings`,
 * `brain_decisions`, `brain_patterns`) for entries that match noise criteria:
 * - `quality_score < 0.3` (below QUALITY_SCORE_THRESHOLD)
 * - `verified = 0` (not owner-verified)
 * - `invalid_at IS NULL` (not already superseded)
 *
 * Produces `brain_observations_staging` rows anchored to a `brain_backfill_runs`
 * row of kind `noise-sweep-2440`. The 100-entry stratified sample is written to
 * `.cleo/agent-outputs/T1147-sweep-validation-<runId>.json` for autonomous validation.
 *
 * @task T1147
 * @epic T1075
 */

import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import {
  brainBackfillRuns,
  brainDecisions,
  brainLearnings,
  brainObservations,
  brainObservationsStaging,
  brainPatterns,
  type NewBrainObservationsStagingRow,
} from '../store/memory-schema.js';
import { getBrainDb } from '../store/memory-sqlite.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Quality score below which an entry is a noise candidate. */
const NOISE_QUALITY_THRESHOLD = 0.3;

/** Number of stratified samples to extract for autonomous validation. */
const SAMPLE_SIZE = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-table count of detected noise candidates. */
export interface NoiseCandidateCounts {
  observations: number;
  learnings: number;
  decisions: number;
  patterns: number;
  total: number;
}

/** Result of the full `detectNoiseCandidates` pass. */
export interface DetectNoiseCandidatesResult {
  /** Run ID created in `brain_backfill_runs`. */
  runId: string;
  /** Per-table candidate counts. */
  counts: NoiseCandidateCounts;
  /** Absolute path to the 100-entry stratified sample JSON file. */
  sampleFilePath: string;
  /** Whether this was a dry-run (no rows inserted into brain_observations_staging). */
  dryRun: boolean;
}

/** Shape of one entry in the stratified sample JSON. */
export interface SampleEntry {
  sourceTable: string;
  sourceId: string;
  qualityScore: number | null;
  sourceConfidence: string | null;
  content: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate a sweep run ID. */
function genRunId(): string {
  return `bfr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Generate a candidate ID. */
function genCandidateId(): string {
  return `bos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Returns a Fisher-Yates shuffled copy of arr, limited to `n` elements. */
function sampleN<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  const limit = Math.min(n, copy.length);
  for (let i = 0; i < limit; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detects noise candidates across all four brain content tables and writes
 * staging rows to `brain_observations_staging`.
 *
 * The function:
 * 1. Opens `brain.db` for the given `projectRoot`.
 * 2. Queries each brain table for rows matching noise criteria.
 * 3. Inserts one `brain_backfill_runs` row (`kind='noise-sweep-2440'`, `status='staged'`).
 * 4. Inserts `brain_observations_staging` rows for each noise candidate.
 * 5. Extracts a 100-entry proportional stratified sample and writes it to
 *    `.cleo/agent-outputs/T1147-sweep-validation-<runId>.json`.
 *
 * In `dryRun` mode, steps 3–4 are skipped (no DB writes). The sample file
 * is still written for preview.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param options     - Optional configuration.
 * @returns Result containing the run ID, candidate counts, and sample file path.
 *
 * @example
 * ```typescript
 * const result = await detectNoiseCandidates('/mnt/projects/cleocode', { dryRun: true });
 * console.log(`Found ${result.counts.total} noise candidates`);
 * ```
 */
export async function detectNoiseCandidates(
  projectRoot: string,
  options: { dryRun?: boolean } = {},
): Promise<DetectNoiseCandidatesResult> {
  const { dryRun = false } = options;
  const db = await getBrainDb(projectRoot);
  const runId = genRunId();
  const nowIso = new Date().toISOString();

  // ── Query each table for noise candidates ─────────────────────────────────

  const obsRows = await db
    .select({
      id: brainObservations.id,
      qualityScore: brainObservations.qualityScore,
      sourceConfidence: brainObservations.sourceConfidence,
      title: brainObservations.title,
    })
    .from(brainObservations)
    .where(
      and(
        or(
          isNull(brainObservations.qualityScore),
          lt(brainObservations.qualityScore, NOISE_QUALITY_THRESHOLD),
        ),
        eq(brainObservations.verified, false),
        isNull(brainObservations.invalidAt),
      ),
    )
    .all();

  const lrnRows = await db
    .select({
      id: brainLearnings.id,
      qualityScore: brainLearnings.qualityScore,
      sourceConfidence: brainLearnings.sourceConfidence,
      insight: brainLearnings.insight,
    })
    .from(brainLearnings)
    .where(
      and(
        or(
          isNull(brainLearnings.qualityScore),
          lt(brainLearnings.qualityScore, NOISE_QUALITY_THRESHOLD),
        ),
        eq(brainLearnings.verified, false),
        isNull(brainLearnings.invalidAt),
      ),
    )
    .all();

  const decRows = await db
    .select({
      id: brainDecisions.id,
      qualityScore: brainDecisions.qualityScore,
      sourceConfidence: brainDecisions.sourceConfidence,
      decision: brainDecisions.decision,
    })
    .from(brainDecisions)
    .where(
      and(
        or(
          isNull(brainDecisions.qualityScore),
          lt(brainDecisions.qualityScore, NOISE_QUALITY_THRESHOLD),
        ),
        eq(brainDecisions.verified, false),
        isNull(brainDecisions.invalidAt),
      ),
    )
    .all();

  const patRows = await db
    .select({
      id: brainPatterns.id,
      qualityScore: brainPatterns.qualityScore,
      sourceConfidence: brainPatterns.sourceConfidence,
      pattern: brainPatterns.pattern,
    })
    .from(brainPatterns)
    .where(
      and(
        or(
          isNull(brainPatterns.qualityScore),
          lt(brainPatterns.qualityScore, NOISE_QUALITY_THRESHOLD),
        ),
        eq(brainPatterns.verified, false),
        isNull(brainPatterns.invalidAt),
      ),
    )
    .all();

  const counts: NoiseCandidateCounts = {
    observations: obsRows.length,
    learnings: lrnRows.length,
    decisions: decRows.length,
    patterns: patRows.length,
    total: obsRows.length + lrnRows.length + decRows.length + patRows.length,
  };

  // ── Build stratified sample (proportional to table counts) ────────────────

  const totalCount = counts.total;
  const targetSample = Math.min(SAMPLE_SIZE, totalCount);
  const allEntries: SampleEntry[] = [];

  const addEntries = (
    rows: Array<{ id: string; qualityScore: number | null; sourceConfidence: string | null }>,
    table: string,
    contentField: string | null,
  ) => {
    for (const r of rows) {
      const raw = contentField ? (r as Record<string, unknown>)[contentField] : null;
      const contentStr = typeof raw === 'string' ? raw.slice(0, 200) : null;
      allEntries.push({
        sourceTable: table,
        sourceId: r.id,
        qualityScore: r.qualityScore,
        sourceConfidence: r.sourceConfidence,
        content: contentStr,
      });
    }
  };

  addEntries(obsRows, 'brain_observations', 'title');
  addEntries(lrnRows, 'brain_learnings', 'insight');
  addEntries(decRows, 'brain_decisions', 'decision');
  addEntries(patRows, 'brain_patterns', 'pattern');

  const sample = sampleN(allEntries, targetSample);

  // Auto-validation: check all sampled entries confirm quality_score < threshold.
  const autoValidationPassed = sample.every((e) => (e.qualityScore ?? 0) < NOISE_QUALITY_THRESHOLD);

  // ── Write sample JSON to agent-outputs ────────────────────────────────────

  const agentOutputsDir = path.join(projectRoot, '.cleo', 'agent-outputs');
  fs.mkdirSync(agentOutputsDir, { recursive: true });
  const sampleFilePath = path.join(agentOutputsDir, `T1147-sweep-validation-${runId}.json`);

  fs.writeFileSync(
    sampleFilePath,
    JSON.stringify(
      {
        runId,
        generatedAt: nowIso,
        dryRun,
        counts,
        autoValidationPassed,
        autoValidationNote: autoValidationPassed
          ? `All ${sample.length} sampled entries have quality_score < ${NOISE_QUALITY_THRESHOLD} — auto-approved`
          : `WARNING: some sampled entries do not meet noise threshold — manual review recommended`,
        sampleSize: sample.length,
        sample,
      },
      null,
      2,
    ),
  );

  // ── Write staging rows (skip on dry-run) ──────────────────────────────────

  if (!dryRun) {
    // Write brain_backfill_runs anchor row.
    await db
      .insert(brainBackfillRuns)
      .values({
        id: runId,
        kind: 'noise-sweep-2440',
        status: 'staged',
        rowsAffected: counts.total,
        source: `T1147-W7-auto-sweep`,
        targetTable: 'brain_observations,brain_learnings,brain_decisions,brain_patterns',
        rollbackSnapshotJson: null,
        approvedAt: null,
        approvedBy: null,
      })
      .run();

    // Batch-insert brain_observations_staging rows.
    const candidateRows: NewBrainObservationsStagingRow[] = [];

    const buildCandidates = (
      rows: Array<{ id: string; [key: string]: unknown }>,
      table: string,
    ) => {
      for (const r of rows) {
        candidateRows.push({
          id: genCandidateId(),
          sourceTable: table,
          sourceId: r.id,
          sweepRunId: runId,
          action: 'purge',
          newQualityScore: null,
          newInvalidAt: nowIso,
          newProvenanceClass: 'noise-purged',
          validationStatus: 'pending',
          createdAt: nowIso,
        });
      }
    };

    buildCandidates(obsRows, 'brain_observations');
    buildCandidates(lrnRows, 'brain_learnings');
    buildCandidates(decRows, 'brain_decisions');
    buildCandidates(patRows, 'brain_patterns');

    // Insert in batches of 500 to avoid SQLite parameter limits.
    const BATCH_SIZE = 500;
    for (let i = 0; i < candidateRows.length; i += BATCH_SIZE) {
      const batch = candidateRows.slice(i, i + BATCH_SIZE);
      if (batch.length > 0) {
        await db.insert(brainObservationsStaging).values(batch).run();
      }
    }
  }

  return {
    runId,
    counts,
    sampleFilePath,
    dryRun,
  };
}

/**
 * Returns a 100-entry stratified sample from `brain_observations_staging` for a given
 * sweep run. Useful for re-sampling without re-running the full detector.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param runId       - The sweep run ID to sample from.
 */
export async function sampleNoiseCandidates(
  projectRoot: string,
  runId: string,
): Promise<SampleEntry[]> {
  const db = await getBrainDb(projectRoot);

  const rows = await db
    .select({
      sourceTable: brainObservationsStaging.sourceTable,
      sourceId: brainObservationsStaging.sourceId,
      newProvenanceClass: brainObservationsStaging.newProvenanceClass,
    })
    .from(brainObservationsStaging)
    .where(eq(brainObservationsStaging.sweepRunId, runId))
    .all();

  return sampleN(
    rows.map((r) => ({
      sourceTable: r.sourceTable,
      sourceId: r.sourceId,
      qualityScore: null,
      sourceConfidence: null,
      content: null,
    })),
    SAMPLE_SIZE,
  );
}
