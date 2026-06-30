/**
 * @cleocode/contracts — Domain types, interfaces, and contracts for the CLEO ecosystem.
 *
 * This is the LEAF package in the dependency graph — ZERO runtime dependencies.
 * All domain types (Task, Session, DataAccessor, etc.) are defined here.
 * Implementation packages (@cleocode/core, @cleocode/cleo) import from here.
 */

// === Acceptance Gate Types (machine-verifiable criteria) ===
export type {
  AcceptanceGate,
  AcceptanceGateKind,
  AcceptanceGateResult,
  CommandGate,
  FileAssertion,
  FileGate,
  GateBase,
  GateResultDetails,
  HttpGate,
  LintGate,
  ManualGate,
  TestGate,
} from './acceptance-gate.js';
export type {
  AcceptanceArrayInput,
  AcceptanceGateResultInput,
  AcceptanceGateSchemaInput,
  AcceptanceItemInput,
  FileAssertionInput,
  GateResultDetailsInput,
} from './acceptance-gate-schema.js';
// === Acceptance Gate Zod Schemas (runtime validation) ===
export {
  acceptanceArraySchema,
  acceptanceGateResultSchema,
  acceptanceGateSchema,
  acceptanceItemSchema,
  commandGateSchema,
  fileAssertionSchema,
  fileGateSchema,
  gateBaseSchema,
  gateResultDetailsSchema,
  httpGateSchema,
  lintGateSchema,
  manualGateSchema,
  testGateSchema,
} from './acceptance-gate-schema.js';
// === Provider Adapter Contracts ===
export type { AdapterHealthStatus, CLEOProviderAdapter } from './adapter.js';
// === Agent Registry (credential management) ===
export type {
  AgentCredential,
  AgentListFilter,
  AgentRegistryAPI,
  AgentWithProjectOverride,
  ProjectAgentRef,
  TransportConfig,
} from './agent-registry.js';
// === Agent Registry v3 (T889 / T897 — tier-aware resolution extensions) ===
export type {
  AgentDoctorCode,
  AgentDoctorFinding,
  AgentRegistryExtendedFields,
  AgentSkillSource,
  AgentSpawnCapability,
  AgentTier,
  DoctorReport,
  ResolvedAgent,
} from './agent-registry-v3.js';
// === Archive Types ===
export type {
  ArchiveCycleTimesReport,
  ArchiveDailyTrend,
  ArchivedTask,
  ArchiveLabelEntry,
  ArchiveMetadata,
  ArchiveMonthlyTrend,
  ArchivePhaseEntry,
  ArchivePriorityEntry,
  ArchiveReportType,
  ArchiveStatsEnvelope,
  ArchiveSummaryReport,
  ArchiveTrendsReport,
  CycleTimeDistribution,
  CycleTimePercentiles,
} from './archive.js';
// === Attachment Types ===
export type {
  Attachment,
  AttachmentKind,
  AttachmentMetadata,
  AttachmentRef,
  BlobAttachment,
  LlmsTxtAttachment,
  LlmtxtDocAttachment,
  LocalFileAttachment,
  UrlAttachment,
} from './attachment.js';
// === Attachment Zod Schemas (runtime validation) ===
export type {
  AttachmentMetadataSchemaInput,
  AttachmentRefSchemaInput,
  AttachmentSchemaInput,
} from './attachment-schema.js';
export {
  attachmentMetadataSchema,
  attachmentRefSchema,
  attachmentSchema,
  blobAttachmentSchema,
  llmsTxtAttachmentSchema,
  llmtxtDocAttachmentSchema,
  localFileAttachmentSchema,
  urlAttachmentSchema,
} from './attachment-schema.js';
// === Audit Lineage Reconstruction Types (T1322) ===
export type {
  CommitEntry,
  ReconstructResult,
  ReleaseTagEntry,
} from './audit.js';
// === Backup Manifest Types ===
export type {
  BackupDatabaseEntry,
  BackupGlobalFileEntry,
  BackupIntegrity,
  BackupJsonEntry,
  BackupManifest,
  BackupMetadata,
  BackupScope,
} from './backup-manifest.js';
// === Backup Verify Types (T10319 — per-DB freshness + integrity walker) ===
export type {
  BackupVerifyDbReport,
  BackupVerifyResult,
  BackupVerifySnapshot,
  BackupVerifySummary,
  BackupVerifyVerdict,
} from './backup-verify.js';
// === Boundary Registry (SSoT for Rust/TS layering — ADR-078, Saga T10176) ===
export type {
  BoundaryEntry,
  CanonicalHome,
  ChannelBoundaryEntry,
  ChannelTrustPosture,
  PerfBudget,
  SafetyBudget,
  ThroughputThreshold,
  WorkloadIntent,
} from './boundary.js';
export { BOUNDARY_REGISTRY, CHANNEL_BOUNDARY_REGISTRY } from './boundary.js';
// === Brain/Memory Types ===
export type {
  BackupRecoverBrainResult,
  BrainCognitiveType,
  BrainEntryRef,
  BrainEntrySummary,
  BrainMemoryTier,
  BrainRecoveredRowCounts,
  BrainRecoveryResult,
  BrainSourceConfidence,
  ContradictionDetail,
  SupersededEntry,
} from './brain.js';
// === Brain Unified-Graph Types (canonical — T989 unification) ===
export type {
  BrainConnectionStatus,
  BrainEdge,
  BrainGraph,
  BrainNode,
  BrainNodeKind,
  BrainProjectContext,
  BrainQueryOptions,
  BrainStreamEvent,
  BrainSubstrate,
} from './brain-graph.js';
export type {
  AbsolutePathRules,
  AbsolutePathValidationResult,
  AgentWorktreeState,
  BoundaryContract,
  BranchLockErrorCode,
  DeniedGitOp,
  FsHardenCapabilities,
  FsHardenState,
  GitShimEnv,
  IsolationEnvKey,
  IsolationOptions,
  IsolationResult,
  OwnerOverrideAuditRecord,
  OwnerOverrideConfig,
  WorktreeCleanupResult,
  WorktreeMergeResult,
  WorktreeSpawnResult,
} from './branch-lock.js';
// === Branch-Lock + Owner-Auth Types (T1118) ===
export {
  BRANCH_LOCK_ERROR_CODES,
  ISOLATION_ENV_KEYS,
  provisionIsolatedShell,
  validateAbsolutePath,
} from './branch-lock.js';
export type { AdapterCapabilities } from './capabilities.js';
// === Changesets (CLEO-native task-anchored DSL — T9738) ===
export type { ChangesetEntry, ChangesetKind, ChangesetReleaseNoteSection } from './changesets.js';
export { CHANGESET_KINDS, ChangesetEntrySchema } from './changesets.js';
// === CLI Category Types (help renderer grouping SSoT) ===
export type { CliCategory } from './cli-category.js';
export { CLI_CATEGORY_ORDER } from './cli-category.js';
// === Code Symbol Types (tree-sitter AST) ===
export type {
  BatchParseResult,
  CodeSymbol,
  CodeSymbolKind,
  ParseResult,
} from './code-symbol.js';
// === Conduit Protocol (agent-to-agent communication) ===
export type {
  ChannelAdapter,
  ChannelConfig,
  ChannelHealth,
  ChannelHealthStatus,
  ChannelSession,
  Conduit,
  ConduitConfig,
  ConduitMessage,
  ConduitSendOptions,
  ConduitSendResult,
  ConduitState,
  ConduitStateChange,
  ConduitTopicPublishOptions,
  ConduitTopicSubscribeOptions,
  ConduitUnsubscribe,
  InboundMsg,
  OutboundReply,
} from './conduit.js';
// === Config Manifest (T9876 / Saga T9855) ===
export type {
  ConfigManifestEntry,
  ConfigManifestScope,
  ConfigScope,
  DriftDetection,
} from './config/manifest.js';
export {
  CLEO_CONFIG_MANIFEST,
  CONFIG_MANIFEST_ENTRIES,
  configManifestEntrySchema,
  GLOBAL_CLEO_CONFIG_MANIFEST,
  PROJECT_CONTEXT_MANIFEST,
  PROJECT_INFO_MANIFEST,
} from './config/manifest.js';
// === Configuration Types ===
export type {
  BackupConfig,
  BrainConfig,
  BrainEmbeddingConfig,
  BrainLlmExtractionConfig,
  BrainMemoryBridgeConfig,
  BrainSummarizationConfig,
  BrainTieringConfig,
  ClaudeProviderConfig,
  ClaudeSpawnMode,
  CleoConfig,
  ConfigSource,
  DaemonConfig,
  DateFormat,
  DecisionsConfig,
  DepsRequiredAt,
  EnforcementProfile,
  HierarchyConfig,
  LeadRollupConfig,
  LeadRollupMode,
  LifecycleConfig,
  LifecycleEnforcementMode,
  LlmConfig,
  LlmDefaultConfig,
  LlmProfileConfig,
  LlmProfileTier,
  LlmProfileTuning,
  LlmProviderEntry,
  LlmProviderTransport,
  LlmRoleConfig,
  LoggingConfig,
  LogLevel,
  MemoryBridgeMode,
  OutputConfig,
  OutputFormat,
  ProviderConfig,
  ResolvedValue,
  ResourcesConfig,
  ResourcesPsiConfig,
  RoleName,
  SessionConfig,
  SessionSummaryInput,
  SharingConfig,
  SharingMode,
  SignalDockConfig,
  SignalDockMode,
  SystemBinding,
} from './config.js';
export type { AdapterContextMonitorProvider } from './context-monitor.js';
// === Claude Code credential parsing (T9307 — pure helper, no core imports) ===
export type {
  ClaudeCodeOAuthBlock,
  ParsedClaudeCodeCredential,
} from './credentials.js';
export { parseClaudeCodeCredentials } from './credentials.js';
// === Daemon lifecycle + subsystem contracts (T11366 · SG-RUNTIME-UNIFICATION R2) ===
export type {
  DaemonLifecycleHooks,
  HealthStatus,
  Subsystem,
  SubsystemDefinition,
  SubsystemHealth,
  SubsystemLifecyclePhase,
  SubsystemState,
} from './daemon/index.js';
export {
  HealthStatusSchema,
  SUBSYSTEM_LIFECYCLE_PHASES,
  SubsystemHealthSchema,
  SubsystemStateSchema,
  summarizeHealth,
  toMonitorChildren,
} from './daemon/index.js';
// === Daemon-IPC v1.0 (AC8 alias of supervisor-ipc — T11369 · R2 gates R4-R7) ===
// `daemon-ipc` is the AC8-named re-export barrel over the FROZEN supervisor-ipc
// v1.0 contract — one contract, two names. The subpath
// `@cleocode/contracts/daemon-ipc` resolves via the package `./*` export.
export { DAEMON_IPC_PROTOCOL_VERSION } from './daemon-ipc/index.js';
// === DataAccessor Interface ===
export type {
  AcBindingRow,
  AcProjectionAuditFinding,
  AcProjectionAuditFindingCode,
  AcProjectionAuditResult,
  AcProjectionAuditStatus,
  AcRow,
  ArchiveFields,
  ArchiveFile,
  DataAccessor,
  DataAccessorAgentInstance,
  QueryTasksResult,
  TaskAuditLogQuery,
  TaskAuditLogRow,
  TaskFieldUpdates,
  TaskQueryFilters,
  TransactionAccessor,
} from './data-accessor.js';
// === Database Inventory (Saga T10281 / Epic T10282 / Task T10305 — SG-BRAIN-DB-RESILIENCE) ===
export type {
  DbConcurrency,
  DbInventoryEntry,
  DbPrivacy,
  DbRole,
  DbTier,
} from './db-inventory.js';
export { DB_INVENTORY } from './db-inventory.js';
// === DB Recovery (T10318 — Saga T10281 / Epic T10284 — generic across DB_INVENTORY) ===
export type {
  BackupRecoverResult,
  DbRecoveredRowCounts,
  DbRecoveryResult,
  DoctorRepairResult,
  DoctorRepairRoleResult,
} from './db-recovery.js';
// === Dependency Registry Contracts ===
export type {
  DependencyCategory,
  DependencyCheckResult,
  DependencyReport,
  DependencySpec,
} from './dependency.js';
export type { AdapterManifest, DetectionPattern } from './discovery.js';
// === Dispatch Identity Contracts (T9954 — Phase 0b of SG-ARCH-SOLID / E-CONTRACTS-FOUNDATION) ===
export type { CanonicalDomain, Gateway, Tier } from './dispatch/identity.js';
export { CANONICAL_DOMAINS } from './dispatch/identity.js';
// === Dispatch OperationDef + Resolution (T9954 — Phase 0b of SG-ARCH-SOLID / E-CONTRACTS-FOUNDATION) ===
export type { OperationDef, Resolution } from './dispatch/operation-def.js';
// === Dispatch OPERATIONS data + builder helpers (T10061 — T9833b / E-CLI-BOUNDARY / SG-ARCH-SOLID) ===
export { defineDomain, defineOp, OPERATIONS } from './dispatch/operations-registry.js';
// === Docs Provenance Graph (T10166 / Saga T9855 / E12) ===
export type {
  DocLifecycleStatus,
  DocProvenanceResponse,
  ProvenanceDecisionNode,
  ProvenanceDocNode,
  ProvenanceEdge,
  ProvenanceEdgeRelation,
  ProvenanceMemoryNode,
  ProvenanceNode,
  ProvenanceNodeKind,
  ProvenanceSessionNode,
  ProvenanceTaskNode,
} from './docs/provenance.js';
export {
  DOC_LIFECYCLE_STATUSES,
  docLifecycleStatusSchema,
  docProvenanceResponseSchema,
  isDocProvenanceResponse,
  isProvenanceDecisionNode,
  isProvenanceDocNode,
  isProvenanceMemoryNode,
  isProvenanceSessionNode,
  isProvenanceTaskNode,
  PROVENANCE_EDGE_RELATIONS,
  PROVENANCE_NODE_KINDS,
  provenanceDecisionNodeSchema,
  provenanceDocNodeSchema,
  provenanceEdgeRelationSchema,
  provenanceEdgeSchema,
  provenanceMemoryNodeSchema,
  provenanceNodeKindSchema,
  provenanceNodeSchema,
  provenanceSessionNodeSchema,
  provenanceTaskNodeSchema,
} from './docs/provenance.js';
// === docs.read core-SDK Contract (T11825) ===
export type { DocBody, DocFrontmatter, DocReadResponse } from './docs/read.js';
export {
  docBodySchema,
  docFrontmatterSchema,
  docReadResponseSchema,
  isDocReadResponse,
} from './docs/read.js';
// === DocsAccessor Contracts (T9063) ===
export type {
  DocExportFormat,
  DocKind,
  DocRecord,
  DocSearchHit,
  DocsAccessor,
  ListDocsFilters,
  StoreDocParams,
  StoreDocResult,
} from './docs-accessor.js';
// === Canonical Doc-Kind Taxonomy Registry (T9788) ===
export type {
  BuiltinDocKind,
  DocKindConfigFile,
  DocKindExtensionConfig,
  DocKindMetadata,
  SlugValidationResult,
} from './docs-taxonomy.js';
export {
  BUILTIN_DOC_KIND_VALUES,
  BUILTIN_DOC_KINDS,
  DocKindConfigError,
  DocKindRegistry,
} from './docs-taxonomy.js';
// === Doctor: Worktree-Orphan Audit + Prune Types (T9790, T9808, T9962) ===
// === Doctor: Saga Hierarchy Audit (T10119 — ADR-073 §1.2) ===
// === Doctor: DB-Substrate Survey (T10307 — Saga T10281 / Epic T10282) ===
// === Doctor: Legacy-Backup Walker (T10309 — Saga T10281 / Epic T10282) ===
// === Doctor: Cross-DB Invariants (T10323 — Saga T10281 / Epic T10285) ===
// === Doctor: Invariant Registry Audit (T10340 — Saga T10326 / Epic T10327) ===
export type {
  ComprehensiveAuditResult,
  DbCrossDbInvariantId,
  DbCrossDbOrphanReport,
  DbSubstrateAuditResult,
  DbSubstrateEntry,
  DbSubstrateMigrationCoverage,
  DbSubstrateMigrationMissing,
  DbSubstrateMigrationOrphan,
  DbSubstrateProjectSurvey,
  DbSubstrateSummary,
  DbSubstrateSurveyOptions,
  DbSubstrateWarning,
  DbSubstrateWarningKind,
  InvariantAuditEntry,
  InvariantAuditResult,
  InvariantAuditStatus,
  InvariantAuditViolation,
  LegacyBackupEntry,
  LegacyBackupOriginHint,
  LegacyBackupRecommendation,
  LegacyBackupScanResult,
  OrphanEntry,
  OrphanScanResult,
  PragmaDriftItem,
  PruneAuditEntry,
  PruneResult,
  SagaAuditEntry,
  SagaAuditResult,
  SagaAuditViolation,
  SagaAuditViolationKind,
  WorktreeAnomaly,
  WorktreeAnomalyKind,
} from './doctor.js';
export type {
  EngineErrorPayload,
  EngineFailure,
  EngineResult,
  EngineSuccess,
  ProblemDetails,
} from './engine-result.js';
// === EngineResult — canonical discriminated-union SDK type (T1685) ===
export {
  EngineResultError,
  engineError,
  engineSuccess,
  unwrap,
} from './engine-result.js';
// === Task-Axis Enum Constants (T9955 — promoted from core/store/tasks-schema.ts) ===
export {
  ARCHIVE_REASONS,
  TASK_KINDS,
  TASK_RELATION_TYPES,
  TASK_SCOPES,
  TASK_SEVERITIES,
  TASK_SIZES,
} from './enums.js';
export type { ChangesetYamlInvalidDetails, SagaInvariantErrorCode } from './errors.js';
// === Error Utilities ===
export {
  ChangesetYamlInvalidError,
  ClassifierUnregisteredAgentError,
  createErrorResult,
  createSuccessResult,
  DecisionValidatorFailedError,
  E_SAGA_INVARIANT_VIOLATION_I3,
  E_SAGA_INVARIANT_VIOLATION_I5,
  E_SAGA_INVARIANT_VIOLATION_I7,
  formatError,
  getErrorMessage,
  isErrorResult,
  isErrorType,
  LeadBypassDetectedError,
  LifecycleScopeDeniedError,
  normalizeError,
  ThinAgentViolationError,
} from './errors.js';
// === ADR-051 Evidence Atom Grammar (T10337 — Saga T10326) ===
export type {
  EvidenceAtom as EvidenceAtomInput,
  EvidenceAtomKind,
  EvidenceValidationFailure,
  EvidenceValidationResult,
  GateEvidenceRequirement,
} from './evidence-atom-schema.js';
export {
  AC_ALIAS_REGEX,
  AC_UUID_REGEX,
  callsiteCoverageAtomSchema,
  commitAtomSchema,
  decisionAtomSchema,
  EvidenceAtomSchema,
  EvidenceParseError,
  filesAtomSchema,
  formatGateRequirement,
  formatGateRequirementHint,
  GATE_EVIDENCE_REQUIREMENTS,
  locDropAtomSchema,
  noteAtomSchema,
  parseEvidenceString,
  prAtomSchema,
  SATISFIES_TASK_ID_REGEX,
  SATISFIES_VERSION_PIN_REGEX,
  satisfiesAtomSchema,
  testRunAtomSchema,
  toolAtomSchema,
  urlAtomSchema,
  validateEvidenceForGate,
} from './evidence-atom-schema.js';
// === Evidence Record Types (IVTR typed proof artifacts) ===
export type {
  CommandOutputRecord,
  EvidenceRecord,
  EvidenceRecordKind,
  ImplDiffRecord,
  LintReportRecord,
  TestOutputRecord,
  ValidateSpecCheckRecord,
} from './evidence-record.js';
export type {
  CommandOutputRecordInput,
  EvidenceRecordInput,
  ImplDiffRecordInput,
  LintReportRecordInput,
  TestOutputRecordInput,
  ValidateSpecCheckRecordInput,
} from './evidence-record-schema.js';
// === Evidence Record Zod Schemas (runtime validation) ===
export {
  commandOutputRecordSchema,
  evidenceRecordSchema,
  implDiffRecordSchema,
  lintReportRecordSchema,
  testOutputRecordSchema,
  validateSpecCheckRecordSchema,
} from './evidence-record-schema.js';
// === Exit Codes ===
export {
  // T10509 / Saga T10377 — AC-coverage gate at cleo complete (IVTR closure)
  E_AC_COVERAGE_INCOMPLETE,
  // T10105 / Saga T10099 — fail-loud changeset parse
  E_CHANGESET_YAML_INVALID,
  // SPEC-T9345 release pipeline v2 error code names (T9525)
  E_CHANNEL_MISMATCH,
  // T11022 / Saga T10295 — CWD-walk-up forbidden under CLEO_PATHS_STRICT=1
  E_CWD_WALKUP_FORBIDDEN,
  E_DIRTY_TREE,
  E_EPIC_EMPTY,
  E_EPIC_EMPTY_LEAF_NO_EVIDENCE,
  E_EPIC_NOT_FOUND,
  E_EVIDENCE_INSUFFICIENT,
  // SPEC-T9345 release pipeline v2 error code names (T9530)
  E_GH_NOT_AUTHENTICATED,
  // T10341 — typed CLI-layer validation for --severity + --pipeline-stage
  E_INVALID_PIPELINE_STAGE,
  E_INVALID_SEVERITY_VALUE,
  E_INVALID_STATE,
  E_PLAN_NOT_FOUND,
  E_RELEASE_PLAN_INVALID,
  E_WORKFLOW_NOT_FOUND,
  // gh#391 — application-level SQLITE_BUSY retry exhaustion (T9839)
  E_WRITE_CONTENTION,
  ExitCode,
  getExitCodeName,
  isErrorCode,
  isNoChangeCode,
  isRecoverableCode,
  isSuccessCode,
} from './exit-codes.js';
export type {
  AdminAPI,
  AgentCapacity,
  AgentHealthStatus,
  AgentInstanceRow,
  AgentInstanceStatus,
  AgentsAPI,
  AgentType,
  BlastRadius,
  BlastRadiusSeverity,
  BrainObservationType,
  CleoInitOptions,
  DuplicateStrategy,
  HybridSearchOptions,
  ImpactedTask,
  ImpactReport,
  ImportParams,
  IntelligenceAPI,
  LifecycleAPI,
  MemoryAPI,
  NexusAPI,
  OrchestrationAPI,
  RegisterAgentOptions,
  ReleaseAPI,
  SessionsAPI,
  StickyAPI,
  SyncAPI,
  TaskRollupPayload,
  TaskStartResult,
  TasksAPI,
} from './facade.js';
// === Facade API Interfaces ===
export {
  AGENT_INSTANCE_STATUSES,
  AGENT_TYPES,
  BRAIN_OBSERVATION_TYPES,
} from './facade.js';
// === CLEO-native Goal System (T11376 · Epic T11290 · Saga T11283) ===
export type {
  FuzzyGoal,
  GoalAdvanceResult,
  GoalContinuation,
  GoalJudge,
  GoalJudgeVerdict,
  GoalKind,
  GoalKindTag,
  GoalRecord,
  GoalStatus,
  TaskCompletionGoal,
} from './goal.js';
export {
  GOAL_STATUSES,
  GOAL_TARGET_TASK_ID_REGEX,
  GOAL_TERMINAL_STATUSES,
  isFuzzyGoal,
  isTaskCompletionGoal,
  isTerminalGoalStatus,
  isValidGoalTargetTaskId,
} from './goal.js';
// === Graph Intelligence Types (T512, T529, T1862, T9145) ===
export type {
  AmbiguousProvenance,
  CommunityNode,
  ConfidenceProvenance,
  ExtractedProvenance,
  GraphEdgeConfidenceLabel,
  GraphNode,
  GraphNodeKind,
  GraphRelation,
  GraphRelationType,
  ImpactResult,
  InferredProvenance,
  KnowledgeGraph,
  ProcessNode,
  SymbolIndex,
} from './graph.js';
export {
  confidenceFromProvenance,
  confidenceLabelFromNumeric,
  provenanceFromNumeric,
} from './graph.js';
export type { AdapterHookProvider } from './hooks.js';
export type { AdapterInstallProvider, InstallOptions, InstallResult } from './install.js';
// === Invariants Registry (Saga T10326 / Epic T10327 / Task T10335 — SG-SUBSTRATE-RECONCILIATION) ===
export type {
  InvariantDoctorAudit,
  InvariantLintRule,
  InvariantRuntimeGate,
  InvariantSeverity,
  RegisteredInvariant,
} from './invariants/index.js';
export {
  ADR_056_INVARIANTS,
  ADR_073_INVARIANTS,
  getInvariant,
  getInvariantsByAdr,
  INVARIANTS_REGISTRY,
} from './invariants/index.js';
// === Background Job Status (T9955 — promoted from core/store/tasks-schema.ts) ===
export type { BackgroundJobStatus } from './jobs.js';
export type {
  CleoResponse,
  ConformanceReport,
  FlagInput,
  GatewayEnvelope,
  GatewayError,
  GatewayMeta,
  GatewaySuccess,
  LAFSEnvelope,
  LAFSError,
  LAFSErrorCategory,
  LAFSMeta,
  LAFSPage,
  LAFSPageCursor,
  LAFSPageNone,
  LAFSPageOffset,
  LAFSTransport,
  LafsAlternative,
  LafsEnvelope,
  LafsError,
  LafsErrorDetail,
  LafsSuccess,
  MVILevel,
  Warning,
} from './lafs.js';
// === LAFS Envelope Types ===
export {
  isGatewayEnvelope,
  isLafsError,
  isLafsSuccess,
} from './lafs.js';
// === Lease-IPC v1.1 (PARALLEL DbWriterLease contract — T11627 · SG-RUNTIME-UNIFICATION) ===
export type {
  ChildKilledUnresponsiveResponse,
  LeaseAcquireRequest,
  LeaseDeniedResponse,
  LeaseErrorResponse,
  LeaseGrantedResponse,
  LeaseIpcEnvelope,
  LeaseIpcRequest,
  LeaseIpcRequestEnvelope,
  LeaseIpcResponse,
  LeaseIpcResponseEnvelope,
  LeaseLane,
  LeaseQueuedResponse,
  LeaseReleaseRequest,
  LeaseRenewRequest,
  LeaseRevokedResponse,
  LeaseScope,
  QueueAdmitDisposition,
  QueueAdmitRequest,
  QueueAdmitResultResponse,
  QueuePriorityClass,
  RateCheckRequest,
  RateResultResponse,
  ToolGrantedResponse,
  ToolGrantRequest,
} from './lease-ipc/index.js';
export {
  ChildKilledUnresponsiveResponseSchema,
  isFrozenLeaseIpcVersion,
  LEASE_IPC_MESSAGE_KINDS,
  LEASE_IPC_PROTOCOL_VERSION,
  LEASE_IPC_REQUEST_KINDS,
  LEASE_IPC_RESPONSE_KINDS,
  LeaseAcquireRequestSchema,
  LeaseDeniedResponseSchema,
  LeaseErrorResponseSchema,
  LeaseGrantedResponseSchema,
  LeaseIpcEnvelopeSchema,
  LeaseIpcRequestEnvelopeSchema,
  LeaseIpcRequestSchema,
  LeaseIpcResponseEnvelopeSchema,
  LeaseIpcResponseSchema,
  LeaseLaneSchema,
  LeaseQueuedResponseSchema,
  LeaseReleaseRequestSchema,
  LeaseRenewRequestSchema,
  LeaseRevokedResponseSchema,
  LeaseScopeSchema,
  QueueAdmitDispositionSchema,
  QueueAdmitRequestSchema,
  QueueAdmitResultResponseSchema,
  QueuePriorityClassSchema,
  RateCheckRequestSchema,
  RateResultResponseSchema,
  ToolGrantedResponseSchema,
  ToolGrantRequestSchema,
} from './lease-ipc/index.js';
export type {
  CatalogAuthType,
  CatalogModelEntry,
  CatalogModelStatus,
  CatalogProvider,
  CuratedCatalog,
  ModelsCatalogRowInsert,
  ModelsCatalogRowSelect,
} from './llm/catalog-schema.js';
// === E8 Curated Models Catalog (T11731 · offline-first catalog SSoT) ===
export {
  CATALOG_AUTH_TYPES,
  CATALOG_MODEL_STATUSES,
  catalogCostSchema,
  catalogLimitSchema,
  catalogModalitiesSchema,
  catalogModelEntrySchema,
  catalogModelProviderSchema,
  catalogProviderSchema,
  curatedCatalogSchema,
  modelsCatalogRowInsertSchema,
  modelsCatalogRowSelectSchema,
} from './llm/catalog-schema.js';
// === LLM Error Taxonomy (T9270 — Hermes FailoverReason port) ===
export type { ClassifiedError, FailoverReason } from './llm/failover-reason.js';
// === Phase 4 Unified Architecture (T9281 / ADR-072) — Session + Executor interfaces ===
export type {
  AggregatedUsage,
  ExecutionEvent,
  ExecutionRequest,
  ExecutorFactoryOptions,
  LlmExecutor,
  LlmExecutorFactory,
  LlmSession,
  LlmSessionFactory,
  NormalizedDelta,
  RetryPolicy,
  SendOptions,
  SessionFactoryOptions,
  ToolCall,
  TransportContext,
} from './llm/interfaces.js';
// === Normalized LLM Transport Types (T9263 — Phase 3 T-LLM-CRED) ===
// Note: LlmTransport (the wire-level interface from normalized-response.ts) is
// intentionally NOT re-exported at the top level here. The config-layer alias
// was renamed LlmProviderTransport (T9308) to eliminate the name collision.
// Consumers that need the transport interface should import LlmTransport from
// the llm/normalized-response.js subpath rather than the package root.
export type {
  NormalizedResponse,
  NormalizedToolCall,
  NormalizedUsage,
  TransportMessage,
  TransportRequest,
  TransportTool,
} from './llm/normalized-response.js';
// === OAuth types — SSoT shared between core and cleo (T9302) ===
export type { OAuthMode, OAuthTokens, PkceFlowConfig, ProviderOAuthConfig } from './llm/oauth.js';
// === Onboarding login engine result envelope (T11724 · M3) ===
export type {
  OnboardingAuthMode,
  OnboardingResult,
  OnboardingStepName,
  OnboardingStepResult,
  OnboardingStepStatus,
} from './llm/onboarding.js';
// === Phase 4/5 Plugin LLM facade types (T9305 / T9313) ===
export type { PluginLlmComplete, PluginLlmContext } from './llm/plugin-llm.js';
export {
  PluginDeniedError,
  PluginLlmError,
  PluginModelGateError,
  PluginRateLimitedError,
} from './llm/plugin-llm.js';
export type {
  AiSdkEndpoint,
  AnthropicMessagesEndpoint,
  OAuthFlowDef,
  OpenAICompletionsEndpoint,
  OpenAIResponsesEndpoint,
  ProviderDef,
  ProviderEndpoint,
  ProviderTransport,
  RequestQuirk,
  RequestQuirkKind,
} from './llm/provider-def.js';
// === M3 Provider SSoT (T11702 · epic T11667) — declarative ProviderDef ===
export {
  PROVIDER_TRANSPORTS,
  REQUEST_QUIRK_KINDS,
} from './llm/provider-def.js';
// === Phase 4 Unified Architecture (T9281 / ADR-072) — Provider identity ===
export type { ApiMode, BuiltinProviderId, ProviderId } from './llm/provider-id.js';
// === Provider Profile + Plugin Contracts (T9262 — Phase 3 T-LLM-CRED) ===
export type {
  ProviderPlugin,
  ProviderPluginApi,
  ProviderProfile,
} from './llm/provider-profile.js';
// === Phase 4 Unified Architecture (T9281 / ADR-072) — Resolved credential ===
export type { ResolvedCredential } from './llm/resolved-credential.js';
// === E9 SSoT resolution descriptor (T11745 / T11761) ===
export type { ModelCaps, ResolvedLLMDescriptor } from './llm/resolved-descriptor.js';
// === E10 Sealed credential handle (T11752 / T11746) — on-demand decrypt at the wire ===
export type { DecryptedToken, SealedCredential } from './llm/sealed-credential.js';
// === E9 System-of-Use taxonomy + registry (T11747 · hermes _AUX_TASKS analog) ===
export type {
  AuxSystem,
  AuxSystemId,
  CantbookNodeSystem,
  OpenSystemKind,
  OrchestrationSystem,
  RegisteredSystemOfUse,
  RoleSystem,
  SkillSystem,
  SpawnUnitSystem,
  SystemOfUse,
  SystemOfUseDefaults,
  SystemOfUseKind,
  SystemOfUsePickerEntry,
  ToolSystem,
  WhoamiRoleId,
} from './llm/system-of-use.js';
export {
  AUX_SYSTEM_IDS,
  BUILTIN_SYSTEMS_OF_USE,
  isBuiltinSystemOfUse,
  isOpenSystemKind,
  isSystemOfUse,
  OPEN_SYSTEM_KEY_PREFIXES,
  ORCHESTRATION_TIER_IDS,
  ROLE_SYSTEM_IDS,
  WHOAMI_ROLE_IDS,
} from './llm/system-of-use.js';
// === E9 System-of-Use chokepoint contract (T11749) ===
export type {
  ResolveLLMForSystemOptions,
  SystemOfUseLabel,
  SystemResolverInput,
} from './llm/system-resolver.js';
export { SYSTEM_ROLE_MAP } from './llm/system-resolver.js';
// === Logger contract (T9766 — centralized from @cleocode/core) ===
export type { LoggerConfig } from './logger.js';
// === BRAIN memory wire-shape contracts (T9956 — promoted from @cleocode/core) ===
export type {
  BudgetedEntry,
  BudgetedResult,
  BudgetedRetrievalOptions,
} from './memory/budgeted.js';
// === ContextEngine contract (canonical home — T9304) ===
export type { CompressedContext, ContextEngine } from './memory/context-engine.js';
export type {
  FetchBrainEntriesParams,
  FetchBrainEntriesResult,
  FetchedBrainEntry,
} from './memory/fetch.js';
export type {
  BrainObservationSourceType,
  DocAttachmentObservationPayload,
  ObserveBrainParams,
  ObserveBrainResult,
} from './memory/observe.js';
export { BRAIN_OBSERVATION_SOURCE_TYPES } from './memory/observe.js';
export type {
  BrainCompactHit,
  SearchBrainCompactParams,
  SearchBrainCompactResult,
} from './memory/search.js';
export type {
  BrainAnchor,
  TimelineBrainParams,
  TimelineBrainResult,
  TimelineNeighbor,
} from './memory/timeline.js';
export type {
  BridgeDecision,
  BridgeLearning,
  BridgeObservation,
  BridgePattern,
  DispatchTrace,
  // T9766 — BRAIN public-API records (centralized from @cleocode/core)
  LearningRecord,
  MemoryBridgeConfig,
  MemoryBridgeContent,
  MemoryDecisionRecord,
  MemoryGraphStats,
  MemorySearchHit,
  PatternRecord,
  SessionSummary,
} from './memory.js';
export type {
  MigrationEnumDrift,
  MigrationForeignKeyViolation,
  MigrationTableParity,
  VerifyMigrationResult,
} from './migration-parity.js';
// === Migration Parity (T11551 — DHQ-045 exodus zero-loss durable guard) ===
export { MIGRATION_ENUM_DRIFT_SAMPLE_LIMIT } from './migration-parity.js';
// === MVI progressive-disclosure primitive (T11349 · Epic T11285 · Saga T11283) ===
export type {
  ExpansionHint,
  MviDigest,
  NextDirectivesHint,
  StructuredOpsHint,
  SuggestedCommandsHint,
} from './mvi.js';
export {
  expansionFromNextDirectives,
  expansionFromStructuredOps,
  expansionFromSuggestedCommands,
  isNextDirectivesHint,
  isStructuredOpsHint,
  isSuggestedCommandsHint,
} from './mvi.js';
export type {
  Contract,
  ContractCompatibilityMatrix,
  ContractExtractionResult,
  ContractMatch,
  ContractMatchLevel,
  ContractTaskLink,
  GrpcContract,
  HttpContract,
  TopicContract,
} from './nexus-contract-ops.js';
// === Living Brain SDK Types (T1068 — 5-substrate traversal primitives) ===
// === Extended Code Reasoning Types (T1069 — reasonWhySymbol + reasonImpactOfChange) ===
export type {
  BlastRadiusSummary,
  BrainMemoryRef,
  BrainRiskNote,
  CodeAnchorResult,
  CodeReasonTrace,
  ConduitThreadRef,
  DecisionRef,
  ImpactFullReport,
  LbTaskRef,
  NexusContext,
  NexusEdgeRef,
  NexusNodeAnchor,
  PlasticityMeasure,
  ProposalRef,
  ReasonTraceStep,
  RiskTier,
  SymbolFullContext,
  SymbolImpactEntry,
  TaskCodeImpact,
  TasksForNodeEntry,
} from './nexus-living-brain-ops.js';
// === Nexus Query DSL (recursive CTE operations) ===
export type {
  NexusCteAlias,
  NexusCteMarkdownTable,
  NexusCteParams,
  NexusCtePlaceholder,
  NexusCteResult,
} from './nexus-query-ops.js';
// === Route Analysis and Contract Registry Types (T1064, T1065) ===
export type {
  RouteMapEntry,
  RouteMapResult,
  ShapeCheckCaller,
  ShapeCheckResult,
  ShapeCheckStatus,
} from './nexus-route-ops.js';
export type {
  GitLogLinkerResult,
  LinkTaskResult,
  SymbolReference,
  TaskReference,
} from './nexus-tasks-bridge-ops.js';
export type {
  CommunityWikiStats,
  GenerateNexusWikiOptions,
  NexusWikiResult,
  WikiDbHandle,
  WikiStateFile,
  WikiSymbolRow,
} from './nexus-wiki-ops.js';
// === Operation-aware LAFS envelope validation (T10610) ===
export type {
  OperationEnvelopeName,
  OperationEnvelopeValidationIssue,
  OperationEnvelopeValidationOptions,
  OperationEnvelopeValidationResult,
} from './operation-envelope-validation.js';
export {
  E_LAFS_OPERATION_ERROR_SHAPE,
  E_LAFS_OPERATION_RESULT_SCHEMA,
  E_LAFS_OPERATION_UNREGISTERED,
  OPERATION_RESULT_SCHEMAS,
  validateOperationEnvelope,
} from './operation-envelope-validation.js';
// Admin operation param/result types — re-exported at top level for typed-dispatch consumers
// (T1426 Wave D · typed-narrowing migration for admin domain)
export type {
  AdminAdrFindParams,
  AdminAdrShowParams,
  AdminAdrSyncParams,
  AdminBackupListParams,
  AdminBackupMutateParams,
  AdminCleanupParams,
  AdminConfigGetParams,
  AdminConfigGetResult,
  AdminConfigListParams,
  AdminConfigListResult,
  AdminConfigPresetsParams,
  AdminConfigScope,
  AdminConfigSetParams,
  AdminConfigSetPresetParams,
  AdminConfigShowParams,
  AdminConfigUnsetParams,
  AdminConfigUnsetResult,
  AdminConfigValidateParams,
  AdminConfigValidateResult,
  AdminContextInjectParams,
  AdminContextParams,
  AdminContextPullParams,
  AdminDashParams,
  AdminDetectParams,
  AdminExportParams,
  AdminHealthMutateParams,
  AdminHealthQueryParams,
  AdminHelpParams,
  AdminHooksMatrixParams,
  AdminImportParams,
  AdminInitParams,
  AdminInjectGenerateParams,
  AdminInstallGlobalParams,
  AdminJobCancelParams,
  AdminJobStatusParams,
  AdminLogParams,
  AdminMapMutateParams,
  AdminMapQueryParams,
  AdminMigrateParams,
  AdminOps,
  AdminPathsParams,
  AdminRoadmapParams,
  AdminRuntimeParams,
  AdminRuntimeResult,
  AdminSafestopParams,
  AdminScaffoldHubParams,
  AdminSequenceParams,
  AdminSmokeParams,
  AdminSmokeProviderParams,
  AdminStatsParams,
  AdminTokenMutateParams,
  AdminTokenQueryParams,
  AdminVersionParams,
} from './operations/admin.js';
// === Conduit Operation Types (T1422 — typed-dispatch migration) ===
// Re-exported at top level so CLI dispatch can import without the `ops.` namespace hop.
// Note: The transport-layer ConduitSendResult (in ./conduit.ts) carries { messageId, deliveredAt }
// and is the canonical type for the Conduit interface (ConduitClient / publishToTopic).
// ConduitSendOperationResult (below) is the wire-format type for the conduit.send CLI/HTTP
// dispatch operation and carries { messageId, from, to, transport, sentAt }.
// The two types serve different layers and are intentionally distinct.
export type {
  ConduitInboxMessage,
  ConduitListenParams,
  ConduitListenResult,
  ConduitOps,
  ConduitPeekParams,
  ConduitPeekResult,
  ConduitPublishParams,
  ConduitPublishResult,
  ConduitSendOperationResult,
  ConduitSendParams,
  ConduitStartParams,
  ConduitStartResult,
  ConduitStatusParams,
  ConduitStatusResult,
  ConduitStopParams,
  ConduitStopResult,
  ConduitSubscribeParams,
  ConduitSubscribeResult,
  ConduitTransportKind,
} from './operations/conduit.js';
// Dialectic Evaluator operation types (T1087 Wave 3)
export type {
  ApplyInsightsParams,
  ApplyInsightsResult,
  DialecticInsights,
  DialecticTurn,
  EvaluateDialecticParams,
  EvaluateDialecticResult,
} from './operations/dialectic.js';
// === Docs Operation Types (T10618 — docs.update lifecycle status SSoT) ===
// Re-exported at top level so core and CLI layers can consume the same
// operation contract without relying on an unexported package subpath.
export {
  DOCS_LIFECYCLE_STATUSES,
  type DocsLifecycleStatus,
  type DocsUpdateParams,
} from './operations/docs.js';
// === Ensures-schema Zod registry (T11762 ST-1 / T11900 — cantbook ensures.schema SSoT) ===
// Named Zod validators for cantbook `ensures.schema` shapes (task_tree, evidence)
// + the registry DATA. Bodied accessors live in @cleocode/core (ST-1b) to keep
// contracts Gate-10-pure. The runtime resolves a schema name → validator here
// instead of hardcoding `if (schema === 'task_tree') … else if (=== 'evidence')`.
export type { EnsuresSchemaSpec } from './operations/ensures-schema-registry.js';
export {
  ENSURES_SCHEMA_REGISTRY,
  evidenceSchema,
  LEGACY_PASSTHROUGH_SCHEMA_NAMES,
  passthroughSchema,
  taskTreeEntrySchema,
  taskTreeSchema,
} from './operations/ensures-schema-registry.js';
// 5-entity provider-experience op contracts (T11700 · epic T11666) — INPUT
// contracts consumed by core's INPUT_CONTRACTS registry; OUTPUT contracts already
// register into OUTPUT_CONTRACTS above.
export {
  accountAddInputContract,
  accountAddOutputContract,
  accountListInputContract,
  accountListOutputContract,
  accountRemoveInputContract,
  accountRemoveOutputContract,
  modelQueryInputContract,
  modelQueryOutputContract,
  modelShowInputContract,
  modelShowOutputContract,
  profileCreateInputContract,
  profileCreateOutputContract,
  profileListInputContract,
  profileListOutputContract,
  profilePinInputContract,
  profilePinOutputContract,
  profileUseInputContract,
  profileUseOutputContract,
  providerConnectInputContract,
  providerConnectOutputContract,
  providerListInputContract,
  providerListOutputContract,
  providerShowInputContract,
  providerShowOutputContract,
} from './operations/entities.js';
// === Operations Types (API wire format, namespaced to avoid collision with domain types) ===
export * as ops from './operations/index.js';
// === Operation Input Contracts (T9914 / Saga T9855 / E7) ===
// Re-exported at top level so SDK consumers (validator T9915, mutate DX
// surface, generated docs) can import without the `ops.` namespace hop.
export type {
  JsonSchema,
  OperationInputContract,
  OperationInputContractRegistry,
  OperationInputExample,
  ValidationError,
  ValidationResult,
} from './operations/input-contract.js';
// === Lifecycle Operation Types (T1455 — ADR-057 D1 Core normalization) ===
// Re-exported at top level so @cleocode/core/lifecycle can import without the `ops.` namespace hop.
// Note: Gate is included here — GateStatus conflict resolved (T1694): lifecycle.ts now re-exports
// the canonical GateStatus from status-registry.ts (single source of truth, ADR-018).
export type {
  Gate,
  LifecycleCheckParams,
  LifecycleCheckResult,
  LifecycleGateFailParams,
  LifecycleGateFailResult,
  LifecycleGatePassParams,
  LifecycleGatePassResult,
  LifecycleGatesParams,
  LifecycleGatesResult,
  LifecycleHistoryEntry,
  LifecycleHistoryParams,
  LifecycleHistoryResult,
  LifecyclePrerequisitesParams,
  LifecyclePrerequisitesResult,
  LifecycleProgressParams,
  LifecycleProgressResult,
  LifecycleResetParams,
  LifecycleResetResult,
  LifecycleSkipParams,
  LifecycleSkipResult,
  LifecycleStage,
  LifecycleStatusParams,
  LifecycleStatusResult,
  StageRecord,
} from './operations/lifecycle.js';
// === LLM Credential + Role-Resolver Wire Types (T-LLM-CRED Phase 1/2 — T9255) ===
export type {
  AuthTypeWire,
  CredentialMetadataWire,
  CredentialResultWire,
  CredentialSourceWire,
  CredentialsStoreStrategyWire,
  // `cleo llm` CLI / dispatch operation contracts (T9258)
  LlmAddParams,
  LlmAddResult,
  LlmAuxiliaryChainEntry,
  LlmAuxiliaryStatusParams,
  LlmAuxiliaryStatusResult,
  LlmListParams,
  LlmListResult,
  LlmProfileParams,
  LlmProfileResult,
  LlmProviderSourceWire,
  LlmProviderStatusEntry,
  LlmRemoveParams,
  LlmRemoveResult,
  LlmStatusResult,
  LlmStoredCredentialView,
  LlmSystemsOfUseParams,
  LlmSystemsOfUseResult,
  LlmTestParams,
  LlmTestResult,
  LlmUseParams,
  LlmUseResult,
  LlmWhoamiEntry,
  LlmWhoamiParams,
  LlmWhoamiResult,
  ModelTransport,
  ResolutionSource,
  ResolvedLLM,
  ResolveLLMForRoleOptions,
  StoredAuthTypeWire,
} from './operations/llm.js';
// Multi-pass retrieval bundle types (PSYCHE Wave 4 · T1090)
export type {
  PassMask,
  RetrievalActiveTask,
  RetrievalBundle,
  RetrievalDecision,
  RetrievalLearning,
  RetrievalObservation,
  RetrievalPattern,
  RetrievalRequest,
  RetrievalTokenCounts,
  SigilCard,
} from './operations/memory.js';
// === NEXUS Operation Types (T1424 — typed-dispatch migration, Wave D) ===
// Re-exported at top level so CLI dispatch can import without the `ops.` namespace hop.
export type {
  BrainPageNodeEntry,
  NexusAugmentParams,
  NexusAugmentResult,
  NexusAugmentSymbol,
  NexusBlockersShowParams,
  NexusBlockersShowResult,
  NexusBrainAnchorsParams,
  NexusBrainAnchorsResult,
  // T1510 — Phase 2
  NexusClustersParams,
  NexusClustersResult,
  NexusColdSymbol,
  NexusColdSymbolsParams,
  NexusColdSymbolsResult,
  NexusCommunityEntry,
  NexusConduitScanParams,
  NexusConduitScanResult,
  NexusContextNode,
  NexusContextParams,
  NexusContextProcess,
  NexusContextRelation,
  NexusContextResult,
  NexusContextSourceContent,
  NexusContractsLinkTasksParams,
  NexusContractsLinkTasksResult,
  NexusContractsShowParams,
  NexusContractsShowResult,
  NexusContractsSyncParams,
  NexusContractsSyncResult,
  NexusDepsEntry,
  NexusDepsParams,
  NexusDepsResult,
  NexusDiffHealth,
  NexusDiffParams,
  NexusDiffResult,
  NexusDiscoverHit,
  NexusDiscoverParams,
  NexusDiscoverResult,
  NexusFlowEntry,
  NexusFlowsParams,
  NexusFlowsResult,
  NexusFullContextParams,
  NexusFullContextResult,
  NexusGraphEdge,
  NexusGraphNode,
  NexusGraphParams,
  NexusGraphResult,
  NexusHealthStatus,
  NexusHotNode,
  NexusHotNodesParams,
  NexusHotNodesResult,
  NexusHotPath,
  NexusHotPathsParams,
  NexusHotPathsResult,
  NexusImpactAffectedNode,
  NexusImpactFullParams,
  NexusImpactFullResult,
  NexusImpactParams,
  NexusImpactResult,
  NexusInitParams,
  NexusInitResult,
  NexusListParams,
  NexusListResult,
  NexusOps,
  NexusOrphanEntry,
  NexusOrphansListParams,
  NexusOrphansListResult,
  NexusPathShowParams,
  NexusPathShowResult,
  NexusPermissionLevel,
  NexusPermissionSetParams,
  NexusPermissionSetResult,
  NexusProjectRecord,
  NexusProjectStats,
  NexusProjectsCleanParams,
  NexusProjectsCleanResult,
  NexusProjectsListParams,
  NexusProjectsListResult,
  NexusProjectsRegisterParams,
  NexusProjectsRegisterResult,
  NexusProjectsRemoveParams,
  NexusProjectsRemoveResult,
  NexusProjectsScanParams,
  NexusProjectsScanResult,
  NexusQueryCteParams,
  NexusQueryCteResult,
  NexusReconcileParams,
  NexusReconcileResult,
  NexusRefreshBridgeParams,
  NexusRefreshBridgeResult,
  NexusRegisterParams,
  NexusRegisterResult,
  NexusResolveParams,
  NexusResolveResult,
  NexusRouteMapParams,
  NexusRouteMapResult,
  NexusScanAutoRegisterError,
  NexusSearchCodeParams,
  NexusSearchCodeResult,
  NexusSearchHit,
  NexusSearchParams,
  NexusSearchResult,
  NexusShapeCheckParams,
  NexusShapeCheckResult,
  NexusShareSnapshotExportParams,
  NexusShareSnapshotExportResult,
  NexusShareSnapshotImportParams,
  NexusShareSnapshotImportResult,
  NexusShareStatusParams,
  NexusShareStatusResult,
  NexusSharingStatus,
  NexusShowParams,
  NexusShowResult,
  NexusSigilListParams,
  NexusSigilListResult,
  NexusSigilSyncParams,
  NexusSigilSyncResult,
  NexusStatusParams,
  NexusStatusResult,
  NexusSyncParams,
  NexusSyncResult,
  NexusTaskFootprintParams,
  NexusTaskFootprintResult,
  NexusTaskRef,
  NexusTaskSymbolsParams,
  NexusTaskSymbolsResult,
  NexusTopEntriesParams,
  NexusTopEntriesResult,
  NexusTopEntry,
  NexusTransferManifest,
  NexusTransferManifestEntry,
  NexusTransferMode,
  NexusTransferOnConflict,
  NexusTransferOnMissingDep,
  NexusTransferParams,
  NexusTransferPreviewParams,
  NexusTransferPreviewResult,
  NexusTransferResult,
  NexusTransferScope,
  NexusUnregisterParams,
  NexusUnregisterResult,
  NexusWhyParams,
  NexusWhyResult,
  NexusWikiParams,
} from './operations/nexus.js';
// === Nexus Scope Contracts (T9145 + T9146) ===
export type {
  MetaWithNexusScope,
  NexusBindingSource,
  NexusEffect,
  NexusOperationDescriptor,
  NexusScope,
  NexusScopeMeta,
  NexusStore,
  ScopeBinding,
  SuggestedNextOp,
} from './operations/nexus-scope.js';
export {
  getNexusDescriptor,
  listOpsByScope,
  NEXUS_SCOPE_MAP,
} from './operations/nexus-scope-map.js';
// === NEXUS User Profile Types (T1076 PSYCHE Wave 1) ===
// Re-exported at top level so @cleocode/core/nexus and CLI dispatch can
// import without the `ops.` namespace hop.
export type {
  NexusProfileExportParams,
  NexusProfileExportResult,
  NexusProfileGetParams,
  NexusProfileGetResult,
  NexusProfileImportParams,
  NexusProfileImportResult,
  NexusProfileReinforceParams,
  NexusProfileReinforceResult,
  NexusProfileSupersedeParams,
  NexusProfileSupersedeResult,
  NexusProfileUpsertParams,
  NexusProfileUpsertResult,
  NexusProfileViewParams,
  NexusProfileViewResult,
  UserProfileTrait,
} from './operations/nexus-user-profile.js';
// Commonly used ops types re-exported at top level for convenience
export type {
  BrainState,
  OrchestrateReportEntry,
  OrchestrateReportGroup,
  OrchestrateReportParams,
} from './operations/orchestrate.js';
// === Operation Output Contracts (T11692 / DHQ-057 — per-op result shape SSoT) ===
// OUTPUT-side mirror of the input contracts. Surfaces the LAFS envelope `data`
// shape + valid --field JSON pointers so agents stop guessing (e.g. the real
// pointer is /data/task/title, not /data/title).
export type {
  OperationOutputContract,
  OperationOutputContractRegistry,
} from './operations/output-contract.js';
export { OUTPUT_CONTRACTS } from './operations/output-contracts-data.js';
// ParamDef contract — re-exported at top level (SSoT for all operation param descriptors)
export type {
  CittyArgDef,
  OperationParams,
  ParamCliDef,
  ParamDef,
  ParamType,
} from './operations/params.js';
export { paramsToCittyArgs } from './operations/params.js';
// === Sentient Operation Types (T1421 — typed-dispatch migration, Wave D) ===
// Re-exported at top level so CLI dispatch can import without the `ops.` namespace hop.
export type {
  AllowlistAddParams,
  AllowlistAddResult,
  AllowlistListParams,
  AllowlistListResult,
  AllowlistRemoveParams,
  AllowlistRemoveResult,
  Proposal,
  ProposeAcceptParams,
  ProposeAcceptResult,
  ProposeDiffParams,
  ProposeDiffResult,
  ProposeDisableParams,
  ProposeDisableResult,
  ProposeEnableParams,
  ProposeEnableResult,
  ProposeListParams,
  ProposeListResult,
  ProposeRejectParams,
  ProposeRejectResult,
  ProposeRunParams,
  ProposeRunResult,
  SentientOps,
} from './operations/sentient.js';
// Service-vault CLI op contracts (T11941 · epic T11765 · M2-W4) — INPUT contracts
// consumed by core's INPUT_CONTRACTS registry; OUTPUT contracts already register
// into OUTPUT_CONTRACTS above.
export {
  serviceConnectInputContract,
  serviceConnectOutputContract,
  serviceListInputContract,
  serviceListOutputContract,
  serviceRevokeInputContract,
  serviceRevokeOutputContract,
  serviceStatusInputContract,
  serviceStatusOutputContract,
} from './operations/service.js';
// Session operation param/result types — re-exported at top level for typed-dispatch consumers
// (T975 Wave D · ADR-051 migration)
export type {
  BriefingExcludeProvenance,
  BriefingFieldContract,
  BriefingFieldRule,
  ContractViolation,
  DecisionRecord,
  SessionBriefingShowParams,
  SessionBriefingShowResult,
  SessionContextDriftParams,
  SessionContextDriftResult,
  SessionDecisionLogParams,
  SessionDecisionLogResult,
  SessionEndParams,
  SessionEndResult,
  SessionFindParams,
  SessionFindResult,
  SessionGcParams,
  SessionGcResult,
  SessionHandoffShowParams,
  SessionHandoffShowResult,
  SessionLintParams,
  SessionLintResult,
  SessionLintViolation,
  SessionListParams,
  SessionListResult,
  SessionOps,
  SessionRecordAssumptionParams,
  SessionRecordAssumptionResult,
  SessionRecordDecisionParams,
  SessionRecordDecisionResult,
  SessionResumeParams,
  SessionResumeResult,
  SessionShowParams,
  SessionShowResult,
  SessionStartParams,
  SessionStatusParams,
  SessionStatusResult,
  SessionSuspendParams,
  SessionSuspendResult,
} from './operations/session.js';
// === Task Operation Types (T1425 — typed-dispatch migration) ===
export type {
  DepGraphIssue,
  DepsTreeEdge,
  DepsTreeNode,
  TaskShowAcRowEntry,
  TaskShowAttachmentEntry,
  TaskShowRelationsEntry,
  TasksAddBatchEntry,
  TasksAddBatchParams,
  TasksAddBatchResult,
  TasksAddParams,
  TasksAddResult,
  TasksAnalyzeQueryParams,
  TasksAnalyzeQueryResult,
  TasksArchiveQueryParams,
  TasksArchiveQueryResult,
  TasksBlockersQueryParams,
  TasksBlockersQueryResult,
  TasksCancelParams,
  TasksCancelResult,
  TasksClaimParams,
  TasksClaimResult,
  TasksCompleteQueryParams,
  TasksCompleteQueryResult,
  TasksComplexityEstimateParams,
  TasksComplexityEstimateResult,
  // T10629 — task context pack types
  TasksContextAcceptanceEntry,
  TasksContextActivityEvent,
  TasksContextBlockerEntry,
  TasksContextBudget,
  TasksContextDocEntry,
  TasksContextOmission,
  TasksContextParams,
  TasksContextResult,
  TasksCurrentParams,
  TasksCurrentResult,
  TasksDeleteQueryParams,
  TasksDeleteQueryResult,
  TasksDependsParams,
  TasksDependsResult,
  // T1857 — dep-graph validation + tree rendering (T1855 guardrails)
  TasksDepsTreeParams,
  TasksDepsTreeResult,
  TasksDepsValidateParams,
  TasksDepsValidateResult,
  TasksFindParams,
  TasksFindResult,
  TasksHistoryParams,
  TasksHistoryResult,
  TasksImpactParams,
  TasksImpactResult,
  TasksLabelListParams,
  TasksLabelListResult,
  TasksListParams,
  TasksListResult,
  TasksNextQueryParams,
  TasksNextQueryResult,
  TasksOps,
  TasksPlanParams,
  TasksPlanResult,
  TasksRelatesAddBatchEntry,
  TasksRelatesAddBatchParams,
  TasksRelatesAddBatchResult,
  TasksRelatesAddParams,
  TasksRelatesAddResult,
  TasksRelatesParams,
  TasksRelatesRemoveParams,
  TasksRelatesRemoveResult,
  TasksRelatesResult,
  TasksReorderDispatchResult,
  TasksReorderQueryParams,
  TasksReparentDispatchResult,
  TasksReparentQueryParams,
  TasksRestoreParams,
  TasksRestoreResult,
  TasksSagaAddParams,
  TasksSagaAddResult,
  TasksSagaCreateParams,
  TasksSagaCreateResult,
  TasksSagaDetachParams,
  TasksSagaDetachResult,
  TasksSagaListParams,
  TasksSagaListResult,
  TasksSagaMembersParams,
  TasksSagaMembersResult,
  TasksSagaRollupParams,
  TasksSagaRollupResult,
  TasksScopeMember,
  TasksScopeReadyEntry,
  TasksScopeRollup,
  TasksShowParams,
  TasksShowResult,
  TasksSliceNode,
  TasksSliceParams,
  TasksSliceResult,
  TasksStartQueryParams,
  TasksStartQueryResult,
  TasksStopQueryParams,
  TasksStopQueryResult,
  TasksSyncLinksParams,
  TasksSyncLinksRemoveParams,
  TasksSyncLinksRemoveResult,
  TasksSyncLinksResult,
  TasksSyncReconcileParams,
  TasksSyncReconcileResult,
  TasksTreeDispatchParams,
  TasksTreeDispatchResult,
  TasksUnclaimParams,
  TasksUnclaimResult,
  TasksUpdateQueryParams,
  TasksUpdateQueryResult,
} from './operations/tasks.js';
// === T9917 tasks.* schema-first input contracts (Saga T9855 / Epic T9903) ===
// Top-level exports so the core dispatch registry (input-contracts.ts) can
// import them without the `ops.` namespace hop.
export {
  TASKS_ADD_BATCH_INPUT_SCHEMA,
  TASKS_ADD_INPUT_SCHEMA,
  TASKS_UPDATE_INPUT_SCHEMA,
  tasksAddBatchInputContract,
  tasksAddInputContract,
  tasksUpdateInputContract,
} from './operations/tasks.js';
// === Validate / Check Operation Types (T982 + T1430 — typed-dispatch surface) ===
// Re-exported at top level so CLI dispatch can import without the `ops.` namespace hop.
export type {
  CheckOps,
  ComplianceMetrics,
  ValidateArchiveStatsParams,
  ValidateArchiveStatsResult,
  ValidateCanonDocsParams,
  ValidateCanonDocsResult,
  ValidateCanonParams,
  ValidateCanonResult,
  ValidateCoherenceParams,
  ValidateCoherenceResult,
  ValidateComplianceRecordParams,
  ValidateComplianceRecordResult,
  ValidateComplianceSummaryParams,
  ValidateComplianceSummaryResult,
  ValidateComplianceSyncParams,
  ValidateComplianceSyncResult,
  ValidateComplianceViolationsParams,
  ValidateComplianceViolationsResult,
  ValidateGateParams,
  ValidateGateResult,
  ValidateGradeListParams,
  ValidateGradeListResult,
  ValidateGradeParams,
  ValidateGradeResult,
  ValidateManifestParams,
  ValidateManifestResult,
  ValidateOutputParams,
  ValidateOutputResult,
  ValidateProtocolBaseParams,
  ValidateProtocolParams,
  ValidateProtocolResult,
  ValidateSchemaParams,
  ValidateSchemaResult,
  ValidateTaskParams,
  ValidateTaskResult,
  ValidateTestCoverageParams,
  ValidateTestCoverageResult,
  ValidateTestRunParams,
  ValidateTestRunResult,
  ValidateTestStatusParams,
  ValidateTestStatusResult,
  ValidateVerifyExplainParams,
  ValidateVerifyExplainResult,
  ValidateWorkflowComplianceParams,
  ValidateWorkflowComplianceResult,
  ValidationSeverity,
  ValidationViolation,
} from './operations/validate.js';
// T1238 Variable substitution — re-exported at top level so SDK consumers can
// import resolver contracts without the `ops.` namespace hop.
export type {
  ResolvedVariable,
  SubstitutionContext,
  SubstitutionOptions,
  SubstitutionResult,
  SubstitutionSource,
  VariableResolver,
} from './operations/variable-substitution.js';
// === Worktree Backend SDK Types (T1161) ===
// Re-exported at top level so @cleocode/worktree and callers can
// import without the `ops.` namespace hop.
export type {
  AdoptWorktreeOpts,
  AdoptWorktreeResult,
  CreateWorktreeOptions,
  CreateWorktreeResult,
  DestroyWorktreeOptions,
  DestroyWorktreeResult,
  ForceUnlockWorktreeOpts,
  ForceUnlockWorktreeResult,
  ListWorktreesOptions,
  ListWorktreesOpts,
  ListWorktreesResult,
  PrunedWorktreeOutcome,
  PruneOrphanedWorktreesOpts,
  PruneOrphanedWorktreesResult,
  PruneWorktreesOptions,
  PruneWorktreesResult,
  WorktreeHook,
  WorktreeHookResult,
  WorktreeIncludePattern,
  WorktreeInfo,
  WorktreeLifecycleAction,
  WorktreeLifecycleAuditEntry,
  WorktreeListEntry,
  WorktreeSource,
  WorktreeStatusCategory,
} from './operations/worktree.js';
// === Orchestration Roll-up Types (T9082, ADR-070) ===
export type {
  EpicRollup,
  RollupBlocker,
  RollupEvidenceAtom,
  RollupWorker,
  WaveRollup,
} from './orchestration-rollup.js';
// === Peer Identity (T1210 — SDK-first CANT persona contract) ===
export {
  assertPeerIdentity,
  filterPeerIdentities,
  isPeerIdentity,
  type PeerIdentity,
  type PeerKind,
} from './peer.js';
// === Playbook DSL Types (T889 / T904 / W4-6) ===
export type {
  ContractViolationRecord,
  PlaybookAgenticNode,
  PlaybookApproval,
  PlaybookApprovalNode,
  PlaybookApprovalStatus,
  PlaybookDefinition,
  PlaybookDeterministicNode,
  PlaybookEdge,
  PlaybookEdgeCondition,
  PlaybookEnsures,
  PlaybookErrorHandler,
  PlaybookInput,
  PlaybookNode,
  PlaybookNodeBase,
  PlaybookNodeOnFailure,
  PlaybookNodeType,
  PlaybookPolicy,
  PlaybookRequires,
  PlaybookRun,
  PlaybookRunStatus,
} from './playbook.js';
// === PostgresDataAccessor Contracts — cloud-sync scaffold (T9062) ===
export type {
  CreatePostgresDataAccessorFn,
  PostgresDataAccessor,
  PostgresDataAccessorOptions,
  PostgresSyncDirection,
  PostgresTenantNamespace,
  PostgresTenantStrategy,
  SyncResult,
  SyncStatus,
} from './postgres-data-accessor.js';
// === Project Context (ecosystem detection types) ===
export type {
  EcosystemHint,
  FileNamingConvention,
  ImportStyle,
  ProjectContext,
  ProjectType,
  TestFramework,
} from './project-context.js';
// === ProjectTools Contracts (scaffold-project, doctor-project, scaffold-global — T10069 / T9835b) ===
export type {
  DoctorProjectOptions,
  DoctorProjectResult,
  ScaffoldGlobalResult,
  ScaffoldProjectOptions,
  ScaffoldProjectResult,
  ScaffoldProjectStep,
} from './project-tools.js';
// === Provenance Graph Unions (T9955 — promoted from core/store/tasks-schema.ts) ===
// Note: ReleaseChannel/ReleaseKind/ReleaseScheme/ReleaseStatus collide with the
// existing `./release/channel.js` + `./release/plan.js` + `./task.js` exports
// (different domains, different value sets). The colliding 4 are re-exported
// here under `Provenance…`-qualified aliases. The other 12 keep their natural
// names — they are unique across the package.
export type {
  BrainReleaseLinkType,
  CommitConventionalType,
  CommitFileChangeType,
  CommitLinkKind,
  CommitLinkSource,
  PrLinkKind,
  PrLinkSource,
  PrState,
  ReleaseArtifactType,
  ReleaseChangeType,
  ReleaseChannel as ProvenanceReleaseChannel,
  ReleaseClassifiedBy,
  ReleaseImpact,
  ReleaseKind as ProvenanceReleaseKind,
  ReleaseScheme as ProvenanceReleaseScheme,
  ReleaseStatus as ProvenanceReleaseStatus,
} from './provenance.js';
export type { AdapterPathProvider } from './provider-paths.js';
// === Release Channel ===
export type { ChannelValidationResult, ReleaseChannel } from './release/channel.js';
// === Release Evidence Atoms (T9764 + T9838) ===
export type {
  GhPrViewPayload,
  ParsedPrEvidenceAtom,
  PrEvidenceStateModifier,
} from './release/evidence-atoms.js';
export {
  ghPrViewSchema,
  PR_REQUIRED_WORKFLOWS,
  PR_REQUIRED_WORKFLOWS_ENV_VAR,
  parsedPrEvidenceAtomSchema,
  prEvidenceStateModifierSchema,
} from './release/evidence-atoms.js';
// === Release GitHub PR ===
export type {
  BranchProtectionResult,
  CleoKnownLabel,
  CleoLabelPalette,
  LabelDefinition,
  LabelEnsureResult,
  PRCreateOptions,
  PRLabelResolution,
  PRMode,
  PRResult,
  RepoIdentity,
} from './release/github-pr.js';
// === Release Pipeline (T1597 / ADR-063) ===
export type {
  PublishResult,
  ReleaseGateStatus,
  ReleaseHandle,
  ReleaseReconcileResult,
  ReleaseVersionScheme,
  VerifyResult,
} from './release/pipeline.js';
// === Release Plan Envelope (T9527 / SPEC-T9345 §6) ===
export type {
  GateName as ReleaseGateName,
  GateStatus as ReleaseGateExecutionStatus,
  Impact as ReleasePlanImpact,
  PlatformTuple,
  Publisher,
  ReleaseChannel as ReleasePlanChannel,
  ReleaseGate,
  ReleaseKind,
  ReleasePlan,
  ReleasePlanChangelog,
  ReleasePlanMeta,
  ReleasePlanTask,
  ReleasePlatformMatrixEntry,
  ReleasePreflightSummary,
  ReleaseScheme,
  ReleaseStatus as ReleasePlanStatus,
  ResolvedSource,
  TaskKind as ReleaseTaskKind,
} from './release/plan.js';
export {
  GATE_NAME,
  GATE_STATUS,
  GateNameSchema,
  GateStatusSchema,
  IMPACT,
  ImpactSchema,
  PLATFORM_TUPLE,
  PlatformTupleSchema,
  PUBLISHER,
  PublisherSchema,
  parseReleasePlan,
  RELEASE_CHANNEL,
  RELEASE_KIND,
  RELEASE_PLAN_SCHEMA_URL,
  RELEASE_PLAN_SCHEMA_VERSION,
  RELEASE_SCHEME,
  RELEASE_STATUS,
  RESOLVED_SOURCE,
  ReleaseChannelSchema,
  ReleaseGateSchema,
  ReleaseKindSchema,
  ReleasePlanChangelogSchema,
  ReleasePlanMetaSchema,
  ReleasePlanSchema,
  ReleasePlanTaskSchema,
  ReleasePlatformMatrixEntrySchema,
  ReleasePreflightSummarySchema,
  ReleaseSchemeSchema,
  ReleaseStatusSchema,
  ResolvedSourceSchema,
  safeParseReleasePlan,
  TASK_KIND,
  TaskKindSchema,
} from './release/plan.js';
// === Release ship-e2e-smoke (T10103) ===
export type {
  ShipE2eSmokeFinalState,
  ShipE2eSmokeParams,
  ShipE2eSmokeResult,
  ShipE2eSmokeStep,
  ShipE2eSmokeStepName,
  ShipE2eSmokeStepStatus,
} from './release/ship-e2e-smoke.js';
// === Release Version Bump ===
export type {
  BumpResult,
  BumpType,
  BumpVersionFromConfigResult,
  ResolveVersionBumpTargetsResult,
  VersionBumpStrategy,
  VersionBumpTarget,
  VersionBumpTargetSource,
} from './release/version-bump.js';
// === Human Render Contract (Epic T10114, ADR-077) ===
export * from './render/index.js';
export type {
  AdmissionResult,
  GovernorMode,
  ResourceClass,
  ResourceDeferral,
  ResourceGrant,
} from './resource-governor.js';
// === Resource Governor — Never-OOM admission layer (T11999 / Epic T11992) ===
export {
  DEFAULT_RESOURCE_RETRY_AFTER_MS,
  isResourceGrant,
  RESOURCE_BACKPRESSURE_CODE,
  RESOURCE_CLASSES,
  RESOURCE_DEFERRED_CODE,
} from './resource-governor.js';
// === Result Types (Dashboard, Stats, Log, Context, Sequence, Analysis, Deps) ===
export type {
  BottleneckTask,
  CompleteTaskUnblocked,
  ContextResult,
  DashboardResult,
  LabelCount,
  LeveragedTask,
  LogQueryResult,
  SequenceResult,
  StatsActivityMetrics,
  StatsAllTime,
  StatsCompletionMetrics,
  StatsCurrentState,
  StatsCycleTimes,
  StatsResult,
  TaskAnalysisResult,
  TaskDepsResult,
  TaskRef,
  TaskRefPriority,
  TaskSummary,
} from './results.js';
// === Scaffold + Diagnostic Result Types (SG-ARCH-SOLID T9831 / E-CONTRACTS-FOUNDATION T9832) ===
export type {
  CheckResult,
  CheckStatus,
  HookCheckResult,
  ScaffoldResult,
} from './scaffold-diagnostics.js';
// === SDK Tool Contract (Category B harness-agnostic SDK utilities — T1768 / ADR-064) ===
export type { SdkTool, SdkToolIdentity } from './sdk-tool.js';
// === Sentient Tier-2 Types (T1008) ===
export type {
  ProposalCandidate,
  ProposalSource,
  ProposedTaskMeta,
  Tier2Stats,
} from './sentient.js';
// === Session Start Result ===
export type {
  Session,
  SessionScope,
  SessionStartResult,
  SessionStats,
  SessionTaskWork,
} from './session.js';
// === Session Types ===
export { SessionView } from './session.js';
export type {
  SessionJournalDebriefSummary,
  SessionJournalDoctorSummary,
  SessionJournalEntry,
} from './session-journal.js';
// === Session Journal Types (T1263 PSYCHE E6) ===
export {
  SESSION_JOURNAL_SCHEMA_VERSION,
  sessionJournalDebriefSummarySchema,
  sessionJournalDoctorSummarySchema,
  sessionJournalEntrySchema,
} from './session-journal.js';
// === Skills Hermes Import (T9691 — SG-CLEO-SKILLS Sphere B) ===
export type {
  SkillImportHermesRequest,
  SkillImportHermesResponse,
  SkillImportHermesRow,
} from './skills/import-hermes.js';
// === Skills Migrate (T9742 — single cleo skills migrate verb) ===
export type {
  SkillMigrateAction,
  SkillMigrateMigratedRow,
  SkillMigrateRequest,
  SkillMigrateResponse,
  SkillMigrateSkippedRow,
  SkillMigrateSkipReason,
  SkillMigrateSourceType,
} from './skills/migrate.js';
// === Skills Prune Telemetry (T9693 — SG-CLEO-SKILLS Sphere B retention) ===
export type {
  SkillPruneTelemetryRequest,
  SkillPruneTelemetryResponse,
} from './skills/prune.js';
// === Skills Stats (T9690 — SG-CLEO-SKILLS Sphere B) ===
export type {
  SkillStatsAgentCreatedRow,
  SkillStatsByLifecycleRow,
  SkillStatsBySourceRow,
  SkillStatsRequest,
  SkillStatsResponse,
  SkillStatsTopRow,
  StatsSkillLifecycleState,
  StatsSkillSourceType,
} from './skills/stats.js';
export type {
  AdapterSpawnProvider,
  AgentContainmentMode,
  AgentSuiteOwnership,
  SpawnContext,
  SpawnResult,
} from './spawn.js';
// === CLEO Spawn Types (distinct from adapter spawn) ===
export type {
  CAAMPSpawnOptions,
  CAAMPSpawnResult,
  CLEOSpawnAdapter,
  CLEOSpawnContext,
  CLEOSpawnResult,
  Provider,
  SpawnStatus,
  TokenResolution,
} from './spawn-types.js';
// === Status Registry (MUST be first — everything depends on this) ===
export {
  ADR_STATUSES,
  type AdrStatus,
  // Registry
  type EntityType,
  GATE_STATUSES,
  type GateStatus,
  isValidStatus,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  MANIFEST_STATUSES,
  type ManifestStatus,
  // Display icons
  PIPELINE_STATUS_ICONS,
  type PipelineStatus,
  SESSION_STATUSES,
  type SessionStatus,
  STAGE_STATUS_ICONS,
  STATUS_REGISTRY,
  type StageStatus,
  TASK_STATUS_SYMBOLS_ASCII,
  TASK_STATUS_SYMBOLS_UNICODE,
  // Constants
  TASK_STATUSES,
  // Derived types
  type TaskStatus,
  TERMINAL_PIPELINE_STATUSES,
  TERMINAL_STAGE_STATUSES,
  // Terminal state sets
  TERMINAL_TASK_STATUSES,
} from './status-registry.js';
// === Sub-Accessor Contracts (T9188) ===
export type {
  AgentRegistrySubAccessor,
  BrainAccessor,
  BrainMemoryHit,
  BrainObserveParams,
  ConduitAccessor,
  NexusAccessor,
  TelemetryAccessor,
} from './sub-accessors.js';
export type {
  ChildState,
  ChildStatus,
  EnvPair,
  ErrorResponse,
  HealthRequest,
  HealthResponse,
  LifecycleEventKind,
  LifecycleEventResponse,
  MonitorRequest,
  MonitorResponse,
  RestartedResponse,
  RestartRequest,
  SpawnedResponse,
  SpawnRequest,
  SupervisorIpcEnvelope,
  SupervisorIpcRequest,
  SupervisorIpcRequestEnvelope,
  SupervisorIpcResponse,
  SupervisorIpcResponseEnvelope,
} from './supervisor-ipc/index.js';
// === Supervisor IPC v1.0 (FROZEN — T11339 · SG-RUNTIME-UNIFICATION R1) ===
export {
  ChildStateSchema,
  ChildStatusSchema,
  EnvPairSchema,
  ErrorResponseSchema,
  HealthRequestSchema,
  HealthResponseSchema,
  LifecycleEventKindSchema,
  LifecycleEventResponseSchema,
  MonitorRequestSchema,
  MonitorResponseSchema,
  RestartedResponseSchema,
  RestartRequestSchema,
  SpawnedResponseSchema,
  SpawnRequestSchema,
  SUPERVISOR_IPC_CHANNEL_BASENAME,
  SUPERVISOR_IPC_MESSAGE_KINDS,
  SUPERVISOR_IPC_PROTOCOL_VERSION,
  SUPERVISOR_IPC_REQUEST_KINDS,
  SUPERVISOR_IPC_RESPONSE_KINDS,
  SupervisorIpcEnvelopeSchema,
  SupervisorIpcRequestEnvelopeSchema,
  SupervisorIpcRequestSchema,
  SupervisorIpcResponseEnvelopeSchema,
  SupervisorIpcResponseSchema,
} from './supervisor-ipc/index.js';
// === Task Types ===
export type {
  AcceptanceItem,
  CancelledTask,
  CompletedTask,
  EpicLifecycle,
  EvidenceAtom,
  FileMeta,
  GateEvidence,
  Phase,
  PhaseStatus,
  PhaseTransition,
  ProjectMeta,
  Release,
  ReleaseStatus,
  SessionNote,
  // T9071 — system-wide severity attestation primitive
  SeverityAttestation,
  Task,
  TaskCreate,
  // T944 new axes (T9072: renamed TaskRole → TaskKind)
  TaskKind,
  TaskOrigin,
  TaskPriority,
  TaskProvenance,
  TaskRelation,
  TaskScope,
  TaskSeverity,
  TaskSize,
  TaskType,
  TaskVerification,
  TaskWorkState,
  VerificationAgent,
  VerificationFailure,
  VerificationGate,
} from './task.js';
export { isTestFixtureOrigin, TASK_ORIGIN_CANONICAL } from './task.js';
// === Task Evidence Types (T801) ===
export type {
  CommandOutputEvidence,
  FileEvidence,
  LogEvidence,
  ScreenshotEvidence,
  TaskEvidence,
  TaskEvidenceInput,
  TaskEvidenceKind,
  TestOutputEvidence,
} from './task-evidence.js';
export {
  commandOutputEvidenceSchema,
  fileEvidenceSchema,
  logEvidenceSchema,
  screenshotEvidenceSchema,
  taskEvidenceSchema,
  testOutputEvidenceSchema,
} from './task-evidence.js';
// === TaskRecord Types (string-widened for dispatch/LAFS) ===
export type {
  MinimalTaskRecord,
  TaskRecord,
  TaskRecordRelation,
  TaskRecordRelationCounts,
  ValidationHistoryEntry,
} from './task-record.js';
// === Task Sync Types (provider-agnostic reconciliation) ===
export type {
  ConflictPolicy,
  ExternalLinkType,
  ExternalTask,
  ExternalTaskLink,
  ExternalTaskProvider,
  ExternalTaskStatus,
  ReconcileAction,
  ReconcileActionType,
  ReconcileOptions,
  ReconcileResult,
  SyncDirection,
} from './task-sync.js';
export type { ArchiveReasonValue } from './tasks/archive.js';
// === Archive Reason Enum (T1409 — typed z.enum + tombstone guard) ===
export {
  ARCHIVE_REASON_TOMBSTONE,
  ARCHIVE_REASON_TOMBSTONE_ENV,
  ARCHIVE_REASON_VALUES,
  ArchiveReason,
  ArchiveReasonSchema,
  ArchiveReasonTombstoneError,
  assertArchiveReason,
  isArchiveTombstoneAllowed,
} from './tasks/archive.js';
// === Task Domain Result Types (T1703 — canonical shapes for operations/tasks.ts stubs) ===
export type {
  CompletionBlockerReason,
  CompletionContextPack,
  CompletionContextPackOptions,
  CompletionContextPackSummary,
  CompletionCriterionEvaluation,
  CompletionCriterionKind,
  CompletionCriterionReplacement,
  CompletionCriterionStatus,
  CompletionCriterionWaiver,
  CompletionEvaluateParams,
  CompletionEvaluateResult,
  CompletionEvaluation,
  CompletionExplainParams,
  CompletionExplainResult,
  CompletionExplanation,
  CompletionHistoryEvent,
  CompletionHistoryEventAction,
  CompletionHistoryEventRelation,
  CompletionListParams,
  CompletionListResult,
  CompletionProjectionRepairError,
  CompletionProjectionRepairErrorCode,
  CompletionProjectionRepairParams,
  CompletionProjectionRepairResult,
  CompletionStaleReason,
  TaskComplexityFactor,
  TaskDependsRef,
  TaskDependsResult,
  TaskLabelInfo,
  TaskMutationBucket,
  TaskMutationDryRunSummary,
  TaskMutationEnvelope,
  TaskMutationWarning,
  TaskMutationWarningSeverity,
  TaskPlanBlockedTask,
  TaskPlanInProgressEpic,
  TaskPlanMetrics,
  TaskPlanOpenBug,
  TaskPlanReadyTask,
  TaskPlanResult,
  TaskTreeNode,
  TaskView,
  TaskViewChildRollup,
  TaskViewGatesStatus,
  TaskViewLifecycleProgress,
  TaskViewNextAction,
  TaskViewPipelineStage,
} from './tasks.js';
export {
  completionCriterionEvaluationSchema,
  completionEvaluateParamsSchema,
  completionEvaluationSchema,
  completionExplainParamsSchema,
  completionExplanationSchema,
  completionListParamsSchema,
  completionListResultSchema,
  completionProjectionRepairErrorSchema,
  completionProjectionRepairParamsSchema,
  completionProjectionRepairResultSchema,
  unsatisfiedCompletionCriterionSchema,
} from './tasks.js';
// === Canonical Taxonomy Registry (T11186) ===
export type {
  CanonicalTagMetadata,
  TaxonomyAxis,
} from './taxonomy.js';
export {
  BUILTIN_TAXONOMY_TAGS,
  CANONICAL_DOC_KIND_TAGS,
  CANONICAL_DOMAIN_TAGS,
  CANONICAL_LIFECYCLE_TAGS,
  CANONICAL_PRIORITY_TAGS,
  CANONICAL_TAG_VALUES,
  CANONICAL_TYPE_TAGS,
  TaxonomyError,
  TaxonomyRegistry,
} from './taxonomy.js';
// === Template Manifest (T9875 / Saga T9855) ===
export type {
  PlaceholderSource,
  PlaceholderSpec,
  PlaceholderSpecInput,
  TemplateKind,
  TemplateManifestEntry,
  TemplateManifestEntryInput,
  TemplateSubstitution,
  UpdateStrategy,
} from './templates/manifest.js';
export {
  PLACEHOLDER_SOURCES,
  PlaceholderSpecSchema,
  TEMPLATE_KINDS,
  TEMPLATE_SUBSTITUTIONS,
  TEMPLATE_UPDATE_STRATEGIES,
  TemplateManifestEntrySchema,
} from './templates/manifest.js';
export type { FetchBrainEntriesInput, FetchBrainEntriesOutput } from './tools/brain-fetch.js';
export type { ObserveBrainInput, ObserveBrainOutput } from './tools/brain-observe.js';
// === SDK Tool Contracts (T10068 / T10070 / T9835) ===
// BrainTools (T10070 / T9835c)
export type { SearchBrainInput, SearchBrainOutput } from './tools/brain-search.js';
export type { TimelineBrainInput, TimelineBrainOutput } from './tools/brain-timeline.js';
export type {
  BuildRetrievalBundleInput,
  BuildRetrievalBundleOutput,
} from './tools/build-retrieval-bundle.js';
// TaskTools (T10068 / T9835b)
export type {
  BuildTaskTreeInput,
  BuildTaskTreeOptions,
  BuildTaskTreeResult,
} from './tools/build-task-tree.js';
export type {
  CriticalPathEdge,
  CriticalPathNode,
  CriticalPathResult,
} from './tools/compute-critical-path.js';
export type {
  SchemaColumn,
  SchemaDescriptor,
  SchemaIndex,
  SchemaTableDescriptor,
} from './tools/describe-schema.js';
export type { RenderTaskTreeInput } from './tools/render-task-tree.js';
export type {
  ScoreFactor,
  ScoreTaskContext,
  ScoreTaskInput,
  ScoreTaskResult,
} from './tools/score-task-priority.js';
// === Transport (low-level wire protocol) ===
export type {
  AdapterTransportProvider,
  Transport,
  TransportConnectConfig,
} from './transport.js';
// === Validator Role Contracts (T10510 / Saga T10377 SG-IVTR-AC-BINDING) ===
// Canonical AgentRole enum + per-AC ValidatorFinding + ValidatorAttestation /
// ValidatorRejection envelopes + ValidatorVerdict discriminated union. Consumed
// by SDK tools (T10511) and the Max-N runtime (T10512) under Epic T10383
// E-VALIDATOR-ROLE.
export type {
  AgentRole,
  ValidatorAttestation,
  ValidatorFinding,
  ValidatorFindingStatus,
  ValidatorRejection,
  ValidatorVerdict,
} from './validator/index.js';
export {
  AGENT_ROLES,
  isAgentRole,
  isValidatorAttestation,
  isValidatorRejection,
  isValidatorVerdict,
  VALIDATOR_ID_REGEX,
  validatorAttestationSchema,
  validatorFindingSchema,
  validatorRejectionSchema,
  validatorVerdictSchema,
} from './validator/index.js';
// === Universal Service Vault — declarative service-provider registry (T11937 seed + T11938 breadth, epic T11765) ===
export type {
  CredentialHeaderRule,
  HostAuthStrategy,
  InjectionRule,
  InjectionValueSource,
  MetadataHeaderRule,
  RefreshBodyFormat,
  RefreshClientAuth,
  RefreshConfig,
  RefreshKind,
  ServiceAuthKind,
  ServiceHostRule,
  ServiceProviderDef,
} from './vault/service-provider.js';
export {
  REFRESH_KINDS,
  SERVICE_AUTH_KINDS,
  SERVICE_PROVIDERS,
} from './vault/service-provider.js';
export type {
  TasksFrontierParamsInput,
  TasksRollupParamsInput,
  TasksTraverseParamsInput,
  TasksTreeParamsInput,
  TasksWorkGraphAuditParamsInput,
  WorkGraphAudienceMode,
  WorkGraphAuditOptions,
  WorkGraphAuditResult,
  WorkGraphContainmentAncestorsResult,
  WorkGraphContainmentChildrenResult,
  WorkGraphContainmentNode,
  WorkGraphContainmentQueryService,
  WorkGraphContextBudget,
  WorkGraphContextPack,
  WorkGraphContextPackParams,
  WorkGraphDependencyEdge,
  WorkGraphDirectEdge,
  WorkGraphEdge,
  WorkGraphEdgeDirection,
  WorkGraphEdgeSource,
  WorkGraphHierarchyInputNode,
  WorkGraphHierarchyValidationOptions,
  WorkGraphHierarchyValidationResult,
  WorkGraphHierarchyViolation,
  WorkGraphNode,
  WorkGraphNodeRef,
  WorkGraphOmission,
  WorkGraphOmissionReason,
  WorkGraphPageInfo,
  WorkGraphPaginationOptions,
  WorkGraphPercentDenominator,
  WorkGraphPlanningDoc,
  WorkGraphPlanningDocParams,
  WorkGraphProjectionMismatch,
  WorkGraphReader,
  WorkGraphReadinessParams,
  WorkGraphReadinessResult,
  WorkGraphReadyFrontierBlockedBy,
  WorkGraphReadyFrontierOptions,
  WorkGraphReadyFrontierResult,
  WorkGraphReadyFrontierTask,
  WorkGraphRelationEdge,
  WorkGraphRelationEdgesOptions,
  WorkGraphRelationEdgesResult,
  WorkGraphRelationKind,
  WorkGraphRelationQueryService,
  WorkGraphRollupCounts,
  WorkGraphScaffoldApplyParams,
  WorkGraphScaffoldApplyResult,
  WorkGraphScaffoldValidateParams,
  WorkGraphScaffoldValidateResult,
  WorkGraphScaffoldValidationIssue,
  WorkGraphSlice,
  WorkGraphSliceParams,
  WorkGraphSnapshot,
  WorkGraphSubtreePercentages,
  WorkGraphSubtreeSummaryOptions,
  WorkGraphSubtreeSummaryResult,
  WorkGraphTaskRelationType,
  WorkGraphTraversalDirection,
  WorkGraphTraversalOptions,
  WorkGraphTraversalResult,
  WorkGraphTreeNode,
  WorkGraphTreeOptions,
  WorkGraphTreeResult,
} from './workgraph.js';
// === PM-Core V2 WorkGraph public contracts ===
export {
  canWorkGraphTaskTypeBeRoot,
  E_WORKGRAPH_PARENT_TYPE_MATRIX,
  isAllowedWorkGraphParentType,
  tasksFrontierParamsSchema,
  tasksFrontierResultSchema,
  tasksRollupParamsSchema,
  tasksRollupResultSchema,
  tasksTraverseParamsSchema,
  tasksTraverseResultSchema,
  tasksTreeParamsSchema,
  tasksTreeResultSchema,
  tasksWorkGraphAuditParamsSchema,
  tasksWorkGraphAuditResultSchema,
  validateWorkGraphHierarchy,
  WorkGraphHierarchyInvariantError,
  workGraphContextPackParamsSchema,
  workGraphContextPackSchema,
  workGraphPlanningDocParamsSchema,
  workGraphPlanningDocSchema,
  workGraphReadinessParamsSchema,
  workGraphReadinessResultSchema,
  workGraphScaffoldApplyParamsSchema,
  workGraphScaffoldApplyResultSchema,
  workGraphScaffoldValidateParamsSchema,
  workGraphScaffoldValidateResultSchema,
  workGraphSliceParamsSchema,
  workGraphSliceSchema,
} from './workgraph.js';
// === WASM SDK (Rust crate bindings) ===
