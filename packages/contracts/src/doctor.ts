/**
 * Doctor domain contracts — types for `cleo doctor` worktree-orphan audit/prune.
 *
 * These types describe orphan `.cleo/` directories left behind under
 * `<projectRoot>/.claude/worktrees/` by the T9550/T9580 SSoT bug (fixed in
 * v2026.5.83) and the schema for the audit JSONL line written per prune.
 *
 * Also contains the comprehensive worktree audit types (T9808) covering:
 *   - Orphan `.cleo/` dirs inside ANY git worktree (not just .claude/worktrees/)
 *   - Worktrees outside the canonical XDG location
 *   - Rogue `.cleo/worktrees/` DIRECTORY (council D009 — only .json sentinel allowed)
 *
 * Consumed by:
 *   - `packages/core/src/doctor/worktree-orphans.ts` (scan + prune primitives)
 *   - `packages/cleo/src/cli/commands/doctor.ts` (CLI flags)
 *
 * @task T9790
 * @task T9808
 * @epic T9790
 * @epic T9808
 */

/**
 * One orphan `.cleo/` directory discovered under
 * `<projectRoot>/.claude/worktrees/`.
 *
 * Worktrees are nested 1-3 levels deep — examples:
 *   - `<projectRoot>/.claude/worktrees/agent-X/.cleo/`            (depth 1)
 *   - `<projectRoot>/.claude/worktrees/agent-X/T9220/.cleo/`     (depth 2)
 *
 * Each entry carries full provenance so the operator can decide whether
 * the orphan represents lost work before pruning.
 */
export interface OrphanEntry {
  /**
   * The worktree root that contains the orphan — the first directory under
   * `.claude/worktrees/` (e.g. `<projectRoot>/.claude/worktrees/agent-X`).
   * Used as the boundary that `pruneWorktreeOrphans` validates against.
   */
  worktreePath: string;

  /**
   * Absolute path to the orphan `.cleo/` directory itself. Always lives
   * under `worktreePath` (the security check rejects anything that doesn't).
   */
  orphanPath: string;

  /**
   * List of `tasks.db`, `brain.db`, `nexus.db`, or `config.json` paths
   * found inside the orphan. Empty array means the orphan exists but is
   * structurally empty (still pruned — it shouldn't be there at all).
   */
  dbFiles: string[];

  /** Total byte size of the orphan tree (sum of regular file sizes). */
  sizeBytes: number;

  /** ISO-8601 timestamp of the most recent file modification under the orphan. */
  lastModifiedAt: string;

  /**
   * Seconds since `lastModifiedAt` (relative to scan time). Surfaces "stale
   * vs recent" without forcing the caller to compute date math.
   */
  ageSeconds: number;

  /**
   * `true` when the orphan contains more than just stray DB files — e.g. a
   * full duplicate of `adrs/`, `agent-outputs/`, `rcasd/`, etc. These need
   * heightened operator review before pruning.
   */
  isFullDuplicate: boolean;
}

/**
 * Result of one prune operation. Reports the archive location, the per-entry
 * outcome, and any entries rejected by the security gate.
 */
export interface PruneResult {
  /**
   * Absolute path to the `.tar.gz` archive written before any deletion.
   * `null` only when `dryRun: true` AND no archive was produced.
   */
  archivePath: string | null;

  /** Whether this was a dry run (no archive, no rm, no audit-log line). */
  dryRun: boolean;

  /** Entries that were successfully pruned (or would be in dry-run mode). */
  pruned: OrphanEntry[];

  /**
   * Entries that failed validation and were skipped. The `reason` is a
   * stable machine-readable code (e.g. `path-outside-worktrees-root`,
   * `path-not-found`, `rm-failed`).
   */
  rejected: Array<{ entry: OrphanEntry; reason: string }>;

  /** Total bytes archived (sum of `pruned[].sizeBytes`). */
  totalSizeBytes: number;

  /** ISO-8601 timestamp the prune completed. */
  prunedAt: string;
}

// ============================================================================
// Comprehensive Worktree Audit (T9808 — council D009)
// ============================================================================

