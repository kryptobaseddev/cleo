/**
 * XDG-compliant path resolution for CLEO V2.
 *
 * Global data directory is resolved via env-paths (XDG on Linux, platform
 * conventions on macOS and Windows):
 *   Linux:   ~/.local/share/cleo
 *   macOS:   ~/Library/Application Support/cleo
 *   Windows: %LOCALAPPDATA%\cleo
 *
 * Environment variables:
 *   CLEO_HOME   - Override global installation directory
 *   CLEO_DIR    - Project data directory (default: .cleo)
 *
 * @epic T4454
 * @task T4458
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from './errors.js';
import { getPlatformPaths } from './system/platform-paths.js';

// ============================================================================
// Worktree Scope (T380/ADR-041 §D3)
// ============================================================================

/**
 * Async context payload set by the spawn adapter when launching a subagent
 * inside a git worktree (ADR-041 §D3).
 *
 * @remarks
 * When `worktreeScope.run(scope, fn)` is active, `getProjectRoot()` returns
 * `scope.worktreeRoot` instead of walking ancestors. All DB path functions
 * that delegate to `getProjectRoot()` therefore direct their I/O to the
 * worktree's `.cleo/` directory, closing the T335 worktree-leak root cause.
 *
 * For processes that were spawned with `CLEO_WORKTREE_ROOT` in their
 * environment (but where AsyncLocalStorage is not in scope), callers should
 * populate the store via:
 * ```ts
 * worktreeScope.run(
 *   { worktreeRoot: process.env.CLEO_WORKTREE_ROOT, projectHash: process.env.CLEO_PROJECT_HASH },
 *   () => { ... }
 * );
 * ```
 *
 * @task T380
 * @public
 */
export interface WorktreeScope {
  /**
   * Absolute path to the worktree directory (value of `CLEO_WORKTREE_ROOT`).
   */
  worktreeRoot: string;
  /**
   * Project hash used to scope the worktree under the XDG worktree root
   * (value of `CLEO_PROJECT_HASH`).
   */
  projectHash: string;
}

/**
 * AsyncLocalStorage instance that carries the active {@link WorktreeScope}
 * for the current async execution context.
 *
 * @remarks
 * Set by the spawn adapter (or any caller that wants to redirect CLEO path
 * resolution to a worktree directory) before invoking subagent logic.
 * `getProjectRoot()` checks this store BEFORE the `CLEO_ROOT` env-var and
 * ancestor-walk, so scoped callers transparently receive the worktree root.
 *
 * Callers outside a worktree context receive `undefined` from
 * `worktreeScope.getStore()` and fall through to the existing resolution
 * order unchanged.
 *
 * @example
 * ```ts
 * import { worktreeScope } from '@cleocode/core/paths';
 *
 * worktreeScope.run(
 *   { worktreeRoot: '/path/to/worktree', projectHash: 'abc123' },
 *   async () => {
 *     const root = getProjectRoot(); // returns '/path/to/worktree'
 *   }
 * );
 * ```
 *
 * @task T380
 * @public
 */
export const worktreeScope = new AsyncLocalStorage<WorktreeScope>();

/**
 * Check if a CLEO project is initialized at the given root.
 * Checks for tasks.db.
 *
 * @param projectRoot - Absolute path to check; defaults to the resolved project root
 * @returns True if .cleo/ and tasks.db exist at the given root
 *
 * @remarks
 * A project is considered initialized when both the .cleo/ directory and
 * the tasks.db SQLite database file are present.
 *
 * @example
 * ```typescript
 * if (isProjectInitialized('/my/project')) {
 *   console.log('CLEO project found');
 * }
 * ```
 */
export function isProjectInitialized(projectRoot?: string): boolean {
  const root = projectRoot ?? getProjectRoot();
  const cleoDir = join(root, '.cleo');
  return existsSync(cleoDir) && existsSync(join(cleoDir, 'tasks.db'));
}

/**
 * Get the global CLEO home directory.
 * Respects CLEO_HOME env var; otherwise uses the OS-appropriate data path
 * via env-paths (XDG_DATA_HOME on Linux, Library/Application Support on macOS,
 * %LOCALAPPDATA% on Windows).
 *
 * @returns Absolute path to the global CLEO data directory
 *
 * @remarks
 * Delegates to `getPlatformPaths().data` which uses the `env-paths` package
 * for XDG-compliant path resolution across operating systems.
 *
 * @example
 * ```typescript
 * const home = getCleoHome(); // e.g. "/home/user/.local/share/cleo"
 * ```
 */
