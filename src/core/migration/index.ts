/**
 * Migration system - schema version detection and migration runner.
 * @task T4468
 * @epic T4454
 */

import { readJson, saveJson } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getTodoPath, getBackupDir, getCleoDirAbsolute, getConfigPath } from '../paths.js';
import { join } from 'node:path';

/** Schema version info. */
export interface SchemaVersion {
  current: string;
  target: string;
  needsMigration: boolean;
}

/** Migration function signature. */
export type MigrationFn = (data: unknown) => unknown;

/** Migration definition. */
export interface MigrationDef {
  fromVersion: string;
  toVersion: string;
  description: string;
  migrate: MigrationFn;
}

/** Migration run result. */
export interface MigrationResult {
  file: string;
  fromVersion: string;
  toVersion: string;
  migrationsApplied: string[];
  success: boolean;
  errors: string[];
  dryRun: boolean;
}

/** Status of all data files. */
export interface MigrationStatus {
  todoJson: SchemaVersion | null;
  configJson: SchemaVersion | null;
  archiveJson: SchemaVersion | null;
}

// Current target schema versions
const TARGET_VERSIONS: Record<string, string> = {
  todo: '2.10.0',
  config: '2.0.0',
  archive: '2.6.0',
  log: '1.0.0',
};

// Migration registry
const MIGRATIONS: Record<string, MigrationDef[]> = {
  todo: [
    {
      fromVersion: '2.6.0',
      toVersion: '2.7.0',
      description: 'Add epicLifecycle and origin fields',
      migrate: (data: unknown) => {
        const d = data as Record<string, unknown>;
        const tasks = d['tasks'] as Array<Record<string, unknown>>;
        for (const task of tasks) {
          if (task['type'] === 'epic' && !task['epicLifecycle']) {
            task['epicLifecycle'] = null;
          }
          if (!task['origin']) {
            task['origin'] = null;
          }
        }
        return d;
      },
    },
    {
      fromVersion: '2.7.0',
      toVersion: '2.8.0',
      description: 'Add verification gates',
      migrate: (data: unknown) => {
        const d = data as Record<string, unknown>;
        const tasks = d['tasks'] as Array<Record<string, unknown>>;
        for (const task of tasks) {
          if (!task['verification']) {
            task['verification'] = null;
          }
        }
        return d;
      },
    },
    {
      fromVersion: '2.8.0',
      toVersion: '2.9.0',
      description: 'Add provenance tracking',
      migrate: (data: unknown) => {
        const d = data as Record<string, unknown>;
        const tasks = d['tasks'] as Array<Record<string, unknown>>;
        for (const task of tasks) {
          if (!task['provenance']) {
            task['provenance'] = null;
          }
        }
        return d;
      },
    },
    {
      fromVersion: '2.9.0',
      toVersion: '2.10.0',
      description: 'Add multi-session support fields',
      migrate: (data: unknown) => {
        const d = data as Record<string, unknown>;
        const meta = d['_meta'] as Record<string, unknown>;
        if (!meta['multiSessionEnabled']) {
          meta['multiSessionEnabled'] = false;
        }
        if (!meta['activeSessionCount']) {
          meta['activeSessionCount'] = 0;
        }
        return d;
      },
    },
  ],
};

/**
 * Detect schema version from a data file.
 * @task T4468
 */
export function detectVersion(data: unknown): string {
  const d = data as Record<string, unknown>;

  // Check _meta.schemaVersion (canonical)
  const meta = d['_meta'] as Record<string, unknown> | undefined;
  if (meta?.['schemaVersion']) {
    return meta['schemaVersion'] as string;
  }

  // Fallback to .version
  if (d['version'] && typeof d['version'] === 'string') {
    return d['version'] as string;
  }

  return '0.0.0';
}

/**
 * Compare two semver strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * @task T4468
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Get migration status for all data files.
 * @task T4468
 */
