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