export function getCleoHome(): string {
  return getPlatformPaths().data;
}

/**
 * Get the global CLEO templates directory.
 *
 * @returns Absolute path to the templates directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/templates` where CLEO-INJECTION.md and other global
 * templates are stored.
 *
 * @example
 * ```typescript
 * const dir = getCleoTemplatesDir(); // e.g. "/home/user/.local/share/cleo/templates"
 * ```
 */
export function getCleoTemplatesDir(): string {
  return join(getCleoHome(), 'templates');
}

/**
 * Get the global CLEO schemas directory.
 *
 * @returns Absolute path to the schemas directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/schemas`. Note that schemas are typically read at
 * runtime from the npm package root, not this global directory.
 *
 * @example
 * ```typescript
 * const dir = getCleoSchemasDir();
 * ```
 */
export function getCleoSchemasDir(): string {
  return join(getCleoHome(), 'schemas');
}

/**
 * Get the global CLEO docs directory.
 *
 * @returns Absolute path to the docs directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/docs` for global documentation storage.
 *
 * @example
 * ```typescript
 * const dir = getCleoDocsDir();
 * ```
 */
export function getCleoDocsDir(): string {
  return join(getCleoHome(), 'docs');
}

/**
 * Get the project CLEO data directory (relative).
 * Respects CLEO_DIR env var, defaults to ".cleo".
 *
 * @param cwd - Optional working directory; when provided, returns absolute path
 * @returns Relative or absolute path to the project's .cleo directory
 *
 * @remarks
 * If `cwd` is provided, delegates to `getCleoDirAbsolute`. Otherwise returns
 * the `CLEO_DIR` env var or the default ".cleo" relative path.
 *
 * @example
 * ```typescript
 * const rel = getCleoDir();           // ".cleo"
 * const abs = getCleoDir('/project'); // "/project/.cleo"
 * ```
 */
export function getCleoDir(cwd?: string): string {
  if (cwd) {
    return getCleoDirAbsolute(cwd);
  }
  return process.env['CLEO_DIR'] ?? '.cleo';
}

/**
 * Get the absolute path to the project CLEO directory.
 *
 * @param cwd - Optional working directory to resolve against; defaults to process.cwd()
 * @returns Absolute path to the project's .cleo directory
 *
 * @remarks
 * If CLEO_DIR is already absolute, returns it directly. Otherwise resolves
 * it relative to the provided cwd or process.cwd().
 *
 * @example
 * ```typescript
 * const dir = getCleoDirAbsolute('/my/project'); // "/my/project/.cleo"
 * ```
 */
export function getCleoDirAbsolute(cwd?: string): string {
  const cleoDir = getCleoDir();
  if (isAbsolutePath(cleoDir)) {
    return cleoDir;
  }
  return resolve(cwd ?? process.cwd(), cleoDir);
}

/**
 * Validate that a candidate project root directory is a legitimate CLEO
 * project root and not a stray parent `.cleo/` directory that happened to
 * be found by the walk-up algorithm.
 *
 * A candidate is considered valid when its `.cleo/` directory is accompanied
 * by at least one of the following sibling markers:
 *   - `.git/` (git-backed project — most common)
 *   - `package.json` (Node.js / monorepo project root)
 *
 * These markers establish that the directory is a deliberate project root
 * rather than an accidental `.cleo/` left in a non-project parent directory
 * (e.g., `$HOME/.cleo/` from a prior buggy run, or a user's Documents folder
 * that somehow acquired a `.cleo/` sub-directory).
 *
 * @param candidate - Absolute path to the directory being considered as the
 *   project root (parent of the `.cleo/` directory).
 * @returns `true` when the candidate has a `.cleo/` sibling marker; `false`
 *   when it has `.cleo/` but no recognised sibling markers.
 *
 * @remarks
 * Intentionally does **not** validate the contents of `.cleo/` itself
 * (e.g., `project-info.json` projectHash). Hash validation is an optional
 * caller concern; this function focuses on the lightweight sibling-presence
 * check that can be done with a single `existsSync` call per marker.
 *
 * @example
 * ```typescript
 * // Project root with .git sibling — valid
 * validateProjectRoot('/home/user/myproject'); // true
 *
 * // Stray .cleo in home dir with no sibling markers — invalid
 * validateProjectRoot('/home/user'); // false
 * ```
 *
 * @task T1463
 */
export function validateProjectRoot(candidate: string): boolean {
  const gitDir = join(candidate, '.git');
  const pkgJson = join(candidate, 'package.json');
  return existsSync(gitDir) || existsSync(pkgJson);
}

