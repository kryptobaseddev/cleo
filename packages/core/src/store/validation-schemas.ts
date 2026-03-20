/**
 * Drizzle-derived Zod validation schemas for all CLEO database tables.
 *
 * Uses `drizzle-orm/zod` to generate insert/select validation schemas
 * directly from Drizzle table definitions in `./schema.ts`. This ensures
 * validation rules stay in sync with the database schema automatically.
 *
 * Also exports canonical Zod enum schemas for all domain enums so that
 * consumers (e.g. CleoOS, plugins) can import them instead of duplicating.
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
const { createInsertSchema, createSelectSchema } = createSchemaFactory(
  z as unknown as Parameters<typeof createSchemaFactory>[0],
);

import {
  architectureDecisions,
  auditLog,
  externalTaskLinks,
  lifecycleEvidence,
  lifecycleGateResults,
  lifecyclePipelines,
  lifecycleStages,
  lifecycleTransitions,
  manifestEntries,
  pipelineManifest,
  releaseManifests,
  schemaMeta,
  sessions,
  taskDependencies,
  taskRelations,
  tasks,
  taskWorkHistory,
  tokenUsage,
  // Enum constants (non-status) from tasks-schema
  EXTERNAL_LINK_TYPES,
  LIFECYCLE_EVIDENCE_TYPES,
  LIFECYCLE_GATE_RESULTS,
  LIFECYCLE_STAGE_NAMES,
  LIFECYCLE_TRANSITION_TYPES,
  SYNC_DIRECTIONS,
  TASK_PRIORITIES,
  TASK_RELATION_TYPES,
  TASK_SIZES,
  TASK_TYPES,
  TOKEN_USAGE_CONFIDENCE,
  TOKEN_USAGE_METHODS,
  TOKEN_USAGE_TRANSPORTS,
  // Agent enum constants
  AGENT_INSTANCE_STATUSES,
  AGENT_TYPES,
  agentInstances,
  agentErrorLog,
} from './tasks-schema.js';

// Status constants from the canonical registry
import {
  ADR_STATUSES,
  GATE_STATUSES,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  MANIFEST_STATUSES,
  SESSION_STATUSES,
  TASK_STATUSES,
} from './status-registry.js';

// Brain enum constants
import {
  BRAIN_CONFIDENCE_LEVELS,
  BRAIN_DECISION_TYPES,
  BRAIN_EDGE_TYPES,
  BRAIN_IMPACT_LEVELS,
  BRAIN_LINK_TYPES,
  BRAIN_MEMORY_TYPES,
  BRAIN_NODE_TYPES,
  BRAIN_OBSERVATION_SOURCE_TYPES,
  BRAIN_OBSERVATION_TYPES,
  BRAIN_OUTCOME_TYPES,
  BRAIN_PATTERN_TYPES,
  BRAIN_STICKY_COLORS,
  BRAIN_STICKY_PRIORITIES,
  BRAIN_STICKY_STATUSES,
} from './brain-schema.js';

// =========================================================================
// CANONICAL ZOD ENUM SCHEMAS
// =========================================================================
// These are the single source of truth for enum validation that consumers
// (e.g. CleoOS tRPC routers) should import instead of duplicating.
// Each wraps the corresponding `as const` array from tasks-schema.ts,
// status-registry.ts, or brain-schema.ts.

// --- Task enums ---
/** Zod enum schema for task statuses. */
export const taskStatusSchema = z.enum(TASK_STATUSES);
/** Zod enum schema for task priorities. */
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
/** Zod enum schema for task types. */
export const taskTypeSchema = z.enum(TASK_TYPES);
/** Zod enum schema for task sizes. */
export const taskSizeSchema = z.enum(TASK_SIZES);

// --- Session enums ---
/** Zod enum schema for session statuses. */
export const sessionStatusSchema = z.enum(SESSION_STATUSES);

// --- Lifecycle enums ---
/** Zod enum schema for lifecycle pipeline statuses. */
export const lifecyclePipelineStatusSchema = z.enum(LIFECYCLE_PIPELINE_STATUSES);
/** Zod enum schema for lifecycle stage statuses. */
export const lifecycleStageStatusSchema = z.enum(LIFECYCLE_STAGE_STATUSES);
/** Zod enum schema for lifecycle stage names. */
export const lifecycleStageNameSchema = z.enum(LIFECYCLE_STAGE_NAMES);
/** Zod enum schema for lifecycle gate results. */
export const lifecycleGateResultSchema = z.enum(LIFECYCLE_GATE_RESULTS);
/** Zod enum schema for lifecycle evidence types. */
export const lifecycleEvidenceTypeSchema = z.enum(LIFECYCLE_EVIDENCE_TYPES);

