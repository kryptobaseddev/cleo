/**
 * Lifecycle pipeline tables: lifecycle_pipelines, lifecycle_stages,
 * lifecycle_gate_results, lifecycle_evidence, lifecycle_transitions.
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { LIFECYCLE_PIPELINE_STATUSES, LIFECYCLE_STAGE_STATUSES } from '../status-registry.js';
import { tasks } from './tasks.js';

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

/** Lifecycle transition types matching DB CHECK constraint on lifecycle_transitions.transition_type. */
export const LIFECYCLE_TRANSITION_TYPES = ['automatic', 'manual', 'forced'] as const;

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

// === TYPE EXPORTS ===

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
