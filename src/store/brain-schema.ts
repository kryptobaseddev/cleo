/**
 * Drizzle ORM schema for CLEO brain.db (SQLite via node:sqlite + sqlite-proxy).
 *
 * Tables: brain_decisions, brain_patterns, brain_learnings, brain_memory_links, brain_schema_meta
 * Stores cognitive infrastructure: decisions, patterns, and learnings extracted
 * from CLEO task execution. Cross-references tasks in tasks.db via soft FKs.
 *
 * @epic T5149
 * @task T5127
 */

import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// === ENUM CONSTANTS ===

/** Decision types from ADR-009. */
export const BRAIN_DECISION_TYPES = ['architecture', 'technical', 'process', 'strategic', 'tactical'] as const;

/** Confidence levels for decisions. */
export const BRAIN_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;

/** Outcome types for decision tracking. */
export const BRAIN_OUTCOME_TYPES = ['success', 'failure', 'mixed', 'pending'] as const;

/** Pattern types for workflow analysis. */
export const BRAIN_PATTERN_TYPES = ['workflow', 'blocker', 'success', 'failure', 'optimization'] as const;

/** Impact levels for patterns. */
export const BRAIN_IMPACT_LEVELS = ['low', 'medium', 'high'] as const;

/** Link types for cross-referencing BRAIN entries with tasks. */
export const BRAIN_LINK_TYPES = ['produced_by', 'applies_to', 'informed_by', 'contradicts'] as const;

/** Observation types for claude-mem compatible observations. */
export const BRAIN_OBSERVATION_TYPES = ['discovery', 'change', 'feature', 'bugfix', 'decision', 'refactor'] as const;

/** Source types for observations (how the observation was created). */
export const BRAIN_OBSERVATION_SOURCE_TYPES = ['agent', 'session-debrief', 'claude-mem', 'manual'] as const;

/** Memory entity types for the links table. */
export const BRAIN_MEMORY_TYPES = ['decision', 'pattern', 'learning', 'observation'] as const;

/** Sticky note status values. */
export const BRAIN_STICKY_STATUSES = ['active', 'converted', 'archived'] as const;

/** Sticky note colors. */
export const BRAIN_STICKY_COLORS = ['yellow', 'blue', 'green', 'red', 'purple'] as const;

/** Sticky note priority levels. */
export const BRAIN_STICKY_PRIORITIES = ['low', 'medium', 'high'] as const;

// === BRAIN_DECISIONS TABLE ===

export const brainDecisions = sqliteTable('brain_decisions', {
  id: text('id').primaryKey(),
  type: text('type', { enum: BRAIN_DECISION_TYPES }).notNull(),
  decision: text('decision').notNull(),
  rationale: text('rationale').notNull(),
  confidence: text('confidence', { enum: BRAIN_CONFIDENCE_LEVELS }).notNull(),
  outcome: text('outcome', { enum: BRAIN_OUTCOME_TYPES }),
  alternativesJson: text('alternatives_json'),
  contextEpicId: text('context_epic_id'),   // soft FK to tasks.id in tasks.db
  contextTaskId: text('context_task_id'),   // soft FK to tasks.id in tasks.db
  contextPhase: text('context_phase'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at'),
}, (table) => [
  index('idx_brain_decisions_type').on(table.type),
  index('idx_brain_decisions_confidence').on(table.confidence),
  index('idx_brain_decisions_outcome').on(table.outcome),
  index('idx_brain_decisions_context_epic').on(table.contextEpicId),
  index('idx_brain_decisions_context_task').on(table.contextTaskId),
]);

// === BRAIN_PATTERNS TABLE ===

export const brainPatterns = sqliteTable('brain_patterns', {
  id: text('id').primaryKey(),
  type: text('type', { enum: BRAIN_PATTERN_TYPES }).notNull(),
  pattern: text('pattern').notNull(),
  context: text('context').notNull(),
  frequency: integer('frequency').notNull().default(1),
  successRate: real('success_rate'),
  impact: text('impact', { enum: BRAIN_IMPACT_LEVELS }),
  antiPattern: text('anti_pattern'),
  mitigation: text('mitigation'),
  examplesJson: text('examples_json').default('[]'),
  extractedAt: text('extracted_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at'),
}, (table) => [
  index('idx_brain_patterns_type').on(table.type),
  index('idx_brain_patterns_impact').on(table.impact),
  index('idx_brain_patterns_frequency').on(table.frequency),
]);

// === BRAIN_LEARNINGS TABLE ===

export const brainLearnings = sqliteTable('brain_learnings', {
  id: text('id').primaryKey(),
  insight: text('insight').notNull(),
  source: text('source').notNull(),
  confidence: real('confidence').notNull(),  // 0.0-1.0
  actionable: integer('actionable', { mode: 'boolean' }).notNull().default(false),
  application: text('application'),
  applicableTypesJson: text('applicable_types_json'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at'),
}, (table) => [
  index('idx_brain_learnings_confidence').on(table.confidence),
  index('idx_brain_learnings_actionable').on(table.actionable),
]);

// === BRAIN_OBSERVATIONS TABLE ===

/** General-purpose observations — replaces claude-mem's observations table. */
export const brainObservations = sqliteTable('brain_observations', {
  id: text('id').primaryKey(),
  type: text('type', { enum: BRAIN_OBSERVATION_TYPES }).notNull(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  narrative: text('narrative'),
  factsJson: text('facts_json'),        // JSON array of fact strings
  conceptsJson: text('concepts_json'),  // JSON array of concept strings
  project: text('project'),
  filesReadJson: text('files_read_json'),      // JSON array of file paths
  filesModifiedJson: text('files_modified_json'), // JSON array of file paths
  sourceSessionId: text('source_session_id'),  // soft FK to sessions
  sourceType: text('source_type', { enum: BRAIN_OBSERVATION_SOURCE_TYPES }).notNull().default('agent'),
  contentHash: text('content_hash'),               // SHA-256 prefix for dedup
  discoveryTokens: integer('discovery_tokens'), // cost to produce this observation
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at'),
}, (table) => [
  index('idx_brain_observations_type').on(table.type),
  index('idx_brain_observations_project').on(table.project),
  index('idx_brain_observations_created_at').on(table.createdAt),
  index('idx_brain_observations_source_type').on(table.sourceType),
  index('idx_brain_observations_source_session').on(table.sourceSessionId),
  index('idx_brain_observations_content_hash').on(table.contentHash),
]);

// === BRAIN_STICKY_NOTES TABLE ===

/** Ephemeral sticky notes for quick capture before formal classification. */
export const brainStickyNotes = sqliteTable('brain_sticky_notes', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at'),
  tagsJson: text('tags_json'),
  status: text('status', { enum: BRAIN_STICKY_STATUSES }).notNull().default('active'),
  convertedToJson: text('converted_to_json'),
  color: text('color', { enum: BRAIN_STICKY_COLORS }),
  priority: text('priority', { enum: BRAIN_STICKY_PRIORITIES }),
  sourceType: text('source_type').default('sticky-note'),
}, (table) => [
  index('idx_brain_sticky_status').on(table.status),
  index('idx_brain_sticky_created').on(table.createdAt),
  index('idx_brain_sticky_tags').on(table.tagsJson),
]);

// === BRAIN_MEMORY_LINKS TABLE ===

/** Cross-references between BRAIN entries and tasks in tasks.db. */
export const brainMemoryLinks = sqliteTable('brain_memory_links', {
  memoryType: text('memory_type', { enum: BRAIN_MEMORY_TYPES }).notNull(),
  memoryId: text('memory_id').notNull(),
  taskId: text('task_id').notNull(),    // soft FK to tasks.id in tasks.db
  linkType: text('link_type', { enum: BRAIN_LINK_TYPES }).notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.memoryType, table.memoryId, table.taskId, table.linkType] }),
  index('idx_brain_links_task').on(table.taskId),
  index('idx_brain_links_memory').on(table.memoryType, table.memoryId),
]);