export async function getMigrationStatus(cwd?: string): Promise<MigrationStatus> {
  const result: MigrationStatus = {
    todoJson: null,
    configJson: null,
    archiveJson: null,
  };

  // Check todo.json
  try {
    const todoData = await readJson(getTodoPath(cwd));
    if (todoData) {
      const current = detectVersion(todoData);
      const target = TARGET_VERSIONS['todo']!;
      result.todoJson = {
        current,
        target,
        needsMigration: compareSemver(current, target) < 0,
      };
    }
  } catch {
    // File may not exist
  }

  // Check config.json
  try {
    const configData = await readJson(getConfigPath(cwd));
    if (configData) {
      const current = detectVersion(configData);
      const target = TARGET_VERSIONS['config']!;
      result.configJson = {
        current,
        target,
        needsMigration: compareSemver(current, target) < 0,
      };
    }
  } catch {
    // File may not exist
  }

  // Check archive
  try {
    const archivePath = join(getCleoDirAbsolute(cwd), 'todo-archive.json');
    const archiveData = await readJson(archivePath);
    if (archiveData) {
      const current = detectVersion(archiveData);
      const target = TARGET_VERSIONS['archive']!;
      result.archiveJson = {
        current,
        target,
        needsMigration: compareSemver(current, target) < 0,
      };
    }
  } catch {
    // File may not exist
  }

  return result;
}

/**
 * Run migrations on a data file.
 * @task T4468
 */
export async function runMigration(
  fileType: string,
  options: { dryRun?: boolean } = {},
  cwd?: string,
): Promise<MigrationResult> {
  const filePaths: Record<string, string> = {
    todo: getTodoPath(cwd),
    config: getConfigPath(cwd),
    archive: join(getCleoDirAbsolute(cwd), 'todo-archive.json'),
  };

  const filePath = filePaths[fileType];
  if (!filePath) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Unknown file type: ${fileType}`);
  }

  const data = await readJson(filePath);
  if (!data) {
    throw new CleoError(ExitCode.NOT_FOUND, `File not found: ${filePath}`);
  }

  const currentVersion = detectVersion(data);
  const targetVersion = TARGET_VERSIONS[fileType] ?? '0.0.0';
  const migrations = MIGRATIONS[fileType] ?? [];

  // Find applicable migrations
  const applicable = migrations.filter(m =>
    compareSemver(m.fromVersion, currentVersion) >= 0 &&
    compareSemver(m.toVersion, targetVersion) <= 0,
  ).sort((a, b) => compareSemver(a.fromVersion, b.fromVersion));

  if (applicable.length === 0) {
    return {
      file: filePath,
      fromVersion: currentVersion,
      toVersion: currentVersion,
      migrationsApplied: [],
      success: true,
      errors: [],
      dryRun: options.dryRun ?? false,
    };
  }

  // Apply migrations sequentially
  let migrated: unknown = data;
  const applied: string[] = [];
  const errors: string[] = [];

  for (const migration of applicable) {
    try {
      migrated = migration.migrate(migrated);
      applied.push(`${migration.fromVersion} -> ${migration.toVersion}: ${migration.description}`);
    } catch (err) {
      errors.push(`Migration ${migration.fromVersion} -> ${migration.toVersion} failed: ${err}`);
      break;
    }
  }

  // Update schema version in _meta
  const migratedObj = migrated as Record<string, unknown>;
  const meta = (migratedObj['_meta'] ?? {}) as Record<string, unknown>;
  meta['schemaVersion'] = errors.length === 0 ? targetVersion : currentVersion;
  migratedObj['_meta'] = meta;

  if (!options.dryRun && errors.length === 0) {
    await saveJson(filePath, migrated, { backupDir: getBackupDir(cwd) });
  }

  return {
    file: filePath,
    fromVersion: currentVersion,
    toVersion: errors.length === 0 ? targetVersion : currentVersion,
    migrationsApplied: applied,
    success: errors.length === 0,
    errors,
    dryRun: options.dryRun ?? false,
  };
}

/**
 * Run all pending migrations.
 * @task T4468
 */
export async function runAllMigrations(
  options: { dryRun?: boolean } = {},
  cwd?: string,
): Promise<MigrationResult[]> {
  const status = await getMigrationStatus(cwd);
  const results: MigrationResult[] = [];

  if (status.todoJson?.needsMigration) {
    results.push(await runMigration('todo', options, cwd));
  }

  if (status.configJson?.needsMigration) {
    results.push(await runMigration('config', options, cwd));
  }

  if (status.archiveJson?.needsMigration) {
    results.push(await runMigration('archive', options, cwd));
  }

  return results;
}
