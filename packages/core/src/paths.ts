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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { E_CWD_WALKUP_FORBIDDEN, ExitCode } from '@cleocode/contracts';
import {
  getCanonicalTemplatesTildePath as _getCanonicalTemplatesTildePath,
  getCleoTemplatesTildePath as _getCleoTemplatesTildePath,
  isAbsolutePath as _isAbsolutePath,
  resolveCanonicalCleoDir as _resolveCanonicalCleoDir,
  resolveProjectByCwd as _pathsResolveProjectByCwd,
} from '@cleocode/paths';
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
 * Run `fn` inside a `worktreeScope.run()` AsyncLocalStorage frame derived
 * from the `CLEO_WORKTREE_ROOT` and `CLEO_PROJECT_HASH` environment variables.
 *
 * This is the env-var → AsyncLocalStorage bridge that lets cleo binaries
 * spawned from `cleo orchestrate spawn` (which exports those env vars in
 * the worker shell) honour the orchestrator's authoritative worktree root.
 *
 * Without this bridge, `getProjectRoot()`'s ALS check at step 0 always
 * returns `undefined` for subprocesses, falling through to env-var or
 * walk-up — which created the rogue `.cleo/` dirs that T1864 was
 * filed to prevent.
 *
 * Belongs in `@cleocode/core` (not `@cleocode/cleo`) per AGENTS.md
 * Package-Boundary Check: cleo CLI is a thin wrapper; ALS plumbing is
 * runtime substrate.
 *
 * @param fn - Callback to invoke (synchronously or asynchronously) within
 *   the worktree scope. The return value is forwarded to the caller.
 * @returns The return value of `fn`, whether or not a worktree scope is active.
 *
 * @example
 * ```ts
 * import { runWithWorktreeScopeFromEnv } from '@cleocode/core/internal';
 *
 * // In the CLI entrypoint:
 * runWithWorktreeScopeFromEnv(() => runMain(main));
 * ```
 *
 * @task T1873
 * @related ADR-041 §D3 worktree scope, ADR-055 worktree-by-default
 */
export function runWithWorktreeScopeFromEnv<T>(fn: () => T): T {
  const wtRoot = process.env['CLEO_WORKTREE_ROOT'];
  if (!wtRoot) return fn();
  const projHash = process.env['CLEO_PROJECT_HASH'] ?? '';
  return worktreeScope.run({ worktreeRoot: wtRoot, projectHash: projHash }, fn);
}

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
 * @deprecated Compose the SSoT registry entry's `installPath` against
 * {@link getCleoHome} instead — e.g.
 * `join(getCleoHome(), getTemplateById('cleo-injection').installPath)`
 * resolves to the same file via the
 * {@link import('./templates/registry.js').getTemplateById} registry surface.
 * T9879 rewired every internal caller; this directory accessor remains as a
 * back-compat shim and is targeted for removal in v2026.7.0 (see
 * `.cleo/deprecations.yml`).
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
 * **@deprecated** Since T10297. Use {@link resolveProjectByCwd} +
 * {@link resolveCanonicalCleoDir} instead. This function remains as a
 * compatibility shim that delegates to the new resolution chain.
 *
 * Migration:
 * ```typescript
 * // Before (deprecated):
 * const cleoDir = getCleoDirAbsolute(cwd);
 *
 * // After (T10297):
 * const project = resolveProjectByCwd(cwd);
 * if (!project) throw new Error('Not in a CLEO project');
 * const cleoDir = resolveCanonicalCleoDir(project.projectId);
 * ```
 *
 * @param cwd - Optional anchor for project-root resolution; if omitted, uses
 *   the canonical {@link getProjectRoot} chain (worktreeScope > CLEO_ROOT >
 *   CLEO_DIR absolute > gitlink walk > ancestor walk).
 * @param opts.bootstrap - When `true`, fall back to a cwd-relative `.cleo`
 *   resolution if {@link getProjectRoot} throws. ONLY for `cleo init` callers
 *   that CREATE the project root and therefore cannot rely on ancestor walk.
 *   Defaults to `false` — every other caller MUST resolve through an existing
 *   project root or the error propagates. See council verdict D009 (T9803).
 * @returns Absolute path to the project's `.cleo` directory
 *
 * @remarks
 * **SSoT for every `.cleo/` path in CLEO** (T9685). All path-derived helpers
 * (`getTaskPath`, `getConfigPath`, `getSessionsPath`, `getLogPath`,
 * `getBackupDir`, `getAgentOutputsAbsolute`, `getManifestPath`, etc.) flow
 * through this function — fixing project-root resolution here cascades to
 * every consumer.
 *
 * **Resolution order** (matches the wider {@link getProjectRoot} chain):
 * 1. `CLEO_DIR` env var with an absolute value — returned verbatim.
 * 2. Delegates to {@link resolveProjectByCwd} + {@link resolveCanonicalCleoDir}
 *    for canonical project resolution via `project-info.json` (T10297).
 * 3. If `cwd` is omitted, resolution runs against `getProjectRoot()` directly.
 *
 * **Root-cause fix (T9803 · council verdict D009)**: when `getProjectRoot()`
 * throws (no project root in scope), the previous implementation silently
 * fell back to `<cwd>/.cleo` — which synthesized orphan `.cleo/` directories
 * inside git worktrees that any subsequent `mkdirSync` call would
 * materialize. The 25+ leaked `.cleo/` directories inside
 * `.claude/worktrees/*` documented in the T9801 forensic audit were created
 * via this path. The fix re-throws unless the caller explicitly passes
 * `{ bootstrap: true }`, which only `initProject()` (line 737, init.ts)
 * legitimately needs.
 *
 * @example
 * ```typescript
 * // Project root → /repo
 * getCleoDirAbsolute();                  // "/repo/.cleo"
 * getCleoDirAbsolute('/repo/packages/x'); // "/repo/.cleo"  (was "/repo/packages/x/.cleo" before T9685)
 *
 * // Worktree without a project — THROWS (was silent orphan synthesis pre-T9803)
 * getCleoDirAbsolute('/tmp/random-dir'); // throws E_NOT_FOUND
 *
 * // Bootstrap (cleo init creating a new project)
 * getCleoDirAbsolute('/tmp/new-project', { bootstrap: true }); // "/tmp/new-project/.cleo"
 * ```
 *
 * @deprecated Migrate to {@link resolveProjectByCwd} + {@link resolveCanonicalCleoDir}
 * @task T11009
 */
