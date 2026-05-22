/**
 * Core task tables: tasks, task_dependencies, task_relations, sessions,
 * session_handoff_entries, task_work_history, external_task_links.
 *
 * @epic T4454
 */

import type { ArchiveReasonValue, TaskKind, TaskScope, TaskSeverity } from '@cleocode/contracts';
import {
  ARCHIVE_REASONS,
  TASK_KINDS,
  TASK_RELATION_TYPES,
  TASK_SCOPES,
  TASK_SEVERITIES,
  TASK_SIZES,
} from '@cleocode/contracts/enums';
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';
import { SESSION_STATUSES, TASK_STATUSES } from '../status-registry.js';

// === CANONICAL ENUM CONSTANTS (non-status) ===

/** Task priorities matching DB CHECK constraint on tasks.priority. */
export const TASK_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

/** Task types matching DB CHECK constraint on tasks.type. */
export const TASK_TYPES = ['epic', 'task', 'subtask'] as const;

/**
 * Union types for the promoted task-axis constants — re-exported here so
 * existing `import { TaskKind, … } from '@cleocode/core/store/tasks-schema'`
 * consumers keep working. Canonical declarations live in
 * `packages/contracts/src/task.ts` (re-routed through `enums.ts` constants).
 */
export type { TaskKind, TaskScope, TaskSeverity };
/**
 * Task kind, scope, severity, and size axes — promoted to
 * `@cleocode/contracts/enums` in Phase 0c of the SG-ARCH-SOLID Saga
 * (T9955). Re-exported here so that Drizzle's `text({ enum: ... })`
 * row-type narrowing keeps using the same identifier and every
 * `import * as schema from './tasks-schema.js'` consumer preserves
 * byte-identical access.
 *
 * @task T944
 * @task T9072
 * @task T9073
 * @task T9955
 */
/** Task relation types — re-exported for Drizzle row-type narrowing. */
/**
 * Truth-grade archive reason values — promoted to
 * `@cleocode/contracts/enums` in Phase 0c of the SG-ARCH-SOLID Saga
 * (T9955).
 *
 * @task T1408
 * @epic T1407
 * @task T9955
 */
export {
  ARCHIVE_REASONS,
  TASK_KINDS,
  TASK_RELATION_TYPES,
  TASK_SCOPES,
  TASK_SEVERITIES,
  TASK_SIZES,
};

/**
 * Union type for {@link ARCHIVE_REASONS}.
 *
 * T1409: re-exported from `@cleocode/contracts` as the SSoT.
 */
export type ArchiveReason = ArchiveReasonValue;

/** External task link types matching DB constraint on external_task_links.link_type. */
export const EXTERNAL_LINK_TYPES = ['created', 'matched', 'manual', 'transferred'] as const;

/** Sync direction types matching DB constraint on external_task_links.sync_direction. */
export const SYNC_DIRECTIONS = ['inbound', 'outbound', 'bidirectional'] as const;

