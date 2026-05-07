/**
 * Lead-tier roll-up contract — used by Phase Lead orchestrators to aggregate
 * Worker status across a single wave of an epic, and surface a unified view
 * back to the top-level Orchestrator (T9082, ADR-070).
 *
 * The contract is engine-neutral and source-of-truth-agnostic: it can be
 * computed from the SQLite `pipeline_manifest` table, from conduit topic
 * messages (`epic-<TID>.wave-<n>.status`), or from a hybrid of both.
 *
 * @task T9082
 * @adr ADR-070
 */

import type { TaskVerification, VerificationGate } from './task.js';

/** A single evidence atom keyed by its kind. */
export interface RollupEvidenceAtom {
  /** The kind of evidence atom (commit, files, tool, test-run, url, note). */
  kind: 'commit' | 'files' | 'tool' | 'test-run' | 'url' | 'note';
  /** The raw atom payload. Shape depends on `kind`. */
  payload: string;
}

/** Per-worker summary row used by the orchestrator to triage a wave. */
export interface RollupWorker {
  /** Task ID owned by this worker (matches `Task.id`). */
  taskId: string;
  /** Task title for human-readable display. */
  title: string;
  /** Lifecycle status pulled from the task row. */
  status: 'pending' | 'active' | 'blocked' | 'done' | 'cancelled' | 'archived' | 'proposed';
  /** Per-gate state from the task verification record. */
  gates: Partial<Record<VerificationGate, boolean | null>>;
  /** Whether the verification record marks all required gates passed. */
  verificationPassed: boolean;
  /** Latest evidence atoms recorded against this task. */
  evidence: RollupEvidenceAtom[];
  /** Manifest entry id (if any) of the most recent worker self-report. */
  latestManifestEntry: string | null;
  /** Most-recent manifest entry status (`complete | partial | blocked | active`). */
  latestManifestStatus: string | null;
  /** ISO timestamp of the most recent manifest entry, or null. */
  latestManifestAt: string | null;
}

/** A blocker preventing the wave from advancing. */
export interface RollupBlocker {
  /** Affected task. */
  taskId: string;
  /** Short reason — one of: `unmet-deps`, `gate-failure`, `manifest-missing`,
   *  `evidence-stale`, `manual-block`. */
  reason:
    | 'unmet-deps'
    | 'gate-failure'
    | 'manifest-missing'
    | 'evidence-stale'
    | 'manual-block';
  /** Human-readable detail. */
  detail: string;
}

/**
 * Roll-up of all workers in a single wave of an epic.
 *
 * Produced by `rollupWaveStatus(epicId, waveId)` in
 * `@cleocode/core/orchestration`. The Orchestrator reads only this single
 * shape per wave, instead of N raw worker outputs.
 */
export interface WaveRollup {
  /** Epic this wave belongs to. */
  epicId: string;
  /** Wave number (0 = first wave; matches `cleo deps waves` output). */
  waveId: number;
  /** Per-worker summary rows. */
  workers: RollupWorker[];
  /** Aggregated blockers. Empty array when the wave is fully ready to advance. */
  blockers: RollupBlocker[];
  /** True iff every worker in the wave has `verificationPassed=true`. */
  readyToAdvance: boolean;
  /** ISO timestamp at which this rollup was computed. */
  capturedAt: string;
}

/**
 * Roll-up keyed by epic, summarising every wave at once. Returned by
 * `rollupEpicStatus(epicId)`.
 */
export interface EpicRollup {
  /** Epic this rollup describes. */
  epicId: string;
  /** Per-wave summaries, ordered by waveId asc. */
  waves: WaveRollup[];
  /** Total worker count across all waves. */
  totalWorkers: number;
  /** Workers with verificationPassed=true. */
  doneWorkers: number;
  /** ISO timestamp at which this rollup was computed. */
  capturedAt: string;
}

/**
 * Re-export the verification shape so consumers don't have to import it
 * separately.
 */
export type { TaskVerification, VerificationGate };
