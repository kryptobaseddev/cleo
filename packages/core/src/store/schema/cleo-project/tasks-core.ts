/**
 * Project-scope `cleo.db` — consolidated **tasks-core** domain (13 tables).
 *
 * Part of the consolidated PROJECT-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11360). Target-shape
 * authoring only — physical names carry the `tasks_` domain prefix. The live
 * runtime module `schema/tasks.ts` keeps its UNPREFIXED names (`tasks`,
 * `sessions`, …) until the exodus migration (T11248) swaps the substrate; the
 * migration-baseline test asserts the live existence table `tasks` (NOT
 * `tasks_tasks`), so the live names must not change in-place.
 *
 * This is the canonical `tasks` → `tasks_tasks` table (AC1's named example) plus
 * its core satellites:
 *   tasks_tasks · tasks_task_acceptance_criteria ·
 *   tasks_acceptance_projection_state · tasks_acceptance_projection_dirty ·
 *   tasks_task_dependencies · tasks_task_relations · tasks_sessions ·
 *   tasks_session_handoff_entries · tasks_task_work_history ·
 *   tasks_task_acceptance_criteria_history · tasks_external_task_links.
 * (The `tasks_task_labels` junction was authored in batch 2.)
 *
 * ## E10 §3 — booleans
 *
 * - `tasks.no_auto_complete` already `integer({ mode: 'boolean' })` (§3a) — preserved.
 * - **`sessions.grade_mode` (§3b non-conformer) → `integer({ mode: 'boolean' })`.**
 *   §8.2 flags that E2 MUST confirm it is genuinely 0/1 (vs multi-state) before
 *   applying the CHECK. RESOLVED by reading the writer/readers: the TS type is
 *   `gradeMode?: boolean` (`sessions/types.ts`, `dispatch/.../session-context.ts`);
 *   the writer (`store/db-helpers.ts`) writes `session.gradeMode ? 1 : null`; the
 *   reader (`store/converters.ts`) does `Boolean(row.gradeMode)`; every consumer
 *   treats it as a 2-state boolean. So it is a genuine nullable boolean, NOT an
 *   enum — modelled as nullable `integer({ mode: 'boolean' })` with a safe
 *   `CHECK (grade_mode IN (0,1))` at exodus. This resolves §8 item 2.
 *
 * ## E10 §4 / §5 / §6a
 *
 * - All timestamps are already canonical TEXT ISO8601 (no epoch non-conformers).
 * - All enum columns already carry `{ enum }` narrowing from named const arrays
 *   (task status/priority/type/kind/scope/severity/size/archive_reason,
 *   session status, relation_type, AC kind, projection status/reason, external
 *   link_type/sync_direction) referenced by identifier (§5a). The inline-literal
 *   `task_acceptance_criteria.kind` and `task_acceptance_criteria_history.reason`
 *   (forward-only log) are promoted to / kept as named const arrays where safe.
 * - JSON columns (labels/notes/acceptance/files/verification on tasks;
 *   scope/notes/handoff/debrief/stats/tasks_*_json on sessions; metadata on
 *   external links; payload on projection-dirty) stay serialized TEXT per the
 *   JSON-Column Audit. No new JSON pattern is invented (the labels-membership
 *   junction lives in batch 2 as `tasks_task_labels`).
 *
 * Self-referential FKs (`tasks.parent_id`, session chain prev/next) and
 * intra-domain FKs are real `.references()`; the live cross-domain references
 * resolve within this same file once exodus consolidates.
 *
 * **§7 idempotency (Pattern A · T11362):** `tasks_tasks` gains a nullable
 * `idempotency_key TEXT` + UNIQUE so a sentient propose / stage-drift re-tick
 * create coalesces via `onConflictDoNothing` (replacing the interim
 * `notes_json LIKE '%dedupHash%'` scan). UNIQUE ignores NULL keys, so only
 * keyed writes dedup; the grain is the project `cleo.db`.
 *
 * @task T11360 · T11362 (§7 idempotency key)
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §3 · §4 · §5 · §6a · §7 · §8.2
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

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
import { SESSION_STATUSES, TASK_STATUSES } from '../../status-registry.js';
import {
  ACCEPTANCE_PROJECTION_DIRTY_REASONS,
  ACCEPTANCE_PROJECTION_STATUSES,
  EXTERNAL_LINK_TYPES,
  SYNC_DIRECTIONS,
  TASK_PRIORITIES,
  TASK_TYPES,
} from '../tasks.js';

/** Typed-criterion discriminator — promoted from the inline literal (§5a). */
export const TASK_AC_KINDS = ['text', 'child_task', 'evidence_bound'] as const;

