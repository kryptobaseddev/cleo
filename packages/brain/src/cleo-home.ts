/**
 * CLEO home + project DB path resolution for `@cleocode/brain`.
 *
 * Path resolution delegates to the `@cleocode/paths` SSoT
 * ({@link getCleoHome}). Project data (tasks.db, brain.db, conduit.db) is
 * resolved via projectId → nexus.db registry lookup
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

/** Returns the absolute path to the global nexus.db file. */
export function getNexusDbPath(): string {
  return join(getCleoHome(), 'nexus.db');
}

/** Returns the absolute path to the project-scoped brain.db file. */
export function getBrainDbPath(): string {
  return join(getCleoProjectDir(), 'brain.db');
}

/** Returns the absolute path to the project-scoped tasks.db file. */
export function getTasksDbPath(): string {
  return join(getCleoProjectDir(), 'tasks.db');
}

/** Returns the absolute path to the project-scoped conduit.db file. */
export function getConduitDbPath(): string {
  return join(getCleoProjectDir(), 'conduit.db');
}

/** Returns the absolute path to the global signaldock.db file. */
export function getAgentRegistryDbPath(): string {
  return join(getCleoHome(), 'signaldock.db');
}

/** Returns true when the given DB file exists on disk. */
export function dbExists(dbPath: string): boolean {
  return existsSync(dbPath);
}
