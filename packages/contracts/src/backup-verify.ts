/**
 * Type contract for `cleo backup verify` — per-DB freshness + integrity walker.
 *
 * `cleo backup verify` walks every entry in `DB_INVENTORY` and reports, for
 * each role, the freshest snapshot in BOTH the canonical backup directory
 * (`.cleo/backups/sqlite/` per T10315) and the legacy backup directory
 * (`.cleo/backups/snapshot/`, kept read-only for one deprecation window).
 * Each snapshot is opened via the canonical chokepoint, verified with
 * `PRAGMA integrity_check`, and surfaced as a structured envelope. Operators
 * use the envelope to detect stale and corrupt backups before they're needed
 * for recovery.
 *
 * Verdict semantics (see {@link BackupVerifyVerdict}):
 *
 *  - `healthy` — a fresh snapshot exists (≤ 24h old) AND `integrity_check`
 *    returned `ok`.
 *  - `stale` — a snapshot exists but its mtime is > 24h old. Integrity may
 *    still be OK; the operator should run `cleo backup add` to refresh.
 *  - `corrupt` — at least one snapshot exists but the FRESH snapshot failed
 *    `integrity_check`. The legacy snapshot may still be usable as a fallback.
 *  - `missing` — no snapshot was found in EITHER the canonical or legacy
 *    directory. Recovery from snapshot is impossible.
 *
 * @task T10319
 * @epic T10284
 * @saga T10281
 */

/**
 * Verdict roll-up for a single role.
 *
 * @public
 */
export type BackupVerifyVerdict = 'healthy' | 'stale' | 'corrupt' | 'missing';

/**
 * Per-snapshot freshness + integrity record.
 *
 * @remarks
 * Returned for both the canonical (`.cleo/backups/sqlite/`) and legacy
 * (`.cleo/backups/snapshot/`) snapshot directories. When no snapshot exists
 * in the corresponding directory the field on the parent
 * {@link BackupVerifyDbReport} is `null` rather than this shape with empty
 * fields — that lets consumers distinguish "no snapshot ever taken" from
 * "snapshot exists but is unhealthy".
 *
 * @public
 */
export interface BackupVerifySnapshot {
  /** Absolute path to the snapshot file. */
  readonly path: string;
  /** Snapshot mtime in epoch ms (the freshness signal). */
  readonly mtime: number;
  /**
   * `true` when the snapshot file opened cleanly AND `PRAGMA integrity_check`
   * returned the single row `ok`. `false` otherwise — see {@link error} for
   * details.
   */
  readonly integrityOK: boolean;
  /**
   * Snapshot file size in bytes when `stat()` succeeded; `null` when the
   * file vanished between discovery and stat.
   */
  readonly sizeBytes: number | null;
  /**
   * Human-readable error message when the snapshot could not be opened or
   * its integrity check threw. `null` on success.
   */
  readonly error: string | null;
}

/**
 * Per-DB report — one entry per role in `DB_INVENTORY`.
 *
 * @public
 */
export interface BackupVerifyDbReport {
  /** Canonical role identifier (matches `DB_INVENTORY[i].role`). */
  readonly role: string;
  /** Lifecycle tier copied through from the inventory for downstream UI. */
  readonly tier: 'project' | 'global' | 'derived';
  /**
   * Freshest snapshot found under `.cleo/backups/sqlite/` (canonical per
   * T10315) — or `null` when the canonical directory has no snapshot for
   * this role.
   */
  readonly freshSnapshot: BackupVerifySnapshot | null;
  /**
   * Freshest snapshot found under `.cleo/backups/snapshot/` (legacy, kept
   * read-only during the deprecation window) — or `null` when the legacy
   * directory has no snapshot for this role.
   */
  readonly legacySnapshot: BackupVerifySnapshot | null;
  /**
   * Hours between `Date.now()` and the freshest available snapshot's mtime
   * (whichever of {@link freshSnapshot} / {@link legacySnapshot} is newer).
   * `null` when {@link verdict} is `missing` — no snapshot to measure from.
   */
  readonly dataLossEstimateHours: number | null;
  /**
   * Roll-up verdict for this role — see {@link BackupVerifyVerdict}.
   */
  readonly verdict: BackupVerifyVerdict;
}

/**
 * Aggregated counters across every role in the survey. Used by the CLI verb
 * to drive its non-zero exit decision (`stale > 0 || corrupt > 0`).
 *
 * @public
 */
export interface BackupVerifySummary {
  /** Number of roles whose verdict is `healthy`. */
  readonly healthy: number;
  /** Number of roles whose verdict is `stale`. */
  readonly stale: number;
  /** Number of roles whose verdict is `corrupt`. */
  readonly corrupt: number;
  /** Number of roles whose verdict is `missing`. */
  readonly missing: number;
}

/**
 * Envelope payload returned by `cleo backup verify` (and the underlying
 * {@link runBackupVerify} core helper).
 *
 * @remarks
 * The shape is keyed by role rather than indexed by array position so
 * consumers can `.dbs['brain']` without scanning. The summary is provided
 * pre-computed because the CLI exit code is driven from it — recomputing it
 * downstream would invite drift.
 *
 * @public
 */
export interface BackupVerifyResult {
  /** Per-role reports keyed by `DB_INVENTORY[i].role`. */
  readonly dbs: Readonly<Record<string, BackupVerifyDbReport>>;
  /** Aggregated counters used to drive the CLI exit code. */
  readonly summary: BackupVerifySummary;
}
