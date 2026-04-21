/**
 * Drizzle ORM schema for CLEO tasks.db (SQLite via node:sqlite + sqlite-proxy).
 *
 * Tables: tasks, task_dependencies, task_relations, sessions, task_work_history
 * Archive uses the same tasks table with status = 'archived' + archive metadata.
 *
 * @epic T4454
 * @task W1-T2
 */

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
import {
  ADR_STATUSES,
  GATE_STATUSES,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  MANIFEST_STATUSES,
  SESSION_STATUSES,
  TASK_STATUSES,
} from './status-registry.js';

export type {
  AgentErrorLogRow,
  AgentErrorType,
  AgentInstanceRow,
  AgentInstanceStatus,
  AgentType,
  NewAgentErrorLogRow,
  NewAgentInstanceRow,
} from '../agents/agent-schema.js';
// Re-export agent schema tables so drizzle-kit picks them up for migrations.
export {
  AGENT_INSTANCE_STATUSES,
  AGENT_TYPES,
  agentErrorLog,
  agentInstances,
} from '../agents/agent-schema.js';
export type {
  NewWarpChainInstanceRow,
  NewWarpChainRow,
  WarpChainInstanceRow,
  WarpChainRow,
} from './chain-schema.js';
// Re-export WarpChain schema tables so drizzle-kit picks them up for migrations.
export { warpChainInstances, warpChains } from './chain-schema.js';

// Re-export status constants and types so existing imports from schema.ts still work.
export {
  ADR_STATUSES,
  type AdrStatus,
  GATE_STATUSES,
  type GateStatus,
  isValidStatus,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  MANIFEST_STATUSES,
  type ManifestStatus,
  type PipelineStatus,
  SESSION_STATUSES,
  type SessionStatus,
  type StageStatus,
  TASK_STATUSES,
  type TaskStatus,
} from './status-registry.js';

// === CANONICAL ENUM CONSTANTS (non-status) ===

/** Task priorities matching DB CHECK constraint on tasks.priority. */
export const TASK_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

/** Task types matching DB CHECK constraint on tasks.type. */
export const TASK_TYPES = ['epic', 'task', 'subtask'] as const;

/**
 * Task role axis — orthogonal to {@link TASK_TYPES}, describes the intent of the
 * work rather than its position in the hierarchy.
 *
 * Added by T944 as an additive second axis so `type` (hierarchy) and `role`
 * (intent) can vary independently. Defaults to `'work'` to preserve existing
 * semantics for the ~948 tasks already in production.
 *
 * @task T944
 */
export const TASK_ROLES = ['work', 'research', 'experiment', 'bug', 'spike', 'release'] as const;

/** Union type for {@link TASK_ROLES}. */
export type TaskRole = (typeof TASK_ROLES)[number];

/**
 * Task scope axis — describes the granularity of the work (project-wide vs.
 * feature-scoped vs. unit-scoped). Orthogonal to type and role.
 *
 * Backfill mapping from legacy `type` during migration:
 * - `type='epic'`    → `scope='project'`
 * - `type='task'`    → `scope='feature'` (also used for NULL legacy rows)
 * - `type='subtask'` → `scope='unit'`
 *
 * @task T944
 */
export const TASK_SCOPES = ['project', 'feature', 'unit'] as const;

/** Union type for {@link TASK_SCOPES}. */
export type TaskScope = (typeof TASK_SCOPES)[number];

/**
 * Bug severity axis — ONLY applies when `role='bug'`. Enforced by a composite
 * CHECK constraint (`severity IS NULL OR (severity IN (...) AND role='bug')`).
 *
 * OWNER-WRITE-ONLY (T944 / owner mandate): severity is meant to be set through
 * owner-authenticated paths only, not by Tier 3 agents. This prevents a
 * prompt-injection exploit where a compromised agent could mark a P0 bug as
 * P3 to force-ship.
 *
 * @task T944
 */
export const TASK_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;

/** Union type for {@link TASK_SEVERITIES}. */
export type TaskSeverity = (typeof TASK_SEVERITIES)[number];

