/**
 * Drizzle ORM schema for CLEO skills.db — per-user skills registry.
 *
 * Implements section §4 of `docs/architecture/SG-CLEO-SKILLS-architecture-v3.md`:
 * a global-tier (per-user, NOT per-project) registry that tracks every Claude
 * Code / cleo skill the local user has installed, regardless of source.
 *
 * The four tables modelled here:
 *   - `skills`          — registry row per installed skill (Sphere A canonical
 *                          ct-* skills, Sphere B user/community/agent-created)
 *   - `skill_usage`     — per-invocation telemetry events (Sphere B writes;
 *                          Sphere A is opt-out aggregated only — see §5)
 *   - `skill_reviews`   — council + grade outcomes from auto-improve loops
 *   - `skill_patches`   — diff payload for auto-improve dry-runs/applied
 *
 * Database lifecycle:
 *   - Path: `<getCleoHome()>/skills.db` (per-user global, NOT per-project)
 *   - Opened via the `openCleoDb('skills')` chokepoint (ADR-068 + D003)
 *   - Migrations live in `packages/core/migrations/drizzle-skills/`
 *   - First-read materialization: see `skills-sqlite.ts#ensureSkillsDb`
 *
 * Scope note for T9651:
 *   This module is schema-only — the runtime (CLI surface) is wired in
 *   downstream tasks under saga SG-CLEO-SKILLS (Sphere B telemetry in T9561,
 *   auto-improve in later epics). The tables here MUST exist so subsequent
 *   tasks can INSERT/SELECT without re-architecting the storage layer.
 *
 * @task T9651
 * @epic T9571
 * @saga T9560
 * @adr ADR-068 (DB-open chokepoint)
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §4
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Enum string-literal unions (kept as TS unions so consumers can import them
// without depending on @cleocode/contracts in this leaf storage module).
// ---------------------------------------------------------------------------

/**
 * Provenance of a skill row.
 *
 * - `canonical`     — Sphere A ct-* skill installed under the XDG canonical
 *                      store; ONLY writable by the owner-CI workflow.
 * - `user`          — Sphere B skill authored by the local user.
 * - `community`     — Sphere B skill installed from a public marketplace.
 * - `agent-created` — Sphere B skill that an agent generated at runtime
 *                      (`is_agent_created=true` is also set on the row).
 *
 * @architecture v3 §4 `source_type` enum
 */
export type SkillSourceType = 'canonical' | 'user' | 'community' | 'agent-created';

/**
 * Lifecycle state of a skill row.
 *
 * - `active`   — installed and resolvable
 * - `stale`    — present on disk but no longer referenced / superseded
 * - `archived` — removed (path nulled or moved); `archived_at` populated
 *
 * @architecture v3 §4 `lifecycle_state` enum
 */
export type SkillLifecycleState = 'active' | 'stale' | 'archived';

/**
 * Skill review outcome (council and/or grade pipelines).
 *
 * @architecture v3 §6/§7 (auto-improve)
 */
export type SkillReviewOutcome = 'approved' | 'rejected' | 'needs-changes';

/**
 * Skill patch application state.
 *
 * @architecture v3 §6/§7 (auto-improve)
 */
export type SkillPatchStatus = 'proposed' | 'applied' | 'reverted' | 'rejected';

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Per-user registry of installed skills.
 *
 * One row per (name) — uniqueness is enforced on the `name` column because
 * Claude Code / cleo resolve skills by name, and shadow-loading is forbidden.
 *
 * Provenance is captured via `source_type` (enum) + `is_agent_created` flag
 * so that the is-canonical resolution logic (see architecture §6) can refuse
 * mutations against Sphere A rows without re-reading the filesystem manifest.
 *
 * Indexes:
 *   - `idx_skills_state`  — filter by lifecycle state (cleanup sweeps)
 *   - `idx_skills_source` — top-N selection for council seeding (Sphere A)
 *
 * @architecture v3 §4 `skills` table
 * @task T9651
 */
export const skills = sqliteTable(
  'skills',
  {
    /** Surrogate primary key — autoincrement integer. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Skill identifier (e.g. `ct-orchestrator`). Globally unique. */
    name: text('name').notNull().unique(),
    /** Semver string parsed from the skill frontmatter, if present. */
    version: text('version'),
    /** Provenance — see {@link SkillSourceType}. */
    sourceType: text('source_type', {
      enum: ['canonical', 'user', 'community', 'agent-created'],
    }).notNull(),
    /** Origin URL (GitHub / marketplace); `null` for `user` / `agent-created`. */
    sourceUrl: text('source_url'),
    /** Resolved on-disk path where the skill currently lives. */
    installPath: text('install_path').notNull(),
    /** XDG canonical path (Sphere A) — `null` for Sphere B rows. */
    canonicalPath: text('canonical_path'),
    /** ISO-8601 install timestamp. */
    installedAt: text('installed_at').notNull(),
    /** ISO-8601 last-updated timestamp. */
    lastUpdatedAt: text('last_updated_at'),
    /** Lifecycle state — see {@link SkillLifecycleState}. */
    lifecycleState: text('lifecycle_state', {
      enum: ['active', 'stale', 'archived'],
    })
      .notNull()
      .default('active'),
    /** Boolean (stored as 0/1) — when true, auto-improve patches are refused. */
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** Boolean (stored as 0/1) — true if generated by an agent at runtime. */
    isAgentCreated: integer('is_agent_created', { mode: 'boolean' }).notNull().default(false),
    /** ISO-8601 archive timestamp; `null` while `lifecycle_state` != 'archived'. */
    archivedAt: text('archived_at'),
    /** Path the row was archived FROM (so move-back is reproducible). */
    archivedFromPath: text('archived_from_path'),
  },
  (table) => [
    index('idx_skills_state').on(table.lifecycleState),
    index('idx_skills_source').on(table.sourceType),
  ],
);