// --- Governance enums ---
/** Zod enum schema for ADR statuses. */
export const adrStatusSchema = z.enum(ADR_STATUSES);
/** Zod enum schema for gate statuses. */
export const gateStatusSchema = z.enum(GATE_STATUSES);
/** Zod enum schema for manifest statuses. */
export const manifestStatusSchema = z.enum(MANIFEST_STATUSES);

// --- Token usage enums ---
/** Zod enum schema for token usage measurement methods. */
export const tokenUsageMethodSchema = z.enum(TOKEN_USAGE_METHODS);
/** Zod enum schema for token usage confidence levels. */
export const tokenUsageConfidenceSchema = z.enum(TOKEN_USAGE_CONFIDENCE);
/** Zod enum schema for token usage transports. */
export const tokenUsageTransportSchema = z.enum(TOKEN_USAGE_TRANSPORTS);

// --- Task relation enums ---
/** Zod enum schema for task relation types. */
export const taskRelationTypeSchema = z.enum(TASK_RELATION_TYPES);

// --- External task link enums ---
/** Zod enum schema for external task link types. */
export const externalLinkTypeSchema = z.enum(EXTERNAL_LINK_TYPES);
/** Zod enum schema for sync directions. */
export const syncDirectionSchema = z.enum(SYNC_DIRECTIONS);

// --- Lifecycle transition enums ---
/** Zod enum schema for lifecycle transition types. */
export const lifecycleTransitionTypeSchema = z.enum(LIFECYCLE_TRANSITION_TYPES);

// --- Brain enums ---
/** Zod enum schema for brain observation types. */
export const brainObservationTypeSchema = z.enum(BRAIN_OBSERVATION_TYPES);
/** Zod enum schema for brain observation source types. */
export const brainObservationSourceTypeSchema = z.enum(BRAIN_OBSERVATION_SOURCE_TYPES);
/** Zod enum schema for brain decision types. */
export const brainDecisionTypeSchema = z.enum(BRAIN_DECISION_TYPES);
/** Zod enum schema for brain confidence levels. */
export const brainConfidenceLevelSchema = z.enum(BRAIN_CONFIDENCE_LEVELS);
/** Zod enum schema for brain outcome types. */
export const brainOutcomeTypeSchema = z.enum(BRAIN_OUTCOME_TYPES);
/** Zod enum schema for brain pattern types. */
export const brainPatternTypeSchema = z.enum(BRAIN_PATTERN_TYPES);
/** Zod enum schema for brain impact levels. */
export const brainImpactLevelSchema = z.enum(BRAIN_IMPACT_LEVELS);
/** Zod enum schema for brain link types. */
export const brainLinkTypeSchema = z.enum(BRAIN_LINK_TYPES);
/** Zod enum schema for brain memory entity types. */
export const brainMemoryTypeSchema = z.enum(BRAIN_MEMORY_TYPES);
/** Zod enum schema for brain sticky note statuses. */
export const brainStickyStatusSchema = z.enum(BRAIN_STICKY_STATUSES);
/** Zod enum schema for brain sticky note colors. */
export const brainStickyColorSchema = z.enum(BRAIN_STICKY_COLORS);
/** Zod enum schema for brain sticky note priorities. */
export const brainStickyPrioritySchema = z.enum(BRAIN_STICKY_PRIORITIES);
/** Zod enum schema for brain page node types. */
export const brainNodeTypeSchema = z.enum(BRAIN_NODE_TYPES);
/** Zod enum schema for brain page edge types. */
export const brainEdgeTypeSchema = z.enum(BRAIN_EDGE_TYPES);

// =========================================================================
// DRIZZLE-DERIVED INSERT/SELECT SCHEMAS WITH BUSINESS LOGIC REFINEMENTS
// =========================================================================

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

/** Task relation refinements — enforce enum values for relation_type. */
const taskRelationRefinements = {
  reason: (s: z.ZodString) => s.max(500),
};