/**
 * Anomaly kinds surfaced by {@link auditWorktreeOrphansComprehensive}.
 *
 * - `orphan-cleo-dir`: a `.cleo/` directory found inside a git worktree path
 *   (any worktree, not just those under `.claude/worktrees/`)
 * - `non-canonical-location`: a worktree exists outside the canonical XDG
 *   path (`~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`)
 * - `rogue-worktrees-directory`: `.cleo/worktrees/` exists as a DIRECTORY
 *   (council D009: only a `.json` sentinel file is permitted there)
 */
export type WorktreeAnomalyKind =
  | 'orphan-cleo-dir'
  | 'non-canonical-location'
  | 'rogue-worktrees-directory';

/**
 * One anomaly surfaced by the comprehensive worktree audit.
 */
export interface WorktreeAnomaly {
  /** Machine-readable anomaly type. */
  kind: WorktreeAnomalyKind;
  /**
   * Absolute path of the affected location.
   * - For `orphan-cleo-dir`: path to the offending `.cleo/` directory.
   * - For `non-canonical-location`: path to the non-canonical worktree root.
   * - For `rogue-worktrees-directory`: path to the `.cleo/worktrees/` directory.
   */
  path: string;
  /** Human-readable description including suggested remediation. */
  description: string;
  /**
   * The git worktree path that triggered this anomaly (from `git worktree list`),
   * or `null` for anomalies not tied to a specific worktree entry.
   */
  worktreePath: string | null;
}

/**
 * Result returned by {@link auditWorktreeOrphansComprehensive}.
 */
export interface ComprehensiveAuditResult {
  /** Absolute path to the project root that was audited. */
  projectRoot: string;
  /** Canonical XDG worktrees root for this project (expected location). */
  canonicalWorktreesRoot: string;
  /** All anomalies detected. Sorted by `kind` then `path`. */
  anomalies: WorktreeAnomaly[];
  /** Total anomaly count. Non-zero triggers exit code 2. */
  count: number;
  /**
   * `true` when the audit was aborted early due to a width budget overflow
   * or a timeout. The `anomalies` list reflects only the entries scanned
   * before the abort — results may be incomplete.
   */
  isPartial?: boolean;
  /**
   * Machine-readable reason the scan was cut short.
   * - `'timeout'`: the configured `timeoutMs` was exceeded.
   * - `'overflow'`: a per-level entry count exceeded `maxEntriesPerLevel`.
   */
  partialReason?: 'timeout' | 'overflow';
}

/**
 * Result shape returned by the budgeted orphan scanner
 * ({@link scanWorktreeOrphansBudgeted}).
 *
 * Wraps the bare `OrphanEntry[]` from `scanWorktreeOrphans` with optional
 * partial-result metadata so callers can surface incomplete scans to the
 * operator without changing the existing `OrphanEntry[]` return type.
 */
export interface OrphanScanResult {
  /** Discovered orphan entries (may be incomplete when `isPartial` is `true`). */
  orphans: OrphanEntry[];
  /**
   * `true` when the scan was aborted before completion due to a budget
   * overflow or timeout. The `orphans` list reflects only entries found
   * before the abort.
   */
  isPartial: boolean;
  /**
   * Machine-readable reason the scan was cut short.
   * - `'timeout'`: the configured `timeoutMs` was exceeded.
   * - `'overflow'`: a per-level entry count exceeded `maxEntriesPerLevel`.
   * `undefined` when `isPartial` is `false`.
   */
  partialReason?: 'timeout' | 'overflow';
  /**
   * Human-readable warning message produced when the soft-warn threshold
   * was crossed (entries per level exceeded `softWarnEntriesPerLevel` but
   * stayed under the hard stop). `undefined` when no warning was triggered.
   */
  softWarnMessage?: string;
}

// ============================================================================
// Saga Hierarchy Audit (T10119 — ADR-073 §1.2 invariant + drift detection)
// ============================================================================