/** Task size values matching DB CHECK constraint on tasks.size. */
export const TASK_SIZES = ['small', 'medium', 'large'] as const;

/** Canonical lifecycle stage names matching DB CHECK constraint on lifecycle_stages.stage_name. */
export const LIFECYCLE_STAGE_NAMES = [
  'research',
  'consensus',
  'architecture_decision',
  'specification',
  'decomposition',
  'implementation',
  'validation',
  'testing',
  'release',
  'contribution',
] as const;

/** Gate result values matching DB CHECK constraint on lifecycle_gate_results.result. */
export const LIFECYCLE_GATE_RESULTS = ['pass', 'fail', 'warn'] as const;

/** Evidence type values matching DB CHECK constraint on lifecycle_evidence.type. */
export const LIFECYCLE_EVIDENCE_TYPES = ['file', 'url', 'manifest'] as const;

/** Token measurement methods for central token telemetry. */
export const TOKEN_USAGE_METHODS = ['otel', 'provider_api', 'tokenizer', 'heuristic'] as const;

/** Confidence levels for token measurements. */
export const TOKEN_USAGE_CONFIDENCE = ['real', 'high', 'estimated', 'coarse'] as const;

/** Transport types for token telemetry. */
export const TOKEN_USAGE_TRANSPORTS = ['cli', 'api', 'agent', 'unknown'] as const;

/** Task relation types matching DB CHECK constraint on task_relations.relation_type. */
export const TASK_RELATION_TYPES = [
  'related',
  'blocks',
  'duplicates',
  'absorbs',
  'fixes',
  'extends',
  'supersedes',
] as const;

