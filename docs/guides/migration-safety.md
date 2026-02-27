# Migration Safety

**Task**: T4731
**Epic**: T4454
**Pillar**: Deterministic Safety

---

## Overview

CLEO's migration safety system ensures that data transitions (JSON-to-SQLite, schema upgrades, agent-output relocations) complete without data loss or corruption. The system implements four safety layers that work together to provide crash-safe, resumable, and auditable migrations.

This aligns with **Pillar 4: Deterministic Safety** from the CLEO Vision — no partial writes, no hallucinated references, no skipped validation.

### Safety Guarantees

- **Atomic writes**: Temp file, validate, backup, rename. A crash at any point leaves data in a recoverable state.
- **Pre-validation**: All source files are parsed and validated before any destructive operation begins.
- **Resumable state**: Migration progress is tracked on disk so interrupted migrations can be diagnosed and resumed.
- **Audit trail**: Every phase, file operation, and error is logged in structured JSONL format.

---

## Architecture: Four Safety Layers

### Layer 1: File Locking (`src/store/lock.ts`)

Prevents concurrent modifications using `proper-lockfile`.

| Setting | Default | Description |
|---------|---------|-------------|
| Retries | 3 | Number of lock acquisition attempts |
| Min timeout | 100ms | Initial retry delay |
| Max timeout | 1000ms | Maximum retry delay (exponential backoff, factor 2) |
| Stale | 10,000ms | Lock considered stale after this duration |

The `withLock(filePath, fn)` helper acquires an exclusive lock, executes the callback, and releases the lock in a `finally` block — ensuring release even on error.

If a lock cannot be acquired, CLEO throws `E_LOCK_TIMEOUT` with a fix suggestion to wait and retry.

### Layer 2: Pre-Migration Validation (`src/core/migration/validate.ts`)

Before any destructive operation, `validateSourceFiles(cleoDir)` checks every JSON source file:

1. **Existence check** — Missing files are acceptable (no data of that type).
2. **Non-empty check** — Rejects zero-byte files and whitespace-only files.
3. **Parse check** — Attempts `JSON.parse()` and reports line/column on failure.
4. **Count extraction** — Counts tasks, sessions, and archived tasks for progress tracking.
5. **Cross-reference check** — `checkTaskCountMismatch()` warns if a database exists but JSON has zero tasks (possible wrong-directory scenario).

Validation runs synchronously and is read-only. It never modifies any files.

### Layer 3: State Tracking (`src/core/migration/state.ts`)

Persistent state is written to `.cleo/.migration-state.json` at each phase transition. This enables:

- **Resumability**: If the process is killed, state shows exactly which phase was interrupted.
- **Integrity verification**: Source file SHA-256 checksums are captured at migration start and can be re-verified with `verifySourceIntegrity()`.
- **Progress monitoring**: Import counts update during long operations.

State writes use a write-to-temp-then-copy pattern for crash safety.

### Layer 4: Structured Audit Logging (`src/core/migration/logger.ts`)

A `MigrationLogger` instance writes timestamped JSONL entries to `.cleo/logs/migration-{timestamp}.jsonl`.

Each log entry includes:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | ISO 8601 | When the event occurred |
| `level` | `debug` / `info` / `warn` / `error` | Severity |
| `phase` | string | Migration phase (init, backup, import, etc.) |
| `operation` | string | Specific operation within the phase |
| `message` | string | Human-readable description |
| `durationMs` | number | Milliseconds since migration start |
| `data` | object (optional) | Structured metadata (file sizes, checksums, counts) |

**Log rotation**: Retains the 10 most recent migration log files by default. Older files are deleted on logger creation.

---

## Migration State Machine

```
  init ──► backup ──► validate ──► import ──► verify ──► cleanup ──► complete
    │         │           │           │          │          │
    └─────────┴───────────┴───────────┴──────────┴──────────┘
                           │
                           ▼
                        failed
```

### Phase Descriptions