/**
 * Stable invariant identifiers surfaced by the saga hierarchy audit
 * (ADR-073 §1.2). `I5` and `I7` mirror the runtime guards in
 * `packages/core/src/sagas/enforcement.ts`. `depth` covers the I5/I7 depth
 * ladder (saga → member-Epic → Task → Subtask = 3 hops max). `auto-close-drift`
 * is a soft-drift detector (no invariant strictly broken — the saga is
 * structurally valid, but every member is done while the saga still says
 * pending; T10116 fixes the root cause).
 */
export type SagaAuditViolationKind = 'I5' | 'I7' | 'depth' | 'auto-close-drift';

/**
 * One violation surfaced by {@link auditSagaHierarchy}.
 *
 * Each violation is actionable: the `repairCommand` field names the
 * canonical `cleo` invocation an operator should run to resolve it.
 */
export interface SagaAuditViolation {
  /** Stable violation identifier (`I5`, `I7`, `depth`, `auto-close-drift`). */
  kind: SagaAuditViolationKind;
  /** Saga task ID where the violation was detected. */
  sagaId: string;
  /**
   * The offending member task ID. Equal to `sagaId` for I5 violations
   * (the saga row itself is the offender). For I7 violations, the
   * nested-saga candidate. For `auto-close-drift`, equal to `sagaId`.
   */
  offendingId: string;
  /** Human-readable message naming both IDs and the repair command. */
  message: string;
  /** Canonical `cleo` command an operator should run to resolve. */
  repairCommand: string;
}

/**
 * Per-saga audit summary returned by {@link auditSagaHierarchy}.
 *
 * Carries enough context for the doctor CLI to render a one-line summary
 * (`Saga T#### · status=… · 4/5 members done · 0 violations`) without a
 * second database round-trip.
 */
export interface SagaAuditEntry {
  /** Saga task ID. */
  sagaId: string;
  /** Saga title (for human-readable rendering). */
  title: string;
  /** Saga status (`pending`, `active`, `done`, …). */
  status: string;
  /** Total member-Epic count. */
  memberCount: number;
  /** Member-Epics with `status='done'`. */
  doneCount: number;
  /**
   * Violations attributable to this saga. Always returned (possibly
   * empty) so callers can render a stable rows-then-violations layout.
   */
  violations: SagaAuditViolation[];
}

/**
 * Aggregated result returned by {@link auditSagaHierarchy}.
 *
 * `count` is the total number of `I5`/`I7`/`depth` invariant violations
 * across all sagas — the doctor CLI uses this to decide whether to set
 * a non-zero exit code (`auto-close-drift` is a soft warning and does
 * NOT alone trigger exit≠0; tests pass with drift but no I-invariant
 * failure).
 *
 * `driftCount` is the number of `auto-close-drift` warnings (kept
 * separate so CI gates can opt-in to treating drift as failure).
 */
export interface SagaAuditResult {
  /** All sagas audited, sorted by `sagaId` ascending. */
  sagas: SagaAuditEntry[];
  /** Total I5/I7/depth invariant violations across all sagas. */
  count: number;
  /** Total auto-close-drift warnings across all sagas. */
  driftCount: number;
}

// ============================================================================
// DB-Substrate Survey (T10307 — Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10282)
// ============================================================================

/**
 * Per-database substrate-audit findings.
 *
 * Produced by `surveyProjectDbSubstrate` for every entry in the
 * `DB_INVENTORY` SSoT. Fields that depend on the file existing on disk
 * (`integrityOK`, `rowCounts`, `lastWriteMs`, `sizeBytes`) are `null` when
 * the file is missing. `error` is non-null when integrity_check or the
 * open / row-count round-trip threw — corrupt DBs surface here so the
 * envelope's `summary.corrupt` counter increments.
 *
 * `suggestedFix` is a stable, machine-readable repair command (typically
 * `cleo backup recover <role>` — the verb introduced by T10304). Always
 * populated when `integrityOK === false` so the operator has a one-line
 * remediation path.
 *
 * @task T10307
 * @epic T10282
 * @saga T10281
 */