// === SCHEMA METADATA ===

export const brainSchemaMeta = sqliteTable('brain_schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// === PAGEINDEX GRAPH TABLES (T5160) ===

/** Node types for PageIndex graph. */
export const BRAIN_NODE_TYPES = ['task', 'doc', 'file', 'concept'] as const;

/** Edge types for PageIndex graph. */
export const BRAIN_EDGE_TYPES = ['depends_on', 'relates_to', 'implements', 'documents'] as const;

/** Documents/concepts as graph nodes for cross-document linking. */
export const brainPageNodes = sqliteTable('brain_page_nodes', {
  id: text('id').primaryKey(),           // 'task:T5241', 'doc:BRAIN-SPEC', 'file:src/store/brain-schema.ts'
  nodeType: text('node_type', { enum: BRAIN_NODE_TYPES }).notNull(),
  label: text('label').notNull(),
  metadataJson: text('metadata_json'),   // JSON blob for extensible metadata
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_brain_nodes_type').on(table.nodeType),
]);

/** Directed links between graph nodes. */
export const brainPageEdges = sqliteTable('brain_page_edges', {
  fromId: text('from_id').notNull(),
  toId: text('to_id').notNull(),
  edgeType: text('edge_type', { enum: BRAIN_EDGE_TYPES }).notNull(),
  weight: real('weight').default(1.0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.fromId, table.toId, table.edgeType] }),
  index('idx_brain_edges_from').on(table.fromId),
  index('idx_brain_edges_to').on(table.toId),
]);

// === TYPE EXPORTS ===

export type BrainDecisionRow = typeof brainDecisions.$inferSelect;
export type NewBrainDecisionRow = typeof brainDecisions.$inferInsert;
export type BrainPatternRow = typeof brainPatterns.$inferSelect;
export type NewBrainPatternRow = typeof brainPatterns.$inferInsert;
export type BrainLearningRow = typeof brainLearnings.$inferSelect;
export type NewBrainLearningRow = typeof brainLearnings.$inferInsert;
export type BrainObservationRow = typeof brainObservations.$inferSelect;
export type NewBrainObservationRow = typeof brainObservations.$inferInsert;
export type BrainMemoryLinkRow = typeof brainMemoryLinks.$inferSelect;
export type NewBrainMemoryLinkRow = typeof brainMemoryLinks.$inferInsert;
export type BrainPageNodeRow = typeof brainPageNodes.$inferSelect;
export type NewBrainPageNodeRow = typeof brainPageNodes.$inferInsert;
export type BrainPageEdgeRow = typeof brainPageEdges.$inferSelect;
export type NewBrainPageEdgeRow = typeof brainPageEdges.$inferInsert;
export type BrainStickyNoteRow = typeof brainStickyNotes.$inferSelect;
export type NewBrainStickyNoteRow = typeof brainStickyNotes.$inferInsert;
