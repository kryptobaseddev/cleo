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

import { existsSync, readFileSync } from 'node:fs';
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
  /** Stable UUID that identifies the project across directory moves. */
  projectId: string;
  /** Absolute path to the project root directory. */
  projectRoot: string;
}

/**
 * Walk up from `cwd` (or `process.cwd()`) looking for `.cleo/project-info.json`
 * and return the project identity if found.
 *
 * This replaces the ancestor-walk pattern in `getCleoDirAbsolute` with a
 * projectId-aware lookup. Instead of resolving a `.cleo/` directory via
 * git-root heuristics, it reads the stable `projectId` from the canonical
 * project-info file — enabling move-safe project identification.
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
          return { projectId: data.projectId, projectRoot: current };
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
 * This enables cross-project lookups: given a stable project ID, resolve where
 * that project lives on disk without walking from a working directory.
 *
 * @param projectId - The stable project UUID (from `.cleo/project-info.json`).
 * @returns Absolute path to the `.cleo/` directory, or `null` if the
 *   projectId is not found in the nexus registry.
 *
 * @example
 * ```typescript
 * const cleoDir = resolveCanonicalCleoDir('a1b2c3d4e5f6');
 * // "/mnt/projects/cleocode/.cleo"
 *
 * const notFound = resolveCanonicalCleoDir('nonexistent');
 * // null
 * ```
 *
 * @public
 * @task T11008
 */
export function resolveCanonicalCleoDir(projectId: string): string | null {
  const cleoHome = getCleoHome();
  const nexusDbPath = join(cleoHome, 'nexus.db');

  if (!existsSync(nexusDbPath)) return null;

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(nexusDbPath, { readOnly: true });
    const stmt = db.prepare(
      'SELECT project_path FROM project_registry WHERE project_id = ? LIMIT 1',
    );
    const row = stmt.get(projectId) as { project_path: string } | undefined;

    if (row && typeof row.project_path === 'string' && row.project_path.length > 0) {
      return join(row.project_path, '.cleo');
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
