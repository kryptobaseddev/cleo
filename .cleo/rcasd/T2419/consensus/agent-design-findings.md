# Design Philosophy Agent Findings

**Agent**: Design Philosophy (Frontend Architect perspective)
**Date**: 2025-12-22
**Focus**: UX design, cognitive load, API design, DRY analysis, developer experience

---

## 1. Cognitive Load Assessment

### Cognitive Load Score: 7/10 (HIGH - problematic)

The current backup system imposes significant cognitive burden on developers and maintainers.

### 1.1 Taxonomy Complexity

**5 Backup Types** (snapshot/safety/incremental/archive/migration):

| Type | Trigger | Files | Retention | Clear Purpose? |
|------|---------|-------|-----------|----------------|
| snapshot | manual | all 4 files | count (10) | Yes - user-initiated |
| safety | auto pre-op | single file | count (5) + time (7d) | Overlaps with incremental |
| incremental | auto on change | single file | count (10) | Overlaps with safety |
| archive | auto pre-archive | 2 files | count (3) | Specialized, reasonable |
| migration | auto pre-migration | all 4 files | NEVER delete | Essential, clear purpose |

**Cognitive Issues:**
- **safety vs incremental confusion**: Both trigger automatically, both backup single files, both have count-based retention. The semantic distinction (pre-operation vs on-change) is not visible in the resulting backups.
- **Unclear when to use what**: A developer asking "how do I restore yesterday's state?" must understand 5 different systems.
- **Comparison to industry**: GFS uses 3 tiers (son/father/grandfather), Time Machine uses 3 tiers (hourly/daily/weekly). 5 types exceeds cognitive best practices.

### 1.2 Directory Structure Confusion

**Two backup locations coexist:**

```
.backups/                           # file-ops.sh numbered backups
  todo.json.1, todo.json.2, etc.

.claude/backups/                    # lib/backup.sh typed backups
  snapshot/
  safety/                           # 275+ directories (not rotated!)
  incremental/
  archive/
  migration/
```

**Evidence of confusion:**
- `.backups/` stores numbered copies (`todo.json.1`, `todo.json.2`)
- `.claude/backups/safety/` stores directories with metadata.json per backup
- Scripts reference both patterns inconsistently
- 275 safety backup directories exist despite retention policy of 5

### 1.3 Function Name Collisions

Both libraries define functions with similar names:

