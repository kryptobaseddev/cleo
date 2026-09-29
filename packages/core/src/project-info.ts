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
import { basename, join } from 'node:path';
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
 * The project's human-readable display name: `project-info.json` `name`
 * (the schema field `cleo project rename` writes), else the legacy
 * `projectName`, else the root directory's basename.
 *
 * This is the ONE accessor for the name. T12716 moves the name into a
 * committed `.cleo/project.json` and repoints this function; callers must not
 * read `project-info.json` for the name themselves.
 *
 * @param projectRoot - Project root.
 * @returns A non-empty display name.
 * @example
 * ```ts
 * const label = getProjectDisplayName('/repo'); // 'repo' unless renamed
 * ```
 * @task T12712
 */
export function getProjectDisplayName(projectRoot: string): string {
  try {
    const data = JSON.parse(
      readFileSync(join(getCleoDirAbsolute(projectRoot), 'project-info.json'), 'utf-8'),
    ) as Record<string, unknown>;
    for (const field of ['name', 'projectName']) {
      const value = data[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // Missing or unreadable metadata: fall back to the directory name.
  }
  return basename(projectRoot);
}

/**
 * Update the project name in project-info.json.
 * Used by `cleo upgrade --name` and programmatic consumers.
 */
export function updateProjectName(cwd: string, name: string): void {
  const cleoDir = getCleoDirAbsolute(cwd);
  const infoPath = join(cleoDir, 'project-info.json');
  if (!existsSync(infoPath)) return;

  const data = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, string>;
  data.projectName = name;
  data.lastUpdated = new Date().toISOString();
  writeFileSync(infoPath, `${JSON.stringify(data, null, 2)}\n`);
}
