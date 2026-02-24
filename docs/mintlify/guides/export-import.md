# Cross-Project Task Export/Import

Export tasks from one cleo project and import them into another, preserving relationships and metadata.

## Quick Start

**Export a task:**
```bash
cleo export-tasks T001 --output task.json
```

**Import to another project:**
```bash
cd /path/to/target-project
cleo import-tasks ~/Downloads/task.json
```

## Export Tasks

### Basic Export

Export a single task:
```bash
cleo export-tasks T042 --output feature.json
```

### Subtree Export

Export a task and all its children (epic → tasks → subtasks):
```bash
cleo export-tasks T001 --subtree --output epic.json
```

This preserves the full hierarchy:
- Epic (T001)
  - Task (T002, T003)
    - Subtasks (T004, T005)

### Multiple Tasks

Export multiple unrelated tasks:
```bash
cleo export-tasks T042 T105 T200 --output selected.json
```

## Import Tasks

### Basic Import

Import tasks into the current project:
```bash
cleo import-tasks feature.json
```

### Preview Changes (Dry Run)

See what would be imported without making changes:
```bash
cleo import-tasks feature.json --dry-run
```

### Import with Parent

Import tasks as children of an existing task:
```bash
cleo import-tasks tasks.json --parent T050
```

All imported tasks become children of T050.

## How It Works

### ID Remapping

**Exported IDs are automatically remapped on import to avoid conflicts:**

| Source Project | Export Package | Target Project |
|----------------|----------------|----------------|
| T001 | T001 | T031 (remapped) |
| T002 | T002 | T032 (remapped) |
| T003 | T003 | T033 (remapped) |

**All relationships update automatically:**
- parentId references
- depends arrays
- Hierarchy preserved

### Dependency Handling

Dependencies are remapped to maintain relationships:

**Source:**
```json
{
  "id": "T002",
  "parentId": "T001",
  "depends": ["T001"]
}
```

**After import to target (IDs T031-T032):**
```json
{
  "id": "T032",
  "parentId": "T031",
  "depends": ["T031"]
}
```

### Topological Sorting

Tasks are imported in dependency order:
1. Parent tasks before children
2. Dependencies before dependents
3. Prevents "missing dependency" errors

## Conflict Resolution

### Duplicate Titles

If imported task title already exists:

```bash
# Interactive mode (default)
cleo import-tasks tasks.json

# Prompts:
# Task "Auth Epic" already exists. Choose:
# 1. Rename to "Auth Epic (imported)"
# 2. Skip this task
# 3. Force import anyway
# 4. Abort entire import
```

**Non-interactive options:**
```bash
# Rename all duplicates automatically
cleo import-tasks tasks.json --on-duplicate rename

# Skip all duplicates
cleo import-tasks tasks.json --on-duplicate skip

# Force import all (allows duplicates)
cleo import-tasks tasks.json --on-duplicate force
```

### Missing Dependencies

If task depends on T999 but T999 not in export or target:

```bash
# Interactive: Choose resolution
cleo import-tasks tasks.json

# Options:
# 1. Create placeholder task T999
# 2. Skip dependent task
# 3. Remove dependency reference
# 4. Abort import
```

**Non-interactive:**
```bash
# Create placeholders for missing deps
cleo import-tasks tasks.json --on-missing-dep placeholder

# Skip tasks with missing deps
cleo import-tasks tasks.json --on-missing-dep skip

# Remove dependency references
cleo import-tasks tasks.json --on-missing-dep remove
```

### Phase Mismatches

If exported task has `phase: "design"` but target has no "design" phase:

```bash
# Interactive: Choose resolution
# 1. Create phase in target
# 2. Map to existing phase
# 3. Remove phase from task
# 4. Skip task
```

**Non-interactive:**
```bash
# Create missing phases
cleo import-tasks tasks.json --on-phase-mismatch create

# Remove phase from mismatched tasks
cleo import-tasks tasks.json --on-phase-mismatch remove

# Skip tasks with phase mismatches
cleo import-tasks tasks.json --on-phase-mismatch skip
```

## Export Format

### File Structure

