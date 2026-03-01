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

/** Memory entity types for the links table. */
export const BRAIN_MEMORY_TYPES = ['decision', 'pattern', 'learning'] as const;

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

// === TYPE EXPORTS ===

export type BrainDecisionRow = typeof brainDecisions.$inferSelect;
export type NewBrainDecisionRow = typeof brainDecisions.$inferInsert;
export type BrainPatternRow = typeof brainPatterns.$inferSelect;
export type NewBrainPatternRow = typeof brainPatterns.$inferInsert;
export type BrainLearningRow = typeof brainLearnings.$inferSelect;
export type NewBrainLearningRow = typeof brainLearnings.$inferInsert;
export type BrainMemoryLinkRow = typeof brainMemoryLinks.$inferSelect;
export type NewBrainMemoryLinkRow = typeof brainMemoryLinks.$inferInsert;
