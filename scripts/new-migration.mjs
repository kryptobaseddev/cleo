#!/usr/bin/env node

/**
 * new-migration.mjs — drizzle-kit generator wrapper for CLEO migration authoring.
 *
 * Wraps `node_modules/.bin/drizzle-kit generate` with:
 *   1. Temp-DB baseline resolution per CLEO_DRIZZLE_BASELINE_<DB>_DB env vars.
 *   2. Trailing `--> statement-breakpoint` post-processing (strips the marker from
 *      the last line so the file ends cleanly with `;\n`).
 *   3. Task-ID-based folder renaming: YYYYMMDDHHMMSS_<drizzle-auto-name>/ →
 *      YYYYMMDDHHMMSS_<TNNNN>-<name>/.
 *   4. Linter validation via scripts/lint-migrations.mjs — aborts on RULE-1 errors.
 *   5. Optional `--commit` mode: git-commits the new migration folder.
 *   6. Optional `--apply` mode: runs migrateSanitized on a fresh temp DB for
 *      local inspection (does not commit).
 *
 * Usage:
 *   node scripts/new-migration.mjs --db <tasks|brain|nexus|signaldock|telemetry> \
 *     --task <TNNNN> --name <kebab-desc> [--commit] [--apply]
 *
 * Root-package alias: pnpm db:new -- --db tasks --task T1234 --name add-column
 *
 * @see packages/core/migrations/README.md — migration authoring guide (T1172)
 * @task T1164
 * @epic T1150
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/** Valid DB identifiers. */
const VALID_DBS = ['tasks', 'brain', 'nexus', 'signaldock', 'telemetry'];

/** Drizzle-kit binary location (R3: never use pnpm dlx — it has incompat issues). */
const DRIZZLE_KIT_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'drizzle-kit');

/** Regex for task ID validation. */
const TASK_ID_RE = /^T\d+$/;

/** Regex for migration name slug validation. */
const NAME_SLUG_RE = /^[a-z0-9-]+$/;

/** Regex to detect a trailing statement-breakpoint at end-of-file. */
const TRAILING_BREAKPOINT_RE = /--> statement-breakpoint[\s]*$/;

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `
Usage: node scripts/new-migration.mjs --db <db> --task <TNNNN> --name <slug> [options]

Required:
  --db <name>     Target database (${VALID_DBS.join(' | ')})
  --task <TNNNN>  Task ID that owns this migration (e.g. T1234)
  --name <slug>   Kebab-case description slug (e.g. add-column)

Options:
  --commit        Auto-commit the generated migration folder after linter passes
  --apply         Run migrateSanitized on a fresh temp DB for local inspection (does not commit)
  --help, -h      Print this help and exit

Environment:
  CLEO_DRIZZLE_BASELINE_DB            Override temp-DB path for tasks DB
  CLEO_DRIZZLE_BASELINE_BRAIN_DB      Override temp-DB path for brain DB
  CLEO_DRIZZLE_BASELINE_NEXUS_DB      Override temp-DB path for nexus DB
  CLEO_DRIZZLE_BASELINE_SIGNALDOCK_DB Override temp-DB path for signaldock DB
  CLEO_DRIZZLE_BASELINE_TELEMETRY_DB  Override temp-DB path for telemetry DB

Example:
  pnpm db:new -- --db tasks --task T1234 --name add-priority-column --commit

Notes:
  - signaldock requires W2A-04 (bare-SQL → Drizzle schema conversion) before
    the generator can produce clean output. The script will warn and exit if you
    target signaldock before that work is complete.
  - Do NOT run against production DBs. The baseline DB is always a throwaway temp file.
`.trim();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse and validate CLI arguments.
 * @returns Parsed argument object or null on validation failure.
 */
function parseCliArgs() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      db: { type: 'string' },
      task: { type: 'string' },
      name: { type: 'string' },
      commit: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false, short: 'h' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const errors = [];

  if (!values.db) {
    errors.push('--db is required');
  } else if (!VALID_DBS.includes(values.db)) {
    errors.push(`--db must be one of: ${VALID_DBS.join(', ')} (got: "${values.db}")`);
  }

  if (!values.task) {
    errors.push('--task is required');
  } else if (!TASK_ID_RE.test(values.task)) {
    errors.push(`--task must match ^T\\d+$ (got: "${values.task}")`);
  }

  if (!values.name) {
    errors.push('--name is required');
  } else if (!NAME_SLUG_RE.test(values.name)) {
    errors.push(`--name must match ^[a-z0-9-]+$ (got: "${values.name}")`);
  }

  if (errors.length > 0) {
    for (const err of errors) {
      process.stderr.write(`ERROR: ${err}\n`);
    }
    process.stderr.write('\nRun with --help for usage.\n');
    process.exit(1);
  }

  return {
    db: values.db,
    task: values.task,
    name: values.name,
    commit: values.commit ?? false,
    apply: values.apply ?? false,
  };
}

