# Phase 1: Industry Best Practices Evidence for Backup Systems

**Research Agent**: Claude Opus 4.5
**Date**: 2025-12-22
**Purpose**: Multi-agent consensus analysis - Evidence collection for claude-todo backup system redesign

---

## Executive Summary

This document presents comprehensive research on industry best practices for backup systems, specifically focused on patterns applicable to JSON file backup in a CLI task management tool. Evidence is drawn from mature systems including Git, SQLite, ZFS, Time Machine, borg backup, and restic.

---

## 1. Grandfather-Father-Son (GFS) Retention Strategy

### Definition
GFS is a hierarchical data retention strategy using three tiers of backup retention:
- **Son (Daily)**: Most recent/frequent backups, short retention (1-2 weeks)
- **Father (Weekly)**: Weekly backups, medium retention (1-3 months)
- **Grandfather (Monthly/Yearly)**: Long-term archival (1+ years)

### Key Principles

| Tier | Frequency | Retention | Purpose |
|------|-----------|-----------|---------|
| Son | Hourly/Daily | 7-14 days | Quick recovery from recent errors |
| Father | Weekly | 1-3 months | Point-in-time weekly recovery |
| Grandfather | Monthly | 1+ years | Long-term archival, compliance |

### Industry Implementation Patterns

**Time Machine (Apple)**:
- Hourly snapshots for 24 hours
- Daily snapshots for 1 month
- Weekly snapshots until disk full
- Oldest backups pruned automatically

**Veeam/Enterprise Solutions**:
- Full backup required at GFS frequency or higher
- Weekly promotes to monthly, monthly promotes to yearly
- Automatic cleanup of expired backups

### Applicability to claude-todo

For a CLI task management tool:
```
Recommended GFS Adaptation:
- Son: Last 10 operations (immediate undo)
- Father: Daily snapshots (7 days retention)
- Grandfather: Weekly snapshots (4 weeks retention)
```

**Evidence Source**: Nakivo, MSP360, Veeam, Apple Time Machine documentation

---

## 2. Atomic Write Patterns for Backup Safety

### The "fsync Dance" Pattern

The industry-standard pattern for durable atomic file writes on POSIX systems:

```
1. Create temporary file in same directory
2. Write all content to temporary file
3. fsync(temp_file)           // Flush file data to disk
4. fsync(directory)           // Ensure directory entry persists
5. rename(temp_file, target)  // Atomic rename
6. fsync(directory)           // Ensure rename persists
```

### Key Findings

**Why Atomic Rename Works**:
- `rename()` is atomic per POSIX specification
- No period where file is missing or partially written
- Either old content or new content, never corrupted state
- Both files must be on same filesystem/mount point

**Critical Requirements**:
1. **Directory fsync**: Required after creating new file to ensure it exists after crash
2. **File fsync before rename**: Ensures content is on disk before making visible
3. **Temp file in same directory**: Required for atomic rename to work

**What Can Go Wrong**:
- Without fsync, rename may result in 0-length file after power loss
- ext4 and other journaling filesystems do NOT guarantee data ordering
- Hardware write caches can lie about completion (enterprise SSDs have capacitors)

### SQLite Pattern
```c
// SQLite Online Backup API
sqlite3_backup_step(B, N)  // Copy N pages
sqlite3_backup_finish(B)   // Complete or abort
// Supports hot backup of active database
// Handles concurrent access with locking
```

### Applicability to claude-todo

```bash
# Current claude-todo pattern (already good!)
write_to_temp_file()
validate_json_schema()
create_backup_of_original()
mv temp_file target_file  # atomic rename
```

**Enhancement**: Add explicit fsync calls before rename for crash safety.

**Evidence Source**: LWN.net, Dan Luu "Files are hard", POSIX specification, SQLite documentation

---

## 3. Metadata Best Practices

### What to Store with Backups