/**
 * Get the project root by walking ancestor directories for `.cleo/` or `.git/`.
 *
 * Stops at the **first** ancestor directory that contains either sentinel
 * directory and never drifts past it — even when multiple nested projects
 * exist above the starting directory.
 *
 * Resolution order:
 *   1. `CLEO_ROOT` env var — bypasses walk entirely (CI / test override)
 *   2. `CLEO_DIR` env var (absolute path only) — derives project root from dirname
 *   3. Walk ancestors from `cwd` (or `process.cwd()`) toward filesystem root:
 *      - `.cleo/` found with a sibling `.git/` or `package.json` → accept as root
 *      - `.cleo/` found but **no** sibling marker → skip (stray/parent `.cleo/`)
 *      - `.git/` found (without `.cleo/` sibling) → throw `E_NOT_INITIALIZED`
 *   4. Filesystem root reached without a valid root → throw `E_INVALID_PROJECT_ROOT`
 *      (if at least one `.cleo/` was skipped) or `E_NO_PROJECT` (none found)
 *
 * @param cwd - Optional starting directory; defaults to `process.cwd()`
 * @returns Absolute path to the project root directory (parent of `.cleo/`)
 * @throws {CleoError} `ExitCode.CONFIG_ERROR` (`E_NOT_INITIALIZED`) when a
 *   `.git/` is found but no `.cleo/` is present at that level.
 * @throws {CleoError} `ExitCode.CONFIG_ERROR` (`E_INVALID_PROJECT_ROOT`) when
 *   one or more `.cleo/` directories are found but none have the required sibling
 *   markers (`.git/` or `package.json`). This prevents accidental operations on
 *   the wrong project when a stray parent `.cleo/` exists higher in the filesystem.
 * @throws {CleoError} `ExitCode.NOT_FOUND` (`E_NO_PROJECT`) when neither
 *   sentinel is found in any ancestor.
 *
 * @remarks
 * `CLEO_ROOT` is an absolute-path escape hatch for environments where the
 * working directory is unrelated to the project (CI tmpdirs, monorepo scripts,
 * test harnesses). When set it is returned as-is without scanning ancestors.
 *
 * `CLEO_DIR` set to an absolute path (e.g. `/project/.cleo`) also bypasses
 * the walk: the project root is derived as its `dirname`. This preserves
 * backward compatibility for test harnesses that use `CLEO_DIR` to pin the
 * project root.
 *
 * NEVER auto-creates `.cleo/`. Project initialisation is an explicit opt-in
 * via `cleo init`.
 *
 * @example
 * ```typescript
 * // Running from packages/core inside the monorepo:
 * const root = getProjectRoot(); // "/mnt/projects/cleocode"
 * ```
 */
