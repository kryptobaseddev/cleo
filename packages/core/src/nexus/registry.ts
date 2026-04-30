/**
 * NEXUS project registry - cross-project registration and management.
 *
 * SQLite-backed via nexus.db (Drizzle ORM). The global project registry
 * is stored in ~/.cleo/nexus.db in the project_registry table.
 *
 * Legacy JSON backend (projects-registry.json) is migrated on first init
 * via migrate-json-to-sqlite.ts.
 *
 * @task T5366
 * @epic T4540
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  ExitCode,
  type NexusInitParams,
  type NexusListParams,
  type NexusPermissionSetParams,
  type NexusReconcileParams,
  type NexusRegisterParams,
  type NexusShowParams,
  type NexusSyncParams,
  type NexusUnregisterParams,
} from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { getLogger } from '../logger.js';
import { paginate } from '../pagination.js';
import { getCleoHome } from '../paths.js';
import { getAccessor } from '../store/data-accessor.js';
import type { ProjectRegistryRow } from '../store/nexus-schema.js';
import { nexusAuditLog, projectRegistry } from '../store/nexus-schema.js';
// Re-export only: resetNexusDbState used by tests and index barrel.
import { resetNexusDbState } from '../store/nexus-sqlite.js';
import { generateProjectHash } from './hash.js';

// ── Domain types ─────────────────────────────────────────────────────
//
// These are plain interfaces (not Zod schemas) because they represent
// the domain shape AFTER row-to-domain mapping. The DB row validation
// is handled by Drizzle's type system (ProjectRegistryRow) and by the
// drizzle-derived schemas in nexus-validation-schemas.ts.

export type NexusPermissionLevel = 'read' | 'write' | 'execute';

export type NexusHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unreachable';

/** Per-project code intelligence statistics stored in stats_json. */
export interface NexusProjectStats {
  nodeCount: number;
  relationCount: number;
  fileCount: number;
}

/** Domain representation of a registered Nexus project. */
export interface NexusProject {
  hash: string;
  projectId: string;
  path: string;
  name: string;
  registeredAt: string;
  lastSeen: string;
  healthStatus: NexusHealthStatus;
  healthLastCheck: string | null;
  permissions: NexusPermissionLevel;
  lastSync: string;
  taskCount: number;
  labels: string[];
  /** Absolute path to the project's brain.db. Null if not yet populated. */
  brainDbPath: string | null;
  /** Absolute path to the project's tasks.db. Null if not yet populated. */
  tasksDbPath: string | null;
  /** ISO 8601 timestamp of the last code intelligence index run. Null if never indexed. */
  lastIndexed: string | null;
  /** Code intelligence stats from the last index run. */
  stats: NexusProjectStats;
}

/** Legacy registry file shape (pre-SQLite). Retained for migration compatibility. */
export interface NexusRegistryFile {
  $schema?: string;
  schemaVersion: string;
  lastUpdated: string;
  projects: Record<string, NexusProject>;
}

// ── Path helpers ─────────────────────────────────────────────────────

/** Get path to the NEXUS home directory (cache, etc.). */
export function getNexusHome(): string {
  return process.env['NEXUS_HOME'] ?? join(getCleoHome(), 'nexus');
}

/** Get path to the NEXUS cache directory. */
export function getNexusCacheDir(): string {
  return process.env['NEXUS_CACHE_DIR'] ?? join(getNexusHome(), 'cache');
}

/**
 * Get path to the legacy projects registry JSON file.
 * @deprecated Use nexus.db via getNexusDb() instead. Retained for JSON-to-SQLite migration.
 */
export function getRegistryPath(): string {
  return process.env['NEXUS_REGISTRY_FILE'] ?? join(getCleoHome(), 'projects-registry.json');
}

// ── Row-to-NexusProject mapping ─────────────────────────────────────

