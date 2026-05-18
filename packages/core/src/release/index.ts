/**
 * Release core module — barrel export.
 *
 * Re-exports all release management operations from the core layer.
 *
 * @task T5709
 * @epic T5701
 * @task T1572 — engine-ops migration (ENG-MIG-5)
 */

// Artifact management
export type { ArtifactConfig, ArtifactHandler, ArtifactResult, ArtifactType } from './artifacts.js';
export {
  buildArtifact,
  getArtifactHandler,
  getSupportedArtifactTypes,
  hasArtifactHandler,
  publishArtifact,
  validateArtifact,
} from './artifacts.js';
// T9528 — provenance backfill verb (Phase 2 of T9493). Aliased to
// `Provenance*` so this barrel can be re-flattened in `../internal.ts`
// without colliding with the legacy task-backfill module in `../backfill/`.
export type {
  BackfillOptions as ProvenanceBackfillOptions,
  BackfillResult as ProvenanceBackfillResult,
  BackfillTagResult as ProvenanceBackfillTagResult,
} from './backfill.js';
export {
  clearCheckpoint as backfillClearCheckpoint,
  enumerateHistoricalTags,
  loadCheckpoint as backfillLoadCheckpoint,
  provenanceBackfill,
  saveCheckpoint as backfillSaveCheckpoint,
  synthesizePlanFromTag,
} from './backfill.js';
// Changelog writing
export { parseChangelogBlocks, writeChangelogSection } from './changelog-writer.js';
// Channel resolution
export type { ChannelValidationResult, ReleaseChannel } from './channel.js';
// Note: getDefaultChannelConfig is exported from both channel.ts and release-config.ts
// with different semantics. Use getDefaultBranchChannelConfig / getDefaultChannelConfig
// via the release-config.ts version (dist-tag mapping).
export {
  channelToDistTag,
  describeChannel,
  getDefaultChannelConfig as getDefaultBranchChannelConfig,
  resolveChannelFromBranch,
  validateVersionChannel,
} from './channel.js';
// CI/CD generation
export type { CIPlatform } from './ci.js';
export {
  detectCIPlatform,
  generateCIConfig,
  getPlatformPath,
  SUPPORTED_PLATFORMS,
  validateCIConfig,
  writeCIConfig,
} from './ci.js';
// Engine operations — CLI-callable release operations migrated from dispatch layer (T1572)
export type { PRCheckStatus, PRStatusResult } from './engine-ops.js';
export {
  IVTR_DECOUPLED_AUDIT_FILE,
  IVTR_DECOUPLED_SENTINEL_FILE,
  releaseCancel,
  releaseChangelog,
  releaseChangelogSince,
  releaseCommit,
  releaseGateCheck,
  releaseGatesRun,
  releaseIvtrAutoSuggest,
  releaseList,
  releasePrepare,
  releasePrStatus,
  releasePush,
  releaseRollback,
  releaseRollbackFull,
  releaseShip,
  releaseShow,
  releaseTag,
  writeIvtrDecouplingAuditOnce,
} from './engine-ops.js';
// T9538 — release workflow bypass audit logger (SPEC-T9345 §12.3 / R-441)
export type {
  AppendReleaseWorkflowBypassOptions,
  ReleaseWorkflowBypassRecord,
} from './escape-hatch.js';
export {
  appendReleaseWorkflowBypass,
  RELEASE_WORKFLOW_BYPASS_FILE,
} from './escape-hatch.js';
// GitHub PR management
export type {
  BranchProtectionResult,
  PRCreateOptions,
  PRResult,
  RepoIdentity,
} from './github-pr.js';
export {
  buildPRBody,
  createPullRequest,
  detectBranchProtection,
  ensureCleoLabelsExist,
  extractRepoOwnerAndName,
  formatManualPRInstructions,
  isGhCliAvailable,
  listExistingLabels,
  resolvePRLabels,
} from './github-pr.js';
// Release guards
export type { DoubleListingResult, EpicCompletenessResult } from './guards.js';
export { checkDoubleListing, checkEpicCompleteness } from './guards.js';
// Post-release invariants registry (ADR-056 D5 / T1411)
export type {
  InvariantReport,
  InvariantResult,
  InvariantRunOptions,
  InvariantSeverity,
  ReconcileAction,
  ReconcileAuditRow,
  RegisteredInvariant,
} from './invariants/index.js';
export {
  ARCHIVE_REASON_INVARIANT_ID,
  clearInvariants,
  extractTaskIds,
  getInvariants,
  RECONCILE_AUDIT_FILE,
  registerArchiveReasonInvariant,
  registerInvariant,
  runInvariants,
} from './invariants/index.js';
// T9530 — v2 release open verb (Phase 3 of T9494)
export type { ReleaseOpenOptions, ReleaseOpenResult, ReleaseOpenRunner } from './open.js';
export { DEFAULT_OPEN_WORKFLOW, releaseOpen } from './open.js';
// Dispatch op registry (ADR-058 OpsFromCore inference — T1543).
// Type-only export: ops.ts declares `releaseCoreOps` via `export declare const`
// for `typeof` inference; there is NO runtime value. Re-exporting as `type`
// avoids ERR_EXPORT_NOT_DEFINED when ESM loaders evaluate this barrel.
export type { ReleaseIvtrSuggestParams, releaseCoreOps } from './ops.js';
// T1597 release pipeline (canonical 4-step flow)
export {
  loadActiveReleaseHandle,
  makeAdr061GateRunner,
  releasePublish,
  releaseReconcile,
  releaseStart,
  releaseVerify,
} from './pipeline.js';
// SPEC-T9345 release pipeline v2 verbs (T9492)
export type { ReleasePlanOptions, ReleasePlanResult } from './plan.js';
export { releasePlan } from './plan.js';
// T9526 — v2 release reconcile verb (Phase 1 of T9492)
// Named V2 to coexist with the legacy 4-step pipeline `releaseReconcile`.
export type { ReleaseReconcileV2Options, ReleaseReconcileV2Result } from './reconcile.js';
export { releaseReconcileV2 } from './reconcile.js';
// Release configuration
export type {
  ChannelConfig,
  GitFlowConfig,
  ProjectReleaseConfig,
  PushMode,
  ReleaseBranchConfig,
  ReleaseConfig,
  ReleaseGate,
} from './release-config.js';
export {
  getArtifactType,
  getChangelogConfig,
  getChannelConfig,
  getDefaultChannelConfig,
  getDefaultGitFlowConfig,
  getGitFlowConfig,
  getPushMode,
  getReleaseBranchConfig,
  getReleaseGates,
  loadReleaseConfig,
  validateReleaseConfig,
} from './release-config.js';
// Release manifest operations
export type {
  PushPolicy,
  ReleaseGateMetadata,
  ReleaseListOptions,
  ReleaseManifest,
  ReleaseTaskRecord,
} from './release-manifest.js';
export {
  cancelRelease,
  commitRelease,
  generateReleaseChangelog,
  listManifestReleases,
  markReleasePushed,
  migrateReleasesJsonToSqlite,
  prepareRelease,
  pushRelease,
  rollbackRelease,
  runReleaseGates,
  showManifestRelease,
  tagRelease,
} from './release-manifest.js';
// T9529 — provenance verify verb (Phase 2 of T9493). READ-ONLY audit of the
// 11 provenance tables for a release (or N most-recent releases).
export type {
  StaleEvidenceAtom,
  VerifyProvenanceCategories,
  VerifyProvenanceOptions,
  VerifyProvenanceReleaseResult,
  VerifyProvenanceResult,
} from './verify-provenance.js';
export { verifyProvenance } from './verify-provenance.js';
// Version bumping
export type { BumpResult, BumpType, VersionBumpTarget } from './version-bump.js';
export {
  bumpVersionFromConfig,
  calculateNewVersion,
  discoverWorkspacePackageJsonFiles,
  getVersionBumpConfig,
  isCalVer,
  isVersionBumpConfigured,
  resolveVersionBumpTargets,
  validateVersionFormat,
} from './version-bump.js';