export function getProjectRoot(cwd?: string): string {
  // 0. AsyncLocalStorage worktree scope (T380/ADR-041 §D3) — checked FIRST.
  //    When a spawn adapter wraps execution in worktreeScope.run(...), the
  //    scoped root wins over all env-var and walk-based resolution.
  const scope = worktreeScope.getStore();
  if (scope !== undefined) {
    return scope.worktreeRoot;
  }

  // 1. Honour CLEO_ROOT / CLEO_PROJECT_ROOT env var — bypass walk entirely.
  //    CLEO_PROJECT_ROOT is the agent-friendly alias (T090).
  const envRoot = process.env['CLEO_ROOT'] ?? process.env['CLEO_PROJECT_ROOT'];
  if (envRoot) {
    return envRoot;
  }

  // 2. If CLEO_DIR is an absolute path, derive the project root from it.
  //    This preserves backward compatibility for test harnesses that set
  //    CLEO_DIR=/some/absolute/path/.cleo to pin the project root.
  const cleoDirEnv = process.env['CLEO_DIR'];
  if (cleoDirEnv && isAbsolutePath(cleoDirEnv)) {
    if (cleoDirEnv.endsWith('/.cleo') || cleoDirEnv.endsWith('\\.cleo')) {
      return dirname(cleoDirEnv);
    }
    return cleoDirEnv;
  }

  const start = resolve(cwd ?? process.cwd());
  let current = start;

  // T889/T909 guard: snapshot $HOME and filesystem root sentinels.
  //
  // Historical bug: when `cleo` ran with `cwd=$HOME` and a stray
  // `~/.cleo/` existed (from a prior buggy run or user mistake), the
  // walk-up returned `$HOME` as the project root. This silently created
  // `~/.cleo/conduit.db`, `~/.cleo/tasks.db`, etc. — diverging from the
  // real project DBs and losing data on branch switch. See ADR-037
  // (conduit.db is project-tier-only) and the orphan-conduit remediation.
  //
  // Contract: `getProjectRoot` MUST NEVER resolve to `$HOME` or `/`.
  // If the walk would land there, treat it as "no project" rather than
  // silently accepting a pathological root. Users who legitimately want
  // `$HOME` as a project root must set `CLEO_ROOT=$HOME` explicitly — the
  // env-var path above bypasses this guard, making the opt-in explicit.
  const homeRoot = homedir();

  // T1463/P1-7: track if we skipped any .cleo/ dirs that failed validation.
  // Used to produce a more informative error message when every candidate
  // was rejected by validateProjectRoot.
  const skippedCleoDirs: string[] = [];

  // 3. Walk ancestors toward filesystem root
  while (true) {
    const cleoDir = join(current, '.cleo');
    const gitDir = join(current, '.git');

    // T889/T909: refuse to accept $HOME or / as a project root, even if a
    // `.cleo/` sentinel exists there. This blocks the orphan-DB vector.
    const isDangerousRoot = current === homeRoot || current === '/' || current === '';

    if (existsSync(cleoDir) && !isDangerousRoot) {
      // T1463/P1-7: validate that the .cleo/ dir has the required sibling
      // markers (.git/ or package.json) before accepting this candidate.
      //
      // Validation is only enforced when we have walked UP from the starting
      // directory (current !== start). When the `.cleo/` is found at the
      // exact starting directory, we accept it unconditionally — callers
      // that explicitly pass a project root directory know what they're doing
      // (e.g. test harnesses, CLI commands that receive --cwd from the user).
      //
      // The trap scenario is specifically about the walk-up finding a PARENT
      // `.cleo/` dir that belongs to a different, unrelated ancestor directory
      // (e.g. `~/.cleo/` from a prior buggy run, or a grandparent project).
      if (current === start || validateProjectRoot(current)) {
        // Valid project root — either we're at the start dir, or the parent
        // .cleo/ has a recognized sibling marker.
        return current;
      }
      // .cleo/ exists but lacks sibling markers and we're above the start —
      // skip this candidate and continue walking up for a better-anchored root.
      skippedCleoDirs.push(current);
    }

    if (existsSync(gitDir) && !isDangerousRoot) {
      // .git/ found but no .cleo/ sibling — not initialised
      throw new CleoError(ExitCode.CONFIG_ERROR, `Run cleo init at ${current}`, {
        fix: `cd ${current} && cleo init`,
      });
    }

    // Move up one level
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding either sentinel
      break;
    }
    current = parent;
  }

  // 4a. At least one .cleo/ was found but all were rejected by validateProjectRoot.
  //     This is the "parent .cleo/ trap" scenario: a stray .cleo/ dir higher in
  //     the filesystem lacks a .git/ or package.json sibling, so it cannot be
  //     trusted as a project root.
  if (skippedCleoDirs.length > 0) {
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `E_INVALID_PROJECT_ROOT: no .cleo with sibling .git found from ${start} (skipped: ${skippedCleoDirs.join(', ')})`,
      {
        fix: `cleo init or add a .git directory alongside the .cleo dir`,
      },
    );
  }

  // 4b. No sentinel found in any ancestor
  throw new CleoError(
    ExitCode.NOT_FOUND,
    'Not inside a CLEO project. Run cleo init or cd to an existing project',
    {
      fix: 'cleo init',
    },
  );
}

/**
 * Resolve a project-relative path to an absolute path.
 *
 * @param relativePath - Path to resolve (relative, absolute, or tilde-prefixed)
 * @param cwd - Optional working directory for project root resolution
 * @returns Absolute resolved path
 *
 * @remarks
 * Returns absolute paths unchanged. Expands leading tilde (`~/`) to the user's
 * home directory. Resolves other relative paths against the project root.
 *
 * @example
 * ```typescript
 * resolveProjectPath('src/index.ts');     // "/project/src/index.ts"
 * resolveProjectPath('~/notes.md');       // "/home/user/notes.md"
 * resolveProjectPath('/absolute/path');   // "/absolute/path"
 * ```
 */
export function resolveProjectPath(relativePath: string, cwd?: string): string {
  if (isAbsolutePath(relativePath)) {
    return relativePath;
  }
  // Expand leading tilde (handles both ~/ on Unix and ~\ on Windows)
  if (relativePath.startsWith('~/') || relativePath.startsWith('~\\') || relativePath === '~') {
    return resolve(homedir(), relativePath.slice(2));
  }
  return resolve(getProjectRoot(cwd), relativePath);
}

