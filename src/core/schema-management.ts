/**
 * Centralized schema path resolution and global schema management.
 *
 * This module is the SINGLE source of truth for resolving schema file
 * paths at runtime. Both schema-integrity.ts and schema-validator.ts
 * should delegate to this module instead of maintaining their own
 * resolveSchemaPath() implementations.
 *
 * Resolution priority:
 *   1. ~/.cleo/schemas/{name}  (global install via getCleoSchemasDir)
 *   2. Package schemas/{name}  (bundled fallback via getPackageRoot)
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoSchemasDir } from './paths.js';
import { getPackageRoot } from './scaffold.js';

// ============================================================================
// Types
// ============================================================================

export interface SchemaInstallResult {
  installed: number;
  updated: number;
  total: number;
}

export interface StalenessReport {
  stale: string[];
  current: string[];
  missing: string[];
}

export interface InstalledSchema {
  name: string;
  path: string;
  version: string | null;
}

export interface CheckResult {
  ok: boolean;
  installed: number;
  bundled: number;
  missing: string[];
  stale: string[];
}

// ============================================================================
// Core resolution
// ============================================================================

/**
 * Resolve the absolute path to a schema file at runtime.
 *
 * Priority:
 *   1. Global install: ~/.cleo/schemas/{schemaName}
 *   2. Package bundled: <packageRoot>/schemas/{schemaName}
 *
 * @param schemaName - Filename of the schema (e.g. "config.schema.json")
 * @returns Absolute path to the schema file, or null if not found
 */
export function resolveSchemaPath(schemaName: string): string | null {
  // 1. Global install location
  const globalPath = join(getCleoSchemasDir(), schemaName);
  if (existsSync(globalPath)) {
    return globalPath;
  }

  // 2. Package bundled fallback
  const packageRoot = getPackageRoot();
  const bundledPath = join(packageRoot, 'schemas', schemaName);
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  return null;
}

// ============================================================================
// Version reading
// ============================================================================

/**
 * Read the schema version from a resolved schema file.
 *
 * Checks `schemaVersion` (top-level) and `_meta.schemaVersion` (canonical).
 *
 * @param schemaName - Filename of the schema (e.g. "config.schema.json")
 * @returns The version string, or null if not found or unreadable
 */
