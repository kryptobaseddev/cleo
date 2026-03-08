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
import { basename, join } from 'node:path';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { getAccessor } from '../../store/data-accessor.js';
import type { ProjectRegistryRow } from '../../store/nexus-schema.js';
import { nexusAuditLog, projectRegistry } from '../../store/nexus-schema.js';
import { getNexusDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { ExitCode } from '../../types/exit-codes.js';
import { CleoError } from '../errors.js';
import { getLogger } from '../logger.js';
import { getCleoHome } from '../paths.js';
import { generateProjectHash } from './hash.js';

// ── Schemas ──────────────────────────────────────────────────────────

export const NexusPermissionLevelSchema = z.enum(['read', 'write', 'execute']);
export type NexusPermissionLevel = z.infer<typeof NexusPermissionLevelSchema>;

export const NexusHealthStatusSchema = z.enum(['unknown', 'healthy', 'degraded', 'unreachable']);
export type NexusHealthStatus = z.infer<typeof NexusHealthStatusSchema>;

export const NexusProjectSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{12}$/),
  projectId: z.string().default(''),
  path: z.string().min(1),
  name: z.string().min(1).max(64),
  registeredAt: z.string(),
  lastSeen: z.string(),
  healthStatus: NexusHealthStatusSchema.default('unknown'),
  healthLastCheck: z.string().nullable().default(null),
  permissions: NexusPermissionLevelSchema.default('read'),
  lastSync: z.string(),
  taskCount: z.number().int().min(0).default(0),
  labels: z.array(z.string()).default([]),
});
export type NexusProject = z.infer<typeof NexusProjectSchema>;

export const NexusRegistryFileSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.string().default('1.0.0'),
  lastUpdated: z.string(),
  projects: z.record(z.string(), NexusProjectSchema),
});
export type NexusRegistryFile = z.infer<typeof NexusRegistryFileSchema>;

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
export async function nexusInit(): Promise<void> {
  const nexusHome = getNexusHome();
  const cacheDir = getNexusCacheDir();

  // Create directories
  await mkdir(nexusHome, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  // Initialize nexus.db (runs migrations)
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
    await accessor.loadTaskFile();
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
    const taskFile = await accessor.loadTaskFile();
    const tasks = taskFile.tasks ?? [];
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
  projectPath: string,
  name?: string,
  permissions: NexusPermissionLevel = 'read',
): Promise<string> {
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

  // Ensure nexus.db is initialized
  await nexusInit();
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
export async function nexusUnregister(nameOrHash: string): Promise<void> {
  if (!nameOrHash) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project name or hash required');
  }

  const project = await nexusGetProject(nameOrHash);
  if (!project) {
    throw new CleoError(ExitCode.NOT_FOUND, `Project not found in registry: ${nameOrHash}`);
  }

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
export async function nexusList(): Promise<NexusProject[]> {
  try {
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
export async function nexusGetProject(nameOrHash: string): Promise<NexusProject | null> {
  try {
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
export async function nexusSync(nameOrHash: string): Promise<void> {
  if (!nameOrHash) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project name or hash required');
  }

  const project = await nexusGetProject(nameOrHash);
  if (!project) {
    throw new CleoError(ExitCode.NOT_FOUND, `Project not found in registry: ${nameOrHash}`);
  }

  const meta = await readProjectMeta(project.path);
  const now = new Date().toISOString();
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
 * Update a project's permission level in the registry.
 * Used by permissions.ts to avoid direct JSON file writes.
 */
export async function nexusSetPermission(
  nameOrHash: string,
  permission: NexusPermissionLevel,
): Promise<void> {
  const project = await nexusGetProject(nameOrHash);
  if (!project) {
    throw new CleoError(ExitCode.NOT_FOUND, `Project not found in registry: ${nameOrHash}`);
  }

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
export async function nexusReconcile(projectRoot: string): Promise<{
  status: 'ok' | 'path_updated' | 'auto_registered';
  oldPath?: string;
  newPath?: string;
}> {
  if (!projectRoot) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project root path required');
  }

  await nexusInit();
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