/** Convert a project_registry row to a NexusProject object. */
function rowToProject(row: ProjectRegistryRow): NexusProject {
  let labels: string[] = [];
  try {
    labels = JSON.parse(row.labelsJson);
  } catch {
    labels = [];
  }
  let stats: NexusProjectStats = { nodeCount: 0, relationCount: 0, fileCount: 0 };
  try {
    const parsed = JSON.parse(row.statsJson ?? '{}') as Partial<NexusProjectStats>;
    stats = {
      nodeCount: parsed.nodeCount ?? 0,
      relationCount: parsed.relationCount ?? 0,
      fileCount: parsed.fileCount ?? 0,
    };
  } catch {
    stats = { nodeCount: 0, relationCount: 0, fileCount: 0 };
  }
  return {
    hash: row.projectHash,
    projectId: row.projectId,
    path: row.projectPath,
    name: row.name,
    registeredAt: row.registeredAt,
    lastSeen: row.lastSeen,
    healthStatus: row.healthStatus as NexusHealthStatus,
    healthLastCheck: row.healthLastCheck ?? null,
    permissions: row.permissions as NexusPermissionLevel,
    lastSync: row.lastSync,
    taskCount: row.taskCount,
    labels,
    brainDbPath: row.brainDbPath ?? null,
    tasksDbPath: row.tasksDbPath ?? null,
    lastIndexed: row.lastIndexed ?? null,
    stats,
  };
}

// ── Audit logging ───────────────────────────────────────────────────

interface NexusAuditFields {
  action: string;
  projectHash?: string;
  projectId?: string;
  operation?: string;
  sessionId?: string;
  requestId?: string;
  source?: string;
  gateway?: string;
  success: boolean;
  durationMs?: number;
  details?: Record<string, unknown>;
  errorMessage?: string;
}

/**
 * Write an audit entry to the nexus_audit_log table and emit a Pino log.
 * Audit failures are caught and logged as warnings — they must never break
 * primary operations.
 */
async function writeNexusAudit(fields: NexusAuditFields): Promise<void> {
  try {
    const { getNexusDb } = await import('../store/nexus-sqlite.js');
    const db = await getNexusDb();
    await db.insert(nexusAuditLog).values({
      id: randomUUID(),
      action: fields.action,
      projectHash: fields.projectHash,
      projectId: fields.projectId,
      domain: 'nexus',
      operation: fields.operation,
      sessionId: fields.sessionId,
      requestId: fields.requestId,
      source: fields.source,
      gateway: fields.gateway,
      success: fields.success ? 1 : 0,
      durationMs: fields.durationMs,
      detailsJson: JSON.stringify(fields.details ?? {}),
      errorMessage: fields.errorMessage,
    });

    getLogger('nexus').info({ ...fields, domain: 'nexus' }, `nexus audit: ${fields.action}`);
  } catch (err) {
    getLogger('nexus').warn({ err }, 'nexus audit write failed');
  }
}

// ── Registry operations ──────────────────────────────────────────────

/**
 * Read all projects from nexus.db and return as a NexusRegistryFile.
 * Compatibility wrapper for consumers that expect the legacy JSON shape.
 * Returns null if nexus.db has not been initialized yet.
 */
export async function readRegistry(): Promise<NexusRegistryFile | null> {
  try {
    const { getNexusDb } = await import('../store/nexus-sqlite.js');
    const db = await getNexusDb();
    const rows = await db.select().from(projectRegistry);
    const projects: Record<string, NexusProject> = {};
    let latestUpdate = '';
    for (const row of rows) {
      const p = rowToProject(row);
      projects[p.hash] = p;
      if (p.lastSeen > latestUpdate) latestUpdate = p.lastSeen;
    }
    return {
      schemaVersion: '1.0.0',
      lastUpdated: latestUpdate || new Date().toISOString(),
      projects,
    };
  } catch {
    return null;
  }
}

/**
 * Read the global registry, throwing if not initialized.
 */
export async function readRegistryRequired(): Promise<NexusRegistryFile> {
  const registry = await readRegistry();
  if (!registry) {
    throw new CleoError(
      ExitCode.NEXUS_NOT_INITIALIZED,
      'Nexus registry not initialized. Run: cleo nexus init',
      { fix: 'cleo nexus init' },
    );
  }
  return registry;
}