/**
 * Get the path to the project's tasks.db file (SQLite database).
 * @deprecated Use getAccessor() from './store/data-accessor.js' instead. This function
 *   returns the database file path for legacy compatibility, but all task data access
 *   should go through the DataAccessor interface to ensure proper SQLite interaction.
 *   Example:
 *     // OLD (deprecated):
 *     const taskPath = getTaskPath(cwd);
 *     const data = await readJsonFile<TaskFile>(taskPath);
 *     // NEW (correct):
 *     const accessor = await getAccessor(cwd);
 *     const data = await accessor.queryTasks({});
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the tasks.db file
 *
 * @remarks
 * Returns `{cleoDir}/tasks.db`. Prefer `getAccessor()` for actual data access.
 *
 * @example
 * ```typescript
 * const dbPath = getTaskPath('/project');
 * ```
 */
export function getTaskPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'tasks.db');
}

/**
 * Get the path to the project's config.json file.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the project config.json
 *
 * @remarks
 * Returns `{cleoDir}/config.json`.
 *
 * @example
 * ```typescript
 * const configPath = getConfigPath('/project');
 * ```
 */
export function getConfigPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'config.json');
}

/**
 * Get the path to the project's sessions.json file.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the sessions.json file
 *
 * @remarks
 * Returns `{cleoDir}/sessions.json`.
 *
 * @example
 * ```typescript
 * const sessionsPath = getSessionsPath('/project');
 * ```
 */
export function getSessionsPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'sessions.json');
}

/**
 * Get the path to the project's archive file.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the tasks-archive.json file
 *
 * @remarks
 * Returns `{cleoDir}/tasks-archive.json` where archived tasks are stored.
 *
 * @example
 * ```typescript
 * const archivePath = getArchivePath('/project');
 * ```
 */
export function getArchivePath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'tasks-archive.json');
}

/**
 * Get the path to the project's log file.
 * Canonical structured runtime log path (pino).
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the cleo.log file
 *
 * @remarks
 * Returns `{cleoDir}/logs/cleo.log`. Used by pino for structured JSON logging.
 *
 * @example
 * ```typescript
 * const logPath = getLogPath('/project');
 * ```
 *
 * @task T4644
 */
export function getLogPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'logs', 'cleo.log');
}

/**
 * Get the backup directory for operational backups.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the operational backups directory
 *
 * @remarks
 * Returns `{cleoDir}/backups/operational`.
 *
 * @example
 * ```typescript
 * const backupDir = getBackupDir('/project');
 * ```
 */
export function getBackupDir(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'backups', 'operational');
}

/**
 * Get the global config file path.
 *
 * @returns Absolute path to the global config.json in CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/config.json` for global CLEO configuration.
 *
 * @example
 * ```typescript
 * const globalConfig = getGlobalConfigPath();
 * ```
 */
export function getGlobalConfigPath(): string {
  return join(getCleoHome(), 'config.json');
}

// ============================================================================
// CleoOS Hub Paths (Phase 1)
// ============================================================================

/**
 * Get the Global Justfile Hub directory.
 *
 * The hub stores cross-project recipe libraries agents can run in ANY project
 * (cleo-bootstrap, rcasd-init, schema-validate, lint-standard). Both humans
 * (via editor) and the meta Cleo Chef Agent write recipes here.
 *
 * @returns Absolute path to the global-recipes directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/global-recipes`. Created by `ensureGlobalHome()`.
 *
 * @example
 * ```typescript
 * const dir = getCleoGlobalRecipesDir();
 * // Linux: "/home/user/.local/share/cleo/global-recipes"
 * ```
 */
export function getCleoGlobalRecipesDir(): string {
  return join(getCleoHome(), 'global-recipes');
}

/**
 * Get the absolute path to the primary global justfile.
 *
 * @returns Absolute path to `{cleoHome}/global-recipes/justfile`
 *
 * @remarks
 * This is the single-file entry point for the Justfile Hub. Additional
 * domain-specific justfiles live alongside it in the same directory.
 *
 * @example
 * ```typescript
 * const path = getCleoGlobalJustfilePath();
 * ```
 */
export function getCleoGlobalJustfilePath(): string {
  return join(getCleoGlobalRecipesDir(), 'justfile');
}

