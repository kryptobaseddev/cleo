#!/usr/bin/env bash
# migrate.sh - Schema version migration system for claude-todo
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: file-ops.sh, logging.sh
# PROVIDES: check_schema_version, run_migrations, get_default_phases,
#           parse_version, compare_versions, SCHEMA_VERSION_TODO,
#           SCHEMA_VERSION_CONFIG, SCHEMA_VERSION_ARCHIVE, SCHEMA_VERSION_LOG

#=== SOURCE GUARD ================================================
[[ -n "${_MIGRATE_SH_LOADED:-}" ]] && return 0
declare -r _MIGRATE_SH_LOADED=1

set -euo pipefail

# Source dependencies
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/file-ops.sh
source "$SCRIPT_DIR/file-ops.sh"
# shellcheck source=lib/logging.sh
source "$SCRIPT_DIR/logging.sh"

# ============================================================================
# CONSTANTS
# ============================================================================

# Current schema versions (single source of truth)
SCHEMA_VERSION_TODO="2.4.0"
SCHEMA_VERSION_CONFIG="2.2.0"
SCHEMA_VERSION_ARCHIVE="2.1.0"
SCHEMA_VERSION_LOG="2.1.0"

# Migration scripts directory
MIGRATIONS_DIR="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}/migrations"

# Templates directory (source of truth for default structures)
TEMPLATES_DIR="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}/templates"

# ============================================================================
# DEFAULT STRUCTURE HELPERS
# ============================================================================

# Get default phases from template (single source of truth)
# Returns JSON object with default phase definitions
get_default_phases() {
    local template_file="${TEMPLATES_DIR}/todo.template.json"

    if [[ -f "$template_file" ]]; then
        # Read phases from template, strip template placeholders
        jq '.project.phases | walk(if type == "string" and test("\\{\\{") then null else . end)' "$template_file" 2>/dev/null
    else
        # Fallback if template not found (shouldn't happen in normal install)
        echo '{"setup":{"order":1,"name":"Setup","status":"pending"},"core":{"order":2,"name":"Core","status":"pending"},"testing":{"order":3,"name":"Testing","status":"pending"},"polish":{"order":4,"name":"Polish","status":"pending"},"maintenance":{"order":5,"name":"Maintenance","status":"pending"}}'
    fi
}

# ============================================================================
# VERSION PARSING
# ============================================================================

# Parse semver version into major.minor.patch components
# Args: $1 = version string (e.g., "2.1.0")
# Returns: 0 if valid, 1 if invalid
# Output: space-separated "major minor patch"
parse_version() {
    local version="$1"

    if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        echo "ERROR: Invalid version format: $version" >&2
        echo "Expected: major.minor.patch (e.g., 2.1.0)" >&2
        return 1
    fi

    echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}"
    return 0
}

# Compare two semantic versions
# Args: $1 = version1, $2 = version2
# Returns: 0 if v1 < v2, 1 if v1 == v2, 2 if v1 > v2
compare_versions() {
    local v1="$1"
    local v2="$2"

    local v1_parts v2_parts
    v1_parts=$(parse_version "$v1") || return 1
    v2_parts=$(parse_version "$v2") || return 1

    read -r v1_major v1_minor v1_patch <<< "$v1_parts"
    read -r v2_major v2_minor v2_patch <<< "$v2_parts"

    # Compare major
    if [[ $v1_major -lt $v2_major ]]; then
        return 0
    elif [[ $v1_major -gt $v2_major ]]; then
        return 2
    fi

    # Compare minor
    if [[ $v1_minor -lt $v2_minor ]]; then
        return 0
    elif [[ $v1_minor -gt $v2_minor ]]; then
        return 2
    fi

    # Compare patch
    if [[ $v1_patch -lt $v2_patch ]]; then
        return 0
    elif [[ $v1_patch -gt $v2_patch ]]; then
        return 2
    fi

    # Equal
    return 1
}

# Check if version needs migration
# Args: $1 = current version, $2 = target version
# Returns: 0 if migration needed, 1 if not
needs_migration() {
    local current="$1"
    local target="$2"

    compare_versions "$current" "$target"
    local result=$?

    # Return 0 (true) if current < target
    [[ $result -eq 0 ]]
}

# ============================================================================
# VERSION DETECTION
# ============================================================================