/**
 * Initialize the NEXUS directory structure and nexus.db.
 * Idempotent -- safe to call multiple times.
 * Migrates legacy JSON registry on first run if present.
 */
export async function nexusInit(_projectRoot = '', _params: NexusInitParams = {}): Promise<void> {
  const nexusHome = getNexusHome();
  const cacheDir = getNexusCacheDir();

  // Create directories
  await mkdir(nexusHome, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  // Initialize nexus.db (runs migrations) then check for legacy migration
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  await getNexusDb();

  // Migrate legacy JSON if nexus.db is empty and JSON exists
  const db = await getNexusDb();
  const existing = await db.select().from(projectRegistry);
  if (existing.length === 0) {
    const { migrateJsonToSqlite } = await import('./migrate-json-to-sqlite.js');
    await migrateJsonToSqlite();
  }
}

/** Check if a path contains a CLEO project (has readable task data). */
async function isCleoProject(projectPath: string): Promise<boolean> {
  try {
    const accessor = await getAccessor(projectPath);
    await accessor.countTasks();
    return true;
  } catch {
    return false;
  }
}

/** Read task metadata from a project's task file. */
async function readProjectMeta(
  projectPath: string,
): Promise<{ taskCount: number; labels: string[] }> {
  try {
    const accessor = await getAccessor(projectPath);
    const { tasks } = await accessor.queryTasks({});
    const allLabels = tasks.flatMap((t) => t.labels ?? []);
    const uniqueLabels = [...new Set(allLabels)].sort();
    return { taskCount: tasks.length, labels: uniqueLabels };
  } catch {
    return { taskCount: 0, labels: [] };
  }
}

/**
 * Read project-info.json from a project directory for projectId.
 * Returns empty string if not available.
 */
async function readProjectId(projectPath: string): Promise<string> {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const infoPath = join(projectPath, '.cleo', 'project-info.json');
    if (!existsSync(infoPath)) return '';
    const data = JSON.parse(readFileSync(infoPath, 'utf-8'));
    return typeof data.projectId === 'string' ? data.projectId : '';
  } catch {
    return '';
  }
}

/**
 * Register a project in the global registry (nexus.db).
 * @returns The project hash.
 */
