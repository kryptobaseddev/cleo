#!/usr/bin/env node
/**
 * lint-migrations.mjs — standalone SQL migration linter for CLEO.
 *
 * Scans packages/core/migrations/** /migration.sql and reports:
 *   RULE-1: Files ending with `--> statement-breakpoint` followed by only whitespace/EOF.
 *   RULE-2: Timestamp collisions (two folders share the same 14-digit timestamp within one DB set).
 *   RULE-3: Orphan snapshot.json (snapshot present but no sibling migration.sql, or vice-versa in
 *           DB sets where snapshots are expected but a folder has one without neighbors having any).
 *   RULE-4: Folder names not matching /^\d{14}_[a-z0-9-]+$/.
 *   RULE-5: Multi-statement migration.sql files missing `--> statement-breakpoint` separators.
 *           node:sqlite's prepare() silently truncates to the first statement when no breakpoints
 *           are present; this rule catches files where statement count exceeds breakpoint count + 1.
 *
 * Usage:
 *   node scripts/lint-migrations.mjs [--migrations-root <path>] [--fail-on=error|warn|none]
 *                                    [--enable-rule-5]
 *
 * Flags:
 *   --migrations-root <path>  Override the migrations root directory.
 *   --fail-on=error           Exit 1 only when there are ERROR-severity violations (default).
 *   --fail-on=warn            Exit 1 when there are any violations (ERROR or WARN).
 *   --fail-on=none            Always exit 0 (report-only mode).
 *   --enable-rule-5           Enable RULE-5 (missing-breakpoint detector). Off by default until
 *                             T9166 lands the breakpoint fixes for the known 7 brain migrations.
 *
 * GitHub Actions:
 *   When GITHUB_ACTIONS=true is set in environment, violations are emitted as
 *   ::error and ::warning workflow commands so findings appear inline on PR diffs.
 *
 * Exits 0 on clean (or when fail-on=none), 1 on qualifying violations.
 *
 * @task T1153
 * @task T1168
 * @task T9165
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/** Folder-name pattern required for standard migration directories. */
const FOLDER_NAME_RE = /^\d{14}_[a-z0-9-]+$/;

/** Pattern that matches a trailing --> statement-breakpoint at end of file. */
// Matches `-->` followed by optional spaces, `statement-breakpoint`, then only whitespace to EOF.
const TRAILING_BREAKPOINT_RE = /--> statement-breakpoint\s*$/;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--migrations-root');
const MIGRATIONS_ROOT =
  rootIdx !== -1 && args[rootIdx + 1]
    ? args[rootIdx + 1]
    : join(REPO_ROOT, 'packages/core/migrations');

/**
 * Threshold at which the process exits 1.
 * - 'error'  → exit 1 only when ERRORs exist (default)
 * - 'warn'   → exit 1 when any violation exists
 * - 'none'   → always exit 0 (report-only mode)
 */
const failOnArg = args.find((a) => a.startsWith('--fail-on='));
const FAIL_ON = failOnArg ? failOnArg.slice('--fail-on='.length) : 'error';
if (!['error', 'warn', 'none'].includes(FAIL_ON)) {
  process.stderr.write(
    `lint-migrations: unknown --fail-on value "${FAIL_ON}". Use error|warn|none.\n`,
  );
  process.exit(2);
}

/** True when running inside GitHub Actions — enables workflow annotation output. */
const IS_GHA = process.env.GITHUB_ACTIONS === 'true';

/**
 * True when RULE-5 (missing-breakpoint detector) is enabled via --enable-rule-5.
 *
 * RULE-5 is gated behind this flag until T9166 lands the breakpoint fixes for the
 * known 7 brain migrations that currently lack separators. Once T9166 merges, the
 * flag can be removed and RULE-5 enabled unconditionally.
 *
 * @see T9163 — parent epic documenting the node:sqlite prepare() truncation issue
 * @see T9166 — sibling task that adds the missing breakpoints to the 7 brain migrations
 */
const RULE_5_ENABLED = args.includes('--enable-rule-5');

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

/**
 * Returns the list of DB-set directories directly under MIGRATIONS_ROOT.
 * Each is a `drizzle-<name>` directory.
 */
function getDbSets() {
  return readdirSync(MIGRATIONS_ROOT).filter((name) => {
    const full = join(MIGRATIONS_ROOT, name);
    return statSync(full).isDirectory() && name.startsWith('drizzle-');
  });
}

