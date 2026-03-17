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
import { SESSION_STATUSES } from './status-registry.js';
import { architectureDecisions, auditLog, lifecycleEvidence, lifecycleGateResults, lifecyclePipelines, lifecycleStages, lifecycleTransitions, manifestEntries, schemaMeta, sessions, taskDependencies, taskRelations, tasks, taskWorkHistory, tokenUsage, } from './tasks-schema.js';
// === TASKS ===
/** Task field refinements matching schema-validator.ts constraints. */
const taskRefinements = {
    id: (s) => s.regex(/^T\d{3,}$/),
    title: (s) => s.min(1).max(120),
    description: (s) => s.max(2000),
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
    providerId: z.string().nullable().optional(),
});
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
    id: (s) => s.uuid(),
    timestamp: (s) => s.datetime({ offset: true }).or(s.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)),
    action: (s) => s.min(1).max(100),
    taskId: (s) => s.min(1).max(20),
    actor: (s) => s.min(1).max(50),
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
// === TOKEN USAGE ===
export const insertTokenUsageSchema = createInsertSchema(tokenUsage);
export const selectTokenUsageSchema = createSelectSchema(tokenUsage);
// === MANIFEST ENTRIES ===
export const insertManifestEntrySchema = createInsertSchema(manifestEntries);
export const selectManifestEntrySchema = createSelectSchema(manifestEntries);
//# sourceMappingURL=validation-schemas.js.map