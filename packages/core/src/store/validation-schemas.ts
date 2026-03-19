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

import { createSchemaFactory } from 'drizzle-orm/zod';
import { z } from 'zod/v4';

// Use factory to bind our zod/v4 instance — ensures drizzle-orm/zod uses
// the same z we use everywhere. The type assertion is needed because
// drizzle-orm beta.18's CoerceOptions type doesn't match zod/v4's coerce
// namespace shape (works correctly at runtime).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { createInsertSchema, createSelectSchema } = createSchemaFactory(z as any);

import {
  architectureDecisions,
  auditLog,
  lifecycleEvidence,
  lifecycleGateResults,
  lifecyclePipelines,
  lifecycleStages,
  lifecycleTransitions,
  manifestEntries,
  schemaMeta,
  sessions,
  taskDependencies,
  taskRelations,
  tasks,
  taskWorkHistory,
  tokenUsage,
} from './tasks-schema.js';

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

// Session domain types (Session, SessionScope, SessionStats, SessionTaskWork)
// are defined in @cleocode/contracts — the single source of truth.
// The Drizzle-derived insertSessionSchema / selectSessionSchema above
// handle DB row validation; no separate domain Zod schema is needed.

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
  timestamp: (s: z.ZodString) =>
    s.datetime({ offset: true }).or(s.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)),
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

// === TOKEN USAGE ===

export const insertTokenUsageSchema = createInsertSchema(tokenUsage);
export const selectTokenUsageSchema = createSelectSchema(tokenUsage);

export type InsertTokenUsage = z.infer<typeof insertTokenUsageSchema>;
export type SelectTokenUsage = z.infer<typeof selectTokenUsageSchema>;

export type InsertArchitectureDecision = z.infer<typeof insertArchitectureDecisionSchema>;
export type SelectArchitectureDecision = z.infer<typeof selectArchitectureDecisionSchema>;

// === MANIFEST ENTRIES ===

export const insertManifestEntrySchema = createInsertSchema(manifestEntries);
export const selectManifestEntrySchema = createSelectSchema(manifestEntries);

export type InsertManifestEntry = z.infer<typeof insertManifestEntrySchema>;
export type SelectManifestEntry = z.infer<typeof selectManifestEntrySchema>;