export const insertTaskRelationSchema = createInsertSchema(taskRelations, taskRelationRefinements);
export const selectTaskRelationSchema = createSelectSchema(taskRelations, taskRelationRefinements);

// === SESSIONS ===

/** Session refinements — name constraints and timestamp validation. */
const sessionRefinements = {
  name: (s: z.ZodString) => s.min(1).max(200),
};

export const insertSessionSchema = createInsertSchema(sessions, sessionRefinements);
export const selectSessionSchema = createSelectSchema(sessions, sessionRefinements);

// Session domain types (Session, SessionScope, SessionStats, SessionTaskWork)
// are defined in @cleocode/contracts — the single source of truth.
// The Drizzle-derived insertSessionSchema / selectSessionSchema above
// handle DB row validation; no separate domain Zod schema is needed.

// === TASK WORK HISTORY ===

export const insertWorkHistorySchema = createInsertSchema(taskWorkHistory);
export const selectWorkHistorySchema = createSelectSchema(taskWorkHistory);

// === LIFECYCLE PIPELINES ===

/** Lifecycle pipeline refinements — status and timestamp constraints. */
const lifecyclePipelineRefinements = {
  id: (s: z.ZodString) => s.min(1),
  taskId: (s: z.ZodString) => s.min(1),
};

export const insertLifecyclePipelineSchema = createInsertSchema(
  lifecyclePipelines,
  lifecyclePipelineRefinements,
);
export const selectLifecyclePipelineSchema = createSelectSchema(
  lifecyclePipelines,
  lifecyclePipelineRefinements,
);

// === LIFECYCLE STAGES ===

/** Lifecycle stage refinements — sequence must be non-negative. */
const lifecycleStageRefinements = {
  id: (s: z.ZodString) => s.min(1),
  pipelineId: (s: z.ZodString) => s.min(1),
  blockReason: (s: z.ZodString) => s.max(1000),
  skipReason: (s: z.ZodString) => s.max(1000),
};

export const insertLifecycleStageSchema = createInsertSchema(
  lifecycleStages,
  lifecycleStageRefinements,
);
export const selectLifecycleStageSchema = createSelectSchema(
  lifecycleStages,
  lifecycleStageRefinements,
);

// === LIFECYCLE GATE RESULTS ===

/** Lifecycle gate result refinements — gate name and checker constraints. */
const lifecycleGateResultRefinements = {
  id: (s: z.ZodString) => s.min(1),
  stageId: (s: z.ZodString) => s.min(1),
  gateName: (s: z.ZodString) => s.min(1).max(100),
  checkedBy: (s: z.ZodString) => s.min(1).max(100),
  details: (s: z.ZodString) => s.max(2000),
  reason: (s: z.ZodString) => s.max(1000),
};

export const insertLifecycleGateResultSchema = createInsertSchema(
  lifecycleGateResults,
  lifecycleGateResultRefinements,
);
export const selectLifecycleGateResultSchema = createSelectSchema(
  lifecycleGateResults,
  lifecycleGateResultRefinements,
);

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

/** Architecture decision refinements — title length and content constraints. */
const architectureDecisionRefinements = {
  id: (s: z.ZodString) => s.min(1),
  title: (s: z.ZodString) => s.min(1).max(200),
  content: (s: z.ZodString) => s.min(1),
  summary: (s: z.ZodString) => s.max(500),
};

export const insertArchitectureDecisionSchema = createInsertSchema(
  architectureDecisions,
  architectureDecisionRefinements,
);
export const selectArchitectureDecisionSchema = createSelectSchema(
  architectureDecisions,
  architectureDecisionRefinements,
);

// === TOKEN USAGE ===

/** Token usage refinements — enforce non-negative token counts. */
const tokenUsageRefinements = {
  id: (s: z.ZodString) => s.min(1),
  provider: (s: z.ZodString) => s.min(1).max(100),
  model: (s: z.ZodString) => s.max(200),
};

export const insertTokenUsageSchema = createInsertSchema(tokenUsage, tokenUsageRefinements);
export const selectTokenUsageSchema = createSelectSchema(tokenUsage, tokenUsageRefinements);

// === MANIFEST ENTRIES ===

export const insertManifestEntrySchema = createInsertSchema(manifestEntries);
export const selectManifestEntrySchema = createSelectSchema(manifestEntries);

// === PIPELINE MANIFEST ===

