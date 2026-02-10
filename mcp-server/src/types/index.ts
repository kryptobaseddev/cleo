/**
 * CLEO MCP Server Type Definitions
 *
 * Central export file for all type definitions used across the MCP server.
 * Provides full type safety for all 96 operations across 8 domains.
 *
 * @module types
 */

// Gateway types
export type {
  GatewayType,
  DomainName,
  GatewayRequest,
  Meta,
  GatewayResponse,
  PartialSuccessResponse,
  ErrorResponse,
  Response,
} from './gateway.js';

// Domain types
export type {
  OperationMeta,
  DomainOperation,
  OperationRegistry,
} from './domain.js';

// Error types
export {
  GeneralErrorCode,
  HierarchyErrorCode,
  SessionErrorCode,
  GateErrorCode,
  ContextErrorCode,
  ProtocolErrorCode,
  LifecycleErrorCode,
  SpecialCode,
  ERROR_CODE_NAMES,
  RETRYABLE_ERROR_CODES,
  isRetryableError,
} from './error.js';
export type { ErrorCode } from './error.js';

// Tasks domain (19 operations)
export type {
  TaskStatus,
  TaskPriority,
  Task,
  MinimalTask,
  // Query operations
  TasksGetParams,
  TasksGetResult,
  TasksListParams,
  TasksListResult,
  TasksFindParams,
  TasksFindResult,
  TasksExistsParams,
  TasksExistsResult,
  TasksTreeParams,
  TaskTreeNode,
  TasksTreeResult,
  TasksBlockersParams,
  Blocker,
  TasksBlockersResult,
  TasksDepsParams,
  DependencyNode,
  TasksDepsResult,
  TasksAnalyzeParams,
  TriageRecommendation,
  TasksAnalyzeResult,
  TasksNextParams,
  SuggestedTask,
  TasksNextResult,
  // Mutate operations
  TasksCreateParams,
  TasksCreateResult,
  TasksUpdateParams,
  TasksUpdateResult,
  TasksCompleteParams,
  TasksCompleteResult,
  TasksDeleteParams,
  TasksDeleteResult,
  TasksArchiveParams,
  TasksArchiveResult,
  TasksUnarchiveParams,
  TasksUnarchiveResult,
  TasksReparentParams,
  TasksReparentResult,
  TasksPromoteParams,
  TasksPromoteResult,
  TasksReorderParams,
  TasksReorderResult,
  TasksReopenParams,
  TasksReopenResult,
} from './operations/tasks.js';

// Session domain (12 operations)
export type {
  Session,
  FocusInfo,
  // Query operations
  SessionStatusParams,
  SessionStatusResult,
  SessionListParams,
  SessionListResult,
  SessionShowParams,
  SessionShowResult,
  SessionFocusGetParams,
  SessionFocusGetResult,
  SessionHistoryParams,
  SessionHistoryEntry,
  SessionHistoryResult,
  // Mutate operations
  SessionStartParams,
  SessionStartResult,
  SessionEndParams,
  SessionEndResult,
  SessionResumeParams,
  SessionResumeResult,
  SessionSuspendParams,
  SessionSuspendResult,
  SessionFocusSetParams,
  SessionFocusSetResult,
  SessionFocusClearParams,
  SessionFocusClearResult,
  SessionGcParams,
  SessionGcResult,
} from './operations/session.js';

// Orchestrate domain (12 operations)
export type {
  Wave,
  SkillDefinition,
  // Query operations
  OrchestrateStatusParams,
  OrchestrateStatusResult,
  OrchestrateNextParams,
  OrchestrateNextResult,
  OrchestrateReadyParams,
  OrchestrateReadyResult,
  OrchestrateAnalyzeParams,
  OrchestrateAnalyzeResult,
  OrchestrateContextParams,
  OrchestrateContextResult,
  OrchestrateWavesParams,
  OrchestrateWavesResult,
  OrchestrateSkillListParams,
  OrchestrateSkillListResult,
  // Mutate operations
  OrchestrateStartupParams,
  OrchestrateStartupResult,
  OrchestrateSpawnParams,
  OrchestrateSpawnResult,
  OrchestrateValidateParams,
  OrchestrateValidateResult,
  OrchestrateParallelStartParams,
  OrchestrateParallelStartResult,
  OrchestrateParallelEndParams,
  OrchestrateParallelEndResult,
} from './operations/orchestrate.js';