/**
 * For a given DB set directory, return all direct child folder names.
 */
function getMigrationFolders(dbSetPath) {
  return readdirSync(dbSetPath).filter((name) => {
    const full = join(dbSetPath, name);
    return statSync(full).isDirectory();
  });
}

// ---------------------------------------------------------------------------
// Rule checkers
// ---------------------------------------------------------------------------

/**
 * RULE-1: Detect migration.sql files whose last non-whitespace content is
 * `--> statement-breakpoint`.
 *
 * The statement-breakpoint marker is a drizzle-kit hint for its own migration
 * runner — it is not valid SQL. When a file ends with this marker the last SQL
 * statement was never written, which signals a truncated or incorrectly
 * generated migration.
 */
function rule1TrailingBreakpoint(violations, dbSet, folderName, migrationSqlPath) {
  const content = readFileSync(migrationSqlPath, 'utf8');
  if (TRAILING_BREAKPOINT_RE.test(content)) {
    violations.push({
      rule: 'RULE-1',
      severity: 'ERROR',
      file: migrationSqlPath,
      message: `File ends with "--> statement-breakpoint" with no following SQL statement.`,
      detail: `Last 100 chars: ${JSON.stringify(content.slice(-100))}`,
    });
  }
}

/**
 * RULE-2: Timestamp collision detection.
 *
 * Within a single DB set, each folder must begin with a unique 14-digit timestamp.
 * Two folders sharing the same timestamp prefix cause non-deterministic migration
 * ordering and can break the reconciler.
 *
 * Note: The signaldock DB set uses a different naming convention (date-based flat SQL
 * files, not folders). We skip timestamp collision checks for that set since it has
 * its own migration runner.
 */
function rule2TimestampCollisions(violations, dbSet, folderNames) {
  const timestampMap = new Map(); // timestamp -> [folderName, ...]
  for (const folder of folderNames) {
    const match = folder.match(/^(\d{14})/);
    if (!match) continue; // non-standard folder — caught by RULE-4
    const ts = match[1];
    if (!timestampMap.has(ts)) timestampMap.set(ts, []);
    timestampMap.get(ts).push(folder);
  }
  for (const [ts, folders] of timestampMap.entries()) {
    if (folders.length > 1) {
      violations.push({
        rule: 'RULE-2',
        severity: 'ERROR',
        file: join(MIGRATIONS_ROOT, dbSet),
        message: `Timestamp collision: ${folders.length} folders share timestamp ${ts}.`,
        detail: `Colliding folders: ${folders.join(', ')}`,
      });
    }
  }
}

/**
 * RULE-3: Orphan snapshot.json detection.
 *
 * A snapshot.json file must be accompanied by a migration.sql in the same folder.
 * A missing snapshot.json is also flagged when at least one sibling folder in the
 * same DB set has a snapshot.json (meaning snapshots are expected for that DB set).
 *
 * Rationale: snapshot.json files are drizzle-kit output. In a hand-rolled workflow
 * they become orphans. This rule surfaces them as violations so removal can be
 * tracked explicitly.
 */
function rule3OrphanSnapshots(violations, dbSet, dbSetPath, folderNames) {
  const foldersWithSnapshots = [];
  const foldersWithoutSnapshots = [];
  const foldersWithSql = [];
  const foldersWithoutSql = [];

  for (const folder of folderNames) {
    const folderPath = join(dbSetPath, folder);
    const hasSnapshot = existsSync(join(folderPath, 'snapshot.json'));
    const hasSql = existsSync(join(folderPath, 'migration.sql'));
    if (hasSnapshot) foldersWithSnapshots.push(folder);
    else foldersWithoutSnapshots.push(folder);
    if (hasSql) foldersWithSql.push(folder);
    else foldersWithoutSql.push(folder);

    // Snapshot with no migration.sql — always an error
    if (hasSnapshot && !hasSql) {
      violations.push({
        rule: 'RULE-3',
        severity: 'ERROR',
        file: join(folderPath, 'snapshot.json'),
        message: `Orphan snapshot.json: folder has snapshot but no migration.sql.`,
        detail: `Folder: ${folder}`,
      });
    }
  }

  // If the DB set has a mix — some folders have snapshots, some don't —
  // flag the folders missing snapshots (they were created hand-rolled after
  // drizzle-kit was used for earlier migrations, leaving an inconsistent chain).
  const someHaveSnapshots = foldersWithSnapshots.length > 0;
  const someHaveNoSnapshots = foldersWithoutSnapshots.length > 0;
  if (someHaveSnapshots && someHaveNoSnapshots) {
    for (const folder of foldersWithoutSnapshots) {
      const folderPath = join(dbSetPath, folder);
      // Only flag if migration.sql exists (folder is a real migration, not a stray dir)
      if (existsSync(join(folderPath, 'migration.sql'))) {
        violations.push({
          rule: 'RULE-3',
          severity: 'WARN',
          file: join(folderPath, 'migration.sql'),
          message: `Inconsistent snapshot chain: sibling folders have snapshot.json but this one does not.`,
          detail: `Folder: ${folder} — DB set ${dbSet} has ${foldersWithSnapshots.length} folder(s) with snapshots and ${foldersWithoutSnapshots.length} without.`,
        });
      }
    }
  }
}