| Phase | What Happens | Failure Recovery |
|-------|-------------|------------------|
| **init** | Create state file, compute source checksums | Safe — no data modified yet |
| **backup** | Create backup of existing database (if any) | Safe — original data untouched |
| **validate** | Parse and validate all JSON source files | Safe — read-only operation |
| **import** | Write data into new database (temp file) | Restore from backup; original intact |
| **verify** | Check imported counts match source counts; verify source checksums unchanged | Restore from backup if mismatch |
| **cleanup** | Rename `.json.migrated` files, remove temp artifacts | Manual cleanup of temp files |
| **complete** | Mark migration done, state file auto-deleted after 5s | No action needed |
| **failed** | Terminal state with error details in state file | Inspect state, fix cause, re-run |

### Phase Transitions

Phase transitions are recorded via `updateMigrationPhase(cleoDir, phase)`, which persists the new phase atomically. Any error during a phase triggers `failMigration(cleoDir, errorMessage)`, which sets the phase to `failed` and appends the error.

---

## Operational Runbook

### Pre-Migration: Check Current State

```bash
# Check if a migration is needed
cleo upgrade --check

# Or use the pre-flight check directly
node dist/cli/index.js preflight
```

The pre-flight check (`src/core/migration/preflight.ts`) detects:
- Legacy JSON files with data but no SQLite database
- Stale JSON files alongside an existing SQLite database
- Empty project (no data found)

### Running a Schema Migration

```bash
# Dry-run first to see what would change
cleo migrate --dry-run

# Run the migration
cleo upgrade
```

Behind the scenes, `cleo upgrade` executes:

1. **Preflight** — `checkStorageMigration()` determines if migration is needed.
2. **Lock** — Acquires exclusive lock on the database path.
3. **State init** — `createMigrationState()` captures source checksums and task counts.
4. **Validate** — `validateSourceFiles()` ensures all JSON files parse correctly.
5. **Backup** — Creates backup of existing database via `atomicDatabaseMigration()`.
6. **Import** — Writes data to a temp database file.
7. **Verify** — Validates the temp database with `validateSqliteDatabase()` (integrity check + table existence).
8. **Swap** — Atomic rename: `tasks.db.new` becomes `tasks.db`.
9. **Cleanup** — Renames source JSON to `.migrated` suffix.
10. **Complete** — `completeMigration()` marks state as done.

### Running Schema Version Migrations

For in-place schema version upgrades (e.g., adding new fields to task records):

```bash
# Check migration status across all data files
node dist/cli/index.js migrate status

# Run migrations for a specific file type
node dist/cli/index.js migrate run todo

# Run all pending migrations
node dist/cli/index.js migrate run-all
```

Migrations are registered in `src/core/migration/index.ts` and applied sequentially. Each migration transforms data from one schema version to the next.

---

## Troubleshooting

### Inspecting Migration State

If a migration was interrupted, the state file persists at `.cleo/.migration-state.json`:

```bash
cat .cleo/.migration-state.json | jq .
```

Key fields to check:

| Field | What It Tells You |
|-------|-------------------|
| `phase` | Last completed phase before interruption |
| `progress.tasksImported` / `progress.totalTasks` | How far the import got |
| `errors` | Array of error messages |
| `sourceFiles.*.checksum` | SHA-256 of source files at migration start |
| `backupPath` | Where the pre-migration backup was stored |

### Checking if a Migration Can Resume

The system tracks whether a migration is resumable:

- **Resumable states**: `init`, `backup`, `validate`, `import`, `verify`, `cleanup`
- **Terminal states**: `complete`, `failed`

A migration in a terminal `failed` state must be diagnosed and re-initiated. Check the `errors` array in the state file for the root cause.

### Reading Migration Logs

Log files are stored in `.cleo/logs/` with filenames like `migration-2026-02-27T10-30-00-000Z.jsonl`.

```bash
# Find the most recent migration log
ls -t .cleo/logs/migration-*.jsonl | head -1

# View all errors from a log
cat .cleo/logs/migration-*.jsonl | jq 'select(.level == "error")'

# View a specific phase
cat .cleo/logs/migration-*.jsonl | jq 'select(.phase == "import")'

# Get summary statistics
cat .cleo/logs/migration-*.jsonl | jq -s '{
  total: length,
  errors: [.[] | select(.level == "error")] | length,
  warnings: [.[] | select(.level == "warn")] | length,
  duration_ms: (last.durationMs // 0)
}'
```

### Recovering from Interrupted Migrations

