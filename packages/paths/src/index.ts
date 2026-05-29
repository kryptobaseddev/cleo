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
 * - {@link isAbsolutePath} — cross-platform abs-path check
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
  getCanonicalTemplatesTildePath,
  getCleoHome,
  getCleoPlatformPaths,
  getCleoSystemInfo,
  getCleoTemplatesTildePath,
  legacyProjectId,
  type ResolvedProject,
  resolveCanonicalCleoDir,
  resolveLegacyCleoDir,
  resolveProjectByCwd,
} from './cleo-paths.js';
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
  type PlatformPaths,
  type PlatformPathsResolver,
  type SystemInfo,
} from './platform-paths.js';
export {
  computeProjectHash,
  getCleoWorktreesRoot,
  resolveTaskWorktreePath,
  resolveWorktreeIndexPath,
  resolveWorktreeRootForHash,
} from './worktree-paths.js';
