/**
 * Integration / smoke tests for migrateSanitized (T1159).
 *
 * Verifies that:
 * 1. migrateSanitized succeeds on a migration file that ends with a trailing
 *    "--> statement-breakpoint" marker (which produces a whitespace-only chunk
 *    in drizzle's readMigrationFiles output).
 * 2. drizzle's raw migrate() fails on the same malformed migration — confirming
 *    the guard is load-bearing and not just defensive noise.
 *
 * drizzle-orm v1 beta.22 migration folder format:
 *   <migrationsFolder>/
 *     <timestamp>_<name>/
 *       migration.sql
 *       snapshot.json  (optional — only hash of migration.sql matters)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Write a synthetic drizzle v1 beta.22 migrations folder containing one
 * migration whose SQL ends with a trailing statement-breakpoint marker.
 *
 * drizzle's readMigrationFiles (v1 beta.22) scans subdirectories and reads
 * `migration.sql` from each one. It splits on "--> statement-breakpoint",
 * so a trailing marker produces a sql array ending in "\n" (whitespace only).
 * session.run(sql.raw("\n")) crashes with "Failed to run the query '\n'".
 */
function writeTrailingBreakpointMigration(migrationsDir: string): void {
  mkdirSync(migrationsDir, { recursive: true });

  // drizzle v1 beta.22 stores each migration in a subdirectory.
  // Timestamp prefix must be exactly 14 chars for formatToMillis() to parse.
  const migSubDir = join(migrationsDir, '20260101000000_smoke_test');
  mkdirSync(migSubDir, { recursive: true });

  // SQL ending with a trailing "--> statement-breakpoint\n".
  // After readMigrationFiles splits on the marker, sql becomes:
  //   ["CREATE TABLE smoke_test ...;\n", "\n"]
  // The "\n" is whitespace-only and crashes session.run().
  const sqlContent =
    'CREATE TABLE smoke_test (id INTEGER PRIMARY KEY, value TEXT);\n--> statement-breakpoint\n';

  writeFileSync(join(migSubDir, 'migration.sql'), sqlContent);
}

describe('migrateSanitized — smoke test (T1159)', () => {
  let tempDir: string;
  const _require = createRequire(import.meta.url);
  const { DatabaseSync } = _require('node:sqlite') as {
    DatabaseSync: new (path: string) => import('node:sqlite').DatabaseSync;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-migrate-sanitized-smoke-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('succeeds on a migration that ends with a trailing statement-breakpoint marker', async () => {
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'smoke-sanitized.db');
    const migrationsDir = join(tempDir, 'migrations-trailing');
    writeTrailingBreakpointMigration(migrationsDir);

    const nativeDb = new DatabaseSync(dbPath);
    nativeDb.exec('PRAGMA journal_mode=WAL');
    const db = drizzle({ client: nativeDb });

    // migrateSanitized should NOT throw — it filters the whitespace-only "\n" chunk
    expect(() => migrateSanitized(db, { migrationsFolder: migrationsDir })).not.toThrow();

    // The table must have been created by the migration
    const row = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smoke_test'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('smoke_test');

    nativeDb.close();
  });

  it('drizzle raw migrate() throws on the same malformed migration — guard is load-bearing', async () => {
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { migrate } = await import('drizzle-orm/node-sqlite/migrator');

    const dbPath = join(tempDir, 'smoke-raw.db');
    const migrationsDir = join(tempDir, 'migrations-raw');
    writeTrailingBreakpointMigration(migrationsDir);

    const nativeDb = new DatabaseSync(dbPath);
    nativeDb.exec('PRAGMA journal_mode=WAL');
    const db = drizzle({ client: nativeDb });

    // drizzle's raw migrate() SHOULD throw — "\n" chunk hits session.run()
    expect(() => migrate(db, { migrationsFolder: migrationsDir })).toThrow();

    nativeDb.close();
  });
});
