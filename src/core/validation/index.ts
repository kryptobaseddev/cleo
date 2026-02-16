/**
 * Validation system barrel exports.
 *
 * Provides the complete validation system ported from lib/validation/*.
 *
 * @task T4523
 * @epic T4454
 */

// Core validation engine
export {
  VALID_STATUSES,
  VALID_OPERATIONS,
  VALID_PHASE_STATUSES,
  FIELD_LIMITS,
  type TaskStatus,
  type ValidationError,
  type ValidationResult,
  type Task,
  type TodoFile,
  type ArchiveFile,
  type ComprehensiveValidationResult,
  sanitizeFilePath,
  validateTitle,
  validateDescription,
  validateNote,
  validateBlockedBy,
  validateSessionNote,
  validateCancelReason,
  validateStatusTransition,
  isValidStatus,
  checkTimestampSanity,
  isMetadataOnlyUpdate,
  normalizeLabels,
  checkIdUniqueness,
  validateTask,
  validateNoCircularDeps,
  validateSingleActivePhase,
  validateCurrentPhaseConsistency,
  validatePhaseTimestamps,
  validatePhaseStatusRequirements,
  validateAll,
} from './engine.js';

// Compliance checking
export {
  type ComplianceMetrics,
  type ManifestIntegrity,
  type TokenMetrics,
  type TokenEfficiency,
  type OrchestrationOverhead,
  checkManifestEntry,
  checkReturnFormat,
  scoreSubagentCompliance,
  calculateTokenEfficiency,
  calculateOrchestrationOverhead,
} from './compliance.js';

// Gap analysis
export {
  type GapReport,
  type GapEntry,
  type CoverageEntry,
  parseManifest,
  findReviewDocs,
  extractTopics,
  searchCanonicalCoverage,
  analyzeCoverage,
  formatGapReport,
} from './gap-check.js';

// Manifest validation
export {
  type ManifestEntry,
  type ManifestViolation,
  type ManifestValidationResult,
  type ComplianceEntry,
  findManifestEntry,
  validateManifestEntry,
  logRealCompliance,
  validateAndLog,
} from './manifest.js';

// Verification gates
export {
  VERIFICATION_GATE_ORDER,
  VERIFICATION_VALID_AGENTS,
  type GateName,
  type AgentName,
  type Verification,
  type VerificationGates,
  type VerificationStatus,
  type FailureLogEntry,
  type CircularValidationResult,
  type TaskForVerification,
  isValidGateName,
  isValidAgentName,
  getGateOrder,
  getGateIndex,
  getDownstreamGates,
  initVerification,
  computePassed,
  setVerificationPassed,
  updateGate,
  resetDownstreamGates,
  incrementRound,
  logFailure,
  checkAllGatesPassed,
  isVerificationComplete,
  getVerificationStatus,
  shouldRequireVerification,
  getMissingGates,
  getGateSummary,
  checkCircularValidation,
  allEpicChildrenVerified,
  allSiblingsVerified,
} from './verification.js';

// Protocol validation common
export {
  type ProtocolViolation,
  type ProtocolValidationResult,
  checkOutputFileExists,
  checkDocumentationSections,
  checkReturnMessageFormat,
  checkManifestFieldPresent,
  checkManifestFieldType,
  checkKeyFindingsCount,
  checkStatusValid,
  checkAgentType,
  checkLinkedTasksPresent,
  checkProvenanceTags,
  validateCommonManifestRequirements,
} from './protocol-common.js';

// Documentation drift detection
export {
  type DriftIssue,
  type DriftReport,
  getScriptCommands,
  getIndexScripts,
  getIndexCommands,
  checkCommandsSync,
  checkWrapperSync,
  detectDrift,
  shouldRunDriftDetection,
} from './docs-sync.js';

// Doctor health checks
export * from './doctor/index.js';