| Field | Purpose | Example |
|-------|---------|---------|
| `timestamp` | When backup was created | ISO 8601 format |
| `trigger` | What caused the backup | "pre-update", "scheduled", "manual" |
| `checksum` | Integrity verification | SHA-256 hash |
| `source_version` | Schema/tool version | "0.24.0" |
| `file_size` | Quick corruption check | Bytes |
| `record_count` | Semantic validation | Number of tasks |
| `parent_backup` | Backup chain linkage | Previous backup ID |
| `operation` | What operation triggered | "task.create", "bulk.import" |

### Checksum Best Practices

**Industry Standard**: SHA-256 (balance of security and performance)

**Verification Strategy**:
1. Calculate checksum after backup creation
2. Store checksum separately from backup (or in backup manifest)
3. Verify checksum before restore
4. Periodic verification of archive integrity

**From Google SRE Book**:
> "Establish 'trust points' in your data - portions verified after being rendered immutable"

### Manifest File Pattern

```json
{
  "version": "1.0",
  "created": "2025-12-22T10:30:00Z",
  "backups": [
    {
      "id": "bkp_20251222_103000_abc123",
      "file": "todo_20251222_103000.json",
      "checksum": "sha256:abc123...",
      "size": 4523,
      "task_count": 47,
      "trigger": "pre-update",
      "operation": "task.complete:T042",
      "parent": "bkp_20251222_093000_def456"
    }
  ]
}
```

**Evidence Source**: AWS Well-Architected Framework, Google SRE Book, enterprise backup vendors

---

## 4. Concurrent Write Handling

### Multi-Writer Scenarios

Claude-todo faces multi-writer challenges:
- CLI tool (direct user operations)
- TodoWrite (Claude Code native tool)
- Potential parallel processes

### Locking Strategies

| Strategy | Pros | Cons |
|----------|------|------|
| **Exclusive Locks (flock)** | Simple, reliable | Blocks all concurrent access |
| **Advisory Locks** | Cooperative, flexible | Requires all writers to participate |
| **Optimistic Concurrency** | No blocking | Requires conflict detection/resolution |
| **Lock Files** | Cross-process, visible | Must handle stale locks |

### Git Reflog Pattern

Git maintains reference logs locally:
```
.git/logs/refs/heads/main  # Branch history
.git/logs/HEAD             # HEAD movement history
```

**Key Design Elements**:
- Append-only logging (no modification of history)
- Local only (not pushed to remotes)
- Automatic expiration (90 days default)
- Recovery mechanism for "lost" commits

### Recommended Pattern for claude-todo

```bash
# Lock file approach with stale detection
LOCKFILE=".claude/todo.lock"
LOCK_TIMEOUT=60  # seconds

acquire_lock() {
    if [ -f "$LOCKFILE" ]; then
        # Check if lock is stale (older than timeout)
        lock_age=$(( $(date +%s) - $(stat -c %Y "$LOCKFILE") ))
        if [ $lock_age -gt $LOCK_TIMEOUT ]; then
            rm -f "$LOCKFILE"  # Remove stale lock
        else
            return 1  # Lock held by another process
        fi
    fi
    echo "$$" > "$LOCKFILE"  # Write our PID
    return 0
}

release_lock() {
    rm -f "$LOCKFILE"
}
```

### Conflict Resolution

For optimistic concurrency (if locking fails):
1. Read current state and compute checksum
2. Perform modifications
3. Before write, verify checksum hasn't changed
4. If changed, merge or abort with clear error

**Evidence Source**: Git internals, Apache Hudi, SQL Server concurrency documentation

---

## 5. Selective Restore / Point-in-Time Recovery

### Point-in-Time Recovery (PITR) Principles

**Database PITR Pattern**:
1. Full backup as base
2. Transaction/operation log (WAL/binlog)
3. Replay logs to specific point
4. Restore represents exact state at that moment

### Selective Restore Patterns

**pg_restore Pattern**:
```bash
# List backup contents
pg_restore -l backup.tar > contents.txt

# Edit contents.txt to select items
# Restore only selected items
pg_restore -L contents.txt -d database backup.tar
```