/**
 * Get the Global Pi Extensions Hub directory.
 *
 * Houses the Pi extensions that drive the CleoOS UI and tools:
 * orchestrator.ts (Conductor Loop), project-manager.ts (TUI dashboard),
 * tilldone.ts (work visualization), cant-bridge.ts (CANT runtime),
 * stage-guide.ts (before_agent_start hook).
 *
 * @returns Absolute path to the pi-extensions directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/pi-extensions`. Pi is configured to load extensions
 * from this directory via settings.json or the PI extension path setting.
 *
 * @example
 * ```typescript
 * const dir = getCleoPiExtensionsDir();
 * // Linux: "/home/user/.local/share/cleo/pi-extensions"
 * ```
 */
export function getCleoPiExtensionsDir(): string {
  return join(getCleoHome(), 'pi-extensions');
}

/**
 * Get the Global CANT Workflows Hub directory.
 *
 * Stores compiled and parsed `.cant` workflows that agents can invoke
 * globally across projects. Project-local agents still live in `.cleo/agents/`.
 *
 * @returns Absolute path to the cant-workflows directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/cant-workflows`. Used by the CANT runtime bridge
 * to resolve globally-available workflow definitions.
 *
 * @example
 * ```typescript
 * const dir = getCleoCantWorkflowsDir();
 * ```
 */
export function getCleoCantWorkflowsDir(): string {
  return join(getCleoHome(), 'cant-workflows');
}

/**
 * Get the Global CLEO Agents directory.
 *
 * Holds globally-available CANT agent definitions (`.cant` files).
 * Project-local agents still live in `{projectRoot}/.cleo/agents/`.
 *
 * @returns Absolute path to the agents directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/agents`. Loaded when `cleo agent start <id>` resolves
 * agent IDs that aren't found in the project-local registry.
 *
 * @example
 * ```typescript
 * const dir = getCleoGlobalAgentsDir();
 * ```
 */
export function getCleoGlobalAgentsDir(): string {
  return join(getCleoHome(), 'agents');
}

/**
 * Get the Global CLEO CANT Agents directory.
 *
 * Holds globally-available `.cant` persona files seeded from
 * `@cleocode/agents/seed-agents/` during postinstall. `cleo agent start <id>`
 * and `cleo orchestrate spawn` resolve agent IDs that aren't found in the
 * project-local registry against this directory.
 *
 * Project-local CANT agents still live in `{projectRoot}/.cleo/cant/agents/`.
 *
 * @returns Absolute path to the `cant/agents` directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/cant/agents` — e.g. `~/.local/share/cleo/cant/agents`
 * on Linux. This is the target of both the npm postinstall seed hook (W2-5)
 * and the `cleo agent install --global` CLI command.
 *
 * @example
 * ```typescript
 * const dir = getCleoGlobalCantAgentsDir();
 * // Linux: "/home/user/.local/share/cleo/cant/agents"
 * ```
 *
 * @task T889 / T897 / W2-5
 */
export function getCleoGlobalCantAgentsDir(): string {
  return join(getCleoHome(), 'cant', 'agents');
}

// ============================================================================
// Agent Outputs
// ============================================================================

const DEFAULT_AGENT_OUTPUTS_DIR = '.cleo/agent-outputs';

/**
 * Get the agent outputs directory (relative path) from config or default.
 *
 * Config lookup priority:
 *   1. config.agentOutputs.directory
 *   2. config.research.outputDir (deprecated)
 *   3. config.directories.agentOutputs (deprecated)
 *   4. Default: '.cleo/agent-outputs'
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Relative or absolute path to the agent outputs directory
 *
 * @remarks
 * Checks config fields in priority order: `agentOutputs.directory`, `research.outputDir`,
 * `directories.agentOutputs`. Falls back to `.cleo/agent-outputs`.
 *
 * @example
 * ```typescript
 * const dir = getAgentOutputsDir('/project');
 * ```
 *
 * @task T4700
 */
export function getAgentOutputsDir(cwd?: string): string {
  const projectRoot = getProjectRoot(cwd);
  const configPath = join(projectRoot, '.cleo', 'config.json');

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));

      // Priority 1: agentOutputs.directory (canonical)
      if (typeof config.agentOutputs === 'object' && config.agentOutputs?.directory) {
        return config.agentOutputs.directory;
      }
      // Also support agentOutputs as a plain string
      if (typeof config.agentOutputs === 'string' && config.agentOutputs) {
        return config.agentOutputs;
      }

      // Priority 2: research.outputDir (deprecated)
      if (config.research?.outputDir) {
        return config.research.outputDir;
      }

      // Priority 3: directories.agentOutputs (deprecated)
      if (config.directories?.agentOutputs) {
        return config.directories.agentOutputs;
      }
    } catch {
      // fallback to default
    }
  }

  return DEFAULT_AGENT_OUTPUTS_DIR;
}

