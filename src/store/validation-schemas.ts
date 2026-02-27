/**
 * Drizzle-derived Zod validation schemas for all CLEO database tables.
 *
 * Uses `drizzle-orm/zod` to generate insert/select validation schemas
 * directly from Drizzle table definitions in `./schema.ts`. This ensures
 * validation rules stay in sync with the database schema automatically.
 *
 * @module validation-schemas
 * @task T3.4
 */

import { createInsertSchema, createSelectSchema } from 'drizzle-orm/zod';
import { z } from 'zod/v4';
import {
  tasks,
  taskDependencies,
  taskRelations,
  sessions,
  taskWorkHistory,
  lifecyclePipelines,
  lifecycleStages,
  lifecycleGateResults,
  lifecycleEvidence,
  lifecycleTransitions,
  schemaMeta,
  auditLog,
  architectureDecisions,
} from './schema.js';
import { SESSION_STATUSES } from './status-registry.js';

// === TASKS ===

/** Task field refinements matching schema-validator.ts constraints. */
const taskRefinements = {
  id: (s: z.ZodString) => s.regex(/^T\d{3,}$/),
  title: (s: z.ZodString) => s.min(1).max(120),
  description: (s: z.ZodString) => s.max(2000),
};

export const insertTaskSchema = createInsertSchema(tasks, taskRefinements);
export const selectTaskSchema = createSelectSchema(tasks, taskRefinements);

// === TASK DEPENDENCIES ===

export const insertTaskDependencySchema = createInsertSchema(taskDependencies);
export const selectTaskDependencySchema = createSelectSchema(taskDependencies);

// === TASK RELATIONS ===

export const insertTaskRelationSchema = createInsertSchema(taskRelations);
export const selectTaskRelationSchema = createSelectSchema(taskRelations);

// === SESSIONS ===

export const insertSessionSchema = createInsertSchema(sessions);
export const selectSessionSchema = createSelectSchema(sessions);

// === SESSION DOMAIN TYPES (Drizzle-first) ===
// Sub-schemas for JSON column shapes, domain transform, and type exports.
// These are the SINGLE SOURCE OF TRUTH for all session types.

/** Zod schema for the session scope JSON blob. */
export const sessionScopeSchema = z.object({
  type: z.string(),
  epicId: z.string().optional(),
  rootTaskId: z.string().optional(),
  includeDescendants: z.boolean().optional(),
  phaseFilter: z.union([z.string(), z.null()]).optional(),
  labelFilter: z.union([z.array(z.string()), z.null()]).optional(),
  maxDepth: z.union([z.number(), z.null()]).optional(),
  explicitTaskIds: z.union([z.array(z.string()), z.null()]).optional(),
  excludeTaskIds: z.union([z.array(z.string()), z.null()]).optional(),
  computedTaskIds: z.array(z.string()).optional(),
  computedAt: z.string().optional(),
});

/** Zod schema for session statistics. */
export const sessionStatsSchema = z.object({
  tasksCompleted: z.number(),
  tasksCreated: z.number(),
  tasksUpdated: z.number(),
  focusChanges: z.number(),
  totalActiveMinutes: z.number(),
  suspendCount: z.number(),
});

/** Zod schema for active task work state within a session. */
export const sessionTaskWorkSchema = z.object({
  taskId: z.union([z.string(), z.null()]),
  setAt: z.union([z.string(), z.null()]),
});

/** Inferred types from Zod sub-schemas. */
export type SessionScope = z.infer<typeof sessionScopeSchema>;
export type SessionStats = z.infer<typeof sessionStatsSchema>;
export type SessionTaskWork = z.infer<typeof sessionTaskWorkSchema>;

/**
 * Session domain schema — Zod object schema defining the canonical Session type.
 * Columns are derived from the Drizzle sessions table; JSON blobs use sub-schemas.
 * Non-required fields use .optional() so Session objects can be created ergonomically.
 *
 * This is the SINGLE SOURCE OF TRUTH for the Session type.
 */
export const sessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(SESSION_STATUSES),
  scope: sessionScopeSchema,
  taskWork: sessionTaskWorkSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  agent: z.string().optional(),
  notes: z.array(z.string()).optional(),
  tasksCompleted: z.array(z.string()).optional(),
  tasksCreated: z.array(z.string()).optional(),
  handoffJson: z.string().nullable().optional(),
  previousSessionId: z.string().nullable().optional(),
  nextSessionId: z.string().nullable().optional(),
  agentIdentifier: z.string().nullable().optional(),
  handoffConsumedAt: z.string().nullable().optional(),
  handoffConsumedBy: z.string().nullable().optional(),
  debriefJson: z.string().nullable().optional(),
  stats: sessionStatsSchema.optional(),
  resumeCount: z.number().optional(),
  gradeMode: z.boolean().optional(),
});

/** Session domain type — derived from Zod schema aligned with Drizzle sessions table. */
export type Session = z.infer<typeof sessionSchema>;

// === TASK WORK HISTORY ===