/** Lifecycle transition types matching DB CHECK constraint on lifecycle_transitions.transition_type. */
export const LIFECYCLE_TRANSITION_TYPES = ['automatic', 'manual', 'forced'] as const;

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
     * Task role axis — orthogonal to `type`. Defaults to `'work'`.
     * See {@link TASK_ROLES}. Added by T944.
     */
    role: text('role', { enum: TASK_ROLES }).notNull().default('work'),
    /**
     * Task scope axis — granularity of the work. Defaults to `'feature'`.
     * See {@link TASK_SCOPES}. Added by T944.
     */
    scope: text('scope', { enum: TASK_SCOPES }).notNull().default('feature'),
    /**
     * Bug severity. ONLY valid when `role='bug'`. NULL otherwise.
     * OWNER-WRITE-ONLY. See {@link TASK_SEVERITIES}. Added by T944.
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

    // Provenance
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
    // Not referencing lifecycle_stages.id so that stage binding works without
    // requiring a lifecycle pipeline record for every task.
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
    // T944 role/scope axes
    index('idx_tasks_role').on(table.role),
    index('idx_tasks_scope').on(table.scope),
    index('idx_tasks_role_status').on(table.role, table.status),
    // T1126 — partial index for Tier-2 proposal rate-limiter.
    // Drizzle ORM beta.22 does not support partial indexes in sqliteTable,
    // so the canonical definition lives in the raw SQL migration:
    //   packages/cleo/migrations/drizzle-tasks/20260421000001_t1126-sentient-proposal-index
    // Re-run `drizzle-kit generate` will NOT emit this index.
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
  },
  (table) => [
    index('idx_sessions_status').on(table.status),
    index('idx_sessions_previous').on(table.previousSessionId),
    index('idx_sessions_agent_identifier').on(table.agentIdentifier),
    index('idx_sessions_started_at').on(table.startedAt),
    // T033 composite index: getActiveSession hot path
    index('idx_sessions_status_started_at').on(table.status, table.startedAt),
  ],
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

// === LIFECYCLE PIPELINES ===

export const lifecyclePipelines = sqliteTable(
  'lifecycle_pipelines',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: LIFECYCLE_PIPELINE_STATUSES,
    })
      .notNull()
      .default('active'),
    currentStageId: text('current_stage_id'),
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
    completedAt: text('completed_at'),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    index('idx_lifecycle_pipelines_task_id').on(table.taskId),
    index('idx_lifecycle_pipelines_status').on(table.status),
  ],
);

// === LIFECYCLE STAGES ===

export const lifecycleStages = sqliteTable(
  'lifecycle_stages',
  {
    id: text('id').primaryKey(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => lifecyclePipelines.id, { onDelete: 'cascade' }),
    stageName: text('stage_name', { enum: LIFECYCLE_STAGE_NAMES }).notNull(),
    status: text('status', {
      enum: LIFECYCLE_STAGE_STATUSES,
    })
      .notNull()
      .default('not_started'),
    sequence: integer('sequence').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    blockedAt: text('blocked_at'),
    blockReason: text('block_reason'),
    skippedAt: text('skipped_at'),
    skipReason: text('skip_reason'),
    notesJson: text('notes_json').default('[]'),
    metadataJson: text('metadata_json').default('{}'),
    // RCASD provenance tracking columns (T5100)
    outputFile: text('output_file'),
    createdBy: text('created_by'),
    validatedBy: text('validated_by'),
    validatedAt: text('validated_at'),
    validationStatus: text('validation_status', {
      enum: ['pending', 'in_review', 'approved', 'rejected', 'needs_revision'],
    }),
    provenanceChainJson: text('provenance_chain_json'),
  },
  (table) => [
    index('idx_lifecycle_stages_pipeline_id').on(table.pipelineId),
    index('idx_lifecycle_stages_stage_name').on(table.stageName),
    index('idx_lifecycle_stages_status').on(table.status),
    index('idx_lifecycle_stages_validated_by').on(table.validatedBy),
  ],
);

// === LIFECYCLE GATE RESULTS ===

export const lifecycleGateResults = sqliteTable(
  'lifecycle_gate_results',
  {
    id: text('id').primaryKey(),
    stageId: text('stage_id')
      .notNull()
      .references(() => lifecycleStages.id, { onDelete: 'cascade' }),
    gateName: text('gate_name').notNull(),
    result: text('result', {
      enum: LIFECYCLE_GATE_RESULTS,
    }).notNull(),
    checkedAt: text('checked_at').notNull().default(sql`(datetime('now'))`),
    checkedBy: text('checked_by').notNull(),
    details: text('details'),
    reason: text('reason'),
  },
  (table) => [index('idx_lifecycle_gate_results_stage_id').on(table.stageId)],
);

// === LIFECYCLE EVIDENCE ===

export const lifecycleEvidence = sqliteTable(
  'lifecycle_evidence',
  {
    id: text('id').primaryKey(),
    stageId: text('stage_id')
      .notNull()
      .references(() => lifecycleStages.id, { onDelete: 'cascade' }),
    uri: text('uri').notNull(),
    type: text('type', {
      enum: LIFECYCLE_EVIDENCE_TYPES,
    }).notNull(),
    recordedAt: text('recorded_at').notNull().default(sql`(datetime('now'))`),
    recordedBy: text('recorded_by'),
    description: text('description'),
  },
  (table) => [index('idx_lifecycle_evidence_stage_id').on(table.stageId)],
);

// === LIFECYCLE TRANSITIONS ===

export const lifecycleTransitions = sqliteTable(
  'lifecycle_transitions',
  {
    id: text('id').primaryKey(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => lifecyclePipelines.id, { onDelete: 'cascade' }),
    fromStageId: text('from_stage_id')
      .notNull()
      .references(() => lifecycleStages.id, { onDelete: 'cascade' }),
    toStageId: text('to_stage_id')
      .notNull()
      .references(() => lifecycleStages.id, { onDelete: 'cascade' }),
    transitionType: text('transition_type', {
      enum: LIFECYCLE_TRANSITION_TYPES,
    })
      .notNull()
      .default('automatic'),
    transitionedBy: text('transitioned_by'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_lifecycle_transitions_pipeline_id').on(table.pipelineId)],
);

// === MANIFEST ENTRIES (RCASD provenance — T5100) ===

export const manifestEntries = sqliteTable(
  'manifest_entries',
  {
    id: text('id').primaryKey(),
    pipelineId: text('pipeline_id').references(() => lifecyclePipelines.id, {
      onDelete: 'cascade',
    }),
    stageId: text('stage_id').references(() => lifecycleStages.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    date: text('date').notNull(),
    status: text('status', { enum: MANIFEST_STATUSES }).notNull(),
    agentType: text('agent_type'),
    outputFile: text('output_file'),
    topicsJson: text('topics_json').default('[]'),
    findingsJson: text('findings_json').default('[]'),
    linkedTasksJson: text('linked_tasks_json').default('[]'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_manifest_entries_pipeline_id').on(table.pipelineId),
    index('idx_manifest_entries_stage_id').on(table.stageId),
    index('idx_manifest_entries_status').on(table.status),
  ],
);

// === PIPELINE MANIFEST (T5581) ===

export const pipelineManifest = sqliteTable(
  'pipeline_manifest',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    epicId: text('epic_id').references(() => tasks.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash'),
    status: text('status').notNull().default('active'),
    distilled: integer('distilled', { mode: 'boolean' }).notNull().default(false),
    brainObsId: text('brain_obs_id'),
    sourceFile: text('source_file'),
    metadataJson: text('metadata_json'),
    createdAt: text('created_at').notNull(),
    archivedAt: text('archived_at'),
  },
  (table) => [
    index('idx_pipeline_manifest_task_id').on(table.taskId),
    index('idx_pipeline_manifest_session_id').on(table.sessionId),
    index('idx_pipeline_manifest_distilled').on(table.distilled),
    index('idx_pipeline_manifest_status').on(table.status),
    index('idx_pipeline_manifest_content_hash').on(table.contentHash),
  ],
);

// === RELEASE MANIFESTS (T5580) ===

export const releaseManifests = sqliteTable(
  'release_manifests',
  {
    id: text('id').primaryKey(),
    version: text('version').notNull().unique(),
    status: text('status').notNull().default('draft'),
    pipelineId: text('pipeline_id').references(() => lifecyclePipelines.id, {
      onDelete: 'set null',
    }),
    epicId: text('epic_id').references(() => tasks.id, { onDelete: 'set null' }),
    tasksJson: text('tasks_json').notNull().default('[]'),
    changelog: text('changelog'),
    notes: text('notes'),
    previousVersion: text('previous_version'),
    commitSha: text('commit_sha'),
    gitTag: text('git_tag'),
    npmDistTag: text('npm_dist_tag'),
    createdAt: text('created_at').notNull(),
    preparedAt: text('prepared_at'),
    committedAt: text('committed_at'),
    taggedAt: text('tagged_at'),
    pushedAt: text('pushed_at'),
  },
  (table) => [
    index('idx_release_manifests_status').on(table.status),
    index('idx_release_manifests_version').on(table.version),
  ],
);

// === SCHEMA METADATA ===

export const schemaMeta = sqliteTable('schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// === AUDIT LOG ===

/**
 * Task change audit log — stores every add/update/complete/delete/archive operation.
 * Migrated from legacy JSONL task logs to SQLite per ADR-006/ADR-012.
 * No FK on taskId — log entries must survive task deletion.
 *
 * @task T4837
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    timestamp: text('timestamp').notNull().default(sql`(datetime('now'))`),
    action: text('action').notNull(),
    taskId: text('task_id').notNull(),
    actor: text('actor').notNull().default('system'),
    detailsJson: text('details_json').default('{}'),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    // Dispatch layer columns (migration 20260225200000_audit-log-dispatch-columns)
    domain: text('domain'),
    operation: text('operation'),
    sessionId: text('session_id'),
    requestId: text('request_id'),
    durationMs: integer('duration_ms'),
    success: integer('success'),
    source: text('source'),
    gateway: text('gateway'),
    errorMessage: text('error_message'),
    // Project correlation (T5334)
    projectHash: text('project_hash'),
  },
  (table) => [
    index('idx_audit_log_task_id').on(table.taskId),
    index('idx_audit_log_action').on(table.action),
    index('idx_audit_log_timestamp').on(table.timestamp),
    index('idx_audit_log_domain').on(table.domain),
    index('idx_audit_log_request_id').on(table.requestId),
    index('idx_audit_log_project_hash').on(table.projectHash),
    index('idx_audit_log_actor').on(table.actor),
    // T033 composite indexes
    index('idx_audit_log_session_timestamp').on(table.sessionId, table.timestamp),
    index('idx_audit_log_domain_operation').on(table.domain, table.operation),
  ],
);

// === TOKEN USAGE ===

/**
 * Central provider-aware token telemetry for CLI and external adapters.
 * Stores measured request/response token counts plus method/confidence metadata.
 */
