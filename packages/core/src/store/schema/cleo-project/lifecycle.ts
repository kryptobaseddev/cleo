/**
 * Project-scope `cleo.db` — consolidated **lifecycle** domain (5 tables).
 *
 * Part of the consolidated PROJECT-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11360). Target-shape
 * authoring only — physical names carry the `tasks_` domain prefix (lifecycle
 * is a project-tier tasks-core satellite per the canonical `targetTable` map).
 * The live runtime module `schema/lifecycle.ts` keeps its UNPREFIXED names
 * until the exodus migration (T11248) swaps the substrate.
 *
 * ## E10 typing (already conformant — preserved)
 *
 * All 5 lifecycle tables were already E10-clean in the source: every timestamp
 * is canonical TEXT ISO8601 (§4 — no epoch non-conformers), every enum column
 * already carries `{ enum }` narrowing from a named const array (§5 — status,
 * stage_name, result, type, transition_type) referenced by identifier (§5a).
 * The `notes_json` / `metadata_json` / `provenance_chain_json` columns stay
 * serialized TEXT per the JSON-Column Audit (§6a). The inline-literal
 * `validation_status` enum is promoted to a named const here (§5a — identifier
 * over literal).
 *
 * Cross-table FKs into `tasks_tasks` are carried as plain TEXT id columns
 * (resolved by the exodus prefixer); intra-domain FKs (pipeline → stage →
 * gate/evidence/transition) are real `.references()`.
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §4 · §5 · §6a
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { LIFECYCLE_PIPELINE_STATUSES, LIFECYCLE_STAGE_STATUSES } from '../../status-registry.js';
import {
  LIFECYCLE_EVIDENCE_TYPES,
  LIFECYCLE_GATE_RESULTS,
  LIFECYCLE_STAGE_NAMES,
  LIFECYCLE_TRANSITION_TYPES,
} from '../lifecycle.js';

/**
 * Stage validation-status values — promoted from the inline literal on
 * `lifecycle_stages.validation_status` to a named const array (§5a — CHECK
 * derivation references an identifier, never a literal).
 */
export const LIFECYCLE_VALIDATION_STATUSES = [
  'pending',
  'in_review',
  'approved',
  'rejected',
  'needs_revision',
] as const;

/**
 * `tasks_lifecycle_pipelines` — per-task lifecycle pipeline state.
 *
 * @task T11360 (target shape)
 */
export const tasksLifecyclePipelines = sqliteTable(
  'tasks_lifecycle_pipelines',
  {
    /** Pipeline id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `tasks_tasks.id` (resolved at exodus). */
    taskId: text('task_id').notNull(),
    /** Pipeline status — CHECK-backed via {@link LIFECYCLE_PIPELINE_STATUSES}. */
    status: text('status', { enum: LIFECYCLE_PIPELINE_STATUSES }).notNull().default('active'),
    /** Current stage id pointer. */
    currentStageId: text('current_stage_id'),
    /** ISO-8601 UTC start instant (canonical TEXT, §4). */
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC completion instant; NULL while active (canonical TEXT, §4). */
    completedAt: text('completed_at'),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
    /** Optimistic-concurrency version counter. */
    version: integer('version').notNull().default(1),
  },
  (table) => [
    index('idx_tasks_lifecycle_pipelines_task_id').on(table.taskId),
    index('idx_tasks_lifecycle_pipelines_status').on(table.status),
  ],
);

/**
 * `tasks_lifecycle_stages` — per-pipeline stage rows.
 *
 * @task T11360 (target shape)
 */
