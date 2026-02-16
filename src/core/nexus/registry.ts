/**
 * NEXUS project registry - cross-project registration and management.
 *
 * Manages the global project registry at ~/.cleo/projects-registry.json.
 * Supports registering, unregistering, listing, and syncing projects
 * for cross-project task coordination.
 *
 * @task T4574
 * @epic T4540
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, access, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoHome } from '../paths.js';
import { readJson, saveJson } from '../../store/json.js';

// ── Schemas ──────────────────────────────────────────────────────────

export const NexusPermissionLevelSchema = z.enum(['read', 'write', 'execute']);
export type NexusPermissionLevel = z.infer<typeof NexusPermissionLevelSchema>;

export const NexusHealthStatusSchema = z.enum(['unknown', 'healthy', 'degraded', 'unreachable']);
export type NexusHealthStatus = z.infer<typeof NexusHealthStatusSchema>;

export const NexusProjectSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{12}$/),
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

/** Get path to the unified projects registry file. */
export function getRegistryPath(): string {
  return process.env['NEXUS_REGISTRY_FILE'] ?? join(getCleoHome(), 'projects-registry.json');
}

// ── Hash ─────────────────────────────────────────────────────────────

/**
 * Generate a 12-character hex hash from a project path.
 * Matches Bash CLI's generate_project_hash() behavior.
 */
export function generateProjectHash(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex');
  return hash.substring(0, 12);
}

// ── Registry operations ──────────────────────────────────────────────

/**
 * Read the global registry file.
 * Returns null if the file does not exist.
 */
export async function readRegistry(): Promise<NexusRegistryFile | null> {
  const data = await readJson<NexusRegistryFile>(getRegistryPath());
  if (!data) return null;
  return NexusRegistryFileSchema.parse(data);
}

/**
 * Read the global registry file, throwing if it does not exist.
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
 * Initialize the NEXUS directory structure and registry file.
 * Idempotent -- safe to call multiple times.
 */
