# import-tasks Command

> Import tasks from export package with ID remapping and conflict resolution

## Usage

```bash
cleo import-tasks <export-file> [OPTIONS]
```

**Arguments:**
- `EXPORT_FILE` - Path to .cleo-export.json package file (required)

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--dry-run` | | Preview import without writing to todo.json | false |
| `--parent` | | Attach all imported tasks under existing parent | none |
| `--phase` | | Override phase for all imported tasks | none |
| `--add-label` | | Add label to all imported tasks | none |
| `--no-provenance` | | Skip adding provenance notes to imported tasks | false |
| `--reset-status` | | Reset all task statuses on import (pending\|active\|blocked) | none |
| `--on-conflict` | | How to handle duplicate titles (duplicate\|rename\|skip\|fail) | fail |
| `--on-missing-dep` | | How to handle missing dependencies (strip\|placeholder\|fail) | strip |
| `--force` | | Skip conflict detection (use with caution) | false |
| `--format` | `-f` | Output format (json\|text) | auto-detect |
| `--json` | | Force JSON output (for LLM agents) | |
| `--human` | | Force human-readable text output | |
| `--quiet` | `-q` | Suppress informational messages | false |
| `--help` | `-h` | Show help message | |

## Conflict Resolution Options

### --on-conflict MODE

Controls how duplicate task titles are handled:

| Mode | Behavior |
|------|----------|
| `duplicate` | Allow duplicate titles (not recommended) |
| `rename` | Append numeric suffix to duplicates (e.g., "Auth Epic (2)") |
| `skip` | Skip tasks with duplicate titles, import rest |
| `fail` | Abort import on first duplicate (safest, default) |

### --on-missing-dep MODE

Controls how missing dependencies are handled:

| Mode | Behavior |
|------|----------|
| `strip` | Remove dependency references not in export (default) |
| `placeholder` | Create stub tasks for missing dependencies |
| `fail` | Abort import if dependencies missing |

## Import Process

### 1. ID Remapping

Exported task IDs are automatically remapped to avoid conflicts with existing tasks:

**Example:**
```
Source Project: T001, T002, T003
Target Project: (existing tasks T001-T030)
After Import:   T031, T032, T033
```

All relationships (parentId, depends) are updated automatically.

### 2. Topological Sorting

Tasks are imported in dependency order:
- Parent tasks before children
- Dependencies before dependents
- Prevents validation errors during import

### 3. Conflict Detection

Detects four types of conflicts:
- **Duplicate Title:** Same title exists in target project
- **Missing Dependency:** Referenced task not in export or target
- **Missing Parent:** parentId not in export or target
- **Phase Mismatch:** Phase doesn't exist in target

### 4. Transformations

Applies transformations in order:
1. ID remapping (IDs, parentId, depends)
2. Parent override (--parent)
3. Phase override (--phase)
4. Label addition (--add-label)
5. Status reset (--reset-status)
6. Provenance notes (unless --no-provenance)

### 5. Validation & Write

- Validates against JSON Schema
- Atomic write operation (temp → validate → backup → rename)
- Logs to audit trail

## Examples

### Basic Import

Preview first, then import:
```bash
cleo import-tasks auth-epic.cleo-export.json --dry-run
cleo import-tasks auth-epic.cleo-export.json
```

### Import with Parent Assignment

Attach imported tasks under existing parent:
```bash
cleo import-tasks feature.cleo-export.json --parent T015
```

All imported tasks become children of T015.

### Import with Phase Override and Label

Reset phase and add tracking label:
```bash
cleo import-tasks tasks.cleo-export.json --phase core --add-label imported-2026-01
```

### Import with Status Reset

Reset all tasks to pending:
```bash
cleo import-tasks tasks.cleo-export.json --reset-status pending
```

### Auto-Rename Duplicates

Automatically rename conflicting titles:
```bash
cleo import-tasks tasks.cleo-export.json --on-conflict rename
```

### Strip Missing Dependencies

Remove dependency references not in export:
```bash
cleo import-tasks tasks.cleo-export.json --on-missing-dep strip
```

### JSON Output for Scripting

Force JSON output for automation:
```bash
cleo import-tasks tasks.cleo-export.json --format json
```

## Dry-Run Preview

Shows what would be imported without making changes:

```bash
cleo import-tasks feature.json --dry-run
```

**Displays:**
- ID remap table (source → new ID mappings)
- Import order (topologically sorted)
- Task summaries with parent/dependency info
- Conflict warnings
- Summary statistics

## Provenance Tracking

By default, adds provenance notes to imported tasks:

```
[Imported from source-project as T001 on 2026-01-03]
```

Skip with `--no-provenance` flag.

## Exit Codes

| Code | Name | Meaning |
|------|------|---------|
| 0 | SUCCESS | Import completed successfully |
| 2 | INVALID_INPUT | Invalid arguments or options |
| 3 | FILE_ERROR | File operation failure |
| 4 | NOT_FOUND | Export file or parent task not found |
| 6 | VALIDATION_ERROR | Validation failed (JSON, schema, checksum) |
| 10 | PARENT_NOT_FOUND | --parent task doesn't exist in target |
| 103 | CONFLICT_DETECTED | Conflicts detected (use --on-conflict to resolve) |
| 104 | IMPORT_ABORTED | Import aborted by user or error |

## Validation

### Export Package Validation

Before import, validates:
1. File exists and is readable
2. Valid JSON format
3. Correct format identifier (`_meta.format: "cleo-export"`)
4. Schema compliance
5. Checksum integrity (prevents tampering/corruption)

### Parent Task Validation

If `--parent` specified:
- Validates ID format (T###)
- Checks parent exists in target
- Verifies parent type (subtask cannot have children)

### Phase Validation

If `--phase` specified:
- Validates phase format (lowercase alphanumeric with hyphens)
- Checks phase exists in target project
- Shows available phases if not found

### Label Validation

If `--add-label` specified:
- Validates label format: `^[a-z][a-z0-9.-]*$`
- Examples: `bug`, `feature`, `v0.5.0`, `imported-2026-01`

### Status Validation

If `--reset-status` specified:
- Must be one of: `pending`, `active`, `blocked`
- Cannot use `done` (tasks must be actively worked)

## Integration

### With Export Command

Typical workflow:
```bash
# Export from source project
cd ~/projects/source-project
cleo export-tasks T001 --subtree --output epic.json

# Import to target project
cd ~/projects/target-project
cleo import-tasks ~/projects/source-project/epic.json --dry-run
cleo import-tasks ~/projects/source-project/epic.json
```

### With List Command

Find tasks to verify import:
```bash
cleo list --label imported-2026-01
```

### With Deps Command

Verify dependencies after import:
```bash
cleo deps T031  # Check dependencies for imported task
```

## Related Commands

- `export-tasks` - Export tasks to .cleo-export.json package
- `list` - List tasks to verify import
- `show` - View imported task details
- `deps` - Check task dependencies
- `tree` - Visualize imported hierarchy

## See Also

- [Export/Import User Guide](../export-import.md) - Comprehensive guide with use cases
- [Export-Tasks Command](export-tasks.md) - Export command documentation
- [Schema Documentation](../../schemas/export-package.schema.json) - Package format specification
- [Import/Export Spec](../../claudedocs/IMPORT-EXPORT-SPEC.md) - Technical specification