export const insertWorkHistorySchema = createInsertSchema(taskWorkHistory);
export const selectWorkHistorySchema = createSelectSchema(taskWorkHistory);

// === LIFECYCLE PIPELINES ===

export const insertLifecyclePipelineSchema = createInsertSchema(lifecyclePipelines);
export const selectLifecyclePipelineSchema = createSelectSchema(lifecyclePipelines);

// === LIFECYCLE STAGES ===

export const insertLifecycleStageSchema = createInsertSchema(lifecycleStages);
export const selectLifecycleStageSchema = createSelectSchema(lifecycleStages);

// === LIFECYCLE GATE RESULTS ===

export const insertLifecycleGateResultSchema = createInsertSchema(lifecycleGateResults);
export const selectLifecycleGateResultSchema = createSelectSchema(lifecycleGateResults);

// === LIFECYCLE EVIDENCE ===

export const insertLifecycleEvidenceSchema = createInsertSchema(lifecycleEvidence);
export const selectLifecycleEvidenceSchema = createSelectSchema(lifecycleEvidence);

// === LIFECYCLE TRANSITIONS ===

export const insertLifecycleTransitionSchema = createInsertSchema(lifecycleTransitions);
export const selectLifecycleTransitionSchema = createSelectSchema(lifecycleTransitions);

// === SCHEMA METADATA ===

export const insertSchemaMetaSchema = createInsertSchema(schemaMeta);
export const selectSchemaMetaSchema = createSelectSchema(schemaMeta);

// === AUDIT LOG ===

/**
 * Zod schema for validating audit log insert payloads.
 * @task T4848
 */
export const insertAuditLogSchema = createInsertSchema(auditLog, {
  id: (s: z.ZodString) => s.uuid(),
  timestamp: (s: z.ZodString) => s.datetime({ offset: true }).or(s.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)),
  action: (s: z.ZodString) => s.min(1).max(100),
  taskId: (s: z.ZodString) => s.min(1).max(20),
  actor: (s: z.ZodString) => s.min(1).max(50),
});

/**
 * Canonical named export for audit log insert schema (T4848).
 * Alias for insertAuditLogSchema.
 */
export const AuditLogInsertSchema = insertAuditLogSchema;

export const selectAuditLogSchema = createSelectSchema(auditLog);

/**
 * Canonical named export for audit log select schema (T4848).
 * Alias for selectAuditLogSchema.
 */
export const AuditLogSelectSchema = selectAuditLogSchema;

// === ARCHITECTURE DECISIONS ===

export const insertArchitectureDecisionSchema = createInsertSchema(architectureDecisions);
export const selectArchitectureDecisionSchema = createSelectSchema(architectureDecisions);

// === INFERRED TYPES ===

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type SelectTask = z.infer<typeof selectTaskSchema>;

export type InsertTaskDependency = z.infer<typeof insertTaskDependencySchema>;
export type SelectTaskDependency = z.infer<typeof selectTaskDependencySchema>;

export type InsertTaskRelation = z.infer<typeof insertTaskRelationSchema>;
export type SelectTaskRelation = z.infer<typeof selectTaskRelationSchema>;

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type SelectSession = z.infer<typeof selectSessionSchema>;

export type InsertWorkHistory = z.infer<typeof insertWorkHistorySchema>;
export type SelectWorkHistory = z.infer<typeof selectWorkHistorySchema>;

export type InsertLifecyclePipeline = z.infer<typeof insertLifecyclePipelineSchema>;
export type SelectLifecyclePipeline = z.infer<typeof selectLifecyclePipelineSchema>;

export type InsertLifecycleStage = z.infer<typeof insertLifecycleStageSchema>;
export type SelectLifecycleStage = z.infer<typeof selectLifecycleStageSchema>;

export type InsertLifecycleGateResult = z.infer<typeof insertLifecycleGateResultSchema>;
export type SelectLifecycleGateResult = z.infer<typeof selectLifecycleGateResultSchema>;

export type InsertLifecycleEvidence = z.infer<typeof insertLifecycleEvidenceSchema>;
export type SelectLifecycleEvidence = z.infer<typeof selectLifecycleEvidenceSchema>;

export type InsertLifecycleTransition = z.infer<typeof insertLifecycleTransitionSchema>;
export type SelectLifecycleTransition = z.infer<typeof selectLifecycleTransitionSchema>;

export type InsertSchemaMeta = z.infer<typeof insertSchemaMetaSchema>;
export type SelectSchemaMeta = z.infer<typeof selectSchemaMetaSchema>;

export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type SelectAuditLog = z.infer<typeof selectAuditLogSchema>;

/** Canonical type alias for audit log insert (T4848). */
export type AuditLogInsert = InsertAuditLog;
/** Canonical type alias for audit log select (T4848). */
export type AuditLogSelect = SelectAuditLog;

export type InsertArchitectureDecision = z.infer<typeof insertArchitectureDecisionSchema>;
export type SelectArchitectureDecision = z.infer<typeof selectArchitectureDecisionSchema>;