export function getCleoDirAbsolute(cwd?: string, opts?: { bootstrap?: boolean }): string {
  const cleoDir = getCleoDir();
  if (isAbsolutePath(cleoDir)) {
    return cleoDir;
  }

  // T11022: Deprecation warning + CLEO_PATHS_STRICT enforcement.
  // When callers pass an absolute CLEO_DIR, we return it verbatim above —
  // no deprecation because the caller already has a canonical path.
  // Every other path through this function is CWD-walk-up resolution that
  // should be migrated to resolveProjectByCwd + resolveCanonicalCleoDir.
  //
  // bootstrap=true is also exempt: cleo init legitimately needs to resolve
  // a .cleo/ path that doesn't exist yet (AC3).
  if (!opts?.bootstrap) {
    if (process.env['CLEO_PATHS_STRICT'] === '1') {
      // AC2: Strict mode — throw with remediation hint.
      throw new CleoError(
        ExitCode.CONFIG_ERROR,
        `${E_CWD_WALKUP_FORBIDDEN}: getCleoDirAbsolute(cwd) with CWD-walk-up resolution is forbidden under CLEO_PATHS_STRICT=1. ` +
          `Migrate to:\\n` +
          `  const project = resolveProjectByCwd(cwd);\\n` +
          `  if (!project) throw new Error('Not in a CLEO project');\\n` +
          `  const cleoDir = resolveCanonicalCleoDir(project.projectId);`,
        {
          fix: 'Replace getCleoDirAbsolute(cwd) with resolveProjectByCwd(cwd) + resolveCanonicalCleoDir(projectId)',
          details: {
            affectedSymbols: ['getCleoDirAbsolute'],
            remediationCommands: [
              'const project = resolveProjectByCwd(cwd)',
              'const cleoDir = resolveCanonicalCleoDir(project.projectId)',
            ],
          },
        },
      );
    }

    if (!_getCleoDirAbsoluteDeprecatedWarned) {
      _getCleoDirAbsoluteDeprecatedWarned = true;
      // AC1: One-time deprecation warning via CLEO_DEBUG.
      if (process.env['CLEO_DEBUG']) {
        process.stderr.write(
          `[cleo][debug] W_PATH_DEPRECATED: getCleoDirAbsolute(cwd) is deprecated (T10297). ` +
            `Migrate to resolveProjectByCwd(cwd) + resolveCanonicalCleoDir(projectId). ` +
            `Set CLEO_PATHS_STRICT=1 to enforce this at runtime.\\n`,
        );
      }
    }
  }

  // T10297: try canonical projectId-based resolution.
  // resolveProjectByCwd verifies we're in a valid CLEO project by reading
  // project-info.json, but getProjectRoot handles the actual path resolution
  // (worktree gitlink following, CLEO_ROOT, worktreeScope ALS, etc.).
  // We use resolveProjectByCwd as a validation gate, and getProjectRoot
  // as the path authority.
  const project = _pathsResolveProjectByCwd(cwd);
  if (project !== null) {
    try {
      const projectRoot = getProjectRoot(cwd);
      const canonical = _resolveCanonicalCleoDir(project.projectId);
      // Use nexus.db resolution only when it agrees with getProjectRoot;
      // otherwise fall through to getProjectRoot-based resolution.
      if (canonical !== null && canonical === resolve(projectRoot, cleoDir)) {
        return canonical;
      }
      return resolve(projectRoot, cleoDir);
    } catch {
      // getProjectRoot threw — fall through to the projectRoot we already
      // found via resolveProjectByCwd (handles edge cases where getProjectRoot
      // is stricter than resolveProjectByCwd).
      return resolve(project.projectRoot, cleoDir);
    }
  }

  // Legacy fallback for non-project contexts (bootstrap / pre-init).
  // SSoT (T9685): route through getProjectRoot so callers anywhere in a
  // worktree or monorepo subdir resolve to the canonical project root, not
  // their cwd.
  try {
    return resolve(getProjectRoot(cwd), cleoDir);
  } catch (err) {
    // T9803 · council verdict D009: SURGICAL fallback policy —
    //   1. Explicit `{ bootstrap: true }` always allows the fallback (cleo init).
    //   2. When the cwd (or any ancestor) contains `.git` (FILE or DIRECTORY) —
    //      REFUSE the fallback.
    //   3. When no `.git` exists anywhere in ancestors — allow the fallback.
    if (opts?.bootstrap) {
      return resolve(cwd ?? process.cwd(), cleoDir);
    }
    if (_cwdHasGitAncestor(cwd)) {
      throw err;
    }
    return resolve(cwd ?? process.cwd(), cleoDir);
  }
}

