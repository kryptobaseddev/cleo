/**
 * CLEO-bound platform path helpers.
 *
 * Pre-binds {@link createPlatformPathsResolver} to `(appName='cleo', homeEnvVar='CLEO_HOME')`
 * and exposes the cleo-specific helpers every other CLEO package needs:
 * `getCleoHome`, `getCleoPlatformPaths`, `getCleoSystemInfo`, and
 * `getCleoTemplatesTildePath`.
 *
 * @task T1883
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
// T11280: node:sqlite is loaded LAZILY (via createRequire below) rather than as
// an eager top-level value import. @cleocode/paths is imported transitively by
// core's sqlite.ts; an eager `node:sqlite` import here pulls the native binding
// in at module-load, defeating the lazy-init invariant proven by core's
// sqlite-lazy-init.test.ts (T1331). Only resolveCanonicalCleoDir's nexus-registry
// lookup actually opens a database.
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import {
  createPlatformPathsResolver,
  type PlatformPaths,
  type SystemInfo,
} from './platform-paths.js';
import { readPortableProjectId } from './portable-project-id.js';

const TEMPLATES_SUBDIR = 'templates';

/**
 * Returns the `node:sqlite` `DatabaseSync` constructor, loaded on first use.
 *
 * Loaded via `createRequire` so that importing this module does not eagerly pull
 * in `node:sqlite` — preserving the lazy-init invariant (T1331/T11280).
 *
 * @internal
 */
function getDatabaseSyncCtor(): new (
  ...args: ConstructorParameters<typeof DatabaseSyncType>
) => DatabaseSyncType {
  const _require = createRequire(import.meta.url);
  const mod = _require('node:sqlite') as {
    DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSyncType>) => DatabaseSyncType;
  };
  return mod.DatabaseSync;
}

const cleoResolver = createPlatformPathsResolver('cleo', 'CLEO_HOME', 'CLEO_CONFIG_HOME');

/**
 * Get OS-appropriate paths for CLEO's global directories.
 *
 * Linux:   `~/.local/share/cleo` | macOS: `~/Library/Application Support/cleo`
 * Windows: `%LOCALAPPDATA%\cleo\Data`
 *
 * The `CLEO_HOME` env var overrides the `data` field. Read fresh on every call.
 *
 * @public
 */
export function getCleoPlatformPaths(): PlatformPaths {
  return cleoResolver.getPlatformPaths();
}

/**
 * Get the absolute path to CLEO's global data directory.
 *
 * Equivalent to `getCleoPlatformPaths().data` — exposed as a stable named
 * helper because `getCleoHome()` is the most common consumer call.
 *
 * @public
 */
export function getCleoHome(): string {
  return cleoResolver.getPlatformPaths().data;
}

/**
 * Path of the persisted stable device id — `<cleoHome>/device-id`.
 *
 * Core's `getStableDeviceId()` creates it; `@cleocode/worktree` reads it to
 * decide whether a worktree lock holder's pid can be probed on this device
 * (T12506). One path, two readers.
 *
 * @returns Absolute path of the device-id file.
 *
 * @public
 * @task T12506
 */
export function resolveStableDeviceIdPath(): string {
  return join(getCleoHome(), 'device-id');
}

/**
 * Get a cached system information snapshot scoped to CLEO.
 *
 * Includes platform, architecture, hostname, Node version, and resolved
 * CLEO paths. Captured once per process and reused — invalidate via
 * {@link _resetCleoPlatformPathsCache} in tests if needed.
 *
 * @public
 */
export function getCleoSystemInfo(): SystemInfo {
  return cleoResolver.getSystemInfo();
}

/**
 * Get the CLEO templates directory as a tilde-prefixed path for use in
 * `@`-references (AGENTS.md, CLAUDE.md, etc.). Cross-platform: replaces
 * the user's home directory with `~` so the reference resolves consistently
 * when an LLM provider expands `~` at runtime.
 *
 * @returns Tilde-prefixed path like `"~/.local/share/cleo/templates"` on Linux
 *
 * @example
 * ```typescript
 * const ref = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
 * // "@~/.local/share/cleo/templates/CLEO-INJECTION.md"  (Linux)
 * ```
 *
 * @public
 */
