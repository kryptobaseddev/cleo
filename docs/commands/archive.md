# archive Command

**Alias**: `rm`

Archive completed and cancelled tasks from `todo.json` to `todo-archive.json` based on configurable retention rules and relationship policies.

## Synopsis

```bash
cleo archive [OPTIONS]
```

## Description

The `archive` command moves completed (`done`) and cancelled tasks from the active todo list to the archive file. It supports configurable retention policies to keep recent completions accessible while archiving older ones. For cancelled tasks, it uses the `cancelledAt` timestamp for retention calculations.

The archive system provides:

- **Retention Policies**: Age-based archiving with configurable days-until-archive
- **Label Filtering**: Archive only specific labels or exclude protected labels
- **Relationship Safety**: Prevent orphaning children or breaking dependencies
- **Cascade Archiving**: Archive complete task families together
- **Phase Triggering**: Archive all completed tasks from a finished project phase
- **Interactive Mode**: Review each task before archiving
- **Per-Label Policies**: Different retention rules for different label types
- **Enhanced Metadata**: Full audit trail with relationship state and restore information

## Options

### Core Options

| Option | Description | Default |
|--------|-------------|---------|
| `--dry-run` | Preview without making changes | `false` |
| `--force` | Bypass age-based retention (still respects `preserveRecentCount`) | `false` |
| `--all` | Archive ALL completed tasks (bypasses both retention and preserve) | `false` |
| `--count N` | Override `maxCompletedTasks` setting | config value |
| `-f, --format FMT` | Output format: `text` or `json` | auto-detect |
| `--human` | Force human-readable text output | |
| `--json` | Force JSON output | |
| `-q, --quiet` | Suppress non-essential output | `false` |
| `-h, --help` | Show help message | |

### Label Filtering Options

| Option | Description | Default |
|--------|-------------|---------|
| `--only-labels LABELS` | Archive ONLY tasks with these labels (comma-separated) | |
| `--exclude-labels LABELS` | Additional labels to exclude from archiving (comma-separated) | |

**Note**: `--only-labels` and `--exclude-labels` are mutually exclusive and cannot be used together.

### Relationship Safety Options

| Option | Description | Default |
|--------|-------------|---------|
| `--safe` | Enable relationship safety checks | config default |
| `--no-safe` | Disable relationship safety checks | |
| `--no-warnings` | Suppress relationship warnings | |

### Cascade Options

| Option | Description | Default |
|--------|-------------|---------|
| `--cascade` | Archive completed parents with all completed children together | `false` |
| `--cascade-from ID` | Archive specific task and all its completed descendants | |

### Phase Triggering

| Option | Description | Default |
|--------|-------------|---------|
| `--phase-complete PHASE` | Archive all completed tasks from specified phase | |

### Interactive Mode

| Option | Description | Default |
|--------|-------------|---------|
| `-i, --interactive` | Review each task before archiving | `false` |

## Archive Modes

| Mode | Age Check | Preserve Recent | Use Case |
|------|-----------|-----------------|----------|
| Default | Yes | Yes | Normal maintenance |
| `--force` | No | Yes | Clear old completions, keep recent |
| `--all` | No | No | Full cleanup (nuclear option) |

## Configuration

Configure archive behavior in `.cleo/config.json`:

```json
{
  "archive": {
    "enabled": true,
    "daysUntilArchive": 7,
    "maxCompletedTasks": 15,
    "preserveRecentCount": 3,
    "archiveOnSessionEnd": true,
    "autoArchiveOnComplete": false,
    "exemptLabels": ["pinned", "keep"],
    "labelPolicies": {
      "security": { "daysUntilArchive": 30 },
      "temp": { "daysUntilArchive": 1 },
      "important": { "neverArchive": true }
    },
    "relationshipSafety": {
      "preventOrphanChildren": true,
      "preventBrokenDependencies": true
    },
    "phaseTriggers": {
      "enabled": false,
      "phases": [],
      "archivePhaseOnly": true
    },
    "interactive": {
      "confirmBeforeArchive": false,
      "showWarnings": true
    }
  }
}
```

### Basic Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Enable/disable archive functionality | `true` |
| `daysUntilArchive` | Days after completion before eligible | `7` |
| `maxCompletedTasks` | Threshold for archive prompt | `15` |
| `preserveRecentCount` | Recent completions to always keep | `3` |
| `archiveOnSessionEnd` | Check archive eligibility at session end | `true` |
| `autoArchiveOnComplete` | Auto-run archive on each task completion | `false` |
| `exemptLabels` | Labels that prevent archiving (opt-in protection) | `["pinned", "keep"]` |