export interface DbSubstrateEntry {
  /** Absolute on-disk path the inventory template resolved to. */
  filePath: string;
  /** `true` iff the file currently exists on disk. */
  exists: boolean;
  /**
   * Result of `PRAGMA integrity_check`. `true` when the pragma returned
   * exactly one `'ok'` row; `false` when it returned anything else or
   * the call threw; `null` when the file did not exist (no integrity
   * check attempted).
   */
  integrityOK: boolean | null;
  /**
   * Row counts for up to 3 representative tables (alphabetically first
   * non-meta tables). `null` when the file is missing or the count
   * round-trip threw.
   */
  rowCounts: Readonly<Record<string, number>> | null;
  /** `fs.statSync(filePath).mtimeMs`, or `null` when the file is missing. */
  lastWriteMs: number | null;
  /** `fs.statSync(filePath).size`, or `null` when the file is missing. */
  sizeBytes: number | null;
  /**
   * Stable error string surfaced from a failed integrity_check or open.
   * `null` when the survey succeeded (including when the file simply
   * does not exist — that is `exists: false`, not an error).
   */
  error: string | null;
  /**
   * Suggested repair command when `integrityOK === false`. `null`
   * otherwise. Typically `cleo backup recover <role>` per T10304.
   */
  suggestedFix: string | null;
  /**
   * Drizzle migration coverage cross-check (T10311). `null` when:
   *   - the inventory entry has `migrationsDir === null` (derived or
   *     reserved roles); OR
   *   - the DB file does not exist; OR
   *   - the DB exists but has no `__drizzle_migrations` table yet (e.g.
   *     reserved opener that never ran migrations).
   *
   * Otherwise carries a populated {@link DbSubstrateMigrationCoverage}
   * with the orphan-row / missing-file diffs.
   *
   * @task T10311
   */
  migrationCoverage: DbSubstrateMigrationCoverage | null;
}

/**
 * One orphan row in `__drizzle_migrations` — a journal entry whose hash
 * does not match any migration file currently on disk for this role.
 *
 * @remarks
 * Orphans indicate one of:
 *  - The DB was last written by a newer CLEO version whose migrations
 *    have since been deleted/renamed; OR
 *  - A hand-edited journal entry (manual SQL bootstrap that bypassed
 *    Drizzle); OR
 *  - A migration file was deleted from disk while its journal row
 *    remained — a charter violation that breaks T9686-class
 *    reconciliation.
 *
 * @task T10311
 */
export interface DbSubstrateMigrationOrphan {
  /** SHA-256 hash recorded in `__drizzle_migrations.hash`. */
  hash: string;
  /**
   * `__drizzle_migrations.created_at` (Drizzle convention: ms-since-epoch
   * derived from the folder timestamp prefix). `null` when the column was
   * present but `NULL`, or the column did not exist on this DB.
   */
  createdAt: number | null;
}

/**
 * One missing-file entry — a migration file present in `migrationsDir`
 * whose hash is NOT recorded in `__drizzle_migrations`.
 *
 * @remarks
 * Missing-file entries indicate the migration has not been applied yet
 * (which is benign for a fresh DB) OR was applied without a journal write
 * (the bug class `reconcileJournal` Scenario 3 was designed to catch).
 *
 * @task T10311
 */
export interface DbSubstrateMigrationMissing {
  /** Migration directory name (e.g. `20260318205539_initial`). */
  name: string;
  /** SHA-256 hash of the migration's `migration.sql` (Drizzle convention). */
  hash: string;
}

/**
 * Per-DB Drizzle migration coverage diff produced by
 * `cleo doctor db-substrate`.
 *
 * @remarks
 * The substrate audit cross-references `__drizzle_migrations` rows (the
 * applied set) with files in `migrationsDir` (the expected set). Both
 * directions are surfaced so operators can distinguish:
 *
 *  - **Orphan rows** (`orphanRows.length > 0`): the DB has applied
 *    migrations that the local checkout does not provide. Risky — a
 *    `reconcileJournal` Scenario 2A signal.
 *  - **Missing files** (`missingFiles.length > 0`): the local checkout
 *    has migrations the DB has not applied. Drizzle's `migrate()` will
 *    pick these up on next open; benign for a fresh DB, suspicious for
 *    a live one.
 *
 * Healthy coverage: `orphanRows.length === 0 && missingFiles.length === 0`
 * AND `applied === expected`.
 *
 * @task T10311
 */
