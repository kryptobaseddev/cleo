/**
 * Brain/Memory domain types for brain.db cognitive memory system.
 *
 * Extracted from inline type definitions in engine-compat.ts to eliminate
 * repeated `{ id: string; type: string; content: string; createdAt: string }` patterns.
 *
 * @task T5800
 */

// ============================================================
// T549: Tiered + Typed Memory Architecture types
// ============================================================

/**
 * Memory retention tier values for the tiered cognitive memory model (T549).
 *
 * - `short`  — Session-scoped working context. Auto-evicted after TTL if not promoted.
 * - `medium` — Project-scoped verified facts. Retained for weeks.
 * - `long`   — Architectural bedrock. Permanent; supersession-only eviction.
 */
export type BrainMemoryTier = 'short' | 'medium' | 'long';

/**
 * Cognitive type taxonomy for brain entries (T549).
 *
 * NOTE: Named `BrainCognitiveType` (not `BrainMemoryType`) to avoid collision
 * with the brain_memory_links entity type enum.
 *
 * - `semantic`   — Declarative facts: brain_decisions, brain_learnings (default)
 * - `episodic`   — Event records: brain_observations, brain_learnings (transcript-derived)
 * - `procedural` — Process knowledge: brain_patterns
 */
export type BrainCognitiveType = 'semantic' | 'episodic' | 'procedural';

/**
 * Source reliability levels for brain entries (T549 §3.1.5).
 *
 * Separate dimension from content `quality_score`. Each level drives a quality
 * multiplier applied at scoring time:
 *
 * | Level         | Quality multiplier |
 * |---------------|--------------------|
 * | `owner`       | 1.0                |
 * | `task-outcome`| 0.90               |
 * | `agent`       | 0.70               |
 * | `speculative` | 0.40               |
 */
export type BrainSourceConfidence = 'owner' | 'task-outcome' | 'agent' | 'speculative';

/** Compact brain entry reference used in contradiction analysis. */
export interface BrainEntryRef {
  /** Brain.db entry identifier. */
  id: string;
  /** Entry type (e.g. `"observation"`, `"learning"`, `"decision"`). */
  type: string;
  /** Full text content of the brain entry. */
  content: string;
  /** ISO 8601 timestamp of when the entry was created. */
  createdAt: string;
}

/** Brain entry reference with summary, used in superseded analysis. */
export interface BrainEntrySummary {
  /** Brain.db entry identifier. */
  id: string;
  /** Entry type (e.g. `"observation"`, `"learning"`, `"decision"`). */
  type: string;
  /** ISO 8601 timestamp of when the entry was created. */
  createdAt: string;
  /** Truncated summary of the entry content. */
  summary: string;
}

/** Contradiction detail between two brain entries. */
export interface ContradictionDetail {
  /** First entry in the contradicting pair. */
  entryA: BrainEntryRef;
  /** Second entry in the contradicting pair. */
  entryB: BrainEntryRef;
  /**
   * Additional context explaining the scope of the contradiction.
   *
   * @defaultValue undefined
   */
  context?: string;
  /** Description of how the two entries conflict. */
  conflictDetails: string;
}

/** Superseded entry pair showing old and replacement entries. */
export interface SupersededEntry {
  /** The older entry that has been superseded. */
  oldEntry: BrainEntrySummary;
  /** The newer entry that replaces the old one. */
  replacement: BrainEntrySummary;
  /** Topic or category grouping these entries together. */
  grouping: string;
}

// ============================================================
// T10303 — Brain.db auto-recovery (Saga T10281 / Epic T10286)
// ============================================================

/**
 * Result of a brain.db auto-recovery attempt.
 *
 * Returned by `recoverMalformedBrainDb()` (T10303) when the chokepoint
 * detects malformation via `ERR_SQLITE_ERROR errcode=11` or a failing
 * `PRAGMA integrity_check`/`PRAGMA quick_check`. The corrupt DB has been
 * moved to a quarantine directory and the freshest validated snapshot has
 * been copied to `.cleo/brain.db`.
 *
 * Consumers (the brain.db open chokepoint, telemetry, the upcoming T10302
 * regression test) read this structure to decide whether to re-attempt the
 * open and to emit user-facing diagnostics with the data-loss window.
 */
