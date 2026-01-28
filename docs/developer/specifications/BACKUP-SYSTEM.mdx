# Backup System Specification

**Version**: 1.0.0
**Status**: ACTIVE
**Effective**: v0.25.0+
**Last Updated**: 2025-12-22

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals.

---

## Preamble

This specification defines the backup and recovery architecture for cleo. The design addresses the requirements of a task management system used by both human operators and LLM agents, with emphasis on data integrity, atomic operations, and reliable recovery.

**Authority**: This specification is AUTHORITATIVE for all backup-related behavior in cleo.

**Consensus Basis**: This specification is derived from a multi-agent consensus analysis involving 9 specialized agents. See CONSENSUS-REPORT.md for the full analysis.

---

## Executive Summary

The backup system implements a **two-tier architecture**:

1. **Tier 1 (Operational)**: Low-level atomic write safety integrated with file operations
2. **Tier 2 (Recovery)**: High-level backup management with taxonomy, metadata, and retention policies

This separation follows the principle of **defense in depth**: Tier 1 protects against individual operation failures, while Tier 2 enables point-in-time recovery and disaster recovery.

---

## Part 1: Core Architecture

### 1.1 Two-Tier Design

The backup system SHALL consist of two complementary tiers:

| Tier | Purpose | Trigger | Scope |
|------|---------|---------|-------|
| **Tier 1 (Operational)** | Atomic write rollback | Automatic on every write | Single file |
| **Tier 2 (Recovery)** | Point-in-time snapshots | Manual, scheduled, or pre-operation | Multi-file system state |

### 1.2 Tier 1: Operational Backup

The operational backup tier MUST:
- Create a backup before every atomic write operation
- Store backups in `.cleo/backups/operational/`
- Use simple numbered rotation (`{filename}.1`, `.2`, `.3`, etc.)
- Maintain the last N backups (configurable via `maxOperationalBackups`)
- Enable immediate rollback on write failure

The operational backup tier MUST NOT:
- Create metadata files
- Perform checksum calculations (time-critical path)
- Block on rotation failure (log and continue)

### 1.3 Tier 2: Recovery Backup

The recovery backup tier MUST:
- Support typed backups with distinct retention policies
- Store backups in `.cleo/backups/{type}/`
- Generate metadata with checksums and provenance
- Support multi-file snapshots (todo.json + config + log + archive)
- Enable point-in-time recovery

The recovery backup tier SHOULD:
- Verify checksums during restore
- Log all backup and restore operations
- Support search and listing of available backups

---

## Part 2: Backup Types

### 2.1 Type Taxonomy

The system MUST support the following backup types:

| Type | Retention Policy | Trigger | Can Delete |
|------|-----------------|---------|------------|
| `operational` | Last 10 + 7 days | Automatic (pre-write) | Yes |
| `snapshot` | Last 5 | Manual command | Yes |
| `safety` | Last 5 + 7 days | Pre-destructive operation | Yes |
| `archive` | Last 3 | Pre-archive operation | Yes |
| `migration` | Never | Pre-schema migration | No |

### 2.2 Type Definitions

#### 2.2.1 Operational

Operational backups MUST be created automatically before every write operation to a tracked file. These backups are lightweight and optimized for speed over metadata richness.

#### 2.2.2 Snapshot

Snapshot backups MUST be created on explicit user request via the `backup` command. These backups SHOULD include complete system state and full metadata.

#### 2.2.3 Safety

Safety backups MUST be created before potentially destructive operations, including:
- `validate --fix` (schema repair)
- `restore` (overwrite current state)
- `archive` (move tasks to archive)
- `complete` (task completion)

#### 2.2.4 Archive

Archive backups MUST be created before moving tasks to the archive file. These backups capture the pre-archive state to enable recovery of accidentally archived tasks.

#### 2.2.5 Migration

Migration backups MUST be created before any schema migration operation. Migration backups MUST NOT be automatically deleted. Manual deletion SHOULD require explicit confirmation.

---

## Part 3: Directory Structure

### 3.1 Canonical Paths

All backup-related paths MUST be relative to the project's `.cleo/` directory:

