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
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createPlatformPathsResolver,
  type PlatformPaths,
  type SystemInfo,
} from './platform-paths.js';

const TEMPLATES_SUBDIR = 'templates';

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
  /** Canonical runtime project ID (12-hex-char SHA-256 of git-root|name|remote). */
  projectId: string;
  /** Absolute realpath to the project root directory. */
  projectRoot: string;
  /** The legacy UUID from project-info.json, if present. */
  legacyUUID?: string;
}

// ---------------------------------------------------------------------------
// Canonical project ID computation (T11023 — cross-mount divergence)
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
 * Compute the canonical project ID for a given repository path (T9149/T11023).
 *
 * Algorithm:
 *   1. Resolve `repoPath` to its `realpath` (resolves symlinks, normalises mounts).
 *   2. Detect the git root via `git rev-parse --show-toplevel` (falls back to realpath).
 *   3. Read `.cleo/project-info.json` name (optional).
 *   4. Read `git remote get-url origin` (optional).
 *   5. SHA-256 of `<gitRoot>|<projectName>|<remoteUrl>`, first 12 hex chars.
 *
 * This ensures `/mnt/projects/X` and `/workspace/X` (same git root,
 * same remote) produce the same ID.
 *
 * @param repoPath - Absolute path to the project root.
 * @returns The 12-hex-char canonical project ID.
 *
 * @task T11023
 * @task T9149
 */
export function computeCanonicalProjectId(repoPath: string): string {
  const realRepoPath = realpathSync(resolve(repoPath));

  const gitRoot = _findGitRootSync(realRepoPath);
  const effectiveRoot = gitRoot ?? realRepoPath;

  const remoteUrl = gitRoot ? _findGitRemoteUrlSync(gitRoot) : null;
  const projectName = _readProjectInfoName(effectiveRoot);

  const fingerprint = [effectiveRoot, projectName ?? '', remoteUrl ?? ''].join('|');
  return createHash('sha256').update(fingerprint).digest('hex').substring(0, 12);
}

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
 * Walk up from `cwd` (or `process.cwd()`) looking for `.cleo/project-info.json`
 * and return the project identity if found.
 *
 * The project-info file acts as the local sentinel and supplies `legacyUUID`.
 * The returned `projectId` is the derived canonical runtime ID, not the raw
 * project-local UUID stored in the file.
 *
 * **Cross-mount divergence (T11023):** Uses `realpathSync` to normalize
 * bind-mounts and symlinks so the same repo at `/mnt/projects/X` and
 * `/workspace/X` resolves to the same `projectRoot`. The `projectId` is
 * the T9149 canonical 12-hex-char SHA-256 fingerprint of git-root + name
 * + remote URL, which is also mount-invariant.
 *
 * @param cwd - Optional working directory to start the ancestor walk from.
 *   Defaults to `process.cwd()`.
 * @returns The resolved project identity, or `null` if no CLEO project is
 *   found anywhere in the ancestor chain.
 *
 * @example
 * ```typescript
 * const project = resolveProjectByCwd('/repo/packages/core');
 * // { projectId: 'a1b2c3d4e5f6', projectRoot: '/repo' }
 *
 * const notFound = resolveProjectByCwd('/tmp/empty');
 * // null
 * ```
 *
 * @public
 * @task T11008
 * @task T11023
 */
export function resolveProjectByCwd(cwd?: string): ResolvedProject | null {
  const start = resolve(cwd ?? process.cwd());
  let current = start;

  while (true) {
    const infoPath = join(current, '.cleo', 'project-info.json');

    if (existsSync(infoPath)) {
      try {
        const raw = readFileSync(infoPath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;

        if (typeof data.projectId === 'string' && data.projectId.length > 0) {
          // T11023: Normalize projectRoot via realpathSync to handle cross-mount
          // divergence — same repo at /mnt/projects/X and /workspace/X resolves
          // to the same real path (AC2, AC3).
          let realRoot: string;
          try {
            realRoot = realpathSync(current);
          } catch {
            // realpathSync fails on nonexistent paths — fall back to resolved path
            realRoot = current;
          }

          // T11023: Compute canonical projectId using T9149 algorithm
          // (git-root + realpath fingerprint) for mount-invariant identity (AC1).
          const canonicalId = computeCanonicalProjectId(realRoot);

          return {
            projectId: canonicalId,
            projectRoot: realRoot,
            legacyUUID: data.projectId,
          };
        }
      } catch {
        // Corrupt or unparseable project-info.json — keep walking up.
        // A higher ancestor may have a valid one.
      }
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
 * Looks up the project in the global `nexus.db` registry (`project_registry`
 * table) to find the project's root path, then returns the `.cleo/` directory
 * under that root.
 *
 * **Legacy ID support (T11023 AC4):** If the `projectId` is not found in
 * `project_registry`, also checks the `project_id_aliases` table for a
 * legacy→canonical mapping before returning `null`.
 *
 * This enables cross-project lookups: given a stable project ID, resolve where
 * that project lives on disk without walking from a working directory.
 *
 * @param projectId - The project ID to look up. Can be a canonical 12-hex-char
 *   ID, a legacy UUID, or a legacy base64url(path) ID.
 * @returns Absolute path to the `.cleo/` directory, or `null` if the
 *   projectId is not found in the nexus registry (or its alias table).
 *
 * @task T11008
 * @task T11023
 */
export function resolveCanonicalCleoDir(projectId: string): string | null {
  const cleoHome = getCleoHome();
  const nexusDbPath = join(cleoHome, 'nexus.db');

  if (!existsSync(nexusDbPath)) return null;

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(nexusDbPath, { readOnly: true }); // db-open-allowed: leaf path package cannot depend on core DB chokepoint

    // Try direct project_registry lookup first.
    const directStmt = db.prepare(
      'SELECT project_path FROM project_registry WHERE project_id = ? LIMIT 1',
    );
    const directRow = directStmt.get(projectId) as { project_path: string } | undefined;

    if (
      directRow &&
      typeof directRow.project_path === 'string' &&
      directRow.project_path.length > 0
    ) {
      return join(directRow.project_path, '.cleo');
    }

    // T11023 AC4: Fall back to project_id_aliases for legacy ID resolution.
    // Legacy base64url(path) IDs and old UUIDs are mapped to canonical IDs
    // in the aliases table. Try resolving the input as a legacy ID first,
    // then look up the canonical ID.
    try {
      const aliasStmt = db.prepare(
        'SELECT canonical_id FROM project_id_aliases WHERE legacy_id = ? LIMIT 1',
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
      // project_id_aliases table may not exist yet (pre-migration) — non-fatal.
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