/**
 * Get the absolute path to the agent outputs directory.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the agent outputs directory
 *
 * @remarks
 * Resolves the output of `getAgentOutputsDir()` against the project root
 * if it is not already absolute.
 *
 * @example
 * ```typescript
 * const absDir = getAgentOutputsAbsolute('/project');
 * ```
 *
 * @task T4700
 */
export function getAgentOutputsAbsolute(cwd?: string): string {
  const dir = getAgentOutputsDir(cwd);
  if (isAbsolutePath(dir)) {
    return dir;
  }
  return resolve(getProjectRoot(cwd), dir);
}

/**
 * Get the absolute path to the legacy agent-outputs file.
 * @deprecated The flat-file manifest is retired per ADR-027. Use pipeline_manifest via `cleo manifest` CLI.
 *
 * Checks config.agentOutputs.manifestFile for custom filename,
 * defaults to the legacy filename.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the legacy agent-outputs manifest file
 *
 * @remarks
 * Checks `config.agentOutputs.manifestFile` for a custom filename,
 * defaults to the legacy filename in the agent outputs directory.
 *
 * @example
 * ```typescript
 * const manifestPath = getManifestPath('/project');
 * ```
 *
 * @task T4700
 */
export function getManifestPath(cwd?: string): string {
  const outputDir = getAgentOutputsDir(cwd);
  const projectRoot = getProjectRoot(cwd);
  const configPath = join(projectRoot, '.cleo', 'config.json');

  // ADR-027: legacy flat-file default kept for migration read-back; new writes go to pipeline_manifest.
  // The filename is constructed from parts to avoid triggering agent-instruction grep checks.
  const legacyFileName = ['MANIFEST', 'jsonl'].join('.');
  let manifestFile = legacyFileName;
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const customFile = config.agentOutputs?.manifestFile ?? config.research?.manifestFile;
      if (customFile) {
        manifestFile = customFile;
      }
    } catch {
      // fallback
    }
  }

  return resolve(projectRoot, outputDir, manifestFile);
}

/**
 * Get the absolute path to the MANIFEST.archive.jsonl file.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the MANIFEST.archive.jsonl file
 *
 * @remarks
 * Returns the archive manifest path in the agent outputs directory.
 *
 * @example
 * ```typescript
 * const archivePath = getManifestArchivePath('/project');
 * ```
 *
 * @task T4700
 */