```
.cleo/
├── backups/
│   ├── operational/
│   │   └── {filename}.{1|2|3|...}
│   ├── snapshot/
│   │   └── snapshot_{timestamp}_{label}/
│   │       ├── metadata.json
│   │       ├── todo.json
│   │       ├── todo-archive.json
│   │       ├── config.json
│   │       └── todo-log.json
│   ├── safety/
│   │   └── safety_{timestamp}_{operation}/
│   │       └── (same structure as snapshot)
│   ├── archive/
│   │   └── archive_{timestamp}/
│   │       └── (same structure as snapshot)
│   └── migration/
│       └── migration_{timestamp}_{from}_{to}/
│           └── (same structure as snapshot)
└── (data files)
```

### 3.2 Naming Conventions

Backup directories MUST follow this naming pattern:

```
{type}_{timestamp}_{context}
```

Where:
- `{type}` is one of: `snapshot`, `safety`, `archive`, `migration`
- `{timestamp}` is ISO 8601 format: `YYYYMMDD-HHMMSS` or epoch seconds
- `{context}` is operation-specific: command name, migration version, user label

### 3.3 Path Constraints

Backup paths MUST NOT:
- Contain spaces (use underscores)
- Contain path traversal sequences (`..`)
- Exceed 255 characters per component
- Use characters invalid on any target filesystem (`<>:"/\|?*`)

---

## Part 4: Metadata

### 4.1 Metadata Requirements

Every Tier 2 backup MUST include a `metadata.json` file containing:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | MUST | Metadata schema version |
| `type` | string | MUST | Backup type from taxonomy |
| `timestamp` | string | MUST | ISO 8601 creation time |
| `trigger` | string | MUST | What triggered this backup |
| `operation` | string | SHOULD | Command that triggered backup |
| `files` | array | MUST | List of backed up files |
| `checksums` | object | MUST | SHA-256 per file |
| `totalSize` | integer | SHOULD | Total bytes across all files |
| `schemaVersion` | string | SHOULD | Data schema version |
| `parentBackup` | string | MAY | Path to preceding backup |
| `neverDelete` | boolean | MAY | Prevent automatic deletion |