export const tokenUsage = sqliteTable(
  'token_usage',
  {
    id: text('id').primaryKey(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    provider: text('provider').notNull().default('unknown'),
    model: text('model'),
    transport: text('transport', { enum: TOKEN_USAGE_TRANSPORTS }).notNull().default('unknown'),
    gateway: text('gateway'),
    domain: text('domain'),
    operation: text('operation'),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    requestId: text('request_id'),
    inputChars: integer('input_chars').notNull().default(0),
    outputChars: integer('output_chars').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    method: text('method', { enum: TOKEN_USAGE_METHODS }).notNull().default('heuristic'),
    confidence: text('confidence', { enum: TOKEN_USAGE_CONFIDENCE }).notNull().default('coarse'),
    requestHash: text('request_hash'),
    responseHash: text('response_hash'),
    metadataJson: text('metadata_json').notNull().default('{}'),
  },
  (table) => [
    index('idx_token_usage_created_at').on(table.createdAt),
    index('idx_token_usage_request_id').on(table.requestId),
    index('idx_token_usage_session_id').on(table.sessionId),
    index('idx_token_usage_task_id').on(table.taskId),
    index('idx_token_usage_provider').on(table.provider),
    index('idx_token_usage_transport').on(table.transport),
    index('idx_token_usage_domain_operation').on(table.domain, table.operation),
    index('idx_token_usage_method').on(table.method),
    index('idx_token_usage_gateway').on(table.gateway),
  ],
);

// === ARCHITECTURE DECISIONS ===

/**
 * Architecture Decision Records (ADRs) stored in the database.
 * Corresponds to the physical ADR markdown files in .cleo/adrs/.
 * Self-referential FKs (supersedes_id, superseded_by_id, amends_id) are
 * enforced at the DB level by T033 migration.
 */
export const architectureDecisions = sqliteTable(
  'architecture_decisions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    status: text('status', { enum: ADR_STATUSES }).notNull().default('proposed'),
    supersedesId: text('supersedes_id').references(
      (): AnySQLiteColumn => architectureDecisions.id,
      { onDelete: 'set null' },
    ),
    supersededById: text('superseded_by_id').references(
      (): AnySQLiteColumn => architectureDecisions.id,
      { onDelete: 'set null' },
    ),
    consensusManifestId: text('consensus_manifest_id').references(
      (): AnySQLiteColumn => manifestEntries.id,
      { onDelete: 'set null' },
    ),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),
    // ADR-017 §5.3 extension columns
    date: text('date').notNull().default(''),
    acceptedAt: text('accepted_at'),
    gate: text('gate', { enum: ['HITL', 'automated'] }),
    gateStatus: text('gate_status', { enum: GATE_STATUSES }),
    amendsId: text('amends_id').references((): AnySQLiteColumn => architectureDecisions.id, {
      onDelete: 'set null',
    }),
    filePath: text('file_path').notNull().default(''),
    // ADR-017 §5.4 cognitive search columns (T4942)
    summary: text('summary'),
    keywords: text('keywords'),
    topics: text('topics'),
  },
  (table) => [
    index('idx_arch_decisions_status').on(table.status),
    index('idx_arch_decisions_amends_id').on(table.amendsId),
  ],
);