/**
 * `tasks_tasks` — the canonical task table (AC1's named example, `tasks` →
 * `tasks_tasks`).
 *
 * @task T11360 (target shape) · T4454 (original)
 */
export const tasksTasks = sqliteTable(
  'tasks_tasks',
  {
    /** Task id. */
    id: text('id').primaryKey(),
    /** Task title. */
    title: text('title').notNull(),
    /** Task description. */
    description: text('description'),
    /** Status — CHECK-backed via {@link TASK_STATUSES}. */
    status: text('status', { enum: TASK_STATUSES }).notNull().default('pending'),
    /** Priority — CHECK-backed via {@link TASK_PRIORITIES}. */
    priority: text('priority', { enum: TASK_PRIORITIES }).notNull().default('medium'),
    /** Tier discriminator — CHECK-backed via {@link TASK_TYPES}. */
    type: text('type', { enum: TASK_TYPES }),
    /** Kind axis — CHECK-backed via {@link TASK_KINDS}. DB column named `role`. */
    kind: text('role', { enum: TASK_KINDS }).notNull().default('work'),
    /** Scope axis — CHECK-backed via {@link TASK_SCOPES}. */
    scope: text('scope', { enum: TASK_SCOPES }).notNull().default('feature'),
    /** Severity — CHECK-backed via {@link TASK_SEVERITIES}. */
    severity: text('severity', { enum: TASK_SEVERITIES }),
    /** Containment edge — self-FK → `tasks_tasks.id`. */
    parentId: text('parent_id').references((): AnySQLiteColumn => tasksTasks.id, {
      onDelete: 'set null',
    }),
    /** Phase tag. */
    phase: text('phase'),
    /** Size — CHECK-backed via {@link TASK_SIZES}. */
    size: text('size', { enum: TASK_SIZES }),
    /** Manual ordering position. */
    position: integer('position'),
    /** Position optimistic-concurrency version. */
    positionVersion: integer('position_version').default(0),
    /** JSON label array (TEXT per JSON audit; membership junction = tasks_task_labels). */
    labelsJson: text('labels_json').default('[]'),
    /** JSON notes array (TEXT per JSON audit). */
    notesJson: text('notes_json').default('[]'),
    /** Legacy JSON AC storage (TEXT per JSON audit). */
    acceptanceJson: text('acceptance_json').default('[]'),
    /** JSON files array (TEXT per JSON audit). */
    filesJson: text('files_json').default('[]'),
    /** Provenance origin tag. */
    origin: text('origin'),
    /** Free-text blocked-by reason. */
    blockedBy: text('blocked_by'),
    /** Epic lifecycle tag. */
    epicLifecycle: text('epic_lifecycle'),
    /** Whether auto-complete is suppressed. §3a boolean — already typed, preserved. */
    noAutoComplete: integer('no_auto_complete', { mode: 'boolean' }),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
    /** ISO-8601 UTC completion instant (canonical TEXT, §4). */
    completedAt: text('completed_at'),
    /** ISO-8601 UTC cancellation instant (canonical TEXT, §4). */
    cancelledAt: text('cancelled_at'),
    /** Cancellation reason. */
    cancellationReason: text('cancellation_reason'),
    /** ISO-8601 UTC archive instant (canonical TEXT, §4). */
    archivedAt: text('archived_at'),
    /** Archive reason — CHECK-backed via {@link ARCHIVE_REASONS}. */
    archiveReason: text('archive_reason', { enum: ARCHIVE_REASONS }),
    /** Cycle time in days. */
    cycleTimeDays: integer('cycle_time_days'),
    /** JSON verification payload (TEXT per JSON audit). */
    verificationJson: text('verification_json'),
    /** Creator identity. */
    createdBy: text('created_by'),
    /** Last-modifier identity. */
    modifiedBy: text('modified_by'),
    /** FK → `tasks_sessions.id`. */
    sessionId: text('session_id').references((): AnySQLiteColumn => tasksSessions.id, {
      onDelete: 'set null',
    }),
    /** Pipeline stage name. */
    pipelineStage: text('pipeline_stage'),
    /** Assignee agent id. */
    assignee: text('assignee'),
    /** JSON IVTR orchestration state (TEXT per JSON audit). */
    ivtrState: text('ivtr_state'),
    /**
     * Caller-supplied stable idempotency key (§7 Pattern A); NULL for legacy /
     * non-agent task creates. Sentient propose / stage-drift re-ticks set it so
     * a retried create is a no-op via `onConflictDoNothing` (replaces the interim
     * `notes_json LIKE '%dedupHash%'` scan). UNIQUE ignores NULLs in SQLite, so
     * only keyed writes dedup; the dedup scope is the project `cleo.db` file.
     */
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [
    index('idx_tasks_tasks_status').on(table.status),
    index('idx_tasks_tasks_parent_id').on(table.parentId),
    index('idx_tasks_tasks_phase').on(table.phase),
    index('idx_tasks_tasks_type').on(table.type),
    index('idx_tasks_tasks_priority').on(table.priority),
    index('idx_tasks_tasks_session_id').on(table.sessionId),
    index('idx_tasks_tasks_pipeline_stage').on(table.pipelineStage),
    index('idx_tasks_tasks_assignee').on(table.assignee),
    index('idx_tasks_tasks_parent_status').on(table.parentId, table.status),
    index('idx_tasks_tasks_status_priority').on(table.status, table.priority),
    index('idx_tasks_tasks_type_phase').on(table.type, table.phase),
    index('idx_tasks_tasks_status_archive_reason').on(table.status, table.archiveReason),
    index('idx_tasks_tasks_role').on(table.kind),
    index('idx_tasks_tasks_scope').on(table.scope),
    index('idx_tasks_tasks_role_status').on(table.kind, table.status),
    index('idx_tasks_tasks_created_date').on(sql`date(${table.createdAt})`),
    unique('uq_tasks_tasks_idempotency_key').on(table.idempotencyKey),
  ],
);

/**
 * `tasks_task_acceptance_criteria` — first-class AC rows (ADR-079-r1).
 *
 * @task T11360 (target shape) · T10502 (original)
 */
export const tasksTaskAcceptanceCriteria = sqliteTable(
  'tasks_task_acceptance_criteria',
  {
    /** Canonical stable AC id. */
    id: text('id').primaryKey(),
    /** FK → `tasks_tasks.id`. ON DELETE CASCADE. */
    taskId: text('task_id')
      .notNull()
      .references(() => tasksTasks.id, { onDelete: 'cascade' }),
    /** 1-based display ordinal. */
    ordinal: integer('ordinal').notNull(),
    /** Criterion kind — CHECK-backed via {@link TASK_AC_KINDS} (§5a). */
    kind: text('kind', { enum: TASK_AC_KINDS }).notNull().default('text'),
    /** Stable per-task source key for idempotent projection. */
    sourceKey: text('source_key'),
    /** Optional child-task target (FK → `tasks_tasks.id`). */
    targetTaskId: text('target_task_id').references((): AnySQLiteColumn => tasksTasks.id, {
      onDelete: 'set null',
    }),
    /** Compatibility projection owner. */
    projection: text('projection').notNull().default('legacy'),
    /** The AC statement. */
    text: text('text').notNull(),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    /** ISO-8601 UTC last-edit instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
    /** Optional sha256(text) drift snapshot. */
    contentHash: text('content_hash'),
  },
  (table) => [
    index('idx_tasks_task_acceptance_criteria_task_id').on(table.taskId),
    index('idx_tasks_task_acceptance_criteria_target_task_id').on(table.targetTaskId),
    unique('uq_tasks_task_acceptance_criteria_task_ordinal').on(table.taskId, table.ordinal),
    unique('uq_tasks_task_acceptance_criteria_task_source_key').on(table.taskId, table.sourceKey),
  ],
);

/**
 * `tasks_acceptance_projection_state` — per-projection freshness state.
 *
 * @task T11360 (target shape) · T10570 (original)
 */
export const tasksAcceptanceProjectionState = sqliteTable(
  'tasks_acceptance_projection_state',
  {
    /** Stable projection key. */
    projectionKey: text('projection_key').primaryKey(),
    /** Projection contract version. */
    schemaVersion: integer('schema_version').notNull().default(1),
    /** Freshness — CHECK-backed via {@link ACCEPTANCE_PROJECTION_STATUSES}. */
    status: text('status', { enum: ACCEPTANCE_PROJECTION_STATUSES }).notNull().default('fresh'),
    /** ISO-8601 UTC last-rebuild instant (canonical TEXT, §4). */
    lastProjectedAt: text('last_projected_at'),
    /** ISO-8601 UTC max-source-update observed (canonical TEXT, §4). */
    lastSourceUpdatedAt: text('last_source_updated_at'),
    /** Source frontier fingerprint. */
    sourceFingerprint: text('source_fingerprint'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
  },
  (table) => [
    index('idx_tasks_acceptance_projection_state_status_freshness').on(
      table.status,
      table.lastSourceUpdatedAt,
      table.lastProjectedAt,
    ),
  ],
);

/**
 * `tasks_acceptance_projection_dirty` — per-task projection dirty queue.
 *
 * @task T11360 (target shape) · T10570 (original)
 */
export const tasksAcceptanceProjectionDirty = sqliteTable(
  'tasks_acceptance_projection_dirty',
  {
    /** FK → `tasks_acceptance_projection_state.projection_key`. ON DELETE CASCADE. */
    projectionKey: text('projection_key')
      .notNull()
      .references(() => tasksAcceptanceProjectionState.projectionKey, { onDelete: 'cascade' }),
    /** FK → `tasks_tasks.id`. ON DELETE CASCADE. */
    taskId: text('task_id')
      .notNull()
      .references(() => tasksTasks.id, { onDelete: 'cascade' }),
    /** Invalidation reason — CHECK-backed via {@link ACCEPTANCE_PROJECTION_DIRTY_REASONS}. */
    reason: text('reason', { enum: ACCEPTANCE_PROJECTION_DIRTY_REASONS })
      .notNull()
      .default('manual_rebuild'),
    /** ISO-8601 UTC source-update that triggered this (canonical TEXT, §4). */
    sourceUpdatedAt: text('source_updated_at'),
    /** ISO-8601 UTC queue-insertion instant (canonical TEXT, §4). */
    queuedAt: text('queued_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
    /** JSON producer context (TEXT per JSON audit). */
    payloadJson: text('payload_json'),
  },
  (table) => [
    primaryKey({ columns: [table.projectionKey, table.taskId] }),
    index('idx_tasks_acceptance_projection_dirty_task_id').on(table.taskId),
    index('idx_tasks_acceptance_projection_dirty_queued_at').on(table.queuedAt),
  ],
);

/**
 * `tasks_task_dependencies` — blocking-dependency edges.
 *
 * @task T11360 (target shape)
 */
export const tasksTaskDependencies = sqliteTable(
  'tasks_task_dependencies',
  {
    /** FK → `tasks_tasks.id`. ON DELETE CASCADE. */
    taskId: text('task_id')
      .notNull()
      .references(() => tasksTasks.id, { onDelete: 'cascade' }),
    /** FK → `tasks_tasks.id` (the dependency). ON DELETE CASCADE. */
    dependsOn: text('depends_on')
      .notNull()
      .references(() => tasksTasks.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOn] }),
    index('idx_tasks_task_dependencies_depends_on').on(table.dependsOn),
  ],
);

/**
 * `tasks_task_relations` — non-containment edge graph.
 *
 * @task T11360 (target shape)
 */
export const tasksTaskRelations = sqliteTable(
  'tasks_task_relations',
  {
    /** FK → `tasks_tasks.id`. ON DELETE CASCADE. */
    taskId: text('task_id')
      .notNull()
      .references(() => tasksTasks.id, { onDelete: 'cascade' }),
    /** FK → `tasks_tasks.id` (the related task). ON DELETE CASCADE. */
    relatedTo: text('related_to')
      .notNull()
      .references(() => tasksTasks.id, { onDelete: 'cascade' }),
    /** Relation type — CHECK-backed via {@link TASK_RELATION_TYPES}. */
    relationType: text('relation_type', { enum: TASK_RELATION_TYPES }).notNull().default('related'),
    /** Optional reason. */
    reason: text('reason'),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.relatedTo, table.relationType] }),
    index('idx_tasks_task_relations_task_id_relation_type').on(table.taskId, table.relationType),
    index('idx_tasks_task_relations_related_to_relation_type').on(
      table.relatedTo,
      table.relationType,
    ),
    index('idx_tasks_task_relations_relation_type').on(table.relationType),
  ],
);

