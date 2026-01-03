#!/usr/bin/env bash
# Schema version migration system for cleo
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: logging.sh (transitively provides atomic-write.sh)
# PROVIDES: check_schema_version, run_migrations, get_default_phases,
#           parse_version, compare_versions, get_schema_version_from_file,
#           compare_schema_versions, bump_version_only, check_compatibility,
#           SCHEMA_VERSION_TODO, SCHEMA_VERSION_CONFIG, SCHEMA_VERSION_ARCHIVE,
#           SCHEMA_VERSION_LOG, SCHEMA_DIR

#=== SOURCE GUARD ================================================
[[ -n "${_MIGRATE_SH_LOADED:-}" ]] && return 0
declare -r _MIGRATE_SH_LOADED=1

set -euo pipefail

# Source dependencies
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/logging.sh
source "$SCRIPT_DIR/logging.sh"

# ============================================================================
# CONSTANTS
# ============================================================================

# Current schema versions (fallback if schema file doesn't have schemaVersion)
SCHEMA_VERSION_TODO="2.6.0"
SCHEMA_VERSION_CONFIG="2.4.0"
SCHEMA_VERSION_ARCHIVE="2.4.0"
SCHEMA_VERSION_LOG="2.4.0"

# Migration scripts directory
MIGRATIONS_DIR="${CLEO_HOME:-$HOME/.cleo}/migrations"

# Templates directory (source of truth for default structures)
TEMPLATES_DIR="${CLEO_HOME:-$HOME/.cleo}/templates"

# Schema directory
SCHEMA_DIR="${SCHEMA_DIR:-${CLEO_HOME:-$HOME/.cleo}/schemas}"

# ============================================================================
# LOCAL HELPER FUNCTIONS (LAYER 2)
# ============================================================================

# save_json - Atomic JSON save using Layer 1 primitives
# This is a local implementation that doesn't require file-ops.sh
# Args: $1 = file path, $2 = JSON content
# Returns: 0 on success, 1 on failure
save_json() {
    local file="$1"
    local content="$2"

    if [[ -z "$file" || -z "$content" ]]; then
        echo "save_json: Both file path and content required" >&2
        return 1
    fi

    # Validate JSON before writing
    if ! echo "$content" | jq empty 2>/dev/null; then
        echo "save_json: Invalid JSON content" >&2
        return 1
    fi

    # Use atomic-write.sh primitives
    aw_atomic_write "$file" "$content"
}

# ============================================================================
# SCHEMA VERSION HELPERS
# ============================================================================

# Get schema version from schema file (single source of truth)
# Falls back to constants if schema file doesn't have schemaVersion field
# Args: $1 = file type (todo|config|archive|log)
# Returns: version string
get_schema_version_from_file() {
    local file_type="$1"
    local schema_file=""

    # Map file type to schema file
    case "$file_type" in
        todo)    schema_file="${SCHEMA_DIR}/todo.schema.json" ;;
        config)  schema_file="${SCHEMA_DIR}/config.schema.json" ;;
        archive) schema_file="${SCHEMA_DIR}/archive.schema.json" ;;
        log)     schema_file="${SCHEMA_DIR}/log.schema.json" ;;
        *)
            echo "ERROR: Unknown file type: $file_type" >&2
            return 1
            ;;
    esac

    # Try to read schemaVersion from the schema file
    if [[ -f "$schema_file" ]]; then
        local version
        version=$(jq -r '.schemaVersion // empty' "$schema_file" 2>/dev/null)
        if [[ -n "$version" && "$version" != "null" ]]; then
            echo "$version"
            return 0
        fi
    fi

    # Fallback to constants if schema doesn't have schemaVersion yet
    case "$file_type" in
        todo)    echo "$SCHEMA_VERSION_TODO" ;;
        config)  echo "$SCHEMA_VERSION_CONFIG" ;;
        archive) echo "$SCHEMA_VERSION_ARCHIVE" ;;
        log)     echo "$SCHEMA_VERSION_LOG" ;;
    esac
}