```json
{
  "_meta": {
    "format": "cleo-export",
    "version": "1.0.0",
    "exportedAt": "2026-01-03T12:00:00Z",
    "sourceProject": "my-project",
    "stats": {
      "total": 3,
      "byType": {"epic": 1, "task": 1, "subtask": 1},
      "byStatus": {"active": 1, "pending": 2}
    },
    "checksum": "a1b2c3d4e5f6g7h8"
  },
  "selection": {
    "mode": "subtree",
    "rootTasks": ["T001"]
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Auth Epic",
      "description": "Authentication system",
      "status": "active",
      "priority": "high",
      "type": "epic",
      "parentId": null,
      "depends": [],
      "labels": ["auth"],
      "phase": "core",
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ]
}
```

### Required Fields

Tasks must include:
- `id`, `title`, `status`, `priority`, `type`
- `parentId`, `depends` (can be null/empty)
- `createdAt` timestamp

### Optional Fields

Preserved if present:
- `description`, `notes`, `labels`
- `phase`, `size`, `blockedBy`
- `completedAt`, `updatedAt`

## Use Cases

### 1. Epic Templates

**Export a successful epic for reuse:**
```bash
# Export authentication epic
cleo export-tasks T001 --subtree --output templates/auth-epic.json

# Import into new project
cd ~/projects/new-app
cleo import-tasks ~/templates/auth-epic.json
```

### 2. Cross-Team Collaboration

**Share task packages between projects:**
```bash
# Team A exports feature work
cleo export-tasks T050 --subtree --output feature-x.json

# Team B imports and continues
cd ~/team-b-project
cleo import-tasks feature-x.json --parent T010
```

### 3. Project Migration

**Move tasks between projects:**
```bash
# Export all pending tasks
cleo list --status pending --format json | \
  jq -r '.tasks[].id' | \
  xargs cleo export-tasks --output migration.json

# Import to new project
cd ~/new-project
cleo import-tasks ~/migration.json
```

### 4. Backup & Restore

**Export for safekeeping:**
```bash
# Full project export
cleo list --format json | \
  jq -r '.tasks[].id' | \
  xargs cleo export-tasks --output backup-2026-01-03.json

# Selective restore
cleo import-tasks backup-2026-01-03.json --parent T999 --dry-run
```

## Best Practices

### ✅ DO

- **Use dry-run first** to preview changes
- **Export subtrees** to preserve relationships
- **Version your exports** (use dates in filenames)
- **Review conflicts** before auto-resolving
- **Keep exports small** (focus on related tasks)

### ❌ DON'T

- Don't edit export JSON manually (use cleo commands)
- Don't import without checking for conflicts
- Don't bypass interactive prompts on first import
- Don't export/import tasks with sensitive data in titles

## Validation

### Schema Validation

Exports are validated against JSON Schema:
```bash
# Manual validation
jq . export.json >/dev/null && echo "Valid JSON" || echo "Invalid JSON"
```

### Checksum Verification

Imports verify package integrity:
```bash
# Checksum prevents tampering/corruption
# Automatically verified on import
```

## Troubleshooting

### "Task T001 already exists"

**Cause:** Target project has conflicting ID
**Solution:** IDs are auto-remapped during import (this is normal)

### "Circular dependency detected"

**Cause:** Export contains A→B→A dependency loop
**Solution:** Fix dependencies in source before exporting

### "Phase 'design' not found"

**Cause:** Target project missing phase
**Solution:** Use `--on-phase-mismatch create` or add phase to target first

### "Parent T999 not found"

**Cause:** Specified --parent doesn't exist in target
**Solution:** Verify parent ID with `cleo list`

## Advanced

### Filtering Exports

```bash
# Export only pending tasks (requires custom script)
cleo list --status pending --format json | \
  jq -r '.tasks[].id' | \
  xargs cleo export-tasks --output pending.json
```

### Batch Import

```bash
# Import multiple packages
for file in exports/*.json; do
  cleo import-tasks "$file" --on-duplicate skip
done
```

### Transform on Import

```bash
# Change all imported tasks to pending
cleo import-tasks tasks.json
# Then update:
cleo list --format json | \
  jq -r '.tasks[-3:][].id' | \
  xargs -I{} cleo update {} --status pending
```

## Related Commands

- `cleo list` - Find tasks to export
- `cleo show <id>` - Inspect task before export
- `cleo tree` - Visualize hierarchy for subtree exports
- `cleo deps <id>` - Check dependencies before import

## See Also

- [Task Hierarchy](hierarchy.md) - Understanding epic/task/subtask structure
- [Dependencies](dependencies.md) - Managing task dependencies
- [Phases](phases.md) - Phase system and workflow stages