**For claude-todo Application**:

```bash
# List available restore points
claude-todo restore --list
# Output:
# ID                      Timestamp            Operation          Tasks
# bkp_20251222_103000     2025-12-22 10:30    task.complete       47
# bkp_20251222_093000     2025-12-22 09:30    task.create         46
# bkp_20251222_080000     2025-12-22 08:00    bulk.import         45

# Restore specific backup
claude-todo restore bkp_20251222_093000

# Restore specific task from backup
claude-todo restore bkp_20251222_093000 --task T042
```

### Granularity Considerations

| Granularity | Use Case | Complexity |
|-------------|----------|------------|
| Full restore | Disaster recovery | Low |
| Task-level | Undo specific change | Medium |
| Field-level | Revert single field | High |

**Recommendation**: Support full restore with optional task-level selective restore.

**Evidence Source**: PostgreSQL, MySQL, SQL Server, Azure SQL documentation

---

## 6. Backup Verification Patterns

### Verification Hierarchy

1. **Checksum Verification**: Quick integrity check
2. **Schema Validation**: JSON schema compliance
3. **Semantic Validation**: Data consistency rules
4. **Restore Test**: Actual restore to temp location

### Automated Verification Schedule

| Check Type | Frequency | Cost |
|------------|-----------|------|
| Checksum | Every backup | Low |
| Schema | Every backup | Low |
| Semantic | Daily | Medium |
| Restore test | Weekly | High |

### Implementation Pattern

```bash
verify_backup() {
    local backup_file="$1"
    local manifest_checksum="$2"

    # 1. File exists
    [ -f "$backup_file" ] || return 1

    # 2. Checksum matches
    actual_checksum=$(sha256sum "$backup_file" | cut -d' ' -f1)
    [ "$actual_checksum" = "$manifest_checksum" ] || return 2

    # 3. Valid JSON
    jq empty "$backup_file" 2>/dev/null || return 3

    # 4. Schema validation
    validate_against_schema "$backup_file" || return 4

    # 5. Semantic checks
    task_count=$(jq '.tasks | length' "$backup_file")
    [ "$task_count" -gt 0 ] || return 5

    return 0
}
```

### Recovery Validation

After any restore:
1. Verify restored file checksum
2. Run full validation suite
3. Create audit log entry
4. Optionally backup pre-restore state

**Evidence Source**: AWS Well-Architected, Google SRE, NinjaOne, enterprise backup vendors

---

## 7. Directory Organization / Backup Taxonomy

### Industry Standard Structures

**Simple Chronological**:
```
backups/
  2025/
    12/
      22/
        todo_20251222_103000.json
        todo_20251222_093000.json
```

**Type-Based Organization**:
```
backups/
  automatic/          # Scheduled/triggered backups
  manual/             # User-requested backups
  pre-migration/      # Schema migration snapshots
  archive/            # Compressed older backups
```

**Git-Style (Recommended for claude-todo)**:
```
.claude/
  backups/
    current/          # Active backup rotation (GFS sons)
    weekly/           # Weekly snapshots (GFS fathers)
    monthly/          # Monthly archives (GFS grandfathers)
    manifest.json     # Backup index with metadata
    .backup.lock      # Lock file for concurrent access
```

### Naming Conventions

**Recommended Format**:
```
{prefix}_{timestamp}_{trigger}_{hash}.json

Examples:
todo_20251222T103000Z_auto_a1b2c3.json
todo_20251222T093000Z_preupdate_d4e5f6.json
todo_20251222T080000Z_manual_g7h8i9.json
```

**Key Elements**:
- ISO 8601 timestamp (sortable)
- Trigger type (auto, manual, preupdate, scheduled)
- Short hash for uniqueness
- Consistent extension

### Retention Automation