// === ADR JUNCTION TABLES (ADR-017 §5.3) ===

/** ADR-to-Task links (soft FK — tasks can be purged) */
export const adrTaskLinks = sqliteTable(
  'adr_task_links',
  {
    adrId: text('adr_id')
      .notNull()
      .references(() => architectureDecisions.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    linkType: text('link_type', {
      enum: ['related', 'governed_by', 'implements'],
    })
      .notNull()
      .default('related'),
  },
  (table) => [
    primaryKey({ columns: [table.adrId, table.taskId] }),
    index('idx_adr_task_links_task_id').on(table.taskId),
  ],
);

/** ADR cross-reference relationships */
export const adrRelations = sqliteTable(
  'adr_relations',
  {
    fromAdrId: text('from_adr_id')
      .notNull()
      .references(() => architectureDecisions.id, { onDelete: 'cascade' }),
    toAdrId: text('to_adr_id')
      .notNull()
      .references(() => architectureDecisions.id, { onDelete: 'cascade' }),
    relationType: text('relation_type', {
      enum: ['supersedes', 'amends', 'related'],
    }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.fromAdrId, table.toAdrId, table.relationType] })],
);

// === EXTERNAL TASK LINKS (provider-agnostic task reconciliation) ===

/**
 * Tracks links between CLEO tasks and external system tasks (Linear, Jira, GitHub, etc.).
 * Used by the reconciliation engine to match external tasks to existing CLEO tasks,
 * detect updates, and maintain bidirectional traceability.
 *
 * Each row represents one link: one CLEO task ↔ one external task from one provider.
 * A CLEO task MAY have links from multiple providers (e.g., both Linear and GitHub).
 * An external task SHOULD have at most one link per provider.
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

// === BACKGROUND JOBS (T641) ===

/**
 * Background job status enum values.
 *
 * - `pending`   – queued but not yet executing
 * - `running`   – actively executing in this process
 * - `complete`  – finished successfully
 * - `failed`    – finished with an error
 * - `cancelled` – explicitly cancelled by a caller
 * - `orphaned`  – was `running` when the process exited; requires human/agent review
 */