/**
 * RULE-4: Folder naming convention.
 *
 * Standard migration folders must match: /^\d{14}_[a-z0-9-]+$/
 * (14-digit timestamp + underscore + lowercase alphanumeric slug with hyphens allowed).
 *
 * The signaldock DB set uses a legacy flat SQL file pattern (not a folder-based
 * convention). Flat .sql files in a DB set are flagged with a WARN, not ERROR,
 * since signaldock has its own migration runner.
 */
function rule4FolderNames(violations, dbSet, dbSetPath, folderNames) {
  for (const folder of folderNames) {
    if (!FOLDER_NAME_RE.test(folder)) {
      violations.push({
        rule: 'RULE-4',
        severity: 'ERROR',
        file: join(dbSetPath, folder),
        message: `Folder name does not match required pattern ^\\d{14}_[a-z0-9-]+$.`,
        detail: `Actual name: "${folder}"`,
      });
    }
  }

  // Also detect flat .sql files directly in the DB set directory (not in subdirs)
  const directFiles = readdirSync(dbSetPath).filter((name) => {
    const full = join(dbSetPath, name);
    return !statSync(full).isDirectory() && name.endsWith('.sql');
  });
  for (const file of directFiles) {
    violations.push({
      rule: 'RULE-4',
      severity: 'WARN',
      file: join(dbSetPath, file),
      message: `Flat .sql file found directly in DB set directory — expected subdirectory/migration.sql pattern.`,
      detail: `File: ${file} — DB set: ${dbSet}`,
    });
  }
}

/**
 * Count the number of `;`-terminated SQL statements in a migration file, skipping
 * semicolons that appear inside string literals or SQL comments.
 *
 * The scanner is a single-pass state machine that tracks:
 *   - Single-quoted string literals (`'...'`, with `''` escape)
 *   - Double-quoted identifiers (`"..."`, with `""` escape)
 *   - Line comments (`-- ...` through end-of-line)
 *   - Block comments (`/* ... *\/`)
 *
 * Only `;` characters that are NOT inside any of the above contexts are counted
 * as statement terminators.
 *
 * @param {string} sql - Raw content of a migration.sql file.
 * @returns {number} Count of top-level semicolons (statement terminators).
 */
function countSqlStatements(sql) {
  let count = 0;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];

    // Line comment: -- ... \n
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }

    // Block comment: /* ... */
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2; // skip closing */
      continue;
    }

    // Single-quoted string: '...' ('' is escaped quote, not end)
    if (ch === "'") {
      i++;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2; // escaped quote
        } else if (sql[i] === "'") {
          i++; // closing quote
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Double-quoted identifier: "..." ("" is escaped quote)
    if (ch === '"') {
      i++;
      while (i < len) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2; // escaped quote
        } else if (sql[i] === '"') {
          i++; // closing quote
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Backtick-quoted identifier (MySQL/SQLite extension): `...`
    if (ch === '`') {
      i++;
      while (i < len && sql[i] !== '`') i++;
      if (i < len) i++; // skip closing backtick
      continue;
    }

    // Top-level semicolon — statement terminator
    if (ch === ';') {
      count++;
      i++;
      continue;
    }

    i++;
  }

  return count;
}

