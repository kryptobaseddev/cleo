# CLEO Migration System

**Version Management Architecture for Schema Evolution**

## Overview

The CLEO migration system manages schema version upgrades for all data files (todo.json, config.json, archive.json, log.json). It follows a **single source of truth** principle where schema versions are defined exclusively in schema files, and migrations are discovered dynamically at runtime.

## Architecture Principles

### 1. Single Source of Truth (Phase 1)

Schema versions are defined ONLY in `schemas/*.schema.json` files:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "schemaVersion": "2.6.0",
  ...
}
```

**File mapping:**
- `schemas/todo.schema.json` → todo.json version
- `schemas/config.schema.json` → config.json version
- `schemas/archive.schema.json` → archive.json version
- `schemas/log.schema.json` → log.json version

**Reading versions:**
```bash
source lib/migrate.sh

# Get current schema version for a file type
version=$(get_schema_version_from_file "todo")  # Returns "2.6.0"
```

### 2. Template Placeholders (Phase 2)

Templates use dynamic placeholders that get replaced during project initialization:

```json
{
  "version": "{{SCHEMA_VERSION_TODO}}",
  "_meta": {
    "schemaVersion": "{{SCHEMA_VERSION_TODO}}"
  }
}
```

**Placeholder format:** `{{SCHEMA_VERSION_<TYPE>}}`
- `{{SCHEMA_VERSION_TODO}}`
- `{{SCHEMA_VERSION_CONFIG}}`
- `{{SCHEMA_VERSION_ARCHIVE}}`
- `{{SCHEMA_VERSION_LOG}}`

### 3. Version Field Standardization (Phase 3)

All files use `._meta.schemaVersion` as the canonical version field:

```json
{
  "version": "2.6.0",          // Top-level (backward compatibility)
  "_meta": {
    "schemaVersion": "2.6.0",  // Canonical location (source of truth)
    "configVersion": "2.4.0"
  }
}
```

**Field precedence:**
1. `._meta.schemaVersion` (canonical)
2. `.version` (legacy fallback)

### 4. Dynamic Migration Discovery

Migration functions are discovered at runtime via Bash function introspection:

```bash
# Discover all migration versions for a file type
discover_migration_versions "todo"
# Returns: 2.2.0 2.3.0 2.4.0 2.5.0 2.6.0

# Discover all migration versions across all types
discover_migration_versions
# Returns: 2.1.0 2.2.0 2.3.0 2.4.0 2.5.0 2.6.0
```

**Function naming conventions:**

The migration system supports **two naming patterns** that can coexist:

1. **Semver Pattern (Legacy):**
   - Format: `migrate_<type>_to_<major>_<minor>_<patch>`
   - Examples:
     - `migrate_todo_to_2_6_0`
     - `migrate_config_to_2_4_0`
   - **Use for:** Schema version changes that align with semver releases
   - **Sort order:** Sorted by version number (2.2.0 < 2.3.0 < 2.6.0)

2. **Timestamp Pattern (Recommended for new migrations):**
   - Format: `migrate_<type>_<YYYYMMDDHHMMSS>_<description>`
   - Examples:
     - `migrate_todo_20260103120000_add_verification_gates`
     - `migrate_config_20260104153000_update_defaults`
   - **Use for:**
     - Data-only migrations (no schema version change)
     - Hotfixes that don't warrant version bump
     - Migrations between minor releases
     - Migrations that need clear chronological ordering
   - **Sort order:** Sorted by timestamp (chronological)
   - **Description:** Snake_case identifier describing the change

**Migration Discovery Order:**

When both patterns exist for a file type, migrations are discovered and executed in this order:
1. All semver migrations (sorted by version)
2. All timestamp migrations (sorted by timestamp)

This ensures smooth transition from semver to timestamp pattern while maintaining backward compatibility.

**When to Use Which Pattern:**

| Scenario | Pattern | Example |
|----------|---------|---------|
| Schema version bump (new field added to schema) | Semver | `migrate_todo_to_2_7_0` |
| Data cleanup (no schema change) | Timestamp | `migrate_todo_20260105120000_clean_orphans` |
| Hotfix (urgent data correction) | Timestamp | `migrate_todo_20260105143000_fix_checksum` |
| Between-release migration | Timestamp | `migrate_config_20260106080000_update_paths` |
| Major schema change | Semver | `migrate_todo_to_3_0_0` |

## Migration Functions

### Core API

#### get_schema_version_from_file()

Read schema version from schema file (single source of truth).

```bash
version=$(get_schema_version_from_file "todo")
# Returns: "2.6.0"
```

**Args:**
- `$1` = file type (todo|config|archive|log)

**Returns:**
- Version string (e.g., "2.6.0")
- Exit code 1 if schema file missing or has no schemaVersion

#### discover_migration_versions()

Dynamically discover available migration functions.

```bash
# All migrations for specific type
versions=$(discover_migration_versions "todo")
# Returns: "2.2.0 2.3.0 2.4.0 2.5.0 2.6.0"