| Function | lib/file-ops.sh | lib/backup.sh | Semantic Conflict |
|----------|-----------------|---------------|-------------------|
| `backup_file()` | Numbered copy to .backups/ | N/A (scripts define their own) | HIGH |
| `list_backups()` | Lists .backups/*.N files | Lists typed backup directories | HIGH |
| `restore_backup()` | Restores from .backups/ | Restores from typed backup | HIGH |
| `create_safety_backup()` | N/A | Creates safety/* directory | LOW |

**Impact**: A developer sourcing both libraries will get unpredictable behavior depending on source order.

---

## 2. API Design Critique

### 2.1 Function Signature Inconsistency

**lib/backup.sh functions:**
```bash
create_snapshot_backup [custom_name]     # Optional name
create_safety_backup file operation      # Required file, optional operation
create_incremental_backup file           # Required file
create_archive_backup                    # No args
create_migration_backup version          # Optional version
```

**Issues:**
- No consistent pattern for arguments
- Some functions output path to stdout, others output to stderr
- Some return backup path, some return nothing

**lib/file-ops.sh functions:**
```bash
backup_file file                         # Outputs backup path to stdout
restore_backup file [backup_num]         # Outputs status to stderr
list_backups file                        # Outputs list to stdout
```

**Return code inconsistency:**
- `file-ops.sh` uses `FO_*` prefixed constants (FO_SUCCESS=0, FO_LOCK_FAILED=8)
- `lib/backup.sh` uses plain 0/1 returns
- Scripts define their own `backup_file()` with no return codes

### 2.2 Error Message Clarity

**Good patterns (lib/file-ops.sh):**
```bash
echo "Error: Failed to acquire lock on $safe_file (timeout after ${timeout}s)" >&2
echo "Another process may be accessing this file." >&2  # Actionable context
```

**Poor patterns (lib/backup.sh):**
```bash
echo "ERROR: Failed to backup $file" >&2  # No context on why
```

**Recommendation**: All error messages should include:
1. What failed
2. Why it failed (if known)
3. How to fix it

### 2.3 Default Behavior Sensibility

**Problematic defaults:**

| Default | Value | Issue |
|---------|-------|-------|
| `MAX_SAFETY_BACKUPS` | 5 | 275+ directories exist - rotation not working |
| `SAFETY_RETENTION_DAYS` | 7 | Not being enforced (oldest backup is Dec 13) |
| `BACKUP_DIR` | `.backups` (file-ops) vs `.claude/backups` (backup.sh) | Inconsistent |

---

## 3. DRY Principle Violations

### 3.1 Quantified Duplication

**Total lines in backup code: 1,633**
- lib/backup.sh: 987 lines
- lib/file-ops.sh: 647 lines

**Estimated duplication: ~350 lines (21%)**

### 3.2 Specific Violations

#### A. Configuration Loading (10 calls)
`_load_backup_config()` is called 10 times in lib/backup.sh:
- Lines 308, 421, 498, 569, 653, 735, 808, 857, 941

**Issue**: Each public function reloads config from disk. Should load once at source time or cache.

**Refactoring recommendation:**
```bash
# Load config once at source time, cache in global
_BACKUP_CONFIG_LOADED=false
_ensure_config_loaded() {
    if [[ "$_BACKUP_CONFIG_LOADED" != "true" ]]; then
        _load_backup_config
        _BACKUP_CONFIG_LOADED=true
    fi
}
```

#### B. Script-Local `backup_file()` Definitions

Three scripts define their own `backup_file()`:

1. **scripts/backup.sh:579** (17 lines)
   ```bash
   backup_file() {
     local source="$1"
     local name="$2"
     if validate_file "$source" "$name"; then
       cp "$source" "${BACKUP_PATH}/$(basename "$source")"
       # ... size tracking
     fi
   }
   ```

2. **scripts/restore.sh:266** (25 lines)
   ```bash
   create_safety_backup() {
     local safety_dir="${BACKUP_DIR}/pre-restore_$(date +"%Y%m%d_%H%M%S")"
     mkdir -p "$safety_dir"
     for file in "$TODO_FILE" "$ARCHIVE_FILE" "$CONFIG_FILE" "$LOG_FILE"; do
       cp "$file" "$safety_dir/$(basename "$file")"
     done
   }
   ```

3. **phase.sh** uses `backup_file` from file-ops.sh but calls it differently than intended

**Duplication: ~60 lines of backup logic in scripts that should use library**

#### C. File Copying Patterns

The pattern `cp "$source" "$dest"` with error handling appears:
- lib/backup.sh: 9 times
- lib/file-ops.sh: 4 times
- scripts/: 6 times

**Recommendation**: Single `safe_copy()` function with consistent error handling.

#### D. Metadata Generation

`_create_backup_metadata()` in lib/backup.sh (30 lines) is well-designed, but scripts/backup.sh duplicates this logic inline (lines 616-660).

---

## 4. Taxonomy Evaluation

### 4.1 Current 5-Type System Analysis

| Type | Justification | Recommendation |
|------|---------------|----------------|
| snapshot | Clear: user-initiated full backup | KEEP |
| safety | Unclear: overlaps with incremental | MERGE with incremental |
| incremental | Unclear: when is it triggered? | MERGE with safety |
| archive | Clear: pre-archive-operation backup | KEEP (rename to "pre-archive") |
| migration | Essential: schema migrations are critical | KEEP |

### 4.2 Industry Comparison

| System | Tiers | Philosophy |
|--------|-------|------------|
| GFS | 3 (son/father/grandfather) | Temporal hierarchy |
| Time Machine | 3 (hourly/daily/weekly) | Progressive thinning |
| Git reflog | 1 + expiration | Append-only, time-based prune |
| borg/restic | 1 + keep rules | Dedup + flexible retention |

**Conclusion**: 3-4 types is industry standard. 5 types is excessive.

### 4.3 Proposed Unified Taxonomy

**3-Tier System:**

| Type | Trigger | Contains | Retention |
|------|---------|----------|-----------|
| **operational** | Auto, pre-write | Single file | Last 10 + 7 days |
| **snapshot** | Manual or scheduled | All files | Last 5 |
| **permanent** | Pre-migration | All files | Never delete |

**Directory structure:**
```
.claude/backups/
  operational/
    20251222_163900_todo.json.bak
    20251222_163800_todo-archive.json.bak
  snapshot/
    snapshot_20251222_160000/
      todo.json
      todo-archive.json
      todo-config.json
      todo-log.json
      metadata.json
  permanent/
    migration_v2.1_to_v2.2_20251222/
      ...
```

**Key changes:**
- Merge safety + incremental into "operational" (flat files, not directories)
- Keep snapshot for user-initiated full backups
- Rename migration to "permanent" for clarity
- Remove archive type (use snapshot instead)

---

## 5. Developer Experience (DX) Vote

### MY VOTE: lib/file-ops.sh provides better DX foundation

**Reasoning:**

| Criteria | file-ops.sh | backup.sh | Winner |
|----------|-------------|-----------|--------|
| Cognitive simplicity | Simple numbered backups | 5-type taxonomy | file-ops |
| API consistency | FO_* return codes, clear signatures | Mixed returns, variable args | file-ops |
| Error handling | Actionable messages | Generic errors | file-ops |
| Locking | Explicit flock with timeout | None | file-ops |
| Atomic writes | Full implementation | Delegates to file-ops | file-ops |
| Metadata | None | Rich JSON metadata | backup.sh |
| Retention | Working rotation | Broken (275 dirs) | file-ops |

**However, backup.sh has superior features:**
- Metadata generation is excellent
- Type-based organization is conceptually sound (just too complex)
- Validation before restore is good practice

### Recommended Path Forward

**Merge the best of both:**
1. Use file-ops.sh as the foundation (atomic writes, locking, simple rotation)
2. Add metadata from backup.sh to operational backups
3. Simplify taxonomy to 3 types
4. Single backup location: `.claude/backups/`
5. Eliminate script-local backup definitions

---

## 6. Recommended Simplifications

### Priority 1: Fix Retention (URGENT)
275 safety backup directories despite 5 max config. The rotation is broken.

**Root cause**: `rotate_backups()` in backup.sh uses find with `-maxdepth 1` looking for directories, but BSD/GNU find differences may cause silent failures.

### Priority 2: Merge Libraries
Create single `lib/backup-unified.sh` that:
- Uses file-ops.sh atomic write pattern
- Implements 3-tier taxonomy
- Caches configuration
- Single `list_backups()`, `restore_backup()` API

### Priority 3: Eliminate Script Duplication
Scripts should import and use library, not define their own `backup_file()`:
- scripts/backup.sh: Use `create_snapshot_backup()`
- scripts/restore.sh: Use `create_safety_backup()` from library
- scripts/phase.sh: Use library consistently

### Priority 4: Standardize Return Codes
Adopt FO_* constants universally or define BACKUP_* constants in backup.sh.

### Priority 5: Improve Error Messages
Every error should include: what, why, how-to-fix.

---

## Summary

| Metric | Score | Details |
|--------|-------|---------|
| Cognitive Load | 7/10 (high) | 5 types, 2 locations, function collisions |
| DRY Compliance | 6/10 | ~350 lines duplication, config reloading |
| API Consistency | 5/10 | Mixed return codes, inconsistent signatures |
| Taxonomy | 6/10 | Over-engineered (5 vs industry 3) |
| Retention | 3/10 | 275 dirs despite 5 max (broken) |

**Overall DX Score: 5.4/10** - Significant improvement needed.

**Primary Recommendation**: Consolidate to 3-tier taxonomy with file-ops.sh as foundation, adding backup.sh's metadata capabilities.

---

*Document prepared for multi-agent consensus analysis. Design perspective favors simplification and consolidation.*