// Research domain (10 operations)
export type {
  ResearchEntry,
  ManifestEntry,
  // Query operations
  ResearchShowParams,
  ResearchShowResult,
  ResearchListParams,
  ResearchListResult,
  ResearchQueryParams,
  ResearchQueryResult,
  ResearchPendingParams,
  ResearchPendingResult,
  ResearchStatsParams,
  ResearchStatsResult,
  ResearchManifestReadParams,
  ResearchManifestReadResult,
  // Mutate operations
  ResearchInjectParams,
  ResearchInjectResult,
  ResearchLinkParams,
  ResearchLinkResult,
  ResearchManifestAppendParams,
  ResearchManifestAppendResult,
  ResearchManifestArchiveParams,
  ResearchManifestArchiveResult,
} from './operations/research.js';

// Lifecycle domain (10 operations)
export type {
  LifecycleStage,
  StageStatus,
  GateStatus,
  StageRecord,
  Gate,
  // Query operations
  LifecycleCheckParams,
  LifecycleCheckResult,
  LifecycleStatusParams,
  LifecycleStatusResult,
  LifecycleHistoryParams,
  LifecycleHistoryEntry,
  LifecycleHistoryResult,
  LifecycleGatesParams,
  LifecycleGatesResult,
  LifecyclePrerequisitesParams,
  LifecyclePrerequisitesResult,
  // Mutate operations
  LifecycleProgressParams,
  LifecycleProgressResult,
  LifecycleSkipParams,
  LifecycleSkipResult,
  LifecycleResetParams,
  LifecycleResetResult,
  LifecycleGatePassParams,
  LifecycleGatePassResult,
  LifecycleGateFailParams,
  LifecycleGateFailResult,
} from './operations/lifecycle.js';

// Validate domain (11 operations)
export type {
  ValidationSeverity,
  ValidationViolation,
  ComplianceMetrics,
  // Query operations
  ValidateSchemaParams,
  ValidateSchemaResult,
  ValidateProtocolParams,
  ValidateProtocolResult,
  ValidateTaskParams,
  ValidateTaskResult,
  ValidateManifestParams,
  ValidateManifestResult,
  ValidateOutputParams,
  ValidateOutputResult,
  ValidateComplianceSummaryParams,
  ValidateComplianceSummaryResult,
  ValidateComplianceViolationsParams,
  ValidateComplianceViolationsResult,
  ValidateTestStatusParams,
  ValidateTestStatusResult,
  ValidateTestCoverageParams,
  ValidateTestCoverageResult,
  // Mutate operations
  ValidateComplianceRecordParams,
  ValidateComplianceRecordResult,
  ValidateTestRunParams,
  ValidateTestRunResult,
} from './operations/validate.js';

// Release domain (7 operations)
export type {
  ReleaseType,
  ReleaseGate,
  ChangelogSection,
  // All mutate operations
  ReleasePrepareParams,
  ReleasePrepareResult,
  ReleaseChangelogParams,
  ReleaseChangelogResult,
  ReleaseCommitParams,
  ReleaseCommitResult,
  ReleaseTagParams,
  ReleaseTagResult,
  ReleasePushParams,
  ReleasePushResult,
  ReleaseGatesRunParams,
  ReleaseGatesRunResult,
  ReleaseRollbackParams,
  ReleaseRollbackResult,
} from './operations/release.js';

// System domain (12 operations)
export type {
  HealthCheck,
  ProjectStats,
  // Query operations
  SystemVersionParams,
  SystemVersionResult,
  SystemDoctorParams,
  SystemDoctorResult,
  SystemConfigGetParams,
  SystemConfigGetResult,
  SystemStatsParams,
  SystemStatsResult,
  SystemContextParams,
  SystemContextResult,
  // Mutate operations
  SystemInitParams,
  SystemInitResult,
  SystemConfigSetParams,
  SystemConfigSetResult,
  SystemBackupParams,
  SystemBackupResult,
  SystemRestoreParams,
  SystemRestoreResult,
  SystemMigrateParams,
  SystemMigrateResult,
  SystemSyncParams,
  SystemSyncResult,
  SystemCleanupParams,
  SystemCleanupResult,
} from './operations/system.js';