**Scenario: Process killed during import phase**

1. Check the state file to confirm the phase:
   ```bash
   cat .cleo/.migration-state.json | jq '.phase'
   ```

2. If a backup exists, restore it:
   ```bash
   # Check for backup
   ls .cleo/tasks.db.backup

   # The backup is a copy of the database from before the migration started.
   # If the original database is corrupted, copy the backup back:
   cp .cleo/tasks.db.backup .cleo/tasks.db
   ```

3. Remove the state file and re-run:
   ```bash
   rm .cleo/.migration-state.json
   cleo upgrade
   ```

**Scenario: Validation failed (corrupt JSON source)**

1. Check which file failed:
   ```bash
   cat .cleo/.migration-state.json | jq '.errors'
   ```

2. The error includes the file path, line number, and column where parsing failed. Fix the JSON manually or restore from a backup.

3. Re-run the migration:
   ```bash
   cleo upgrade
   ```

**Scenario: Checksum mismatch (source files changed during migration)**

The `verifySourceIntegrity()` function compares current file checksums against those captured at migration start. If files changed mid-migration:

1. Remove the state file.
2. Ensure no other process is modifying the source files.
3. Re-run the migration.

### Verifying Backup Integrity

The checksum module (`src/core/migration/checksum.ts`) provides verification:

- `computeChecksum(filePath)` — Returns SHA-256 hex digest.
- `verifyBackup(sourcePath, backupPath)` — Compares checksums and validates the backup as a readable SQLite database.
- `compareChecksums(file1, file2)` — Quick equality check.

---

## SQLite-Only Enforcement (ADR-006)

Per ADR-006, SQLite is the only supported storage engine for CLEO project data. The pre-flight check enforces this:

- If legacy JSON files contain data but no SQLite database exists, `migrationNeeded` is `true`.
- If a SQLite database exists alongside stale JSON files, `migrationNeeded` is `true` (cleanup needed).
- The only JSON files exempt from SQLite enforcement are `config.json` and `project-context.json`, which remain as configuration files.

The `currentEngine` field in pre-flight results is always `'sqlite'` or `'none'` — there is no JSON engine option.

---

## Atomic Database Migration Pattern

The `atomicDatabaseMigration()` function in `src/store/atomic.ts` implements the core swap pattern:

```
1. Write new database → tasks.db.new (temp file)
2. Validate temp database → PRAGMA integrity_check + table existence
3. Rename tasks.db → tasks.db.backup (preserves original)
4. Rename tasks.db.new → tasks.db (atomic on POSIX)
5. Delete backup only on success
```

If step 4 fails (rare — would require filesystem failure), the backup at `tasks.db.backup` contains the original data. The `restoreDatabaseFromBackup()` function handles this recovery path.

SQLite database validation (`validateSqliteDatabase()`) checks:
- The file can be opened as a SQLite database (read-only mode).
- `PRAGMA integrity_check` returns `ok`.
- A `tasks` table exists in the schema.

---

## Configuration

Migration behavior is influenced by the following settings in `.cleo/config.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `storage.engine` | `sqlite` | Storage engine (always `sqlite` per ADR-006) |

Migration logger configuration (set programmatically):

| Option | Default | Description |
|--------|---------|-------------|
| `maxLogFiles` | 10 | Number of migration log files retained |
| `minLevel` | `debug` | Minimum log level recorded |
| `consoleOutput` | `false` | Echo log entries to console |

Lock configuration (set programmatically):

| Option | Default | Description |
|--------|---------|-------------|
| `stale` | 10,000ms | Lock staleness threshold |
| `retries` | 3 | Lock acquisition retry count |

---

## Related Documentation

- [CLEO Vision: Deterministic Safety](../concepts/vision.md) — Pillar 4 definition
- [Data Integrity Specification](../specs/CLEO-DATA-INTEGRITY-SPEC.md) — Git checkpoint isolation and VACUUM INTO backups
- [Backup System: SQLite Migration Guide](../mintlify/guides/backup-sqlite-migration.md) — Backup tier architecture
- [Troubleshooting Guide](../mintlify/guides/troubleshooting.md) — General CLEO troubleshooting
- [Schema Authority](../specs/SCHEMA-AUTHORITY.md) — Schema version management