### 4.2 Metadata Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["version", "type", "timestamp", "trigger", "files", "checksums"],
  "properties": {
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "type": { "enum": ["operational", "snapshot", "safety", "archive", "migration"] },
    "timestamp": { "type": "string", "format": "date-time" },
    "trigger": { "type": "string" },
    "operation": { "type": "string" },
    "files": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1
    },
    "checksums": {
      "type": "object",
      "additionalProperties": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
    },
    "totalSize": { "type": "integer", "minimum": 0 },
    "schemaVersion": { "type": "string" },
    "parentBackup": { "type": "string" },
    "neverDelete": { "type": "boolean" }
  }
}
```

---

## Part 5: Retention Policies

### 5.1 Rotation Algorithm

The rotation algorithm MUST:
1. Count existing backups of the specified type
2. If count > maximum, identify excess backups
3. Sort by creation time (ascending)
4. Delete oldest backups until count <= maximum
5. Skip backups with `neverDelete: true`
6. Log all deletion operations

The rotation algorithm MUST NOT:
- Delete backups silently on error
- Leave partial deletion state
- Delete migration backups regardless of count

### 5.2 Time-Based Retention

For types with time-based retention (operational, safety):
1. Backups older than `{type}RetentionDays` SHOULD be deleted
2. The `maxBackups` limit MUST be enforced regardless of age
3. Time-based deletion SHOULD run during rotation
4. A backup MUST NOT be deleted if it would leave fewer than `minBackups` remaining

### 5.3 Configuration Options

| Config Key | Type | Default | Description |
|------------|------|---------|-------------|
| `maxOperationalBackups` | integer | 10 | Max operational backups per file |
| `maxSnapshotBackups` | integer | 5 | Max snapshot backups |
| `maxSafetyBackups` | integer | 5 | Max safety backups |
| `maxArchiveBackups` | integer | 3 | Max archive backups |
| `safetyRetentionDays` | integer | 7 | Days to keep safety backups |
| `operationalRetentionDays` | integer | 7 | Days to keep operational backups |

---

## Part 6: Operations

### 6.1 Create Backup

Creating a backup MUST follow this sequence:

1. Validate backup type is recognized
2. Generate unique backup directory name
3. Create backup directory atomically
4. For each source file:
   a. Validate file exists and is readable
   b. Copy file to backup directory
   c. Calculate SHA-256 checksum
   d. Record in metadata
5. Write metadata.json
6. Execute rotation for this backup type
7. Log operation to audit trail

### 6.2 Restore Backup

Restoring a backup MUST follow this sequence:

1. Validate backup directory exists
2. Read and validate metadata.json
3. For each file in backup:
   a. Verify checksum matches metadata
   b. If mismatch, abort with error
4. Create safety backup of current state
5. For each file in backup:
   a. Atomic write to destination
6. Log operation to audit trail
7. Return summary of restored files

### 6.3 List Backups

Listing backups MUST:
- Enumerate all backup types
- Sort by creation time (newest first)
- Include metadata summary
- Support filtering by type, date range

### 6.4 Verify Backup

Verifying a backup MUST:
- Read metadata.json
- For each file in backup:
  a. Recalculate checksum
  b. Compare to stored checksum
- Report any mismatches
- Return verification status (passed/failed)

---

## Part 7: Error Handling

### 7.1 Exit Codes

| Code | Constant | Description | Recoverable |
|------|----------|-------------|-------------|
| 0 | `EXIT_SUCCESS` | Operation completed successfully | N/A |
| 1 | `EXIT_GENERAL_ERROR` | Unspecified error | Yes |
| 2 | `EXIT_INVALID_ARGS` | Invalid arguments | Yes |
| 10 | `EXIT_BACKUP_FAILED` | Backup creation failed | Yes |
| 11 | `EXIT_RESTORE_FAILED` | Restore operation failed | Partial |
| 12 | `EXIT_VERIFY_FAILED` | Checksum verification failed | Yes |
| 13 | `EXIT_ROTATION_FAILED` | Rotation failed | Yes |
| 14 | `EXIT_DISK_FULL` | Insufficient disk space | No |
| 15 | `EXIT_PERMISSION_DENIED` | Permission error | No |

### 7.2 Error Strings

| Code | Exit Code | Description |
|------|-----------|-------------|
| `E_BACKUP_DIR_CREATE` | 10 | Cannot create backup directory |
| `E_BACKUP_COPY` | 10 | Cannot copy file to backup |
| `E_BACKUP_METADATA` | 10 | Cannot write metadata.json |
| `E_RESTORE_CHECKSUM` | 12 | Checksum mismatch during restore |
| `E_RESTORE_MISSING` | 11 | Backup file missing |
| `E_ROTATION_DELETE` | 13 | Cannot delete old backup |
| `E_ROTATION_LIST` | 13 | Cannot enumerate backups |

### 7.3 Failure Modes

The backup system MUST NOT:
- Silently suppress errors (all errors MUST be logged)
- Leave partial backups without cleanup
- Corrupt existing backups on failure
- Delete backups without confirmation on disk full

The backup system SHOULD:
- Attempt cleanup of partial backups on failure
- Provide clear error messages with remediation steps
- Continue operation if rotation fails (log warning)

---

## Part 8: Concurrency

### 8.1 Locking Requirements

Backup operations MUST:
- Acquire file lock before reading source files
- Hold lock for minimum duration necessary
- Use POSIX advisory locks (`flock`)
- Support timeout with configurable maximum

### 8.2 Lock Semantics

| Operation | Lock Type | Scope | Timeout |
|-----------|-----------|-------|---------|
| Create backup | Shared (read) | Source files | 30s |
| Restore backup | Exclusive (write) | Destination files | 60s |
| Rotation | None | Backup directory | N/A |
| Verify | Shared (read) | Backup files | 30s |

### 8.3 Race Condition Handling

The system MUST handle concurrent access gracefully:
- Lock acquisition timeout SHOULD log warning and retry
- Permanent lock failure MUST return error with explanation
- Backup directory creation MUST be atomic (mkdir or fail)

---

## Part 9: LLM Agent Considerations

### 9.1 Path Discovery

LLM agents MUST NOT hardcode backup paths. Instead, agents SHOULD:
1. Query `cleo config get backup.directory`
2. Use returned path for all backup operations
3. Fall back to `.cleo/backups/` if config unavailable

### 9.2 Restoration Instructions

When an LLM agent needs to restore a backup:
1. Execute `cleo backup --list` to discover available backups
2. Select appropriate backup based on timestamp and type
3. Execute `cleo restore {backup-id}` with explicit confirmation
4. Verify restoration with `cleo validate`

### 9.3 Error Recovery

If backup operations fail, LLM agents SHOULD:
1. Check disk space (`df -h .cleo/`)
2. Verify permissions (`ls -la .cleo/backups/`)
3. Run `cleo validate --fix` if corruption suspected
4. Escalate to user if automated recovery fails

---

## Part 10: Configuration Schema

### 10.1 Backup Configuration

The following configuration options MUST be supported in `config.json`:

```json
{
  "backup": {
    "enabled": true,
    "directory": ".cleo/backups",
    "types": {
      "operational": {
        "enabled": true,
        "max": 10,
        "retentionDays": 7
      },
      "snapshot": {
        "enabled": true,
        "max": 5
      },
      "safety": {
        "enabled": true,
        "max": 5,
        "retentionDays": 7
      },
      "archive": {
        "enabled": true,
        "max": 3
      },
      "migration": {
        "enabled": true,
        "neverDelete": true
      }
    },
    "verification": {
      "onRestore": true,
      "onSchedule": false
    }
  }
}
```

### 10.2 Configuration Constraints

| Constraint | Requirement |
|------------|-------------|
| `backup.enabled` | MUST default to `true` |
| `backup.types.*.max` | MUST be ≥ 1 |
| `backup.types.*.retentionDays` | MUST be ≥ 1 if specified |
| `backup.types.migration.neverDelete` | MUST default to `true` |

---

## Part 11: Acceptance Criteria

### 11.1 Functional Requirements

The backup system MUST:
- Create operational backups on every atomic write
- Create typed backups via CLI commands
- Restore any backup to current state
- Verify backup integrity via checksum
- Rotate backups per retention policy
- List available backups with metadata

### 11.2 Non-Functional Requirements

The backup system SHOULD:
- Complete operational backup in < 50ms (typical file sizes)
- Complete snapshot backup in < 500ms (4 files, ~2MB total)
- Support 10,000+ tasks without performance degradation
- Function correctly on Linux, macOS, and WSL

### 11.3 Security Requirements

The backup system MUST:
- Sanitize all user-provided paths
- Reject path traversal attempts
- Use secure file permissions (0600 for data, 0700 for directories)
- Not expose backup contents in error messages

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) | Defers to for output format requirements |
| [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) | Related: ID format for backup references |
| [CONSENSUS-REPORT.md](../../.cleo/consensus/CONSENSUS-REPORT.md) | Source: Multi-agent analysis |
| [BACKUP-SYSTEM-IMPLEMENTATION-REPORT.md](BACKUP-SYSTEM-IMPLEMENTATION-REPORT.md) | Tracks implementation status |

---

## Appendix A: Decision Rationale

| Decision | Alternatives Considered | Why Chosen |
|----------|------------------------|------------|
| Two-tier architecture | Single unified system | Separation of concerns; Tier 1 for atomicity, Tier 2 for recovery features |
| Directory-based backups | Single archive file | Enables selective restore; easier debugging |
| SHA-256 checksums | MD5, CRC32 | Security standard; collision resistance |
| Numbered rotation | Timestamp only | Faster lookup; simpler implementation |
| Never-delete migrations | Configurable | Schema migrations are irreversible; data protection critical |

## Appendix B: Industry Precedents

| System | Pattern | Relevance |
|--------|---------|-----------|
| SQLite | WAL + Checkpoints | Tier 1/Tier 2 separation for durability |
| Git | Object store + Refs | Immutable snapshots with metadata |
| PostgreSQL | WAL + pg_dump | Continuous protection + periodic snapshots |
| Time Machine | Hourly/Daily/Weekly | Tiered retention policy |

## Appendix C: Rejected Alternatives

| Alternative | Why Rejected |
|-------------|--------------|
| Database backend (SQLite) | Adds dependency; exceeds current scale needs |
| Compression | CPU overhead; minimal space savings for small files |
| Incremental backups | Complexity vs benefit for current file sizes |
| Cloud sync | Scope creep; privacy concerns; offline operation required |

---

*End of Specification*
