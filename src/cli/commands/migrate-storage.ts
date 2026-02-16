/**
 * CLI migrate-storage command - migrate between JSON and SQLite storage engines.
 *
 * Supports:
 *   --to-sqlite: Migrate JSON data to SQLite
 *   --to-json: Export SQLite data back to JSON files
 *   --dry-run: Preview what would be migrated
 *   --verify: Verify migration integrity after completion
 *
 * @task T4648
 * @epic T4638
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoDirAbsolute } from '../../core/paths.js';
import { detectStoreEngine } from '../../store/provider.js';

/**
 * Count records in JSON files for dry-run or verification.
 * @task T4648
 */
function countJsonRecords(cleoDir: string): {
  tasks: number;
  archived: number;
  sessions: number;
} {
  let tasks = 0;
  let archived = 0;
  let sessions = 0;

  const todoPath = join(cleoDir, 'todo.json');
  if (existsSync(todoPath)) {
    try {
      const data = JSON.parse(readFileSync(todoPath, 'utf-8'));
      tasks = (data.tasks ?? []).length;
    } catch {
      // Corrupted file
    }
  }

  const archivePath = join(cleoDir, 'todo-archive.json');
  if (existsSync(archivePath)) {
    try {
      const data = JSON.parse(readFileSync(archivePath, 'utf-8'));
      archived = (data.tasks ?? data.archivedTasks ?? []).length;
    } catch {
      // Corrupted file
    }
  }

  const sessionsPath = join(cleoDir, 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      const data = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      sessions = (data.sessions ?? []).length;
    } catch {
      // Corrupted file
    }
  }

  return { tasks, archived, sessions };
}

/**
 * Update the storage.engine field in config.json.
 * @task T4648
 */
function updateConfigEngine(cleoDir: string, engine: string): void {
  const configPath = join(cleoDir, 'config.json');
  let config: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Start fresh if corrupted
    }
  }

  if (!config.storage || typeof config.storage !== 'object') {
    config.storage = {};
  }
  (config.storage as Record<string, unknown>).engine = engine;

  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/** @task T4648 */