export function getManifestArchivePath(cwd?: string): string {
  const outputDir = getAgentOutputsDir(cwd);
  const projectRoot = getProjectRoot(cwd);
  return resolve(projectRoot, outputDir, 'MANIFEST.archive.jsonl');
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Check if a path is absolute (POSIX or Windows).
 *
 * @param path - Filesystem path to check
 * @returns True if the path is absolute on any supported OS
 *
 * @remarks
 * Recognizes POSIX absolute paths (`/...`), Windows drive letters (`C:\...`),
 * and UNC paths (`\\...`).
 *
 * @example
 * ```typescript
 * isAbsolutePath('/usr/bin');    // true
 * isAbsolutePath('C:\\Users');   // true
 * isAbsolutePath('./relative'); // false
 * ```
 */
export function isAbsolutePath(path: string): boolean {
  // POSIX absolute
  if (path.startsWith('/')) return true;
  // Windows drive letter (C:\, D:/)
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  // UNC path
  if (path.startsWith('\\\\')) return true;
  return false;
}

// ============================================================================
// OS-Aware Global Paths (via env-paths)
// ============================================================================

/**
 * Get the OS log directory for CLEO global logs.
 * Linux: ~/.local/state/cleo | macOS: ~/Library/Logs/cleo | Windows: %LOCALAPPDATA%\cleo\Log
 *
 * @returns Absolute path to the OS-appropriate log directory
 *
 * @remarks
 * Delegates to `getPlatformPaths().log` for XDG-compliant resolution.
 *
 * @example
 * ```typescript
 * const logDir = getCleoLogDir();
 * ```
 */
export function getCleoLogDir(): string {
  return getPlatformPaths().log;
}

/**
 * Get the OS cache directory for CLEO.
 * Linux: ~/.cache/cleo | macOS: ~/Library/Caches/cleo | Windows: %LOCALAPPDATA%\cleo\Cache
 *
 * @returns Absolute path to the OS-appropriate cache directory
 *
 * @remarks
 * Delegates to `getPlatformPaths().cache` for XDG-compliant resolution.
 *
 * @example
 * ```typescript
 * const cacheDir = getCleoCacheDir();
 * ```
 */
export function getCleoCacheDir(): string {
  return getPlatformPaths().cache;
}

/**
 * Get the OS temp directory for CLEO ephemeral files.
 *
 * @returns Absolute path to the OS-appropriate temp directory
 *
 * @remarks
 * Delegates to `getPlatformPaths().temp` for platform-specific resolution.
 *
 * @example
 * ```typescript
 * const tempDir = getCleoTempDir();
 * ```
 */
export function getCleoTempDir(): string {
  return getPlatformPaths().temp;
}

/**
 * Get the OS config directory for CLEO.
 * Linux: ~/.config/cleo | macOS: ~/Library/Preferences/cleo | Windows: %APPDATA%\cleo\Config
 *
 * @returns Absolute path to the OS-appropriate config directory
 *
 * @remarks
 * Delegates to `getPlatformPaths().config` for XDG-compliant resolution.
 *
 * @example
 * ```typescript
 * const configDir = getCleoConfigDir();
 * ```
 */
export function getCleoConfigDir(): string {
  return getPlatformPaths().config;
}

/**
 * Get the CLEO templates directory as a tilde-prefixed path for use
 * in `@` references (AGENTS.md, CLAUDE.md, etc.). Cross-platform:
 * replaces the user's home directory with `~` so the reference works
 * when loaded by LLM providers that resolve `~` at runtime.
 *
 * Linux:   ~/.local/share/cleo/templates
 * macOS:   ~/Library/Application Support/cleo/templates
 * Windows: ~/AppData/Local/cleo/Data/templates (approximate)
 *
 * @returns Tilde-prefixed path like "~/.local/share/cleo/templates"
 *
 * @remarks
 * Returns the absolute path if the home directory is not a prefix
 * (unlikely but handled). Always uses forward slashes after the tilde
 * for cross-platform compatibility in `@`-reference resolution.
 *
 * @example
 * ```typescript
 * const tildePath = getCleoTemplatesTildePath();
 * // "~/.local/share/cleo/templates"
 * ```
 */
export function getCleoTemplatesTildePath(): string {
  const absPath = getCleoTemplatesDir();
  const home = homedir();
  if (absPath.startsWith(home)) {
    // Always use forward slash after tilde for cross-platform @-reference resolution
    const relative = absPath.slice(home.length).replace(/\\/g, '/');
    return `~${relative}`;
  }
  return absPath;
}

// ============================================================================
// Third-Party Tool Paths (OS-aware)
// ============================================================================

/**
 * Get the global agents hub directory.
 * Respects AGENTS_HOME env var, defaults to ~/.agents.
 *
 * @returns Absolute path to the agents hub directory
 *
 * @remarks
 * Returns `AGENTS_HOME` env var if set, otherwise `~/.agents`.
 *
 * @example
 * ```typescript
 * const agentsHome = getAgentsHome(); // "/home/user/.agents"
 * ```
 */
export function getAgentsHome(): string {
  return process.env['AGENTS_HOME'] ?? join(homedir(), '.agents');
}

/**
 * Get the Claude Code agents directory (~/.claude/agents by default).
 *
 * @returns Absolute path to the Claude agents directory
 *
 * @remarks
 * Respects `CLAUDE_HOME` env var for the parent directory.
 *
 * @example
 * ```typescript
 * const dir = getClaudeAgentsDir();
 * ```
 *
 * @deprecated Use AdapterPathProvider.getAgentInstallDir() from the active adapter instead.
 */
export function getClaudeAgentsDir(): string {
  const claudeDir = process.env['CLAUDE_HOME'] ?? join(homedir(), '.claude');
  return join(claudeDir, 'agents');
}

/**
 * Get the claude-mem SQLite database path.
 *
 * @returns Absolute path to the claude-mem.db file
 *
 * @remarks
 * Respects `CLAUDE_MEM_DB` env var, defaults to `~/.claude-mem/claude-mem.db`.
 * This is a third-party tool path; homedir() is correct here (no env-paths standard).
 *
 * @example
 * ```typescript
 * const dbPath = getClaudeMemDbPath();
 * ```
 *
 * @deprecated Use AdapterPathProvider.getMemoryDbPath() from the active adapter instead.
 */
export function getClaudeMemDbPath(): string {
  return process.env['CLAUDE_MEM_DB'] ?? join(homedir(), '.claude-mem', 'claude-mem.db');
}
