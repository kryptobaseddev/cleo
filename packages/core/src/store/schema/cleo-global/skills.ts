/**
 * Global-scope `cleo.db` — consolidated **skills** domain (4 tables).
 *
 * Part of the consolidated GLOBAL-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11361). Target-shape
 * authoring only — physical names carry the `skills_` domain prefix. The live
 * runtime module `schema/skills-schema.ts` keeps its UNPREFIXED names
 * (`skills`, `skill_usage`, …) until the exodus migration (T11248) swaps the
 * substrate.
 *
 * ## Idempotent prefixer (AC1)
 *
 * All four source tables are bare and gain the `skills_` prefix at exodus:
 * `skills` → `skills_skills` · `skill_usage` → `skills_skill_usage` ·
 * `skill_reviews` → `skills_skill_reviews` · `skill_patches` →
 * `skills_skill_patches`.
 *
 * ## E10 typing applied
 *
 * The skills source is already E10-clean — no non-conformers to remediate:
 *   - **§5a enums:** `source_type` / `lifecycle_state` / `outcome` / `status`
 *     already declare `text({ enum })` from in-module named const arrays
 *     ({@link SKILL_SOURCE_TYPES} / {@link SKILL_LIFECYCLE_STATES} /
 *     {@link SKILL_REVIEW_OUTCOMES} / {@link SKILL_PATCH_STATUSES}); the
 *     matching `CHECK (col IN (...))` ships at exodus.
 *   - **§3a booleans:** `skills.pinned` / `skills.is_agent_created` already
 *     declare `{ mode:'boolean' }`.
 *   - **§4 timestamps:** every timestamp is already canonical TEXT ISO8601
 *     (`installed_at`, `observed_at`, `reviewed_at`, `proposed_at`, …) — no
 *     epoch/Date non-conformer in this domain.
 *
 * ## FK reconciliation to single-file Pattern A (AC4)
 *
 * The skills source declares all relationships as LOGICAL (denormalized
 * `skill_name` / `review_id` columns, no enforced `.references()`), so nothing
 * crossed a file boundary. `skill_usage.task_id` is a cross-domain reference to
 * the PROJECT-scope `cleo.db` and therefore stays a plain `text` soft FK
 * (resolved by the skill-telemetry accessor; no ATTACH).
 *
 * @task T11361
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (D1″ · global counts) · §3a · §5a
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 * @see ../skills-schema.ts (the runtime source module)
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// E10 §5a — enum const arrays (in-module SSoT; no @cleocode/contracts dependency
// in this leaf storage domain)
// ---------------------------------------------------------------------------

/**
 * Provenance of a skill row (Sphere A canonical vs Sphere B authored).
 *
 * @architecture SG-CLEO-SKILLS v3 §4 `source_type` enum
 * @task T11361 (target shape) · T9651 (original)
 */
export const SKILL_SOURCE_TYPES = ['canonical', 'user', 'community', 'agent-created'] as const;

/** TypeScript union derived from {@link SKILL_SOURCE_TYPES}. */
export type SkillSourceType = (typeof SKILL_SOURCE_TYPES)[number];

/**
 * Lifecycle state of a skill row.
 *
 * @architecture SG-CLEO-SKILLS v3 §4 `lifecycle_state` enum
 * @task T11361 (target shape) · T9651 (original)
 */
export const SKILL_LIFECYCLE_STATES = ['active', 'stale', 'archived'] as const;

/** TypeScript union derived from {@link SKILL_LIFECYCLE_STATES}. */
export type SkillLifecycleState = (typeof SKILL_LIFECYCLE_STATES)[number];

/**
 * Skill review outcome (council and/or grade pipelines).
 *
 * @architecture SG-CLEO-SKILLS v3 §6/§7 (auto-improve)
 * @task T11361 (target shape) · T9651 (original)
 */
export const SKILL_REVIEW_OUTCOMES = ['approved', 'rejected', 'needs-changes'] as const;

/** TypeScript union derived from {@link SKILL_REVIEW_OUTCOMES}. */
export type SkillReviewOutcome = (typeof SKILL_REVIEW_OUTCOMES)[number];

/**
 * Skill patch application state.
 *
 * @architecture SG-CLEO-SKILLS v3 §6/§7 (auto-improve)
 * @task T11361 (target shape) · T9651 (original)
 */
