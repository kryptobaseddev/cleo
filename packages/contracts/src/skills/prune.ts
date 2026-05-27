/**
 * Contract types for `cleo skills prune-telemetry` — Sphere B retention policy.
 *
 * Deletes `skill_usage` rows older than a configurable window so the
 * SQLite file doesn't grow unbounded over long-lived installs.
 *
 * @task T9693
 * @epic T9561
 * @saga T9560
 */

/**
 * Input parameters for the `cleo skills prune-telemetry` verb.
 */
export interface SkillPruneTelemetryRequest {
  /**
   * Age threshold in days. Rows with `observed_at` strictly older than
   * `NOW() - olderThanDays * 86_400_000` are deleted. Defaults to 180
   * days at the CLI layer (mirrors Hermes `archive_after_days`).
   */
  readonly olderThanDays?: number;
  /** When true, returns the plan without touching the DB. */
  readonly dryRun?: boolean;
  /** When true, runs `VACUUM` after the delete to reclaim disk space. */
  readonly vacuum?: boolean;
}

/**
 * Result envelope for `cleo skills prune-telemetry`.
 *
 * Wrapped in the standard LAFS `{success, data, meta}` envelope at the
 * dispatch boundary; this interface describes the `data` payload only.
 */
export interface SkillPruneTelemetryResponse {
  /** Number of `skill_usage` rows deleted (or projected for dry-run). */
  readonly deletedRows: number;
  /** Effective `olderThanDays` value used. */
  readonly olderThanDays: number;
  /** ISO-8601 cutoff timestamp the prune was computed against. */
  readonly cutoffIso: string;
  /** Whether this was a dry-run (no DB writes). */
  readonly dryRun: boolean;
  /** Whether VACUUM ran after the prune. */
  readonly vacuumed: boolean;
  /** Bytes on disk for skills.db BEFORE the prune (best-effort). */
  readonly dbSizeBefore: number;
  /** Bytes on disk for skills.db AFTER the prune. */
  readonly dbSizeAfter: number;
  /** Oldest `observed_at` still in the table (`null` if empty). */
  readonly oldestRemaining: string | null;
  /** Newest `observed_at` still in the table (`null` if empty). */
  readonly newestRemaining: string | null;
}