// ---------------------------------------------------------------------------
// Temp-DB baseline helpers
// ---------------------------------------------------------------------------

/**
 * Map from DB identifier to the environment variable that overrides the temp-DB path.
 */
const DB_ENV_VAR_MAP = {
  tasks: 'CLEO_DRIZZLE_BASELINE_DB',
  brain: 'CLEO_DRIZZLE_BASELINE_BRAIN_DB',
  nexus: 'CLEO_DRIZZLE_BASELINE_NEXUS_DB',
  signaldock: 'CLEO_DRIZZLE_BASELINE_SIGNALDOCK_DB',
  telemetry: 'CLEO_DRIZZLE_BASELINE_TELEMETRY_DB',
};

/**
 * Resolve the throwaway temp-DB path for a given DB identifier.
 * Creates parent directories if they do not exist.
 *
 * @param db - DB identifier (tasks, brain, etc.)
 * @returns Absolute path to the temp DB file.
 */
function resolveBaselineDb(db) {
  const envVar = DB_ENV_VAR_MAP[db];
  const envValue = process.env[envVar];
  const dbPath = envValue || `/tmp/cleo-drizzle-baseline/${db}.db`;

  const parentDir = dirname(dbPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
    console.log(`[new-migration] Created baseline dir: ${parentDir}`);
  }

  return dbPath;
}

// ---------------------------------------------------------------------------
// Drizzle-kit invocation
// ---------------------------------------------------------------------------

/**
 * Invoke drizzle-kit generate for the specified DB config.
 * Exits the process on non-zero exit code.
 *
 * @param db - DB identifier.
 * @param baselineDbPath - Path to the throwaway temp DB.
 */
