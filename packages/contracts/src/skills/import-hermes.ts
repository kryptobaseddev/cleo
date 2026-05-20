/**
 * Contract types for `cleo skill import-hermes` — Hermes sidecar migration.
 *
 * Reads `~/.hermes/skills/.usage.json` plus `~/.hermes/skills/.bundled_manifest`
 * and inserts equivalent rows into CLEO's `skills.db`. Counters from the
 * Hermes sidecar (use_count / view_count / patch_count) are preserved as
 * synthesized `skill_usage` rows so the CLEO `cleo skills stats` rollup
 * surfaces day-zero usage data right after migration.
 *
 * @task T9691
 * @epic T9561
 * @saga T9560
 */

/**
 * Input parameters for the `cleo skill import-hermes` verb.
 */
export interface SkillImportHermesRequest {
  /** Override default `~/.hermes` lookup. */
  readonly hermesHome?: string;
  /** When true, print planned writes without mutating skills.db. */
  readonly dryRun?: boolean;
}

/**
 * Per-skill outcome row in the import response.
 */
export interface SkillImportHermesRow {
  /** Skill identifier. */
  readonly name: string;
  /**
   * Disposition of the row:
   * - `imported` — skills row was inserted / upserted.
   * - `skipped`  — skills row already exists with matching content; no write.
   * - `failed`   — validation error or DB error; see `error`.
   */
  readonly disposition: 'imported' | 'skipped' | 'failed';
  /** Resolved CLEO source-type mapping for the row (or null when failed). */
  readonly sourceType: 'canonical' | 'user' | 'community' | 'agent-created' | null;
  /** Number of synthesized `skill_usage` rows from counters. */
  readonly synthesizedUsageRows: number;
  /** Error message if `disposition='failed'`. */
  readonly error: string | null;
}

/**
 * Result envelope for `cleo skill import-hermes`.
 *
 * Wrapped in the standard LAFS `{success, data, meta}` envelope at the
 * dispatch boundary; this interface describes the `data` payload only.
 */
export interface SkillImportHermesResponse {
  /** Resolved Hermes home used for this run. */
  readonly hermesHome: string;
  /** Whether this was a dry-run (no DB writes). */
  readonly dryRun: boolean;
  /** Total skills rows seen in the Hermes sidecar. */
  readonly seen: number;
  /** Count of `disposition='imported'` rows. */
  readonly imported: number;
  /** Count of `disposition='skipped'` rows. */
  readonly skipped: number;
  /** Count of `disposition='failed'` rows. */
  readonly failed: number;
  /** Per-skill outcome rows. */
  readonly rows: readonly SkillImportHermesRow[];
  /** Total `skill_usage` rows synthesized from counters (sum across rows). */
  readonly totalSynthesizedUsage: number;
}