export const SKILL_PATCH_STATUSES = ['proposed', 'applied', 'reverted', 'rejected'] as const;

/** TypeScript union derived from {@link SKILL_PATCH_STATUSES}. */
export type SkillPatchStatus = (typeof SKILL_PATCH_STATUSES)[number];

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * `skills_skills` — per-user registry of installed skills (one row per name).
 * Bare `skills` → `skills_skills` under the AC1 idempotent prefixer.
 *
 * @task T11361 (target shape) · T9651 (original)
 */
export const skillsSkills = sqliteTable(
  'skills_skills',
  {
    /** Surrogate primary key — autoincrement integer. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Skill identifier (e.g. `ct-orchestrator`). Globally unique. */
    name: text('name').notNull().unique(),
    /** Semver string parsed from the skill frontmatter, if present. */
    version: text('version'),
    /** Provenance from {@link SKILL_SOURCE_TYPES} (E10 §5a). */
    sourceType: text('source_type', { enum: SKILL_SOURCE_TYPES }).notNull(),
    /** Origin URL (GitHub / marketplace); NULL for user / agent-created. */
    sourceUrl: text('source_url'),
    /** Resolved on-disk path where the skill currently lives. */
    installPath: text('install_path').notNull(),
    /** XDG canonical path (Sphere A); NULL for Sphere B rows. */
    canonicalPath: text('canonical_path'),
    /** ISO-8601 install timestamp (canonical TEXT, §4). */
    installedAt: text('installed_at').notNull(),
    /** ISO-8601 last-updated timestamp (canonical TEXT, §4). */
    lastUpdatedAt: text('last_updated_at'),
    /** Lifecycle state from {@link SKILL_LIFECYCLE_STATES} (E10 §5a). */
    lifecycleState: text('lifecycle_state', { enum: SKILL_LIFECYCLE_STATES })
      .notNull()
      .default('active'),
    /** When true, auto-improve patches are refused (E10 §3a — typed boolean). */
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** True if generated by an agent at runtime (E10 §3a — typed boolean). */
    isAgentCreated: integer('is_agent_created', { mode: 'boolean' }).notNull().default(false),
    /** ISO-8601 archive timestamp; NULL while not archived (canonical TEXT, §4). */
    archivedAt: text('archived_at'),
    /** Path the row was archived FROM (so move-back is reproducible). */
    archivedFromPath: text('archived_from_path'),
  },
  (table) => [
    index('idx_skills_skills_state').on(table.lifecycleState),
    index('idx_skills_skills_source').on(table.sourceType),
  ],
);

/**
 * `skills_skill_usage` — per-event telemetry row (load / invoke / error). Bare
 * `skill_usage` → `skills_skill_usage`.
 *
 * @task T11361 (target shape) · T9651 (original)
 */
export const skillsSkillUsage = sqliteTable(
  'skills_skill_usage',
  {
    /** Surrogate primary key — autoincrement integer. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Logical FK to {@link skillsSkills}.name — denormalised for query speed. */
    skillName: text('skill_name').notNull(),
    /** ISO-8601 wall-clock timestamp of the load/invoke event (canonical TEXT, §4). */
    observedAt: text('observed_at').notNull().default(sql`(datetime('now'))`),
    /** Event kind — `load`, `invoke`, `error`, etc. */
    eventKind: text('event_kind').notNull(),
    /**
     * Owning task context; NULL if not running inside a CLEO task.
     *
     * Cross-domain soft FK → PROJECT-scope `cleo.db` `tasks_tasks.id`. CANNOT
     * be a native FK (different scope DB file); resolved by the skill-telemetry
     * accessor (AC4 — no ATTACH).
     */
    taskId: text('task_id'),
    /**
     * Owning project context; NULL if not running inside a resolvable CLEO
     * project (global usage outside any repo).
     *
     * Cross-domain soft FK → the project registry's canonical `project_id`. Like
     * {@link taskId} this is a plain `text` soft FK (no native cross-scope FK);
     * resolved by the skill-telemetry recorder from the active ProjectContext.
     * Nullable so existing rows + project-less usage stay valid (T11544 — the
     * cross-project skill-usage attribution column).
     */
    projectId: text('project_id'),
    /** Model identifier the calling agent was running under. */
    modelId: text('model_id'),
    /** Free-form JSON blob for forward-compatible event metadata (serialized TEXT). */
    metadata: text('metadata').notNull().default('{}'),
  },
  (table) => [
    index('idx_skills_skill_usage_name_observed').on(table.skillName, table.observedAt),
    index('idx_skills_skill_usage_kind').on(table.eventKind),
  ],
);