export function getSchemaVersion(schemaName: string): string | null {
  const schemaPath = resolveSchemaPath(schemaName);
  if (!schemaPath) return null;

  try {
    const raw = readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(raw) as Record<string, unknown>;

    // Check top-level schemaVersion first, then _meta.schemaVersion
    const topLevel = schema['schemaVersion'];
    if (typeof topLevel === 'string') return topLevel;

    const meta = schema['_meta'] as Record<string, unknown> | undefined;
    const metaVersion = meta?.['schemaVersion'];
    if (typeof metaVersion === 'string') return metaVersion;

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Global schema installation
// ============================================================================

/**
 * List all bundled schema files from the package schemas/ directory.
 */
function listBundledSchemas(): string[] {
  const packageRoot = getPackageRoot();
  const schemasDir = join(packageRoot, 'schemas');
  if (!existsSync(schemasDir)) return [];

  try {
    return readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
  } catch {
    return [];
  }
}

/**
 * Read the version from a schema file at a given path.
 */
function readVersionFromPath(schemaPath: string): string | null {
  try {
    const raw = readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(raw) as Record<string, unknown>;
    const topLevel = schema['schemaVersion'];
    if (typeof topLevel === 'string') return topLevel;
    const meta = schema['_meta'] as Record<string, unknown> | undefined;
    const metaVersion = meta?.['schemaVersion'];
    if (typeof metaVersion === 'string') return metaVersion;
    return null;
  } catch {
    return null;
  }
}

/**
 * Copy ALL bundled schemas from package schemas/ to ~/.cleo/schemas/.
 *
 * - Creates the global schemas directory if it doesn't exist.
 * - Skips files that are already up-to-date (same version).
 * - Overwrites stale files (version mismatch).
 *
 * @param opts - Optional settings (currently unused, reserved for future options)
 * @returns Summary of installed, updated, and total schemas
 */
export function ensureGlobalSchemas(_opts?: Record<string, unknown>): SchemaInstallResult {
  const packageRoot = getPackageRoot();
  const bundledDir = join(packageRoot, 'schemas');
  const globalDir = getCleoSchemasDir();
  const bundledFiles = listBundledSchemas();

  let installed = 0;
  let updated = 0;

  if (bundledFiles.length === 0) {
    return { installed: 0, updated: 0, total: 0 };
  }

  // Ensure target directory exists
  if (!existsSync(globalDir)) {
    mkdirSync(globalDir, { recursive: true });
  }

  for (const file of bundledFiles) {
    const source = join(bundledDir, file);
    const target = join(globalDir, file);

    if (!existsSync(target)) {
      // New file — install
      copyFileSync(source, target);
      installed++;
    } else {
      // Existing file — check if stale
      const sourceVersion = readVersionFromPath(source);
      const targetVersion = readVersionFromPath(target);

      if (sourceVersion !== targetVersion) {
        copyFileSync(source, target);
        updated++;
      }
    }
  }

  return {
    installed,
    updated,
    total: bundledFiles.length,
  };
}

// ============================================================================
// Schema health checks
// ============================================================================

/**
 * Verify that global schemas are installed and not stale.
 *
 * @returns Check result with counts and lists of issues
 */
export function checkGlobalSchemas(): CheckResult {
  const globalDir = getCleoSchemasDir();
  const bundledFiles = listBundledSchemas();

  const missing: string[] = [];
  const stale: string[] = [];
  let installedCount = 0;

  const packageRoot = getPackageRoot();
  const bundledDir = join(packageRoot, 'schemas');

  for (const file of bundledFiles) {
    const globalPath = join(globalDir, file);
    if (!existsSync(globalPath)) {
      missing.push(file);
      continue;
    }

    installedCount++;

    const bundledVersion = readVersionFromPath(join(bundledDir, file));
    const globalVersion = readVersionFromPath(globalPath);

    if (bundledVersion !== null && bundledVersion !== globalVersion) {
      stale.push(file);
    }
  }

  return {
    ok: missing.length === 0 && stale.length === 0,
    installed: installedCount,
    bundled: bundledFiles.length,
    missing,
    stale,
  };
}

/**
 * Compare global schema versions against bundled package versions.
 *
 * @returns Report of stale, current, and missing schemas
 */
export function checkSchemaStaleness(): StalenessReport {
  const globalDir = getCleoSchemasDir();
  const bundledFiles = listBundledSchemas();

  const stale: string[] = [];
  const current: string[] = [];
  const missing: string[] = [];

  const packageRoot = getPackageRoot();
  const bundledDir = join(packageRoot, 'schemas');

  for (const file of bundledFiles) {
    const globalPath = join(globalDir, file);
    if (!existsSync(globalPath)) {
      missing.push(file);
      continue;
    }

    const bundledVersion = readVersionFromPath(join(bundledDir, file));
    const globalVersion = readVersionFromPath(globalPath);

    if (bundledVersion !== null && bundledVersion !== globalVersion) {
      stale.push(file);
    } else {
      current.push(file);
    }
  }

  return { stale, current, missing };
}

// ============================================================================
// Inventory
// ============================================================================

/**
 * List all schemas installed in ~/.cleo/schemas/.
 *
 * @returns Array of installed schema details
 */
export function listInstalledSchemas(): InstalledSchema[] {
  const globalDir = getCleoSchemasDir();
  if (!existsSync(globalDir)) return [];

  let files: string[];
  try {
    files = readdirSync(globalDir).filter(f => f.endsWith('.schema.json'));
  } catch {
    return [];
  }

  return files.map(name => {
    const fullPath = join(globalDir, name);
    return {
      name,
      path: fullPath,
      version: readVersionFromPath(fullPath),
    };
  });
}

// ============================================================================
// Project schema cleanup
// ============================================================================

/**
 * Backup and remove deprecated .cleo/schemas/ directory from a project.
 *
 * Schemas should live in ~/.cleo/schemas/ (global) not in project directories.
 * This function creates a backup before removal for safety.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns Whether cleanup was performed
 */
export async function cleanProjectSchemas(projectRoot: string): Promise<{ cleaned: boolean }> {
  const projectSchemasDir = join(projectRoot, '.cleo', 'schemas');

  if (!existsSync(projectSchemasDir)) {
    return { cleaned: false };
  }

  // Verify it's a directory
  try {
    const stat = statSync(projectSchemasDir);
    if (!stat.isDirectory()) {
      return { cleaned: false };
    }
  } catch {
    return { cleaned: false };
  }

  // Create backup with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = join(projectRoot, '.cleo', 'backups', 'schemas');
  const backupTarget = join(backupDir, `schemas-${timestamp}`);

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  // Rename (move) the schemas directory to the backup location
  renameSync(projectSchemasDir, backupTarget);

  return { cleaned: true };
}