export const BACKGROUND_JOB_STATUSES = [
  'pending',
  'running',
  'complete',
  'failed',
  'cancelled',
  'orphaned',
] as const;

/** Union type for {@link BACKGROUND_JOB_STATUSES}. */
export type BackgroundJobStatus = (typeof BACKGROUND_JOB_STATUSES)[number];

/**
 * Durable background job row stored in tasks.db.
 *
 * Jobs survive process restart; any row with `status='running'` at startup
 * is transitioned to `status='orphaned'` so humans/agents can triage them.
 *
 * Timestamps are stored as INTEGER milliseconds-since-epoch to allow
 * range queries without string parsing.
 *
 * @task T641
 */
export const backgroundJobs = sqliteTable(
  'background_jobs',
  {
    /** Unique job identifier (UUID v4). */
    id: text('id').primaryKey(),
    /** Operation name, e.g. "nexus.analyze" or "tasks.sync.reconcile". */
    operation: text('operation').notNull(),
    /** Current lifecycle status. */
    status: text('status', { enum: BACKGROUND_JOB_STATUSES }).notNull().default('pending'),
    /** When the job was created (ms epoch). */
    startedAt: integer('started_at').notNull(),
    /** When the job finished (ms epoch); NULL while running. */
    completedAt: integer('completed_at'),
    /** JSON-serialised result payload; NULL on failure or while running. */
    result: text('result'),
    /** Human-readable error message; NULL on success or while running. */
    error: text('error'),
    /** Execution progress 0-100; NULL until progress is reported. */
    progress: integer('progress'),
    /** Last heartbeat timestamp (ms epoch). */
    heartbeatAt: integer('heartbeat_at').notNull(),
    /** Agent or session ID that claimed this job; NULL if unclaimed. */
    claimedBy: text('claimed_by'),
  },
  (table) => [
    index('idx_background_jobs_status').on(table.status),
    index('idx_background_jobs_operation').on(table.operation),
    index('idx_background_jobs_claimed_by').on(table.claimedBy),
    index('idx_background_jobs_started_at').on(table.startedAt),
  ],
);

