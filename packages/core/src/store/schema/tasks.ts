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

/**
 * Task types matching DB CHECK constraint on tasks.type.
 *
 * Per ADR-083 §2.5, `'saga'` is a first-class tier discriminator above
 * Epic. The contracts SSoT (`packages/contracts/src/task.ts` line 45)
 * was widened to include `'saga'` by T10328; this constant mirrors it
 * so Drizzle's row-type narrowing stays aligned across the codebase.
 *
 * The DB-layer CHECK constraint enforcing this enum (plus the ADR-073
 * §1.2 I5 invariant `CHECK (type != 'saga' OR parent_id IS NULL)`) is
 * installed by `20260523213708_t10277-saga-tasktype/migration.sql`
 * (T10329, Saga T10326 W1.B).
 *
 * @adr ADR-083 §2.5
 * @adr ADR-073 §1.2 I5
 * @saga T10326
 * @task T10328
 * @task T10329
 */
export const TASK_TYPES = ['saga', 'epic', 'task', 'subtask'] as const;

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

// === TASK ACCEPTANCE CRITERIA (T10502 · ADR-079-r1) ===

/**
 * Acceptance criteria stored as first-class rows (one row per AC clause),
 * replacing the legacy JSON-array `tasks.acceptanceJson` column for new
 * writes per ADR-079-r1 §2.1 + §2.2 (Saga T10377 SG-IVTR-AC-BINDING,
 * Epic T10381 E-AC-MIGRATION, Task T10502 Wave 2a).
 *
 * Identity model:
 *   - `id` is a canonical UUIDv4 generated at creation (`crypto.randomUUID()`).
 *     Immutable across edits; binds Validator verdicts, `satisfies:` evidence
 *     atoms, and CI gate references.
 *   - `ordinal` is the 1-based positional alias (`AC<n>`) for human + agent
 *     display. Monotonic per-task insertion order, **never reused** when an
 *     AC is deleted (per §2.2: deletion leaves a gap, never back-fills).
 *
 * The UNIQUE INDEX on (taskId, ordinal) guarantees no two ACs on the same
 * task share an ordinal — protecting the alias-resolution path used by
 * spawn prompts and `cleo show`.
 *
 * `contentHash` is an optional sha256(text) snapshot used by the future
 * `_history` companion table (§2.3) for drift detection on text edits.
 * Writers MAY leave it NULL; readers MUST treat NULL as "drift detection
 * unavailable" rather than as "text unchanged".
 *
 * Subsequent waves in T10381 add `task_acceptance_criteria_history`
 * (T10503) and `evidence_ac_bindings` (T10504) — this PR establishes the
 * canonical AC table the others reference via FK.
 *
 * @adr  ADR-079-r1 §2.1 §2.2 §4.2
 * @saga T10377
 * @epic T10381
 * @task T10502
 * @decision D013
 */
