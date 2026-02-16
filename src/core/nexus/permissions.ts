/**
 * NEXUS permission enforcement - three-tier access control for cross-project operations.
 *
 * Permission model:
 *   read (1)    - Query tasks, discover relationships
 *   write (2)   - read + modify task fields, add relationships
 *   execute (3) - write + create/delete tasks, run commands
 *
 * Hierarchical: execute includes write includes read.
 * Same-project operations always have full permissions.
 *
 * @task T4574
 * @epic T4540
 */

import { z } from 'zod';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { nexusGetProject, generateProjectHash, readRegistryRequired, getRegistryPath, type NexusPermissionLevel } from './registry.js';
import { saveJson } from '../../store/json.js';

// ── Schemas ──────────────────────────────────────────────────────────

export const PermissionLevelSchema = z.enum(['read', 'write', 'execute']);

export const PermissionCheckResultSchema = z.object({
  project: z.string(),
  required: PermissionLevelSchema,
  granted: PermissionLevelSchema,
  allowed: z.boolean(),
});
export type PermissionCheckResult = z.infer<typeof PermissionCheckResultSchema>;

// ── Constants ────────────────────────────────────────────────────────

const PERMISSION_LEVELS: Record<NexusPermissionLevel, number> = {
  read: 1,
  write: 2,
  execute: 3,
};

// ── Functions ────────────────────────────────────────────────────────

/**
 * Convert a permission string to its numeric level.
 * Returns 0 for invalid/unknown permissions.
 */
export function permissionLevel(permission: string): number {
  return PERMISSION_LEVELS[permission as NexusPermissionLevel] ?? 0;
}

/**
 * Get the permission level for a registered project.
 * Returns 'read' as default if the project has no explicit permission.
 */
export async function getPermission(nameOrHash: string): Promise<NexusPermissionLevel> {
  const project = await nexusGetProject(nameOrHash);
  if (!project) return 'read';
  return project.permissions ?? 'read';
}

/**
 * Check if a project has sufficient permissions (non-throwing).
 * Uses hierarchical comparison: execute >= write >= read.
 *
 * @returns true if the granted permission meets or exceeds the required level.
 */
export async function checkPermission(
  nameOrHash: string,
  required: NexusPermissionLevel,
): Promise<boolean> {
  // Test bypass
  if (process.env['NEXUS_SKIP_PERMISSION_CHECK'] === 'true') {
    return true;
  }

  const granted = await getPermission(nameOrHash);
  return permissionLevel(granted) >= permissionLevel(required);
}

/**
 * Require a permission level or throw CleoError.
 * Used as a guard at the start of cross-project operations.
 */
export async function requirePermission(
  nameOrHash: string,
  required: NexusPermissionLevel,
  operationName = 'operation',
): Promise<void> {
  // Test bypass
  if (process.env['NEXUS_SKIP_PERMISSION_CHECK'] === 'true') {
    return;
  }

  const granted = await getPermission(nameOrHash);
  if (permissionLevel(granted) < permissionLevel(required)) {
    throw new CleoError(
      ExitCode.NEXUS_PERMISSION_DENIED,
      `Permission denied: '${required}' required for '${operationName}' on project '${nameOrHash}' (granted: ${granted})`,
    );
  }
}

/**
 * Full permission check returning a structured result.
 */
export async function checkPermissionDetail(
  nameOrHash: string,
  required: NexusPermissionLevel,
): Promise<PermissionCheckResult> {
  const granted = await getPermission(nameOrHash);
  return {
    project: nameOrHash,
    required,
    granted,
    allowed: permissionLevel(granted) >= permissionLevel(required),
  };
}

/**
 * Set the permission level for a project.
 * Validates the permission value and updates the registry.
 * @task T4574
 */
export async function setPermission(
  nameOrHash: string,
  permission: NexusPermissionLevel,
): Promise<void> {
  if (!nameOrHash) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project name or hash required');
  }

  const project = await nexusGetProject(nameOrHash);
  if (!project) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Project not found in registry: ${nameOrHash}`,
    );
  }

  const projectHash = generateProjectHash(project.path);
  const registry = await readRegistryRequired();

  if (!registry.projects[projectHash]) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Project not found in registry: ${nameOrHash}`,
    );
  }

  registry.projects[projectHash].permissions = permission;
  registry.lastUpdated = new Date().toISOString();
  await saveJson(getRegistryPath(), registry);
}

/** Convenience: check read access. */
export async function canRead(nameOrHash: string): Promise<boolean> {
  return checkPermission(nameOrHash, 'read');
}

/** Convenience: check write access. */
export async function canWrite(nameOrHash: string): Promise<boolean> {
  return checkPermission(nameOrHash, 'write');
}

/** Convenience: check execute access. */
export async function canExecute(nameOrHash: string): Promise<boolean> {
  return checkPermission(nameOrHash, 'execute');
}