/**
 * Per-event telemetry row written each time a skill is loaded / invoked.
 *
 * Anonymous by design — see architecture §5. Aggregated client-side before
 * being uploaded (or scrubbed into a PR diff) by the owner-CI workflow.
 *
 * Index on `(skill_name, observed_at)` accelerates the periodic top-N rollup
 * that drives the Sphere A council seeding job.
 *
 * @architecture v3 §4 + §5
 * @task T9651
 */
export const skillUsage = sqliteTable(
  'skill_usage',
  {
    /** Surrogate primary key — autoincrement integer. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Foreign key (logical) to {@link skills}.name — denormalised for query speed. */
    skillName: text('skill_name').notNull(),
    /** ISO-8601 wall-clock timestamp of the load/invoke event. */
    observedAt: text('observed_at').notNull().default(sql`(datetime('now'))`),
    /** Event kind — `load`, `invoke`, `error`, etc. (free-form for now). */
    eventKind: text('event_kind').notNull(),
    /** Optional epic / task ID context (null if not running inside a CLEO task). */
    taskId: text('task_id'),
    /** Optional model identifier the calling agent was running under. */
    modelId: text('model_id'),
    /** Free-form JSON blob for forward-compatible event metadata. */
    metadata: text('metadata').notNull().default('{}'),
  },
  (table) => [
    index('idx_skill_usage_name_observed').on(table.skillName, table.observedAt),
    index('idx_skill_usage_kind').on(table.eventKind),
  ],
);

/**
 * Council + grade review outcomes (auto-improve quality gate).
 *
 * One row per (skill, review_run). `outcome` is the consolidated verdict
 * from the multi-advisor council pass; `score` carries the numeric grade
 * if the review ran the rubric pipeline.
 *
 * @architecture v3 §6/§7 (auto-improve)
 * @task T9651
 */
export const skillReviews = sqliteTable(
  'skill_reviews',
  {
    /** Surrogate primary key — autoincrement integer. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Foreign key (logical) to {@link skills}.name. */
    skillName: text('skill_name').notNull(),
    /** ISO-8601 timestamp of the review. */
    reviewedAt: text('reviewed_at').notNull().default(sql`(datetime('now'))`),
    /** Outcome verdict — see {@link SkillReviewOutcome}. */
    outcome: text('outcome', {
      enum: ['approved', 'rejected', 'needs-changes'],
    }).notNull(),
    /** Numeric grade (0-100); null if review was council-only. */
    score: integer('score'),
    /** Identifier of the council/grade run (UUID, hash, or run-id). */
    reviewRunId: text('review_run_id'),
    /** Free-form summary / chairman verdict text. */
    summary: text('summary'),
  },
  (table) => [
    index('idx_skill_reviews_name_reviewed').on(table.skillName, table.reviewedAt),
    index('idx_skill_reviews_outcome').on(table.outcome),
  ],
);

/**
 * Auto-improve patch payload (diff produced by the improvement loop).
 *
 * Stores the unified diff in `diff` so reverts are byte-exact. `status`
 * tracks the lifecycle (`proposed` → `applied` | `reverted` | `rejected`).
 *
 * @architecture v3 §6/§7 (auto-improve)
 * @task T9651
 */
export const skillPatches = sqliteTable(
  'skill_patches',
  {
    /** Surrogate primary key — autoincrement integer. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Foreign key (logical) to {@link skills}.name. */
    skillName: text('skill_name').notNull(),
    /** ISO-8601 timestamp the patch was proposed. */
    proposedAt: text('proposed_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 timestamp the patch was applied (null while `status='proposed'`). */
    appliedAt: text('applied_at'),
    /** Optional foreign key (logical) to {@link skillReviews}.id that gated this patch. */
    reviewId: integer('review_id'),
    /** Unified diff bytes (text, may be large — kept inline by design). */
    diff: text('diff').notNull(),
    /** Lifecycle — see {@link SkillPatchStatus}. */
    status: text('status', {
      enum: ['proposed', 'applied', 'reverted', 'rejected'],
    })
      .notNull()
      .default('proposed'),
    /** Optional revert pointer — id of the patch that reverted this one. */
    revertedByPatchId: integer('reverted_by_patch_id'),
  },
  (table) => [
    index('idx_skill_patches_name_proposed').on(table.skillName, table.proposedAt),
    index('idx_skill_patches_status').on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Inferred row + insert types
// ---------------------------------------------------------------------------

/** Row type for the `skills` table. */
export type SkillRow = typeof skills.$inferSelect;
/** Insert type for the `skills` table. */
export type NewSkillRow = typeof skills.$inferInsert;

/** Row type for the `skill_usage` table. */
export type SkillUsageRow = typeof skillUsage.$inferSelect;
/** Insert type for the `skill_usage` table. */
export type NewSkillUsageRow = typeof skillUsage.$inferInsert;

/** Row type for the `skill_reviews` table. */
export type SkillReviewRow = typeof skillReviews.$inferSelect;
/** Insert type for the `skill_reviews` table. */
export type NewSkillReviewRow = typeof skillReviews.$inferInsert;

/** Row type for the `skill_patches` table. */
export type SkillPatchRow = typeof skillPatches.$inferSelect;
/** Insert type for the `skill_patches` table. */
export type NewSkillPatchRow = typeof skillPatches.$inferInsert;