# Detect schema version from JSON file
# Args: $1 = file path
# Returns: version string or "unknown"
detect_file_version() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        echo "unknown"
        return 1
    fi

    # Try to extract version field - check both top-level and _meta.version
    local version
    version=$(jq -r '.version // ._meta.version // "unknown"' "$file" 2>/dev/null)

    if [[ "$version" == "unknown" || -z "$version" ]]; then
        # Try to infer from $schema field
        local schema_id
        schema_id=$(jq -r '."$schema" // ""' "$file" 2>/dev/null)

        # Extract version from schema ID (e.g., "claude-todo-schema-v2.1")
        if [[ "$schema_id" =~ v([0-9]+\.[0-9]+) ]]; then
            version="${BASH_REMATCH[1]}.0"
        else
            version="1.0.0"  # Assume oldest version if no version info
        fi
    fi

    # Special case: Check if file has string project field (pre-v2.2.0 format)
    # This overrides the version field if detected
    if [[ "$version" == "2.1.0" ]] || [[ "$version" == "2.0.0" ]]; then
        local project_type
        project_type=$(jq -r 'if has("project") then (.project | type) else "null" end' "$file" 2>/dev/null)

        if [[ "$project_type" == "string" ]]; then
            # Old format with string project -> needs v2.2.0 migration
            echo "2.1.0"
            return 0
        fi
    fi

    echo "$version"
}

# Get expected version for file type
# Args: $1 = file type (todo|config|archive|log)
# Returns: expected version string
get_expected_version() {
    local file_type="$1"

    case "$file_type" in
        "todo")
            echo "$SCHEMA_VERSION_TODO"
            ;;
        "config")
            echo "$SCHEMA_VERSION_CONFIG"
            ;;
        "archive")
            echo "$SCHEMA_VERSION_ARCHIVE"
            ;;
        "log")
            echo "$SCHEMA_VERSION_LOG"
            ;;
        *)
            echo "ERROR: Unknown file type: $file_type" >&2
            return 1
            ;;
    esac
}

# ============================================================================
# MIGRATION EXECUTION
# ============================================================================

# Execute migration for a file
# Args: $1 = file path, $2 = file type, $3 = from version, $4 = to version
# Returns: 0 on success, 1 on failure
migrate_file() {
    local file="$1"
    local file_type="$2"
    local from_version="$3"
    local to_version="$4"

    echo "Migrating $file_type from v$from_version to v$to_version..."

    # Create backup before migration
    local backup_file
    backup_file=$(create_backup "$file" "pre-migration-v$to_version") || {
        echo "ERROR: Failed to create backup" >&2
        return 1
    }

    echo "Backup created: $backup_file"

    # Find migration path (may require multiple steps)
    local migration_chain
    migration_chain=$(find_migration_path "$from_version" "$to_version") || {
        echo "ERROR: No migration path found" >&2
        return 1
    }

    # Execute each migration step
    local current_file="$file"
    local step=1

    while read -r migration_version; do
        echo "  Step $step: Migrating to v$migration_version..."

        if ! execute_migration_step "$current_file" "$file_type" "$migration_version"; then
            echo "ERROR: Migration step failed" >&2
            echo "Restoring backup..." >&2
            restore_file "$backup_file" "$file" || {
                echo "CRITICAL: Failed to restore backup!" >&2
                echo "Manual recovery required from: $backup_file" >&2
                return 1
            }
            return 1
        fi

        ((step++))
    done <<< "$migration_chain"

    # Verify final version
    local final_version
    final_version=$(detect_file_version "$file")

    if [[ "$final_version" != "$to_version" ]]; then
        echo "WARNING: Final version ($final_version) doesn't match target ($to_version)" >&2
    fi

    echo "✓ Migration successful: $file"
    log_migration "$file" "$file_type" "$from_version" "$to_version"

    return 0
}

# Find migration path between versions
# Args: $1 = from version, $2 = to version
# Returns: newline-separated list of intermediate versions
find_migration_path() {
    local from="$1"
    local to="$2"

    # For now, simple linear path (can be enhanced for complex scenarios)
    # Direct migration to target version
    echo "$to"
}

# Execute a single migration step
# Args: $1 = file path, $2 = file type, $3 = target version
# Returns: 0 on success, 1 on failure
execute_migration_step() {
    local file="$1"
    local file_type="$2"
    local target_version="$3"

    # Try to find and execute migration function
    local migration_func="migrate_${file_type}_to_${target_version//./_}"

    if declare -f "$migration_func" >/dev/null 2>&1; then
        # Custom migration function exists
        "$migration_func" "$file"
    else
        # Use generic version update
        update_version_field "$file" "$target_version"
    fi
}

# ============================================================================
# GENERIC MIGRATION HELPERS
# ============================================================================

# Update version field in JSON file
# Args: $1 = file path, $2 = new version
update_version_field() {
    local file="$1"
    local new_version="$2"

    # Update version field using atomic save_json
    local updated_content
    updated_content=$(jq --arg ver "$new_version" '.version = $ver' "$file") || {
        echo "ERROR: Failed to update version field" >&2
        return 1
    }

    save_json "$file" "$updated_content"
}

# Add field if missing (idempotent)
# Args: $1 = file, $2 = jq path, $3 = default value (JSON)
add_field_if_missing() {
    local file="$1"
    local path="$2"
    local default="$3"

    # Add field using atomic save_json
    local updated_content
    updated_content=$(jq --argjson default "$default" \
       "if $path == null then $path = \$default else . end" \
       "$file") || {
        echo "ERROR: Failed to add field $path" >&2
        return 1
    }

    save_json "$file" "$updated_content"
}