export interface BrainRecoveryResult {
  /** Absolute path to the snapshot that was restored, or null if recovery failed. */
  restoredFrom: string | null;
  /**
   * Approximate hours between the snapshot's timestamp and the recovery
   * event. `null` when the snapshot timestamp could not be parsed.
   * Used in the recovery warning to make the data-loss window legible.
   */
  dataLossWindowHours: number | null;
  /**
   * Number of `brain_observations` rows in the restored DB. Best-effort —
   * `null` when the count query failed (table missing, FK violation, …).
   */
  observationsRecovered: number | null;
  /** `true` if the restored DB passes `PRAGMA quick_check`. */
  integrityOK: boolean;
  /**
   * Absolute path to the quarantine directory where the corrupt DB plus
   * its `-wal`/`-shm` sidecars were moved before restore.
   */
  quarantineDir: string | null;
}

// ============================================================
// T10304 — `cleo backup recover brain` CLI verb (Saga T10281 / Epic T10286)
// ============================================================

/**
 * Per-table row counts probed from the restored brain.db.
 *
 * Best-effort — any individual count may be `null` when the table is
 * missing (very old snapshot predating that schema rev) or when the count
 * query throws. The values feed both the `cleo backup recover brain`
 * envelope and the recovery runbook's user-facing diagnostics.
 *
 * @task T10304
 * @epic T10286
 * @saga T10281
 */
export interface BrainRecoveredRowCounts {
  /** `brain_observations` row count, or `null` when the count failed. */
  observations: number | null;
  /** `brain_decisions` row count, or `null` when the count failed. */
  decisions: number | null;
  /** `brain_learnings` row count, or `null` when the count failed. */
  learnings: number | null;
}

/**
 * Envelope payload returned by `cleo backup recover brain`.
 *
 * The CLI verb (T10304) wraps {@link BrainRecoveryResult} from
 * {@link recoverMalformedBrainDb} (T10303) and enriches it with per-table
 * row counts plus the operator-friendly snapshot/quarantine paths required
 * by the AC envelope shape.
 *
 * Surfaces:
 * - `--dry-run` plan envelopes (with `restoredFrom` being the snapshot that
 *   *would* be restored and `quarantinedTo` being the directory the corrupt
 *   DB *would* be moved to).
 * - Real-recovery envelopes after the pipeline has executed.
 *
 * @task T10304
 * @epic T10286
 * @saga T10281
 */
export interface BackupRecoverBrainResult {
  /**
   * Absolute path to the snapshot that was (or would be) restored. Empty
   * string when no snapshot was available — the envelope's caller surfaces
   * that as a failure mode.
   */
  restoredFrom: string;
  /** Per-table row counts probed from the restored DB. */
  rowsRecovered: BrainRecoveredRowCounts;
  /**
   * Approximate hours between the snapshot's timestamp and the recovery
   * event. `null` when the snapshot timestamp could not be parsed (e.g.
   * legacy `brain.db.PRE-DUP-FIX-*` fallback artifact).
   */
  dataLossWindowHours: number | null;
  /** `true` when the restored DB passes `PRAGMA quick_check`. */
  integrityOK: boolean;
  /**
   * Absolute path to the quarantine directory where the corrupt DB plus
   * its `-wal`/`-shm` sidecars were moved. Empty string in `--dry-run`
   * mode where no files were touched.
   */
  quarantinedTo: string;
  /**
   * `true` when invoked with `--dry-run` — indicates the envelope is a
   * plan, NOT a record of mutations performed. Consumers MUST check this
   * before treating `restoredFrom` as a post-condition.
   */
  dryRun: boolean;
}