/**
 * Count the number of `--> statement-breakpoint` markers in raw file content.
 *
 * The markers are drizzle-kit hints inserted between SQL statements. When a
 * file contains N SQL statements, it requires exactly N-1 markers.
 *
 * @param {string} content - Raw content of a migration.sql file.
 * @returns {number} Count of statement-breakpoint markers.
 */
function countBreakpoints(content) {
  // Use a global regex to count all occurrences of the marker string.
  return (content.match(/--> statement-breakpoint/g) ?? []).length;
}

/**
 * RULE-5: Detect multi-statement migration.sql files that are missing
 * `--> statement-breakpoint` separators between statements.
 *
 * Rationale: node:sqlite's `prepare()` method silently truncates execution to
 * the first SQL statement when a file contains multiple statements without the
 * drizzle-kit breakpoint markers. This causes subsequent DDL/DML to be
 * silently skipped, leaving the schema in a partially applied state.
 *
 * Detection logic:
 *   1. Count `;`-terminated top-level statements (ignoring literals/comments).
 *   2. Count `--> statement-breakpoint` markers.
 *   3. If statements > 1 AND markers < (statements - 1), emit ERROR.
 *
 * This rule is gated behind `--enable-rule-5` until T9166 lands the
 * breakpoint fixes for the known 7 brain migrations.
 *
 * @see T9163 — parent epic: node:sqlite prepare() truncation investigation
 * @see T9166 — sibling task: adds missing breakpoints to 7 brain migrations
 *
 * @param {Array} violations - Violations array to append to.
 * @param {string} _dbSet - DB set name (unused, kept for signature consistency).
 * @param {string} _folderName - Migration folder name (unused, kept for signature consistency).
 * @param {string} migrationSqlPath - Absolute path to the migration.sql file.
 */