export const taskAcceptanceCriteria = sqliteTable(
  'task_acceptance_criteria',
  {
    /** Canonical stable ID — UUIDv4 generated at AC creation, immutable. */
    id: text('id').primaryKey(),
    /** Owning task. ON DELETE CASCADE — ACs are owned by the task lifecycle. */
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** 1-based insertion-order alias used by the AC<n> display label. */
    ordinal: integer('ordinal').notNull(),
    /** Typed completion criterion discriminator per ADR-088. */
    kind: text('kind', { enum: ['text', 'child_task', 'evidence_bound'] })
      .notNull()
      .default('text'),
    /** Stable per-task source key for idempotent criteria projection/upsert. */
    sourceKey: text('source_key'),
    /** Optional child task target; only `kind='child_task'` may populate it. */
    targetTaskId: text('target_task_id').references((): AnySQLiteColumn => tasks.id, {
      onDelete: 'set null',
    }),
    /** Compatibility projection owner (for example: legacy, direct, parent-child). */
    projection: text('projection').notNull().default('legacy'),
    /** The AC statement itself — editable; edits append to _history (T10503). */
    text: text('text').notNull(),
    /** ISO-8601 creation timestamp. */
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    /** ISO-8601 last-edit timestamp. NULL until first edit. */
    updatedAt: text('updated_at'),
    /** Optional sha256(text) snapshot — populated by writers for drift detection. */
    contentHash: text('content_hash'),
  },
  (table) => [
    // FK lookup path — `WHERE task_id = ?` is the dominant access pattern.
    index('idx_task_acceptance_criteria_task_id').on(table.taskId),
    index('idx_task_acceptance_criteria_target_task_id').on(table.targetTaskId),
    // Alias-resolution + invariant: no two ACs share an ordinal on the same task.
    unique('uq_task_acceptance_criteria_task_ordinal').on(table.taskId, table.ordinal),
    // PM-Core V2 typed criteria idempotency: each source projection is unique per task.
    unique('uq_task_acceptance_criteria_task_source_key').on(table.taskId, table.sourceKey),
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

// === TASK ACCEPTANCE CRITERIA HISTORY (T10504 · Saga T10377 SG-IVTR-AC-BINDING) ===

/**
 * Recognised values for {@link taskAcceptanceCriteriaHistory.reason}.
 *
 * Treated as an enum-ish discriminator at the application layer — NOT
 * enforced by a SQL CHECK constraint. The history table is forward-only,
 * and locking new reason codes behind a migration would block legitimate
 * future event kinds (e.g. saga-merge, evidence-rebind) without buying
 * any storage-level safety.
 *
 * @see {@link taskAcceptanceCriteriaHistory}
 * @task T10504
 */
export const AC_HISTORY_REASONS = ['drift', 'edit', 'backfill', 'cancel', 'restore'] as const;

/** Union type for {@link AC_HISTORY_REASONS}. */
export type AcHistoryReason = (typeof AC_HISTORY_REASONS)[number];

/**
 * Append-only retention log of acceptance-criterion text changes.
 *
 * Each row captures the AC body that was REPLACED by an edit (or wiped
 * by a cancel, restored on un-cancel, etc.). The current AC text always
 * lives on the live `task_acceptance_criteria` row (added by sibling
 * task T10502 — `task_acceptance_criteria`). This table answers:
 *
 *   - "Show me the most recent drift event for AC X" (idx + LIMIT 1)
 *   - "Was this AC text ever in the form recorded by evidence atom Y?"
 *   - "How many times has this AC drifted since the bound atom was recorded?"
 *
 * ## Why no FK on acId
 *
 * `acId` is INTENTIONALLY NOT declared `REFERENCES task_acceptance_criteria(id)`.
 * AC rows can be deleted (e.g. when their parent task is cancelled and the
 * task-level cascade fires, or when an entire AC is removed by an explicit
 * edit). The drift forensics use-case requires the history to outlive the
 * AC row — a deleted AC's history must remain queryable so we can answer
 * "did this AC ever exist?" after the live row is gone.
 *
 * Per T10494 / decision D013 (research doc `ac-history-model-decision`),
 * this is a deliberate denormalisation: orphan rows are accepted as the
 * cost of unbounded auditability.
 *
 * ## Why INTEGER AUTOINCREMENT primary key
 *
 * High-volume append-only log. Sequential integer PKs are ~2× faster than
 * UUIDs for the dominant access pattern (sequential insert, scan by acId).
 * The PK is opaque — no consumer is expected to address rows by `id`; the
 * `(acId, recordedAt DESC)` index drives the only read path.
 *
 * @adr ADR-079-r1 §D6 (drift detection model)
 * @task T10504
 * @epic T10381
 * @saga T10377
 * @decision D013
 */
export const taskAcceptanceCriteriaHistory = sqliteTable(
  'task_acceptance_criteria_history',
  {
    /** Surrogate auto-increment PK — opaque, never addressed by consumers. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /**
     * Reference to the AC that was changed. INTENTIONALLY NOT a foreign
     * key so history rows survive AC deletion (drift forensics).
     */
    acId: text('ac_id').notNull(),
    /** ISO 8601 wall-clock instant the change was recorded. */
    recordedAt: text('recorded_at').notNull().default(sql`(datetime('now'))`),
    /** The AC text BEFORE this change — i.e. the value being superseded. */
    previousText: text('previous_text').notNull(),
    /**
     * Why this history row was written. See {@link AC_HISTORY_REASONS}
     * for canonical values; storage is plain TEXT to allow future event
     * kinds without a schema migration.
     */
    reason: text('reason').notNull(),
  },
  (table) => [
    // Drives the dominant read: "fetch latest drift events for AC X first."
    // DESC ordering on recorded_at is load-bearing for the LIMIT 1 latest
    // lookup — expressed via raw SQL because drizzle's index DSL does not
    // surface per-column sort direction in the IndexColumn type.
    index('idx_ac_history_ac_id_recorded_at').on(table.acId, sql`${table.recordedAt} desc`),
  ],
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
export type TaskAcceptanceCriteriaHistoryRow = typeof taskAcceptanceCriteriaHistory.$inferSelect;
export type NewTaskAcceptanceCriteriaHistoryRow = typeof taskAcceptanceCriteriaHistory.$inferInsert;
