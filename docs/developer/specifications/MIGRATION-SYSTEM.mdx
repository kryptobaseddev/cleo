# Migration System Specification

**Version:** 1.0.0
**Status:** Draft
**Created:** 2025-12-23
**Purpose:** Simplified, SOLID, DRY migration system for cleo schema evolution

---

## 1. Overview

### 1.1 Problem Statement

The current migration system has accumulated complexity:
- Multiple version sources (VERSION, lib/migrate.sh constants, template files, schema $id)
- Every schema change requires manual migration function creation
- No distinction between safe changes (relaxations) and breaking changes
- Conflation of schema migration with backup reorganization

### 1.2 Goals

1. **Single Source of Truth:** One authoritative location for schema version
2. **Automated Classification:** Determine migration requirements from version semantics
3. **Skip Safe Changes:** Constraint relaxations and optional additions require no data transformation
4. **Clear Separation:** Schema migration vs backup taxonomy vs validation vs repair

### 1.3 Non-Goals

- Automatic schema diffing (too complex, error-prone)
- Supporting downgrades (one-way migration only)
- Cross-major-version jumps in single step (must migrate through intermediate versions)

---

## 2. Version Management

### 2.1 Version Types

| Version Type | Location | Purpose | Example |
|--------------|----------|---------|---------|
| **App Version** | `VERSION` file | Release tracking, user-facing | `0.32.4` |
| **Schema Version** | `schemas/*.schema.json` | Data structure compatibility | `2.5.0` |
| **Data Version** | `.cleo/todo.json#.version` | Records schema data conforms to | `2.4.0` |
| **Spec Version** | Schema `$id` field | Specification document version | `v3.1` |

### 2.2 Single Source of Truth

**Schema version lives in the schema file itself:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo.dev/schemas/v3.1/todo.schema.json",
  "schemaVersion": "2.5.0",
  ...
}
```

**Reading schema version dynamically:**

```bash
get_schema_version() {
    local schema_file="${SCHEMA_DIR}/todo.schema.json"
    jq -r '.schemaVersion // .version // "unknown"' "$schema_file"
}
```

### 2.3 Semver Semantics for Schema

Schema versions follow strict semantic versioning with specific meanings:

| Segment | Meaning | Migration Required | Example Changes |
|---------|---------|-------------------|-----------------|
| **MAJOR** | Breaking structural changes | YES (complex) | Type changes, incompatible restructuring |
| **MINOR** | Additive changes requiring defaults | YES (simple) | Required field addition, field rename |
| **PATCH** | Backward-compatible relaxations | NO | maxLength increase, optional field addition |

**Key Principle:** PATCH-only differences NEVER require data transformation. The data file's version field is simply updated to match.

---

## 3. Change Type Classification

### 3.1 Decision Matrix

| Change Type | Version Bump | Migration Action | Validation Action |
|-------------|--------------|------------------|-------------------|
| Constraint relaxation (maxLength increase) | PATCH | Version bump only | None |
| Pattern loosening | PATCH | Version bump only | None |
| Enum value addition | PATCH | Version bump only | None |
| Optional field addition | PATCH | Version bump only | None |
| Default value change | PATCH | Version bump only | None |
| Constraint tightening (maxLength decrease) | MINOR | Check + truncate/warn | Verify compliance |
| Required field addition | MINOR | Add with defaults | Verify presence |
| Field rename | MINOR | Rename in data | Verify new name exists |
| Field removal | MINOR | Remove from data | None (cleanup) |
| Enum value removal | MINOR | Map to replacement | Verify no orphans |
| Structural change (e.g., string to object) | MAJOR | Transform structure | Verify new structure |
| Type change | MAJOR | Convert values | Verify new types |

### 3.2 Classification Rules

```
IF data.version == schema.schemaVersion:
    -> NO ACTION NEEDED

ELSE IF only_patch_differs(data.version, schema.schemaVersion):
    -> BUMP VERSION ONLY (no data transformation)

