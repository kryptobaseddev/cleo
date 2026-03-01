/**
 * Canonical JSON file integrity checker for the SQLite era.
 *
 * Validates the JSON files that remain active per ADR-006:
 * config.json, project-info.json, project-context.json, .context-state.json
 *
 * Table-driven design — add a new file by adding one entry to INTEGRITY_TARGETS.
 * Uses AJV (via src/core/schema.ts) and reads schema versions from schema files
 * at runtime; no hardcoded version strings.
 *
 * @task T4862
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDirAbsolute } from '../paths.js';
import { checkSchema } from '../schema.js';
import { resolveSchemaPath, getSchemaVersion } from '../schema-management.js';

// ============================================================================
// Types
// ============================================================================

/** Configuration for a single JSON file to check. */
interface IntegrityTarget {
  label: string;
  /** Absolute path to the file given the .cleo directory. */
  filePath: (cleoDir: string) => string;
  /** Filename only — resolved against schemas/ at runtime. */
  schemaName: string;
  /** Whether the file is required to exist. */
  required: boolean;
  /** Field in the data file that holds the schema version. */
  versionKey: 'schemaVersion' | 'version';
}

/** Result for a single file check. */
export interface JsonFileIntegrityResult {
  label: string;
  status: 'ok' | 'missing' | 'invalid' | 'version_mismatch' | 'schema_not_found';
  errors: string[];
  /** Version found in the data file. */
  dataVersion?: string;
  /** Version declared in the schema file. */
  expectedVersion?: string;
}

/** Full integrity report for all JSON files. */
export interface SchemaIntegrityReport {
  files: JsonFileIntegrityResult[];
  /** SQLite schema_meta.schemaVersion — null if DB not accessible. */
  sqliteVersion: string | null;
  allOk: boolean;
}

// ============================================================================
// Table of files to check
// ============================================================================

const INTEGRITY_TARGETS: IntegrityTarget[] = [
  {
    label: 'config.json',
    filePath: (d) => join(d, 'config.json'),
    schemaName: 'config.schema.json',
    required: true,
    versionKey: 'schemaVersion',
  },
  {
    label: 'project-info.json',
    filePath: (d) => join(d, 'project-info.json'),
    schemaName: 'project-info.schema.json',
    required: false,
    versionKey: 'schemaVersion',
  },
  {
    label: 'project-context.json',
    filePath: (d) => join(d, 'project-context.json'),
    schemaName: 'project-context.schema.json',
    required: false,
    versionKey: 'schemaVersion',
  },
  {
    label: '.context-state.json',
    filePath: (d) => join(d, '.context-state.json'),
    schemaName: 'context-state.schema.json',
    required: false,
    versionKey: 'version',
  },
];

// ============================================================================
// Schema path resolution
// ============================================================================

/**
 * Read the top-level `schemaVersion` field from a schema file.
 * Delegates to the centralized schema-management module.
 * Returns null if the file cannot be read or has no such field.
 */
export function readSchemaVersionFromFile(schemaName: string): string | null {
  return getSchemaVersion(schemaName);
}

// ============================================================================
// Single file checker
// ============================================================================

function checkFile(target: IntegrityTarget, cleoDir: string): JsonFileIntegrityResult {
  const filePath = target.filePath(cleoDir);

  // File missing
  if (!existsSync(filePath)) {
    if (target.required) {
      return {
        label: target.label,
        status: 'missing',
        errors: [`Required file not found: ${filePath}`],
      };
    }
    // Optional files that don't exist are fine
    return { label: target.label, status: 'ok', errors: [] };
  }

  // Parse file
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    return {
      label: target.label,
      status: 'invalid',
      errors: [`JSON parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Load schema
  const schemaPath = resolveSchemaPath(target.schemaName);
  if (!schemaPath) {
    return {
      label: target.label,
      status: 'schema_not_found',
      errors: [`Schema file not found: ${target.schemaName}`],
    };
  }

  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    return {
      label: target.label,
      status: 'schema_not_found',
      errors: [`Schema file unreadable: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // AJV validation
  const ajvErrors = checkSchema(data, schema);
  if (ajvErrors.length > 0) {
    return {
      label: target.label,
      status: 'invalid',
      errors: ajvErrors,
    };
  }

  // Version comparison
  const dataVersion = data[target.versionKey];
  const expectedVersion = getSchemaVersion(target.schemaName);

  const dataVersionStr = typeof dataVersion === 'string' ? dataVersion : undefined;
  const result: JsonFileIntegrityResult = {
    label: target.label,
    status: 'ok',
    errors: [],
    dataVersion: dataVersionStr,
    expectedVersion: expectedVersion ?? undefined,
  };

  if (dataVersionStr && expectedVersion && dataVersionStr !== expectedVersion) {
    result.status = 'version_mismatch';
    result.errors = [
      `Version mismatch: file has ${dataVersionStr}, schema expects ${expectedVersion}. Run: cleo upgrade`,
    ];
  }

  return result;
}

// ============================================================================
// SQLite version reader
// ============================================================================

async function readSqliteVersion(cwd?: string): Promise<string | null> {
  try {
    const { getDb } = await import('../../store/sqlite.js');
    const schemaTable = await import('../../store/schema.js');
    const db = await getDb(cwd);
    const rows = await db
      .select()
      .from(schemaTable.schemaMeta)
      .limit(10);
    const row = rows.find((r) => r.key === 'schemaVersion');
    return row?.value ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check integrity of all active JSON files in a CLEO project.
 *
 * @param cwd - Project root (defaults to process.cwd())
 */
export async function checkSchemaIntegrity(
  cwd?: string,
): Promise<SchemaIntegrityReport> {
  const cleoDir = getCleoDirAbsolute(cwd);
  const files = INTEGRITY_TARGETS.map((t) => checkFile(t, cleoDir));
  const sqliteVersion = await readSqliteVersion(cwd);

  const allOk = files.every(
    (f) => f.status === 'ok' || f.status === 'schema_not_found',
  );

  return { files, sqliteVersion, allOk };
}
