# ADR-003: Migration Safety Architecture

## Status

Accepted

## Context

The CLEO SQLite migration system had critical vulnerabilities that could result in complete data loss during JSON→SQLite migrations. This ADR documents the safety architecture implemented to prevent data loss.

## Problem Statement

The original migration implementation had these issues:

1. **Destructive Pattern**: Deleted database before creating new one
2. **Singleton Contamination**: Cached database references could point to deleted files
3. **No Concurrency Protection**: Multiple agents could run migration simultaneously
4. **Weak Verification**: File size comparison insufficient for integrity
5. **Late Validation**: JSON parsed AFTER database deletion
6. **Non-Idempotent**: Running twice could cause issues

## Decision

Implement a comprehensive safety system with 10 components:

### 1. Atomic Rename Pattern (T4721)

**Decision**: Replace delete-then-create with atomic write-to-temp-then-rename.

**Implementation**:

- Write to `tasks.db.new` (temp file)
- Validate temp database
- Rename: `tasks.db` → `tasks.db.backup` → `tasks.db.new` → `tasks.db`
- Only delete backup after success

**Rationale**: Eliminates window where database is missing.

### 2. Singleton State Management (T4722)

**Decision**: Add resetDbState() function to clear cached references.

**Implementation**:

- resetDbState() clears _db, _nativeDb, _dbPath
- getDb() validates path matches requested cwd
- Auto-reset on path mismatch

**Rationale**: Prevents stale references to deleted databases.

### 3. File Locking (T4723)

**Decision**: Wrap migration in exclusive file lock.

**Implementation**:

- withLock() with 30s timeout, 5 retries
- Lock covers all critical sections

**Rationale**: Prevents race conditions between concurrent migrations.

### 4. Idempotency (T4724)

**Decision**: Compare row counts to detect already-migrated data.

**Implementation**:

- Count existing DB rows vs JSON rows
- Skip if counts match
- --force flag to override

**Rationale**: Prevents wasted work and confusion.

### 5. Pre-Migration JSON Validation (T4725)

**Decision**: Validate JSON BEFORE any destructive operations.

**Implementation**:

- Parse all JSON files first
- Fail fast on corruption
- Warn on empty data

**Rationale**: Prevents data loss from corrupted sources.

### 6. State Tracking (T4726)

**Decision**: Track migration progress in persistent state file.

**Implementation**:

- .migration-state.json with phase tracking
- Resume capability
- Error preservation

**Rationale**: Enables recovery from interruptions.

### 7. Comprehensive Logging (T4727)

**Decision**: Log all operations with structured JSONL format.

**Implementation**:

- Timestamp, duration, file sizes
- Per-operation logging
- Audit trail

**Rationale**: Essential for debugging production issues.

### 8. Checksum Verification (T4728)

**Decision**: Replace file-size check with SHA-256 checksums.

**Implementation**:

- SHA-256 of source and backup
- Verify backup opens as SQLite
- Store checksums for audit

**Rationale**: Detects corruption even with same file size.

### 9. User Confirmation (T4730)

**Decision**: Require explicit confirmation for destructive operations.

**Implementation**:

- --confirm flag or interactive prompt
- Show detailed migration summary
- Require typing "yes"

**Rationale**: Final safety net against accidents.

### 10. Integration Tests (T4729)

**Decision**: Comprehensive test suite covering all failure modes.

**Implementation**:

- Corrupted JSON handling
- Interruption and resume
- Concurrent access blocking
- Data preservation

**Rationale**: Validates safety mechanisms work together.

## Consequences

### Positive

- Zero data loss in all tested scenarios
- Resumable migrations
- Complete audit trail
- Protection against concurrent access
- Early failure detection

### Negative

- Increased complexity
- Slightly slower migration due to validation
- Additional disk space for temp files
- More code to maintain

## Related

- T4720: SQLite Migration Safety Epic
- T4719: Previous migration fix attempt
- T4454: Original SQLite implementation epic