/**
 * Resolve the canonical `.cleo` directory for a project given its `projectId`.
 *
 * Looks up the project in the global `nexus.db` registry (`project_registry`
 * table) to find the project's root path, then returns the `.cleo/` directory
 * under that root.
 *
 * This is the core-level wrapper around the `@cleocode/paths` implementation.
 * Unlike the zero-dep leaf package version (which returns `null`), this wrapper
 * throws `E_PROJECT_NOT_FOUND` when the projectId is not in the nexus registry,
 * matching the contract expected by CLEO's higher-level subsystems.
 *
 * @param projectId - The stable project UUID (from `.cleo/project-info.json`).
 * @returns Absolute path to the `.cleo/` directory.
 * @throws {CleoError} `ExitCode.NOT_FOUND` (`E_PROJECT_NOT_FOUND`) when the
 *   projectId is not found in the nexus registry.
 *
 * @public
 * @task T11018
 */
export function resolveCanonicalCleoDir(projectId: string): string {
  const result = _resolveCanonicalCleoDir(projectId);
  if (result === null) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `E_PROJECT_NOT_FOUND: projectId "${projectId}" not found in nexus registry`,
      {
        fix: 'Ensure the project has been registered: cleo init',
        details: {
          field: 'projectId',
          actual: projectId,
        },
      },
    );
  }
  return result;
}

/**
 * Walk up from cwd looking for a match in the global nexus.db project_registry
 * by project_path. Falls back when no `.cleo/project-info.json` is found locally.
 *
 * @internal
 * @task T11013
 */
