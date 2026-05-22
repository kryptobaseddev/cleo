/**
 * Directory & file scaffolding utilities.
 *
 * Barrel re-export — all implementation lives in the sibling
 * packages/core/src/scaffold/ directory (T10066 · T9834c · Saga T9831).
 *
 * External callers that import from './scaffold.js' (or '@cleocode/core'
 * subpaths that forward here) continue to see the same public surface.
 */

export type {
  CheckResult,
  CheckStatus,
  ScaffoldResult,
} from '@cleocode/contracts/scaffold-diagnostics';
export {
  CLEO_GITIGNORE_FALLBACK,
  createDefaultConfig,
  ensureConfig,
  ensureContributorMcp,
  ensureGitignore,
  ensureProjectInfo,
  ensureWorktreeInclude,
  getCleoVersion,
  getGitignoreContent,
  getPackageRoot,
  getWorktreeIncludeContent,
  WORKTREE_INCLUDE_FALLBACK,
} from './scaffold/ensure-config.js';

export {
  ensureBrainDb,
  ensureCleoGitRepo,
  ensureCleoStructure,
  ensureProjectGitInitialCommit,
  ensureSqliteDb,
  generateProjectHash,
  REQUIRED_CLEO_SUBDIRS,
} from './scaffold/ensure-dirs.js';
export { ensureProjectContext } from './scaffold/ensure-skills.js';
export { ensureGlobalIdentity, ensureGlobalTemplates } from './scaffold/ensure-templates.js';
export {
  ensureCleoOsHub,
  ensureGlobalHome,
  ensureGlobalScaffold,
  REQUIRED_GLOBAL_SUBDIRS,
  type ScaffoldHubData,
  STALE_GLOBAL_ENTRIES,
} from './scaffold/global-scaffold.js';
export {
  fileExists,
  hasGitIdentity,
  removeCleoFromRootGitignore,
  stripCLEOBlocks,
} from './scaffold/init.js';
export {
  type MigrateWorktreeIncludeResult,
  migrateWorktreeIncludeFile,
} from './scaffold/migrate-worktree-include.js';

export {
  checkBrainDb,
  checkCleoGitRepo,
  checkCleoStructure,
  checkConfig,
  checkGitignore,
  checkLogDir,
  checkMemoryBridge,
  checkNexusBridge,
  checkProjectContext,
  checkProjectInfo,
  checkSqliteDb,
  checkWorktreeInclude,
} from './scaffold/project-detection.js';

export {
  checkGlobalHome,
  checkGlobalIdentity,
  checkGlobalTemplates,
} from './scaffold/telemetry.js';