export const tasksLifecycleStages = sqliteTable(
  'tasks_lifecycle_stages',
  {
    /** Stage id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `tasks_lifecycle_pipelines.id`. ON DELETE CASCADE. */
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => tasksLifecyclePipelines.id, { onDelete: 'cascade' }),
    /** Canonical stage name — CHECK-backed via {@link LIFECYCLE_STAGE_NAMES}. */
    stageName: text('stage_name', { enum: LIFECYCLE_STAGE_NAMES }).notNull(),
    /** Stage status — CHECK-backed via {@link LIFECYCLE_STAGE_STATUSES}. */
    status: text('status', { enum: LIFECYCLE_STAGE_STATUSES }).notNull().default('not_started'),
    /** Ordinal position within the pipeline. */
    sequence: integer('sequence').notNull(),
    /** ISO-8601 UTC start instant; NULL until started (canonical TEXT, §4). */
    startedAt: text('started_at'),
    /** ISO-8601 UTC completion instant (canonical TEXT, §4). */
    completedAt: text('completed_at'),
    /** ISO-8601 UTC blocked instant (canonical TEXT, §4). */
    blockedAt: text('blocked_at'),
    /** Reason the stage is blocked. */
    blockReason: text('block_reason'),
    /** ISO-8601 UTC skipped instant (canonical TEXT, §4). */
    skippedAt: text('skipped_at'),
    /** Reason the stage was skipped. */
    skipReason: text('skip_reason'),
    /** JSON array of notes (TEXT per JSON audit; empty-array default). */
    notesJson: text('notes_json').default('[]'),
    /** JSON metadata object (TEXT per JSON audit; empty-object default). */
    metadataJson: text('metadata_json').default('{}'),
    /** RCASD output file path. */
    outputFile: text('output_file'),
    /** Creator identity. */
    createdBy: text('created_by'),
    /** Validator identity. */
    validatedBy: text('validated_by'),
    /** ISO-8601 UTC validation instant (canonical TEXT, §4). */
    validatedAt: text('validated_at'),
    /** Validation status — CHECK-backed via {@link LIFECYCLE_VALIDATION_STATUSES} (§5a). */
    validationStatus: text('validation_status', { enum: LIFECYCLE_VALIDATION_STATUSES }),
    /** JSON provenance chain (TEXT per JSON audit). */
    provenanceChainJson: text('provenance_chain_json'),
  },
  (table) => [
    index('idx_tasks_lifecycle_stages_pipeline_id').on(table.pipelineId),
    index('idx_tasks_lifecycle_stages_stage_name').on(table.stageName),
    index('idx_tasks_lifecycle_stages_status').on(table.status),
    index('idx_tasks_lifecycle_stages_validated_by').on(table.validatedBy),
  ],
);

/**
 * `tasks_lifecycle_gate_results` — per-stage gate evaluation results.
 *
 * @task T11360 (target shape)
 */
export const tasksLifecycleGateResults = sqliteTable(
  'tasks_lifecycle_gate_results',
  {
    /** Gate-result id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `tasks_lifecycle_stages.id`. ON DELETE CASCADE. */
    stageId: text('stage_id')
      .notNull()
      .references(() => tasksLifecycleStages.id, { onDelete: 'cascade' }),
    /** Gate name. */
    gateName: text('gate_name').notNull(),
    /** Result — CHECK-backed via {@link LIFECYCLE_GATE_RESULTS}. */
    result: text('result', { enum: LIFECYCLE_GATE_RESULTS }).notNull(),
    /** ISO-8601 UTC check instant (canonical TEXT, §4). */
    checkedAt: text('checked_at').notNull().default(sql`(datetime('now'))`),
    /** Checker identity. */
    checkedBy: text('checked_by').notNull(),
    /** Optional detail payload. */
    details: text('details'),
    /** Optional reason. */
    reason: text('reason'),
  },
  (table) => [index('idx_tasks_lifecycle_gate_results_stage_id').on(table.stageId)],
);

/**
 * `tasks_lifecycle_evidence` — per-stage evidence references.
 *
 * @task T11360 (target shape)
 */