export type BackgroundJobRow = typeof backgroundJobs.$inferSelect;
export type NewBackgroundJobRow = typeof backgroundJobs.$inferInsert;

// === STATUS REGISTRY (ADR-018) ===

export const statusRegistryTable = sqliteTable(
  'status_registry',
  {
    name: text('name').notNull(),
    entityType: text('entity_type', {
      enum: ['task', 'session', 'lifecycle_pipeline', 'lifecycle_stage', 'adr', 'gate', 'manifest'],
    }).notNull(),
    namespace: text('namespace', { enum: ['workflow', 'governance', 'manifest'] }).notNull(),
    description: text('description').notNull(),
    isTerminal: integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.name, table.entityType] }),
    index('idx_status_registry_entity_type').on(table.entityType),
    index('idx_status_registry_namespace').on(table.namespace),
  ],
);

export type StatusRegistryRow = typeof statusRegistryTable.$inferSelect;

// === Attachment Storage ===

const ATTACHMENT_OWNER_TYPES = [
  'task',
  'observation',
  'session',
  'decision',
  'learning',
  'pattern',
] as const;

/**
 * Registry of stored attachments (blob content).
 *
 * Storage path: `.cleo/attachments/sha256/<sha256[0..2]>/<sha256[2..]>.<ext>`
 *
 * @epic T760
 * @task T796
 */
export const attachments = sqliteTable(
  'attachments',
  {
    /** Unique attachment identifier (UUID v4). */
    id: text('id').primaryKey(),
    /** SHA-256 hex digest of the uncompressed content. Unique across the registry. */
    sha256: text('sha256').notNull().unique(),
    /** Serialised `Attachment` discriminated union (all kind-specific fields). */
    attachmentJson: text('attachment_json').notNull(),
    /** ISO 8601 timestamp when this attachment was first registered. */
    createdAt: text('created_at').notNull(),
    /**
     * How many `attachment_refs` rows point at this attachment.
     *
     * When `ref_count` drops to zero the blob is eligible for GC.
     * Blobs are NEVER auto-deleted — use `cleo docs attachments gc`.
     */
    refCount: integer('ref_count').notNull().default(0),
  },
  (table) => [index('idx_attachments_sha256').on(table.sha256)],
);

/**
 * Ref-counted junction table linking attachments to owner entities.
 *
 * A single attachment can be referenced by multiple owners simultaneously
 * (e.g., the same RFC PDF attached to an epic task AND to every child task).
 * Deleting a ref decrements `attachments.ref_count`; when `ref_count` reaches
 * zero the blob file may be purged.
 *
 * @epic T760
 * @task T796
 */
export const attachmentRefs = sqliteTable(
  'attachment_refs',
  {
    /** ID of the attachment (→ `attachments.id`). */
    attachmentId: text('attachment_id').notNull(),
    /**
     * The domain entity type that owns this ref.
     *
     * Restricted to the six supported CLEO entity types.
     */
    ownerType: text('owner_type', { enum: ATTACHMENT_OWNER_TYPES }).notNull(),
    /** The ID of the owning entity (e.g., `"T766"`, `"O-abc123"`, `"ses_..."`). */
    ownerId: text('owner_id').notNull(),
    /** ISO 8601 timestamp when this ref was created. */
    attachedAt: text('attached_at').notNull(),
    /**
     * Agent identity (or `"human"`) that created this ref.
     *
     * Optional; populated from the active session credential when available.
     */
    attachedBy: text('attached_by'),
  },
  (table) => [
    primaryKey({ columns: [table.attachmentId, table.ownerType, table.ownerId] }),
    index('idx_attachment_refs_attachment_id').on(table.attachmentId),
    index('idx_attachment_refs_owner').on(table.ownerType, table.ownerId),
  ],
);

// === EXPERIMENTS SIDE-TABLE (T944) ===

/**
 * Experiment metadata side-table, keyed 1:1 to `tasks.id` for rows where
 * `tasks.role='experiment'`.
 *
 * Tracks sandbox/branch state and metrics delta for experimental work so the
 * main `tasks` table stays clean and sparse. Cascades on task deletion.
 *
 * @task T944
 */
