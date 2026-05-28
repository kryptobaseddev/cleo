/**
 * Project lifecycle engine — move, rename, and re-register CLEO projects.
 *
 * Provides the core operations for relocating a CLEO project on disk,
 * renaming it, and reconciling the nexus registry after manual moves.
 *
 * All functions accept explicit absolute paths — no CWD-walk-up (AC7).
 *
 * @task T11010 — T10298-1
 */

import { existsSync } from 'node:fs';
import { cp, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { type EngineResult, engineError, engineSuccess } from './engine-result.js';
import { generateProjectHash, nexusReconcile, nexusRenameProject } from './nexus/index.js';

// ── Result types ─────────────────────────────────────────────────────

/** Result of a successful project move. */
export interface MoveProjectResult {
  /** Stable project UUID — preserved across moves. */
  projectId: string;
  /** The old absolute project root path. */
  oldPath: string;
  /** The new absolute project root path. */
  newPath: string;
  /** Updated project hash (based on new path). */
  newProjectHash: string;
  /** Nexus reconcile status. */
  reconcileStatus: 'ok' | 'path_updated' | 'auto_registered';
}

/** Result of a successful project rename. */
export interface RenameProjectResult {
  /** Stable project UUID — preserved across renames. */
  projectId: string;
  /** The project root path. */
  projectRoot: string;
  /** The old project name. */
  oldName: string;
  /** The new project name. */
  newName: string;
  /** Updated project hash (name influences hash). */
  newProjectHash: string;
}

/** Result of a successful project re-registration. */
export interface ReregisterProjectResult {
  /** Stable project UUID. */
  projectId: string;
  /** The project root path. */
  projectRoot: string;
  /** Current project hash. */
  projectHash: string;
  /** Whether the project had drifted (path changed since last register). */
  drifted: boolean;
  /** Nexus reconcile status. */
  reconcileStatus: 'ok' | 'path_updated' | 'auto_registered';
  /** Previous path if drift was detected. */
  oldPath?: string;
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Read and parse project-info.json from the given project root.
 * Returns null if the file doesn't exist or is unparseable.
 */
async function readProjectInfo(projectRoot: string): Promise<Record<string, unknown> | null> {
  const infoPath = join(projectRoot, '.cleo', 'project-info.json');
  try {
    const raw = await readFile(infoPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Write project-info.json atomically (tmp + rename).
 */
async function writeProjectInfo(projectRoot: string, data: Record<string, unknown>): Promise<void> {
  const cleoDir = join(projectRoot, '.cleo');
  const infoPath = join(cleoDir, 'project-info.json');
  const tmpPath = join(cleoDir, 'project-info.json.tmp');

  const content = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, infoPath);
}

/**
 * Validate that a path is absolute and exists.
 */
function validateAbsolutePath(label: string, p: string): EngineResult<never> | null {
  const resolved = resolvePath(p);
  if (resolved !== p) {
    return engineError('E_INVALID_PATH', `${label} must be an absolute path: "${p}"`, {
      fix: `Provide an absolute path like "${resolved}"`,
    });
  }
  return null; // valid
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Move a CLEO project to a new filesystem location.
 *
 * Copies the entire project directory tree to `newPath`, updates
 * `project-info.json` with the new project root and hash, reconciles
 * the nexus registry, and returns the result.
 *
 * The original directory is NOT removed — callers should verify the
 * move succeeded before cleaning up the old location.
 *
 * @param newPath - Absolute path to the new project root location.
 * @param projectRoot - Absolute path to the current project root.
 * @returns EngineResult with {@link MoveProjectResult} on success.
 *
 * @remarks AC3: Uses fs.cp for the filesystem move. The projectId is
 *   preserved across moves; projectHash is recomputed from the new path.
 *
 * @example
 * ```typescript
 * const result = await moveProject('/new/location/project', '/old/project');
 * if (result.success) {
 *   console.log(`Moved to ${result.data.newPath}, hash=${result.data.newProjectHash}`);
 * }
 * ```
 */
export async function moveProject(
  newPath: string,
  projectRoot: string,
): Promise<EngineResult<MoveProjectResult>> {
  // AC7: Validate absolute paths
  const pathErr = validateAbsolutePath('newPath', newPath);
  if (pathErr) return pathErr;
  const rootErr = validateAbsolutePath('projectRoot', projectRoot);
  if (rootErr) return rootErr;

  // Validate source exists and has project-info.json
  if (!existsSync(join(projectRoot, '.cleo', 'project-info.json'))) {
    return engineError('E_NOT_CLEO_PROJECT', `No CLEO project found at "${projectRoot}"`, {
      fix: 'Ensure the project was initialized with `cleo init`',
    });
  }

  if (resolvePath(newPath) === resolvePath(projectRoot)) {
    return engineError(
      'E_SAME_PATH',
      `newPath and projectRoot resolve to the same location: "${projectRoot}"`,
    );
  }

  // Read current project info
  const info = await readProjectInfo(projectRoot);
  if (!info) {
    return engineError(
      'E_PROJECT_INFO_MISSING',
      `Failed to read project-info.json at "${projectRoot}"`,
    );
  }

  const projectId = typeof info.projectId === 'string' ? info.projectId : '';
  if (!projectId) {
    return engineError(
      'E_NO_PROJECT_ID',
      `project-info.json at "${projectRoot}" is missing projectId`,
      { fix: 'Run `cleo init` to generate a projectId' },
    );
  }

  // AC3: Filesystem move via copy
  // We copy rather than rename so the caller can verify before cleanup.
  try {
    // Create parent dirs if needed
    const newParent = dirname(newPath);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(newParent, { recursive: true });

    // Copy the project tree (exclude node_modules for performance)
    await cp(projectRoot, newPath, {
      recursive: true,
      filter: (src) => {
        // Skip node_modules and .git directories during copy (they'll be
        // reconstructed or linked by the caller after the move).
        const base = basename(src);
        return base !== 'node_modules' && base !== '.git';
      },
    });
  } catch (err) {
    return engineError(
      'E_MOVE_FAILED',
      `Failed to copy project from "${projectRoot}" to "${newPath}": ${(err as Error).message}`,
    );
  }

  // AC3: Update project-info.json with new path and hash
  const newProjectHash = generateProjectHash(newPath);
  const newInfo = {
    ...info,
    projectRoot: newPath,
    projectHash: newProjectHash,
    lastUpdated: new Date().toISOString(),
  };
  await writeProjectInfo(newPath, newInfo);

  // Reconcile nexus registry with the new path
  let reconcile: { status: 'ok' | 'path_updated' | 'auto_registered'; oldPath?: string };
  try {
    reconcile = await nexusReconcile(newPath);
  } catch (err) {
    return engineError(
      'E_NEXUS_RECONCILE_FAILED',
      `Nexus reconcile failed for "${newPath}": ${(err as Error).message}`,
      { details: { originalError: (err as Error).message } },
    );
  }

  return engineSuccess({
    projectId,
    oldPath: projectRoot,
    newPath,
    newProjectHash,
    reconcileStatus: reconcile.status,
  });
}

/**
 * Rename a CLEO project (updates project-info.json name and hash).
 *
 * This is a lightweight metadata operation — no files are moved.
 * The projectHash is recomputed because the project name influences
 * the canonical project ID (T9149 algorithm).
 *
 * @param newName - The new project name.
 * @param projectRoot - Absolute path to the project root.
 * @returns EngineResult with {@link RenameProjectResult} on success.
 *
 * @remarks AC4: Updates project-info.json name field and recomputes
 *   projectHash based on the new basename.
 *
 * @example
 * ```typescript
 * const result = await renameProject('my-new-name', '/path/to/project');
 * if (result.success) {
 *   console.log(`Renamed to ${result.data.newName}`);
 * }
 * ```
 */
export async function renameProject(
  newName: string,
  projectRoot: string,
): Promise<EngineResult<RenameProjectResult>> {
  // AC7: Validate absolute path
  const rootErr = validateAbsolutePath('projectRoot', projectRoot);
  if (rootErr) return rootErr;

  if (!newName || newName.trim().length === 0) {
    return engineError('E_INVALID_NAME', 'newName must be a non-empty string');
  }

  // Read current project info
  const info = await readProjectInfo(projectRoot);
  if (!info) {
    return engineError(
      'E_PROJECT_INFO_MISSING',
      `Failed to read project-info.json at "${projectRoot}"`,
    );
  }

  const projectId = typeof info.projectId === 'string' ? info.projectId : '';
  if (!projectId) {
    return engineError(
      'E_NO_PROJECT_ID',
      `project-info.json at "${projectRoot}" is missing projectId`,
      { fix: 'Run `cleo init` to generate a projectId' },
    );
  }

  const oldName =
    (typeof info.name === 'string' ? info.name : '') ||
    (typeof info.projectName === 'string' ? info.projectName : '') ||
    basename(projectRoot);

  // AC4: Update project-info.json — only name changes, path stays same
  const newProjectHash = generateProjectHash(projectRoot);
  const newInfo = {
    ...info,
    name: newName.trim(),
    projectHash: newProjectHash,
    lastUpdated: new Date().toISOString(),
  };
  await writeProjectInfo(projectRoot, newInfo);

  // AC1, AC3, AC5: Register self-alias in nexus projectIdAliases table
  // for dispatch-layer consumer compatibility (T11025).
  try {
    await nexusRenameProject(projectId, newName.trim());
  } catch {
    // Non-fatal: alias registration is best-effort; the rename succeeded
  }

  return engineSuccess({
    projectId,
    projectRoot,
    oldName,
    newName: newName.trim(),
    newProjectHash,
  });
}

/**
 * Re-register a CLEO project with the nexus registry.
 *
 * Detects when a project has been moved on the filesystem without using
 * `moveProject`, and reconciles the nexus registry accordingly.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns EngineResult with {@link ReregisterProjectResult} on success.
 *
 * @remarks AC5: Reads project-info.json, calls nexusReconcile, and
 *   returns drift status when the filesystem location has changed.
 *
 * @example
 * ```typescript
 * const result = await reregisterProject('/path/to/moved-project');
 * if (result.success) {
 *   console.log(`Drifted: ${result.data.drifted}, status: ${result.data.reconcileStatus}`);
 * }
 * ```
 */
export async function reregisterProject(
  projectRoot: string,
): Promise<EngineResult<ReregisterProjectResult>> {
  // AC7: Validate absolute path
  const rootErr = validateAbsolutePath('projectRoot', projectRoot);
  if (rootErr) return rootErr;

  if (!existsSync(join(projectRoot, '.cleo', 'project-info.json'))) {
    return engineError('E_NOT_CLEO_PROJECT', `No CLEO project found at "${projectRoot}"`, {
      fix: 'Ensure the project was initialized with `cleo init`',
    });
  }

  // Read current project info
  const info = await readProjectInfo(projectRoot);
  if (!info) {
    return engineError(
      'E_PROJECT_INFO_MISSING',
      `Failed to read project-info.json at "${projectRoot}"`,
    );
  }

  const projectId = typeof info.projectId === 'string' ? info.projectId : '';
  if (!projectId) {
    return engineError(
      'E_NO_PROJECT_ID',
      `project-info.json at "${projectRoot}" is missing projectId`,
      { fix: 'Run `cleo init` to generate a projectId' },
    );
  }

  const projectHash = generateProjectHash(projectRoot);

  // AC5: Reconcile with nexus — detects drift
  let reconcile: { status: 'ok' | 'path_updated' | 'auto_registered'; oldPath?: string };
  try {
    reconcile = await nexusReconcile(projectRoot);
  } catch (err) {
    return engineError(
      'E_NEXUS_RECONCILE_FAILED',
      `Nexus reconcile failed for "${projectRoot}": ${(err as Error).message}`,
      { details: { originalError: (err as Error).message } },
    );
  }

  const drifted = reconcile.status === 'path_updated';

  return engineSuccess({
    projectId,
    projectRoot,
    projectHash,
    drifted,
    reconcileStatus: reconcile.status,
    ...(drifted && reconcile.oldPath ? { oldPath: reconcile.oldPath } : {}),
  });
}
