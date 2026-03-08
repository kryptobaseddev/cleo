/**
 * Validation system barrel exports.
 *
 * Provides the complete validation system ported from lib/validation/*.
 *
 * @task T4523
 * @epic T4454
 */

// Core validation engine — also re-export registry constants for convenience
export { TASK_STATUSES } from '../../store/status-registry.js';
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
  type ArchiveFile,
  type ComprehensiveValidationResult,
  checkIdUniqueness,
  checkTimestampSanity,
  FIELD_LIMITS,
  isMetadataOnlyUpdate,
  isValidStatus,
  normalizeLabels,
  sanitizeFilePath,
  type Task,
  type TaskFile,
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