/** Pipeline manifest refinements — type and content constraints. */
const pipelineManifestRefinements = {
  id: (s: z.ZodString) => s.min(1),
  type: (s: z.ZodString) => s.min(1).max(100),
  content: (s: z.ZodString) => s.min(1),
};

export const insertPipelineManifestSchema = createInsertSchema(
  pipelineManifest,
  pipelineManifestRefinements,
);
export const selectPipelineManifestSchema = createSelectSchema(
  pipelineManifest,
  pipelineManifestRefinements,
);

// === RELEASE MANIFESTS ===

/** Release manifest refinements — semver format for version. */
const releaseManifestRefinements = {
  id: (s: z.ZodString) => s.min(1),
  version: (s: z.ZodString) => s.regex(/^\d{4}\.\d+\.\d+$|^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/),
};

export const insertReleaseManifestSchema = createInsertSchema(
  releaseManifests,
  releaseManifestRefinements,
);
export const selectReleaseManifestSchema = createSelectSchema(
  releaseManifests,
  releaseManifestRefinements,
);

// === EXTERNAL TASK LINKS ===

/** External task link refinements — URL format and field length constraints. */
const externalTaskLinkRefinements = {
  id: (s: z.ZodString) => s.min(1),
  taskId: (s: z.ZodString) => s.min(1),
  providerId: (s: z.ZodString) => s.min(1).max(100),
  externalId: (s: z.ZodString) => s.min(1),
  externalUrl: (s: z.ZodString) => s.url(),
  externalTitle: (s: z.ZodString) => s.max(500),
};

export const insertExternalTaskLinkSchema = createInsertSchema(
  externalTaskLinks,
  externalTaskLinkRefinements,
);
export const selectExternalTaskLinkSchema = createSelectSchema(
  externalTaskLinks,
  externalTaskLinkRefinements,
);

// === AGENT INSTANCES ===

/** Agent instance refinements — ID format and metadata constraints. */
const agentInstanceRefinements = {
  id: (s: z.ZodString) => s.regex(/^agt_\d{14}_[0-9a-f]{6}$/),
};

export const insertAgentInstanceSchema = createInsertSchema(
  agentInstances,
  agentInstanceRefinements,
);
export const selectAgentInstanceSchema = createSelectSchema(
  agentInstances,
  agentInstanceRefinements,
);

// === AGENT ERROR LOG ===

export const insertAgentErrorLogSchema = createInsertSchema(agentErrorLog);
export const selectAgentErrorLogSchema = createSelectSchema(agentErrorLog);

// --- Agent enums ---
/** Zod enum schema for agent instance statuses. */
export const agentInstanceStatusSchema = z.enum(AGENT_INSTANCE_STATUSES);
/** Zod enum schema for agent types. */
export const agentTypeSchema = z.enum(AGENT_TYPES);

// =========================================================================
// INFERRED TYPES
// =========================================================================

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

export type InsertTokenUsage = z.infer<typeof insertTokenUsageSchema>;
export type SelectTokenUsage = z.infer<typeof selectTokenUsageSchema>;

export type InsertArchitectureDecision = z.infer<typeof insertArchitectureDecisionSchema>;
export type SelectArchitectureDecision = z.infer<typeof selectArchitectureDecisionSchema>;

export type InsertManifestEntry = z.infer<typeof insertManifestEntrySchema>;
export type SelectManifestEntry = z.infer<typeof selectManifestEntrySchema>;

export type InsertPipelineManifest = z.infer<typeof insertPipelineManifestSchema>;
export type SelectPipelineManifest = z.infer<typeof selectPipelineManifestSchema>;

export type InsertReleaseManifest = z.infer<typeof insertReleaseManifestSchema>;
export type SelectReleaseManifest = z.infer<typeof selectReleaseManifestSchema>;

export type InsertExternalTaskLink = z.infer<typeof insertExternalTaskLinkSchema>;
export type SelectExternalTaskLink = z.infer<typeof selectExternalTaskLinkSchema>;

export type InsertAgentInstance = z.infer<typeof insertAgentInstanceSchema>;
export type SelectAgentInstance = z.infer<typeof selectAgentInstanceSchema>;

export type InsertAgentErrorLog = z.infer<typeof insertAgentErrorLogSchema>;
export type SelectAgentErrorLog = z.infer<typeof selectAgentErrorLogSchema>;
