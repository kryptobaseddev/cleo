/**
 * `@cleocode/paths` — XDG / env-paths SSoT for the CLEO ecosystem.
 *
 * Zero-dep leaf package consumed by `@cleocode/core`, `@cleocode/worktree`,
 * `@cleocode/brain`, `@cleocode/adapters`, and `@cleocode/caamp` to eliminate
 * the env-paths and platform-path duplication that previously existed in
 * each of those packages.
 *
 * Exposes:
 * - {@link createPlatformPathsResolver} — generic factory bindable to any app
 * - CLEO-bound helpers: {@link getCleoHome}, {@link getCleoPlatformPaths},
 *   {@link getCleoSystemInfo}, {@link getCleoTemplatesTildePath}
 * - Project resolution: {@link resolveProjectByCwd}, {@link resolveCanonicalCleoDir}
 * - Worktree primitives: {@link computeProjectHash},
 *   {@link resolveWorktreeRootForHash}, {@link resolveTaskWorktreePath},
 *   {@link getCleoWorktreesRoot}, {@link resolveWorktreeIndexPath}
 * - {@link getCleoStateDir} — CLEO state dir (XDG state on Linux, `<cleoHome>/state` elsewhere)
 * - {@link expandTildePath} — `~` expansion via `os.homedir()`
 * - {@link isAbsolutePath} — cross-platform abs-path check
 * - Executable search: {@link findOnPath}, {@link prependPathEntry},
 *   {@link splitPathEnv} (PATH delimiter + PATHEXT aware, T12605)
 * - Portable identity: {@link readPortableProjectId} (tracked `.cleo/project-id`, T12325)
 *
 * @packageDocumentation
 * @task T1883
 * @task T11008
 */

export { isAbsolutePath } from './abs-path.js';
export {
  _resetCleoPlatformPathsCache,
  canonicalizePath,
  computeCanonicalProjectId,
  computePathFingerprintId,
  type DeclaredProjectIdentity,
  getCanonicalTemplatesTildePath,
  getCleoHome,
  getCleoPlatformPaths,
  getCleoStateDir,
  getCleoSystemInfo,
  getCleoTemplatesTildePath,
  legacyAliasClaimants,
  legacyProjectId,
  type RecordedProjectPath,
  type ResolvedProject,
  readDeclaredProjectIdentity,
  resolveCanonicalCleoDir,
  resolveLegacyCleoDir,
  resolveProjectByCwd,
  resolveStableDeviceIdPath,
} from './cleo-paths.js';
export {
  type ExecPathOptions,
  executableNames,
  findOnPath,
  pathDelimiterFor,
  pathEnvKey,
  prependPathEntry,
  quoteCmdArg,
  resolveSpawnInvocation,
  type ShellInvocation,
  type SpawnInvocation,
  shellInvocation,
  splitPathEnv,
} from './exec-path.js';
export {
  type EnforceOptions,
  enforceNodeVersion,
  evaluateNodeVersion,
  FALLBACK_MIN_NODE,
  getRequiredNodeVersion,
  type NodeManager,
  type NodeVersionVerdict,
  parseSemver,
  type Semver,
  type UpgradeHint,
} from './node-version-gate.js';
export {
  createPlatformPathsResolver,
  expandTildePath,
  type PlatformPaths,
  type PlatformPathsResolver,
  type SystemInfo,
} from './platform-paths.js';
export {
  formatPortableProjectId,
  isValidPortableProjectId,
  PORTABLE_PROJECT_ID_FILE,
  type PortableProjectIdRead,
  parsePortableProjectId,
  portableProjectIdPath,
  readPortableProjectId,
} from './portable-project-id.js';
export {
  computeProjectHash,
  getCleoWorktreesRoot,
  resolveTaskWorktreePath,
  resolveWorktreeIndexPath,
  resolveWorktreeRootForHash,
  resolveWorktreeTaskLockPath,
} from './worktree-paths.js';
