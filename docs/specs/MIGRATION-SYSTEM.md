# Migration System

CLEO uses two complementary migration systems: **Drizzle ORM migrations** for SQLite schema changes, and a **TypeScript migration framework** in `src/core/migration/` for legacy JSON data upgrades.

## Schema Source of Truth

The canonical database schema is defined in `src/store/schema.ts`. This file uses Drizzle ORM's `sqliteTable` definitions to declare all tables, columns, indexes, constraints, and type exports.

Status enums (task, session, pipeline, stage, ADR, gate, manifest) are centralized in `src/store/status-registry.ts` per ADR-018. The schema file re-exports these constants so existing imports from `schema.ts` continue to work.

The Drizzle configuration at `drizzle.config.ts` points drizzle-kit to this schema file and outputs migrations to the `drizzle/` directory.

## Drizzle Migrations (SQLite Schema)

### How Migrations Work

Each migration lives in a timestamped directory under `drizzle/` containing exactly two files:

- `migration.sql` -- the SQL statements to execute
- `snapshot.json` -- a drizzle-kit-generated snapshot of the schema state after this migration

Migrations are applied automatically on database initialization. When `getDb()` is called in `src/store/sqlite.ts`, it runs `runMigrations()` which:

1. Resolves the migrations folder relative to the package root (`drizzle/`)
2. Bootstraps pre-existing databases that predate Drizzle migrations by marking the baseline migration as already applied (ADR-012 Step D)
3. Calls `drizzle-orm/sqlite-proxy/migrator`'s `migrate()` function, which reads all migration files and applies any that haven't been recorded in the `__drizzle_migrations` table
4. Each migration batch runs inside a `BEGIN IMMEDIATE` transaction for concurrency safety
5. On `SQLITE_BUSY` errors, retries with exponential backoff and jitter

### Standard Migration Workflow

Use this workflow when adding or modifying tables, columns, or indexes -- changes that drizzle-kit can detect by diffing the schema file against the most recent snapshot.

1. Edit `src/store/schema.ts` with the desired changes
2. Run `npx drizzle-kit generate`
3. Inspect the generated SQL in `drizzle/<timestamp>_<name>/migration.sql`
4. If the generated SQL contains already-applied statements (from a broken prior chain), trim those statements from `migration.sql` -- **leave `snapshot.json` untouched**
5. Commit both `migration.sql` and `snapshot.json` together

### Custom Migration Workflow

Use this workflow when changing CHECK constraints or enum values. Drizzle-kit's SQLite snapshots store column type (`text`) but not CHECK constraint values, so `{ enum: [...] }` on a SQLite column is TypeScript-only metadata that drizzle-kit cannot diff. These changes will return "No schema changes" from a standard generate.

1. Edit `src/store/schema.ts` and `src/store/status-registry.ts` with the new values
2. Run `npx drizzle-kit generate` to confirm it reports "No schema changes"
3. Run `npx drizzle-kit generate --custom --name "describe-the-change"`
4. Fill in the generated (empty) `migration.sql` with the table-rebuild SQL
5. Commit `migration.sql` and `snapshot.json` together

SQLite requires a table rebuild to modify CHECK constraints. The pattern is:

```sql
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_table_name` (...new schema with updated CHECK...);
INSERT INTO `__new_table_name`(...) SELECT ... FROM `table_name`;
DROP TABLE `table_name`;
ALTER TABLE `__new_table_name` RENAME TO `table_name`;
PRAGMA foreign_keys=ON;
```

Use `--> statement-breakpoint` between statements (the Drizzle migration parser uses this as a delimiter).

### Snapshot Chain Integrity

Snapshots form a linked chain. Each `snapshot.json` records the DDL state of the database after its migration is applied. When you run `npx drizzle-kit generate`, drizzle-kit diffs the current `schema.ts` against the **last snapshot** to determine what changed.

**Rules:**

- Never hand-write a `snapshot.json` -- always let drizzle-kit generate it
- Never copy a `snapshot.json` from another migration and edit it
- Never create a `snapshot.json` with `"ddl": []` or `"prevIds": []`
- A migration without a snapshot breaks the diff chain: the next `drizzle-kit generate` will produce incorrect output
- The pre-commit hook enforces that every `drizzle/*/migration.sql` has a sibling `snapshot.json`

### Migration Execution Details

The `runMigrations()` function in `src/store/sqlite.ts` handles several edge cases:

- **Pre-Drizzle databases**: If a `tasks` table exists but no `__drizzle_migrations` table, the baseline migration hash is inserted to prevent re-running initial table creation
- **Concurrency**: `BEGIN IMMEDIATE` acquires a RESERVED lock upfront, preventing parallel MCP server starts from racing on the same migration
- **SQLITE_BUSY retry**: On lock contention, retries with exponential backoff up to a configurable maximum. The SQLite `busy_timeout` (5000ms) provides first-line defense; the retry loop handles cases where a lock holder runs long migrations
- **Transaction safety**: Each migration batch is wrapped in a transaction. If a `CREATE TABLE` fails, the `ROLLBACK` ensures the migration hash is not recorded, so it will retry on next startup rather than leaving the schema in an inconsistent state

## TypeScript Migration Framework (Legacy JSON)

The `src/core/migration/` module handles upgrades of legacy JSON data files (`todo.json`, `sessions.json`, `todo-archive.json`). This system predates the SQLite migration and remains for backward compatibility.

### Version Detection

`detectVersion()` reads schema versions from JSON data files:
1. Checks `_meta.schemaVersion` (canonical location)
2. Falls back to top-level `.version` field
3. Returns `'0.0.0'` if neither is found

### Migration Registry

Migrations are registered in a `MIGRATIONS` record keyed by file type (`todo`, `config`, `archive`). Each migration specifies:

- `fromVersion` / `toVersion` -- the version range
- `description` -- human-readable summary
- `migrate` -- transformation function that takes the parsed JSON and returns updated data

Migrations are applied sequentially in version order. After all applicable migrations run, the `_meta.schemaVersion` is updated to the target version.

### Running Migrations

- `getMigrationStatus(cwd?)` -- checks all data files and returns which need migration
- `runMigration(fileType, options?, cwd?)` -- runs migrations for a specific file type
- `runAllMigrations(options?, cwd?)` -- runs all pending migrations across all file types
- All functions support a `dryRun` option for previewing changes

### Pre-flight Checks

`checkStorageMigration()` in `src/core/migration/preflight.ts` detects when legacy JSON data exists but hasn't been migrated to SQLite, providing diagnostics for users upgrading from V1. This is a read-only check that examines file existence and record counts.

### Migration State Tracking

`src/core/migration/state.ts` provides persistent state tracking for long-running migrations:

- Tracks migration phase (`init` -> `backup` -> `validate` -> `import` -> `verify` -> `cleanup` -> `complete`)
- Records source file checksums for integrity verification
- Enables resumable migrations after interruptions
- State is written atomically (temp file + rename)

### Checksum Verification

`src/core/migration/checksum.ts` provides SHA-256 checksum utilities:

- `computeChecksum(filePath)` -- SHA-256 of a file
- `verifyBackup(sourcePath, backupPath)` -- compares checksums and validates SQLite database integrity
- `compareChecksums(file1, file2)` -- quick content comparison

### Pre-Migration Validation

`src/core/migration/validate.ts` validates all JSON source files **before** any destructive operations:

- Checks that files are parseable JSON
- Counts records to detect empty files
- Detects task count mismatches between existing database and JSON
- Provides formatted output for user display

### Migration Logging

`src/core/migration/logger.ts` provides structured JSONL logging:

- Log files stored in `.cleo/logs/migration-<timestamp>.jsonl`
- Supports severity levels: `debug`, `info`, `warn`, `error`
- Tracks file operations, validation results, and import progress
- Automatic cleanup of old log files (default: keep 10)

## Auto-Recovery System

The database initialization in `src/store/sqlite.ts` includes an auto-recovery mechanism (T5188):

- After migrations complete, `autoRecoverFromBackup()` checks if the tasks table is empty
- If a backup exists with data (minimum 10 tasks), the database is automatically restored
- This guards against data loss caused by git-tracked WAL/SHM files being overwritten during branch switches
- Recovery is non-fatal: if it fails, the system continues with the empty database

## Common Pitfalls

1. **Never hand-write migration files** -- always use `drizzle-kit generate` or `drizzle-kit generate --custom`
2. **Never copy snapshots between migrations** -- each snapshot must be generated by drizzle-kit
3. **Never create a snapshot with empty DDL** -- this breaks the diff chain
4. **Always commit migration.sql and snapshot.json together** -- orphaned files break the chain
5. **Use `--custom` for CHECK constraint changes** -- drizzle-kit cannot detect these automatically
6. **Never edit the database directly** -- use CLI commands or the core API
7. **Never hand-edit `.cleo/tasks.db`** -- all writes go through the store layer with atomic operations

## Legacy Notes

The original Bash migration system (`lib/migrate.sh`) has been removed. All migration logic is now in TypeScript under `src/core/migration/` and `src/store/sqlite.ts`. The JSON migration framework remains for upgrading installations that still have legacy JSON data files from before the SQLite transition (ADR-006).
