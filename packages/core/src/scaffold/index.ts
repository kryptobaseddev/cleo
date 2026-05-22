/**
 * Barrel re-export for the scaffold module. All public symbols from the
 * 8 sibling files are re-exported here so that callers importing from
 * '@cleocode/core/scaffold' or '../scaffold/index.js' continue to work
 * unchanged.
 */

export type {
  CheckResult,
  CheckStatus,
  ScaffoldResult,
} from '@cleocode/contracts/scaffold-diagnostics';
// ensure-config.ts
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
} from './ensure-config.js';

// ensure-dirs.ts
export {
  ensureBrainDb,
  ensureCleoGitRepo,
  ensureCleoStructure,
  ensureProjectGitInitialCommit,
  ensureSqliteDb,
  generateProjectHash,
  REQUIRED_CLEO_SUBDIRS,
} from './ensure-dirs.js';
// ensure-skills.ts
export { ensureProjectContext } from './ensure-skills.js';
// ensure-templates.ts
export { ensureGlobalIdentity, ensureGlobalTemplates } from './ensure-templates.js';
// global-scaffold.ts
export {
  ensureCleoOsHub,
  ensureGlobalHome,
  ensureGlobalScaffold,
  REQUIRED_GLOBAL_SUBDIRS,
  type ScaffoldHubData,
  STALE_GLOBAL_ENTRIES,
} from './global-scaffold.js';
// init.ts
export {
  fileExists,
  hasGitIdentity,
  removeCleoFromRootGitignore,
  stripCLEOBlocks,
} from './init.js';

// project-detection.ts
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
} from './project-detection.js';

// telemetry.ts
export {
  checkGlobalHome,
  checkGlobalIdentity,
  checkGlobalTemplates,
} from './telemetry.js';