### Label Policies

Per-label retention rules allow different archiving behavior for different task types:

```json
{
  "archive": {
    "labelPolicies": {
      "security": { "daysUntilArchive": 30 },
      "temp": { "daysUntilArchive": 1 },
      "important": { "neverArchive": true }
    }
  }
}
```

| Policy Option | Description |
|---------------|-------------|
| `daysUntilArchive` | Override default retention period for tasks with this label |
| `neverArchive` | When `true`, tasks with this label are never archived |

### Relationship Safety Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `relationshipSafety.preventOrphanChildren` | Block archiving tasks with active children | `true` |
| `relationshipSafety.preventBrokenDependencies` | Block archiving tasks with active dependents | `true` |

### Phase Trigger Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `phaseTriggers.enabled` | Enable automatic phase-triggered archiving | `false` |
| `phaseTriggers.phases` | List of phases that trigger archiving when complete | `[]` |
| `phaseTriggers.archivePhaseOnly` | Only archive tasks from the completing phase | `true` |

### Interactive Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `interactive.confirmBeforeArchive` | Enable interactive mode by default | `false` |
| `interactive.showWarnings` | Display relationship warnings before archiving | `true` |

## Examples

### Preview Archiving

```bash
# See what would be archived without making changes
cleo archive --dry-run
```

Output:
```
[INFO] Config: daysUntilArchive=7, maxCompleted=15, preserve=3
[INFO] Found 8 completed tasks
[INFO] Tasks to archive: 5

DRY RUN - Would archive these tasks:
  - T001: Initial setup
  - T003: Configure database
  - T005: Add authentication
  - T008: Write documentation
  - T012: Code review fixes

No changes made.
```

### Standard Archive

```bash
# Archive based on config rules (age + preserve count)
cleo archive
```

### Force Archive

```bash
# Archive regardless of age, but keep 3 most recent
cleo archive --force
```

### Archive Everything

```bash
# Archive ALL completed tasks (use with caution)
cleo archive --all
```

### Label Filtering

```bash
# Archive only tasks with specific labels
cleo archive --only-labels "cleanup,temp"

# Exclude specific labels from archiving
cleo archive --exclude-labels "important,keep"
```

### Cascade Archiving

```bash
# Archive complete task families together
cleo archive --cascade

# Archive specific epic and all completed descendants
cleo archive --cascade-from T001
```

### Phase-Triggered Archiving

```bash
# Archive all completed tasks from the 'setup' phase
cleo archive --phase-complete setup
```

### Interactive Mode

```bash
# Review each task before archiving
cleo archive --interactive
```

Interactive mode prompts:
- `(y)es` - Archive this task
- `(n)o` - Skip this task
- `(a)ll` - Archive all remaining tasks
- `(q)uit` - Cancel the operation

### Safe Mode Control

```bash
# Enable relationship safety (prevents orphaning)
cleo archive --safe

# Disable safety checks when needed
cleo archive --no-safe
```

## Archive Metadata

Each archived task receives enhanced metadata in the `_archive` field:

```json
{
  "_archive": {
    "archivedAt": "2025-12-13T10:00:00Z",
    "reason": "auto",
    "archiveSource": "auto",
    "sessionId": "session_20251213_100000_abc123",
    "cycleTimeDays": 3,
    "triggerDetails": {
      "configRule": "daysUntilArchive=7",
      "phase": "setup",
      "labelPolicy": "temp"
    },
    "relationshipState": {
      "hadChildren": true,
      "childIds": ["T002", "T003"],
      "hadDependents": false,
      "dependentIds": [],
      "parentId": null
    },
    "restoreInfo": {
      "originalStatus": "done",
      "canRestore": true,
      "restoreBlockers": []
    }
  }
}
```

### Metadata Fields

| Field | Description |
|-------|-------------|
| `archivedAt` | ISO 8601 timestamp of when the task was archived |
| `reason` | Archive reason: `auto`, `force`, `manual`, `label-policy` |
| `archiveSource` | How the archive was triggered: `auto`, `force`, `all`, `phase-trigger`, `cascade-from`, `manual` |
| `sessionId` | Session ID during which the archive occurred |
| `cycleTimeDays` | Days between task creation and completion |
| `triggerDetails` | Additional context about what triggered the archive |
| `relationshipState` | Snapshot of task relationships at archive time |
| `restoreInfo` | Information to support task restoration |

## Output

### Successful Archive (Text)