export async function nexusInit(): Promise<void> {
  const nexusHome = getNexusHome();
  const cacheDir = getNexusCacheDir();
  const registryPath = getRegistryPath();

  // Create directories
  await mkdir(nexusHome, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  // Create empty registry if it doesn't exist
  const existing = await readJson(registryPath);
  if (!existing) {
    const now = new Date().toISOString();
    const registry: NexusRegistryFile = {
      $schema: './schemas/projects-registry.schema.json',
      schemaVersion: '1.0.0',
      lastUpdated: now,
      projects: {},
    };
    await saveJson(registryPath, registry);
  }
}

/** Check if a path contains a CLEO project (has .cleo/todo.json). */
async function isCleoProject(projectPath: string): Promise<boolean> {
  try {
    await access(join(projectPath, '.cleo', 'todo.json'));
    return true;
  } catch {
    return false;
  }
}

/** Read task metadata from a project's todo.json. */
async function readProjectMeta(projectPath: string): Promise<{ taskCount: number; labels: string[] }> {
  try {
    const todoPath = join(projectPath, '.cleo', 'todo.json');
    const raw = await readFile(todoPath, 'utf-8');
    const data = JSON.parse(raw) as { tasks: Array<{ labels?: string[] }> };
    const tasks = data.tasks ?? [];
    const allLabels = tasks.flatMap(t => t.labels ?? []);
    const uniqueLabels = [...new Set(allLabels)].sort();
    return { taskCount: tasks.length, labels: uniqueLabels };
  } catch {
    return { taskCount: 0, labels: [] };
  }
}

/**
 * Register a project in the global registry.
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

  // Validate project has .cleo/todo.json
  if (!(await isCleoProject(projectPath))) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Path missing .cleo/todo.json: ${projectPath}`,
      { fix: `cd ${projectPath} && cleo init` },
    );
  }

  const projectName = name || projectPath.split('/').pop() || 'unnamed';
  const projectHash = generateProjectHash(projectPath);

  // Ensure registry exists
  await nexusInit();
  const registry = await readRegistryRequired();

  // Check if already registered
  const existing = registry.projects[projectHash];
  if (existing?.permissions) {
    throw new CleoError(
      ExitCode.NEXUS_PROJECT_EXISTS,
      `Project already registered with hash: ${projectHash}`,
    );
  }

  // Check for name conflicts (new entries only)
  if (!existing) {
    const nameConflict = Object.values(registry.projects).find(p => p.name === projectName);
    if (nameConflict) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Project name '${projectName}' already exists in registry`,
      );
    }
  }

  // Read project metadata
  const meta = await readProjectMeta(projectPath);
  const now = new Date().toISOString();

  if (existing) {
    // Merge nexus fields into existing entry
    existing.permissions = permissions;
    existing.lastSync = now;
    existing.taskCount = meta.taskCount;
    existing.labels = meta.labels;
    existing.lastSeen = now;
  } else {
    // Create new entry
    registry.projects[projectHash] = {
      hash: projectHash,
      path: projectPath,
      name: projectName,
      registeredAt: now,
      lastSeen: now,
      healthStatus: 'unknown',
      healthLastCheck: null,
      permissions,
      lastSync: now,
      taskCount: meta.taskCount,
      labels: meta.labels,
    };
  }

  registry.lastUpdated = now;
  await saveJson(getRegistryPath(), registry);
  return projectHash;
}

/**
 * Unregister a project from the global registry.
 */
export async function nexusUnregister(nameOrHash: string): Promise<void> {
  if (!nameOrHash) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project name or hash required');
  }

  const registry = await readRegistryRequired();
  const hash = resolveProjectHash(registry, nameOrHash);

  if (!hash || !registry.projects[hash]) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Project not found in registry: ${nameOrHash}`,
    );
  }

  delete registry.projects[hash];
  registry.lastUpdated = new Date().toISOString();
  await saveJson(getRegistryPath(), registry);
}

/**
 * List all registered projects.
 */
export async function nexusList(): Promise<NexusProject[]> {
  const registry = await readRegistry();
  if (!registry) return [];
  return Object.values(registry.projects);
}

/**
 * Get a project by name or hash.
 * Returns null if not found.
 */
export async function nexusGetProject(nameOrHash: string): Promise<NexusProject | null> {
  const registry = await readRegistry();
  if (!registry) return null;

  // Try hash first
  if (/^[a-f0-9]{12}$/.test(nameOrHash)) {
    return registry.projects[nameOrHash] ?? null;
  }

  // Try name
  return Object.values(registry.projects).find(p => p.name === nameOrHash) ?? null;
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

  const registry = await readRegistryRequired();
  const hash = resolveProjectHash(registry, nameOrHash);

  if (!hash || !registry.projects[hash]) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Project not found in registry: ${nameOrHash}`,
    );
  }

  const project = registry.projects[hash];
  const meta = await readProjectMeta(project.path);
  const now = new Date().toISOString();

  project.taskCount = meta.taskCount;
  project.labels = meta.labels;
  project.lastSync = now;
  registry.lastUpdated = now;

  await saveJson(getRegistryPath(), registry);
}

/**
 * Sync all registered projects.
 * @returns Counts of synced and failed projects.
 */
export async function nexusSyncAll(): Promise<{ synced: number; failed: number }> {
  const registry = await readRegistryRequired();
  let synced = 0;
  let failed = 0;

  for (const project of Object.values(registry.projects)) {
    try {
      const meta = await readProjectMeta(project.path);
      project.taskCount = meta.taskCount;
      project.labels = meta.labels;
      project.lastSync = new Date().toISOString();
      synced++;
    } catch {
      failed++;
    }
  }

  registry.lastUpdated = new Date().toISOString();
  await saveJson(getRegistryPath(), registry);
  return { synced, failed };
}

// ── Internal helpers ─────────────────────────────────────────────────

/** Resolve a name-or-hash to a registry key (hash). */
function resolveProjectHash(registry: NexusRegistryFile, nameOrHash: string): string | null {
  // Direct hash match
  if (/^[a-f0-9]{12}$/.test(nameOrHash) && registry.projects[nameOrHash]) {
    return nameOrHash;
  }

  // Name lookup
  const entry = Object.entries(registry.projects).find(([, p]) => p.name === nameOrHash);
  return entry ? entry[0] : null;
}
