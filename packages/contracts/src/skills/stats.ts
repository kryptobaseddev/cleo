/**
 * Contract types for `cleo skills stats` — Sphere B telemetry rollup CLI.
 *
 * The stats verb queries the typed Drizzle adapter (`skills-store.ts`) and
 * returns a multi-faceted view of recent usage: top-N by event count,
 * lifecycle distribution, source-type breakdown, and agent-created counts.
 * Designed to mirror Hermes' `agent_created_report()` output shape but
 * sourced from `skills.db` instead of `~/.hermes/skills/.usage.json`.
 *
 * @task T9690
 * @epic T9561
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §5
 */

// ---------------------------------------------------------------------------
// Enum mirrors (kept in sync with packages/core/src/store/skills-schema.ts)
// ---------------------------------------------------------------------------

/**
 * Provenance of a skill row, mirrored from
 * `packages/core/src/store/skills-schema.ts` so contracts consumers don't
 * need a runtime dependency on @cleocode/core.
 */
export type StatsSkillSourceType = 'canonical' | 'user' | 'community' | 'agent-created';

/**
 * Lifecycle state of a skill row, mirrored from
 * `packages/core/src/store/skills-schema.ts`.
 */
export type StatsSkillLifecycleState = 'active' | 'stale' | 'archived';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Input parameters for the `cleo skills stats` verb.
 *
 * All flags are optional. When no facet flag is set, the verb returns the
 * full multi-facet report.
 */
export interface SkillStatsRequest {
  /** Cap on entries returned by the top-N facet (default 10). */
  readonly top?: number;
  /** Restrict the top-N rollup to the last N days (default: all-time). */
  readonly sinceDays?: number;
  /** When true, include the source-type breakdown facet. */
  readonly bySource?: boolean;
  /** When true, include the lifecycle-state breakdown facet. */
  readonly byLifecycle?: boolean;
  /** When true, include the agent-created skill list facet. */
  readonly agentCreated?: boolean;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Single row in the {@link SkillStatsResponse.top} rollup.
 *
 * Mirrors the `SkillUsageRollup` interface exposed by the core
 * `skills-store.ts` module.
 */
export interface SkillStatsTopRow {
  /** Skill identifier (matches `skills.name`). */
  readonly skillName: string;
  /** Number of `skill_usage` rows referencing this skill in the window. */
  readonly count: number;
}

/**
 * Source-type breakdown row.
 *
 * Reports the count of skills in each {@link StatsSkillSourceType} bucket.
 * Skills whose `lifecycle_state` is `archived` are excluded by default.
 */
export interface SkillStatsBySourceRow {
  /** Source-type bucket. */
  readonly sourceType: StatsSkillSourceType;
  /** Number of active skills in this bucket. */
  readonly count: number;
}

/**
 * Lifecycle-state breakdown row.
 */
export interface SkillStatsByLifecycleRow {
  /** Lifecycle bucket. */
  readonly state: StatsSkillLifecycleState;
  /** Number of skills in this bucket. */
  readonly count: number;
}

/**
 * Lightweight summary of a single agent-created skill row, ordered by
 * `installed_at` descending.
 */
export interface SkillStatsAgentCreatedRow {
  /** Skill identifier. */
  readonly name: string;
  /** Semver from frontmatter, if present. */
  readonly version: string | null;
  /** ISO-8601 install timestamp. */
  readonly installedAt: string;
  /** Lifecycle state at query time. */
  readonly lifecycleState: StatsSkillLifecycleState;
}

/**
 * Result envelope for `cleo skills stats`.
 *
 * Facet fields are nullable so consumers can detect "facet was not requested"
 * vs. "facet returned zero rows" — both result in `[]` would be ambiguous.
 *
 * Wrapped in the standard LAFS `{success, data, meta}` envelope at the
 * dispatch boundary; this interface describes the `data` payload only.
 */
export interface SkillStatsResponse {
  /** Top-N rollup (always present). */
  readonly top: readonly SkillStatsTopRow[];
  /** Source-type breakdown — `null` when `bySource` was not requested. */
  readonly bySource: readonly SkillStatsBySourceRow[] | null;
  /** Lifecycle breakdown — `null` when `byLifecycle` was not requested. */
  readonly byLifecycle: readonly SkillStatsByLifecycleRow[] | null;
  /** Agent-created skill list — `null` when `agentCreated` was not requested. */
  readonly agentCreated: readonly SkillStatsAgentCreatedRow[] | null;
  /** Effective `sinceDays` value applied to the top-N rollup, if any. */
  readonly sinceDays: number | null;
}
