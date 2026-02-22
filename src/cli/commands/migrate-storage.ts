/**
 * CLI migrate-storage command - migrate between JSON and SQLite storage engines.
 *
 * Supports:
 *   --to-sqlite: Migrate JSON data to SQLite
 *   --to-json: Export SQLite data back to JSON files
 *   --dry-run: Preview what would be migrated
 *   --verify: Verify migration integrity after completion
 *   --confirm: Confirm destructive operations (or use interactive prompt)
 *   --force: Skip confirmation prompts (requires --confirm)
 *
 * @task T4648
 * @task T4730 - Added user confirmation requirements
 * @epic T4638
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoDirAbsolute } from '../../core/paths.js';

/**
 * Format bytes to human-readable string.
 * @task T4730
 */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Prompt user for confirmation with details about the destructive operation.
 * @task T4730
 */
async function promptConfirmation(details: {
  jsonCounts: { tasks: number; archived: number; sessions: number };
  existingDbSize?: number;
  existingDbTaskCount?: number;
  backupPath: string;
}): Promise<boolean> {
  console.log('\n⚠️  DESTRUCTIVE OPERATION WARNING ⚠️\n');
  console.log('This operation will:');
  console.log(`  • Read ${details.jsonCounts.tasks} tasks from JSON`);
  console.log(`  • Read ${details.jsonCounts.archived} archived tasks from JSON`);
  console.log(`  • Read ${details.jsonCounts.sessions} sessions from JSON`);

  if (details.existingDbSize && details.existingDbTaskCount !== undefined) {
    console.log(`  • REPLACE existing SQLite database:`);
    console.log(`    - Size: ${formatBytes(details.existingDbSize)}`);
    console.log(`    - Tasks: ${details.existingDbTaskCount}`);
  }

  console.log(`  • Create backup at: ${details.backupPath}\n`);

  console.log('The existing database will be preserved as a backup.\n');

  const answer = await question('Type "yes" to proceed: ');
  return answer.toLowerCase().trim() === 'yes';
}

/**
 * Ask a question via readline.
 * @task T4730
 */