export interface DbSubstrateMigrationCoverage {
  /** Number of rows in `__drizzle_migrations`. */
  applied: number;
  /** Number of migration directories in `migrationsDir`. */
  expected: number;
  /**
   * Rows in `__drizzle_migrations` whose hash does not match any
   * migration file on disk. Always present (may be empty).
   */
  orphanRows: DbSubstrateMigrationOrphan[];
  /**
   * Migration files whose hash is not recorded in
   * `__drizzle_migrations`. Always present (may be empty).
   */
  missingFiles: DbSubstrateMigrationMissing[];
}

/**
 * Warning kinds surfaced by `surveyDbSubstrate` via `envelope.meta.warnings`.
 *
 * @remarks
 * Surfacing as warnings (not violations) means they do NOT drive a
 * non-zero exit code on their own — operators should review and remediate,
 * but the substrate is otherwise healthy.
 *
 * - `orphan-project-root` — a `.cleo/` directory found at a project-PARENT
 *   path (e.g. `/mnt/projects/.cleo/`). Regression class T9550.
 * - `nested-nexus-duplicate` — `~/.local/share/cleo/nexus/{nexus,signaldock}.db`
 *   exists alongside the canonical flat `nexus.db` / `signaldock.db` files,
 *   indicating a structural duplicate from an older XDG-path resolution.
 *
 * @task T10307
 */
export type DbSubstrateWarningKind = 'orphan-project-root' | 'nested-nexus-duplicate';

/**
 * One warning entry surfaced in the envelope's `meta.warnings` list.
 *
 * @task T10307
 * @task T10308 — added `parentWorkspace` for orphan-project-root attribution.
 */
export interface DbSubstrateWarning {
  /** Machine-readable warning class. */
  kind: DbSubstrateWarningKind;
  /** Absolute path of the offending file or directory. */
  path: string;
  /**
   * `fs.statSync(path).mtimeMs` for the offending file/directory.
   * `null` when stat() threw (e.g. ephemeral race during scan).
   */
  lastWriteMs: number | null;
  /**
   * For `orphan-project-root` warnings only: the `workspace` field read
   * from `<path>/.context-state.json` when present. Identifies which
   * outside workspace last wrote into this orphan `.cleo/` directory
   * (audit trail for the T9550 regression class). `null` when the
   * file is absent, unreadable, or carries no `workspace` field.
   *
   * @task T10308
   */
  parentWorkspace?: string | null;
}

/**
 * Survey result for one CLEO project (i.e. one `.cleo/` directory) plus
 * the global tier of databases owned by it.
 *
 * @remarks
 * `dbs` is keyed by the canonical role names from `DB_INVENTORY`. Every
 * entry is populated regardless of whether the file exists — the caller
 * can iterate every role and decide how to surface absent rows.
 *
 * @task T10307
 */
export interface DbSubstrateProjectSurvey {
  /** Absolute path to the project root that was surveyed. */
  projectRoot: string;
  /**
   * Stable identifier for the project — currently the `base64url(path)`
   * truncated to 32 chars, matching the convention used by `cleo nexus`
   * project resolution.
   */
  projectId: string;
  /** Per-role survey result, keyed by canonical role name. */
  dbs: Readonly<Record<string, DbSubstrateEntry>>;
}

/**
 * Aggregate counters surfaced in `envelope.data.summary`.
 *
 * @task T10307
 */
export interface DbSubstrateSummary {
  /** Total inventory entries surveyed across all projects + global tier. */
  totalDbs: number;
  /** Entries where `exists && integrityOK === true`. */
  healthy: number;
  /** Entries where `!exists`. */
  missing: number;
  /** Entries where `exists && integrityOK === false`. */
  corrupt: number;
}