/**
 * `tasks_sessions` — work sessions.
 *
 * @task T11360 (target shape)
 */
export const tasksSessions = sqliteTable(
  'tasks_sessions',
  {
    /** Session id. */
    id: text('id').primaryKey(),
    /** Session name. */
    name: text('name').notNull(),
    /** Status — CHECK-backed via {@link SESSION_STATUSES}. */
    status: text('status', { enum: SESSION_STATUSES }).notNull().default('active'),
    /** JSON scope object (TEXT per JSON audit; empty-object default). */
    scopeJson: text('scope_json').notNull().default('{}'),
    /** Current task pointer (FK → `tasks_tasks.id`). */
    currentTask: text('current_task').references((): AnySQLiteColumn => tasksTasks.id, {
      onDelete: 'set null',
    }),
    /** ISO-8601 UTC task-start instant (canonical TEXT, §4). */
    taskStartedAt: text('task_started_at'),
    /** Agent name. */
    agent: text('agent'),
    /** JSON notes array (TEXT per JSON audit). */
    notesJson: text('notes_json').default('[]'),
    /** JSON completed-task ids (TEXT per JSON audit). */
    tasksCompletedJson: text('tasks_completed_json').default('[]'),
    /** JSON created-task ids (TEXT per JSON audit). */
    tasksCreatedJson: text('tasks_created_json').default('[]'),
    /** JSON handoff payload (TEXT per JSON audit). */
    handoffJson: text('handoff_json'),
    /** ISO-8601 UTC start instant (canonical TEXT, §4). */
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC end instant (canonical TEXT, §4). */
    endedAt: text('ended_at'),
    /** Previous session pointer (self-FK). */
    previousSessionId: text('previous_session_id').references(
      (): AnySQLiteColumn => tasksSessions.id,
      { onDelete: 'set null' },
    ),
    /** Next session pointer (self-FK). */
    nextSessionId: text('next_session_id').references((): AnySQLiteColumn => tasksSessions.id, {
      onDelete: 'set null',
    }),
    /**
     * Fork-tree PARENT session pointer (self-FK). Distinct from
     * `previousSessionId` (the linear resume chain): `parentSessionId` is the
     * orchestrator→worker spawn edge, sourced from `CLEO_PARENT_SESSION_ID`
     * (stamped by the supervisor — T11629 / PR #996) at session start. NULL for a
     * root session with no spawning parent. Nullable, `ON DELETE SET NULL`.
     *
     * @task T11639
     * @epic T11638
     */
    parentSessionId: text('parent_session_id').references((): AnySQLiteColumn => tasksSessions.id, {
      onDelete: 'set null',
    }),
    /** Agent identifier. */
    agentIdentifier: text('agent_identifier'),
    /** ISO-8601 UTC handoff-consumed instant (canonical TEXT, §4). */
    handoffConsumedAt: text('handoff_consumed_at'),
    /** Handoff consumer identity. */
    handoffConsumedBy: text('handoff_consumed_by'),
    /** JSON debrief payload (TEXT per JSON audit). */
    debriefJson: text('debrief_json'),
    /** Provider adapter id. */
    providerId: text('provider_id'),
    /** JSON stats payload (TEXT per JSON audit). */
    statsJson: text('stats_json'),
    /** Resume count. */
    resumeCount: integer('resume_count'),
    /**
     * Whether the session is in grade mode. §3b non-conformer → typed nullable
     * boolean (§8.2 RESOLVED: genuine 0/1, NOT multi-state — see module docs).
     */
    gradeMode: integer('grade_mode', { mode: 'boolean' }),
    /** Owner-auth HMAC token. */
    ownerAuthToken: text('owner_auth_token'),
    /** Human-readable agent tag. */
    agentHandle: text('agent_handle'),
    /** Denormalised scope type. */
    scopeKind: text('scope_kind'),
    /** Denormalised scope target id. */
    scopeId: text('scope_id'),
    /** ISO-8601 UTC last-activity instant (canonical TEXT, §4). */
    lastActivity: text('last_activity'),
  },
  (table) => [
    index('idx_tasks_sessions_status').on(table.status),
    index('idx_tasks_sessions_previous').on(table.previousSessionId),
    index('idx_tasks_sessions_parent').on(table.parentSessionId),
    index('idx_tasks_sessions_agent_identifier').on(table.agentIdentifier),
    index('idx_tasks_sessions_started_at').on(table.startedAt),
    index('idx_tasks_sessions_status_started_at').on(table.status, table.startedAt),
    index('idx_tasks_sessions_agent_handle').on(table.agentHandle),
    index('idx_tasks_sessions_scope_kind_id').on(table.scopeKind, table.scopeId),
  ],
);

