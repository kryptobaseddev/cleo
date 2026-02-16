/**
 * Doctor module barrel exports.
 * @task T4525
 * @epic T4454
 */

export {
  type CheckResult,
  type CheckStatus,
  checkCliInstallation,
  checkCliVersion,
  checkDocsAccessibility,
  checkAtReferenceResolution,
  checkRootGitignore,
  runAllGlobalChecks,
  calculateHealthStatus,
} from './checks.js';

export {
  type ProjectDetail,
  type CategorizedProjects,
  type HealthSummary,
  type UserJourneyStage,
  isTempProject,
  categorizeProjects,
  getProjectCategoryName,
  formatProjectHealthSummary,
  getProjectGuidance,
  getUserJourneyStage,
  getJourneyGuidance,
} from './utils.js';

export {
  type DoctorProjectCache,
  type ProjectCacheEntry,
  type SchemaVersions,
  type FileHashes,
  CACHE_VERSION,
  CACHE_TTL_SECONDS,
  getCacheFilePath,
  initCacheFile,
  loadCache,
  getFileHash,
  getCachedValidation,
  cacheValidationResult,
  clearProjectCache,
  clearEntireCache,
} from './project-cache.js';