/**
 * `skills_skill_reviews` — council + grade review outcomes (auto-improve quality
 * gate). Bare `skill_reviews` → `skills_skill_reviews`.
 *
 * @task T11361 (target shape) · T9651 (original)
 */
export const skillsSkillReviews = sqliteTable(
  'skills_skill_reviews',
  {
    /** Surrogate primary key — autoincrement integer. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Logical FK to {@link skillsSkills}.name. */
    skillName: text('skill_name').notNull(),
    /** ISO-8601 timestamp of the review (canonical TEXT, §4). */
    reviewedAt: text('reviewed_at').notNull().default(sql`(datetime('now'))`),
    /** Outcome verdict from {@link SKILL_REVIEW_OUTCOMES} (E10 §5a). */
    outcome: text('outcome', { enum: SKILL_REVIEW_OUTCOMES }).notNull(),
    /** Numeric grade (0-100); NULL if review was council-only. */
    score: integer('score'),
    /** Identifier of the council/grade run (UUID, hash, or run-id). */
    reviewRunId: text('review_run_id'),
    /** Free-form summary / chairman verdict text. */
    summary: text('summary'),
  },
  (table) => [
    index('idx_skills_skill_reviews_name_reviewed').on(table.skillName, table.reviewedAt),
    index('idx_skills_skill_reviews_outcome').on(table.outcome),
  ],
);

/**
 * `skills_skill_patches` — auto-improve patch payload (unified diff). Bare
 * `skill_patches` → `skills_skill_patches`.
 *
 * @task T11361 (target shape) · T9651 (original)
 */
export const skillsSkillPatches = sqliteTable(
  'skills_skill_patches',
  {
    /** Surrogate primary key — autoincrement integer. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Logical FK to {@link skillsSkills}.name. */
    skillName: text('skill_name').notNull(),
    /** ISO-8601 timestamp the patch was proposed (canonical TEXT, §4). */
    proposedAt: text('proposed_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 timestamp the patch was applied; NULL while proposed (canonical TEXT, §4). */
    appliedAt: text('applied_at'),
    /** Logical FK to {@link skillsSkillReviews}.id that gated this patch. */
    reviewId: integer('review_id'),
    /** Unified diff bytes (text, may be large — kept inline by design). */
    diff: text('diff').notNull(),
    /** Lifecycle from {@link SKILL_PATCH_STATUSES} (E10 §5a). */
    status: text('status', { enum: SKILL_PATCH_STATUSES }).notNull().default('proposed'),
    /** Revert pointer — id of the patch that reverted this one. */
    revertedByPatchId: integer('reverted_by_patch_id'),
  },
  (table) => [
    index('idx_skills_skill_patches_name_proposed').on(table.skillName, table.proposedAt),
    index('idx_skills_skill_patches_status').on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Inferred row + insert types
// ---------------------------------------------------------------------------

/** Row type for `skills_skills` SELECT (target shape). */
export type SkillRow = typeof skillsSkills.$inferSelect;
/** Row type for `skills_skills` INSERT (target shape). */
export type NewSkillRow = typeof skillsSkills.$inferInsert;
/** Row type for `skills_skill_usage` SELECT (target shape). */
export type SkillUsageRow = typeof skillsSkillUsage.$inferSelect;
/** Row type for `skills_skill_usage` INSERT (target shape). */
export type NewSkillUsageRow = typeof skillsSkillUsage.$inferInsert;
/** Row type for `skills_skill_reviews` SELECT (target shape). */
export type SkillReviewRow = typeof skillsSkillReviews.$inferSelect;
/** Row type for `skills_skill_reviews` INSERT (target shape). */
export type NewSkillReviewRow = typeof skillsSkillReviews.$inferInsert;
/** Row type for `skills_skill_patches` SELECT (target shape). */
export type SkillPatchRow = typeof skillsSkillPatches.$inferSelect;
/** Row type for `skills_skill_patches` INSERT (target shape). */
export type NewSkillPatchRow = typeof skillsSkillPatches.$inferInsert;
