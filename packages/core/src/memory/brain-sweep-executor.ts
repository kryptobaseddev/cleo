/**
 * @module memory/brain-sweep-executor
 *
 * T1147 Wave 7: BRAIN noise sweep executor.
 *
 * Applies the actions staged in `brain_observations_staging` (produced by W7-3
 * `detectNoiseCandidates`) to the live brain tables, inside a single
 * SQLite transaction. The transaction is fenced by a Sentient self-healing
 * gate (Option A): the existing `killSwitch` field in `.cleo/sentient-state.json`
 * is toggled to `true` before the tx begins, and restored to `false` on both
 * commit and rollback.
 *
 * Self-healing gate semantics:
 * - Before tx: read existing `sentient-state.json`, save original `killSwitch` value.
 * - Write `{ ...existing, killSwitch: true, sweepGateActive: true, sweepRunId: <id> }`.
 * - Open cutover tx: apply updates + deletes to live tables.
 * - Commit/rollback: write `{ ...existing, killSwitch: originalKillSwitch, sweepGateActive: false }`.
 *
 * Note: This temporarily co-opts `killSwitch` semantics for sweep gating. A
 * future cleanup (T1148 W8) should add a dedicated `sweepLock` field (Option B)
 * and teach the Sentient v1 daemon to check it separately.
 *
 * WAL deadlock mitigation:
 * - `PRAGMA busy_timeout = 10000` is set before the cutover tx.
 * - Document: sweep should not run while a CLEO session is active (session-end
 *   hook triggers `runConsolidation` which also writes to brain.db).
 *
 * Vector sync:
 * - W7-4 does NOT trigger `populateEmbeddings` during sweep (OOM risk on 2440+ entries).
 * - For `purge` actions, entries are logically invalidated (invalid_at set); their
 *   `brain_embeddings` rows are left orphaned. A separate optional post-sweep step
 *   (`cleo memory sweep --rebuild-embeddings`) should clean them up.
 *
 * @task T1147
 * @epic T1075
 */

import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { brainBackfillRuns, brainObservationsStaging } from '../store/memory-schema.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SQLite busy timeout in milliseconds for the cutover transaction. */
const BUSY_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the sweep executor. */
export interface SweepExecutorOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** The run ID to approve (`brain_backfill_runs.id` of kind `noise-sweep-2440`). */
  runId: string;
  /** Identity of the approver (agent ID or 'autonomous'). */
  approvedBy?: string;
}

/** Result of the sweep executor. */
export interface SweepExecutorResult {
  /** Run ID that was applied. */
  runId: string;
  /** Total candidates processed. */
  totalCandidates: number;
  /** Number of entries that had `invalid_at` set (`purge` action). */
  purged: number;
  /** Number of entries that had `provenance_class` set to `swept-clean`. */
  kept: number;
  /** Number of entries skipped (already invalidated or not found). */
  skipped: number;
  /** Whether the run completed successfully. */
  success: boolean;
  /** Error message if `success === false`. */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Self-healing gate (Option A)
// ---------------------------------------------------------------------------

/** Shape of `.cleo/sentient-state.json`. */
interface SentientState {
  killSwitch?: boolean;
  sweepGateActive?: boolean;
  sweepRunId?: string;
  [key: string]: unknown;
}

/**
 * Reads `.cleo/sentient-state.json`, returning an empty object if absent.
 */
function readSentientState(projectRoot: string): SentientState {
  const statePath = path.join(projectRoot, '.cleo', 'sentient-state.json');
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw) as SentientState;
  } catch {
    return {};
  }
}

/**
 * Writes `.cleo/sentient-state.json`, creating parent directories if needed.
 */