export const experiments = sqliteTable(
  'experiments',
  {
    /** Owning task ID. Primary key + cascade FK to {@link tasks}. */
    taskId: text('task_id')
      .primaryKey()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Git branch used as the experiment sandbox (nullable until created). */
    sandboxBranch: text('sandbox_branch'),
    /** Baseline commit SHA the experiment forked from. */
    baselineCommit: text('baseline_commit'),
    /** ISO 8601 timestamp when the experiment merged back (null = open). */
    mergedAt: text('merged_at'),
    /** Optional receipt ID linking to an audit/receipt record. */
    receiptId: text('receipt_id'),
    /** JSON-serialised metrics delta between baseline and experiment. */
    metricsDeltaJson: text('metrics_delta_json'),
    /** ISO 8601 timestamp of row creation. */
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /** ISO 8601 timestamp of last update. */
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_experiments_merged').on(table.mergedAt)],
);

// === TYPE EXPORTS ===

export type AttachmentRow = typeof attachments.$inferSelect;
export type NewAttachmentRow = typeof attachments.$inferInsert;
export type AttachmentRefRow = typeof attachmentRefs.$inferSelect;
export type NewAttachmentRefRow = typeof attachmentRefs.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type TaskRelationRow = typeof taskRelations.$inferSelect;
export type WorkHistoryRow = typeof taskWorkHistory.$inferSelect;
export type LifecyclePipelineRow = typeof lifecyclePipelines.$inferSelect;
export type NewLifecyclePipelineRow = typeof lifecyclePipelines.$inferInsert;
export type LifecycleStageRow = typeof lifecycleStages.$inferSelect;
export type NewLifecycleStageRow = typeof lifecycleStages.$inferInsert;
export type LifecycleGateResultRow = typeof lifecycleGateResults.$inferSelect;
export type NewLifecycleGateResultRow = typeof lifecycleGateResults.$inferInsert;
export type LifecycleEvidenceRow = typeof lifecycleEvidence.$inferSelect;
export type NewLifecycleEvidenceRow = typeof lifecycleEvidence.$inferInsert;
export type LifecycleTransitionRow = typeof lifecycleTransitions.$inferSelect;
export type NewLifecycleTransitionRow = typeof lifecycleTransitions.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
export type TokenUsageRow = typeof tokenUsage.$inferSelect;
export type NewTokenUsageRow = typeof tokenUsage.$inferInsert;
export type ArchitectureDecisionRow = typeof architectureDecisions.$inferSelect;
export type NewArchitectureDecisionRow = typeof architectureDecisions.$inferInsert;
export type AdrTaskLinkRow = typeof adrTaskLinks.$inferSelect;
export type NewAdrTaskLinkRow = typeof adrTaskLinks.$inferInsert;
export type AdrRelationRow = typeof adrRelations.$inferSelect;
export type NewAdrRelationRow = typeof adrRelations.$inferInsert;
export type ManifestEntryRow = typeof manifestEntries.$inferSelect;
export type NewManifestEntryRow = typeof manifestEntries.$inferInsert;
export type PipelineManifestRow = typeof pipelineManifest.$inferSelect;
export type NewPipelineManifestRow = typeof pipelineManifest.$inferInsert;
export type ReleaseManifestRow = typeof releaseManifests.$inferSelect;
export type NewReleaseManifestRow = typeof releaseManifests.$inferInsert;
export type ExternalTaskLinkRow = typeof externalTaskLinks.$inferSelect;
export type NewExternalTaskLinkRow = typeof externalTaskLinks.$inferInsert;
// T944 experiments side-table row types
export type ExperimentRow = typeof experiments.$inferSelect;
export type NewExperimentRow = typeof experiments.$inferInsert;

// agent_credentials REMOVED from tasks.db — T234 clean-cut.
// Agent data (identity, credentials, capabilities, skills) now lives
// exclusively in signaldock.db. See AgentRegistryAccessor.
