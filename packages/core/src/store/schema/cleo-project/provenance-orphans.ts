/**
 * Project-scope `cleo.db` — **orphan provenance tables** (3 tables).
 *
 * These tables existed in the legacy brain.db but had no consolidated target
 * in the initial E2 schema authoring, causing their rows to be skipped during
 * exodus migration. Added as part of T11549 (zero-loss final mile) so all 11
 * rows (3 agent_credentials + 8 brain_release_links) are preserved.
 *
 * ## tasks_agent_credentials
 *
 * Mirrors the legacy `agent_credentials` table (tasks domain — agent runtime
 * credential cache, physically stored in brain.db due to historical locality).
 * The consolidated target uses the `tasks_` prefix to match the agent runtime
 * domain. Column shape matches the legacy schema
 * (`packages/core/migrations/drizzle-tasks/20260327000000_agent-credentials/migration.sql`)
 * exactly so the exodus column intersection copies all rows without drift.
 * `created_at` and `updated_at` remain INTEGER epoch (milliseconds) to mirror
 * the legacy shape — no E10 §4 re-typing applied here (runtime-recreatable table;
 * owner decision: preserve fidelity over strictness).
 *
 * ## tasks_brain_release_links
 *
 * Mirrors the legacy `brain_release_links` table from
 * `schema/provenance/releases.ts` (brainReleaseLinks). In the legacy schema this
 * table lived in brain.db but referenced releases in tasks.db via a soft FK.
 * In the consolidated project-scope `cleo.db` both tables coexist, so the soft FK
 * is preserved as a plain `text` column (no native REFERENCES — the data model
 * does not enforce cascade across domain boundaries in this release).
 * The `tasks_` prefix matches the provenance domain of the parent
 * `tasks_releases` table.
 *
 * ## brain_task_observations
 *
 * The join between `brain_observations` and task ids that `cleo memory find`
 * session-context lookups read (writer: `sessions/session-memory-bridge.ts`).
 * It was created only by the standalone `drizzle-brain` migration, which the
 * consolidated store's brain reconcile runs after the open-time identity heal,
 * so a fresh store lacked it during that heal. T12896 adds it to the
 * consolidated project schema (same shape, `IF NOT EXISTS`) so every store has
 * it before the heal, and declares it natural on (observation id, task uid).
 *
 * @task T11549 (P0 zero-loss final mile)
 * @task T12896
 * @epic T11245
 * @saga T11242
 */

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------

/**
 * Semantic relationship types for the BRAIN↔release link junction.
 * Mirrors `BRAIN_RELEASE_LINK_TYPES` from `schema/provenance/releases.ts`.
 * Duplicated here (not cross-imported) to keep this module free of dependency
 * on the legacy unprefixed schema during the exodus transition.
 *
 * @see packages/contracts/src/provenance.ts `BrainReleaseLinkType`
 */
export const BRAIN_RELEASE_LINK_TYPES_CONSOLIDATED = [
  'approved-by',
  'documented-in',
  'derived-from',
  'observed-in',
] as const;

// ---------------------------------------------------------------------------
// tasks_agent_credentials
// ---------------------------------------------------------------------------

/**
 * Consolidated mirror of the legacy `agent_credentials` table.
 *
 * Stores agent API keys (encrypted at rest, AES-256-GCM machine-key bound)
 * and associated capability/transport configuration. The table is
 * runtime-recreatable from signaldock.db on first auth, but migrating the 3
 * existing rows avoids a forced re-authentication cycle post-exodus.
 *
 * Column shape matches the legacy migration SQL exactly so the exodus
 * intersection copy is lossless.
 *
 * @task T11549
 */
export const tasksAgentCredentials = sqliteTable(
  'tasks_agent_credentials',
  {
    /** Stable agent identifier (primary key). */
    agentId: text('agent_id').primaryKey(),
    /** Human-readable display name for this agent. */
    displayName: text('display_name').notNull(),
    /** AES-256-GCM encrypted API key (machine-key bound). */
    apiKeyEncrypted: text('api_key_encrypted').notNull(),
    /**
     * Base URL of the agent's API endpoint. The SQL default (the retired
     * SignalDock host) is kept, with no table rebuild; ORM inserts get
     * `'local'` (T13169).
     */
    apiBaseUrl: text('api_base_url')
      .notNull()
      .default('https://api.signaldock.io')
      .$defaultFn(() => 'local'),
    /** Agent classification tier (e.g. 'orchestrator', 'worker'). */
    classification: text('classification'),
    /** Privacy visibility tier (e.g. 'public', 'private'). */
    privacyTier: text('privacy_tier').notNull().default('public'),
    /** JSON-encoded capability list. */
    capabilities: text('capabilities').notNull().default('[]'),
    /** JSON-encoded skill slug list. */
    skills: text('skills').notNull().default('[]'),
    /** JSON-encoded transport configuration. */
    transportConfig: text('transport_config').notNull().default('{}'),
    /** Whether this credential is currently active. */
    isActive: integer('is_active').notNull().default(1),
    /** Unix epoch of most recent use (milliseconds). Null = never used. */
    lastUsedAt: integer('last_used_at'),
    /** Unix epoch when this credential was created (milliseconds). */
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
    /** Unix epoch when this credential was last updated (milliseconds). */
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_tasks_agent_cred_active').on(table.isActive),
    index('idx_tasks_agent_cred_last_used').on(table.lastUsedAt),
  ],
);