export function getCleoTemplatesTildePath(): string {
  const cleoHome = getCleoHome();
  // Use posix-style join when the path uses forward slashes (e.g. test
  // overrides or Unix-style paths on any platform) to avoid converting
  // separators to backslashes on Windows.
  const absPath =
    cleoHome.includes('/') && !cleoHome.includes('\\')
      ? `${cleoHome}/${TEMPLATES_SUBDIR}`
      : join(cleoHome, TEMPLATES_SUBDIR);
  const home = homedir();
  if (absPath.startsWith(home)) {
    const relative = absPath.slice(home.length).replace(/\\/g, '/');
    return `~${relative}`;
  }
  return absPath;
}

/**
 * Get the CLEO templates directory as a stable tilde-prefixed path for use in
 * `@`-references written into shared files (e.g. `~/.agents/AGENTS.md`).
 *
 * Unlike {@link getCleoTemplatesTildePath}, this function is **immune to
 * `CLEO_HOME` overrides**. It derives the reference from `homedir()` alone
 * via the canonical `~/.cleo` symlink path, which is always stable regardless
 * of the current `CLEO_HOME` env var value.
 *
 * This is the correct function to use when writing a template reference into
 * a file that persists across sessions (e.g. the global `~/.agents/AGENTS.md`
 * hub). Using {@link getCleoTemplatesTildePath} there causes test environments
 * — which override `CLEO_HOME` to a temp directory — to write stale temp-path
 * blocks into the real AGENTS.md on every test run (T9020 / T1929).
 *
 * @returns `"~/.cleo/templates"` on all platforms — resolves via the `~/.cleo`
 *   symlink to the OS-appropriate canonical data directory at runtime.
 *
 * @example
 * ```typescript
 * const ref = `@${getCanonicalTemplatesTildePath()}/CLEO-INJECTION.md`;
 * // "@~/.cleo/templates/CLEO-INJECTION.md"
 * ```
 *
 * @public
 */
export function getCanonicalTemplatesTildePath(): string {
  // Always return the stable ~/.cleo symlink path. This symlink is created by
  // bootstrapGlobalCleo() and always points to the OS-appropriate canonical data
  // directory (e.g. ~/.local/share/cleo on Linux). Using this path here ensures
  // that CLEO_HOME overrides in test environments do NOT pollute shared files.
  return '~/.cleo/templates';
}

/**
 * Resolve the legacy `~/.cleo` directory, with optional explicit override.
 *
 * On a fully-bootstrapped install `~/.cleo` is a symlink to {@link getCleoHome}
 * (see `ensureCleoSymlink` in `@cleocode/core/bootstrap`), so writes through
 * this path land in the canonical OS-appropriate location. The override
 * argument takes precedence and is the standard wiring for CLI commands that
 * accept a `--cleo-dir` flag (`cleo daemon`, `cleo gc`, …).
 *
 * This helper centralizes the `args['--cleo-dir'] ?? join(homedir(), '.cleo')`
 * pattern that was previously duplicated across the CLI surface. Prefer
 * {@link getCleoHome} when you need the canonical (post-XDG) data directory
 * and there is no legacy-path or `--cleo-dir` override semantic.
 *
 * @param override - Explicit override (typically the `--cleo-dir` CLI arg)
 * @returns Absolute path to the resolved `.cleo` directory
 *
 * @example
 * ```typescript
 * // CLI handler
 * const cleoDir = resolveLegacyCleoDir(args['cleo-dir'] as string | undefined);
 * // Bootstrap migration probe
 * const legacyPath = resolveLegacyCleoDir();
 * ```
 *
 * @public
 */
export function resolveLegacyCleoDir(override?: string): string {
  if (override) return override;
  return join(homedir(), '.cleo');
}

/**
 * Result of {@link resolveProjectByCwd} — the project identity resolved
 * from walking up from a working directory.
 *
 * @public
 */
export interface ResolvedProject {
  /**
   * The project's portable identity (ADR-094, T12470): the tracked
   * `.cleo/project-id` when valid, otherwise the `projectId` recorded in
   * `.cleo/project-info.json`. Never derived from the path. Treat it as an
   * opaque string — ids of every historical shape (UUID, 12-hex, legacy) occur.
   */
  projectId: string;
  /** Absolute realpath to the project root directory. */
  projectRoot: string;
  /** The `projectId` recorded in `project-info.json`, if present. */
  legacyUUID?: string;
  /**
   * Which declaration supplied {@link ResolvedProject.projectId}. Optional so
   * callers that construct a `ResolvedProject` themselves keep compiling;
   * {@link resolveProjectByCwd} always sets it.
   */
  source?: DeclaredProjectIdentity['source'];
}

/**
 * A project identity declared by files inside `<root>/.cleo/` — the only
 * sources that may name a project (ADR-094, T12470).
 *
 * @public
 */
