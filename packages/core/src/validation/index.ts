/**
 * Validation system barrel exports.
 *
 * Provides the complete validation system ported from lib/validation/*,
 * plus canonical Zod enum schemas for all domain enums so consumers can
 * import them from `@cleocode/core` instead of duplicating.
 *
 * @task T4523
 * @epic T4454
 */

// Core validation engine — also re-export registry constants for convenience
export { TASK_STATUSES } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Canonical Zod enum schemas (from validation-schemas.ts)
// ---------------------------------------------------------------------------
// Task enums
export {
  taskStatusSchema,
  taskPrioritySchema,
  taskTypeSchema,
  taskSizeSchema,
} from '../store/validation-schemas.js';
// Session enums
export { sessionStatusSchema } from '../store/validation-schemas.js';
// Lifecycle enums
export {
  lifecyclePipelineStatusSchema,
  lifecycleStageStatusSchema,
  lifecycleStageNameSchema,
  lifecycleGateResultSchema,
  lifecycleEvidenceTypeSchema,
  lifecycleTransitionTypeSchema,
} from '../store/validation-schemas.js';
// Governance enums
export {
  adrStatusSchema,
  gateStatusSchema,
  manifestStatusSchema,
} from '../store/validation-schemas.js';
// Token usage enums
export {
  tokenUsageMethodSchema,
  tokenUsageConfidenceSchema,
  tokenUsageTransportSchema,
} from '../store/validation-schemas.js';
// Relation / link enums
export {
  taskRelationTypeSchema,
  externalLinkTypeSchema,
  syncDirectionSchema,
} from '../store/validation-schemas.js';
// Brain enums
export {
  brainObservationTypeSchema,
  brainObservationSourceTypeSchema,
  brainDecisionTypeSchema,
  brainConfidenceLevelSchema,
  brainOutcomeTypeSchema,
  brainPatternTypeSchema,
  brainImpactLevelSchema,
  brainLinkTypeSchema,
  brainMemoryTypeSchema,
  brainStickyStatusSchema,
  brainStickyColorSchema,
  brainStickyPrioritySchema,
  brainNodeTypeSchema,
  brainEdgeTypeSchema,
} from '../store/validation-schemas.js';
// Insert/select schemas for all tables
export {
  insertTaskSchema,
  selectTaskSchema,
  insertTaskDependencySchema,
  selectTaskDependencySchema,
  insertTaskRelationSchema,
  selectTaskRelationSchema,
  insertSessionSchema,
  selectSessionSchema,
  insertWorkHistorySchema,
  selectWorkHistorySchema,
  insertLifecyclePipelineSchema,
  selectLifecyclePipelineSchema,
  insertLifecycleStageSchema,
  selectLifecycleStageSchema,
  insertLifecycleGateResultSchema,
  selectLifecycleGateResultSchema,
  insertLifecycleEvidenceSchema,
  selectLifecycleEvidenceSchema,
  insertLifecycleTransitionSchema,
  selectLifecycleTransitionSchema,
  insertSchemaMetaSchema,
  selectSchemaMetaSchema,
  insertAuditLogSchema,
  selectAuditLogSchema,
  AuditLogInsertSchema,
  AuditLogSelectSchema,
  insertArchitectureDecisionSchema,
  selectArchitectureDecisionSchema,
  insertTokenUsageSchema,
  selectTokenUsageSchema,
  insertManifestEntrySchema,
  selectManifestEntrySchema,
  insertPipelineManifestSchema,
  selectPipelineManifestSchema,
  insertReleaseManifestSchema,
  selectReleaseManifestSchema,
  insertExternalTaskLinkSchema,
  selectExternalTaskLinkSchema,
} from '../store/validation-schemas.js';
// Inferred types
export type {
  InsertTask,
  SelectTask,
  InsertTaskDependency,
  SelectTaskDependency,
  InsertTaskRelation,
  SelectTaskRelation,
  InsertSession,
  SelectSession,
  InsertWorkHistory,
  SelectWorkHistory,
  InsertLifecyclePipeline,
  SelectLifecyclePipeline,
  InsertLifecycleStage,
  SelectLifecycleStage,
  InsertLifecycleGateResult,
  SelectLifecycleGateResult,
  InsertLifecycleEvidence,
  SelectLifecycleEvidence,
  InsertLifecycleTransition,
  SelectLifecycleTransition,
  InsertSchemaMeta,
  SelectSchemaMeta,
  InsertAuditLog,
  SelectAuditLog,
  AuditLogInsert,
  AuditLogSelect,
  InsertArchitectureDecision,
  SelectArchitectureDecision,
  InsertTokenUsage,
  SelectTokenUsage,
  InsertManifestEntry,
  SelectManifestEntry,
  InsertPipelineManifest,
  SelectPipelineManifest,
  InsertReleaseManifest,
  SelectReleaseManifest,
  InsertExternalTaskLink,
  SelectExternalTaskLink,
} from '../store/validation-schemas.js';
// Compliance checking
export {
  type ComplianceMetrics,
  calculateOrchestrationOverhead,
  calculateTokenEfficiency,
  checkManifestEntry,
  checkReturnFormat,
  type ManifestIntegrity,
  type OrchestrationOverhead,
  scoreSubagentCompliance,
  type TokenEfficiency,
  type TokenMetrics,
} from './compliance.js';
// Documentation drift detection
export {
  checkCommandsSync,
  checkWrapperSync,
  type DriftIssue,
  type DriftReport,
  detectDrift,
  getIndexCommands,
  getIndexScripts,
  getScriptCommands,
  shouldRunDriftDetection,
} from './docs-sync.js';
// Doctor health checks
export * from './doctor/index.js';
export {
  type ArchiveData,
  type ComprehensiveValidationResult,
  checkIdUniqueness,
  checkTimestampSanity,
  FIELD_LIMITS,
  isMetadataOnlyUpdate,
  isValidStatus,
  normalizeLabels,
  sanitizeFilePath,
  type Task,
  type TaskData,
  type TaskStatus,
  VALID_OPERATIONS,
  type ValidationError,
  type ValidationResult,
  validateAll,
  validateBlockedBy,
  validateCancelReason,
  validateCurrentPhaseConsistency,
  validateDescription,
  validateNoCircularDeps,
  validateNote,
  validatePhaseStatusRequirements,
  validatePhaseTimestamps,
  validateSessionNote,
  validateSingleActivePhase,
  validateStatusTransition,
  validateTask,
  validateTitle,
} from './engine.js';
// Gap analysis
export {
  analyzeCoverage,
  type CoverageEntry,
  extractTopics,
  findReviewDocs,
  formatGapReport,
  type GapEntry,
  type GapReport,
  parseManifest,
  searchCanonicalCoverage,
} from './gap-check.js';
// Manifest validation
export {
  type ComplianceEntry,
  findManifestEntry,
  logRealCompliance,
  type ManifestEntry,
  type ManifestValidationResult,
  type ManifestViolation,
  validateAndLog,
  validateManifestEntry,
} from './manifest.js';
// Protocol validation common
export {
  checkAgentType,
  checkDocumentationSections,
  checkKeyFindingsCount,
  checkLinkedTasksPresent,
  checkManifestFieldPresent,
  checkManifestFieldType,
  checkOutputFileExists,
  checkProvenanceTags,
  checkReturnMessageFormat,
  checkStatusValid,
  type ProtocolValidationResult,
  type ProtocolViolation,
  validateCommonManifestRequirements,
} from './protocol-common.js';
// Verification gates
export {
  type AgentName,
  allEpicChildrenVerified,
  allSiblingsVerified,
  type CircularValidationResult,
  checkAllGatesPassed,
  checkCircularValidation,
  computePassed,
  type FailureLogEntry,
  type GateName,
  getDownstreamGates,
  getGateIndex,
  getGateOrder,
  getGateSummary,
  getMissingGates,
  getVerificationStatus,
  incrementRound,
  initVerification,
  isValidAgentName,
  isValidGateName,
  isVerificationComplete,
  logFailure,
  resetDownstreamGates,
  setVerificationPassed,
  shouldRequireVerification,
  type TaskForVerification,
  updateGate,
  VERIFICATION_GATE_ORDER,
  VERIFICATION_VALID_AGENTS,
  type Verification,
  type VerificationGates,
  type VerificationStatus,
} from './verification.js';