# Remove field if exists (idempotent)
# Args: $1 = file, $2 = jq path
remove_field_if_exists() {
    local file="$1"
    local path="$2"

    # Remove field using atomic save_json
    local updated_content
    updated_content=$(jq "del($path)" "$file") || {
        echo "ERROR: Failed to remove field $path" >&2
        return 1
    }

    save_json "$file" "$updated_content"
}

# Rename field (idempotent)
# Args: $1 = file, $2 = old path, $3 = new path
rename_field() {
    local file="$1"
    local old_path="$2"
    local new_path="$3"

    # Rename field using atomic save_json
    local updated_content
    updated_content=$(jq "$new_path = $old_path | del($old_path)" "$file") || {
        echo "ERROR: Failed to rename field $old_path to $new_path" >&2
        return 1
    }

    save_json "$file" "$updated_content"
}

# ============================================================================
# SPECIFIC MIGRATIONS
# ============================================================================

# Migration helper to rename config fields (backward compatibility)
# Args: $1 = file path
migrate_config_field_naming() {
    local file="$1"

    # Rename old field names to new show* prefix pattern
    # This maintains backward compatibility while standardizing naming
    local updated_content
    updated_content=$(jq '
        if .output then
            .output |= (
                # Rename colorEnabled -> showColor
                if .colorEnabled != null then
                    .showColor = .colorEnabled | del(.colorEnabled)
                else . end |
                # Rename unicodeEnabled -> showUnicode
                if .unicodeEnabled != null then
                    .showUnicode = .unicodeEnabled | del(.unicodeEnabled)
                else . end |
                # Rename progressBars -> showProgressBars
                if .progressBars != null then
                    .showProgressBars = .progressBars | del(.progressBars)
                else . end |
                # Rename compactTitles -> showCompactTitles
                if .compactTitles != null then
                    .showCompactTitles = .compactTitles | del(.compactTitles)
                else . end
            )
        else . end
    ' "$file") || {
        echo "ERROR: Failed to migrate config field names" >&2
        return 1
    }

    save_json "$file" "$updated_content"
}

# Migration from any 2.x version to 2.1.0 for config.json
migrate_config_to_2_1_0() {
    local file="$1"

    # Add new config sections if missing
    add_field_if_missing "$file" ".session" '{"requireSessionNote":true,"warnOnNoFocus":true,"autoStartSession":true,"sessionTimeoutHours":24}' || return 1

    # Migrate field names for consistency (idempotent)
    migrate_config_field_naming "$file" || return 1

    # Update version
    update_version_field "$file" "2.1.0"
}

# Migration from 2.1.0 to 2.2.0 for config.json
# Adds hierarchy configuration section with LLM-Agent-First defaults
# See CONFIG-SYSTEM-SPEC.md Appendix A.5, HIERARCHY-ENHANCEMENT-SPEC.md Part 3.2
migrate_config_to_2_2_0() {
    local file="$1"

    # Add hierarchy section with LLM-Agent-First defaults
    # - maxSiblings: 20 (was 7, based on human cognitive limits)
    # - countDoneInLimit: false (done tasks are historical, not active context)
    # - maxActiveSiblings: 8 (aligns with TodoWrite sync limit)
    # - maxDepth: 3 (organizational, rarely needs changing)
    add_field_if_missing "$file" ".hierarchy" '{"maxSiblings":20,"maxDepth":3,"countDoneInLimit":false,"maxActiveSiblings":8}' || return 1

    # Update version
    update_version_field "$file" "2.2.0"
}

# Example: Migration from 2.0.0 to 2.1.0 for todo.json
# migrate_todo_to_2_1_0() {
#     local file="$1"
#
#     # Add new fields introduced in 2.1.0
#     add_field_if_missing "$file" "._meta.activeSession" "null"
#     add_field_if_missing "$file" ".focus.nextAction" "null"
#
#     # Update version
#     update_version_field "$file" "2.1.0"
# }