/** Row type for `tasks_agent_credentials`. */
export type TasksAgentCredentialRow = typeof tasksAgentCredentials.$inferSelect;
/** Insert type for `tasks_agent_credentials`. */
export type NewTasksAgentCredentialRow = typeof tasksAgentCredentials.$inferInsert;

// ---------------------------------------------------------------------------
// tasks_brain_release_links
// ---------------------------------------------------------------------------

/**
 * Consolidated mirror of the legacy `brain_release_links` junction table.
 *
 * Closes the BRAIN↔release loop (ADR-073 / SPEC-T9345 §8): each row links a
 * brain memory entry to a release via a semantic relationship type. In the legacy
 * schema this table lived in brain.db alongside decisions/observations; in the
 * consolidated project-scope `cleo.db` it lives with the provenance family
 * (prefixed `tasks_` to match `tasks_releases`).
 *
 * The `release_id` is a soft FK to `tasks_releases.id` — no native REFERENCES
 * is declared here to avoid ordering issues during exodus bulk copy (FK-defer
 * mode covers this at migration time; the runtime accessor enforces referential
 * integrity at write time).
 *
 * @task T11549
 * @see packages/core/src/store/schema/provenance/releases.ts brainReleaseLinks
 */
export const tasksBrainReleaseLinks = sqliteTable(
  'tasks_brain_release_links',
  {
    /**
     * Soft FK to a brain memory entry (decisions/observations/etc.).
     * NOT a hard REFERENCES — cross-domain soft FK only.
     */
    brainEntryId: text('brain_entry_id'),
    /** Soft FK to `tasks_releases.id`. Part of composite PK. */
    releaseId: text('release_id').notNull(),
    /** Semantic relationship type. */
    linkType: text('link_type', { enum: BRAIN_RELEASE_LINK_TYPES_CONSOLIDATED }).notNull(),
    /** ISO-8601 timestamp when this link was created. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** Identity of the agent or user that created this link. */
    createdBy: text('created_by'),
    /** Row uid (T12895): a UUIDv8 over (brain entry id, release id, link type), filled at open or by the uid trigger. */
    uid: text('uid'),
  },
  (table) => [
    primaryKey({ columns: [table.brainEntryId, table.releaseId, table.linkType] }),
    uniqueIndex('uq_tasks_brain_release_links_uid').on(table.uid),
    index('idx_tasks_brain_rel_links_brain_entry_id').on(table.brainEntryId),
    index('idx_tasks_brain_rel_links_release_id').on(table.releaseId),
    index('idx_tasks_brain_rel_links_link_type').on(table.linkType),
  ],
);

/** Row type for `tasks_brain_release_links`. */
export type TasksBrainReleaseLinkRow = typeof tasksBrainReleaseLinks.$inferSelect;
/** Insert type for `tasks_brain_release_links`. */
export type NewTasksBrainReleaseLinkRow = typeof tasksBrainReleaseLinks.$inferInsert;

// ---------------------------------------------------------------------------
// brain_task_observations
// ---------------------------------------------------------------------------

/**
 * Join table linking a brain observation to a task id (T1615). Its INTEGER id
 * is a local key that never travels; row identity is natural on
 * (`observation_id`, task uid) (T12896).
 *
 * @task T12896
 */
export const brainTaskObservations = sqliteTable(
  'brain_task_observations',
  {
    /** Local autoincrement key; never sent on the wire. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Soft FK to `brain_observations.id`. */
    observationId: text('observation_id').notNull(),
    /** Soft FK to `tasks_tasks.id`. */
    taskId: text('task_id').notNull(),
    /** How the observation relates to the task. */
    linkType: text('link_type').notNull().default('session-completed'),
    /** Timestamp the link was written. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** Row uid (T12896): a UUIDv8 over (observation id, task uid), filled at open or by the uid trigger. */
    uid: text('uid'),
  },
  (table) => [
    uniqueIndex('idx_brain_task_obs_unique').on(table.observationId, table.taskId),
    index('idx_brain_task_obs_observation').on(table.observationId),
    index('idx_brain_task_obs_task').on(table.taskId),
    uniqueIndex('uq_brain_task_observations_uid').on(table.uid),
  ],
);

/** Row type for `brain_task_observations`. */
export type BrainTaskObservationRow = typeof brainTaskObservations.$inferSelect;
/** Insert type for `brain_task_observations`. */
export type NewBrainTaskObservationRow = typeof brainTaskObservations.$inferInsert;
