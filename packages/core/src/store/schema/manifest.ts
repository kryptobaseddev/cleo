/**
 * Manifest tables: manifest_entries, pipeline_manifest.
 *
 * @task T5100 (manifest_entries — RCASD provenance)
 * @task T5581 (pipeline_manifest)
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { MANIFEST_STATUSES } from '../status-registry.js';
import { lifecyclePipelines, lifecycleStages } from './lifecycle.js';
import { sessions, tasks } from './tasks.js';

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

// === TYPE EXPORTS ===

export type ManifestEntryRow = typeof manifestEntries.$inferSelect;
export type NewManifestEntryRow = typeof manifestEntries.$inferInsert;
export type PipelineManifestRow = typeof pipelineManifest.$inferSelect;
export type NewPipelineManifestRow = typeof pipelineManifest.$inferInsert;