# All migrations across all types
versions=$(discover_migration_versions)
# Returns: "2.1.0 2.2.0 2.3.0 2.4.0 2.5.0 2.6.0"
```

**Args:**
- `$1` = file_type (optional) - filter for specific type

**Returns:**
- Sorted unique version strings (space-separated)

#### compare_schema_versions()

Compare data version against schema version and determine difference type.

```bash
comparison=$(compare_schema_versions "2.4.0" "2.6.0")
# Returns: "minor_diff"
```

**Args:**
- `$1` = data version (from file)
- `$2` = schema version (expected)

**Returns:**
- `equal` - No migration needed
- `patch_only` - Version bump only, no data transformation
- `minor_diff` - Migration needed (MINOR change)
- `major_diff` - Major upgrade required
- `data_newer` - Data is newer than schema (cannot migrate, upgrade cleo)

#### ensure_compatible_version()

Automatically migrate file if needed based on version comparison.

```bash
ensure_compatible_version "$file" "todo"
```

**Args:**
- `$1` = file path
- `$2` = file type

**Returns:**
- Exit code 0 on success
- Exit code 1 on failure

### Version Detection

#### detect_file_version()

Detect current schema version from a file.

```bash
version=$(detect_file_version ".cleo/todo.json")
# Returns: "2.6.0"
```

**Priority:**
1. `._meta.schemaVersion` (canonical)
2. `.version` (legacy fallback)
3. `$schema` field inference
4. Legacy structure detection (pre-v2.2.0)

### Migration Helpers

#### bump_version_only()

For PATCH-only differences - update version field without data transformation.

```bash
bump_version_only "$file" "2.6.0"
```

#### migrate_file()

Execute full migration path with backups and validation.

```bash
migrate_file "$file" "todo" "2.4.0" "2.6.0"
```

## Migration Types

### Semver-Based Migration

#### PATCH Changes (x.y.Z)

- **No data transformation needed**
- Version bump only
- Examples: Documentation updates, comment changes

```bash
# Detected automatically by compare_schema_versions()
# Executes: bump_version_only()
```

#### MINOR Changes (x.Y.0)

- **Data transformation required**
- Backward compatible
- Examples: New optional fields, structural additions

```bash
# Requires migration function
migrate_todo_to_2_6_0() {
    local file="$1"
    # ... add position field to tasks ...
    update_version_field "$file" "2.6.0"
}
```

#### MAJOR Changes (X.0.0)

- **Breaking changes**
- May require manual intervention
- Can be migrated with `--force` flag

### Migration Patterns

#### Adding New Fields

```bash
migrate_config_to_2_2_0() {
    local file="$1"

    # Add hierarchy section with defaults
    add_field_if_missing "$file" ".hierarchy" '{
        "maxSiblings": 20,
        "maxDepth": 3,
        "countDoneInLimit": false
    }' || return 1

    update_version_field "$file" "2.2.0"
}
```

#### Structural Transformations

```bash
migrate_todo_to_2_2_0() {
    local file="$1"

    # Convert project from string to object
    local updated_content
    updated_content=$(jq '
        if (.project | type) == "string" then
            .project = {
                "name": .project,
                "currentPhase": null,
                "phases": {}
            }
        else . end
    ' "$file")

    save_json "$file" "$updated_content"
    update_version_field "$file" "2.2.0"
}
```

## Commands

### Check Migration Status

```bash
cleo migrate status          # Show pending migrations
cleo migrate status --json   # JSON output
```

**Output:**
```
Schema Version Status
====================

✓ todo: v2.6.0 (current)
⚠ config: v2.1.0 → v2.4.0 (migration needed)
✓ archive: v2.4.0 (current)
✓ log: v2.4.0 (current)
```

### Run Migrations

```bash
cleo upgrade                 # Run all pending migrations
cleo migrate run             # Alternative command
cleo upgrade --force         # Force re-migration
```

### Version Checking

```bash
# Check compatibility (exit codes: 0=current, 1=patch, 2=minor, 3=major, 4=newer)
check_compatibility ".cleo/todo.json" "todo"
echo $?  # 0 = no migration needed
```

## File Structure

```
cleo/
├── lib/
│   └── migrate.sh           # Core migration functions
├── schemas/
│   ├── todo.schema.json     # Todo schema with schemaVersion
│   ├── config.schema.json   # Config schema with schemaVersion
│   ├── archive.schema.json  # Archive schema with schemaVersion
│   └── log.schema.json      # Log schema with schemaVersion
└── templates/
    ├── todo.template.json   # Template with {{SCHEMA_VERSION_TODO}}
    ├── config.template.json # Template with {{SCHEMA_VERSION_CONFIG}}
    └── ...
```

## Migration Safety

### Backup Strategy

1. **Pre-migration backup** - Created automatically before any migration
2. **Atomic writes** - All-or-nothing updates prevent corruption
3. **Validation** - Migrated files validated against schema before saving
4. **Rollback** - Can restore from backup if migration fails

### Migration Journal (Phase 4 - In Progress)

Future enhancement: `.cleo/migrations.json` will track applied migrations:

```json
{
  "applied": [
    {
      "version": "2.6.0",
      "type": "todo",
      "appliedAt": "2026-01-03T12:00:00Z",
      "status": "success"
    }
  ]
}
```

## Anti-Patterns (Prohibited)

### ❌ DO NOT: Hardcode version constants

```bash
# WRONG - No hardcoded version constants
SCHEMA_VERSION_TODO="2.6.0"

# WRONG - No fallback defaults
VERSION="${VERSION:-2.4.0}"
```

### ❌ DO NOT: Use version literals in code

```bash
# WRONG - No version literals in error messages
echo "Expected version 2.6.0"

# RIGHT - Read from schema file
expected=$(get_schema_version_from_file "todo")
echo "Expected version $expected"
```

### ❌ DO NOT: Bypass version detection

```bash
# WRONG - Direct .version field access
version=$(jq -r '.version' "$file")

# RIGHT - Use detection function with fallback handling
version=$(detect_file_version "$file")
```

### ❌ DO NOT: Static migration arrays

```bash
# WRONG - Static array of known versions
known_versions=("2.2.0" "2.3.0" "2.4.0")

# RIGHT - Dynamic discovery
mapfile -t known_versions < <(discover_migration_versions)
```

## Best Practices

### ✅ DO: Read versions from schema files

```bash
todo_version=$(get_schema_version_from_file "todo")
config_version=$(get_schema_version_from_file "config")
```

### ✅ DO: Use dynamic migration discovery

```bash
# Discover available migrations for specific type
versions=$(discover_migration_versions "todo")

# Build migration path dynamically
migration_chain=$(find_migration_path "$from" "$to")
```

### ✅ DO: Follow naming conventions

```bash
# Semver pattern (current)
migrate_todo_to_2_6_0() { ... }
migrate_config_to_2_4_0() { ... }

# Timestamp pattern (future)
migrate_todo_20260103120000_add_verification() { ... }
```

### ✅ DO: Use idempotent operations

```bash
# Safe to run multiple times
add_field_if_missing "$file" ".hierarchy" '{"maxDepth": 3}'

# Version updates are idempotent
update_version_field "$file" "2.6.0"
```

## Troubleshooting

### Version Mismatch

**Problem:** File shows older version than schema
```bash
✗ todo: v2.4.0 (schema expects v2.6.0)
```

**Solution:**
```bash
cleo migrate status
cleo upgrade
```

### Data Newer Than Schema

**Problem:** File version is newer than installed schema
```bash
✗ todo: v2.8.0 (newer than schema v2.6.0 - upgrade cleo)
```

**Solution:**
```bash
# Upgrade cleo to latest version
cd ~/.cleo
git pull origin main
./install.sh
```

### Migration Failed

**Problem:** Migration completed but file is corrupt

**Solution:**
```bash
# Restore from automatic backup
ls .cleo/backups/migration/
cleo migrate rollback
```

## Version History

| Version | File Type | Changes |
|---------|-----------|---------|
| 2.6.0 | todo | Added position and positionVersion fields |
| 2.5.0 | todo | Added position field (deprecated in favor of 2.6.0) |
| 2.4.0 | todo, config, archive, log | Notes maxLength increased to 5000 |
| 2.3.0 | todo | Added hierarchy fields (type, parentId, size) |
| 2.2.0 | todo, config | Project string → object, hierarchy config |
| 2.1.0 | config | Session configuration section |

## See Also

- [docs/commands/migrate.md](commands/migrate.md) - Migration command reference
- [docs/commands/upgrade.md](commands/upgrade.md) - Upgrade command reference
- [CLAUDE.md](../CLAUDE.md) - Repository guidelines including version management section