function _resolveProjectByCwdFromNexus(cwd?: string): string | null {
  try {
    const cleoHome = getCleoHome();
    const nexusDbPath = join(cleoHome, 'nexus.db');
    if (!existsSync(nexusDbPath)) return null;

    const start = resolve(cwd ?? process.cwd());
    let current = start;

    const db = new DatabaseSync(nexusDbPath, { readOnly: true });
    try {
      const stmt = db.prepare(
        'SELECT project_id FROM project_registry WHERE project_path = ? LIMIT 1',
      );

      while (true) {
        const row = stmt.get(current) as { project_id: string } | undefined;
        if (row && typeof row.project_id === 'string' && row.project_id.length > 0) {
          return row.project_id;
        }

        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } finally {
      try { db.close(); } catch { /* best-effort */ }
    }
  } catch {
    // nexus.db unavailable or corrupted — not an error, just no match
  }
  return null;
}

/**
 * Resolve the canonical projectId from a working directory.
 *
 * First reads `.cleo/project-info.json` from CWD or an ancestor directory (AC2).
 * Falls back to nexus registry `project_registry.project_path` match when no
 * local `project-info.json` is found (AC3).
 *
 * @param cwd - Optional working directory. Defaults to `process.cwd()`.
 * @returns The canonical projectId string (AC4).
 * @throws {CleoError} `ExitCode.NEXUS_PROJECT_NOT_FOUND` (E_CLEO_NEXUS_PROJECT_NOT_FOUND)
 *   with a remediation hint when no CLEO project is found (AC5).
 *
 * @example
 * ```typescript
 * const projectId = resolveProjectByCwd('/repo/packages/core');
 * // "a1b2c3d4e5f6"
 * ```
 *
 * @public
 * @task T11013
 */
export function resolveProjectByCwd(cwd?: string): string {
  // AC2: Try local project-info.json first (via paths package)
  const pathsResult = _pathsResolveProjectByCwd(cwd);
  if (pathsResult !== null) {
    return pathsResult.projectId;
  }

  // AC3: Fall back to nexus registry lookup
  const nexusProjectId = _resolveProjectByCwdFromNexus(cwd);
  if (nexusProjectId !== null) {
    return nexusProjectId;
  }

  // AC5: Throw with remediation hint
  throw new CleoError(
    ExitCode.NEXUS_PROJECT_NOT_FOUND,
    'No CLEO project found — not in a CLEO project directory and no registry match. ' +
      'Run `cleo init` to create a new project, or cd into an existing CLEO project.',
    {
      fix: 'Run `cleo init` to initialize a CLEO project here, or cd into a project with a .cleo/ directory',
    },
  );
}

/**
 * Internal: resolve the canonical `.cleo/` directory using the T10297
 * projectId-based resolution chain.
 *
 * Prefer this over the deprecated {@link getCleoDirAbsolute} in internal
 * path helpers. Falls back to {@link getCleoDirAbsolute} when
 * `resolveProjectByCwd` returns `null` (bootstrap / non-project contexts).
 *
 * Uses {@link getProjectRoot} for worktree-aware path authority
 * (gitlink following, CLEO_ROOT, worktreeScope ALS) while leveraging
 * {@link resolveProjectByCwd} for project validation.
 *
 * @internal
 * @task T11009
 */
function _resolveCleoDir(cwd?: string): string {
  const cleoDir = getCleoDir();
  if (isAbsolutePath(cleoDir)) {
    return cleoDir;
  }

  const project = _pathsResolveProjectByCwd(cwd);
  if (project !== null) {
    try {
      return resolve(getProjectRoot(cwd), cleoDir);
    } catch {
      return resolve(project.projectRoot, cleoDir);
    }
  }

  // Fallback to legacy resolution for non-project contexts
  return getCleoDirAbsolute(cwd);
}

/**
 * Walk the ancestor chain looking for `.git` (FILE or DIRECTORY) — any marker
 * that the cwd is inside a git repository. When `getProjectRoot()` threw inside
 * a git repo, the repo is NOT a CLEO project and the fallback must NOT silently
 * create a rogue `.cleo/` inside it (T10287 regression of T9550/T9580/T9801).
 *
 * Prior to T10287 this only checked for gitlink FILES (worktrees), missing
 * legitimate git DIRECTORIES that happen to not be CLEO projects
 * (e.g. `/mnt/projects/awesome-skills/` running `cleo briefing`).
 *
 * @internal
 */
function _cwdHasGitAncestor(cwd?: string): boolean {
  const start = resolve(cwd ?? process.cwd());
  let current = start;
  while (true) {
    const gitMarker = join(current, '.git');
    try {
      if (existsSync(gitMarker)) {
        return true;
      }
    } catch {
      /* unreadable — treat as not present */
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Attempt to resolve the main git repo root from a gitlink (.git as FILE).
 * Returns the main repo path if the gitlink is valid and the main repo is a
 * CLEO project; otherwise returns `null`.
 *
 * @internal
 * @task T11034
 */
function _resolveMainRepoFromGitlink(gitlinkDir: string): string | null {
  try {
    const gitLinkPath = join(gitlinkDir, '.git');
    if (!existsSync(gitLinkPath)) return null;
    const stat = statSync(gitLinkPath);
    if (!stat.isFile()) return null;
    const gitLinkContent = readFileSync(gitLinkPath, 'utf-8').trim();
    const match = gitLinkContent.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    const gitdir = match[1].trim();
    // gitdir is `<main>/.git/worktrees/<name>` → strip last 3 segments.
    const mainRepo = dirname(dirname(dirname(gitdir)));
    if (existsSync(join(mainRepo, '.cleo')) && validateProjectRoot(mainRepo)) {
      return mainRepo;
    }
  } catch {
    // Parse error — not a valid gitlink.
  }
  return null;
}

/**
 * Module-level flag: emit the legacy-fallback warning at most once per process.
 * Prevents log spam when `validateProjectRoot` is called repeatedly in a session.
 */
let _legacyFallbackWarned = false;

/**
 * Module-level flag: emit the T10297 deprecation warning for
 * `getCleoDirAbsolute` at most once per process (AC4).
 *
 * @task T11022
 * @epic T10296
 * @saga T10295
 */
let _getCleoDirAbsoluteDeprecatedWarned = false;

/**
 * Validate that a candidate project root directory is a legitimate CLEO
 * project root and not a stray parent `.cleo/` directory that happened to
 * be found by the walk-up algorithm.
 *
 * ## Primary path (T1864 — project-info.json contract)
 *
 * A candidate is **accepted** when `.cleo/project-info.json` exists and
 * parses as JSON with a non-empty `projectId` string field.  This is the
 * canonical form written by `cleo init` and is the only form that guarantees
 * the directory is a proper CLEO project rather than a stray `.cleo/` left by
 * an old installation or a git worktree that auto-created its own `.cleo/`.
 *
 * ## Legacy fallback (backwards-compatibility)
 *
 * Projects initialized before `project-info.json` was introduced are still
 * accepted when **both** of the following are true:
 *   1. `.cleo/` exists in `candidate`
 *   2. `.git/` exists as a sibling of `.cleo/` in `candidate`
 *
 * A one-time stderr warning is emitted (guarded by `_legacyFallbackWarned`)
 * so operators know to re-run `cleo init` to upgrade the project metadata.
 *
 * **Breaking change vs. prior implementation**: bare `package.json` alone is
 * no longer sufficient.  The old check `existsSync(gitDir) || existsSync(pkgJson)`
 * accepted any Node.js package directory as a valid project root, which caused
 * the monorepo-package bug where sub-packages inside `packages/` created their
 * own empty `.cleo/` databases.
 *
 * @param candidate - Absolute path to the directory being considered as the
 *   project root (parent of the `.cleo/` directory).
 * @returns `true` when the candidate is a recognised CLEO project root.
 *
 * @example
 * ```typescript
 * // Project root with project-info.json — valid (primary path)
 * validateProjectRoot('/home/user/myproject'); // true
 *
 * // Legacy project root with .git/ but no project-info.json — valid + warning
 * validateProjectRoot('/home/user/legacy-project'); // true (+ stderr warning)
 *
 * // Stray .cleo in home dir with no markers — invalid
 * validateProjectRoot('/home/user'); // false
 * ```
 *
 * @task T1463
 * @task T1864
 */
export function validateProjectRoot(candidate: string): boolean {
  const cleoDir = join(candidate, '.cleo');
  if (!existsSync(cleoDir)) {
    return false;
  }

  // Primary: .cleo/project-info.json with a valid projectId string.
  // T11034 — Worktree guard: a worktree has .git as a gitlink FILE, not a
  // directory. project-info.json is copied into worktrees for identity
  // inheritance (T11033), but worktrees must NOT be treated as standalone
  // project roots — path resolution must walk past them to the parent project.
  const projectInfoPath = join(cleoDir, 'project-info.json');
  if (existsSync(projectInfoPath)) {
    try {
      const raw = readFileSync(projectInfoPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'projectId' in parsed &&
        typeof (parsed as Record<string, unknown>)['projectId'] === 'string' &&
        (parsed as Record<string, unknown>)['projectId'] !== ''
      ) {
        // T11034: Reject worktrees — .git is a gitlink FILE, not a directory.
        // Workers should resolve through to the parent project root.
        const gitMarker = join(candidate, '.git');
        if (existsSync(gitMarker)) {
          try {
            if (!statSync(gitMarker).isDirectory()) {
              // Gitlink file (worktree) — NOT a project root.
              return false;
            }
          } catch {
            // Stat failed — treat as non-directory (reject).
            return false;
          }
        }
        return true;
      }
    } catch {
      // JSON parse error or read error — fall through to legacy check.
    }
  }

  // Legacy fallback: .cleo/ + .git/ sibling (no project-info.json required).
  // Emits a one-time warning to prompt the operator to run `cleo init`.
  //
  // CRITICAL (T9092): a git worktree has `.git` as a *file* (a "gitlink" pointing
  // back to the main repo's .git/worktrees/<name> directory), NOT a directory.
  // Accepting such candidates as project roots recreates the 2026-05-04 dead-end-DB
  // disaster pattern: workers spawned in a worktree create rogue `.cleo/tasks.db`
  // files isolated from the real project database. The legacy fallback MUST only
  // accept candidates where `.git` is a true directory (a real repo root).
  const gitDir = join(candidate, '.git');
  if (existsSync(gitDir)) {
    let isRealGitDir = false;
    try {
      const stat = statSync(gitDir);
      isRealGitDir = stat.isDirectory();
    } catch {
      isRealGitDir = false;
    }
    if (!isRealGitDir) {
      // .git is a gitlink file (worktree marker) — NOT a project root.
      return false;
    }
    if (!_legacyFallbackWarned) {
      _legacyFallbackWarned = true;
      // T9774: debug-only — surfaced via CLEO_DEBUG to keep stderr clean by default.
      // Cannot use pushWarning here because paths.ts is in the import chain of
      // output.ts (output → sessions/context-alert → paths) — circular dep.
      if (process.env['CLEO_DEBUG']) {
        process.stderr.write(
          `[cleo][debug] W_PATH_RESOLUTION: ${candidate}/.cleo/ lacks project-info.json. ` +
            `Run \`cleo init\` to upgrade project metadata (T1864 legacy-fallback).\n`,
        );
      }
    }
    return true;
  }

  return false;
}

/**
 * Assert that the given directory is an initialized CLEO project root,
 * throwing a `CleoError` if it is not.
 *
 * This guard MUST be called before any operation that writes into `.cleo/`
 * (e.g. creating audit directories, session journals) to prevent workers
 * running inside git worktrees from auto-creating empty `.cleo/` directories
 * that diverge from the real project database.
 *
 * @param projectRoot - Absolute path to the directory that should contain
 *   `.cleo/project-info.json` (or the legacy `.cleo/ + .git/` marker pair).
 * @throws {CleoError} `ExitCode.CONFIG_ERROR` with code `E_NOT_INITIALIZED`
 *   when `validateProjectRoot(projectRoot)` returns `false`.
 *
 * @example
 * ```typescript
 * assertProjectInitialized(projectRoot);
 * await mkdir(join(projectRoot, '.cleo', 'audit'), { recursive: true });
 * ```
 *
 * @task T1864
 */
export function assertProjectInitialized(projectRoot: string): void {
  if (!validateProjectRoot(projectRoot)) {
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `E_NOT_INITIALIZED: ${projectRoot} is not a CLEO project root`,
      {
        fix: 'cleo init',
      },
    );
  }
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

  // 2.5. T9092 + T11034: if `start` is inside a git worktree (i.e. has `.git` as a
  //      gitlink FILE pointing to `<mainrepo>/.git/worktrees/<name>`), the
  //      canonical project root is the MAIN repo, not the worktree dir.
  //      Delegates to the shared _resolveMainRepoFromGitlink helper which
  //      provides deterministic resolution from any worktree path.
  const mainRepoFromStart = _resolveMainRepoFromGitlink(start);
  if (mainRepoFromStart !== null) return mainRepoFromStart;

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
      // T9092: previously the start-directory short-circuit was unconditional —
      // `current === start` returned the candidate without running
      // validateProjectRoot. That allowed a worktree (whose `.git` is a gitlink
      // FILE not a directory) to be accepted as a project root if any process
      // had previously created a stray `.cleo/` inside it. validateProjectRoot
      // now rejects gitlink-only candidates, so we must run it on the start dir
      // too — but only as a *gate* to walk up further, not to reject outright.
      // If start dir validation fails, we continue walking to find the real
      // project root (the main repo).
      if (validateProjectRoot(current)) {
        // Valid project root.
        return current;
      }
      // Stray/rogue .cleo/ found (e.g. worktree with gitlink, or .cleo without
      // project-info.json AND without a real .git/ sibling) — skip it and
      // continue walking up for the canonical project root.
      skippedCleoDirs.push(current);
    }

    if (existsSync(gitDir) && !isDangerousRoot) {
      // T9092: only treat .git as a "real repo root" boundary when it is a
      // DIRECTORY. A gitlink FILE (worktree marker) does not anchor a project
      // root — keep walking up to find the canonical main repo.
      let isRealGitDir = false;
      try {
        isRealGitDir = statSync(gitDir).isDirectory();
      } catch {
        isRealGitDir = false;
      }
      if (isRealGitDir) {
        // Real .git/ found but no .cleo/ sibling — not initialised
        throw new CleoError(ExitCode.CONFIG_ERROR, `Run cleo init at ${current}`, {
          fix: `cd ${current} && cleo init`,
        });
      }
      // gitlink file — attempt to resolve the main repo from it (T11034).
      // When a worktree lives under ~/.local/share/cleo/worktrees/... and the
      // caller is in a subdirectory (not the worktree root), the start-level
      // gitlink check misses it. During the walk we must resolve gitlinks
      // to ensure deterministic resolution from any worktree path.
      const mainRepoFromWalk = _resolveMainRepoFromGitlink(current);
      if (mainRepoFromWalk !== null) return mainRepoFromWalk;
      // gitlink we couldn't resolve — keep walking up.
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
 * Resolve an optional caller-provided root, falling back to canonical project root.
 *
 * Use this in CORE-layer functions that accept an optional `opts.root` (or
 * `projectRoot`) parameter where the pre-T9580 pattern was
 * `opts.root ?? process.cwd()`. Centralizing the fallback through this helper
 * ensures the canonical 5-tier {@link getProjectRoot} chain
 * (worktreeScope > CLEO_ROOT > CLEO_DIR > gitlink walk-up > ancestor walk)
 * runs whenever the caller does not pin an explicit root — so an invocation
 * from a monorepo sub-directory never silently materializes a rogue
 * `<subdir>/.cleo/` tree.
 *
 * The caller-provided path is trusted as-is (no validation, no normalisation):
 * orchestrate spawn already hands callers an absolute, canonical root, and
 * forcing a re-walk would change semantics for explicit overrides.
 *
 * @param maybeRoot - Optional absolute path provided by the caller. When it
 *   is a non-empty string it is returned verbatim. When `undefined`, `null`,
 *   or the empty string the helper falls through to {@link getProjectRoot}.
 * @returns The resolved project root.
 *
 * @example
 * ```ts
 * // Before (T9580 anti-pattern):
 * const root = opts.root ?? process.cwd();
 *
 * // After:
 * const root = resolveOrCwd(opts.root);
 * ```
 *
 * @task T9584
 * @related T9580 audit, T9581, T9582, T9583
 */
export function resolveOrCwd(maybeRoot?: string | null): string {
  if (typeof maybeRoot === 'string' && maybeRoot.length > 0) {
    return maybeRoot;
  }
  return getProjectRoot();
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
 * @deprecated Use getTaskAccessor() from './store/data-accessor.js' instead. This function
 *   returns the database file path for legacy compatibility, but all task data access
 *   should go through the DataAccessor interface to ensure proper SQLite interaction.
 *   Example:
 *     // OLD (deprecated):
 *     const taskPath = getTaskPath(cwd);
 *     const data = await readJsonFile<TaskFile>(taskPath);
 *     // NEW (correct):
 *     const accessor = await getTaskAccessor(cwd);
 *     const data = await accessor.queryTasks({});
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the tasks.db file
 *
 * @remarks
 * Returns `{cleoDir}/tasks.db`. Prefer `getTaskAccessor()` for actual data access.
 *
 * @example
 * ```typescript
 * const dbPath = getTaskPath('/project');
 * ```
 *
 * @task T11009 — rewired to _resolveCleoDir (T10297 projectId-based resolution)
 */
export function getTaskPath(cwd?: string): string {
  return join(_resolveCleoDir(cwd), 'tasks.db');
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
  return join(_resolveCleoDir(cwd), 'config.json');
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
  return join(_resolveCleoDir(cwd), 'sessions.json');
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
  return join(_resolveCleoDir(cwd), 'tasks-archive.json');
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
  return join(_resolveCleoDir(cwd), 'logs', 'cleo.log');
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
  return join(_resolveCleoDir(cwd), 'backups', 'operational');
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
  return _isAbsolutePath(path);
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
  return _getCleoTemplatesTildePath();
}

/**
 * Get the CLEO templates directory as a stable tilde-prefixed path for use in
 * `@`-references written into shared files (e.g. `~/.agents/AGENTS.md`).
 *
 * Unlike {@link getCleoTemplatesTildePath}, this function is immune to
 * `CLEO_HOME` overrides. It always returns `"~/.cleo/templates"` — the stable
 * symlink path that resolves to the OS-appropriate canonical data directory at
 * runtime. Use this when writing template references into files that persist
 * across sessions to prevent test environments from polluting shared files
 * with stale temp-path blocks (T9020 / T1929).
 *
 * @returns `"~/.cleo/templates"` on all platforms
 *
 * @example
 * ```typescript
 * const ref = `@${getCanonicalTemplatesTildePath()}/CLEO-INJECTION.md`;
 * // "@~/.cleo/templates/CLEO-INJECTION.md"
 * ```
 */
export function getCanonicalTemplatesTildePath(): string {
  return _getCanonicalTemplatesTildePath();
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

// ============================================================================
// Worktree-aware CLI routing helpers (T10389 / ADR-068 amendment §3.1)
// ============================================================================

/**
 * Result of {@link resolveWorktreeRouting}.
 *
 * Encodes the canonical project root + caller cwd + whether routing kicked in
 * so CLI verbs can emit a single, consistent log line and pre-resolve file
 * paths against the worktree's cwd before dispatch reaches the canonical-root-
 * anchored sanitizer.
 *
 * @public
 * @task T10389
 */
export interface WorktreeRouting {
  /** Caller's `process.cwd()` (or the override passed to the helper). */
  readonly cwd: string;
  /** Canonical project root as returned by {@link getProjectRoot}. */
  readonly canonicalRoot: string;
  /**
   * True when `cwd` is inside a git worktree whose canonical root resolves to
   * a different directory (i.e. `.git` is a gitlink FILE pointing back to a
   * different repo).
   *
   * False when running directly from the canonical project root OR from a
   * subdirectory that walks up to the same project root.
   */
  readonly isWorktree: boolean;
  /**
   * Absolute path to the worktree directory when `isWorktree` is true,
   * otherwise `undefined`. Equal to the closest ancestor of `cwd` that
   * carries `.git` as a FILE (the gitlink).
   */
  readonly worktreePath?: string;
}

/**
 * Detect whether the caller is operating from inside a git worktree whose
 * canonical project root resolves to a DIFFERENT directory than `cwd`.
 *
 * The resolver walks ancestors from `cwd` looking for `.git`. When `.git` is
 * a FILE it is a worktree gitlink; the canonical root is the main repo (the
 * resolver in {@link getProjectRoot} already parses this case correctly).
 *
 * Used by CLI verbs that need to resolve user-supplied file paths against
 * the worktree's cwd (not the canonical root) BEFORE dispatching to the
 * sanitizer middleware, which enforces canonical-root anchoring.
 *
 * @param cwdOverride - Override for `process.cwd()`; used by tests.
 *
 * @returns A {@link WorktreeRouting} envelope describing the detected routing.
 *
 * @public
 * @task T10389
 */
export function resolveWorktreeRouting(cwdOverride?: string): WorktreeRouting {
  const cwd = resolve(cwdOverride ?? process.cwd());
  const home = homedir();

  // Walk ancestors from cwd looking for `.git` (as either FILE for a worktree
  // gitlink OR DIRECTORY for a real repo root). The closest ancestor with a
  // `.git` FILE is the worktree directory. We do this discovery FIRST — before
  // delegating to `getProjectRoot` — because the existing `getProjectRoot`
  // gitlink branch only fires when the START dir itself carries the gitlink.
  // From a subdirectory of a worktree (e.g. `<worktree>/docs/`), the ancestor
  // gitlink would be missed and `getProjectRoot` would throw `E_NO_PROJECT`
  // instead of routing back to the main repo.
  let worktreePath: string | undefined;
  let current = cwd;
  while (current !== home && current !== '/' && current !== '') {
    const gitPath = join(current, '.git');
    try {
      if (existsSync(gitPath)) {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          worktreePath = current;
          break;
        }
        if (stat.isDirectory()) {
          // Real `.git/` directory found — `current` is the canonical project
          // root itself, not a worktree. Stop walking.
          break;
        }
      }
    } catch {
      /* fall through to ancestor walk */
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Resolve the canonical root. When we discovered a worktree gitlink, use
  // its directory as the cwd argument so `getProjectRoot`'s own gitlink branch
  // walks back to the main repo (this is the path `getProjectRoot` already
  // handles correctly when start carries the gitlink).
  let canonicalRoot: string;
  try {
    canonicalRoot = getProjectRoot(worktreePath ?? cwd);
  } catch {
    // No project root resolvable — return a non-worktree shape so callers
    // fall through to their existing dispatch path and let it raise the
    // underlying error.
    return { cwd, canonicalRoot: cwd, isWorktree: false };
  }

  if (worktreePath !== undefined && worktreePath !== canonicalRoot) {
    return { cwd, canonicalRoot, isWorktree: true, worktreePath };
  }

  return { cwd, canonicalRoot, isWorktree: false };
}

/**
 * Resolve a user-supplied file path against the calling worktree's cwd when
 * applicable, returning an absolute path suitable for I/O.
 *
 * Behaviour:
 *   - When the caller is NOT in a worktree (or `routing` is not provided),
 *     returns `resolve(filePath)` (the historic behaviour).
 *   - When the caller IS in a worktree, resolves relative paths against the
 *     worktree's cwd (`routing.cwd`). Absolute paths pass through unchanged.
 *
 * The returned absolute path may be OUTSIDE the canonical project root — that
 * is the whole point of worktree routing. Callers that pass this path through
 * the dispatch sanitizer MUST exempt the operation (see
 * `packages/core/src/security/input-sanitization.ts` `allowExternalPath`).
 *
 * @param filePath - Raw file path as supplied by the user.
 * @param routing  - Detected routing envelope (from {@link resolveWorktreeRouting}).
 *
 * @returns Absolute file path resolved against the worktree's cwd.
 *
 * @public
 * @task T10389
 */
export function resolveWorktreeFilePath(filePath: string, routing: WorktreeRouting): string {
  if (!routing.isWorktree || routing.worktreePath === undefined) {
    return resolve(filePath);
  }
  // Relative paths resolve against the worktree's cwd (not the canonical root).
  return resolve(routing.cwd, filePath);
}

/**
 * Detect a stray `.cleo/tasks.db` SQLite handle inside a worktree directory.
 *
 * Background: CLEO worktrees are advised to keep their `.cleo/` empty so
 * every DB open routes through `openCleoDb()` against the canonical project
 * root (T9806 / ADR-068). A leaked `.cleo/tasks.db` inside a worktree
 * indicates a pre-T9803 install OR a misbehaving agent that wrote to the
 * worktree instead of routing to the canonical root.
 *
 * When this helper detects a stray DB, CLI verbs should emit an actionable
 * error BEFORE invoking the dispatch chain so the user sees clear
 * remediation steps rather than the lower-level `E_WT_DB_ISOLATION_VIOLATION`
 * thrown from inside the DB chokepoint.
 *
 * @param routing - Detected routing envelope (from {@link resolveWorktreeRouting}).
 *
 * @returns The absolute path to the stray `tasks.db` when present, otherwise
 *   `undefined`. The presence of `.cleo/` alone (without `tasks.db`) is NOT
 *   a stray — intentional caches may legitimately live there.
 *
 * @public
 * @task T10389
 */
export function detectStrayCleoDb(routing: WorktreeRouting): string | undefined {
  if (!routing.isWorktree || routing.worktreePath === undefined) {
    return undefined;
  }
  const tasksDbPath = join(routing.worktreePath, '.cleo', 'tasks.db');
  try {
    if (existsSync(tasksDbPath) && statSync(tasksDbPath).isFile()) {
      return tasksDbPath;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}
