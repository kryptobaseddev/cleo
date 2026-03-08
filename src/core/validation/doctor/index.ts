/**
 * Doctor module barrel exports.
 * @task T4525
 * @epic T4454
 */

export {
  type CheckResult,
  type CheckStatus,
  calculateHealthStatus,
  checkAtReferenceResolution,
  checkCliInstallation,
  checkCliVersion,
  checkCoreFilesNotIgnored,
  checkDocsAccessibility,
  checkNodeVersion,
  checkRootGitignore,
  checkSqliteNotTracked,
  runAllGlobalChecks,
} from './checks.js';
export {
  CACHE_TTL_SECONDS,
  CACHE_VERSION,
  cacheValidationResult,
  clearEntireCache,
  clearProjectCache,
  type DoctorProjectCache,
  type FileHashes,
  getCachedValidation,
  getCacheFilePath,
  getFileHash,
  initCacheFile,
  loadCache,
  type ProjectCacheEntry,
  type SchemaVersions,
} from './project-cache.js';
export {
  type CategorizedProjects,
  categorizeProjects,
  formatProjectHealthSummary,
  getJourneyGuidance,
  getProjectCategoryName,
  getProjectGuidance,
  getUserJourneyStage,
  type HealthSummary,
  isTempProject,
  type ProjectDetail,
  type UserJourneyStage,
} from './utils.js';