ELSE IF minor_differs(data.version, schema.schemaVersion):
    -> LOOK FOR MIGRATION FUNCTION
    -> IF function exists: EXECUTE IT
    -> IF no function: ERROR (developer must add migration)

ELSE IF major_differs(data.version, schema.schemaVersion):
    -> REQUIRE EXPLICIT MIGRATION FUNCTION
    -> NO AUTOMATIC HANDLING
```

### 3.3 Safe Change Examples (PATCH - No Migration)

```json
// Before: v2.4.0
"notes": { "items": { "maxLength": 500 } }

// After: v2.4.1 - PATCH increment
"notes": { "items": { "maxLength": 5000 } }
```

Existing data with notes under 500 chars remains valid. No transformation needed.

```json
// Before: v2.4.1
"task": { "properties": { /* no size field */ } }

// After: v2.4.2 - PATCH increment
"task": { "properties": { "size": { "type": ["string", "null"], "default": null } } }
```

Optional field with null default. Existing data without field is valid (null is implicit).

### 3.4 Migration Required Examples (MINOR/MAJOR)

```json
// Before: v2.4.0
"task": { "required": ["id", "title", "status"] }

// After: v2.5.0 - MINOR increment
"task": { "required": ["id", "title", "status", "type"] }
// Migration: Add "type": "task" to all tasks missing it
```

```json
// Before: v2.x.x
"project": { "type": "string" }

// After: v3.0.0 - MAJOR increment
"project": { "type": "object", "properties": { "name": {...}, "phases": {...} } }
// Migration: Convert project string to object structure
```

---

## 4. Migration Flow

### 4.1 Detection Algorithm

```
FUNCTION check_migration_needed(data_file, schema_file):
    data_version = read_version(data_file)
    schema_version = read_schema_version(schema_file)

    IF data_version == schema_version:
        RETURN "current"

    comparison = compare_versions(data_version, schema_version)

    IF comparison == "data_newer":
        RETURN "incompatible"  # Data from future schema version

    IF comparison == "patch_only":
        RETURN "patch_bump"  # Safe: just update version field

    IF comparison == "minor_diff" OR comparison == "major_diff":
        RETURN "migration_needed"
```

### 4.2 Execution Flow

```
FUNCTION execute_migration(data_file, file_type):
    1. DETECT current and target versions
    2. IF no migration needed: RETURN success

    3. CREATE backup (using unified backup library)

    4. DETERMINE migration type:
       - patch_only: call bump_version_only()
       - minor/major: call find_and_execute_migration()

    5. VALIDATE result against schema

    6. IF validation fails:
       RESTORE from backup
       RETURN error

    7. LOG migration to audit trail
    8. RETURN success
```

### 4.3 Migration Function Naming Convention

```bash
# Pattern: migrate_{file_type}_v{major}_{minor}_to_v{target_major}_{target_minor}
migrate_todo_v2_4_to_v2_5()
migrate_todo_v2_5_to_v3_0()
migrate_config_v2_2_to_v2_3()
```

**Note:** PATCH versions are not included in function names since PATCH changes don't require migration functions.

### 4.4 Migration Path Resolution

For multi-version jumps, migrations execute sequentially:

```
Data at v2.2.0, Schema at v2.5.0:
  1. migrate_todo_v2_2_to_v2_3()
  2. migrate_todo_v2_3_to_v2_4()
  3. migrate_todo_v2_4_to_v2_5()
```

Each step is atomic with its own backup point.

---

## 5. Component Responsibilities

### 5.1 Separation of Concerns

```
+------------------+     +------------------+     +------------------+
|  Schema Files    |     |   Data Files     |     |  Backup System   |
|  (source of      |     |  (migration      |     |  (recovery       |
|   truth)         |     |   targets)       |     |   support)       |
+--------+---------+     +--------+---------+     +--------+---------+
         |                        |                        |
         v                        v                        v