/**
 * Top-level result payload returned by `surveyDbSubstrate`.
 *
 * @remarks
 * `scope === 'project'` means the survey covered exactly one project plus
 * the global tier. `scope === 'fleet'` means the survey walked every
 * `.cleo/` directory discoverable from a fleet-root search path.
 *
 * Carried as the `data` field of the LAFS envelope; the corresponding
 * `meta` field carries `meta.warnings` per `DbSubstrateWarning` and the
 * canonical `operation: 'doctor.db-substrate.run'` identifier.
 *
 * @task T10307
 */
export interface DbSubstrateAuditResult {
  /** Survey scope. `'project'` = current project; `'fleet'` = many projects. */
  scope: 'project' | 'fleet';
  /** Per-project surveys. One entry for `scope='project'`; ≥1 for `scope='fleet'`. */
  projects: DbSubstrateProjectSurvey[];
  /** Aggregate counters across all surveyed entries. */
  summary: DbSubstrateSummary;
  /**
   * Structural warnings the survey detected outside of any inventory
   * entry — orphan project-root `.cleo/` directories, nested-nexus
   * duplicates, etc. ALWAYS present (may be empty).
   */
  warnings: DbSubstrateWarning[];
}

/**
 * One line appended to `.cleo/audit/worktree-prune.jsonl` per prune
 * operation. Extends the existing audit-log schema (timestamp +
 * worktreePath + action + agent) with the orphan-specific fields needed
 * to reconstruct what was removed.
 *
 * Existing fields preserved for schema continuity:
 *   - `timestamp`, `worktreePath`, `action`, `agent`
 *
 * New fields for orphan prune:
 *   - `orphanPath`, `sizeBytes`, `dbFileCount`, `archivePath`, `dryRun`
 */
export interface PruneAuditEntry {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Worktree root that contained the orphan. */
  worktreePath: string;
  /** Absolute path to the orphan `.cleo/` directory removed. */
  orphanPath: string;
  /** Action code — fixed to `'prune-worktree-orphan'` for this flow. */
  action: 'prune-worktree-orphan';
  /** Always `'cleo'` — written by `cleo doctor`. */
  agent: 'cleo';
  /** Byte size of the pruned tree. */
  sizeBytes: number;
  /** Number of DB files found in the orphan (informational). */
  dbFileCount: number;
  /** Absolute path to the archive. `null` only on dry-run lines. */
  archivePath: string | null;
  /** Whether this entry represents a dry-run plan (no actual removal). */
  dryRun: boolean;
}

// ============================================================================
// Legacy-Backup Walker (T10309 — Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10282)
// ============================================================================

/**
 * Origin hint inferred from a legacy backup file's name.
 *
 * Identifies which legacy migration produced the file. Used by the operator
 * to decide whether the artefact is safe to delete. Derived purely from the
 * filename (and parent-directory name) — no DB inspection is performed.
 *
 * Codes:
 * - `pre-cleo-migration` — `*-pre-cleo.db.bak` files written by the
 *   pre-cleo→cleo migration when the SDK still used legacy file shapes.
 * - `brain-dup-fix` — `brain.db.PRE-DUP-FIX-*` written by the BRAIN
 *   dedup repair (T7xxx series).
 * - `pre-untrack` — `*.pre-untrack-*` written by T5158 when the four
 *   runtime files were `git rm --cached`-ed in 2026-04-07.
 * - `quarantine-snapshot` — files captured under
 *   `<projectRoot>/.cleo/quarantine/` by historical quarantine sweeps
 *   (lafs-, studio-, adapters-, core-, runtime-, cleo-os- timestamped
 *   directories). NEVER auto-pruned (may be active forensic artefacts).
 * - `brain-malformed` — files under `.cleo/quarantine/brain-malformed-*`
 *   (2026-05-23 P0 brain.db malformation incident). Treated as
 *   `quarantine-snapshot` for retention.
 * - `db-backup-rotation` — files under `.cleo/backups/sqlite/` older
 *   than the 10-snapshot rotation cap (overflow candidates).
 * - `unknown` — file matches the suffix pattern but no specific origin
 *   could be inferred from the path. Defaults to safe retention.
 *
 * @task T10309
 */
