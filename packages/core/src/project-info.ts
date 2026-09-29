/**
 * Thin reader for .cleo/project-info.json.
 *
 * The file is written by scaffold.ts (ensureProjectInfo). This module
 * provides a typed read interface for consumers that need the project-local
 * identity fields without importing the full scaffold machinery.
 *
 * @task T5333
 * @task T11008 — resolveProjectByCwd and resolveCanonicalCleoDir added to @cleocode/paths
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDirAbsolute, resolveOrCwd } from './paths.js';
import {
  computeStableProjectHash,
  type ProjectInfo,
  readProjectInfoAtDirectory,
  readProjectInfoAtDirectorySync,
} from './project-scope.js';

// ── Types ────────────────────────────────────────────────────────────

export type { ProjectInfo } from './project-scope.js';

// ── Implementation ───────────────────────────────────────────────────

/**
 * Read project-info.json and return a typed ProjectInfo.
 *
 * Falls back gracefully when the project-local `projectId` is missing
 * (pre-T5333 installs) by returning an empty string, allowing callers to
 * detect and handle the legacy shape.
 *
 * @throws {Error} If .cleo/project-info.json does not exist or is invalid JSON.
 */
export async function getProjectInfo(cwd?: string): Promise<ProjectInfo> {
  const projectRoot = resolveOrCwd(cwd);
  const cleoDir = getCleoDirAbsolute(projectRoot);
  return readProjectInfoAtDirectory(projectRoot, cleoDir);
}

/**
 * Synchronous variant for use in hot paths where async is not feasible.
 * Returns null if the file is missing or unparseable.
 */
export function getProjectInfoSync(cwd?: string): ProjectInfo | null {
  const projectRoot = resolveOrCwd(cwd);
  const cleoDir = getCleoDirAbsolute(projectRoot);
  try {
    return readProjectInfoAtDirectorySync(projectRoot, cleoDir);
  } catch {
    return null;
  }
}

/**
 * The project's write-once `projectHash` identity key.
 *
 * Every persisted key built from the hash (release ids `<hash>:<version>`,
 * audit rows, idempotency) MUST come from here, never from
 * `generateProjectHash(projectRoot)`: a path-derived hash changes when the
 * project moves and splits those keys (T12557).
 *
 * @param cwd - Project root (defaults to the resolved current project).
 * @returns The persisted hash, or {@link computeStableProjectHash} when the
 *   project has no readable `project-info.json`.
 * @example
 * ```ts
 * const releaseId = `${getProjectHashKey(root)}:${version}`;
 * ```
 * @task T12557
 */
export function getProjectHashKey(cwd?: string): string {
  const projectRoot = resolveOrCwd(cwd);
  let persisted: string | undefined;
  try {
    persisted = getProjectInfoSync(projectRoot)?.projectHash;
  } catch {
    // Unresolvable store: fall through to the stable derivation.
  }
  return persisted ?? computeStableProjectHash(projectRoot);
}

/**
 * Update the project name in project-info.json.
 * Used by `cleo upgrade --name` and programmatic consumers.
 *
 * Writes `name`, the field every reader uses. It used to write `projectName`,
 * which nothing reads, so `cleo upgrade --name` had no visible effect; a
 * stray `projectName` left by that bug is removed.
 */
export function updateProjectName(cwd: string, name: string): void {
  const cleoDir = getCleoDirAbsolute(cwd);
  const infoPath = join(cleoDir, 'project-info.json');
  if (!existsSync(infoPath)) return;

  const data = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>;
  data['name'] = name;
  delete data['projectName'];
  data['lastUpdated'] = new Date().toISOString();
  writeFileSync(infoPath, `${JSON.stringify(data, null, 2)}\n`);
}