export async function nexusRegister(
  _projectRoot: string,
  params: NexusRegisterParams,
): Promise<string>;
/** @deprecated Use `nexusRegister(projectRoot, params)` — ADR-057 D1 */
export async function nexusRegister(
  projectPath: string,
  name?: string,
  permissions?: NexusPermissionLevel,
): Promise<string>;
export async function nexusRegister(
  projectRootOrPath: string,
  paramsOrName?: NexusRegisterParams | string,
  permissionsArg?: NexusPermissionLevel,
): Promise<string> {
  let projectPath: string;
  let name: string | undefined;
  let permissions: NexusPermissionLevel;

  if (paramsOrName !== undefined && typeof paramsOrName === 'object') {
    // New normalized signature: (projectRoot, params)
    projectPath = paramsOrName.path;
    name = paramsOrName.name;
    permissions = (paramsOrName.permission as NexusPermissionLevel | undefined) ?? 'read';
  } else {
    // Legacy positional signature
    projectPath = projectRootOrPath;
    name = paramsOrName as string | undefined;
    permissions = permissionsArg ?? 'read';
  }

  if (!projectPath) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project path required');
  }

  // Validate project has readable task data
  if (!(await isCleoProject(projectPath))) {
    throw new CleoError(ExitCode.NOT_FOUND, `Path missing .cleo/tasks.db: ${projectPath}`, {
      fix: `cd ${projectPath} && cleo init`,
    });
  }

  const projectName = name || basename(projectPath) || 'unnamed';
  const projectHash = generateProjectHash(projectPath);

  // Ensure nexus.db is initialized (internal call — projectRoot unused for global registry)
  await nexusInit();
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();

  // Check if already registered
  const existingRows = await db
    .select()
    .from(projectRegistry)
    .where(eq(projectRegistry.projectHash, projectHash));
  const existing = existingRows[0];

  if (existing?.permissions) {
    throw new CleoError(
      ExitCode.NEXUS_PROJECT_EXISTS,
      `Project already registered with hash: ${projectHash}`,
    );
  }

  // Check for name conflicts (new entries only)
  if (!existing) {
    const nameConflictRows = await db
      .select()
      .from(projectRegistry)
      .where(eq(projectRegistry.name, projectName));
    if (nameConflictRows.length > 0) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Project name '${projectName}' already exists in registry`,
      );
    }
  }

  // Read project metadata
  const meta = await readProjectMeta(projectPath);
  const now = new Date().toISOString();
  let projectId = await readProjectId(projectPath);
  const resolvedPath = resolve(projectPath);
  const brainDbPath = join(resolvedPath, '.cleo', 'brain.db');
  const tasksDbPath = join(resolvedPath, '.cleo', 'tasks.db');

  if (existing) {
    // Merge nexus fields into existing entry
    await db
      .update(projectRegistry)
      .set({
        permissions,
        lastSync: now,
        taskCount: meta.taskCount,
        labelsJson: JSON.stringify(meta.labels),
        lastSeen: now,
        brainDbPath,
        tasksDbPath,
      })
      .where(eq(projectRegistry.projectHash, projectHash));
  } else {
    // Generate projectId fallback
    if (!projectId) {
      projectId = randomUUID();
    }

    // Create new entry
    await db.insert(projectRegistry).values({
      projectId,
      projectHash,
      projectPath,
      name: projectName,
      registeredAt: now,
      lastSeen: now,
      healthStatus: 'unknown',
      healthLastCheck: null,
      permissions,
      lastSync: now,
      taskCount: meta.taskCount,
      labelsJson: JSON.stringify(meta.labels),
      brainDbPath,
      tasksDbPath,
      statsJson: '{}',
    });
  }

  await writeNexusAudit({
    action: 'register',
    projectHash,
    projectId,
    operation: 'register',
    success: true,
  });

  return projectHash;
}

/**
 * Unregister a project from the global registry.
 */
export async function nexusUnregister(
  _projectRoot: string,
  params: NexusUnregisterParams,
): Promise<void>;
/** @deprecated Use `nexusUnregister(projectRoot, params)` — ADR-057 D1 */
export async function nexusUnregister(nameOrHash: string): Promise<void>;
export async function nexusUnregister(
  projectRootOrNameOrHash: string,
  paramsOrUndefined?: NexusUnregisterParams,
): Promise<void> {
  const nameOrHash =
    paramsOrUndefined !== undefined ? paramsOrUndefined.name : projectRootOrNameOrHash;
  if (!nameOrHash) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project name or hash required');
  }

  const project = await nexusGetProject(nameOrHash);
  if (!project) {
    throw new CleoError(ExitCode.NOT_FOUND, `Project not found in registry: ${nameOrHash}`);
  }

  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();
  await db.delete(projectRegistry).where(eq(projectRegistry.projectHash, project.hash));

  await writeNexusAudit({
    action: 'unregister',
    projectHash: project.hash,
    projectId: project.projectId,
    operation: 'unregister',
    success: true,
  });
}

/**
 * List all registered projects.
 */
export async function nexusList(
  _projectRoot = '',
  _params: NexusListParams = {},
): Promise<NexusProject[]> {
  try {
    const { getNexusDb } = await import('../store/nexus-sqlite.js');
    const db = await getNexusDb();
    const rows = await db.select().from(projectRegistry);
    return rows.map(rowToProject);
  } catch {
    return [];
  }
}

/**
 * Get a project by name or hash.
 * Returns null if not found.
 */
export async function nexusGetProject(
  _projectRoot: string,
  params: NexusShowParams,
): Promise<NexusProject | null>;
/** @deprecated Use `nexusGetProject(projectRoot, params)` — ADR-057 D1 */
export async function nexusGetProject(nameOrHash: string): Promise<NexusProject | null>;
export async function nexusGetProject(
  projectRootOrNameOrHash: string,
  paramsOrUndefined?: NexusShowParams,
): Promise<NexusProject | null> {
  const nameOrHash =
    paramsOrUndefined !== undefined ? paramsOrUndefined.name : projectRootOrNameOrHash;
  try {
    const { getNexusDb } = await import('../store/nexus-sqlite.js');
    const { eq, or } = await import('drizzle-orm');
    const db = await getNexusDb();

    // Try hash match first, then name
    const rows = await db
      .select()
      .from(projectRegistry)
      .where(or(eq(projectRegistry.projectHash, nameOrHash), eq(projectRegistry.name, nameOrHash)));

    const row = rows[0];
    if (!row) return null;
    return rowToProject(row);
  } catch {
    return null;
  }
}

/**
 * Check if a project exists in the registry.
 */
export async function nexusProjectExists(nameOrHash: string): Promise<boolean> {
  const project = await nexusGetProject(nameOrHash);
  return project !== null;
}

/**
 * Sync project metadata (task count, labels) for a registered project.
 */
export async function nexusSync(_projectRoot: string, params: NexusSyncParams): Promise<void>;
/** @deprecated Use `nexusSync(projectRoot, params)` — ADR-057 D1 */
export async function nexusSync(nameOrHash: string): Promise<void>;
export async function nexusSync(
  projectRootOrName: string,
  paramsOrUndefined?: NexusSyncParams,
): Promise<void> {
  const nameOrHash =
    paramsOrUndefined !== undefined ? (paramsOrUndefined.name ?? '') : projectRootOrName;
  if (!nameOrHash) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project name or hash required');
  }

  const project = await nexusGetProject(nameOrHash);
  if (!project) {
    throw new CleoError(ExitCode.NOT_FOUND, `Project not found in registry: ${nameOrHash}`);
  }

  const meta = await readProjectMeta(project.path);
  const now = new Date().toISOString();
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();

  await db
    .update(projectRegistry)
    .set({
      taskCount: meta.taskCount,
      labelsJson: JSON.stringify(meta.labels),
      lastSync: now,
      lastSeen: now,
    })
    .where(eq(projectRegistry.projectHash, project.hash));

  await writeNexusAudit({
    action: 'sync',
    projectHash: project.hash,
    projectId: project.projectId,
    operation: 'sync',
    success: true,
  });
}

/**
 * Sync all registered projects.
 * @returns Counts of synced and failed projects.
 */
export async function nexusSyncAll(): Promise<{ synced: number; failed: number }> {
  const projects = await nexusList();
  let synced = 0;
  let failed = 0;
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();

  for (const project of projects) {
    try {
      const meta = await readProjectMeta(project.path);
      const now = new Date().toISOString();
      await db
        .update(projectRegistry)
        .set({
          taskCount: meta.taskCount,
          labelsJson: JSON.stringify(meta.labels),
          lastSync: now,
          lastSeen: now,
        })
        .where(eq(projectRegistry.projectHash, project.hash));
      synced++;
    } catch {
      failed++;
    }
  }

  await writeNexusAudit({
    action: 'sync-all',
    operation: 'sync-all',
    success: true,
    details: { synced, failed },
  });

  return { synced, failed };
}

/**
 * Update code intelligence index stats for a registered project.
 *
 * Called after a successful `cleo nexus analyze` run to record the
 * latest node/relation/file counts and the indexed timestamp.
 *
 * @param projectPath - Absolute path to the project root.
 * @param stats       - Results from the pipeline run.
 * @task T622
 */
export async function nexusUpdateIndexStats(
  projectPath: string,
  stats: NexusProjectStats,
): Promise<void> {
  if (!projectPath) return;

  const projectHash = generateProjectHash(projectPath);
  const now = new Date().toISOString();

  try {
    const { getNexusDb } = await import('../store/nexus-sqlite.js');
    const { eq } = await import('drizzle-orm');
    const db = await getNexusDb();

    const rows = await db
      .select()
      .from(projectRegistry)
      .where(eq(projectRegistry.projectHash, projectHash));

    if (rows.length === 0) {
      // Not yet registered — auto-register first (best effort)
      try {
        await nexusRegister(projectPath);
      } catch {
        // Already registered or cannot register — ignore
      }
    }

    await db
      .update(projectRegistry)
      .set({
        lastIndexed: now,
        statsJson: JSON.stringify(stats),
        lastSeen: now,
      })
      .where(eq(projectRegistry.projectHash, projectHash));

    await writeNexusAudit({
      action: 'update-index-stats',
      projectHash,
      operation: 'update-index-stats',
      success: true,
      details: {
        nodeCount: stats.nodeCount,
        relationCount: stats.relationCount,
        fileCount: stats.fileCount,
      },
    });
  } catch (err) {
    // Non-fatal — index stats update must never break the analyze pipeline
    getLogger('nexus').warn({ err }, 'nexus: failed to update index stats');
  }
}

/**
 * Update a project's permission level in the registry.
 * Used by permissions.ts to avoid direct JSON file writes.
 */
export async function nexusSetPermission(
  _projectRoot: string,
  params: NexusPermissionSetParams,
): Promise<void>;
/** @deprecated Use `nexusSetPermission(projectRoot, params)` — ADR-057 D1 */
export async function nexusSetPermission(
  nameOrHash: string,
  permission: NexusPermissionLevel,
): Promise<void>;
export async function nexusSetPermission(
  projectRootOrName: string,
  paramsOrPermission?: NexusPermissionSetParams | NexusPermissionLevel,
): Promise<void> {
  let nameOrHash: string;
  let permission: NexusPermissionLevel;
  if (paramsOrPermission !== undefined && typeof paramsOrPermission === 'object') {
    nameOrHash = paramsOrPermission.name;
    permission = paramsOrPermission.level as NexusPermissionLevel;
  } else {
    nameOrHash = projectRootOrName;
    permission = (paramsOrPermission as NexusPermissionLevel | undefined) ?? 'read';
  }
  const project = await nexusGetProject(nameOrHash);
  if (!project) {
    throw new CleoError(ExitCode.NOT_FOUND, `Project not found in registry: ${nameOrHash}`);
  }

  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();
  await db
    .update(projectRegistry)
    .set({ permissions: permission })
    .where(eq(projectRegistry.projectHash, project.hash));

  await writeNexusAudit({
    action: 'set-permission',
    projectHash: project.hash,
    projectId: project.projectId,
    operation: 'set-permission',
    success: true,
    details: { permission },
  });
}

/**
 * Reconcile the current project's identity with the global nexus registry.
 *
 * 4-scenario policy:
 *   1. projectId in registry + path matches → update lastSeen, return {status:'ok'}
 *   2. projectId in registry + path changed → update path+hash, return {status:'path_updated'}
 *   3. projectId not in registry → auto-register, return {status:'auto_registered'}
 *   4. projectHash matches but different projectId → throw CleoError (identity conflict)
 *
 * Uses projectId as the stable identifier across project moves, since
 * projectHash is derived from the absolute path and changes when moved.
 *
 * @task T5368
 */
export async function nexusReconcile(
  projectRoot: string,
  _params: NexusReconcileParams = {},
): Promise<{
  status: 'ok' | 'path_updated' | 'auto_registered';
  oldPath?: string;
  newPath?: string;
}> {
  if (!projectRoot) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project root path required');
  }

  await nexusInit();
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();

  const projectId = await readProjectId(projectRoot);
  const currentHash = generateProjectHash(projectRoot);

  // Scenario 4 check: hash matches but different projectId
  if (projectId) {
    const hashRows = await db
      .select()
      .from(projectRegistry)
      .where(eq(projectRegistry.projectHash, currentHash));
    const hashMatch = hashRows[0];
    if (hashMatch && hashMatch.projectId !== projectId) {
      await writeNexusAudit({
        action: 'reconcile',
        projectHash: currentHash,
        projectId,
        operation: 'reconcile',
        success: false,
        errorMessage: `Identity conflict: hash ${currentHash} registered to '${hashMatch.projectId}', current project is '${projectId}'`,
      });
      throw new CleoError(
        ExitCode.NEXUS_REGISTRY_CORRUPT,
        `Project identity conflict: hash ${currentHash} is registered to projectId '${hashMatch.projectId}' but current project has projectId '${projectId}'`,
        { fix: 'Manually resolve the conflict with `cleo nexus unregister` and re-register' },
      );
    }
  }

  // Look up by projectId (stable across moves)
  if (projectId) {
    const idRows = await db
      .select()
      .from(projectRegistry)
      .where(eq(projectRegistry.projectId, projectId));
    const existing = idRows[0];

    if (existing) {
      const now = new Date().toISOString();

      if (existing.projectPath === projectRoot) {
        // Scenario 1: path matches — just update lastSeen
        await db
          .update(projectRegistry)
          .set({ lastSeen: now })
          .where(eq(projectRegistry.projectId, projectId));
        await writeNexusAudit({
          action: 'reconcile',
          projectHash: currentHash,
          projectId,
          operation: 'reconcile',
          success: true,
          details: { status: 'ok' },
        });
        return { status: 'ok' };
      }

      // Scenario 2: path changed — update path, hash, and lastSeen
      const oldPath = existing.projectPath;
      await db
        .update(projectRegistry)
        .set({
          projectPath: projectRoot,
          projectHash: currentHash,
          lastSeen: now,
        })
        .where(eq(projectRegistry.projectId, projectId));
      await writeNexusAudit({
        action: 'reconcile',
        projectHash: currentHash,
        projectId,
        operation: 'reconcile',
        success: true,
        details: { status: 'path_updated', oldPath, newPath: projectRoot },
      });
      return { status: 'path_updated', oldPath, newPath: projectRoot };
    }
  }

  // Also check by hash for projects without a projectId
  const hashRows = await db
    .select()
    .from(projectRegistry)
    .where(eq(projectRegistry.projectHash, currentHash));
  const hashMatch = hashRows[0];

  if (hashMatch) {
    const now = new Date().toISOString();
    await db
      .update(projectRegistry)
      .set({ lastSeen: now })
      .where(eq(projectRegistry.projectHash, currentHash));
    await writeNexusAudit({
      action: 'reconcile',
      projectHash: currentHash,
      operation: 'reconcile',
      success: true,
      details: { status: 'ok' },
    });
    return { status: 'ok' };
  }

  // Scenario 3: not in registry — auto-register
  try {
    await nexusRegister(projectRoot);
  } catch (err) {
    const errStr = String(err);
    if (!errStr.includes('already registered') && !errStr.includes('NEXUS_PROJECT_EXISTS')) {
      throw err;
    }
  }
  await writeNexusAudit({
    action: 'reconcile',
    projectHash: currentHash,
    projectId: projectId || undefined,
    operation: 'reconcile',
    success: true,
    details: { status: 'auto_registered' },
  });
  return { status: 'auto_registered' };
}

/**
 * Reset the nexus database singleton state.
 * Re-exported from nexus-sqlite for test convenience.
 */
export { resetNexusDbState };

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1569 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

/**
 * Convert a caught error to an EngineResult failure.
 */
function caughtToEngineError<T>(error: unknown, fallbackMsg: string): EngineResult<T> {
  const e = error instanceof Error ? error : null;
  return engineError<T>('E_INTERNAL', e?.message ?? fallbackMsg);
}

/**
 * Get nexus status (initialized, project count, last updated).
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusStatus(): Promise<
  EngineResult<{
    initialized: boolean;
    projectCount: number;
    lastUpdated: string | null;
  }>
> {
  try {
    const registry = await readRegistry();
    const initialized = registry !== null;
    const projectCount = initialized ? Object.keys(registry.projects).length : 0;
    return engineSuccess({
      initialized,
      projectCount,
      lastUpdated: registry?.lastUpdated ?? null,
    });
  } catch (error) {
    return caughtToEngineError(error, 'Failed to get nexus status');
  }
}

/**
 * List all registered projects with pagination.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusListProjects(
  limit?: number,
  offset?: number,
): Promise<
  EngineResult<{
    projects: Awaited<ReturnType<typeof nexusList>>;
    count: number;
    total: number;
    filtered: number;
    page: ReturnType<typeof paginate>['page'];
  }>
> {
  try {
    const projects = await nexusList('', {});
    const page = paginate(projects, limit, offset);
    return {
      success: true,
      data: {
        projects: page.items as Awaited<ReturnType<typeof nexusList>>,
        count: projects.length,
        total: projects.length,
        filtered: projects.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return caughtToEngineError(error, 'Failed to list projects');
  }
}

/**
 * Show a single project by name.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusShowProject(
  name: string,
): Promise<EngineResult<Awaited<ReturnType<typeof nexusGetProject>>>> {
  try {
    const project = await nexusGetProject('', { name });
    if (!project) {
      return engineError('E_NOT_FOUND', `Project not found: ${name}`);
    }
    return engineSuccess(project);
  } catch (error) {
    return caughtToEngineError(error, `Failed to show project: ${name}`);
  }
}

/**
 * Initialize the nexus.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusInitialize(): Promise<EngineResult<{ message: string }>> {
  try {
    await nexusInit('', {});
    return engineSuccess({ message: 'NEXUS initialized successfully' });
  } catch (error) {
    return caughtToEngineError(error, 'Failed to initialize nexus');
  }
}

/**
 * Register a project in the nexus.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusRegisterProject(
  path: string,
  name?: string,
  permission: NexusPermissionLevel = 'read',
): Promise<EngineResult<{ hash: string; message: string }>> {
  try {
    const hash = await nexusRegister('', { path, name, permission });
    return engineSuccess({ hash, message: `Project registered with hash: ${hash}` });
  } catch (error) {
    return caughtToEngineError(error, `Failed to register project: ${path}`);
  }
}

/**
 * Unregister a project from the nexus.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusUnregisterProject(
  name: string,
): Promise<EngineResult<{ message: string }>> {
  try {
    await nexusUnregister('', { name });
    return engineSuccess({ message: `Project unregistered: ${name}` });
  } catch (error) {
    return caughtToEngineError(error, `Failed to unregister project: ${name}`);
  }
}

/**
 * Sync a specific project or all projects.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusSyncProject(name?: string): Promise<EngineResult<unknown>> {
  try {
    if (name) {
      await nexusSync('', { name });
      return engineSuccess({ message: `Project synced: ${name}` });
    }
    const result = await nexusSyncAll();
    return engineSuccess(result);
  } catch (error) {
    return caughtToEngineError(error, 'Failed to sync project');
  }
}

/**
 * Reconcile the nexus registry with the filesystem.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusReconcileProject(
  projectRoot: string,
): Promise<EngineResult<Awaited<ReturnType<typeof nexusReconcile>>>> {
  try {
    const result = await nexusReconcile(projectRoot, {});
    return engineSuccess(result);
  } catch (error) {
    return caughtToEngineError(error, `Failed to reconcile project: ${projectRoot}`);
  }
}

/**
 * List all projects in the global nexus registry (Phase 2 dispatch op).
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProjectsList(): Promise<EngineResult<unknown>> {
  try {
    const list = await nexusList('', {});
    return engineSuccess({ projects: list, count: list.length });
  } catch (error) {
    return caughtToEngineError(error, 'Failed to list nexus projects');
  }
}

/**
 * Register a project in the global nexus registry (Phase 2 dispatch op).
 *
 * @param repoPath - Absolute path to the project directory.
 * @param name     - Custom project name (optional).
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProjectsRegister(
  repoPath: string,
  name?: string,
): Promise<EngineResult<{ hash: string; path: string }>> {
  try {
    const hash = await nexusRegister(repoPath, name);
    return engineSuccess({ hash, path: repoPath });
  } catch (error) {
    return caughtToEngineError(error, `Failed to register project: ${repoPath}`);
  }
}

/**
 * Remove a project from the global nexus registry by name or hash (Phase 2 dispatch op).
 *
 * @param nameOrHash - Project name or hash to remove.
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProjectsRemove(
  nameOrHash: string,
): Promise<EngineResult<{ removed: string }>> {
  try {
    await nexusUnregister(nameOrHash);
    return engineSuccess({ removed: nameOrHash });
  } catch (error) {
    return caughtToEngineError(error, `Failed to remove project: ${nameOrHash}`);
  }
}
