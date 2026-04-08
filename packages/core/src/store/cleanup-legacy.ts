/**
 * Idempotent cleanup of legacy and stray CLEO database files.
 *
 * Provides two independent cleanup functions:
 *
 * 1. {@link detectAndRemoveLegacyGlobalFiles} — removes stale files left at
 *    the global CLEO home directory (`getCleoHome()`) by pre-v2026.4.11
 *    naming migrations. Safe to call on repeat invocations — existence-checks
 *    guard every deletion.
 *
 *    Files targeted (see ADR-036 §Decision/Global-Tier table):
 *      - workspace.db              (pre-nexus naming relic)
 *      - workspace.db.bak-pre-rename  (safety copy from a long-landed rename)
 *      - workspace.db-shm          (SQLite shared-memory sidecar of workspace.db)
 *      - workspace.db-shm-wal      (SQLite WAL sidecar of workspace.db)
 *      - nexus-pre-cleo.db.bak     (pre-CLEO backup of nexus — migration complete)
 *
 *    Live files (nexus.db, signaldock.db, machine-key, config.json, etc.) are
 *    NEVER touched. The function only acts on the explicit LEGACY_FILES list.
 *
 * 2. {@link detectAndRemoveStrayProjectNexus} — removes a stray
 *    `{projectRoot}/.cleo/nexus.db` that violates ADR-036's global-only
 *    nexus contract. Some pre-v2026.4.11 code path accidentally created a
 *    zero-byte nexus.db at project tier; this cleans it up on first run.
 *
 * @task T304
 * @task T307
 * @epic T299
 * @adr ADR-036
 * @why v2026.4.10 left workspace.db and pre-cleo backups at global tier;
 *   ADR-036 mandates their deletion to eliminate diagnostic confusion and
 *   false impressions of active legacy databases.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../logger.js';
import { getCleoHome } from '../paths.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Exhaustive list of legacy filenames that MUST be removed from the global
 * CLEO home directory. No other files are touched.
 *
 * @task T304
 */
const LEGACY_FILES: readonly string[] = [
  'workspace.db',
  'workspace.db.bak-pre-rename',
  'workspace.db-shm',
  'workspace.db-shm-wal',
  'nexus-pre-cleo.db.bak',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by {@link detectAndRemoveLegacyGlobalFiles}. */
export interface LegacyCleanupResult {
  /** Filenames (basename only) that were successfully deleted. */
  removed: string[];
  /** Files that could not be deleted, with error messages. */
  errors: Array<{ file: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Detect and remove legacy global-tier files from the CLEO home directory.
 *
 * Idempotent: safe to call when some or all files are already absent. Each
 * file is individually existence-checked before attempting deletion. Failures
 * on individual files are captured in `errors` rather than thrown, so the
 * caller receives a complete picture of what was (and was not) cleaned up.
 *
 * Logs each successful deletion at `info` level and each failure at `warn`
 * level via the shared pino logger.
 *
 * @param cleoHomeOverride - Optional directory override for tests. When
 *   omitted the canonical `getCleoHome()` path is used. Prefer passing this
 *   parameter in test harnesses rather than mutating `CLEO_HOME` environment
 *   variables, as it avoids global state contamination between test runs.
 * @returns A {@link LegacyCleanupResult} describing what was removed and any
 *   errors encountered.
 *
 * @example
 * ```typescript
 * // Production usage (runs against real global home)
 * const result = detectAndRemoveLegacyGlobalFiles();
 * if (result.removed.length > 0) {
 *   // Legacy files were cleaned up
 * }
 *
 * // Test usage (runs against tmp directory)
 * const result = detectAndRemoveLegacyGlobalFiles('/tmp/fake-cleo-home');
 * ```
 *
 * @task T304
 * @epic T299
 */
export function detectAndRemoveLegacyGlobalFiles(cleoHomeOverride?: string): LegacyCleanupResult {
  const log = getLogger('cleanup-legacy');
  const cleoHome = cleoHomeOverride ?? getCleoHome();
  const removed: string[] = [];
  const errors: Array<{ file: string; error: string }> = [];

  for (const fileName of LEGACY_FILES) {
    const fullPath = path.join(cleoHome, fileName);
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        removed.push(fileName);
        log.info({ file: fullPath }, 'Removed legacy global file');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ file: fileName, error: message });
      log.warn({ file: fullPath, error: message }, 'Failed to remove legacy global file');
    }
  }

  return { removed, errors };
}

// ---------------------------------------------------------------------------
// Project-tier stray nexus.db cleanup (T307)
// ---------------------------------------------------------------------------

/** Result returned by {@link detectAndRemoveStrayProjectNexus}. */
export interface StrayNexusCleanupResult {
  /** Whether a stray nexus.db was found and deleted. */
  removed: boolean;
  /** Absolute path that was checked (and removed if `removed` is true). */
  path: string;
}

/**
 * Detect and remove a stray project-tier `.cleo/nexus.db` file.
 *
 * ADR-036 declares nexus.db as **global-only** — it lives exclusively under
 * `getCleoHome()` (e.g. `~/.local/share/cleo/nexus.db` on Linux). A
 * zero-byte stray was discovered at `/mnt/projects/cleocode/.cleo/nexus.db`
 * (created 2026-03-31), likely produced by an early `cleo init` / `cleo
 * nexus init` invocation that ran before the canonical path was fully wired
 * through `getNexusDbPath()`.
 *
 * This function is idempotent: calling it when no stray file exists is a
 * no-op. It is designed to be called once per CLI startup (alongside
 * {@link detectAndRemoveLegacyGlobalFiles}) so that users who upgrade to
 * v2026.4.11 have the stray silently cleaned up on the first `cleo` run.
 *
 * @param projectRoot - Absolute path to the project root directory. When
 *   omitted the caller is responsible for supplying the current project
 *   root from `getProjectRoot()`. An override parameter is accepted here to
 *   keep tests hermetic (avoids reading live `process.cwd()` state).
 * @returns A {@link StrayNexusCleanupResult} indicating whether a file was
 *   removed and the absolute path that was checked.
 *
 * @example
 * ```typescript
 * // Production usage
 * import { getProjectRoot } from '../paths.js';
 * const result = detectAndRemoveStrayProjectNexus(getProjectRoot());
 * if (result.removed) {
 *   // Stray project-tier nexus.db has been cleaned up
 * }
 *
 * // Test usage (hermetic)
 * const result = detectAndRemoveStrayProjectNexus('/tmp/fake-project-root');
 * ```
 *
 * @task T307
 * @epic T299
 * @adr ADR-036
 * @why ADR-036 §Decision/Global-Tier: nexus.db is global-only. A stray
 *   project-tier copy was created by pre-v2026.4.11 code and must be removed
 *   to prevent diagnostic confusion and guard against future regressions.
 */
export function detectAndRemoveStrayProjectNexus(projectRoot: string): StrayNexusCleanupResult {
  const log = getLogger('cleanup-legacy');
  const strayPath = path.join(projectRoot, '.cleo', 'nexus.db');

  if (fs.existsSync(strayPath)) {
    try {
      fs.unlinkSync(strayPath);
      log.warn(
        { path: strayPath },
        'Removed stray project-tier nexus.db (violates ADR-036 global-only contract)',
      );
      return { removed: true, path: strayPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { path: strayPath, error: message },
        'Failed to remove stray project-tier nexus.db — manual deletion may be required',
      );
      return { removed: false, path: strayPath };
    }
  }

  return { removed: false, path: strayPath };
}
