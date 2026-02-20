# migrate-storage Command

Migrate storage engine between JSON and SQLite.

## Synopsis

```bash
 cleo migrate-storage --to-sqlite [options]
 cleo migrate-storage --to-json [options]
```

## Options

### --to-sqlite

Migrate from JSON to SQLite storage.

### --to-json

Export SQLite data back to JSON files.

### --dry-run

Show what would be migrated without making changes.

### --verify

Verify migration integrity after completion.

### --force

Skip idempotency check and re-import (requires --confirm).

### --confirm

Confirm destructive operations (required without interactive terminal).

### --resume

Resume interrupted migration from last saved state.

## Safety Features

### Automatic

- JSON validation before any destructive operations
- SHA-256 checksum verification of backups
- Atomic rename operations (no delete-then-create)
- Exclusive file locking during migration
- Progress tracking with resumable state

### User-Controlled

- Dry-run mode to preview changes
- Confirmation prompt for destructive operations
- --force flag for intentional re-import

## Examples

### Preview Migration

```bash
 cleo migrate-storage --to-sqlite --dry-run
```

### Run Migration with Verification

```bash
 cleo migrate-storage --to-sqlite --verify
```

### Force Re-Import

```bash
 cleo migrate-storage --to-sqlite --force --confirm
```

### Resume Interrupted Migration

```bash
 cleo migrate-storage --to-sqlite --resume
```

## Exit Codes

- 0: Success
- 1: General error
- 2: Invalid input
- 3: File error
- 4: Lock timeout (another migration running)
- 5: Validation error (JSON corrupted)

## See Also

- [Migration Recovery Runbook](../runbooks/migration-recovery.md)
- [Migration Troubleshooting](../troubleshooting/migration-issues.md)