```
[INFO] Mode: --force (bypassing retention, preserving 3 recent)
[INFO] Found 10 completed tasks
[INFO] Tasks to archive: 7
[INFO] Archive backup created: .cleo/backups/archive/...
[INFO] Archived 7 tasks

Archived tasks:
  - T001
  - T003
  - T005
  - T008
  - T010
  - T012
  - T015

[ARCHIVE] Summary Statistics:
  Total archived: 7
  By priority:
    High: 2
    Medium: 4
    Low: 1
  Top labels:
    backend: 3
    frontend: 2
  Average cycle time: 4 days
```

## JSON Output

When using `--json` or piping output (LLM-Agent-First), returns structured JSON:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "archive",
    "timestamp": "2025-12-20T10:00:00Z",
    "version": "0.31.0"
  },
  "success": true,
  "safeMode": true,
  "cascadeApplied": false,
  "cascadedFamilies": [],
  "cascadeFrom": null,
  "phaseTrigger": null,
  "interactive": null,
  "archived": {
    "count": 7,
    "taskIds": ["T001", "T003", "T005", "T008", "T010", "T012", "T015"]
  },
  "exempted": {
    "count": 2,
    "taskIds": ["T020", "T021"]
  },
  "blockedByRelationships": {
    "byChildren": ["T025"],
    "byDependents": ["T030"]
  },
  "filters": {
    "onlyLabels": null,
    "excludeLabels": ["important", "keep"]
  },
  "warnings": [
    "Task T002 will lose parent T001 (active child)",
    "Task T004 depends on archiving tasks: T003"
  ],
  "warningCount": 2,
  "remaining": {
    "total": 25,
    "pending": 18,
    "active": 1,
    "blocked": 3
  }
}
```

### JSON Fields

| Field | Description |
|-------|-------------|
| `safeMode` | Whether relationship safety was enabled |
| `cascadeApplied` | Whether cascade mode was used |
| `cascadedFamilies` | Array of family structures archived together |
| `cascadeFrom` | Details about `--cascade-from` operation |
| `phaseTrigger` | Details about `--phase-complete` operation |
| `interactive` | Interactive mode statistics (approved/skipped counts) |
| `archived` | Count and IDs of successfully archived tasks |
| `exempted` | Count and IDs of tasks protected by labels |
| `blockedByRelationships` | Tasks blocked due to safety checks |
| `filters` | Active label filters |
| `warnings` | Relationship warnings generated |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success (tasks archived or none eligible) |
| `1` | General error |
| `2` | Invalid input/arguments |
| `3` | File not found |
| `4` | Task not found |
| `6` | Validation error |
| `102` | No change (idempotent operation - tasks already archived) |

## Safety Features

- **File locking** prevents concurrent modifications
- **Atomic transactions** ensure all-or-nothing operations
- **Backup creation** before archiving
- **JSON validation** before writing
- **Relationship safety** prevents orphaning children and breaking dependencies
- **Idempotency** - re-archiving already-archived tasks is a no-op
- **Dependency cleanup** removes orphaned dependency references

## Related Commands

### Viewing Archived Tasks

```bash
# Include archived tasks in list output
cleo list --include-archive

# Show only archived tasks
cleo list --archive-only

# Search for task in archive
cleo show T001 --include-archive

# Search archived tasks
cleo find "query" --include-archive
```

### Restoring Archived Tasks

```bash
# Restore specific tasks from archive
cleo unarchive T001 T002

# Preview restoration
cleo unarchive --dry-run T001

# Restore with specific status
cleo unarchive --status active T001

# Preserve original status
cleo unarchive --preserve-status T001
```

### Archive Analytics

```bash
# Summary statistics
cleo archive-stats

# Breakdown by phase
cleo archive-stats --by-phase

# Breakdown by label
cleo archive-stats --by-label

# Cycle time analysis
cleo archive-stats --cycle-times

# Archiving trends over time
cleo archive-stats --trends

# Filter by date range
cleo archive-stats --since 2025-01-01 --until 2025-06-30
```

## See Also

- [unarchive](unarchive.md) - Restore archived tasks to active list
- [archive-stats](archive-stats.md) - Generate archive analytics and reports
- [complete](complete.md) - Mark tasks done
- [list](list.md) - View tasks (use `--include-archive` or `--archive-only`)
- [show](show.md) - View task details (use `--include-archive`)
- [find](find.md) - Search tasks (use `--include-archive`)
- [restore](restore.md) - Restore from backups
- [stats](stats.md) - View project statistics
