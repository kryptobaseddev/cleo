#!/usr/bin/env bash
# migrate.sh - Schema version migration system for claude-todo
# Handles schema version changes gracefully with automatic data migration

# Source guard - prevent multiple sourcing
[[ -n "${_MIGRATE_SH_LOADED:-}" ]] && return 0
_MIGRATE_SH_LOADED=1

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
SCHEMA_VERSION_TODO="2.2.0"
SCHEMA_VERSION_CONFIG="2.1.0"
SCHEMA_VERSION_ARCHIVE="2.1.0"
SCHEMA_VERSION_LOG="2.1.0"

# Migration scripts directory
MIGRATIONS_DIR="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}/migrations"

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

    local temp_file="${file}.tmp"

    # Update version field
    jq --arg ver "$new_version" '.version = $ver' "$file" > "$temp_file" || {
        echo "ERROR: Failed to update version field" >&2
        rm -f "$temp_file"
        return 1
    }

    # Atomic replace
    mv "$temp_file" "$file"
}

# Add field if missing (idempotent)
# Args: $1 = file, $2 = jq path, $3 = default value (JSON)
add_field_if_missing() {
    local file="$1"
    local path="$2"
    local default="$3"

    local temp_file="${file}.tmp"

    jq --argjson default "$default" \
       "if $path == null then $path = \$default else . end" \
       "$file" > "$temp_file" || {
        echo "ERROR: Failed to add field $path" >&2
        rm -f "$temp_file"
        return 1
    }

    mv "$temp_file" "$file"
}

# Remove field if exists (idempotent)
# Args: $1 = file, $2 = jq path
remove_field_if_exists() {
    local file="$1"
    local path="$2"

    local temp_file="${file}.tmp"

    jq "del($path)" "$file" > "$temp_file" || {
        echo "ERROR: Failed to remove field $path" >&2
        rm -f "$temp_file"
        return 1
    }

    mv "$temp_file" "$file"
}

# Rename field (idempotent)
# Args: $1 = file, $2 = old path, $3 = new path
rename_field() {
    local file="$1"
    local old_path="$2"
    local new_path="$3"

    local temp_file="${file}.tmp"

    jq "$new_path = $old_path | del($old_path)" "$file" > "$temp_file" || {
        echo "ERROR: Failed to rename field $old_path to $new_path" >&2
        rm -f "$temp_file"
        return 1
    }

    mv "$temp_file" "$file"
}

# ============================================================================
# SPECIFIC MIGRATIONS
# ============================================================================

# Migration helper to rename config fields (backward compatibility)
# Args: $1 = file path
migrate_config_field_naming() {
    local file="$1"
    local temp_file="${file}.tmp"

    # Rename old field names to new show* prefix pattern
    # This maintains backward compatibility while standardizing naming
    jq '
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
    ' "$file" > "$temp_file" || {
        echo "ERROR: Failed to migrate config field names" >&2
        rm -f "$temp_file"
        return 1
    }

    mv "$temp_file" "$file"
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
    local temp_file="${file}.tmp"

    # Check if project is already an object (idempotent)
    local project_type
    project_type=$(jq -r '.project | type' "$file" 2>/dev/null)

    if [[ "$project_type" == "object" ]]; then
        # Already migrated, just ensure phases have required fields and update version
        jq '
            # Ensure all phases have startedAt and completedAt fields
            .project.phases |= (
                to_entries | map(
                    .value |= (
                        if .startedAt == null then .startedAt = null else . end |
                        if .completedAt == null then .completedAt = null else . end
                    )
                ) | from_entries
            )
        ' "$file" > "$temp_file" || {
            echo "ERROR: Failed to update existing phase fields" >&2
            rm -f "$temp_file"
            return 1
        }
    else
        # Migrate from string to object
        jq '
            # Convert project string to object with phases
            if (.project | type) == "string" then
                .project = {
                    "name": .project,
                    "currentPhase": null,
                    "phases": {
                        "setup": {
                            "order": 1,
                            "name": "Setup",
                            "description": "Initial setup and configuration",
                            "status": "pending",
                            "startedAt": null,
                            "completedAt": null
                        },
                        "core": {
                            "order": 2,
                            "name": "Core",
                            "description": "Core feature implementation",
                            "status": "pending",
                            "startedAt": null,
                            "completedAt": null
                        },
                        "polish": {
                            "order": 3,
                            "name": "Polish",
                            "description": "Refinement and testing",
                            "status": "pending",
                            "startedAt": null,
                            "completedAt": null
                        },
                        "release": {
                            "order": 4,
                            "name": "Release",
                            "description": "Release preparation",
                            "status": "pending",
                            "startedAt": null,
                            "completedAt": null
                        }
                    }
                }
            else . end
        ' "$file" > "$temp_file" || {
            echo "ERROR: Failed to migrate project field" >&2
            rm -f "$temp_file"
            return 1
        }
    fi

    # Move temp file to original
    mv "$temp_file" "$file" || {
        echo "ERROR: Failed to update file" >&2
        return 1
    }

    # Update version fields
    update_version_field "$file" "2.2.0" || return 1

    # Update _meta.version to match
    jq '._meta.version = "2.2.0"' "$file" > "$temp_file" || {
        echo "ERROR: Failed to update _meta.version" >&2
        rm -f "$temp_file"
        return 1
    }

    mv "$temp_file" "$file"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        log_migration "$file" "todo" "2.1.0" "2.2.0"
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
