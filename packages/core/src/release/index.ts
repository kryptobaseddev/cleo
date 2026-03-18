/**
 * Release core module — barrel export.
 *
 * Re-exports all release management operations from the core layer.
 *
 * @task T5709
 * @epic T5701
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
  extractRepoOwnerAndName,
  formatManualPRInstructions,
  isGhCliAvailable,
} from './github-pr.js';

// Release guards
export type { DoubleListingResult, EpicCompletenessResult } from './guards.js';
export { checkDoubleListing, checkEpicCompleteness } from './guards.js';

// Release configuration
export type {
  ChannelConfig,
  GitFlowConfig,
  PushMode,
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

// Version bumping
export type { BumpResult, BumpType, VersionBumpTarget } from './version-bump.js';
export {
  bumpVersionFromConfig,
  calculateNewVersion,
  getVersionBumpConfig,
  isCalVer,
  isVersionBumpConfigured,
  validateVersionFormat,
} from './version-bump.js';