function writeSentientState(projectRoot: string, state: SentientState): void {
  const statePath = path.join(projectRoot, '.cleo', 'sentient-state.json');
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Enables the sweep gate (sets `killSwitch: true` + `sweepGateActive: true`).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param runId       - The sweep run ID being processed.
 * @returns Original `killSwitch` value before gating (for restore on cleanup).
 */
function enableSweepGate(projectRoot: string, runId: string): boolean {
  const existing = readSentientState(projectRoot);
  const originalKillSwitch = existing.killSwitch === true;
  writeSentientState(projectRoot, {
    ...existing,
    killSwitch: true,
    sweepGateActive: true,
    sweepRunId: runId,
  });
  return originalKillSwitch;
}

/**
 * Restores the sweep gate (sets `killSwitch` back to its pre-sweep value,
 * clears `sweepGateActive` and `sweepRunId`).
 *
 * Called on both commit and rollback paths.
 *
 * @param projectRoot            - Absolute path to the project root.
 * @param originalKillSwitch     - Original `killSwitch` value before sweep started.
 */
function restoreSweepGate(projectRoot: string, originalKillSwitch: boolean): void {
  try {
    const existing = readSentientState(projectRoot);
    writeSentientState(projectRoot, {
      ...existing,
      killSwitch: originalKillSwitch,
      sweepGateActive: false,
      sweepRunId: undefined,
    });
  } catch (err) {
    console.warn('[sweep-executor] Failed to restore sentient-state.json:', err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Applies the sweep actions from `brain_observations_staging` to the live brain tables.
 *
 * The execution flow:
 * 1. Verify the run exists in `brain_backfill_runs` with status `staged`.
 * 2. Load all `brain_observations_staging` rows for this run.
 * 3. Enable the self-healing gate (killSwitch → true).
 * 4. Set `PRAGMA busy_timeout = 10000` via the native DB handle.
 * 5. Open a single SQLite transaction:
 *    a. For `purge` rows: `UPDATE <table> SET invalid_at = ?, provenance_class = 'noise-purged'`.
 *    b. For `keep`/`reclassify`/`promote` rows: `UPDATE <table> SET provenance_class = 'swept-clean' [, quality_score = ?]`.
 *    c. Mark each candidate as `applied` or `skipped` in `brain_observations_staging`.
 *    d. Update `brain_backfill_runs.status = 'approved'` + `approved_at` + `approved_by`.
 * 6. Commit tx → restore sweep gate.
 * 7. On any error → rollback tx (implicit via exception) → restore sweep gate.
 *
 * @param options - Executor options including projectRoot, runId, and approvedBy.
 * @returns Result summary of the sweep execution.
 *
 * @example
 * ```typescript
 * const result = await executeSweep({
 *   projectRoot: '/mnt/projects/cleocode',
 *   runId: 'bfr-abc123-xyz789',
 *   approvedBy: 'autonomous',
 * });
 * console.log(`Purged: ${result.purged}, Kept: ${result.kept}`);
 * ```
 */
export async function executeSweep(options: SweepExecutorOptions): Promise<SweepExecutorResult> {
  const { projectRoot, runId, approvedBy = 'autonomous' } = options;

  const db = await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  // ── Step 1: Verify the run exists and is in staged status ─────────────────

  const run = await db
    .select({
      id: brainBackfillRuns.id,
      status: brainBackfillRuns.status,
      kind: brainBackfillRuns.kind,
    })
    .from(brainBackfillRuns)
    .where(eq(brainBackfillRuns.id, runId))
    .get();

  if (!run) {
    return {
      runId,
      totalCandidates: 0,
      purged: 0,
      kept: 0,
      skipped: 0,
      success: false,
      errorMessage: `Run '${runId}' not found in brain_backfill_runs`,
    };
  }

  if (run.status !== 'staged') {
    return {
      runId,
      totalCandidates: 0,
      purged: 0,
      kept: 0,
      skipped: 0,
      success: false,
      errorMessage: `Run '${runId}' has status '${run.status}' — only 'staged' runs can be approved`,
    };
  }

  // ── Step 2: Load all candidates for this run ──────────────────────────────

  const candidates = await db
    .select()
    .from(brainObservationsStaging)
    .where(
      and(
        eq(brainObservationsStaging.sweepRunId, runId),
        eq(brainObservationsStaging.validationStatus, 'pending'),
      ),
    )
    .all();

  if (candidates.length === 0) {
    return {
      runId,
      totalCandidates: 0,
      purged: 0,
      kept: 0,
      skipped: 0,
      success: false,
      errorMessage: `No pending candidates found for run '${runId}'`,
    };
  }

  // ── Step 3: Enable self-healing gate ──────────────────────────────────────

  const originalKillSwitch = enableSweepGate(projectRoot, runId);

  // ── Step 4: Set SQLite busy_timeout ───────────────────────────────────────

  if (nativeDb) {
    try {
      nativeDb.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    } catch {
      // Non-fatal: proceed without guarantee of busy timeout.
    }
  }

  // ── Step 5: Cutover transaction ───────────────────────────────────────────

  let purged = 0;
  let kept = 0;
  let skipped = 0;
  const nowIso = new Date().toISOString();

  try {
    // Group candidates by table for bulk processing.
    const byTable = new Map<string, typeof candidates>();
    for (const c of candidates) {
      const arr = byTable.get(c.sourceTable) ?? [];
      arr.push(c);
      byTable.set(c.sourceTable, arr);
    }

    // Execute each table's updates using the native DB for sync transaction control.
    // Drizzle SQLite (node:sqlite driver) requires synchronous transaction callbacks.
    // We use the native DatabaseSync handle directly for the cutover tx to avoid
    // the async-in-sync restriction.
    if (!nativeDb) {
      throw new Error('Native brain.db handle unavailable — cannot execute sweep transaction');
    }

    const BATCH = 200;

    const bulkUpdate = (tableName: string, ids: string[], setClause: string): number => {
      let total = 0;
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const placeholders = batch.map(() => '?').join(',');
        const stmt = nativeDb.prepare(
          `UPDATE ${tableName} SET ${setClause} WHERE id IN (${placeholders})`,
        );
        const result = stmt.run(...batch) as { changes: number };
        total += result.changes;
      }
      return total;
    };

    // Run everything inside a native SQLite transaction.
    const commitTx = () => nativeDb.exec('COMMIT');
    const rollbackTx = () => {
      try {
        nativeDb.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
    };

    nativeDb.exec('BEGIN');

    try {
      for (const [tableName, rows] of byTable.entries()) {
        const purgeIds = rows.filter((r) => r.action === 'purge').map((r) => r.sourceId);
        const keepIds = rows.filter((r) => r.action !== 'purge').map((r) => r.sourceId);

        if (purgeIds.length > 0) {
          const count = bulkUpdate(
            tableName,
            purgeIds,
            `invalid_at = '${nowIso}', provenance_class = 'noise-purged'`,
          );
          purged += count;
          skipped += purgeIds.length - count;
        }

        if (keepIds.length > 0) {
          const count = bulkUpdate(tableName, keepIds, `provenance_class = 'swept-clean'`);
          kept += count;
          skipped += keepIds.length - count;
        }
      }

      // Mark all candidates as applied
      const allCandidateIds = candidates.map((c) => c.id);
      for (let i = 0; i < allCandidateIds.length; i += BATCH) {
        const batch = allCandidateIds.slice(i, i + BATCH);
        const placeholders = batch.map(() => '?').join(',');
        nativeDb
          .prepare(
            `UPDATE brain_observations_staging SET validation_status = 'applied' WHERE id IN (${placeholders})`,
          )
          .run(...batch);
      }

      // Update brain_backfill_runs to approved
      nativeDb
        .prepare(
          `UPDATE brain_backfill_runs SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?`,
        )
        .run(nowIso, approvedBy, runId);

      commitTx();
    } catch (txErr) {
      rollbackTx();
      throw txErr;
    }

    // ── Commit succeeded: restore gate ──────────────────────────────────────
    restoreSweepGate(projectRoot, originalKillSwitch);

    return {
      runId,
      totalCandidates: candidates.length,
      purged,
      kept,
      skipped,
      success: true,
    };
  } catch (err) {
    // ── Rollback: restore gate ───────────────────────────────────────────────
    restoreSweepGate(projectRoot, originalKillSwitch);

    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[sweep-executor] Sweep transaction failed:', errorMessage);

    // Mark run as rolled-back
    try {
      await db
        .update(brainBackfillRuns)
        .set({ status: 'rolled-back' })
        .where(eq(brainBackfillRuns.id, runId))
        .run();
    } catch (innerErr) {
      console.warn('[sweep-executor] Failed to mark run as rolled-back:', innerErr);
    }

    return {
      runId,
      totalCandidates: candidates.length,
      purged,
      kept,
      skipped,
      success: false,
      errorMessage,
    };
  }
}

/**
 * Rolls back a staged sweep run without applying any changes.
 *
 * Sets `brain_backfill_runs.status = 'rolled-back'` and marks all pending
 * candidates as `skipped`. Does not toggle the self-healing gate (no tx needed).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param runId       - The run ID to roll back.
 * @returns True if the rollback succeeded, false if the run was not found or
 *          already settled.
 */
export async function rollbackSweep(projectRoot: string, runId: string): Promise<boolean> {
  const db = await getBrainDb(projectRoot);

  const run = await db
    .select({ id: brainBackfillRuns.id, status: brainBackfillRuns.status })
    .from(brainBackfillRuns)
    .where(eq(brainBackfillRuns.id, runId))
    .get();

  if (!run || run.status !== 'staged') {
    return false;
  }

  await db
    .update(brainBackfillRuns)
    .set({ status: 'rolled-back' })
    .where(eq(brainBackfillRuns.id, runId))
    .run();

  // Mark all pending candidates as skipped
  await db
    .update(brainObservationsStaging)
    .set({ validationStatus: 'skipped' })
    .where(
      and(
        eq(brainObservationsStaging.sweepRunId, runId),
        eq(brainObservationsStaging.validationStatus, 'pending'),
      ),
    )
    .run();

  return true;
}