function rule5MissingBreakpoints(violations, _dbSet, _folderName, migrationSqlPath) {
  const content = readFileSync(migrationSqlPath, 'utf8');
  const stmtCount = countSqlStatements(content);
  const breakpointCount = countBreakpoints(content);

  if (stmtCount > 1 && breakpointCount < stmtCount - 1) {
    violations.push({
      rule: 'RULE-5',
      severity: 'ERROR',
      file: migrationSqlPath,
      message: `Multi-statement migration missing statement-breakpoint separators: ${stmtCount} statement(s) but only ${breakpointCount} breakpoint(s) (need ${stmtCount - 1}).`,
      detail: `node:sqlite prepare() silently truncates to the first statement without breakpoints. Add "--> statement-breakpoint" between each SQL statement. See T9163.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const violations = [];
  const stats = {
    dbSets: 0,
    folders: 0,
    sqlFiles: 0,
    snapshotFiles: 0,
    errors: 0,
    warnings: 0,
  };

  const dbSets = getDbSets();
  stats.dbSets = dbSets.length;

  for (const dbSet of dbSets) {
    const dbSetPath = join(MIGRATIONS_ROOT, dbSet);
    const folderNames = getMigrationFolders(dbSetPath);
    stats.folders += folderNames.length;

    // RULE-2: timestamp collisions (across all folders in this DB set)
    rule2TimestampCollisions(violations, dbSet, folderNames);

    // RULE-4: folder naming (folders)
    rule4FolderNames(violations, dbSet, dbSetPath, folderNames);

    // RULE-3: orphan snapshots (DB-set level analysis)
    rule3OrphanSnapshots(violations, dbSet, dbSetPath, folderNames);

    // Per-folder checks
    for (const folder of folderNames) {
      const folderPath = join(dbSetPath, folder);
      const sqlPath = join(folderPath, 'migration.sql');
      const snapshotPath = join(folderPath, 'snapshot.json');

      if (existsSync(snapshotPath)) stats.snapshotFiles++;

      if (!existsSync(sqlPath)) {
        // No migration.sql in folder — RULE-3 covers snapshot-without-sql;
        // flag missing SQL if there is no snapshot either (truly empty folder)
        if (!existsSync(snapshotPath)) {
          violations.push({
            rule: 'RULE-3',
            severity: 'WARN',
            file: folderPath,
            message: `Migration folder contains neither migration.sql nor snapshot.json.`,
            detail: `Folder: ${folder}`,
          });
        }
        continue;
      }

      stats.sqlFiles++;

      // RULE-1: trailing statement-breakpoint
      rule1TrailingBreakpoint(violations, dbSet, folder, sqlPath);

      // RULE-5: missing statement-breakpoint separators (gated behind --enable-rule-5)
      if (RULE_5_ENABLED) {
        rule5MissingBreakpoints(violations, dbSet, folder, sqlPath);
      }
    }
  }

  // Tally severities
  for (const v of violations) {
    if (v.severity === 'ERROR') stats.errors++;
    else stats.warnings++;
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  const lines = [];
  lines.push('=== CLEO Migration Linter — T1153 R3 ===');
  lines.push(`Run at: ${new Date().toISOString()}`);
  lines.push(`Migrations root: ${MIGRATIONS_ROOT}`);
  lines.push('');
  lines.push('--- Scan Summary ---');
  lines.push(`  DB sets scanned:     ${stats.dbSets}`);
  lines.push(`  Migration folders:   ${stats.folders}`);
  lines.push(`  migration.sql files: ${stats.sqlFiles}`);
  lines.push(`  snapshot.json files: ${stats.snapshotFiles}`);
  lines.push(`  Errors:              ${stats.errors}`);
  lines.push(`  Warnings:            ${stats.warnings}`);
  lines.push(`  Total violations:    ${violations.length}`);
  lines.push(
    `  RULE-5 enabled:      ${RULE_5_ENABLED ? 'yes (--enable-rule-5)' : 'no (pass --enable-rule-5 to activate)'}`,
  );
  lines.push('');

  if (violations.length === 0) {
    lines.push('RESULT: PASS — no violations found.');
  } else {
    lines.push(`RESULT: FAIL — ${violations.length} violation(s) found.`);
    lines.push('');
    lines.push('--- Violations ---');
    for (const v of violations) {
      lines.push('');
      lines.push(`[${v.severity}] ${v.rule}`);
      lines.push(`  File:    ${v.file}`);
      lines.push(`  Message: ${v.message}`);
      if (v.detail) lines.push(`  Detail:  ${v.detail}`);
    }
  }

  lines.push('');
  lines.push('--- DB Set Inventory ---');
  for (const dbSet of dbSets) {
    const dbSetPath = join(MIGRATIONS_ROOT, dbSet);
    const folderNames = getMigrationFolders(dbSetPath);
    const flatSqlFiles = readdirSync(dbSetPath).filter((n) => {
      const full = join(dbSetPath, n);
      return !statSync(full).isDirectory() && n.endsWith('.sql');
    });
    lines.push(
      `  ${dbSet}: ${folderNames.length} folder(s), ${flatSqlFiles.length} flat SQL file(s)`,
    );
    for (const folder of folderNames) {
      const folderPath = join(dbSetPath, folder);
      const hasSql = existsSync(join(folderPath, 'migration.sql'));
      const hasSnap = existsSync(join(folderPath, 'snapshot.json'));
      const flags = [
        hasSql ? 'migration.sql' : 'NO-SQL',
        hasSnap ? 'snapshot.json' : 'no-snap',
      ].join(' | ');
      lines.push(`    ${folder}  [${flags}]`);
    }
    for (const file of flatSqlFiles) {
      lines.push(`    ${file}  [flat SQL]`);
    }
  }

  const report = lines.join('\n');

  // Print to stdout
  process.stdout.write(report + '\n');

  // GitHub Actions workflow annotations — emit ::error / ::warning for inline PR diff view.
  // File paths are made relative to REPO_ROOT for cleaner annotation display.
  if (IS_GHA) {
    for (const v of violations) {
      // Produce a repo-relative path when possible; fall back to absolute.
      const relFile = v.file.startsWith(REPO_ROOT) ? v.file.slice(REPO_ROOT.length + 1) : v.file;
      const level = v.severity === 'ERROR' ? 'error' : 'warning';
      // GitHub Actions annotation format: ::<level> file=<path>::<message>
      process.stdout.write(`::${level} file=${relFile}::${v.rule}: ${v.message}\n`);
    }
  }

  // Determine exit code based on --fail-on threshold.
  let shouldFail = false;
  if (FAIL_ON === 'error') {
    shouldFail = stats.errors > 0;
  } else if (FAIL_ON === 'warn') {
    shouldFail = violations.length > 0;
  }
  // FAIL_ON === 'none' → shouldFail stays false

  process.exit(shouldFail ? 1 : 0);
}

main();