# Migration from 2.1.0 to 2.2.0 for todo.json
# Converts project field from string to object with phases
migrate_todo_to_2_2_0() {
    local file="$1"

    # Check if project is already an object (idempotent)
    local project_type
    project_type=$(jq -r '.project | type' "$file" 2>/dev/null)

    local updated_content
    if [[ "$project_type" == "object" ]]; then
        # Already migrated, just ensure phases have required fields and update version
        updated_content=$(jq '
            # Ensure all phases have startedAt and completedAt fields
            .project.phases |= (
                to_entries | map(
                    .value |= (
                        if .startedAt == null then .startedAt = null else . end |
                        if .completedAt == null then .completedAt = null else . end
                    )
                ) | from_entries
            )
        ' "$file") || {
            echo "ERROR: Failed to update existing phase fields" >&2
            return 1
        }
    else
        # Migrate from string to object
        # Get default phases from template (single source of truth)
        local default_phases
        default_phases=$(get_default_phases)

        updated_content=$(jq --argjson phases "$default_phases" '
            # Convert project string to object with phases from template
            if (.project | type) == "string" then
                .project = {
                    "name": .project,
                    "currentPhase": null,
                    "phases": $phases
                }
            else . end
        ' "$file") || {
            echo "ERROR: Failed to migrate project field" >&2
            return 1
        }
    fi

    # Save the updated content atomically
    save_json "$file" "$updated_content" || {
        echo "ERROR: Failed to update file" >&2
        return 1
    }

    # Update version fields
    update_version_field "$file" "2.2.0" || return 1

    # Update _meta.version to match using atomic save_json
    local meta_updated
    meta_updated=$(jq '._meta.version = "2.2.0"' "$file") || {
        echo "ERROR: Failed to update _meta.version" >&2
        return 1
    }

    save_json "$file" "$meta_updated"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        log_migration "$file" "todo" "2.1.0" "2.2.0"
    fi

    return 0
}