export const tasksLifecycleEvidence = sqliteTable(
  'tasks_lifecycle_evidence',
  {
    /** Evidence id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `tasks_lifecycle_stages.id`. ON DELETE CASCADE. */
    stageId: text('stage_id')
      .notNull()
      .references(() => tasksLifecycleStages.id, { onDelete: 'cascade' }),
    /** Evidence URI. */
    uri: text('uri').notNull(),
    /** Evidence type — CHECK-backed via {@link LIFECYCLE_EVIDENCE_TYPES}. */
    type: text('type', { enum: LIFECYCLE_EVIDENCE_TYPES }).notNull(),
    /** ISO-8601 UTC record instant (canonical TEXT, §4). */
    recordedAt: text('recorded_at').notNull().default(sql`(datetime('now'))`),
    /** Recorder identity. */
    recordedBy: text('recorded_by'),
    /** Optional description. */
    description: text('description'),
  },
  (table) => [index('idx_tasks_lifecycle_evidence_stage_id').on(table.stageId)],
);

/**
 * `tasks_lifecycle_transitions` — stage→stage transition log.
 *
 * @task T11360 (target shape)
 */
export const tasksLifecycleTransitions = sqliteTable(
  'tasks_lifecycle_transitions',
  {
    /** Transition id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `tasks_lifecycle_pipelines.id`. ON DELETE CASCADE. */
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => tasksLifecyclePipelines.id, { onDelete: 'cascade' }),
    /** FK → `tasks_lifecycle_stages.id` (source). ON DELETE CASCADE. */
    fromStageId: text('from_stage_id')
      .notNull()
      .references(() => tasksLifecycleStages.id, { onDelete: 'cascade' }),
    /** FK → `tasks_lifecycle_stages.id` (target). ON DELETE CASCADE. */
    toStageId: text('to_stage_id')
      .notNull()
      .references(() => tasksLifecycleStages.id, { onDelete: 'cascade' }),
    /** Transition type — CHECK-backed via {@link LIFECYCLE_TRANSITION_TYPES}. */
    transitionType: text('transition_type', { enum: LIFECYCLE_TRANSITION_TYPES })
      .notNull()
      .default('automatic'),
    /** Actor identity. */
    transitionedBy: text('transitioned_by'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_tasks_lifecycle_transitions_pipeline_id').on(table.pipelineId)],
);

// === TYPE EXPORTS ===

/** Row type for `tasks_lifecycle_pipelines` SELECT queries (target shape). */
export type TasksLifecyclePipelineRow = typeof tasksLifecyclePipelines.$inferSelect;
/** Row type for `tasks_lifecycle_pipelines` INSERT operations (target shape). */
export type NewTasksLifecyclePipelineRow = typeof tasksLifecyclePipelines.$inferInsert;
/** Row type for `tasks_lifecycle_stages` SELECT queries (target shape). */
export type TasksLifecycleStageRow = typeof tasksLifecycleStages.$inferSelect;
/** Row type for `tasks_lifecycle_stages` INSERT operations (target shape). */
export type NewTasksLifecycleStageRow = typeof tasksLifecycleStages.$inferInsert;
/** Row type for `tasks_lifecycle_gate_results` SELECT queries (target shape). */
export type TasksLifecycleGateResultRow = typeof tasksLifecycleGateResults.$inferSelect;
/** Row type for `tasks_lifecycle_gate_results` INSERT operations (target shape). */
export type NewTasksLifecycleGateResultRow = typeof tasksLifecycleGateResults.$inferInsert;
/** Row type for `tasks_lifecycle_evidence` SELECT queries (target shape). */
export type TasksLifecycleEvidenceRow = typeof tasksLifecycleEvidence.$inferSelect;
/** Row type for `tasks_lifecycle_evidence` INSERT operations (target shape). */
export type NewTasksLifecycleEvidenceRow = typeof tasksLifecycleEvidence.$inferInsert;
/** Row type for `tasks_lifecycle_transitions` SELECT queries (target shape). */
export type TasksLifecycleTransitionRow = typeof tasksLifecycleTransitions.$inferSelect;
/** Row type for `tasks_lifecycle_transitions` INSERT operations (target shape). */
export type NewTasksLifecycleTransitionRow = typeof tasksLifecycleTransitions.$inferInsert;