+--------+---------+     +--------+---------+     +--------+---------+
| lib/migrate.sh   |<--->|  Migration       |<--->| lib/backup.sh    |
| - Version detect |     |  Execution       |     | - Create backup  |
| - Path resolution|     |                  |     | - Restore        |
| - Migration funcs|     |                  |     | - Rotate         |
+------------------+     +------------------+     +------------------+
         |                        |
         v                        v
+--------+---------+     +--------+---------+
| lib/validation.sh|     | lib/logging.sh   |
| - Schema validate|     | - Audit trail    |
| - Post-migration |     | - Migration log  |
+------------------+     +------------------+
```

### 5.2 Module Responsibilities

| Module | Responsibility | Does NOT Handle |
|--------|---------------|-----------------|
| `lib/migrate.sh` | Version detection, migration functions, path resolution | Backup creation (delegates), validation (delegates) |
| `lib/validation.sh` | Schema validation, constraint checking | Data transformation, version management |
| `lib/backup.sh` | Backup creation, restoration, rotation | Migration logic, validation |
| `lib/file-ops.sh` | Atomic writes, file operations | Migration logic, version semantics |
| `scripts/migrate.sh` | CLI interface for migration commands | Core migration logic (delegates to lib) |
| `scripts/reorganize-backups.sh` | Legacy backup reorganization (SEPARATE concern) | Schema migration |

### 5.3 Backup Taxonomy Migration (Separate System)

The backup directory reorganization (`.cleo/.backups/` to `.cleo/backups/{type}/`) is a **completely separate concern** from schema migration:

- **Different trigger:** Legacy directory exists vs schema version mismatch
- **Different frequency:** One-time operation vs ongoing schema evolution
- **Different scope:** File system layout vs data structure

**Recommendation:** Rename `reorganize-backups.sh` to `reorganize-backups.sh` to avoid confusion.

---

## 6. Implementation Guidelines

### 6.1 Adding a PATCH Release (No Migration)

1. Update schema file with relaxed constraints or optional fields
2. Increment PATCH in `schemaVersion` field
3. **No migration function needed**
4. Existing data automatically compatible

### 6.2 Adding a MINOR Release (Simple Migration)

1. Update schema file with new required fields or renames
2. Increment MINOR in `schemaVersion` field (reset PATCH to 0)
3. Add migration function:

```bash
# In lib/migrate.sh
migrate_todo_v2_5_to_v2_6() {
    local file="$1"

    # Add new required field with default
    add_field_if_missing "$file" ".tasks[].newField" '"default_value"'

    # Update version
    update_version_field "$file" "2.6.0"
}
```

4. Register in migration path (if not auto-discovered)

### 6.3 Adding a MAJOR Release (Complex Migration)

1. Update schema file with structural changes
2. Increment MAJOR in `schemaVersion` (reset MINOR and PATCH to 0)
3. Add comprehensive migration function with:
   - Data structure transformation
   - Value conversion
   - Validation checks
4. Document breaking changes
5. Consider multi-step migration path

### 6.4 Migration Function Template

```bash
migrate_{type}_v{from_major}_{from_minor}_to_v{to_major}_{to_minor}() {
    local file="$1"

    echo "  Migrating to v${to_major}.${to_minor}.0..."

    # 1. Perform data transformations
    local updated_content
    updated_content=$(jq '
        # JQ transformation here
    ' "$file") || {
        echo "ERROR: Transformation failed" >&2
        return 1
    }

    # 2. Validate result
    if ! echo "$updated_content" | jq empty 2>/dev/null; then
        echo "ERROR: Invalid JSON produced" >&2
        return 1
    fi

    # 3. Atomic save
    save_json "$file" "$updated_content" || return 1

    # 4. Update version
    update_version_field "$file" "${to_major}.${to_minor}.0"

    return 0
}
```

---

## 7. CLI Interface

### 7.1 Commands

```bash
# Check migration status
cleo migrate status

# Check if migration needed (exit code 0 = current, 1 = needed)
cleo migrate check