# Migration from 2.2.0 to 2.3.0 for todo.json
# Adds hierarchy fields: type, parentId, size
# Migrates label conventions to structured fields
migrate_todo_to_2_3_0() {
    local file="$1"

    echo "  Adding hierarchy fields (type, parentId, size) to tasks..."

    # Perform the migration with jq
    # - Add type: "task" if missing
    # - Add parentId: null if missing
    # - Add size: null if missing (optional field)
    # - Migrate label conventions (supports both colon and hyphen separators):
    #   - "type:epic" or "type-epic" → type: "epic", remove label
    #   - "type:task" or "type-task" → type: "task", remove label
    #   - "type:subtask" or "type-subtask" → type: "subtask", remove label
    #   - "parent:T001" or "parent-T001" → parentId: "T001", remove label
    #   - "size:small" or "size-small" → size: "small", remove label
    #   - "size:medium" or "size-medium" → size: "medium", remove label
    #   - "size:large" or "size-large" → size: "large", remove label
    local updated_content
    updated_content=$(jq '
        # Helper to check if label matches prefix with either : or - separator
        def matches_prefix($prefix):
            startswith($prefix + ":") or startswith($prefix + "-");

        # Helper to extract value from label with either : or - separator
        def extract_value($prefix):
            if startswith($prefix + ":") then
                split(":")[1]
            elif startswith($prefix + "-") then
                # Handle hyphen separator - split on first hyphen after prefix
                (length - ($prefix | length) - 1) as $val_len |
                .[$prefix | length + 1:]
            else
                null
            end;

        # Helper to extract type from labels
        def extract_type_from_labels:
            if . then
                . as $labels |
                if ($labels | any(matches_prefix("type"))) then
                    ($labels | map(select(matches_prefix("type"))) | .[0] | extract_value("type") // "task")
                else
                    "task"
                end
            else
                "task"
            end;

        # Helper to extract parent from labels
        def extract_parent_from_labels:
            if . then
                . as $labels |
                if ($labels | any(matches_prefix("parent"))) then
                    ($labels | map(select(matches_prefix("parent"))) | .[0] | extract_value("parent") // null)
                else
                    null
                end
            else
                null
            end;

        # Helper to extract size from labels
        def extract_size_from_labels:
            if . then
                . as $labels |
                if ($labels | any(matches_prefix("size"))) then
                    ($labels | map(select(matches_prefix("size"))) | .[0] | extract_value("size") // null)
                else
                    null
                end
            else
                null
            end;

        # Helper to clean labels (remove migrated ones - both : and - separators)
        def clean_labels:
            if . then
                map(select(
                    (matches_prefix("type") | not) and
                    (matches_prefix("parent") | not) and
                    (matches_prefix("size") | not)
                ))
            else
                []
            end;

        # Migrate each task
        .tasks = [.tasks[] |
            # Extract values from labels if present
            (.labels // []) as $labels |

            # Set type: use existing, or extract from labels, or default to "task"
            .type = (.type // ($labels | extract_type_from_labels)) |

            # Set parentId: use existing, or extract from labels, or null
            .parentId = (.parentId // ($labels | extract_parent_from_labels)) |

            # Set size: use existing, or extract from labels, or null (optional)
            (if .size == null then
                .size = ($labels | extract_size_from_labels)
            else
                .
            end) |

            # Clean up migrated labels
            .labels = ($labels | clean_labels)
        ] |

        # Update version fields
        .version = "2.3.0" |
        ._meta.version = "2.3.0"
    ' "$file") || {
        echo "ERROR: Failed to add hierarchy fields" >&2
        return 1
    }

    # Validate the result
    if ! echo "$updated_content" | jq empty 2>/dev/null; then
        echo "ERROR: Migration produced invalid JSON" >&2
        return 1
    fi

    # Atomic save using save_json
    save_json "$file" "$updated_content" || {
        echo "ERROR: Failed to update file" >&2
        return 1
    }

    # Count tasks with hierarchy fields
    local task_count type_epic type_task type_subtask with_parent
    task_count=$(jq '.tasks | length' "$file")
    type_epic=$(jq '[.tasks[] | select(.type == "epic")] | length' "$file")
    type_task=$(jq '[.tasks[] | select(.type == "task")] | length' "$file")
    type_subtask=$(jq '[.tasks[] | select(.type == "subtask")] | length' "$file")
    with_parent=$(jq '[.tasks[] | select(.parentId != null)] | length' "$file")

    echo "  Migrated $task_count tasks:"
    echo "    - Epic: $type_epic"
    echo "    - Task: $type_task"
    echo "    - Subtask: $type_subtask"
    echo "    - With parent: $with_parent"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        log_migration "$file" "todo" "2.2.0" "2.3.0"
    fi

    return 0
}

# ============================================================================
# BACKWARD COMPATIBILITY CHECKS
# ============================================================================

# Check if file is compatible with current schema
# Args: $1 = file path, $2 = file type
# Returns: 0 if compatible, 1 if migration needed, 2 if incompatible
check_compatibility() {
    local file="$1"
    local file_type="$2"

    local current_version expected_version
    current_version=$(detect_file_version "$file")
    expected_version=$(get_expected_version "$file_type")

    if [[ "$current_version" == "$expected_version" ]]; then
        return 0  # Exact match
    fi

    # Parse versions
    local curr_parts exp_parts
    curr_parts=$(parse_version "$current_version") || return 2
    exp_parts=$(parse_version "$expected_version") || return 2

    # Explicitly set IFS to space for version parsing (IFS may have been modified by caller)
    IFS=' ' read -r curr_major curr_minor curr_patch <<< "$curr_parts"
    IFS=' ' read -r exp_major exp_minor exp_patch <<< "$exp_parts"

    # Check backward compatibility rules
    if [[ $curr_major -ne $exp_major ]]; then
        # Major version mismatch - incompatible
        return 2
    fi

    if [[ $curr_minor -lt $exp_minor ]] || \
       [[ $curr_minor -eq $exp_minor && $curr_patch -lt $exp_patch ]]; then
        # Current is older - migration needed
        return 1
    fi

    # Current is newer or equal - compatible
    return 0
}

# ============================================================================
# MAIN MIGRATION INTERFACE
# ============================================================================

# Check and migrate file if needed
# Args: $1 = file path, $2 = file type
# Returns: 0 if compatible or migrated, 1 on error
ensure_compatible_version() {
    local file="$1"
    local file_type="$2"

    check_compatibility "$file" "$file_type"
    local compat_status=$?

    case $compat_status in
        0)
            # Already compatible
            return 0
            ;;
        1)
            # Migration needed
            local current_version expected_version
            current_version=$(detect_file_version "$file")
            expected_version=$(get_expected_version "$file_type")

            echo "Migration required: $file (v$current_version → v$expected_version)"
            echo "Automatic migration will be attempted..."

            if migrate_file "$file" "$file_type" "$current_version" "$expected_version"; then
                echo "✓ Migration successful"
                return 0
            else
                echo "✗ Migration failed" >&2
                return 1
            fi
            ;;
        2)
            # Incompatible
            local current_version expected_version
            current_version=$(detect_file_version "$file")
            expected_version=$(get_expected_version "$file_type")

            echo "ERROR: Incompatible schema version" >&2
            echo "  File: $file" >&2
            echo "  Current version: $current_version" >&2
            echo "  Expected version: $expected_version" >&2
            echo "  Major version mismatch - manual intervention required" >&2
            return 1
            ;;
    esac
}

# Log migration operation
log_migration() {
    local file="$1"
    local file_type="$2"
    local from_version="$3"
    local to_version="$4"

    echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") MIGRATION $file_type: v$from_version → v$to_version" >> "${file%/*}/.migration.log"
}

# ============================================================================
# BACKWARD COMPATIBILITY ALIASES
# ============================================================================

# Alias for backward compatibility with file-ops.sh function names
create_backup() {
    # create_backup used to accept two arguments: file and label
    # backup_file only accepts one argument: file
    # The label argument is ignored for backward compatibility
    backup_file "$1"
}

# Alias for backward compatibility with file-ops.sh function names
restore_file() {
    # restore_file(backup_file, target_file) -> restore_backup(target_file, backup_num)
    # This is a different signature, so we need to handle it carefully
    local backup="$1"
    local target="$2"

    if [[ -z "$backup" || -z "$target" ]]; then
        echo "Error: Both backup and target file required" >&2
        return 1
    fi

    # Simply copy the backup to target location
    if ! cp "$backup" "$target" 2>/dev/null; then
        echo "Error: Failed to restore from backup: $backup" >&2
        return 1
    fi

    # Set proper permissions
    chmod 644 "$target" 2>/dev/null || true

    echo "Restored from backup: $backup" >&2
    return 0
}

# ============================================================================
# REPAIR FUNCTIONS (T302)
# ============================================================================

# Get canonical phase structure from template
# Returns: JSON object with canonical phases (with {{TIMESTAMP}} placeholders cleaned)
get_canonical_phases() {
    local template_file="${TEMPLATES_DIR}/todo.template.json"

    if [[ -f "$template_file" ]]; then
        # Read phases from template, clean timestamp placeholders to null
        jq '.project.phases | walk(if type == "string" and test("\\{\\{") then null else . end)' "$template_file" 2>/dev/null
    else
        # Fallback: hardcoded canonical structure
        cat <<'EOF'
{
  "setup": {"order":1,"name":"Setup & Foundation","description":"Initial project setup, dependencies, and configuration","status":"pending","startedAt":null,"completedAt":null},
  "core": {"order":2,"name":"Core Development","description":"Build core functionality and features","status":"pending","startedAt":null,"completedAt":null},
  "testing": {"order":3,"name":"Testing & Validation","description":"Comprehensive testing, validation, and quality assurance","status":"pending","startedAt":null,"completedAt":null},
  "polish": {"order":4,"name":"Polish & Refinement","description":"UX improvements, optimization, and release preparation","status":"pending","startedAt":null,"completedAt":null},
  "maintenance": {"order":5,"name":"Maintenance","description":"Bug fixes, updates, and ongoing support","status":"pending","startedAt":null,"completedAt":null}
}
EOF
    fi
}

# Compare actual phases against canonical and return discrepancies
# Args: $1 = file path
# Returns: JSON object with {missing: [], extra: [], order_mismatch: []}
compare_phases_structure() {
    local file="$1"

    local canonical
    canonical=$(get_canonical_phases)

    local actual
    actual=$(jq '.project.phases // {}' "$file" 2>/dev/null)

    # Use jq to compare and find discrepancies
    jq -n --argjson canonical "$canonical" --argjson actual "$actual" '
        ($canonical | keys) as $canonical_keys |
        ($actual | keys) as $actual_keys |
        {
            missing: ($canonical_keys - $actual_keys),
            extra: ($actual_keys - $canonical_keys),
            order_mismatch: [
                $canonical_keys[] |
                select(. as $k | $actual[$k] != null) |
                select(. as $k | $canonical[$k].order != $actual[$k].order) |
                {
                    phase: .,
                    expected_order: $canonical[.].order,
                    actual_order: $actual[.].order
                }
            ]
        }
    '
}

# Get repair actions needed for a todo.json file
# Args: $1 = file path
# Returns: JSON object with all needed repairs
get_repair_actions() {
    local file="$1"

    local phase_diff
    phase_diff=$(compare_phases_structure "$file")

    local missing_phases extra_phases order_mismatches
    missing_phases=$(echo "$phase_diff" | jq -r '.missing | length')
    extra_phases=$(echo "$phase_diff" | jq -r '.extra | length')
    order_mismatches=$(echo "$phase_diff" | jq -r '.order_mismatch | length')

    local needs_repair=false
    [[ $missing_phases -gt 0 || $extra_phases -gt 0 || $order_mismatches -gt 0 ]] && needs_repair=true

    # Check _meta fields
    local meta_issues=()
    local has_checksum has_schema_version has_config_version
    has_checksum=$(jq -r '._meta.checksum // "missing"' "$file")
    has_schema_version=$(jq -r '._meta.schemaVersion // "missing"' "$file")
    has_config_version=$(jq -r '._meta.configVersion // "missing"' "$file")

    [[ "$has_checksum" == "missing" ]] && meta_issues+=("checksum")
    [[ "$has_schema_version" == "missing" ]] && meta_issues+=("schemaVersion")
    [[ "$has_config_version" == "missing" ]] && meta_issues+=("configVersion")

    # Check focus fields
    local focus_issues=()
    local has_session_note has_next_action
    has_session_note=$(jq -r '.focus.sessionNote // "missing"' "$file")
    has_next_action=$(jq -r '.focus.nextAction // "missing"' "$file")

    [[ "$has_session_note" == "missing" ]] && focus_issues+=("sessionNote")
    [[ "$has_next_action" == "missing" ]] && focus_issues+=("nextAction")

    # Output summary
    jq -n \
        --argjson phase_diff "$phase_diff" \
        --argjson meta_issues "$(printf '%s\n' "${meta_issues[@]:-}" | jq -R . | jq -s .)" \
        --argjson focus_issues "$(printf '%s\n' "${focus_issues[@]:-}" | jq -R . | jq -s .)" \
        --argjson needs_repair "$needs_repair" \
        '{
            needs_repair: $needs_repair,
            phases: $phase_diff,
            meta_missing: ($meta_issues | map(select(. != ""))),
            focus_missing: ($focus_issues | map(select(. != "")))
        }'
}

# Display repair preview (dry-run)
# Args: $1 = file path
show_repair_preview() {
    local file="$1"

    local actions
    actions=$(get_repair_actions "$file")

    local needs_repair
    needs_repair=$(echo "$actions" | jq -r '.needs_repair')

    if [[ "$needs_repair" != "true" ]]; then
        echo "✓ No repairs needed - file is compliant with schema"
        return 0
    fi

    echo "Repair Preview"
    echo "=============="
    echo ""
    echo "File: $file"
    echo ""

    # Phase repairs
    local missing_count extra_count order_count
    missing_count=$(echo "$actions" | jq '.phases.missing | length')
    extra_count=$(echo "$actions" | jq '.phases.extra | length')
    order_count=$(echo "$actions" | jq '.phases.order_mismatch | length')

    if [[ $missing_count -gt 0 || $extra_count -gt 0 || $order_count -gt 0 ]]; then
        echo "Phase Repairs:"

        if [[ $missing_count -gt 0 ]]; then
            echo "  Add missing phases:"
            echo "$actions" | jq -r '.phases.missing[] | "    + \(.)"'
        fi

        if [[ $extra_count -gt 0 ]]; then
            echo "  Remove obsolete phases:"
            echo "$actions" | jq -r '.phases.extra[] | "    - \(.)"'
        fi

        if [[ $order_count -gt 0 ]]; then
            echo "  Fix phase ordering:"
            echo "$actions" | jq -r '.phases.order_mismatch[] | "    ~ \(.phase): order \(.actual_order) → \(.expected_order)"'
        fi
        echo ""
    fi

    # Meta repairs
    local meta_count
    meta_count=$(echo "$actions" | jq '.meta_missing | length')
    if [[ $meta_count -gt 0 ]]; then
        echo "Meta Field Repairs:"
        echo "$actions" | jq -r '.meta_missing[] | "  + _meta.\(.)"'
        echo ""
    fi

    # Focus repairs
    local focus_count
    focus_count=$(echo "$actions" | jq '.focus_missing | length')
    if [[ $focus_count -gt 0 ]]; then
        echo "Focus Field Repairs:"
        echo "$actions" | jq -r '.focus_missing[] | "  + focus.\(.)"'
        echo ""
    fi

    return 0
}

# Execute repairs on todo.json
# Args: $1 = file path
# Returns: 0 on success, 1 on failure
execute_repair() {
    local file="$1"

    # Get canonical phases
    local canonical_phases
    canonical_phases=$(get_canonical_phases)

    # Build the repair jq filter
    # This is a complex but idempotent transformation
    local updated_content
    updated_content=$(jq --argjson canonical "$canonical_phases" '
        # Start with the original
        . as $original |

        # Get existing phases with their current status/timestamps
        (.project.phases // {}) as $existing_phases |

        # Build new phases object
        ($canonical | to_entries | map(
            .key as $slug |
            .value as $default |
            # If phase exists, preserve status/timestamps, update order/name/description
            if $existing_phases[$slug] then
                {
                    key: $slug,
                    value: ($existing_phases[$slug] + {
                        order: $default.order,
                        name: $default.name,
                        description: $default.description
                    })
                }
            else
                # New phase with defaults
                {key: $slug, value: $default}
            end
        ) | from_entries) as $repaired_phases |

        # Apply all repairs
        $original |

        # Ensure project is object structure
        (if (.project | type) == "string" then
            .project = {name: .project, currentPhase: null, phases: {}}
        else . end) |

        # Set repaired phases
        .project.phases = $repaired_phases |

        # Ensure _meta has all fields
        ._meta.schemaVersion = "2.4.0" |
        ._meta.configVersion = (._meta.configVersion // "2.1.0") |
        (if ._meta.checksum == null then ._meta.checksum = "pending" else . end) |

        # Ensure version field
        .version = "2.4.0" |

        # Ensure focus has all fields
        .focus.sessionNote = (.focus.sessionNote // null) |
        .focus.nextAction = (.focus.nextAction // null)
    ' "$file" 2>/dev/null)

    local jq_status=$?
    if [[ $jq_status -ne 0 ]]; then
        echo "ERROR: jq transformation failed" >&2
        return 1
    fi

    # Validate the result
    if ! echo "$updated_content" | jq empty 2>/dev/null; then
        echo "ERROR: Repair produced invalid JSON" >&2
        return 1
    fi

    # Atomic save using save_json
    save_json "$file" "$updated_content"

    return 0
}

# Main repair command handler
# Args: $1 = file path, $2 = mode (preview|auto|interactive)
# Returns: 0 on success/no-repair-needed, 1 on failure
repair_todo_schema() {
    local file="$1"
    local mode="${2:-interactive}"

    if [[ ! -f "$file" ]]; then
        echo "ERROR: File not found: $file" >&2
        return 1
    fi

    # Get repair actions
    local actions
    actions=$(get_repair_actions "$file")

    local needs_repair
    needs_repair=$(echo "$actions" | jq -r '.needs_repair')

    if [[ "$needs_repair" != "true" ]]; then
        echo "✓ No repairs needed - file is fully compliant"
        return 0
    fi

    case "$mode" in
        "preview"|"dry-run")
            show_repair_preview "$file"
            echo "Run with --auto to apply these repairs"
            return 0
            ;;
        "auto")
            echo "Applying repairs..."

            # Create backup first
            local backup_file
            backup_file=$(create_backup "$file" "pre-repair") || {
                echo "ERROR: Failed to create backup" >&2
                return 1
            }
            echo "✓ Backup created: $backup_file"

            # Execute repair
            if ! execute_repair "$file"; then
                echo "ERROR: Repair failed" >&2
                echo "Restoring from backup..."
                restore_file "$backup_file" "$file" || {
                    echo "CRITICAL: Failed to restore backup!" >&2
                    return 1
                }
                return 1
            fi

            # Verify repair
            local post_actions
            post_actions=$(get_repair_actions "$file")
            local still_needs_repair
            still_needs_repair=$(echo "$post_actions" | jq -r '.needs_repair')

            if [[ "$still_needs_repair" == "true" ]]; then
                echo "WARNING: Some issues remain after repair" >&2
                show_repair_preview "$file"
                return 1
            fi

            echo "✓ Repair completed successfully"
            return 0
            ;;
        "interactive")
            show_repair_preview "$file"
            echo ""
            read -p "Apply these repairs? (y/N) " -r
            echo ""

            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Repair cancelled"
                return 0
            fi

            # Recursively call with auto mode
            repair_todo_schema "$file" "auto"
            ;;
        *)
            echo "ERROR: Unknown mode: $mode" >&2
            return 1
            ;;
    esac
}

# ============================================================================
# CLI INTERFACE
# ============================================================================

# Show migration status for all files
show_migration_status() {
    local claude_dir="${1:-.claude}"

    if [[ ! -d "$claude_dir" ]]; then
        echo "ERROR: Directory not found: $claude_dir" >&2
        return 1
    fi

    echo "Schema Version Status"
    echo "===================="
    echo ""

    local files=(
        "$claude_dir/todo.json:todo"
        "$claude_dir/todo-config.json:config"
        "$claude_dir/todo-archive.json:archive"
        "$claude_dir/todo-log.json:log"
    )

    for file_spec in "${files[@]}"; do
        IFS=':' read -r file file_type <<< "$file_spec"

        if [[ ! -f "$file" ]]; then
            echo "⊘ $file_type: not found"
            continue
        fi

        local current_version expected_version
        current_version=$(detect_file_version "$file")
        expected_version=$(get_expected_version "$file_type")

        local status
        check_compatibility "$file" "$file_type" && status=$? || status=$?

        # Special check for v2.2.0 migration (string project → object)
        local needs_v2_2_migration=""
        if [[ "$file_type" == "todo" ]]; then
            local project_type
            project_type=$(jq -r 'if has("project") then (.project | type) else "null" end' "$file" 2>/dev/null)
            if [[ "$project_type" == "string" ]]; then
                needs_v2_2_migration=" (project field: string → object)"
            fi
        fi

        case $status in
            0)
                echo "✓ $file_type: v$current_version (compatible)"
                ;;
            1)
                echo "⚠ $file_type: v$current_version (migration needed → v$expected_version)$needs_v2_2_migration"
                ;;
            2)
                echo "✗ $file_type: v$current_version (incompatible with v$expected_version)"
                ;;
        esac
    done
}

# ============================================================================
# MAIN (for testing)
# ============================================================================

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        "status")
            show_migration_status "${2:-.claude}"
            ;;
        "migrate")
            if [[ $# -lt 3 ]]; then
                echo "Usage: $0 migrate <file> <type>" >&2
                echo "Types: todo, config, archive, log" >&2
                exit 1
            fi
            ensure_compatible_version "$2" "$3"
            ;;
        "check")
            if [[ $# -lt 3 ]]; then
                echo "Usage: $0 check <file> <type>" >&2
                exit 1
            fi
            check_compatibility "$2" "$3"
            exit $?
            ;;
        *)
            echo "Usage: $0 {status|migrate|check} [args...]" >&2
            echo "" >&2
            echo "Commands:" >&2
            echo "  status [dir]           Show migration status for all files" >&2
            echo "  migrate <file> <type>  Migrate file to current version" >&2
            echo "  check <file> <type>    Check compatibility status" >&2
            exit 1
            ;;
    esac
fi
