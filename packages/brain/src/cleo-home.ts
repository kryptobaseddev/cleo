/**
 * CLEO home + project DB path resolution for `@cleocode/brain`.
 *
 * Path resolution delegates to the `@cleocode/paths` SSoT
 * ({@link getCleoHome}). The project store (`.cleo/cleo.db`) is resolved via
 * projectId → global registry lookup
 * ({@link resolveProjectByCwd} + {@link resolveCanonicalCleoDir}), with a
 * `CLEO_ROOT` / `process.cwd()` fallback for non-project contexts.
 *
 * Previously this module imported `env-paths` directly which caused a Windows
 * path mismatch with the rest of the CLEO ecosystem (the CLI used env-paths
 * returning `%LOCALAPPDATA%\cleo\Data` while brain used a bare
 * `%LOCALAPPDATA%\cleo`, looking up `nexus.db` one directory shallower than
 * where it was written). Fixed in T1874 (Closes #102, supersedes #103).
 *
 * @task T1874 (original Windows fix)
 * @task T1886 (migrated to @cleocode/paths SSoT)
 * @task T11040 (verified 2026-05-27: projectId-based resolution confirmed; 72/72 tests pass)
 * @task T14583 (read the consolidated cleo.db, not the legacy per-domain files)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalizePath,
  getCleoHome,
  resolveCanonicalCleoDir,
  resolveProjectByCwd,
} from '@cleocode/paths';

export { getCleoHome };

/**
 * Returns the project's `.cleo/` directory.
 *
 * Resolution order:
 * 1. {@link resolveProjectByCwd} — reads the declared `projectId`
 *    (`.cleo/project.json` / legacy `.cleo/project-id`, then `project-info.json`) and the checkout root. The
 *    registry path from {@link resolveCanonicalCleoDir} is used only when it
 *    names this same checkout (T12470); otherwise `<projectRoot>/.cleo`.
 * 2. Fallback: `CLEO_ROOT` env var or `process.cwd()` + `'.cleo'` for
 *    non-project contexts (e.g., before `cleo init`).
 *
 * @task T11040 — migrate from CWD-walk-up to projectId-based resolution
 */
export function getCleoProjectDir(): string {
  const project = resolveProjectByCwd();
  if (project !== null) {
    const local = join(project.projectRoot, '.cleo');
    // T12470: the registry names ONE checkout per project id — whichever was
    // confirmed last. Two clones of one project share the id, so the registry
    // answer is used only when it agrees with the checkout the caller is in;
    // otherwise clone A would read clone B's `.cleo/`. Mirrors the
    // path-agrees check in core's getCleoDirAbsolute.
    const canonical = resolveCanonicalCleoDir(project.projectId);
    if (canonical !== null && canonicalizePath(canonical) === canonicalizePath(local)) {
      return canonical;
    }
    return local;
  }
  // Fallback for non-project contexts (pre-init, CLEO_ROOT override).
  const root = process.env['CLEO_ROOT'] ?? process.cwd();
  return join(root, '.cleo');
}

/**
 * Returns the absolute path to the project-scope `cleo.db`.
 *
 * It holds the project's `tasks_*`, `brain_*`, `conduit_*` and `nexus_*`
 * (code graph, ADR-090) tables. The legacy `tasks.db`, `brain.db` and
 * `conduit.db` files are decoys and are never read (T12095, T14583).
 *
 * @returns `<project>/.cleo/cleo.db`.
 */
export function getProjectStorePath(): string {
  return join(getCleoProjectDir(), 'cleo.db');
}

/**
 * Returns the absolute path to the global-scope `cleo.db` under CLEO home.
 *
 * It holds the `agent_registry_*` tables; the retired `signaldock.db` and
 * `nexus.db` files are never read (T14583).
 *
 * @returns `<cleoHome>/cleo.db`.
 */
export function getGlobalStorePath(): string {
  return join(getCleoHome(), 'cleo.db');
}

/** Returns true when the given DB file exists on disk. */
export function dbExists(dbPath: string): boolean {
  return existsSync(dbPath);
}