function runDrizzleKitGenerate(db, baselineDbPath) {
  const configPath = `drizzle/${db}.config.ts`;
  const configAbsolute = join(REPO_ROOT, configPath);

  if (!existsSync(configAbsolute)) {
    process.stderr.write(`ERROR: Config not found: ${configAbsolute}\n`);
    process.exit(1);
  }

  console.log(`[new-migration] Running drizzle-kit generate for ${db}...`);
  console.log(`[new-migration] Config:      ${configPath}`);
  console.log(`[new-migration] Baseline DB: ${baselineDbPath}`);

  // Build env with the correct baseline DB env var set, so the config picks it up.
  const envVar = DB_ENV_VAR_MAP[db];
  const env = { ...process.env, [envVar]: baselineDbPath };

  const result = spawnSync(DRIZZLE_KIT_BIN, ['generate', `--config=${configPath}`], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    process.stderr.write(
      `ERROR: drizzle-kit generate exited with code ${result.status}. Aborting.\n`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Migration folder discovery
// ---------------------------------------------------------------------------

/**
 * Find the newest migration folder under packages/core/migrations/drizzle-<db>/.
 * Drizzle-kit names folders with a 14-digit UTC timestamp prefix.
 *
 * @param db - DB identifier.
 * @returns Absolute path to the newly generated migration folder, or null.
 */
function findNewestMigrationFolder(db) {
  const migrationsDir = join(REPO_ROOT, 'packages', 'core', 'migrations', `drizzle-${db}`);

  if (!existsSync(migrationsDir)) {
    process.stderr.write(`ERROR: Migrations directory not found: ${migrationsDir}\n`);
    process.exit(1);
  }

  const entries = readdirSync(migrationsDir)
    .filter((name) => {
      const full = join(migrationsDir, name);
      return statSync(full).isDirectory() && /^\d{14}/.test(name);
    })
    .sort(); // lexicographic = chronological for 14-digit timestamps

  if (entries.length === 0) {
    process.stderr.write(`ERROR: No migration folders found in ${migrationsDir}\n`);
    process.exit(1);
  }

  const newestFolder = entries[entries.length - 1];
  return join(migrationsDir, newestFolder);
}

// ---------------------------------------------------------------------------
// Trailing-breakpoint post-processing
// ---------------------------------------------------------------------------

/**
 * Strip trailing `--> statement-breakpoint` markers from migration.sql.
 *
 * Drizzle-kit inserts these markers as hints for its own runner. CLEO uses
 * migrateSanitized which ignores them, but the linter (RULE-1) flags any file
 * that ends with the marker. This function cleans the file at generation time.
 *
 * Defense-in-depth: also strips any purely whitespace chunks between markers
 * so that runs of `\n--> statement-breakpoint\n\n--> statement-breakpoint\n`
 * collapse correctly.
 *
 * @param folderPath - Absolute path to the migration folder.
 * @returns true if the file was modified, false if no change was needed.
 */
function stripTrailingBreakpoint(folderPath) {
  const sqlPath = join(folderPath, 'migration.sql');

  if (!existsSync(sqlPath)) {
    console.log('[new-migration] No migration.sql found to post-process (skipping).');
    return false;
  }

  let content = readFileSync(sqlPath, 'utf8');
  const original = content;

  // Pass 1: strip any trailing statement-breakpoint marker at end of file.
  // Keep looping in case there are multiple consecutive trailing markers.
  while (TRAILING_BREAKPOINT_RE.test(content)) {
    content = content.replace(TRAILING_BREAKPOINT_RE, '');
  }

  // Pass 2: collapse blank-line sequences immediately after a breakpoint marker
  // that is NOT the final statement separator. This handles the edge case where
  // drizzle-kit emits:
  //   CREATE TABLE foo (...);\n--> statement-breakpoint\n\n\n--> statement-breakpoint\n
  // After pass 1 we still have the non-trailing markers; normalise their spacing.
  content = content.replace(/--> statement-breakpoint\n(\s*\n)+/g, '--> statement-breakpoint\n');

  // Ensure file ends with exactly one newline.
  content = content.trimEnd() + '\n';

  if (content === original) {
    console.log('[new-migration] migration.sql: no trailing breakpoint found — no changes needed.');
    return false;
  }

  writeFileSync(sqlPath, content, 'utf8');
  console.log('[new-migration] migration.sql: stripped trailing statement-breakpoint marker.');
  return true;
}

// ---------------------------------------------------------------------------
// Folder renaming
// ---------------------------------------------------------------------------

/**
 * Rename the generated migration folder from drizzle-kit's auto-name to the
 * CLEO task-id convention: YYYYMMDDHHMMSS_<TNNNN>-<name>/.
 *
 * @param currentFolderPath - Absolute path to the current migration folder.
 * @param task - Task ID (e.g. T1234).
 * @param name - Kebab-case description slug.
 * @returns Absolute path to the renamed folder.
 */
function renameMigrationFolder(currentFolderPath, task, name) {
  const currentFolderName = currentFolderPath.split('/').pop();
  const timestampMatch = currentFolderName.match(/^(\d{14})/);

  if (!timestampMatch) {
    process.stderr.write(
      `ERROR: Could not extract timestamp from folder name: ${currentFolderName}\n`,
    );
    process.exit(1);
  }

  const timestamp = timestampMatch[1];
  // CLEO convention: lowercase task ID in folder name (t1234, not T1234)
  const newFolderName = `${timestamp}_${task.toLowerCase()}-${name}`;
  const parentDir = dirname(currentFolderPath);
  const newFolderPath = join(parentDir, newFolderName);

  if (currentFolderPath === newFolderPath) {
    console.log(`[new-migration] Folder already named correctly: ${newFolderName}`);
    return currentFolderPath;
  }

  if (existsSync(newFolderPath)) {
    process.stderr.write(`ERROR: Target folder already exists: ${newFolderPath}\n`);
    process.exit(1);
  }

  renameSync(currentFolderPath, newFolderPath);
  console.log(`[new-migration] Renamed: ${currentFolderName} → ${newFolderName}`);
  return newFolderPath;
}

// ---------------------------------------------------------------------------
// Linter validation
// ---------------------------------------------------------------------------

/**
 * Run scripts/lint-migrations.mjs scoped to the new migration folder's parent DB set.
 * Aborts if RULE-1 errors are found.
 *
 * @param db - DB identifier used to scope the linter to the right DB set.
 * @param migrationsRoot - Absolute path to packages/core/migrations.
 */
function runLinter(db, migrationsRoot) {
  console.log('[new-migration] Running lint-migrations.mjs...');

  const linterPath = join(REPO_ROOT, 'scripts', 'lint-migrations.mjs');
  const result = spawnSync(process.execPath, [linterPath, '--migrations-root', migrationsRoot], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  const combinedOutput = (result.stdout || '') + (result.stderr || '');

  if (result.status !== 0) {
    process.stderr.write('\n[new-migration] LINTER FAILED — output:\n');
    process.stderr.write(combinedOutput);
    process.stderr.write('\nAborting: fix RULE-1 violations before committing.\n');
    process.exit(1);
  }

  console.log('[new-migration] Linter: PASS');
}

// ---------------------------------------------------------------------------
// Git commit
// ---------------------------------------------------------------------------

/**
 * Stage and commit the new migration folder to git.
 *
 * @param folderPath - Absolute path to the renamed migration folder.
 * @param task - Task ID for commit message.
 * @param name - Slug for commit message.
 */
function gitCommit(folderPath, task, name) {
  console.log('[new-migration] Staging migration folder for commit...');

  const addResult = spawnSync('git', ['add', folderPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (addResult.status !== 0) {
    process.stderr.write(`ERROR: git add failed with exit code ${addResult.status}\n`);
    process.exit(1);
  }

  const commitMessage = `feat(${task}): ${name} migration`;
  const commitResult = spawnSync('git', ['commit', '-m', commitMessage], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (commitResult.status !== 0) {
    process.stderr.write(`ERROR: git commit failed with exit code ${commitResult.status}\n`);
    process.exit(1);
  }

  console.log(`[new-migration] Committed: "${commitMessage}"`);
}

// ---------------------------------------------------------------------------
// Apply mode (temp DB inspection)
// ---------------------------------------------------------------------------

/**
 * Apply the generated migration to a fresh throwaway temp DB using migrateSanitized.
 * This is for local inspection only — it does not commit anything.
 *
 * The function dynamically imports @cleocode/core/internal to obtain
 * migrateSanitized and creates a brand-new temp SQLite DB.
 *
 * @param db - DB identifier.
 * @param migrationsFolder - Absolute path to the DB-set migrations folder.
 */
async function applyToTempDb(db, migrationsFolder) {
  console.log('[new-migration] --apply mode: running migrateSanitized on a fresh temp DB...');

  const tempDbPath = `/tmp/cleo-apply-inspect-${db}-${Date.now()}.db`;

  try {
    // Dynamic import — requires the core package to be built (dist/ present).
    // Fall back to a graceful error message if the build is absent.
    const { DatabaseSync } = await import('node:sqlite');
    const drizzle = await import('drizzle-orm/node-sqlite');

    // We need migrateSanitized from core. Since this is an ESM script,
    // we attempt to load from the built dist. If unavailable, we tell the
    // developer to run `pnpm build` first.
    let migrateSanitized;
    try {
      const coreInternal = await import(join(REPO_ROOT, 'packages', 'core', 'dist', 'internal.js'));
      migrateSanitized = coreInternal.migrateSanitized;
    } catch (importErr) {
      process.stderr.write(
        '[new-migration] --apply: Could not import @cleocode/core dist. ' +
          'Run `pnpm build` first, then retry with --apply.\n',
      );
      process.stderr.write(`  Import error: ${importErr.message}\n`);
      return;
    }

    if (typeof migrateSanitized !== 'function') {
      process.stderr.write(
        '[new-migration] --apply: migrateSanitized not found in core dist. Skipping apply.\n',
      );
      return;
    }

    const nativeDb = new DatabaseSync(tempDbPath);
    const ormDb = drizzle.drizzle(nativeDb);

    migrateSanitized(ormDb, { migrationsFolder });

    nativeDb.close();
    console.log(`[new-migration] --apply: Migration applied successfully to: ${tempDbPath}`);
    console.log('[new-migration] --apply: Inspect with: sqlite3 ' + tempDbPath);
  } catch (err) {
    process.stderr.write(`[new-migration] --apply error: ${err.message}\n`);
    process.stderr.write('Skipping apply step. The migration files were still generated.\n');
  }
}

// ---------------------------------------------------------------------------
// Print diff / summary
// ---------------------------------------------------------------------------

/**
 * Print the contents of the new migration.sql and note the snapshot.json location.
 *
 * @param folderPath - Absolute path to the renamed migration folder.
 */
function printMigrationSummary(folderPath) {
  const sqlPath = join(folderPath, 'migration.sql');
  const snapshotPath = join(folderPath, 'snapshot.json');
  const folderName = folderPath.split('/').pop();

  console.log('\n=== Generated Migration Summary ===');
  console.log(`Folder: ${folderPath}`);

  if (existsSync(sqlPath)) {
    const content = readFileSync(sqlPath, 'utf8');
    console.log('\n--- migration.sql ---');
    console.log(content);
    console.log('--- end migration.sql ---');
  } else {
    console.log('(no migration.sql found in output folder — schema may be unchanged)');
  }

  if (existsSync(snapshotPath)) {
    console.log(`\nsnapshot.json: ${snapshotPath}`);
  }

  console.log('\nReview the SQL above, then commit with:');
  console.log(`  git add ${folderPath}`);
  console.log(`  git commit -m "feat(<task>): ${folderName} migration"`);
  console.log('Or rerun with --commit to auto-commit.\n');
}

// ---------------------------------------------------------------------------
// Signaldock guard
// ---------------------------------------------------------------------------

/**
 * Emit a warning when targeting signaldock, which requires W2A-04 completion
 * before the generator can produce clean output.
 *
 * The script does NOT exit for signaldock — it warns and proceeds so that
 * W2A-04 implementors can test incrementally. The linter will catch any issues.
 *
 * @param db - DB identifier.
 */
function warnIfSignaldock(db) {
  if (db !== 'signaldock') return;

  process.stderr.write(
    '\nWARNING (T1164): signaldock is flagged as needing W2A-04 (bare-SQL → Drizzle schema\n' +
      'conversion in packages/core/src/store/signaldock-sqlite.ts) before the generator\n' +
      'can produce clean output. The current config points at signaldock-sqlite.ts which\n' +
      'contains embedded bare-SQL migrations rather than a proper Drizzle ORM schema.\n\n' +
      'Proceeding anyway — the linter will catch any violations.\n\n',
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point — orchestrates the full generation workflow.
 */
async function main() {
  const args = parseCliArgs();
  const { db, task, name, commit, apply } = args;

  console.log(`[new-migration] Starting migration generation`);
  console.log(`[new-migration] DB:     ${db}`);
  console.log(`[new-migration] Task:   ${task}`);
  console.log(`[new-migration] Name:   ${name}`);
  console.log(`[new-migration] Commit: ${commit}`);
  console.log(`[new-migration] Apply:  ${apply}`);

  // 1. Warn for signaldock (W2A-04 dependency)
  warnIfSignaldock(db);

  // 2. Resolve baseline DB path (creates parent dir if needed)
  const baselineDbPath = resolveBaselineDb(db);

  // 3. Run drizzle-kit generate
  runDrizzleKitGenerate(db, baselineDbPath);

  // 4. Locate the newest generated folder
  const generatedFolderPath = findNewestMigrationFolder(db);
  console.log(`[new-migration] Found generated folder: ${generatedFolderPath}`);

  // 5. Post-process: strip trailing statement-breakpoint
  stripTrailingBreakpoint(generatedFolderPath);

  // 6. Rename folder to CLEO task-id convention
  const renamedFolderPath = renameMigrationFolder(generatedFolderPath, task, name);

  // 7. Run linter to validate
  const migrationsRoot = join(REPO_ROOT, 'packages', 'core', 'migrations');
  runLinter(db, migrationsRoot);

  // 8. Print migration summary for human review
  printMigrationSummary(renamedFolderPath);

  // 9. Optional: apply to temp DB
  if (apply) {
    const migrationsFolder = join(REPO_ROOT, 'packages', 'core', 'migrations', `drizzle-${db}`);
    await applyToTempDb(db, migrationsFolder);
  }

  // 10. Optional: auto-commit
  if (commit) {
    gitCommit(renamedFolderPath, task, name);
  }

  console.log('[new-migration] Done.');
}

main().catch((err) => {
  process.stderr.write(`[new-migration] Unexpected error: ${err.stack || err.message}\n`);
  process.exit(1);
});