export type LegacyBackupOriginHint =
  | 'pre-cleo-migration'
  | 'brain-dup-fix'
  | 'pre-untrack'
  | 'quarantine-snapshot'
  | 'brain-malformed'
  | 'db-backup-rotation'
  | 'unknown';

/**
 * Retention recommendation for one legacy backup file.
 *
 * `keep` — file is younger than the soft retention window (default 30
 * days), OR the file lives under a path that is unconditionally
 * preserved (quarantine artefacts).
 *
 * `compress` — file is 30-90 days old and large enough that gzip-ing it
 * reduces disk pressure. The current implementation surfaces this
 * recommendation but the `--prune` flag does NOT compress (it only
 * deletes); a future T10311+ task will wire the compressor.
 *
 * `delete` — file is older than the hard retention window (default 90
 * days) AND does NOT live under `.cleo/quarantine/`. The `--prune`
 * verb removes these (or simulates removal in dry-run mode).
 *
 * @task T10309
 */
export type LegacyBackupRecommendation = 'keep' | 'compress' | 'delete';

/**
 * One legacy backup artefact discovered by the walker.
 *
 * Carries enough provenance for the operator to act without re-reading
 * the file from disk. `ageDays` is rounded DOWN to match the retention
 * window semantics (a file exactly 30.5 days old is `30` days, still
 * inside the keep window).
 *
 * @task T10309
 */
export interface LegacyBackupEntry {
  /** Absolute path to the legacy backup file. */
  path: string;
  /** `fs.statSync(path).size`. */
  sizeBytes: number;
  /** `fs.statSync(path).mtimeMs`. */
  mtimeMs: number;
  /** Whole-day age of the file at scan time (`floor((now - mtimeMs) / 86_400_000)`). */
  ageDays: number;
  /** Inferred origin (which legacy migration created this artefact). */
  originHint: LegacyBackupOriginHint;
  /** Retention verdict for this file. */
  recommendation: LegacyBackupRecommendation;
  /**
   * Free-form reason explaining the recommendation. Stable enough to
   * surface to operators; do NOT machine-parse — switch on
   * `originHint` + `recommendation` instead.
   */
  reason: string;
}

/**
 * Result returned by the legacy-backup walker (T10309).
 *
 * Lists every discovered artefact plus aggregate counters. When
 * `--prune` was requested the `pruned` and `kept` arrays partition the
 * total set; otherwise both arrays are empty and `entries` is the only
 * populated list.
 *
 * @remarks
 * `softRetentionDays` and `hardRetentionDays` echo the configured
 * retention thresholds back to the operator so the envelope is
 * self-documenting.
 *
 * @task T10309
 */
export interface LegacyBackupScanResult {
  /** Absolute path to the project root that was scanned. */
  projectRoot: string;
  /** Absolute path to the CLEO home (`<projectRoot>/../.local/share/cleo` style) that was scanned. */
  cleoHome: string;
  /** All artefacts discovered, sorted by `path` ascending. */
  entries: LegacyBackupEntry[];
  /** Total bytes across `entries`. */
  totalBytes: number;
  /** Soft retention window in days (files younger than this are always `keep`). */
  softRetentionDays: number;
  /** Hard retention window in days (files older than this are `delete`). */
  hardRetentionDays: number;
  /**
   * `true` when this result represents a `--prune` invocation; `false`
   * when it is a pure scan. Drives whether `pruned`/`kept` are
   * populated.
   */
  prune: boolean;
  /**
   * `true` when `--prune` was requested but `--dry-run` was active
   * (the implementation defaults `--prune` to dry-run). `false` for
   * actual deletions or when `prune === false`.
   */
  dryRun: boolean;
  /**
   * Entries that were (or would be) deleted. Always empty when
   * `prune === false`.
   */
  pruned: LegacyBackupEntry[];
  /**
   * Entries the prune operation skipped (recommendation !== 'delete'
   * or path under quarantine). Always empty when `prune === false`.
   */
  kept: LegacyBackupEntry[];
  /**
   * Errors encountered while removing pruneable files. Empty in
   * dry-run mode and on pure scans.
   */
  errors: Array<{ path: string; error: string }>;
}