# Compare schema versions and determine the type of difference
# Args: $1 = data version (from file), $2 = schema version (expected)
# Returns: "equal", "patch_only", "minor_diff", "major_diff", "data_newer"
compare_schema_versions() {
    local data_version="$1"
    local schema_version="$2"

    # Parse versions - handle both X.Y.Z and X.Y formats
    local data_major data_minor data_patch
    local schema_major schema_minor schema_patch

    # Parse data version
    if [[ "$data_version" =~ ^([0-9]+)\.([0-9]+)(\.([0-9]+))?$ ]]; then
        data_major="${BASH_REMATCH[1]}"
        data_minor="${BASH_REMATCH[2]}"
        data_patch="${BASH_REMATCH[4]:-0}"
    else
        echo "ERROR: Invalid data version format: $data_version" >&2
        return 1
    fi

    # Parse schema version
    if [[ "$schema_version" =~ ^([0-9]+)\.([0-9]+)(\.([0-9]+))?$ ]]; then
        schema_major="${BASH_REMATCH[1]}"
        schema_minor="${BASH_REMATCH[2]}"
        schema_patch="${BASH_REMATCH[4]:-0}"
    else
        echo "ERROR: Invalid schema version format: $schema_version" >&2
        return 1
    fi

    # Compare versions
    if [[ "$data_version" == "$schema_version" ]] || \
       [[ "$data_major" == "$schema_major" && "$data_minor" == "$schema_minor" && "$data_patch" == "$schema_patch" ]]; then
        echo "equal"
    elif [[ "$data_major" -gt "$schema_major" ]]; then
        echo "data_newer"
    elif [[ "$data_major" == "$schema_major" && "$data_minor" -gt "$schema_minor" ]]; then
        echo "data_newer"
    elif [[ "$data_major" == "$schema_major" && "$data_minor" == "$schema_minor" && "$data_patch" -gt "$schema_patch" ]]; then
        echo "data_newer"
    elif [[ "$data_major" -ne "$schema_major" ]]; then
        echo "major_diff"
    elif [[ "$data_minor" -ne "$schema_minor" ]]; then
        echo "minor_diff"
    else
        # Same major.minor, different patch (data_patch < schema_patch)
        echo "patch_only"
    fi
}

