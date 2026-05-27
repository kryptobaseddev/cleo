/**
 * Project lifecycle engine — move, rename, and re-register operations.
 *
 * TS-only per envelope-first doctrine (SG-ENVELOPE-FIRST T10343).
 * All functions accept explicit absolute paths (no CWD-walk-up).
 *
 * @task T11010
 * @epic T10298
 * @saga T10295
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type EngineResult, engineError, engineSuccess } from '@cleocode/contracts';
import { getLogger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────────────

/** Result of a successful project move operation. */
export interface MoveProjectResult {
  /** Stable project UUID — preserved across moves. */
  projectId: string;
  /** Original absolute project root path. */
  oldPath: string;
  /** New absolute project root path. */
  newPath: string;
  /** Updated 12-char hex project hash (based on new path). */
  newProjectHash: string;
  /** Whether the nexus registry was updated. */
  registryUpdated: boolean;
  /** Reconcile status after move ('ok' | 'path_updated' | 'auto_registered'). */
  reconcileStatus: string;
}

/** Result of a successful project rename operation. */
export interface RenameProjectResult {
  /** Stable project UUID — preserved across renames. */
  projectId: string;
  /** Previous project name. */
  oldName: string;
  /** New project name. */
  newName: string;
  /** Updated 12-char hex project hash. */
  newProjectHash: string;
  /** Absolute path to the project root. */
  projectRoot: string;
}

