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

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatProjectManifest,
  isValidProjectDisplayName,
  projectManifestPath,
  readProjectManifest,
} from '@cleocode/paths';
import { getCleoDirAbsolute, resolveOrCwd } from './paths.js';
import {
  computeStableProjectHash,
  type ProjectInfo,
  readProjectInfoAtDirectory,
  readProjectInfoAtDirectorySync,
} from './project-scope.js';

export { getProjectDisplayName } from './project-scope.js';

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
 *   project has no readable `project-info.json` — the same value
 *   `ensureProjectInfo` records for any project it did not just mint (T12716).
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
 * Update the project name, synchronously (T12716).
 *
 * Writes the committed `.cleo/project.json` `name` (id carried over
 * byte-identical) when the project has one; a legacy project without it gets
 * `project-info.json` `displayName`, which `getProjectDisplayName` reads. The
 * cached `name` is never touched: it is the frozen input to the path
 * fingerprint alias key. It once wrote `projectName`, which nothing reads; a
 * stray one is removed.
 *
 * Programmatic consumers that also want the registry and Nexus labels use
 * `renameProject` (`cleo project rename`, `cleo upgrade --name`).
 *
 * @param cwd - Project root.
 * @param name - New display name (trimmed; must pass `isValidProjectDisplayName`).
 * @throws {Error} When the name is invalid.
 */
export function updateProjectName(cwd: string, name: string): void {
  const newName = name.trim();
  if (!isValidProjectDisplayName(newName)) throw new Error(`Invalid project name '${newName}'`);
  const root = resolveOrCwd(cwd);
  const manifest = readProjectManifest(root);
  if (manifest.status === 'valid') {
    const path = projectManifestPath(root);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, formatProjectManifest({ ...manifest.manifest, name: newName }));
    renameSync(tmp, path);
    return;
  }
  const cleoDir = getCleoDirAbsolute(cwd);
  const infoPath = join(cleoDir, 'project-info.json');
  if (!existsSync(infoPath)) return;

  // Legacy project: `displayName`, never `name` — `name` feeds the path
  // fingerprint alias key, which must not move on a rename (T12716).
  const data = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>;
  data['displayName'] = newName;
  delete data['projectName'];
  data['lastUpdated'] = new Date().toISOString();
  writeFileSync(infoPath, `${JSON.stringify(data, null, 2)}\n`);
}