async function question(promptText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(promptText, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Get task count from existing SQLite database.
 * @task T4730
 */
async function getDbTaskCount(cwd?: string): Promise<number> {
  try {
    const { count } = await import('drizzle-orm');
    const { getDb } = await import('../../store/sqlite.js');
    const { tasks } = await import('../../store/schema.js');
    const db = await getDb(cwd);
    const result = db.select({ count: count() })
      .from(tasks)
      .get();
    return result?.count ?? 0;
  } catch {
    return 0;
  }
}

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

/**
 * Check for and handle resumable migration state.
 * @task T4726
 */
async function checkResumableMigration(cleoDir: string): Promise<{
  shouldResume: boolean;
  state: Awaited<ReturnType<typeof canResumeMigration>>;
}> {
  const { canResumeMigration, getMigrationSummary } = await import('../../core/migration/state.js');
  const state = await canResumeMigration(cleoDir);

  if (!state) {
    return { shouldResume: false, state: null };
  }

  if (state.phase === 'complete') {
    console.log('✅ Previous migration completed successfully.');
    return { shouldResume: false, state };
  }

  if (state.phase === 'failed') {
    console.log('\n❌ Previous migration failed with errors:');
    state.errors.forEach((err: string) => console.log(`   - ${err}`));
    console.log('\nMigration state preserved for debugging.');
    console.log('To retry, run: cleo migrate-storage --to-sqlite --force --confirm\n');
    return { shouldResume: false, state };
  }

  // Migration is in progress - show status and offer resume
  console.log('\n⏳ A migration is currently in progress:');
  const summary = await getMigrationSummary(cleoDir);
  if (summary) {
    console.log(summary);
  }

  return { shouldResume: true, state };
}

/** @task T4648 @task T4730 @task T4726 */
export function registerMigrateStorageCommand(program: Command): void {
  program
    .command('migrate-storage')
    .description('Migrate storage engine between JSON and SQLite')
    .option('--to-sqlite', 'Migrate from JSON to SQLite')
    .option('--to-json', 'Export SQLite data back to JSON')
    .option('--dry-run', 'Show what would be migrated without making changes')
    .option('--verify', 'Verify migration integrity after completion')
    .option('--force', 'Force re-import even if data already exists (requires --confirm)')
    .option('--confirm', 'Confirm destructive operations')
    .option('--resume', 'Resume interrupted migration from last checkpoint')
    .option('--status', 'Show migration status and exit')
    .action(async (opts: Record<string, unknown>) => {
      try {
        // Deprecation warning (ADR-006: use `cleo upgrade` instead)
        process.stderr.write(
          `\n⚠ migrate-storage is deprecated. Use 'cleo upgrade' instead.\n\n`,
        );

        const toSqlite = !!opts['toSqlite'];
        const toJson = !!opts['toJson'];
        const dryRun = !!opts['dryRun'];
        const verify = !!opts['verify'];
        const force = !!opts['force'];
        const confirm = !!opts['confirm'];
        const resume = !!opts['resume'];
        const showStatus = !!opts['status'];

        const cleoDir = getCleoDirAbsolute();

        // Handle --status flag first
        if (showStatus) {
          const { getMigrationSummary } = await import('../../core/migration/state.js');
          const summary = await getMigrationSummary(cleoDir);
          if (summary) {
            console.log(summary);
          } else {
            console.log('No migration in progress.');
          }
          return;
        }

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

        // --force requires --confirm for destructive operations
        if (force && !confirm && !dryRun) {
          throw new CleoError(
            ExitCode.INVALID_INPUT,
            '--force requires --confirm flag for destructive operations',
            { fix: 'cleo migrate-storage --to-sqlite --confirm or cleo migrate-storage --to-sqlite --dry-run' },
          );
        }

        // Check for resumable migration state (T4726)
        if (toSqlite && !resume && !force) {
          const { shouldResume, state } = await checkResumableMigration(cleoDir);

          if (state?.phase === 'failed') {
            // Don't proceed if previous migration failed
            return;
          }

          if (shouldResume) {
            console.log('\nUse --resume to continue this migration, or --force to start fresh.');
            return;
          }
        }

        // Clear any existing state if starting fresh with --force
        if (force && !resume) {
          const { clearMigrationState } = await import('../../core/migration/state.js');
          await clearMigrationState(cleoDir);
        }

        if (toSqlite) {
          await handleToSqlite(cleoDir, dryRun, verify, force, confirm, resume);
        } else {
          await handleToJson(cleoDir, dryRun, confirm);
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
 * @task T4730 - Added user confirmation flow
 * @task T4726 - Added resume support
 */
async function handleToSqlite(
  cleoDir: string,
  dryRun: boolean,
  verify: boolean,
  force: boolean,
  confirm: boolean,
  resume: boolean,
): Promise<void> {
  const dbPath = join(cleoDir, 'tasks.db');
  
  // Check for resumable migration if resume flag is set
  if (resume) {
    const { loadMigrationState } = await import('../../core/migration/state.js');
    const state = await loadMigrationState(cleoDir);
    if (state && state.phase !== 'complete') {
      console.log(`Resuming migration from phase: ${state.phase}`);
      console.log(`Progress: ${state.progress.tasksImported} tasks imported`);
    } else if (state && state.phase === 'complete') {
      console.log('Migration already complete. Use --force to restart.');
      return;
    } else {
      console.log('No resumable migration found. Starting fresh.');
    }
  }
  
  const jsonCounts = countJsonRecords(cleoDir);

  // Enhanced dry-run output showing detailed plan
  if (dryRun) {
    console.log('\n📋 MIGRATION PLAN (DRY RUN)\n');
    console.log('Source Data:');
    console.log(`  • Tasks: ${jsonCounts.tasks}`);
    console.log(`  • Archived: ${jsonCounts.archived}`);
    console.log(`  • Sessions: ${jsonCounts.sessions}`);
    console.log(`  • Total: ${jsonCounts.tasks + jsonCounts.archived + jsonCounts.sessions}\n`);

    if (existsSync(dbPath)) {
      const stats = statSync(dbPath);
      const existingTaskCount = await getDbTaskCount();
      console.log('Existing Database:');
      console.log(`  • Size: ${formatBytes(stats.size)}`);
      console.log(`  • Tasks: ${existingTaskCount}`);
      console.log(`  • Will be: Backed up and replaced\n`);
    }

    console.log('Safety Measures:');
    console.log('  ✓ JSON validation will run');
    console.log('  ✓ Checksum verification will run');
    console.log('  ✓ Atomic rename will be used');
    console.log('  ✓ File lock will be acquired\n');

    console.log('No changes will be made. Run without --dry-run to execute.\n');
    return;
  }

  // Require confirmation for destructive migration to SQLite
  if (!confirm && !dryRun) {
    const existingDbSize = existsSync(dbPath) ? statSync(dbPath).size : undefined;
    const existingDbTaskCount = existsSync(dbPath) ? await getDbTaskCount() : undefined;
    const backupPath = join(cleoDir, 'backups', 'safety', `tasks.db.pre-migration.${Date.now()}`);

    const details = {
      jsonCounts,
      existingDbSize,
      existingDbTaskCount,
      backupPath,
    };

    const confirmed = await promptConfirmation(details);
    if (!confirmed) {
      console.log('\n❌ Migration cancelled by user.\n');
      process.exit(0);
    }
  }

  // Perform migration with options
  const { migrateJsonToSqlite } = await import('../../store/migration-sqlite.js');
  const result = await migrateJsonToSqlite(undefined, { force, dryRun });

  if (!result.success) {
    throw new CleoError(
      ExitCode.FILE_ERROR,
      `Migration failed with ${result.errors.length} error(s): ${result.errors.join('; ')}`,
    );
  }

  // Check if migration was skipped due to idempotency
  if (result.tasksImported === 0 && result.archivedImported === 0 && result.sessionsImported === 0) {
    cliOutput({
      action: 'skipped',
      from: 'json',
      to: 'sqlite',
      reason: result.warnings[0] ?? 'No data to import',
      existingCounts: result.existingCounts,
      jsonCounts: result.jsonCounts,
    }, { command: 'migrate-storage', message: 'Migration skipped.' });
    return;
  }

  // Update config to use sqlite
  updateConfigEngine(cleoDir, 'sqlite');

  // Optionally verify
  let verification = undefined;
  if (verify) {
    verification = await verifyMigration(cleoDir);
  }

  cliOutput({
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
  }, { command: 'migrate-storage', message: 'Migration to SQLite complete.' });

  // Close the database connection
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
}

/**
 * Handle --to-json export.
 * @task T4648
 * @task T4730 - Added confirmation support
 */
async function handleToJson(
  cleoDir: string,
  dryRun: boolean,
  confirm: boolean,
): Promise<void> {
  if (dryRun) {
    cliOutput({
      action: 'dry-run',
      from: 'sqlite',
      to: 'json',
      message: 'Would export SQLite data to JSON files',
    }, { command: 'migrate-storage', message: 'Dry run complete. No changes made.' });
    return;
  }

  // Require confirmation for destructive export (overwrites existing JSON)
  if (!confirm) {
    const todoPath = join(cleoDir, 'todo.json');
    const archivePath = join(cleoDir, 'todo-archive.json');
    const sessionsPath = join(cleoDir, 'sessions.json');

    let existingFiles = 0;
    if (existsSync(todoPath)) existingFiles++;
    if (existsSync(archivePath)) existingFiles++;
    if (existsSync(sessionsPath)) existingFiles++;

    if (existingFiles > 0) {
      console.log('\n⚠️  DESTRUCTIVE OPERATION WARNING ⚠️\n');
      console.log('This operation will:');
      console.log(`  • Export all SQLite data to JSON files`);
      console.log(`  • OVERWRITE ${existingFiles} existing JSON file(s)\n`);

      const answer = await question('Type "yes" to proceed: ');
      if (answer.toLowerCase().trim() !== 'yes') {
        console.log('\n❌ Export cancelled by user.\n');
        process.exit(0);
      }
    }
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

  cliOutput({
    action: 'exported',
    from: 'sqlite',
    to: 'json',
    exported: {
      tasks: exported.tasks.length,
      archived: exported.archived.length,
      sessions: exported.sessions.length,
    },
  }, { command: 'migrate-storage', message: 'Export to JSON complete.' });
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