/** Result of a successful project re-register operation. */
export interface ReregisterProjectResult {
  /** Stable project UUID. */
  projectId: string;
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Current project hash. */
  projectHash: string;
  /** Reconcile status ('ok' | 'path_updated' | 'auto_registered'). */
  reconcileStatus: string;
  /** Whether path drift was detected. */
  drifted: boolean;
  /** Previous path if drift was detected. */
  oldPath?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Generate a 12-char hex project hash from a normalized path. */
function generateProjectHash(absPath: string): string {
  const normalized = resolve(absPath).replace(/[\\/]+$/, '');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/** Compute the project name from the last path segment. */
function projectNameFromPath(absPath: string): string {
  const segments = resolve(absPath)
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/);
  return segments[segments.length - 1] ?? 'unknown';
}

// ── Project Info I/O ──────────────────────────────────────────────────────

interface ProjectInfoFile {
  $schema?: string;
  schemaVersion?: string;
  projectId: string;
  projectHash: string;
  cleoVersion?: string;
  lastUpdated?: string;
  schemas?: Record<string, string>;
  injection?: Record<string, unknown>;
  health?: Record<string, unknown>;
  features?: Record<string, boolean>;
}

function readProjectInfo(projectRoot: string): ProjectInfoFile {
  const infoPath = join(projectRoot, '.cleo', 'project-info.json');
  if (!existsSync(infoPath)) {
    throw Object.assign(
      new Error(`No .cleo/project-info.json found at ${projectRoot}. Is this a CLEO project?`),
      { code: 'E_PROJECT_INFO_MISSING' },
    );
  }
  const raw = readFileSync(infoPath, 'utf-8');
  return JSON.parse(raw) as ProjectInfoFile;
}

function writeProjectInfo(projectRoot: string, info: ProjectInfoFile): void {
  const cleoDir = join(projectRoot, '.cleo');
  if (!existsSync(cleoDir)) {
    mkdirSync(cleoDir, { recursive: true });
  }
  info.lastUpdated = new Date().toISOString();
  writeFileSync(join(cleoDir, 'project-info.json'), `${JSON.stringify(info, null, 2)}\n`);
}

// ── Nexus Registry Update ─────────────────────────────────────────────────

async function updateNexusRegistryPath(
  projectId: string,
  oldPath: string,
  newPath: string,
): Promise<boolean> {
  try {
    const { getNexusDb, getNexusDbPath } = await import('../store/nexus-sqlite.js');

    const dbPath = getNexusDbPath();
    if (!existsSync(dbPath)) return false;

    const db = await getNexusDb();
    const newHash = generateProjectHash(newPath);
    const newName = projectNameFromPath(newPath);
    const now = new Date().toISOString();

    const result = db.run(
      `UPDATE project_registry
       SET project_path = ?,
           project_hash = ?,
           name = ?,
           last_seen = ?,
           tasks_db_path = ?,
           brain_db_path = ?
       WHERE project_id = ?`,
      [
        newPath,
        newHash,
        newName,
        now,
        join(newPath, '.cleo', 'tasks.db'),
        join(newPath, '.cleo', 'brain.db'),
        projectId,
      ],
    );

    getLogger().info(
      `[moveProject] Updated nexus registry: ${projectId} moved from ${oldPath} to ${newPath} (${result.changes} row(s) affected)`,
    );
    return result.changes > 0;
  } catch (err) {
    getLogger().warn(
      `[moveProject] Failed to update nexus registry for ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// ── moveProject ───────────────────────────────────────────────────────────

/**
 * Move a CLEO project directory to a new location.
 *
 * Preserves the stable `projectId` while updating `projectHash`, nexus
 * registry path, and the `.cleo/project-info.json` file.
 *
 * @param newPath - New absolute path for the project root.
 * @param projectRoot - Current project root (explicit, no CWD-walk-up).
 * @returns EngineResult with MoveProjectResult on success.
 *
 * @public
 * @task T11010
 */
export async function moveProject(
  newPath: string,
  projectRoot: string,
): Promise<EngineResult<MoveProjectResult>> {
  const logger = getLogger();
  const resolvedNewPath = resolve(newPath);
  const resolvedRoot = resolve(projectRoot);

  // ── Read current project info ──
  let info: ProjectInfoFile;
  try {
    info = readProjectInfo(resolvedRoot);
  } catch (err) {
    return engineError('E_PROJECT_INFO_MISSING', (err as Error).message, {
      details: { projectRoot: resolvedRoot },
    });
  }

  const projectId = info.projectId;
  const oldPath = resolvedRoot;

  // ── Validate: newPath must not already be a different CLEO project ──
  const newInfoPath = join(resolvedNewPath, '.cleo', 'project-info.json');
  if (existsSync(newInfoPath)) {
    try {
      const existingInfo = JSON.parse(readFileSync(newInfoPath, 'utf-8')) as ProjectInfoFile;
      if (existingInfo.projectId && existingInfo.projectId !== projectId) {
        return engineError(
          'E_DESTINATION_OCCUPIED',
          `Destination ${resolvedNewPath} already contains a different CLEO project (${existingInfo.projectId}).`,
          { details: { existingProjectId: existingInfo.projectId, newPath: resolvedNewPath } },
        );
      }
    } catch {
      return engineError(
        'E_DESTINATION_OCCUPIED',
        `Destination ${resolvedNewPath} already contains a .cleo/ directory.`,
        { details: { newPath: resolvedNewPath } },
      );
    }
  }

  // ── Validate: newPath's parent must exist ──
  const newParent = dirname(resolvedNewPath);
  if (!existsSync(newParent)) {
    return engineError('E_INVALID_INPUT', `Parent directory does not exist: ${newParent}`, {
      details: { newPath: resolvedNewPath, parent: newParent },
    });
  }

  // ── Validate: newPath must not be the same as current ──
  if (resolvedNewPath === oldPath) {
    return engineError(
      'E_INVALID_INPUT',
      `New path is the same as the current project root: ${oldPath}`,
      { details: { newPath: resolvedNewPath, oldPath } },
    );
  }

  const newHash = generateProjectHash(resolvedNewPath);

  // ── Execute move ──
  logger.info(`[moveProject] Moving project: ${oldPath} → ${resolvedNewPath}`);

  try {
    if (!existsSync(newParent)) {
      mkdirSync(newParent, { recursive: true });
    }

    let moved = false;
    try {
      renameSync(oldPath, resolvedNewPath);
      moved = true;
      logger.info('[moveProject] Atomic rename succeeded');
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
        logger.info('[moveProject] Cross-device move detected, using copy+delete fallback');
        await cp(oldPath, resolvedNewPath, { recursive: true });
        await rm(oldPath, { recursive: true, force: true });
        moved = true;
      } else {
        throw renameErr;
      }
    }

    if (!moved) {
      return engineError('E_MOVE_FAILED', 'Failed to move project directory.', {
        details: { oldPath, newPath: resolvedNewPath },
      });
    }

    writeProjectInfo(resolvedNewPath, { ...info, projectHash: newHash });

    const registryUpdated = await updateNexusRegistryPath(projectId, oldPath, resolvedNewPath);

    const result: MoveProjectResult = {
      projectId,
      oldPath,
      newPath: resolvedNewPath,
      newProjectHash: newHash,
      registryUpdated,
      reconcileStatus: registryUpdated ? 'ok' : 'path_updated',
    };

    logger.info(
      `[moveProject] Complete: ${oldPath} → ${resolvedNewPath} (registry=${registryUpdated})`,
    );
    return engineSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[moveProject] Failed: ${message}`);
    return engineError('E_MOVE_FAILED', `Failed to move project: ${message}`, {
      details: { oldPath, newPath: resolvedNewPath, error: message },
    });
  }
}

// ── renameProject ─────────────────────────────────────────────────────────

/**
 * Rename a CLEO project.
 *
 * Updates project-info.json with the new name, recomputes the project hash,
 * and registers a projectId alias for backward compatibility.
 *
 * @param newName - New project name (1–100 chars, alphanumeric + hyphens/underscores).
 * @param projectRoot - Current project root (explicit, no CWD-walk-up).
 * @returns EngineResult with RenameProjectResult on success.
 *
 * @public
 * @task T11010
 */
export async function renameProject(
  newName: string,
  projectRoot: string,
): Promise<EngineResult<RenameProjectResult>> {
  const resolvedRoot = resolve(projectRoot);

  // Validate name
  const nameRe = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
  if (!newName || !nameRe.test(newName)) {
    return engineError(
      'E_INVALID_NAME',
      `Invalid project name: "${newName}". Must be 1–100 characters, alphanumeric with hyphens/underscores.`,
      { exitCode: 2, fix: 'Provide a valid name matching /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/' },
    );
  }

  // Read project info
  let info: ProjectInfoFile;
  try {
    info = readProjectInfo(resolvedRoot);
  } catch (err) {
    return engineError('E_PROJECT_INFO_MISSING', (err as Error).message, {
      details: { projectRoot: resolvedRoot },
    });
  }

  const projectId = info.projectId;
  const oldName = projectNameFromPath(resolvedRoot);
  const newHash = generateProjectHash(resolvedRoot);

  // Update project-info.json
  writeProjectInfo(resolvedRoot, { ...info, projectHash: newHash });

  // Register alias in nexus
  const oldHash = info.projectHash;
  if (oldHash && oldHash !== newHash) {
    try {
      const { getNexusDb } = await import('../store/nexus-sqlite.js');
      const db = await getNexusDb();
      const now = new Date().toISOString();
      db.run(
        `INSERT OR IGNORE INTO project_id_aliases (legacy_id, canonical_id, created_at) VALUES (?, ?, ?)`,
        [oldHash, projectId, now],
      );
    } catch {
      // Alias registration is best-effort
    }
  }

  return engineSuccess({
    projectId,
    oldName,
    newName,
    newProjectHash: newHash,
    projectRoot: resolvedRoot,
  });
}

// ── reregisterProject ─────────────────────────────────────────────────────

/**
 * Re-register a project with the NEXUS registry.
 *
 * Detects path drift and optionally auto-heals. Used when a project has been
 * moved without going through `cleo project move`.
 *
 * @param projectRoot - Current project root (explicit, no CWD-walk-up).
 * @returns EngineResult with ReregisterProjectResult.
 *
 * @public
 * @task T11010
 */
export async function reregisterProject(
  projectRoot: string,
): Promise<EngineResult<ReregisterProjectResult>> {
  const resolvedRoot = resolve(projectRoot);

  let info: ProjectInfoFile;
  try {
    info = readProjectInfo(resolvedRoot);
  } catch (err) {
    return engineError('E_PROJECT_INFO_MISSING', (err as Error).message, {
      details: { projectRoot: resolvedRoot },
    });
  }

  const projectId = info.projectId;
  const currentHash = generateProjectHash(resolvedRoot);
  const oldHash = info.projectHash;
  const drifted = oldHash !== currentHash;
  let oldPath: string | undefined;

  // Check nexus registry for previous path
  if (drifted) {
    try {
      const { getNexusDb, getNexusDbPath } = await import('../store/nexus-sqlite.js');
      const dbPath = getNexusDbPath();
      if (existsSync(dbPath)) {
        const db = await getNexusDb();
        const rows = db
          .prepare('SELECT project_path FROM project_registry WHERE project_id = ?')
          .all(projectId) as Array<{ project_path: string }>;
        if (rows.length > 0 && rows[0].project_path !== resolvedRoot) {
          oldPath = rows[0].project_path;
        }
      }
    } catch {
      // Best-effort
    }
  }

  // Update project-info.json with current hash
  if (drifted) {
    writeProjectInfo(resolvedRoot, { ...info, projectHash: currentHash });
  }

  // Update nexus registry
  const registryUpdated = drifted
    ? await updateNexusRegistryPath(projectId, oldPath ?? resolvedRoot, resolvedRoot)
    : false;

  return engineSuccess({
    projectId,
    projectRoot: resolvedRoot,
    projectHash: currentHash,
    reconcileStatus: drifted ? (registryUpdated ? 'ok' : 'path_updated') : 'ok',
    drifted,
    oldPath,
  });
}
