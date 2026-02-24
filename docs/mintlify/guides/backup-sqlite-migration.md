# Backup System: SQLite Migration Guide

**Task**: T4649
**Epic**: T4638
**Date**: 2026-02-16

---

## Current Architecture (JSON Mode)

The backup system uses two tiers:

### Tier 1: Operational Backups (`src/store/backup.ts`)

- **Location**: `.cleo/backups/operational/`
- **Format**: Numbered files (`todo.json.1`, `todo.json.2`, etc.)
- **Trigger**: Automatic on every `saveJson()` call via `createBackup()`
- **Retention**: Last 5 backups per file (configurable)
- **Mechanism**: File copy + rotation

### Tier 2: CLI Backup Command (`src/cli/commands/backup.ts`)

- **Subcommands**: `backup create`, `backup list`
- **Scope**: All four data files:
  - `todo.json`
  - `config.json`
  - `todo-archive.json`
  - `todo-log.jsonll`

---

## SQLite Changes Required

### Storage Architecture

CLEO uses Node built-in `node:sqlite` (`DatabaseSync`) with WAL mode
enabled for file-backed, concurrent multi-process access (see ADR-006,
amended by ADR-010). The database file at `.cleo/tasks.db` (project store)
and `~/.cleo/cleo-nexus.db` (global registry) are standard SQLite files
with WAL journal. Unlike the prior `sql.js` WASM engine, there is no
in-memory export/save cycle -- all writes go directly to disk via SQLite's
native file-locking and WAL mechanisms.

Key behavioral difference from prior `sql.js` engine:
- No `saveToFile()` / `_nativeDb.export()` pattern -- writes are immediate
- WAL files (`.db-wal`, `.db-shm`) may exist alongside the database file
- Backup must account for WAL state to ensure consistency

### Tier 1: Operational Backup Changes

**No changes needed.** The existing `createBackup()` in `src/store/backup.ts`
operates on any file path. It uses `copyFile()` which works identically
for binary files:

```typescript
// This already works for both JSON and SQLite files:
await createBackup('.cleo/tasks.db', backupDir);
```

The `StoreProvider` write path should call `createBackup` before
`saveToFile()`. This is handled by the provider's write methods.

Backup files will be: `tasks.db.1`, `tasks.db.2`, etc.

### Tier 2: CLI Backup Command Changes

The backup command needs to support both modes:

```typescript
// Current (JSON mode)
const files = [getTodoPath(), getConfigPath(), getArchivePath(), getLogPath()];

// SQLite mode
const files = [getDbPath(), getConfigPath()];
// Note: archive and log are tables within tasks.db, not separate files
```

**Required changes to `src/cli/commands/backup.ts`**:

1. Import `getDbPath` and `dbExists` from `src/store/sqlite.js`
2. Check active storage mode (JSON vs SQLite)
3. Adjust file list based on mode:
   - JSON: `todo.json`, `config.json`, `todo-archive.json`, `todo-log.jsonll`
   - SQLite: `tasks.db`, `config.json`

### Backup File List (by mode)

| File | JSON Mode | SQLite Mode | Notes |
|------|-----------|-------------|-------|
| `todo.json` | Backed up | N/A | Tasks stored in `tasks.db` |
| `config.json` | Backed up | Backed up | Config stays as JSON |
| `todo-archive.json` | Backed up | N/A | Archived tasks in `tasks.db` |
| `todo-log.jsonll` | Backed up | N/A | Log entries in `tasks.db` |
| `tasks.db` | N/A | Backed up | Complete database |

### Restore Changes

The `restoreFromBackup()` function in `src/store/backup.ts` already copies
the backup file to the target path. For SQLite mode:

1. Close the current database connection (`closeDb()`)
2. Restore the file (`restoreFromBackup()`)
3. Re-initialize the database (`getDb()` with fresh singleton)

```typescript
// SQLite restore flow
closeDb();
await restoreFromBackup('tasks.db', backupDir, getDbPath());
// Next getDb() call will re-read from disk
```

### SQLite Backup Considerations with `node:sqlite`

With the `node:sqlite` engine (ADR-010), the database is file-backed with
WAL mode. For consistent backups:

1. **Checkpoint before backup**: Run `PRAGMA wal_checkpoint(TRUNCATE)` to
   flush WAL contents into the main database file before copying.
2. **Copy the `.db` file**: After checkpoint, a simple file copy of
   `tasks.db` produces a valid backup.
3. **WAL-aware backup** (alternative): Copy `.db`, `.db-wal`, and `.db-shm`
   together atomically if checkpoint is not desired.

```typescript
// Recommended backup flow with node:sqlite
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
// Now safe to copy tasks.db as a single file
```

### Dual-Mode Support

During the migration period where both JSON and SQLite may be active,
the backup command should detect and backup both:

```typescript
const files: string[] = [];
if (await fileExists(getTodoPath())) {
  files.push(getTodoPath(), getArchivePath(), getLogPath());
}
if (dbExists()) {
  files.push(getDbPath());
}
files.push(getConfigPath()); // Always present
```

---

## Migration Checklist

- [ ] Update `backup create` to detect storage mode
- [ ] Add `tasks.db` to backed-up file list for SQLite mode
- [ ] Add `backup list` support for `.db` files
- [ ] Add WAL checkpoint before backup (`PRAGMA wal_checkpoint(TRUNCATE)`)
- [ ] Add `closeDb()` call before restore operations
- [ ] Test backup/restore cycle with SQLite database (including WAL state)
- [ ] Update backup size display (binary vs JSON)
- [ ] Handle WAL companion files (`.db-wal`, `.db-shm`) during restore

> **Engine reference**: ADR-006 (canonical storage), ADR-010 (node:sqlite engine choice)