// === TASKS TABLE ===

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', {
      enum: TASK_STATUSES,
    })
      .notNull()
      .default('pending'),
    priority: text('priority', {
      enum: TASK_PRIORITIES,
    })
      .notNull()
      .default('medium'),
    type: text('type', { enum: TASK_TYPES }),
    /**
     * Task kind axis — orthogonal to `type`. Defaults to `'work'`.
     * See {@link TASK_KINDS}. Added by T944. DB column named `role` (T9067 deferral).
     */
    kind: text('role', { enum: TASK_KINDS }).notNull().default('work'),
    /**
     * Task scope axis — granularity of the work. Defaults to `'feature'`.
     * See {@link TASK_SCOPES}. Added by T944.
     */
    scope: text('scope', { enum: TASK_SCOPES }).notNull().default('feature'),
    /**
     * Severity level. Valid for any kind (widened from bug-only by T9073).
     * DB column 'role' preserved with drizzle alias for kind. OWNER-WRITE-ONLY.
     * See {@link TASK_SEVERITIES}. Added by T944, widened by T9073.
     */
    severity: text('severity', { enum: TASK_SEVERITIES }),
    parentId: text('parent_id').references((): AnySQLiteColumn => tasks.id, {
      onDelete: 'set null',
    }),
    phase: text('phase'),
    size: text('size', { enum: TASK_SIZES }),
    position: integer('position'),
    positionVersion: integer('position_version').default(0),

    // JSON-serialized complex fields (avoids excessive normalization)
    labelsJson: text('labels_json').default('[]'),
    notesJson: text('notes_json').default('[]'),
    acceptanceJson: text('acceptance_json').default('[]'),
    filesJson: text('files_json').default('[]'),

    // Provenance — T1899: typed CHECK constraint (production|test-fixture|imported|migrated)
    origin: text('origin'),
    blockedBy: text('blocked_by'),
    epicLifecycle: text('epic_lifecycle'),
    noAutoComplete: integer('no_auto_complete', { mode: 'boolean' }),

    // Timestamps
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),
    completedAt: text('completed_at'),
    cancelledAt: text('cancelled_at'),
    cancellationReason: text('cancellation_reason'),

    // Archive metadata (populated when status = 'archived')
    archivedAt: text('archived_at'),
    /**
     * Truth-grade archive reason. SQL-layer storage remains TEXT; the
     * 6-value enum is enforced by a CHECK constraint applied in migration
     * `20260424000000_t1408-archive-reason-enum`.
     *
     * @task T1408
     */
    archiveReason: text('archive_reason'),
    cycleTimeDays: integer('cycle_time_days'),

    // Verification (JSON-serialized)
    verificationJson: text('verification_json'),

    // Provenance tracking
    createdBy: text('created_by'),
    modifiedBy: text('modified_by'),
    sessionId: text('session_id').references((): AnySQLiteColumn => sessions.id, {
      onDelete: 'set null',
    }),
    // T060: pipeline stage name (RCASD-IVTR+C). Stored as a plain stage name string.
    pipelineStage: text('pipeline_stage'),
    /** Agent ID that has claimed/is assigned to this task. */
    assignee: text('assignee'),
    // IVTR orchestration state — nullable JSON blob. NULL = no loop started. @task T811
    ivtrState: text('ivtr_state'),
  },
  (table) => [
    index('idx_tasks_status').on(table.status),
    index('idx_tasks_parent_id').on(table.parentId),
    index('idx_tasks_phase').on(table.phase),
    index('idx_tasks_type').on(table.type),
    index('idx_tasks_priority').on(table.priority),
    index('idx_tasks_session_id').on(table.sessionId),
    index('idx_tasks_pipeline_stage').on(table.pipelineStage),
    index('idx_tasks_assignee').on(table.assignee),
    // T033 composite indexes
    index('idx_tasks_parent_status').on(table.parentId, table.status),
    index('idx_tasks_status_priority').on(table.status, table.priority),
    index('idx_tasks_type_phase').on(table.type, table.phase),
    index('idx_tasks_status_archive_reason').on(table.status, table.archiveReason),
    // T944 kind/scope axes (T9072: TS field renamed role→kind; DB column stays 'role')
    index('idx_tasks_role').on(table.kind),
    index('idx_tasks_scope').on(table.scope),
    index('idx_tasks_role_status').on(table.kind, table.status),
    // T1126 / T1174 — partial index now schema-expressed.
    index('idx_tasks_sentient_proposals_today')
      .on(sql`date(${table.createdAt})`)
      .where(sql`${table.labelsJson} LIKE '%sentient-tier2%'`),
  ],
);

// === TASK DEPENDENCIES ===

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOn: text('depends_on')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOn] }),
    index('idx_deps_depends_on').on(table.dependsOn),
  ],
);

// === TASK RELATIONS ===

export const taskRelations = sqliteTable(
  'task_relations',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    relatedTo: text('related_to')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    relationType: text('relation_type', {
      enum: TASK_RELATION_TYPES,
    })
      .notNull()
      .default('related'),
    reason: text('reason'),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.relatedTo] }),
    index('idx_task_relations_related_to').on(table.relatedTo),
  ],
);

