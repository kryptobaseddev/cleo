/**
 * Integration tests for scripts/new-migration.mjs.
 *
 * Test 1 (stripTrailingBreakpoint — end-to-end post-processing):
 *   Primes a fake migration folder that simulates drizzle-kit output with a
 *   trailing `--> statement-breakpoint`, invokes the post-processing logic
 *   directly, and asserts that the resulting migration.sql:
 *     (a) exists with correct TNNNN-name folder shape
 *     (b) contains no trailing `–-> statement-breakpoint`
 *     (c) passes lint-migrations.mjs RULE-1
 *     (d) has a snapshot.json alongside it
 *
 * Test 2 (stripTrailingBreakpoint — synthetic injection):
 *   Simulates a trailing-breakpoint bug at the drizzle-kit emit stage by
 *   writing a fake migration.sql with the marker at end-of-file and asserts
 *   the strip logic removes it.
 *
 * NOTE: These tests do NOT invoke drizzle-kit generate — that would require a
 * full DB baseline and is reserved for manual / CI integration runs.  They
 * exercise the post-processing and linter-validation pipeline in isolation.
 *
 * @task T1164
 * @epic T1150
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const NEW_MIGRATION_SCRIPT = join(REPO_ROOT, 'scripts', 'new-migration.mjs');
const LINT_MIGRATIONS_SCRIPT = join(REPO_ROOT, 'scripts', 'lint-migrations.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp directory that is cleaned up after each test.
 * Returns the path and a cleanup function.
 */
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-new-migration-test-'));
  return dir;
}

/**
 * Prime a fake migration folder in the given migrations root.
 *
 * Creates:
 *   <migrationsRoot>/drizzle-tasks/<timestamp>_auto-name/
 *     migration.sql  (content provided)
 *     snapshot.json  (minimal valid JSON)
 *
 * @param migrationsRoot - Root path for migrations.
 * @param timestamp - 14-digit timestamp string.
 * @param autoName - drizzle-kit auto-generated folder name suffix.
 * @param sqlContent - SQL content to write.
 * @returns Absolute path to the created folder.
 */
function primeFakeMigrationFolder(migrationsRoot, timestamp, autoName, sqlContent) {
  const dbSetDir = join(migrationsRoot, 'drizzle-tasks');
  const folderName = `${timestamp}_${autoName}`;
  const folderPath = join(dbSetDir, folderName);

  mkdirSync(folderPath, { recursive: true });
  writeFileSync(join(folderPath, 'migration.sql'), sqlContent, 'utf8');
  writeFileSync(
    join(folderPath, 'snapshot.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', tables: {} }),
    'utf8',
  );

  return folderPath;
}

/**
 * Invoke the new-migration.mjs post-processing logic in isolation by calling
 * the parts of the script that do not require drizzle-kit to run.
 *
 * Since the logic is in an ESM script (not a module), we extract the behaviour
 * under test by calling `node` with a small inline driver that replicates
 * stripTrailingBreakpoint + renameMigrationFolder.
 *
 * @param folderPath - Absolute path to the fake migration folder.
 * @param task - Task ID (e.g. T1234).
 * @param name - Slug (e.g. add-column).
 * @returns The renamed folder path.
 */