# For PATCH-only differences, just update the version field - no data transformation
# Args: $1 = file path, $2 = new version
# Returns: 0 on success, 1 on failure
bump_version_only() {
    local file="$1"
    local new_version="$2"

    echo "  Version bump only (no data transformation needed)"

    local updated_content
    updated_content=$(jq --arg ver "$new_version" '
        .version = $ver |
        if ._meta then ._meta.schemaVersion = $ver else . end
    ' "$file") || {
        echo "ERROR: Failed to bump version" >&2
        return 1
    }

    save_json "$file" "$updated_content"
}

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

    # Special case: Check if file has legacy structure (pre-v2.2.0 format)
    # This overrides the version field if detected - catches incorrectly marked versions
    # ONLY applies to todo.json - archive and log files correctly use string project
    if [[ "$version" =~ ^2\. ]]; then
        # Check if this is a todo.json file (has .tasks array, not .entries or .archivedTasks)
        local is_todo_file
        is_todo_file=$(jq -r 'if has("tasks") and (has("entries") | not) then "yes" else "no" end' "$file" 2>/dev/null)

        if [[ "$is_todo_file" == "yes" ]]; then
            local project_type
            project_type=$(jq -r 'if has("project") then (.project | type) else "null" end' "$file" 2>/dev/null)

            if [[ "$project_type" == "string" ]]; then
                # Old format with string project -> needs v2.2.0 migration
                # The version field is lying - data structure is pre-v2.2.0
                echo "2.1.0"
                return 0
            fi

            # Also check if .phases exists at top level (should be in .project.phases)
            local has_top_level_phases
            has_top_level_phases=$(jq -r 'if has("phases") then "yes" else "no" end' "$file" 2>/dev/null)

            if [[ "$has_top_level_phases" == "yes" ]]; then
                # Old format with top-level .phases -> needs v2.2.0 migration
                echo "2.1.0"
                return 0
            fi
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
# Returns: newline-separated list of intermediate versions to migrate through
find_migration_path() {
    local from="$1"
    local to="$2"

    # Define known migration steps (must be in ascending order)
    # Each version listed here has a corresponding migrate_*_to_X_Y_Z function
    local -a known_versions=("2.2.0" "2.3.0" "2.4.0" "2.5.0" "2.6.0")

    # Parse versions
    local from_parts to_parts
    from_parts=$(parse_version "$from" 2>/dev/null) || from_parts="0 0 0"
    to_parts=$(parse_version "$to" 2>/dev/null) || to_parts="2 4 0"

    read -r from_major from_minor from_patch <<< "$from_parts"
    read -r to_major to_minor to_patch <<< "$to_parts"

    # Build migration path: include all known versions > from and <= to
    local result=()
    for version in "${known_versions[@]}"; do
        local v_parts
        v_parts=$(parse_version "$version")
        read -r v_major v_minor v_patch <<< "$v_parts"

        # Skip if version <= from
        if [[ $v_major -lt $from_major ]] || \
           [[ $v_major -eq $from_major && $v_minor -lt $from_minor ]] || \
           [[ $v_major -eq $from_major && $v_minor -eq $from_minor && $v_patch -le $from_patch ]]; then
            continue
        fi

        # Skip if version > to
        if [[ $v_major -gt $to_major ]] || \
           [[ $v_major -eq $to_major && $v_minor -gt $to_minor ]] || \
           [[ $v_major -eq $to_major && $v_minor -eq $to_minor && $v_patch -gt $to_patch ]]; then
            continue
        fi

        result+=("$version")
    done

    # If no known versions in range, just return target
    if [[ ${#result[@]} -eq 0 ]]; then
        echo "$to"
    else
        printf '%s\n' "${result[@]}"
    fi
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
    # Update all version fields for consistency across file types:
    # - .version (top-level)
    # - ._meta.version (legacy, used by detect_file_version)
    # - ._meta.schemaVersion (canonical schema version)
    local updated_content
    updated_content=$(jq --arg ver "$new_version" '
        .version = $ver |
        if ._meta then (._meta.version = $ver | ._meta.schemaVersion = $ver) else . end
    ' "$file") || {
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
# IMPORTANT: Preserves existing top-level .phases and moves them into .project.phases
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

        # CRITICAL: Preserve existing top-level .phases if present
        # They take precedence over template defaults
        # Also ensure all phases have required fields (status, order, etc.)
        updated_content=$(jq --argjson default_phases "$default_phases" '
            # Get existing phases (from top-level .phases or empty)
            (.phases // {}) as $existing_phases |

            # Merge: existing phases override defaults
            ($default_phases + $existing_phases) as $raw_merged |

            # Ensure all phases have required fields with sensible defaults
            ($raw_merged | to_entries | map(
                .key as $slug |
                .value |= (
                    # Add missing required fields
                    .status = (.status // "pending") |
                    .order = (.order // 999) |
                    .name = (.name // $slug) |
                    .startedAt = (.startedAt // null) |
                    .completedAt = (.completedAt // null)
                )
            ) | from_entries) as $merged_phases |

            # Convert project string to object with merged phases
            (if (.project | type) == "string" then
                .project = {
                    "name": .project,
                    "currentPhase": (.focus.currentPhase // null),
                    "phases": $merged_phases
                }
            else . end) |

            # Remove top-level .phases (now in .project.phases)
            del(.phases)
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

    # Update checksum after structural changes
    local new_checksum
    new_checksum=$(jq -c '.tasks' "$file" | sha256sum | cut -c1-16)
    local checksum_updated
    checksum_updated=$(jq --arg cs "$new_checksum" '._meta.checksum = $cs' "$file") || {
        echo "WARNING: Failed to update checksum" >&2
    }
    if [[ -n "$checksum_updated" ]]; then
        save_json "$file" "$checksum_updated" || {
            echo "WARNING: Failed to save checksum update" >&2
        }
    fi

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

# Migration from 2.3.0 to 2.4.0 for todo.json
# Relaxes notes maxLength constraint from 500 to 5000 characters
# No data transformation needed - just version bump
migrate_todo_to_2_4_0() {
    local file="$1"

    echo "  Updating schema version for notes maxLength increase..."

    # Simple version bump - no data transformation needed
    local updated_content
    updated_content=$(jq '
        .version = "2.4.0" |
        ._meta.schemaVersion = "2.4.0"
    ' "$file") || {
        echo "ERROR: Failed to update version fields" >&2
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

    echo "  Schema version updated to 2.4.0 (notes maxLength: 500 → 5000)"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        log_migration "$file" "todo" "2.3.0" "2.4.0"
    fi

    return 0
}

# Migration from 2.4.0 to 2.5.0 for todo.json
# Adds position field to tasks for explicit ordering (T805)
# Position is auto-assigned by createdAt order within each parent scope
migrate_todo_to_2_5_0() {
    local file="$1"

    echo "  Adding position field to tasks..."

    # Auto-assign positions by createdAt order within each parent scope
    local updated_content
    updated_content=$(jq '
        # Group tasks by parentId and assign positions
        def get_parent_key: if .parentId == null then "__null__" else .parentId end;

        # First pass: build index of positions by parent
        (reduce .tasks[] as $t (
            {};
            . + {
                ($t | get_parent_key):
                    ((.[($t | get_parent_key)] // []) + [$t])
            }
        )) as $by_parent |

        # Second pass: sort each group by createdAt and assign positions
        (.tasks | map(
            . as $task |
            ($task | get_parent_key) as $pk |
            ($by_parent[$pk] | sort_by(.createdAt) | to_entries | map(select(.value.id == $task.id)) | .[0].key + 1) as $pos |
            $task + {
                position: (if $task.position == null then $pos else $task.position end)
            }
        )) as $updated_tasks |

        .version = "2.5.0" |
        ._meta.schemaVersion = "2.5.0" |
        .tasks = $updated_tasks
    ' "$file") || {
        echo "ERROR: Failed to add position field" >&2
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

    # Count tasks that got positions
    local task_count
    task_count=$(echo "$updated_content" | jq '[.tasks[] | select(.position != null)] | length')
    echo "  Assigned positions to $task_count tasks (by createdAt order within parent scope)"
    echo "  Schema version updated to 2.5.0"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        log_migration "$file" "todo" "2.4.0" "2.5.0"
    fi

    return 0
}

# Migration from 2.5.0 to 2.6.0 for todo.json
# Adds position and positionVersion fields to tasks (T805)
# Position is auto-assigned by createdAt order within each parent scope
migrate_todo_to_2_6_0() {
    local file="$1"

    echo "  Migrating tasks to add position ordering..."

    # Auto-assign positions by createdAt order within each parent scope
    local updated_content
    updated_content=$(jq '
        # Group tasks by parentId and assign positions
        def get_parent_key: if .parentId == null then "__null__" else .parentId end;

        # First pass: build index of positions by parent
        (reduce .tasks[] as $t (
            {};
            . + {
                ($t | get_parent_key):
                    ((.[($t | get_parent_key)] // []) + [$t])
            }
        )) as $by_parent |

        # Second pass: sort each group by createdAt and assign positions
        (.tasks | map(
            . as $task |
            ($task | get_parent_key) as $pk |
            ($by_parent[$pk] | sort_by(.createdAt) | to_entries | map(select(.value.id == $task.id)) | .[0].key + 1) as $pos |
            $task + {
                position: (if $task.position == null then $pos else $task.position end),
                positionVersion: (if $task.positionVersion == null then 0 else $task.positionVersion end)
            }
        )) as $updated_tasks |

        .version = "2.6.0" |
        ._meta.schemaVersion = "2.6.0" |
        .tasks = $updated_tasks
    ' "$file") || {
        echo "ERROR: Failed to add position fields" >&2
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

    # Count tasks that got positions
    local task_count
    task_count=$(echo "$updated_content" | jq '[.tasks[] | select(.position != null)] | length')
    echo "  Assigned positions to $task_count tasks (by createdAt order within parent scope)"
    echo "  Schema version updated to 2.6.0"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        log_migration "$file" "todo" "2.5.0" "2.6.0"
    fi

    return 0
}

# Standalone position migration function (can be called directly)
# Assigns positions to tasks without positions, preserving existing positions
# Args: $1 = file path
# Returns: 0 on success, count of migrated tasks
migrate_positions() {
    local file="${1:-${TODO_FILE:-$(pwd)/.cleo/todo.json}}"

    if [[ ! -f "$file" ]]; then
        echo "ERROR: File not found: $file" >&2
        return 1
    fi

    # Check how many tasks need positions
    local needs_position
    needs_position=$(jq '[.tasks[] | select(.position == null)] | length' "$file")

    if [[ "$needs_position" -eq 0 ]]; then
        echo "All tasks already have positions assigned"
        return 0
    fi

    echo "Migrating $needs_position tasks without positions..."

    # Create backup
    if declare -f create_safety_backup >/dev/null 2>&1; then
        create_safety_backup "$file" "position-migration"
    fi

    # Run the position migration
    migrate_todo_to_2_6_0 "$file"
}

# ============================================================================
# BACKWARD COMPATIBILITY CHECKS
# ============================================================================

# Check if file is compatible with current schema
# Uses smart semver-based migration detection
# Args: $1 = file path, $2 = file type
# Returns:
#   0 = current (no action needed)
#   1 = patch_only (just bump version, no data transformation)
#   2 = migration_needed (MINOR change requiring data transformation)
#   3 = major_upgrade (MAJOR version upgrade - can migrate with --force)
#   4 = data_newer (data is newer than schema - cannot migrate, upgrade cleo)
check_compatibility() {
    local file="$1"
    local file_type="$2"

    local current_version expected_version
    current_version=$(detect_file_version "$file")
    # Use get_schema_version_from_file for dynamic version detection
    expected_version=$(get_schema_version_from_file "$file_type") || {
        expected_version=$(get_expected_version "$file_type")
    }

    # Use the new compare_schema_versions for detailed comparison
    local comparison
    comparison=$(compare_schema_versions "$current_version" "$expected_version") || return 4

    case "$comparison" in
        equal)
            return 0  # No action needed
            ;;
        patch_only)
            return 1  # Just bump version, no data transformation
            ;;
        minor_diff)
            return 2  # Migration needed (MINOR change)
            ;;
        major_diff)
            return 3  # Major upgrade (can migrate with --force)
            ;;
        data_newer)
            return 4  # Data newer than schema (cannot migrate, upgrade cleo)
            ;;
        *)
            echo "ERROR: Unknown comparison result: $comparison" >&2
            return 4
            ;;
    esac
}

# ============================================================================
# MAIN MIGRATION INTERFACE
# ============================================================================

# Check and migrate file if needed
# Uses smart semver-based migration detection:
#   - PATCH changes: version bump only (no data transformation)
#   - MINOR changes: full migration with data transformation
#   - MAJOR changes: major upgrade (can migrate with --force in CLI)
#   - DATA_NEWER: cannot migrate, need to upgrade cleo
# Args: $1 = file path, $2 = file type
# Returns: 0 if compatible or migrated, 1 on error
ensure_compatible_version() {
    local file="$1"
    local file_type="$2"

    check_compatibility "$file" "$file_type"
    local compat_status=$?

    local current_version expected_version
    current_version=$(detect_file_version "$file")
    expected_version=$(get_schema_version_from_file "$file_type") || {
        expected_version=$(get_expected_version "$file_type")
    }

    case $compat_status in
        0)
            # Already compatible (equal versions)
            return 0
            ;;
        1)
            # PATCH-only difference - just bump version, no data transformation
            echo "Version bump: $file (v$current_version → v$expected_version)"
            echo "  PATCH change detected - no data transformation needed"

            # Create backup before version bump
            local backup_file
            backup_file=$(create_backup "$file" "pre-version-bump") || {
                echo "ERROR: Failed to create backup" >&2
                return 1
            }
            echo "  Backup created: $backup_file"

            if bump_version_only "$file" "$expected_version"; then
                echo "✓ Version bump successful"
                log_migration "$file" "$file_type" "$current_version" "$expected_version"
                return 0
            else
                echo "✗ Version bump failed" >&2
                echo "Restoring backup..." >&2
                restore_file "$backup_file" "$file" || {
                    echo "CRITICAL: Failed to restore backup!" >&2
                    echo "Manual recovery required from: $backup_file" >&2
                    return 1
                }
                return 1
            fi
            ;;
        2)
            # MINOR change - full migration with data transformation
            echo "Migration required: $file (v$current_version → v$expected_version)"
            echo "  MINOR change detected - data transformation required"

            if migrate_file "$file" "$file_type" "$current_version" "$expected_version"; then
                echo "✓ Migration successful"
                return 0
            else
                echo "✗ Migration failed" >&2
                return 1
            fi
            ;;
        3)
            # MAJOR version upgrade - can be migrated
            echo "Major upgrade required: $file (v$current_version → v$expected_version)"
            echo "  MAJOR change detected - data transformation required"

            if migrate_file "$file" "$file_type" "$current_version" "$expected_version"; then
                echo "✓ Major upgrade successful"
                return 0
            else
                echo "✗ Major upgrade failed" >&2
                return 1
            fi
            ;;
        4)
            # Data is newer than schema - cannot migrate
            echo "ERROR: Cannot migrate - data version is newer than schema" >&2
            echo "  File: $file" >&2
            echo "  Data version: $current_version" >&2
            echo "  Schema version: $expected_version" >&2
            echo "  Please upgrade cleo to a newer version" >&2
            return 1
            ;;
        *)
            echo "ERROR: Unknown compatibility status: $compat_status" >&2
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

# Alias for backward compatibility - uses atomic-write.sh primitives
# Args: $1 = file to backup, $2 = label (ignored for compatibility)
# Returns: backup file path on stdout
create_backup() {
    local file="$1"
    # $2 (label) is ignored for backward compatibility
    aw_create_backup "$file"
}

# Alias for backward compatibility
# Args: $1 = backup file, $2 = target file
restore_file() {
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
    jq -nc --argjson canonical "$canonical" --argjson actual "$actual" '
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
    jq -nc \
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

    # Recalculate checksum after structural changes (T314)
    local new_checksum
    new_checksum=$(echo "$updated_content" | jq -c '.tasks' | sha256sum | cut -c1-16)
    updated_content=$(echo "$updated_content" | jq --arg checksum "$new_checksum" '
        ._meta.checksum = $checksum
    ')

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
        "$claude_dir/config.json:config"
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
        expected_version=$(get_schema_version_from_file "$file_type") || {
            expected_version=$(get_expected_version "$file_type")
        }

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

        # Return codes: 0=current, 1=patch, 2=minor, 3=major, 4=data_newer
        case $status in
            0)
                echo "✓ $file_type: v$current_version (current)"
                ;;
            1)
                echo "↑ $file_type: v$current_version → v$expected_version (patch update)"
                ;;
            2)
                echo "⚠ $file_type: v$current_version → v$expected_version (migration needed)$needs_v2_2_migration"
                ;;
            3)
                echo "⚡ $file_type: v$current_version → v$expected_version (major upgrade - use --force)"
                ;;
            4)
                echo "✗ $file_type: v$current_version (newer than schema v$expected_version - upgrade cleo)"
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