// === SESSIONS ===

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    status: text('status', {
      enum: SESSION_STATUSES,
    })
      .notNull()
      .default('active'),
    scopeJson: text('scope_json').notNull().default('{}'),
    currentTask: text('current_task').references((): AnySQLiteColumn => tasks.id, {
      onDelete: 'set null',
    }),
    taskStartedAt: text('task_started_at'),
    agent: text('agent'),
    notesJson: text('notes_json').default('[]'),
    tasksCompletedJson: text('tasks_completed_json').default('[]'),
    tasksCreatedJson: text('tasks_created_json').default('[]'),
    handoffJson: text('handoff_json'),
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
    endedAt: text('ended_at'),
    // Session chain columns (T4959)
    previousSessionId: text('previous_session_id').references((): AnySQLiteColumn => sessions.id, {
      onDelete: 'set null',
    }),
    nextSessionId: text('next_session_id').references((): AnySQLiteColumn => sessions.id, {
      onDelete: 'set null',
    }),
    agentIdentifier: text('agent_identifier'),
    handoffConsumedAt: text('handoff_consumed_at'),
    handoffConsumedBy: text('handoff_consumed_by'),
    debriefJson: text('debrief_json'),
    // Provider adapter tracking (T5240)
    providerId: text('provider_id'),
    // Session stats columns (type unification)
    statsJson: text('stats_json'),
    resumeCount: integer('resume_count'),
    gradeMode: integer('grade_mode'),
    // Owner-auth HMAC token for L4a override authentication (T1118)
    ownerAuthToken: text('owner_auth_token'),
    // T9975 — per-agent session isolation columns
    /** Human-readable agent tag (e.g. "agent-A") for multi-agent isolation. */
    agentHandle: text('agent_handle'),
    /** Denormalised scope type ("global" | "epic") — avoids JSON parsing in hot paths. */
    scopeKind: text('scope_kind'),
    /** Denormalised scope target ID (e.g. "T9964" for epic sessions). NULL for global. */
    scopeId: text('scope_id'),
    /** ISO 8601 timestamp of the last mutation — used by idle auto-end hook. */
    lastActivity: text('last_activity'),
  },
  (table) => [
    index('idx_sessions_status').on(table.status),
    index('idx_sessions_previous').on(table.previousSessionId),
    index('idx_sessions_agent_identifier').on(table.agentIdentifier),
    index('idx_sessions_started_at').on(table.startedAt),
    // T033 composite index: getActiveSession hot path
    index('idx_sessions_status_started_at').on(table.status, table.startedAt),
    // T9975 — per-agent session isolation indexes
    index('idx_sessions_agent_handle').on(table.agentHandle),
    index('idx_sessions_scope_kind_id').on(table.scopeKind, table.scopeId),
  ],
);

// === SESSION HANDOFF ENTRIES (T1609 — append-only, write-once) ===

/**
 * Write-once handoff log for sessions.
 *
 * Each session may have AT MOST ONE handoff entry (UNIQUE on session_id).
 *
 * @task T1609
 */
export const sessionHandoffEntries = sqliteTable(
  'session_handoff_entries',
  {
    /** Auto-increment surrogate key — sessions are addressed by sessionId UNIQUE. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** FK → sessions.id.  UNIQUE enforces one-handoff-per-session. */
    sessionId: text('session_id')
      .notNull()
      .unique()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Serialised HandoffData (or DebriefData) JSON blob. */
    handoffJson: text('handoff_json').notNull(),
    /** Wall-clock instant this entry was created. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_session_handoff_session_id').on(table.sessionId)],
);

// === TASK WORK HISTORY ===

export const taskWorkHistory = sqliteTable(
  'task_work_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    setAt: text('set_at').notNull().default(sql`(datetime('now'))`),
    clearedAt: text('cleared_at'),
  },
  (table) => [index('idx_work_history_session').on(table.sessionId)],
);

// === EXTERNAL TASK LINKS (provider-agnostic task reconciliation) ===

/**
 * Tracks links between CLEO tasks and external system tasks (Linear, Jira, GitHub, etc.).
 * Used by the reconciliation engine to match external tasks to existing CLEO tasks,
 * detect updates, and maintain bidirectional traceability.
 */
export const externalTaskLinks = sqliteTable(
  'external_task_links',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Provider identifier (e.g. 'linear', 'jira', 'github', 'gitlab'). */
    providerId: text('provider_id').notNull(),
    /** Provider-assigned identifier for the external task (opaque to CLEO). */
    externalId: text('external_id').notNull(),
    /** Optional URL to the external task (for human navigation). */
    externalUrl: text('external_url'),
    /** Title of the external task at the time of last sync. */
    externalTitle: text('external_title'),
    /** How this link was established. */
    linkType: text('link_type', {
      enum: EXTERNAL_LINK_TYPES,
    }).notNull(),
    /** Direction of the sync that created this link. */
    syncDirection: text('sync_direction', {
      enum: SYNC_DIRECTIONS,
    })
      .notNull()
      .default('inbound'),
    /** Arbitrary provider-specific metadata (JSON). */
    metadataJson: text('metadata_json').default('{}'),
    /** When the link was first established. */
    linkedAt: text('linked_at').notNull().default(sql`(datetime('now'))`),
    /** When the external task was last synchronized. */
    lastSyncAt: text('last_sync_at'),
  },
  (table) => [
    index('idx_ext_links_task_id').on(table.taskId),
    index('idx_ext_links_provider_external').on(table.providerId, table.externalId),
    index('idx_ext_links_provider_id').on(table.providerId),
    unique('uq_ext_links_task_provider_external').on(
      table.taskId,
      table.providerId,
      table.externalId,
    ),
  ],
);

// === TYPE EXPORTS ===

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type TaskRelationRow = typeof taskRelations.$inferSelect;
export type WorkHistoryRow = typeof taskWorkHistory.$inferSelect;
export type ExternalTaskLinkRow = typeof externalTaskLinks.$inferSelect;
export type NewExternalTaskLinkRow = typeof externalTaskLinks.$inferInsert;