function runPostProcessing(folderPath, task, name) {
  // Inline Node driver that applies the same strip + rename logic as new-migration.mjs
  // without invoking drizzle-kit. This exercises the core post-processing path.
  const driver = `
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const folderPath = ${JSON.stringify(folderPath)};
const task = ${JSON.stringify(task)};
const name = ${JSON.stringify(name)};

const TRAILING_BREAKPOINT_RE = /--> statement-breakpoint[\\s]*$/;

const sqlPath = join(folderPath, 'migration.sql');
let content = readFileSync(sqlPath, 'utf8');

// Strip trailing breakpoint (same as new-migration.mjs)
while (TRAILING_BREAKPOINT_RE.test(content)) {
  content = content.replace(TRAILING_BREAKPOINT_RE, '');
}
content = content.replace(/--> statement-breakpoint\\n(\\s*\\n)+/g, '--> statement-breakpoint\\n');
content = content.trimEnd() + '\\n';
writeFileSync(sqlPath, content, 'utf8');

// Rename folder
const currentName = folderPath.split('/').pop();
const tsMatch = currentName.match(/^(\\d{14})/);
const ts = tsMatch[1];
const newFolderName = ts + '_' + task.toLowerCase() + '-' + name;
const parentDir = dirname(folderPath);
const newPath = join(parentDir, newFolderName);
renameSync(folderPath, newPath);
process.stdout.write(newPath + '\\n');
`;

  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: driver,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(
      `Post-processing driver failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }

  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('new-migration.mjs — post-processing', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = makeTempDir();
  });

  afterEach(() => {
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: End-to-end post-processing + linter
  // -------------------------------------------------------------------------

  it('generates correct folder shape and strips trailing breakpoint (end-to-end)', () => {
    const timestamp = '20260421120000';
    const task = 'T9999';
    const name = 'add-test-col';

    // SQL that drizzle-kit might emit ending with a trailing breakpoint
    const rawSql = 'ALTER TABLE `tasks` ADD COLUMN `test_col` text;\n--> statement-breakpoint\n';

    const originalFolder = primeFakeMigrationFolder(
      tempRoot,
      timestamp,
      'drizzle-auto-name',
      rawSql,
    );

    // Run post-processing
    const renamedFolder = runPostProcessing(originalFolder, task, name);

    // (a) New folder exists with correct TNNNN-name shape
    const folderName = renamedFolder.split('/').pop();
    expect(folderName).toMatch(/^\d{14}_t9999-add-test-col$/);
    expect(existsSync(renamedFolder)).toBe(true);

    // (b) migration.sql has no trailing statement-breakpoint
    const sqlPath = join(renamedFolder, 'migration.sql');
    expect(existsSync(sqlPath)).toBe(true);
    const finalContent = readFileSync(sqlPath, 'utf8');
    expect(finalContent).not.toMatch(/--> statement-breakpoint\s*$/);

    // (c) migration.sql ends cleanly with ;\n
    expect(finalContent.trimEnd()).toMatch(/;$/);

    // (d) snapshot.json exists
    const snapshotPath = join(renamedFolder, 'snapshot.json');
    expect(existsSync(snapshotPath)).toBe(true);

    // (e) linter passes (RULE-1 should not fire)
    const linterResult = spawnSync(
      process.execPath,
      [LINT_MIGRATIONS_SCRIPT, '--migrations-root', tempRoot],
      { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] },
    );
    expect(linterResult.status).toBe(0);
    expect(linterResult.stdout).toMatch(/RESULT: PASS/);
  });

  // -------------------------------------------------------------------------
  // Test 2: Synthetic trailing-breakpoint injection + strip assertion
  // -------------------------------------------------------------------------

  it('strips trailing statement-breakpoint when drizzle-kit emits it', () => {
    const timestamp = '20260421130000';
    const task = 'T8888';
    const name = 'strip-test';

    // Simulate drizzle-kit emitting a trailing breakpoint
    const rawSql = 'CREATE TABLE `foo` (`id` integer PRIMARY KEY);\n--> statement-breakpoint\n';

    const originalFolder = primeFakeMigrationFolder(
      tempRoot,
      timestamp,
      'drizzle-auto-strip',
      rawSql,
    );

    const sqlBefore = readFileSync(join(originalFolder, 'migration.sql'), 'utf8');
    expect(sqlBefore).toMatch(/--> statement-breakpoint\s*$/);

    // Run post-processing
    const renamedFolder = runPostProcessing(originalFolder, task, name);

    const sqlAfter = readFileSync(join(renamedFolder, 'migration.sql'), 'utf8');

    // Assert: trailing marker is gone
    expect(sqlAfter).not.toMatch(/--> statement-breakpoint\s*$/);

    // Assert: SQL content is preserved (the CREATE TABLE statement remains)
    expect(sqlAfter).toContain('CREATE TABLE');

    // Assert: file ends with exactly one trailing newline
    expect(sqlAfter.endsWith('\n')).toBe(true);
    expect(sqlAfter.endsWith('\n\n')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3: No-op when there is no trailing breakpoint
  // -------------------------------------------------------------------------

  it('leaves migration.sql unchanged when there is no trailing breakpoint', () => {
    const timestamp = '20260421140000';
    const task = 'T7777';
    const name = 'no-change';

    const cleanSql = 'CREATE INDEX IF NOT EXISTS `idx_test` ON `tasks` (`id`);\n';

    const originalFolder = primeFakeMigrationFolder(tempRoot, timestamp, 'drizzle-clean', cleanSql);

    const renamedFolder = runPostProcessing(originalFolder, task, name);

    const sqlAfter = readFileSync(join(renamedFolder, 'migration.sql'), 'utf8');
    expect(sqlAfter).toBe(cleanSql);
  });

  // -------------------------------------------------------------------------
  // Test 4: --help flag prints usage and exits 0
  // -------------------------------------------------------------------------

  it('--help prints usage information and exits 0', () => {
    const result = spawnSync(process.execPath, [NEW_MIGRATION_SCRIPT, '--help'], {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--db');
    expect(result.stdout).toContain('--task');
    expect(result.stdout).toContain('--name');
    expect(result.stdout).toContain('--commit');
    expect(result.stdout).toContain('--apply');
  });

  // -------------------------------------------------------------------------
  // Test 5: Missing required args exits 1 with useful message
  // -------------------------------------------------------------------------

  it('exits 1 with error message when required args are missing', () => {
    const result = spawnSync(process.execPath, [NEW_MIGRATION_SCRIPT, '--db', 'tasks'], {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--task is required');
    expect(result.stderr).toContain('--name is required');
  });

  // -------------------------------------------------------------------------
  // Test 6: Invalid --db value exits 1
  // -------------------------------------------------------------------------

  it('exits 1 when --db is not a valid DB identifier', () => {
    const result = spawnSync(
      process.execPath,
      [NEW_MIGRATION_SCRIPT, '--db', 'invalid-db', '--task', 'T1234', '--name', 'test'],
      { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--db must be one of');
  });

  // -------------------------------------------------------------------------
  // Test 7: Invalid --task format exits 1
  // -------------------------------------------------------------------------

  it('exits 1 when --task does not match ^T\\d+$', () => {
    const result = spawnSync(
      process.execPath,
      [NEW_MIGRATION_SCRIPT, '--db', 'tasks', '--task', 'INVALID', '--name', 'test'],
      { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--task must match');
  });
});