export interface DeclaredProjectIdentity {
  /** The opaque project id. */
  readonly projectId: string;
  /** `tracked` = `.cleo/project-id`; `project-info` = `.cleo/project-info.json`. */
  readonly source: 'tracked' | 'project-info';
  /** The `projectId` recorded in `project-info.json`, when that file has one. */
  readonly infoProjectId?: string;
}

/**
 * Read the `projectId` field from `<root>/.cleo/project-info.json`.
 * Returns `undefined` when the file is absent, unparseable or has no id.
 */
function _readProjectInfoId(projectRoot: string): string | undefined {
  try {
    const raw = readFileSync(join(projectRoot, '.cleo', 'project-info.json'), 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    return typeof data.projectId === 'string' && data.projectId.length > 0
      ? data.projectId
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the identity a project root DECLARES, in precedence order (T12470):
 *
 *   1. the tracked, write-once `.cleo/project-id` (ADR-094);
 *   2. the `projectId` in `.cleo/project-info.json`.
 *
 * A malformed tracked file is skipped here (it is reported by
 * `cleo doctor project-identity`) and never replaced by a derived value.
 * Nothing about the path — its spelling, realpath, git root or remote — takes
 * part: moving or re-cloning a project keeps its id.
 *
 * @param projectRoot - Directory containing `.cleo/`.
 * @returns The declared identity, or `null` when the root declares none.
 *
 * @example
 * ```ts
 * readDeclaredProjectIdentity('/repo'); // { projectId: 'c78d09c3a8ee', source: 'tracked' }
 * ```
 *
 * @public
 * @task T12470
 */
export function readDeclaredProjectIdentity(projectRoot: string): DeclaredProjectIdentity | null {
  const infoProjectId = _readProjectInfoId(projectRoot);
  const tracked = readPortableProjectId(projectRoot);
  if (tracked.status === 'valid') {
    return {
      projectId: tracked.projectId,
      source: 'tracked',
      ...(infoProjectId !== undefined && { infoProjectId }),
    };
  }
  if (infoProjectId !== undefined) {
    return { projectId: infoProjectId, source: 'project-info', infoProjectId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Path fingerprint (alias key only — never an identity, T12470)
// ---------------------------------------------------------------------------

/**
 * Synchronously find the git root for a given directory.
 * Returns `null` if the directory is not inside a git repo.
 */
function _findGitRootSync(fromPath: string): string | null {
  try {
    const stdout = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolve(fromPath),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return resolve(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Synchronously find the primary git remote URL (origin fetch URL).
 * Returns `null` when there are no remotes or git is unavailable.
 */
function _findGitRemoteUrlSync(fromPath: string): string | null {
  try {
    const stdout = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: resolve(fromPath),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const url = stdout.trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Read the project name from `.cleo/project-info.json` (if present).
 * Non-fatal on any I/O or parse error.
 */
function _readProjectInfoName(repoRoot: string): string | undefined {
  try {
    const raw = readFileSync(join(repoRoot, '.cleo', 'project-info.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Canonicalize a filesystem path across operating systems — resolve symlinks
 * and mount/alias divergence (macOS `/var` → `/private/var`, Windows
 * drive-letter case + 8.3 short names, Linux bind-mounts) via
 * {@link realpathSync}.
 *
 * Falls back to the lexically-resolved absolute path when the target does not
 * exist on disk, so identity/root computations never throw for a moved,
 * deleted, or not-yet-created project path.
 *
 * **SSoT:** this is the single path-canonicalization entry point for the CLEO
 * SDK. Never call `realpathSync` ad-hoc for path identity — route through here
 * so the OS-specific normalization stays consistent across every consumer and
 * test (notably the macOS `/var` vs `/private/var` split).
 *
 * @param p - A relative or absolute filesystem path.
 * @returns The realpath-canonicalized absolute path, or the lexically-resolved
 *   absolute path when the target does not exist.
 *
 * @public
 * @task T11023
 */
export function canonicalizePath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    // Target does not exist (moved / deleted / not-yet-created) — the
    // lexically-resolved absolute path is the best canonical form available.
    return resolved;
  }
}

/**
 * Compute the path-derived fingerprint `sha256(gitRoot|name|remote)[0:12]`.
 *
 * **Not an identity (T12470, supersedes the T9149/T11023 design).** A project
 * is identified only by its declared id ({@link readDeclaredProjectIdentity}).
 * This fingerprint survives solely as a LOOKUP KEY into
 * `nexus_project_id_aliases`, so ids that older CLEO versions derived from a
 * path keep resolving to the project that now owns them. Never return it as a
 * project id and never mint a registry row from it.
 *
 * @param repoPath - Absolute path to the project root.
 * @returns The 12-hex-char path fingerprint.
 *
 * @public
 * @task T12470
 */
export function computePathFingerprintId(repoPath: string): string {
  const realRepoPath = canonicalizePath(repoPath);

  const gitRoot = _findGitRootSync(realRepoPath);
  const effectiveRoot = gitRoot ?? realRepoPath;

  const remoteUrl = gitRoot ? _findGitRemoteUrlSync(gitRoot) : null;
  const projectName = _readProjectInfoName(effectiveRoot);

  const fingerprint = [effectiveRoot, projectName ?? '', remoteUrl ?? ''].join('|');
  return createHash('sha256').update(fingerprint).digest('hex').substring(0, 12);
}

/**
 * Former name of {@link computePathFingerprintId}.
 *
 * @deprecated T12470 — the value is a path fingerprint (alias key), not a
 * project id. Use {@link readDeclaredProjectIdentity} for identity and
 * {@link computePathFingerprintId} for alias lookups.
 */
export const computeCanonicalProjectId: (repoPath: string) => string = computePathFingerprintId;

/**
 * Compute the legacy base64url(path) ID for a given path.
 *
 * **Canonical source** for this function. `@cleocode/core` re-exports
 * from here via `nexus/identity.ts`. This is the old algorithm used
 * before T9149 W5: `Buffer.from(path).toString('base64url').slice(0, 32)`.
 */
export function legacyProjectId(repoPath: string): string {
  return Buffer.from(repoPath).toString('base64url').slice(0, 32);
}

/**
 * Walk up from `cwd` (or `process.cwd()`) to the nearest directory whose
 * `.cleo/` DECLARES a project identity, and return that identity.
 *
 * Resolution order at each level (T12470 · ADR-094): the tracked
 * `.cleo/project-id`, then `project-info.json`'s `projectId`. The returned
 * `projectId` is that declared id — never a hash of the path — so the same
 * project resolves to the same id from any absolute location, mount or device.
 * `projectRoot` is realpath-canonicalized (bind-mounts, macOS `/private/var`).
 *
 * A `.cleo/` that holds only the tracked id (no `project-info.json`) counts as
 * a project root only when the directory is a git toplevel (has `.git`), so a
 * monorepo subdirectory carrying a committed id does not shadow its parent.
 *
 * @param cwd - Optional working directory to start the ancestor walk from.
 *   Defaults to `process.cwd()`.
 * @returns The resolved project identity, or `null` if no ancestor declares one.
 *
 * @example
 * ```typescript
 * const project = resolveProjectByCwd('/repo/packages/core');
 * // { projectId: 'c78d09c3a8ee', projectRoot: '/repo', source: 'tracked' }
 *
 * const notFound = resolveProjectByCwd('/tmp/empty');
 * // null
 * ```
 *
 * @public
 * @task T11008
 * @task T12470
 */
export function resolveProjectByCwd(cwd?: string): ResolvedProject | null {
  const start = resolve(cwd ?? process.cwd());
  let current = start;

  while (true) {
    if (existsSync(join(current, '.cleo'))) {
      const declared = readDeclaredProjectIdentity(current);
      // A `.cleo/` holding ONLY a committed project-id (no project-info.json)
      // is a project root only at a git toplevel. Otherwise a monorepo
      // subdirectory that carries a committed id would shadow its parent.
      const trackedOnly = declared?.source === 'tracked' && declared.infoProjectId === undefined;
      if (declared !== null && (!trackedOnly || existsSync(join(current, '.git')))) {
        return {
          projectId: declared.projectId,
          projectRoot: canonicalizePath(current),
          ...(declared.infoProjectId !== undefined && { legacyUUID: declared.infoProjectId }),
          source: declared.source,
        };
      }
      // A `.cleo/` that declares nothing (corrupt / id-less project-info.json),
      // or only a tracked id below a git toplevel, keeps walking — a higher
      // ancestor may declare one.
    }

    const parent = dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  return null;
}

/**
 * Resolve the canonical `.cleo` directory for a project given its `projectId`.
 *
 * Looks up the project in the consolidated GLOBAL `cleo.db` registry
 * (`nexus_project_registry` table) to find the project's root path, then returns
 * the `.cleo/` directory under that root.
 *
 * **Post-E6 consolidation (T11569):** The cross-project registry moved from the
 * standalone `<cleoHome>/nexus.db` into the consolidated dual-scope
 * `<cleoHome>/cleo.db` (SG-DB-SUBSTRATE-V2 · E6-L4, T11524). On a fresh post-E6
 * install `nexus.db` is never created, so opening it here returned `null` and
 * the core wrapper threw `E_PROJECT_NOT_FOUND` even for registered projects (the
 * read path had diverged from the write path — same class as #909/T11562). This
 * resolver opens `cleo.db`.
 *
 * **COMPLETE-CUTOVER (T11578 · AC3):** The live runtime registry table is now the
 * PREFIXED consolidated `nexus_project_registry` (the consolidated cleo-global
 * migration owns it; the bare `project_registry` runtime shape is retired). The
 * runtime writers and this read path both target the prefixed table — the read
 * path no longer diverges from the write path.
 *
 * **Legacy ID support (T11023 AC4):** If the `projectId` is not found in
 * `nexus_project_registry`, also checks the `nexus_project_id_aliases` table for a
 * legacy→canonical mapping before returning `null`. The path-derived canonical
 * 12-hex id is recorded as an alias of the immutable registry id (T11281), so a
 * canonical id supplied by `resolveProjectByCwd` resolves through this fallback.
 *
 * This enables cross-project lookups: given a stable project ID, resolve where
 * that project lives on disk without walking from a working directory.
 *
 * @param projectId - The project ID to look up. Can be a canonical 12-hex-char
 *   ID, a legacy UUID, or a legacy base64url(path) ID.
 * @returns Absolute path to the `.cleo/` directory, or `null` if the
 *   projectId is not found in the consolidated registry (or its alias table).
 *
 * @task T11008
 * @task T11023
 * @task T11569
 */
export function resolveCanonicalCleoDir(projectId: string): string | null {
  const cleoHome = getCleoHome();
  // T11569: read the consolidated GLOBAL `cleo.db` (the registry moved out of
  // the now-gone `nexus.db` at E6-L4/T11524). T11578 · AC3: the PREFIXED
  // `nexus_project_registry` table inside `cleo.db` is the live runtime registry
  // SSoT.
  const globalDbPath = join(cleoHome, 'cleo.db');

  if (!existsSync(globalDbPath)) return null;

  let db: DatabaseSyncType | undefined;
  try {
    const DatabaseSync = getDatabaseSyncCtor();
    db = new DatabaseSync(globalDbPath, { readOnly: true }); // db-open-allowed: leaf path package cannot depend on core DB chokepoint

    // Try direct nexus_project_registry lookup first (T11578 · AC3).
    const directStmt = db.prepare(
      'SELECT project_path FROM nexus_project_registry WHERE project_id = ? LIMIT 1',
    );
    const directRow = directStmt.get(projectId) as { project_path: string } | undefined;

    if (
      directRow &&
      typeof directRow.project_path === 'string' &&
      directRow.project_path.length > 0
    ) {
      return join(directRow.project_path, '.cleo');
    }

    // T11023 AC4: Fall back to nexus_project_id_aliases for legacy ID resolution
    // (T11578 · AC3 prefixed table). Legacy base64url(path) IDs and old UUIDs are
    // mapped to canonical IDs in the aliases table. Try resolving the input as a
    // legacy ID first, then look up the canonical ID.
    try {
      const aliasStmt = db.prepare(
        'SELECT canonical_id FROM nexus_project_id_aliases WHERE legacy_id = ? LIMIT 1',
      );
      const aliasRow = aliasStmt.get(projectId) as { canonical_id: string } | undefined;

      if (
        aliasRow &&
        typeof aliasRow.canonical_id === 'string' &&
        aliasRow.canonical_id.length > 0
      ) {
        // Resolved a legacy alias — look up the canonical ID.
        const canonicalRow = directStmt.get(aliasRow.canonical_id) as
          | { project_path: string }
          | undefined;
        if (
          canonicalRow &&
          typeof canonicalRow.project_path === 'string' &&
          canonicalRow.project_path.length > 0
        ) {
          return join(canonicalRow.project_path, '.cleo');
        }
      }
    } catch {
      // nexus_project_id_aliases table may not exist yet (pre-migration) — non-fatal.
    }

    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort close
    }
  }
}

/**
 * Invalidate the cached CLEO system info snapshot. Use in tests after
 * mutating `CLEO_HOME` or related env vars.
 *
 * @internal
 */
export function _resetCleoPlatformPathsCache(): void {
  cleoResolver.resetCache();
}