export function registerMigrateStorageCommand(program: Command): void {
  program
    .command('migrate-storage')
    .description('Migrate storage engine between JSON and SQLite')
    .option('--to-sqlite', 'Migrate from JSON to SQLite')
    .option('--to-json', 'Export SQLite data back to JSON')
    .option('--dry-run', 'Show what would be migrated without making changes')
    .option('--verify', 'Verify migration integrity after completion')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const toSqlite = !!opts['toSqlite'];
        const toJson = !!opts['toJson'];
        const dryRun = !!opts['dryRun'];
        const verify = !!opts['verify'];

        if (!toSqlite && !toJson) {
          throw new CleoError(
            ExitCode.INVALID_INPUT,
            'Specify --to-sqlite or --to-json',
            { fix: 'cleo migrate-storage --to-sqlite' },
          );
        }

        if (toSqlite && toJson) {
          throw new CleoError(
            ExitCode.INVALID_INPUT,
            'Cannot specify both --to-sqlite and --to-json',
            { fix: 'cleo migrate-storage --to-sqlite' },
          );
        }

        const cleoDir = getCleoDirAbsolute();
        const currentEngine = detectStoreEngine();

        if (toSqlite) {
          await handleToSqlite(cleoDir, currentEngine, dryRun, verify);
        } else {
          await handleToJson(cleoDir, currentEngine, dryRun);
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}

/**
 * Handle --to-sqlite migration.
 * @task T4648
 */
async function handleToSqlite(
  cleoDir: string,
  currentEngine: string,
  dryRun: boolean,
  verify: boolean,
): Promise<void> {
  const counts = countJsonRecords(cleoDir);

  if (dryRun) {
    console.log(formatSuccess({
      action: 'dry-run',
      from: 'json',
      to: 'sqlite',
      wouldMigrate: {
        tasks: counts.tasks,
        archived: counts.archived,
        sessions: counts.sessions,
        total: counts.tasks + counts.archived + counts.sessions,
      },
      currentEngine,
    }, 'Dry run complete. No changes made.'));
    return;
  }

  if (currentEngine === 'sqlite' && !verify) {
    console.log(formatSuccess({
      action: 'no-op',
      currentEngine: 'sqlite',
      message: 'Already using SQLite storage engine',
    }));
    return;
  }

  // Perform migration
  const { migrateJsonToSqlite } = await import('../../store/migration-sqlite.js');
  const result = await migrateJsonToSqlite();

  if (!result.success) {
    throw new CleoError(
      ExitCode.FILE_ERROR,
      `Migration failed with ${result.errors.length} error(s): ${result.errors.join('; ')}`,
    );
  }

  // Update config to use sqlite
  updateConfigEngine(cleoDir, 'sqlite');

  // Optionally verify
  let verification = undefined;
  if (verify) {
    verification = await verifyMigration(cleoDir);
  }

  console.log(formatSuccess({
    action: 'migrated',
    from: 'json',
    to: 'sqlite',
    imported: {
      tasks: result.tasksImported,
      archived: result.archivedImported,
      sessions: result.sessionsImported,
    },
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
    ...(verification ? { verification } : {}),
  }, 'Migration to SQLite complete.'));

  // Close the database connection
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
}

/**
 * Handle --to-json export.
 * @task T4648
 */
async function handleToJson(
  cleoDir: string,
  currentEngine: string,
  dryRun: boolean,
): Promise<void> {
  if (currentEngine === 'json') {
    console.log(formatSuccess({
      action: 'no-op',
      currentEngine: 'json',
      message: 'Already using JSON storage engine',
    }));
    return;
  }

  if (dryRun) {
    console.log(formatSuccess({
      action: 'dry-run',
      from: 'sqlite',
      to: 'json',
      message: 'Would export SQLite data to JSON files',
    }, 'Dry run complete. No changes made.'));
    return;
  }

  // Export SQLite data to JSON
  const { exportToJson } = await import('../../store/migration-sqlite.js');
  const exported = await exportToJson();

  // Write JSON files
  const todoPath = join(cleoDir, 'todo.json');
  const existingTodo = existsSync(todoPath)
    ? JSON.parse(readFileSync(todoPath, 'utf-8'))
    : {
        version: '2.10.0',
        project: { name: 'project' },
        _meta: { schemaVersion: '2.10.0', checksum: '', configVersion: '1.0.0' },
        lastUpdated: new Date().toISOString(),
      };

  existingTodo.tasks = exported.tasks;
  existingTodo.lastUpdated = new Date().toISOString();
  writeFileSync(todoPath, JSON.stringify(existingTodo, null, 2));

  const archivePath = join(cleoDir, 'todo-archive.json');
  writeFileSync(archivePath, JSON.stringify({
    _meta: { schemaVersion: '2.10.0' },
    archivedTasks: exported.archived,
  }, null, 2));

  const sessionsPath = join(cleoDir, 'sessions.json');
  writeFileSync(sessionsPath, JSON.stringify({
    version: '1.0.0',
    _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() },
    sessions: exported.sessions,
  }, null, 2));

  // Update config to use json
  updateConfigEngine(cleoDir, 'json');

  // Close the database connection
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();

  console.log(formatSuccess({
    action: 'exported',
    from: 'sqlite',
    to: 'json',
    exported: {
      tasks: exported.tasks.length,
      archived: exported.archived.length,
      sessions: exported.sessions.length,
    },
  }, 'Export to JSON complete.'));
}

/**
 * Verify data parity between JSON source files and SQLite.
 * @task T4648
 */
async function verifyMigration(cleoDir: string): Promise<{
  match: boolean;
  jsonCounts: { tasks: number; archived: number; sessions: number };
  sqliteCounts: { tasks: number; archived: number; sessions: number };
  discrepancies: string[];
}> {
  const jsonCounts = countJsonRecords(cleoDir);
  const discrepancies: string[] = [];

  // Count records in SQLite
  const { countTasks } = await import('../../store/task-store.js');
  const { getDb } = await import('../../store/sqlite.js');
  const { sql } = await import('drizzle-orm');
  const { tasks } = await import('../../store/schema.js');

  const db = await getDb();
  const sqliteTaskCount = await countTasks();

  const archivedRows = db.all<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM ${tasks} WHERE status = 'archived'
  `);
  const sqliteArchivedCount = archivedRows[0]?.count ?? 0;

  const sessionRows = db.all<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM sessions
  `);
  const sqliteSessionCount = sessionRows[0]?.count ?? 0;

  const sqliteCounts = {
    tasks: sqliteTaskCount,
    archived: sqliteArchivedCount,
    sessions: sqliteSessionCount,
  };

  if (jsonCounts.tasks !== sqliteCounts.tasks) {
    discrepancies.push(
      `Task count mismatch: JSON=${jsonCounts.tasks}, SQLite=${sqliteCounts.tasks}`,
    );
  }

  if (jsonCounts.archived !== sqliteCounts.archived) {
    discrepancies.push(
      `Archived count mismatch: JSON=${jsonCounts.archived}, SQLite=${sqliteCounts.archived}`,
    );
  }

  if (jsonCounts.sessions !== sqliteCounts.sessions) {
    discrepancies.push(
      `Session count mismatch: JSON=${jsonCounts.sessions}, SQLite=${sqliteCounts.sessions}`,
    );
  }

  return {
    match: discrepancies.length === 0,
    jsonCounts,
    sqliteCounts,
    discrepancies,
  };
}