/**
 * `tasks_session_handoff_entries` — write-once handoff log.
 *
 * @task T11360 (target shape) · T1609 (original)
 */
export const tasksSessionHandoffEntries = sqliteTable(
  'tasks_session_handoff_entries',
  {
    /** Auto-increment surrogate PK. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** FK → `tasks_sessions.id` (UNIQUE — one handoff per session). ON DELETE CASCADE. */
    sessionId: text('session_id')
      .notNull()
      .unique()
      .references(() => tasksSessions.id, { onDelete: 'cascade' }),
    /** Serialised handoff/debrief JSON (TEXT per JSON audit). */
    handoffJson: text('handoff_json').notNull(),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_tasks_session_handoff_entries_session_id').on(table.sessionId)],
);

/**
 * `tasks_task_work_history` — per-session task-focus history.
 *
 * @task T11360 (target shape)
 */
export const tasksTaskWorkHistory = sqliteTable(
  'tasks_task_work_history',
  {
    /** Auto-increment surrogate PK. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** FK → `tasks_sessions.id`. ON DELETE CASCADE. */
    sessionId: text('session_id')
      .notNull()
      .references(() => tasksSessions.id, { onDelete: 'cascade' }),
    /** FK → `tasks_tasks.id`. ON DELETE CASCADE. */
    taskId: text('task_id')
      .notNull()
      .references(() => tasksTasks.id, { onDelete: 'cascade' }),
    /** ISO-8601 UTC set instant (canonical TEXT, §4). */
    setAt: text('set_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC cleared instant (canonical TEXT, §4). */
    clearedAt: text('cleared_at'),
  },
  (table) => [index('idx_tasks_task_work_history_session').on(table.sessionId)],
);

/**
 * `tasks_task_acceptance_criteria_history` — append-only AC-text drift log.
 *
 * @task T11360 (target shape) · T10504 (original)
 */
export const tasksTaskAcceptanceCriteriaHistory = sqliteTable(
  'tasks_task_acceptance_criteria_history',
  {
    /** Surrogate auto-increment PK — opaque. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** AC id this row records (NOT an FK — survives AC deletion). */
    acId: text('ac_id').notNull(),
    /** ISO-8601 UTC record instant (canonical TEXT, §4). */
    recordedAt: text('recorded_at').notNull().default(sql`(datetime('now'))`),
    /** AC text BEFORE this change. */
    previousText: text('previous_text').notNull(),
    /**
     * Why this row was written. Forward-only log — stays plain TEXT (no CHECK)
     * to allow future event kinds without a migration; the `AC_HISTORY_REASONS`
     * const (`schema/tasks.ts`) is the documented canonical value set
     * (referenced, not frozen).
     */
    reason: text('reason').notNull(),
  },
  (table) => [
    index('idx_tasks_task_acceptance_criteria_history_ac_id_recorded_at').on(
      table.acId,
      sql`${table.recordedAt} desc`,
    ),
  ],
);

/**
 * `tasks_external_task_links` — links to external-system tasks.
 *
 * @task T11360 (target shape)
 */
export const tasksExternalTaskLinks = sqliteTable(
  'tasks_external_task_links',
  {
    /** Link id. */
    id: text('id').primaryKey(),
    /** FK → `tasks_tasks.id`. ON DELETE CASCADE. */
    taskId: text('task_id')
      .notNull()
      .references(() => tasksTasks.id, { onDelete: 'cascade' }),
    /** Provider identifier. */
    providerId: text('provider_id').notNull(),
    /** Provider-assigned external id. */
    externalId: text('external_id').notNull(),
    /** External task URL. */
    externalUrl: text('external_url'),
    /** External task title at last sync. */
    externalTitle: text('external_title'),
    /** Link type — CHECK-backed via {@link EXTERNAL_LINK_TYPES}. */
    linkType: text('link_type', { enum: EXTERNAL_LINK_TYPES }).notNull(),
    /** Sync direction — CHECK-backed via {@link SYNC_DIRECTIONS}. */
    syncDirection: text('sync_direction', { enum: SYNC_DIRECTIONS }).notNull().default('inbound'),
    /** JSON provider metadata (TEXT per JSON audit; empty-object default). */
    metadataJson: text('metadata_json').default('{}'),
    /** ISO-8601 UTC link-creation instant (canonical TEXT, §4). */
    linkedAt: text('linked_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-sync instant (canonical TEXT, §4). */
    lastSyncAt: text('last_sync_at'),
  },
  (table) => [
    index('idx_tasks_external_task_links_task_id').on(table.taskId),
    index('idx_tasks_external_task_links_provider_external').on(table.providerId, table.externalId),
    index('idx_tasks_external_task_links_provider_id').on(table.providerId),
    unique('uq_tasks_external_task_links_task_provider_external').on(
      table.taskId,
      table.providerId,
      table.externalId,
    ),
  ],
);

// === TYPE EXPORTS ===

/** Row type for `tasks_tasks` SELECT queries (target shape). */
export type TasksTaskRow = typeof tasksTasks.$inferSelect;
/** Row type for `tasks_tasks` INSERT operations (target shape). */
export type NewTasksTaskRow = typeof tasksTasks.$inferInsert;
/** Row type for `tasks_task_acceptance_criteria` SELECT queries (target shape). */
export type TasksTaskAcceptanceCriteriaRow = typeof tasksTaskAcceptanceCriteria.$inferSelect;
/** Row type for `tasks_task_acceptance_criteria` INSERT operations (target shape). */
export type NewTasksTaskAcceptanceCriteriaRow = typeof tasksTaskAcceptanceCriteria.$inferInsert;
/** Row type for `tasks_acceptance_projection_state` SELECT queries (target shape). */
export type TasksAcceptanceProjectionStateRow = typeof tasksAcceptanceProjectionState.$inferSelect;
/** Row type for `tasks_acceptance_projection_state` INSERT operations (target shape). */
export type NewTasksAcceptanceProjectionStateRow =
  typeof tasksAcceptanceProjectionState.$inferInsert;
/** Row type for `tasks_acceptance_projection_dirty` SELECT queries (target shape). */
export type TasksAcceptanceProjectionDirtyRow = typeof tasksAcceptanceProjectionDirty.$inferSelect;
/** Row type for `tasks_acceptance_projection_dirty` INSERT operations (target shape). */
export type NewTasksAcceptanceProjectionDirtyRow =
  typeof tasksAcceptanceProjectionDirty.$inferInsert;
/** Row type for `tasks_task_dependencies` SELECT queries (target shape). */
export type TasksTaskDependencyRow = typeof tasksTaskDependencies.$inferSelect;
/** Row type for `tasks_task_dependencies` INSERT operations (target shape). */
export type NewTasksTaskDependencyRow = typeof tasksTaskDependencies.$inferInsert;
/** Row type for `tasks_task_relations` SELECT queries (target shape). */
export type TasksTaskRelationRow = typeof tasksTaskRelations.$inferSelect;
/** Row type for `tasks_task_relations` INSERT operations (target shape). */
export type NewTasksTaskRelationRow = typeof tasksTaskRelations.$inferInsert;
/** Row type for `tasks_sessions` SELECT queries (target shape). */
export type TasksSessionRow = typeof tasksSessions.$inferSelect;
/** Row type for `tasks_sessions` INSERT operations (target shape). */
export type NewTasksSessionRow = typeof tasksSessions.$inferInsert;
/** Row type for `tasks_session_handoff_entries` SELECT queries (target shape). */
export type TasksSessionHandoffEntryRow = typeof tasksSessionHandoffEntries.$inferSelect;
/** Row type for `tasks_session_handoff_entries` INSERT operations (target shape). */
export type NewTasksSessionHandoffEntryRow = typeof tasksSessionHandoffEntries.$inferInsert;
/** Row type for `tasks_task_work_history` SELECT queries (target shape). */
export type TasksTaskWorkHistoryRow = typeof tasksTaskWorkHistory.$inferSelect;
/** Row type for `tasks_task_work_history` INSERT operations (target shape). */
export type NewTasksTaskWorkHistoryRow = typeof tasksTaskWorkHistory.$inferInsert;
/** Row type for `tasks_task_acceptance_criteria_history` SELECT queries (target shape). */
export type TasksTaskAcceptanceCriteriaHistoryRow =
  typeof tasksTaskAcceptanceCriteriaHistory.$inferSelect;
/** Row type for `tasks_task_acceptance_criteria_history` INSERT operations (target shape). */
export type NewTasksTaskAcceptanceCriteriaHistoryRow =
  typeof tasksTaskAcceptanceCriteriaHistory.$inferInsert;
/** Row type for `tasks_external_task_links` SELECT queries (target shape). */
export type TasksExternalTaskLinkRow = typeof tasksExternalTaskLinks.$inferSelect;
/** Row type for `tasks_external_task_links` INSERT operations (target shape). */
export type NewTasksExternalTaskLinkRow = typeof tasksExternalTaskLinks.$inferInsert;
