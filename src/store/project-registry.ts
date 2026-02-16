/**
 * Project registration utilities - hybrid registry architecture.
 * Ported from lib/data/project-registry.sh
 *
 * Manages a two-tier registry:
 * - Global registry (~/.cleo/projects-registry.json): Minimal info, system-wide
 * - Per-project info (.cleo/project-info.json): Detailed metadata, project-local
 *
 * get_project_data() merges both sources, with per-project info taking precedence.
 *
 * @task T4552
 * @epic T4545
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, saveJson } from './json.js';
import { getCleoHome } from '../core/paths.js';

/** Global registry file structure. */
export interface ProjectRegistry {
  $schema: string;
  schemaVersion: string;
  lastUpdated: string;
  projects: Record<string, ProjectRegistryEntry>;
}

/** Entry in the global registry (minimal info). */
export interface ProjectRegistryEntry {
  path: string;
  name: string;
  lastAccess: string;
  [key: string]: unknown;
}

/** Per-project info (detailed metadata). */
export interface ProjectLocalInfo {
  description?: string;
  aliases?: string[];
  [key: string]: unknown;
}

/** Merged project data (global + local). */
export interface MergedProjectData extends ProjectRegistryEntry {
  description?: string;
  aliases?: string[];
  [key: string]: unknown;
}

/**
 * Generate a stable 12-character hex hash from a project path.
 * Used as the unique identifier in the project registry.
 * @task T4552
 */
export function generateProjectHash(path: string): string {
  if (!path) {
    throw new Error('Project path required');
  }
  return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

/**
 * Get the global registry file path.
 * @task T4552
 */
export function getRegistryPath(): string {
  return join(getCleoHome(), 'projects-registry.json');
}

/**
 * Get per-project info file path.
 * @task T4552
 */
export function getProjectInfoPath(projectPath?: string): string {
  const base = projectPath ?? process.cwd();
  return join(base, '.cleo', 'project-info.json');
}

/**
 * Check if project has per-project info file.
 * @task T4552
 */
export function hasProjectInfo(projectPath?: string): boolean {
  return existsSync(getProjectInfoPath(projectPath));
}

/**
 * Read per-project info.
 * Returns empty object if the file doesn't exist.
 * @task T4552
 */
export async function getProjectInfo(projectPath?: string): Promise<ProjectLocalInfo> {
  const infoFile = getProjectInfoPath(projectPath);
  const data = await readJson<ProjectLocalInfo>(infoFile);
  return data ?? {};
}

/**
 * Save per-project info using atomic write.
 * Creates the .cleo directory if needed.
 * @task T4552
 */
export async function saveProjectInfo(
  content: ProjectLocalInfo,
  projectPath?: string,
): Promise<void> {
  const infoFile = getProjectInfoPath(projectPath);
  await saveJson(infoFile, content);
}

/**
 * Read the global registry file.
 * Returns null if the file doesn't exist.
 * @task T4552
 */
async function readRegistry(): Promise<ProjectRegistry | null> {
  return readJson<ProjectRegistry>(getRegistryPath());
}

/**
 * Check if a project is registered.
 * @task T4552
 */
export async function isProjectRegistered(projectHash: string): Promise<boolean> {
  if (!projectHash) return false;
  const registry = await readRegistry();
  if (!registry) return false;
  return projectHash in registry.projects;
}

/**
 * Get project data from global registry only (no merge).
 * Useful when you only need minimal registration data.
 * @task T4552
 */
export async function getProjectDataGlobal(
  projectHash: string,
): Promise<ProjectRegistryEntry | null> {
  if (!projectHash) return null;
  const registry = await readRegistry();
  if (!registry) return null;
  return registry.projects[projectHash] ?? null;
}

/**
 * Get project data from registry using the hybrid model.
 * Merges global registry with per-project info; local takes precedence.
 * @task T4552
 */
export async function getProjectData(
  projectHash: string,
): Promise<MergedProjectData | null> {
  if (!projectHash) return null;

  const globalData = await getProjectDataGlobal(projectHash);
  if (!globalData) return null;

  const projectPath = globalData.path;

  // If path doesn't exist, return just global data
  if (!projectPath || !existsSync(projectPath)) {
    return globalData;
  }

  // Check for per-project info file
  if (!hasProjectInfo(projectPath)) {
    return globalData;
  }

  // Get per-project info and merge (local takes precedence)
  const localData = await getProjectInfo(projectPath);
  return { ...globalData, ...localData };
}

/**
 * Create an empty registry file.
 * @task T4552
 */
export async function createEmptyRegistry(registryPath?: string): Promise<void> {
  const path = registryPath ?? getRegistryPath();
  const registry: ProjectRegistry = {
    $schema: './schemas/projects-registry.schema.json',
    schemaVersion: '1.0.0',
    lastUpdated: new Date().toISOString(),
    projects: {},
  };
  await saveJson(path, registry);
}

/**
 * List all registered projects.
 * @task T4552
 */
export async function listRegisteredProjects(): Promise<ProjectRegistryEntry[]> {
  const registry = await readRegistry();
  if (!registry) return [];
  return Object.values(registry.projects);
}

/**
 * Prune projects from registry where the path no longer exists.
 * Returns the list of removed project hashes.
 * @task T4552
 */
export async function pruneRegistry(
  options?: { dryRun?: boolean },
): Promise<string[]> {
  const registryPath = getRegistryPath();
  const registry = await readRegistry();
  if (!registry) return [];

  const removed: string[] = [];

  for (const [hash, entry] of Object.entries(registry.projects)) {
    if (!existsSync(entry.path)) {
      removed.push(hash);
    }
  }

  if (removed.length > 0 && !options?.dryRun) {
    for (const hash of removed) {
      delete registry.projects[hash];
    }
    registry.lastUpdated = new Date().toISOString();
    await saveJson(registryPath, registry);
  }

  return removed;
}

/**
 * Remove a specific project from registry by hash.
 * @task T4552
 */
export async function removeProjectFromRegistry(hash: string): Promise<void> {
  const registryPath = getRegistryPath();
  const registry = await readRegistry();

  if (!registry) {
    throw new Error(`Registry not found at ${registryPath}`);
  }

  if (!(hash in registry.projects)) {
    throw new Error(`Project ${hash} not found in registry`);
  }

  delete registry.projects[hash];
  registry.lastUpdated = new Date().toISOString();
  await saveJson(registryPath, registry);
}