# Execute migrations
cleo migrate run [--auto] [--no-backup]

# Migrate specific file
cleo migrate file <path> <type>

# Rollback from backup
cleo migrate rollback [--backup-id <id>]

# Repair structural issues (separate from migration)
cleo migrate repair [--dry-run] [--auto]
```

### 7.2 JSON Output

```json
{
  "$schema": "https://cleo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "command": "migrate",
    "subcommand": "status",
    "timestamp": "2025-12-23T10:30:00Z"
  },
  "success": true,
  "files": [
    {
      "type": "todo",
      "file": ".cleo/todo.json",
      "currentVersion": "2.4.0",
      "schemaVersion": "2.5.0",
      "status": "migration_needed",
      "migrationType": "minor"
    }
  ]
}
```

---

## 8. Error Handling

### 8.1 Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| `E_VERSION_MISMATCH` | Data version newer than schema | Cannot downgrade; manual intervention |
| `E_MIGRATION_MISSING` | No function for required migration | Developer must add migration |
| `E_MIGRATION_FAILED` | Migration function returned error | Auto-restore from backup |
| `E_VALIDATION_FAILED` | Post-migration validation failed | Auto-restore from backup |
| `E_BACKUP_FAILED` | Could not create pre-migration backup | Abort migration |

### 8.2 Recovery Flow

```
Migration fails at any step:
  1. Log detailed error
  2. Automatically restore from pre-migration backup
  3. Report failure with recovery details
  4. Exit with appropriate error code
```

---

## 9. Appendix

### A.1 Current Version Inventory (As-Is)

| Source | Current Value | Proposed Change |
|--------|---------------|-----------------|
| `VERSION` | 0.32.4 | Keep as app version (unchanged) |
| `lib/migrate.sh` SCHEMA_VERSION_TODO | 2.4.0 | Remove; read from schema file |
| `schemas/todo.schema.json` | No schemaVersion field | Add `"schemaVersion": "2.4.0"` |
| `templates/todo.template.json#.version` | 2.2.0 | Update to match schema; or read dynamically |

### A.2 Migration from Current System

1. Add `schemaVersion` field to all schema files
2. Remove hardcoded SCHEMA_VERSION_* constants from lib/migrate.sh
3. Update `get_expected_version()` to read from schema files
4. Update templates to reference schema version dynamically
5. Test with existing migration functions (should work unchanged)

### A.3 Example: v2.4.0 to v2.4.1 (PATCH - Notes maxLength)

**Schema change:**
```diff
- "notes": { "items": { "maxLength": 500 } }
+ "notes": { "items": { "maxLength": 5000 } }

- "schemaVersion": "2.4.0"
+ "schemaVersion": "2.4.1"
```

**Migration behavior:**
```
Data version: 2.4.0
Schema version: 2.4.1
Difference: PATCH only

Action: Update data.version to 2.4.1
No data transformation required
```

### A.4 Example: v2.4.0 to v2.5.0 (MINOR - Required Field)

**Schema change:**
```diff
+ "tasks[].priority": { "type": "string", "enum": [...], "required": true }

- "schemaVersion": "2.4.0"
+ "schemaVersion": "2.5.0"
```

**Migration function:**
```bash
migrate_todo_v2_4_to_v2_5() {
    local file="$1"

    echo "  Adding required 'priority' field to all tasks..."

    local updated_content
    updated_content=$(jq '
        .tasks = [.tasks[] |
            if .priority == null then
                .priority = "medium"
            else . end
        ]
    ' "$file") || return 1

    save_json "$file" "$updated_content"
    update_version_field "$file" "2.5.0"
}
```

---

## 10. References

- SOLID Principles: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion
- DRY: Don't Repeat Yourself
- Semver: https://semver.org/
- JSON Schema: https://json-schema.org/
- Related specs: BACKUP-SYSTEM-SPEC.md, CONFIG-SYSTEM-SPEC.md