```bash
# Cleanup script pattern
cleanup_backups() {
    local backup_dir="$1"
    local max_sons=10
    local max_fathers=7
    local max_grandfathers=4

    # Keep only max_sons in current/
    ls -t "$backup_dir/current/" | tail -n +$((max_sons + 1)) | xargs rm -f

    # Similar for weekly/ and monthly/
}
```

**Evidence Source**: Research data management guides, file naming conventions literature

---

## 8. Reference System Analysis

### Git Reflog

**Strengths**:
- Append-only audit trail
- Automatic expiration (gc.reflogExpire = 90 days)
- Per-reference granularity
- Recovery mechanism for "lost" work

**Applicable Pattern**:
```
.claude/
  logs/
    todo.log          # Append-only operation log
    archive.log       # Archive operations
```

### ZFS Snapshots

**Strengths**:
- Instant creation (copy-on-write)
- Atomic consistency
- Space-efficient (stores only changes)
- Send/receive for migration

**Applicable Pattern**:
- Pre-operation snapshots (COW-like behavior)
- Atomic "all or nothing" backup creation

### borg backup / restic

**Strengths**:
- Deduplication at block level
- Encryption at rest
- Incremental-forever (no full backup cycles)
- Mounting backups as filesystem

**Applicable Pattern**:
- Content-addressable storage (hash-based)
- Deduplication across backups

### Time Machine

**Strengths**:
- Automatic, unobtrusive
- Familiar browse interface
- Space-efficient (hard links for unchanged files)
- Progressive retention thinning

**Applicable Pattern**:
- Automatic hourly/daily/weekly thinning
- User-friendly restore interface

---

## 9. Recommendations for claude-todo

### Priority 1: Atomic Operations (Already Implemented)
- temp file → validate → backup → atomic rename
- **Enhancement**: Add fsync calls for crash safety

### Priority 2: Structured Backup Directory
```
.claude/
  backups/
    current/          # Last 10 operation backups
    daily/            # Daily snapshots (7 days)
    weekly/           # Weekly snapshots (4 weeks)
    manifest.json     # Index with checksums
```

### Priority 3: Backup Metadata
- Timestamp, trigger, checksum, operation, task count
- Parent backup for chain tracking
- Schema version for migration support

### Priority 4: Verification
- SHA-256 checksum on creation
- Schema validation before restore
- Verification command: `claude-todo backup verify`

### Priority 5: Selective Restore
- List available restore points
- Restore full backup or specific task
- Pre-restore backup of current state

### Priority 6: Concurrent Access
- Lock file with stale detection
- Clear error messages on lock contention
- Graceful handling of TodoWrite conflicts

---

## 10. Evidence Quality Assessment

| Topic | Source Quality | Confidence |
|-------|---------------|------------|
| GFS Retention | High (enterprise vendors) | 95% |
| Atomic Writes | High (POSIX, kernel docs) | 98% |
| Metadata | High (SRE, AWS) | 90% |
| Concurrency | Medium (varies by pattern) | 85% |
| Selective Restore | High (database docs) | 92% |
| Verification | High (SRE, enterprise) | 93% |
| Directory Org | Medium (varied sources) | 80% |

---

## Sources

1. Nakivo - GFS Backup Retention Policy Explained
2. MSP360 - Grandfather-Father-Son Retention Policy
3. Apple - Time Machine Documentation
4. Git - Reflog Documentation and Internals
5. SQLite - Backup API Documentation
6. Oracle - ZFS Storage Best Practices
7. Google SRE Book - Data Integrity Chapter
8. AWS Well-Architected Framework - Backup Verification
9. LWN.net - Ensuring Data Reaches Disk
10. Dan Luu - Files Are Hard
11. POSIX Specification - fsync, rename
12. PostgreSQL - Point-in-Time Recovery Documentation
13. borg backup / restic - Design Documentation
14. Hostinger - Restic vs Borg Comparison
15. Research Data Management Guides (Stanford, Harvard, UMich)

---

*Document prepared for multi-agent consensus analysis. Evidence supports backup system redesign with emphasis on atomic operations, structured retention, and robust verification.*
