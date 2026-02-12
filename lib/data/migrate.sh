#!/usr/bin/env bash
# Schema version migration system for cleo
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: logging.sh (transitively provides atomic-write.sh)
# PROVIDES: check_schema_version, run_migrations, get_default_phases,
#           parse_version, compare_versions, get_schema_version_from_file,
#           compare_schema_versions, bump_version_only, check_compatibility,
#           init_migrations_journal, get_migration_checksum,
#           record_migration_application, validate_applied_checksums,
#           SCHEMA_DIR

#=== SOURCE GUARD ================================================
[[ -n "${_MIGRATE_SH_LOADED:-}" ]] && return 0
declare -r _MIGRATE_SH_LOADED=1

set -euo pipefail

# Source dependencies
# NOTE: Use _MIGRATE_LIB_DIR to avoid overwriting caller's SCRIPT_DIR
_MIGRATE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/core/logging.sh
source "$_MIGRATE_LIB_DIR/core/logging.sh"

# ============================================================================
# CONSTANTS
# ============================================================================

# Migration scripts directory
MIGRATIONS_DIR="${CLEO_HOME:-$HOME/.cleo}/migrations"

# Templates directory (source of truth for default structures)
TEMPLATES_DIR="${CLEO_HOME:-$HOME/.cleo}/templates"

# Schema directory
SCHEMA_DIR="${SCHEMA_DIR:-${CLEO_HOME:-$HOME/.cleo}/schemas}"

# ============================================================================
# INITIALIZATION FUNCTIONS
# ============================================================================

# Initialize migrations.json from template
# Creates .cleo/migrations.json if it doesn't exist
# Args: $1 = cleo directory (default: .cleo)
# Returns: 0 on success, 1 on failure
init_migrations_journal() {
    local cleo_dir="${1:-.cleo}"
    local migrations_file="$cleo_dir/migrations.json"

    # Skip if already exists
    if [[ -f "$migrations_file" ]]; then
        return 0
    fi

    # Get schema version from schema file (single source of truth)
    local schema_version
    schema_version=$(jq -r '.schemaVersion // "1.0.0"' "$SCHEMA_DIR/migrations.schema.json" 2>/dev/null || echo "1.0.0")

    # Create from template with version replacement
    if [[ -f "$TEMPLATES_DIR/migrations.template.json" ]]; then
        sed "s/{{SCHEMA_VERSION_MIGRATIONS}}/$schema_version/g" \
            "$TEMPLATES_DIR/migrations.template.json" > "$migrations_file"

        # Verify no placeholders remain
        if grep -q '{{' "$migrations_file"; then
            echo "ERROR: Placeholder replacement failed in migrations.json" >&2
            rm -f "$migrations_file"
            return 1
        fi

        # Validate JSON
        if ! jq empty "$migrations_file" 2>/dev/null; then
            echo "ERROR: Generated migrations.json is invalid JSON" >&2
            rm -f "$migrations_file"
            return 1
        fi

        return 0
    else
        echo "ERROR: Template not found: $TEMPLATES_DIR/migrations.template.json" >&2
        return 1
    fi
}

# ============================================================================
# MIGRATION RECORDING AND CHECKSUM VALIDATION
# ============================================================================

# Calculate SHA256 checksum of a migration function's source code
# Args: $1 = function name
# Returns: 64-character hex checksum
get_migration_checksum() {
    local function_name="$1"

    # Get function body using declare -f
    local function_body
    function_body=$(declare -f "$function_name" 2>/dev/null)

    if [[ -z "$function_body" ]]; then
        # Function not found, return zeros
        echo "0000000000000000000000000000000000000000000000000000000000000000"
        return 1
    fi

    # Calculate SHA256
    echo -n "$function_body" | sha256sum | cut -d' ' -f1
}

# Record a migration execution to the journal
# Args:
#   $1 = file path that was migrated
#   $2 = file type (todo|config|archive|log)
#   $3 = target version (e.g., "2.6.0")
#   $4 = previous version (e.g., "2.5.0")
#   $5 = function name (e.g., "migrate_todo_to_2_6_0")
#   $6 = status (success|failed|skipped)
#   $7 = execution time in ms (optional)
#   $8 = backup path (optional)
# Returns: 0 on success, 1 on failure
record_migration_application() {
    local file_path="$1"
    local file_type="$2"
    local version="$3"
    local previous_version="$4"
    local function_name="$5"
    local status="$6"
    local exec_time_ms="${7:-null}"
    local backup_path="${8:-null}"

    local cleo_dir
    cleo_dir=$(dirname "$file_path")
    local journal_file="$cleo_dir/migrations.json"

    # Initialize journal if needed
    init_migrations_journal "$cleo_dir" || return 1

    # Calculate checksum of migration function
    local checksum
    checksum=$(get_migration_checksum "$function_name")

    # Create entry
    local entry
    entry=$(jq -nc \
        --arg ver "$version" \
        --arg prev "$previous_version" \
        --arg ft "$file_type" \
        --arg fn "$function_name" \
        --arg cs "$checksum" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg st "$status" \
        --argjson et "$exec_time_ms" \
        --arg bp "$backup_path" \
        '{
            version: $ver,
            fileType: $ft,
            functionName: $fn,
            checksum: $cs,
            appliedAt: $ts,
            status: $st,
            previousVersion: $prev,
            executionTimeMs: $et,
            backupPath: (if $bp == "null" then null else $bp end)
        }')

    # Append to journal
    local updated_journal
    updated_journal=$(jq --argjson entry "$entry" \
        '.appliedMigrations += [$entry] | ._meta.lastChecked = now | ._meta.lastChecked |= todate' \
        "$journal_file")

    # Save atomically
    echo "$updated_journal" > "$journal_file.tmp" && mv "$journal_file.tmp" "$journal_file"
}

# Validate that applied migrations haven't been modified
# Args: $1 = cleo directory (default: .cleo)
# Returns: 0 if all valid, 1 if mismatches found
# Outputs: List of modified migrations to stderr
validate_applied_checksums() {
    local cleo_dir="${1:-.cleo}"
    local journal_file="$cleo_dir/migrations.json"

    if [[ ! -f "$journal_file" ]]; then
        return 0  # No journal = nothing to validate
    fi

    local has_errors=false

    # Read all applied migrations with checksums
    while IFS= read -r entry; do
        local fn version checksum
        fn=$(echo "$entry" | jq -r '.functionName // empty')
        version=$(echo "$entry" | jq -r '.version')
        checksum=$(echo "$entry" | jq -r '.checksum')

        # Skip entries without function names (version-only bumps)
        [[ -z "$fn" ]] && continue

        # Calculate current checksum
        local current_checksum
        current_checksum=$(get_migration_checksum "$fn")

        if [[ "$current_checksum" != "$checksum" ]]; then
            echo "WARNING: Migration $fn (v$version) has been modified!" >&2
            echo "  Expected: $checksum" >&2
            echo "  Current:  $current_checksum" >&2
            has_errors=true
        fi
    done < <(jq -c '.appliedMigrations[]' "$journal_file" 2>/dev/null)

    if $has_errors; then
        return 1
    fi
    return 0
}

# ============================================================================
# LOCAL HELPER FUNCTIONS (LAYER 2)
# ============================================================================

# save_json - Atomic JSON save using Layer 1 primitives
# This is a local implementation that doesn't require file-ops.sh
# Args: $1 = file path, $2 = JSON content (optional, reads from stdin if not provided)
# Returns: 0 on success, 1 on failure
save_json() {
    local file="$1"
    local content="${2:-}"

    # Read from stdin if no content provided (matches file-ops.sh behavior)
    [[ -z "$content" ]] && content=$(cat)

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

# Extract target version from calling function's name
# migrate_todo_to_2_6_0 -> 2.6.0
# migrate_config_to_2_4_0 -> 2.4.0
# Args: None (uses FUNCNAME[1] to get caller's function name)
# Returns: version string (e.g., "2.6.0") or "unknown" if pattern doesn't match
get_target_version_from_funcname() {
    local funcname="${FUNCNAME[1]}"
    if [[ "$funcname" =~ _to_([0-9]+)_([0-9]+)_([0-9]+)$ ]]; then
        echo "${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
    else
        echo "unknown"
    fi
}

# Get source/from version by decrementing patch version from target
# Args: $1 = target version (e.g., "2.4.0")
# Returns: from version (e.g., "2.3.0")
get_from_version() {
    local target="$1"
    if [[ "$target" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        local major="${BASH_REMATCH[1]}"
        local minor="${BASH_REMATCH[2]}"
        local patch="${BASH_REMATCH[3]}"

        # Decrement minor version
        if [[ "$minor" -gt 0 ]]; then
            echo "$major.$((minor - 1)).$patch"
        else
            # If minor is 0, we'd need to decrement major (edge case)
            echo "$((major - 1)).9.$patch"
        fi
    else
        echo "unknown"
    fi
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

    # Read schemaVersion from the schema file (single source of truth)
    if [[ -f "$schema_file" ]]; then
        local version
        version=$(jq -r '.schemaVersion // empty' "$schema_file" 2>/dev/null)
        if [[ -n "$version" && "$version" != "null" ]]; then
            echo "$version"
            return 0
        fi
    fi

    # If schema file missing or has no version, this is an error
    echo "ERROR: Schema file missing or has no schemaVersion: $schema_file" >&2
    return 1
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
        # Ensure _meta object exists before setting schemaVersion
        if ._meta == null then ._meta = {} else . end |
        ._meta.schemaVersion = $ver
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

    # Extract version from ._meta.schemaVersion (canonical location)
    local version
    version=$(jq -r '._meta.schemaVersion' "$file" 2>/dev/null)

    # If missing, check for old .version field (pre-migration files only)
    if [[ -z "$version" || "$version" == "null" ]]; then
        version=$(jq -r '.version' "$file" 2>/dev/null)

        # If still missing, try to infer from $schema field
        if [[ -z "$version" || "$version" == "null" ]]; then
            local schema_id
            schema_id=$(jq -r '."$schema" // ""' "$file" 2>/dev/null)

            # Extract version from schema ID (e.g., "claude-todo-schema-v2.1")
            if [[ "$schema_id" =~ v([0-9]+\.[0-9]+) ]]; then
                version="${BASH_REMATCH[1]}.0"
            else
                # Final fallback: assume oldest version for pre-migration files
                version="1.0.0"
            fi
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
    
    # Delegate to get_schema_version_from_file (single source of truth)
    get_schema_version_from_file "$file_type"
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

    # STRUCTURAL MIGRATION: Ensure version field format is correct
    # This should run before any version-specific migrations
    # It's idempotent, so safe to run even if already in new format
    echo "Checking version field format..."
    if ! migrate_version_field_format "$file" "$file_type"; then
        echo "WARNING: Version field format migration failed, continuing anyway..." >&2
        # Don't fail the entire migration for this - it's a best-effort fix
    fi

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

# Parse migration function name into structured data
# Supports two patterns:
#   - Semver: migrate_<type>_to_<major>_<minor>_<patch>
#   - Timestamp: migrate_<type>_<YYYYMMDDHHMMSS>_<description>
# Args: $1 = function name
# Returns: JSON object with {type, pattern, identifier, sortKey}
#   - type: file type (todo, config, etc.)
#   - pattern: "semver" or "timestamp"
#   - identifier: version string (e.g., "2.6.0") or timestamp (e.g., "20260103120000")
#   - sortKey: numeric key for sorting (e.g., "2006000" or "20260103120000")
parse_migration_identifier() {
    local func_name="$1"

    # Semver pattern: migrate_<type>_to_<major>_<minor>_<patch>
    if [[ "$func_name" =~ ^migrate_([^_]+)_to_([0-9]+)_([0-9]+)_([0-9]+)$ ]]; then
        local type="${BASH_REMATCH[1]}"
        local major="${BASH_REMATCH[2]}"
        local minor="${BASH_REMATCH[3]}"
        local patch="${BASH_REMATCH[4]}"
        local version="${major}.${minor}.${patch}"
        # Sort key: pad each component to 3 digits (e.g., 2.6.0 -> 002006000)
        local sort_key
        printf -v sort_key "%03d%03d%03d" "$major" "$minor" "$patch"

        jq -nc --arg type "$type" \
               --arg pattern "semver" \
               --arg id "$version" \
               --arg sort "$sort_key" \
               '{type: $type, pattern: $pattern, identifier: $id, sortKey: $sort}'
        return 0
    fi

    # Timestamp pattern: migrate_<type>_<YYYYMMDDHHMMSS>_<description>
    if [[ "$func_name" =~ ^migrate_([^_]+)_([0-9]{14})_(.+)$ ]]; then
        local type="${BASH_REMATCH[1]}"
        local timestamp="${BASH_REMATCH[2]}"
        local description="${BASH_REMATCH[3]}"

        jq -nc --arg type "$type" \
               --arg pattern "timestamp" \
               --arg id "$timestamp" \
               --arg sort "$timestamp" \
               --arg desc "$description" \
               '{type: $type, pattern: $pattern, identifier: $id, sortKey: $sort, description: $desc}'
        return 0
    fi

    # Unknown pattern
    return 1
}

# Discover migration versions dynamically using Bash introspection
# Searches for all migration functions and extracts version numbers/timestamps
# Supports two patterns:
#   - Semver: migrate_<type>_to_<major>_<minor>_<patch> (e.g., migrate_todo_to_2_6_0)
#   - Timestamp: migrate_<type>_<YYYYMMDDHHMMSS>_<description> (e.g., migrate_todo_20260103120000_add_field)
# Args: $1 = file_type (optional) - filter for specific file type (e.g., "todo", "config")
# Returns: sorted unique version/timestamp strings (e.g., "2.2.0 2.3.0 20260103120000")
#   - Semver migrations sorted by version number
#   - Timestamp migrations sorted by timestamp
#   - Semver migrations appear before timestamp migrations at same logical point
discover_migration_versions() {
    local file_type="${1:-}"

    # Build function name prefix
    local prefix="migrate_"
    if [[ -n "$file_type" ]]; then
        prefix="migrate_${file_type}_"
    fi

    # Collect all migration functions
    local -a all_funcs=()
    while IFS= read -r func_decl; do
        # Extract function name from "declare -f function_name"
        local func_name="${func_decl#declare -f }"

        # Filter by prefix
        if [[ "$func_name" == ${prefix}* ]]; then
            all_funcs+=("$func_name")
        fi
    done < <(declare -F)

    # Parse each function and collect structured data
    local -a parsed_migrations=()
    for func in "${all_funcs[@]}"; do
        local parsed
        if parsed=$(parse_migration_identifier "$func" 2>/dev/null); then
            # Filter by file type if specified
            if [[ -z "$file_type" ]] || [[ "$(echo "$parsed" | jq -r '.type')" == "$file_type" ]]; then
                parsed_migrations+=("$parsed")
            fi
        fi
    done

    # If no migrations found, return empty
    if [[ ${#parsed_migrations[@]} -eq 0 ]]; then
        echo ""
        return 0
    fi

    # Sort by sortKey and extract identifiers
    # This naturally gives us: semver first (smaller numeric keys), then timestamps
    # Output newline-separated for proper consumption with mapfile/head/tail
    printf '%s\n' "${parsed_migrations[@]}" | \
        jq -rs 'sort_by(.sortKey) | .[].identifier' | \
        tr -d '"'
}

# Find migration path between versions
# Args: $1 = from version, $2 = to version
# Returns: newline-separated list of intermediate versions to migrate through
find_migration_path() {
    local from="$1"
    local to="$2"

    # Use dynamic discovery instead of static array
    local -a known_versions
    mapfile -t known_versions < <(discover_migration_versions)

    # Parse versions
    local from_parts to_parts
    from_parts=$(parse_version "$from" 2>/dev/null) || from_parts="0 0 0"
    to_parts=$(parse_version "$to" 2>/dev/null) || {
        # Get highest known version as fallback
        local latest
        latest=$(discover_migration_versions | tail -1)
        to_parts=$(parse_version "$latest")
    }

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

    # Get current version before migration
    local previous_version
    previous_version=$(detect_file_version "$file")

    # Try to find and execute migration function
    local migration_func="migrate_${file_type}_to_${target_version//./_}"
    local start_time end_time exec_time_ms
    local status="success"
    local backup_path=""

    # Record start time (milliseconds since epoch)
    start_time=$(date +%s%3N)

    if declare -f "$migration_func" >/dev/null 2>&1; then
        # Custom migration function exists - execute with timing
        if "$migration_func" "$file"; then
            status="success"
        else
            status="failed"
            end_time=$(date +%s%3N)
            exec_time_ms=$((end_time - start_time))
            record_migration_application "$file" "$file_type" "$target_version" "$previous_version" \
                "$migration_func" "$status" "$exec_time_ms" "$backup_path"
            return 1
        fi
    else
        # Use generic version update
        migration_func="update_version_field"
        if update_version_field "$file" "$target_version"; then
            status="success"
        else
            status="failed"
            end_time=$(date +%s%3N)
            exec_time_ms=$((end_time - start_time))
            record_migration_application "$file" "$file_type" "$target_version" "$previous_version" \
                "$migration_func" "$status" "$exec_time_ms" "$backup_path"
            return 1
        fi
    fi

    # Record end time and calculate execution time
    end_time=$(date +%s%3N)
    exec_time_ms=$((end_time - start_time))

    # Record successful migration
    record_migration_application "$file" "$file_type" "$target_version" "$previous_version" \
        "$migration_func" "$status" "$exec_time_ms" "$backup_path"

    return 0
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
    # CRITICAL: Create _meta object if it doesn't exist
    local updated_content
    updated_content=$(jq --arg ver "$new_version" '
        .version = $ver |
        # Ensure _meta object exists before setting fields
        if ._meta == null then ._meta = {} else . end |
        ._meta.version = $ver |
        ._meta.schemaVersion = $ver
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
# STRUCTURAL MIGRATIONS
# ============================================================================

# Convert .version to ._meta.schemaVersion format
# This is a structural migration (not a version-bump migration)
# Handles three cases:
#   1. Files with only .version field → move to ._meta.schemaVersion
#   2. Files with both fields → use ._meta.schemaVersion, remove .version
#   3. Files with neither → set to oldest known version (2.1.0)
# Args: $1 = file path, $2 = file type (todo|config|archive|log)
# Returns: 0 on success, 1 on failure
migrate_version_field_format() {
    local file="$1"
    local file_type="$2"

    if [[ ! -f "$file" ]]; then
        echo "ERROR: File not found: $file" >&2
        return 1
    fi

    echo "  Migrating version field format to ._meta.schemaVersion..."

    # Detect which case we're in
    local has_version has_meta_schema_version
    has_version=$(jq -r 'has("version")' "$file" 2>/dev/null)
    has_meta_schema_version=$(jq -r '._meta.schemaVersion != null' "$file" 2>/dev/null)

    # Determine the version to use
    local version_to_use
    if [[ "$has_meta_schema_version" == "true" ]]; then
        # Case 2: Both fields exist - use ._meta.schemaVersion
        version_to_use=$(jq -r '._meta.schemaVersion' "$file")
        echo "    Found both .version and ._meta.schemaVersion - using ._meta.schemaVersion: $version_to_use"
    elif [[ "$has_version" == "true" ]]; then
        # Case 1: Only .version exists - move to ._meta.schemaVersion
        version_to_use=$(jq -r '.version' "$file")
        echo "    Found .version only - migrating to ._meta.schemaVersion: $version_to_use"
    else
        # Case 3: Neither field exists - set to oldest known version
        version_to_use=$(discover_migration_versions | head -1)
        if [[ -z "$version_to_use" ]]; then
            log_error "Cannot determine oldest migration version"
            return 1
        fi
        echo "    No version fields found - setting default version: $version_to_use"
    fi

    # Perform the migration
    local updated_content
    updated_content=$(jq --arg ver "$version_to_use" '
        # Ensure ._meta object exists
        if ._meta == null then ._meta = {} else . end |

        # Set ._meta.schemaVersion
        ._meta.schemaVersion = $ver |

        # Keep top-level .version for backward compatibility (some code still reads it)
        # But ._meta.schemaVersion is now canonical
        .version = $ver
    ' "$file") || {
        echo "ERROR: Failed to migrate version field format" >&2
        return 1
    }

    # Validate the result
    if ! echo "$updated_content" | jq empty 2>/dev/null; then
        echo "ERROR: Migration produced invalid JSON" >&2
        return 1
    fi

    # Atomic save using save_json
    save_json "$file" "$updated_content" || {
        echo "ERROR: Failed to save migrated file" >&2
        return 1
    }

    # Verify the migration
    local final_schema_version
    final_schema_version=$(jq -r '._meta.schemaVersion' "$file")
    echo "    ✓ Migration complete - ._meta.schemaVersion: $final_schema_version"

    return 0
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
# DEPRECATED: Semver pattern - use timestamp pattern for new migrations
# See docs/MIGRATION-SYSTEM.md for migration naming conventions
migrate_config_to_2_1_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

    # Add new config sections if missing
    add_field_if_missing "$file" ".session" '{"requireSessionNote":true,"warnOnNoFocus":true,"autoStartSession":true,"sessionTimeoutHours":72}' || return 1

    # Migrate field names for consistency (idempotent)
    migrate_config_field_naming "$file" || return 1

    # Update version
    update_version_field "$file" "$target_version"
}

# Migration from 2.1.0 to 2.2.0 for config.json
# Adds hierarchy configuration section with LLM-Agent-First defaults
# See CONFIG-SYSTEM-SPEC.md Appendix A.5, HIERARCHY-ENHANCEMENT-SPEC.md Part 3.2
# DEPRECATED: Semver pattern - use timestamp pattern for new migrations
# See docs/MIGRATION-SYSTEM.md for migration naming conventions
migrate_config_to_2_2_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

    # Add hierarchy section with LLM-Agent-First defaults
    # - maxSiblings: 20 (was 7, based on human cognitive limits)
    # - countDoneInLimit: false (done tasks are historical, not active context)
    # - maxActiveSiblings: 8 (aligns with TodoWrite sync limit)
    # - maxDepth: 3 (organizational, rarely needs changing)
    add_field_if_missing "$file" ".hierarchy" '{"maxSiblings":20,"maxDepth":3,"countDoneInLimit":false,"maxActiveSiblings":8}' || return 1

    # Update version
    update_version_field "$file" "$target_version"
}

# Migration from 2.4.0 to 2.5.0 for config.json
# Adds comprehensive project.status section for doctor command integration
# See DOCTOR_IMPROVEMENTS.md for details on project-level health tracking
migrate_config_to_2_5_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

    # Read current schema versions dynamically (single source of truth)
    local current_todo_version current_config_version current_archive_version current_log_version
    current_todo_version=$(get_schema_version_from_file "todo")
    current_config_version=$(get_schema_version_from_file "config")
    current_archive_version=$(get_schema_version_from_file "archive")
    current_log_version=$(get_schema_version_from_file "log")

    echo "  Adding project status tracking for doctor command..."

    # Add complete project.status section with all required fields
    add_field_if_missing "$file" ".project" '{
        "status": {
            "health": "unknown",
            "lastCheck": null,
            "schemaVersions": {
                "todo": "'"$current_todo_version"'",
                "config": "'"$current_config_version"'",
                "archive": "'"$current_archive_version"'",
                "log": "'"$current_log_version"'"
            },
            "validation": {
                "lastValidated": null,
                "passed": false,
                "errors": []
            },
            "injection": {
                "CLAUDE.md": "",
                "AGENTS.md": "",
                "GEMINI.md": ""
            }
        }
    }' || return 1

    # Update version
    update_version_field "$file" "$target_version"
}

# Migration from 2.5.0 to 2.6.0 for config.json
# Adds retention section with session lifecycle management options
# - maxSessionsInMemory: for session garbage collection (T2321)
# - autoEndActiveAfterDays: automatically end stale active sessions (T2320)
migrate_config_to_2_6_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

    echo "  Adding retention section with session lifecycle management..."

    # Add retention section with all fields including new options
    add_field_if_missing "$file" ".retention" '{
        "maxArchivedSessions": 100,
        "autoArchiveEndedAfterDays": 30,
        "autoDeleteArchivedAfterDays": 90,
        "contextStateRetentionDays": 7,
        "cleanupOnSessionEnd": true,
        "dryRunByDefault": true,
        "maxSessionsInMemory": 100,
        "autoEndActiveAfterDays": 7
    }' || return 1

    # Add autoEndActiveAfterDays if retention section exists but field is missing
    # This handles incremental upgrades where retention was added before this field
    add_field_if_missing "$file" ".retention.autoEndActiveAfterDays" "7" || return 1

    # Update version
    update_version_field "$file" "$target_version"
}

# @task T2844
# Migration to v2.10.0: Consolidate release gates configuration
# Moves validation.releaseGates and orchestrator.validation.customGates to release.gates
migrate_config_to_2_10_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

    echo "  Consolidating release gates configuration..."

    # Check if old fields exist
    local has_validation_gates has_orchestrator_gates
    has_validation_gates=$(jq 'has("validation") and .validation | has("releaseGates")' "$file" 2>/dev/null || echo "false")
    has_orchestrator_gates=$(jq 'has("orchestrator") and .orchestrator | has("validation") and .orchestrator.validation | has("customGates")' "$file" 2>/dev/null || echo "false")

    # Get gates from old locations (prefer validation.releaseGates over orchestrator.validation.customGates)
    local gates="[]"
    if [[ "$has_validation_gates" == "true" ]]; then
        gates=$(jq -c '.validation.releaseGates // []' "$file" 2>/dev/null || echo "[]")
        echo "    Found gates in validation.releaseGates"
    elif [[ "$has_orchestrator_gates" == "true" ]]; then
        gates=$(jq -c '.orchestrator.validation.customGates // []' "$file" 2>/dev/null || echo "[]")
        echo "    Found gates in orchestrator.validation.customGates"
    fi

    # Add release section with gates
    add_field_if_missing "$file" ".release" "{\"gates\": $gates}" || return 1
    echo "    Created release.gates"

    # Remove old fields (leave them for now with deprecation warnings in code)
    # Users can manually remove after confirming migration worked

    # Update version
    update_version_field "$file" "$target_version"
}


# ============================================================================
# ARCHIVE MIGRATIONS
# ============================================================================

# Migration baseline for archive.schema.json v2.4.0
# Establishes migration foundation - schema already at v2.4.0
migrate_archive_to_2_4_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)
    
    # Baseline migration - just bump version
    bump_version_only "$file" "$target_version"
}

# ============================================================================
# LOG MIGRATIONS  
# ============================================================================

# Migration baseline for log.schema.json v2.4.0
# Establishes migration foundation - schema already at v2.4.0
# Note: log schema data file is todo-log.json
migrate_log_to_2_4_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)
    
    # Baseline migration - just bump version
    bump_version_only "$file" "$target_version"
}

# ============================================================================
# SESSIONS MIGRATIONS
# ============================================================================

# Migration baseline for sessions.schema.json v1.0.0
# Establishes migration foundation - schema already at v1.0.0
migrate_sessions_to_1_0_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)
    
    # Baseline migration - just bump version
    bump_version_only "$file" "$target_version"
}
# Example: Migration from 2.0.0 to 2.1.0 for todo.json
# DEPRECATED: Semver pattern - use timestamp pattern for new migrations
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
# DEPRECATED: Semver pattern - use timestamp pattern for new migrations
# See docs/MIGRATION-SYSTEM.md for migration naming conventions
migrate_todo_to_2_2_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

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
    update_version_field "$file" "$target_version" || return 1

    # Update _meta.version to match using atomic save_json
    local meta_updated
    meta_updated=$(jq --arg ver "$target_version" '._meta.version = $ver' "$file") || {
        echo "ERROR: Failed to update _meta.version" >&2
        return 1
    }

    save_json "$file" "$meta_updated"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        # Extract source version from function name pattern (migrate_X_to_Y -> previous version)
        local from_version="2.1.0"  # This is safe - it's the literal "from" version in the function name
        log_migration "$file" "todo" "$from_version" "$target_version"
    fi

    return 0
}

# Migration from 2.2.0 to 2.3.0 for todo.json
# Adds hierarchy fields: type, parentId, size
# Migrates label conventions to structured fields
# DEPRECATED: Semver pattern - use timestamp pattern for new migrations
# See docs/MIGRATION-SYSTEM.md for migration naming conventions
migrate_todo_to_2_3_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

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
        .version = $ver |
        ._meta.version = $ver
    ' --arg ver "$target_version" "$file") || {
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
        local from_version="2.2.0"  # Literal "from" version from function name
        log_migration "$file" "todo" "$from_version" "$target_version"
    fi

    return 0
}

# Migration from 2.3.0 to 2.4.0 for todo.json
# Relaxes notes maxLength constraint from 500 to 5000 characters
# No data transformation needed - just version bump
# DEPRECATED: Semver pattern - use timestamp pattern for new migrations
# See docs/MIGRATION-SYSTEM.md for migration naming conventions
migrate_todo_to_2_4_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)
    local from_version
    from_version=$(get_from_version "$target_version")

    echo "  Updating schema version for notes maxLength increase..."

    # Simple version bump - no data transformation needed
    local updated_content
    updated_content=$(jq --arg ver "$target_version" '
        .version = $ver |
        ._meta.schemaVersion = $ver
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

    echo "  Schema version updated to $target_version (notes maxLength: 500 → 5000)"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        log_migration "$file" "todo" "$from_version" "$target_version"
    fi

    return 0
}

# Migration from 2.4.0 to 2.5.0 for todo.json
# Adds position field to tasks for explicit ordering (T805)
# Position is auto-assigned by createdAt order within each parent scope
# DEPRECATED: Semver pattern - use timestamp pattern for new migrations
# See docs/MIGRATION-SYSTEM.md for migration naming conventions
migrate_todo_to_2_5_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)
    local from_version
    from_version=$(get_from_version "$target_version")

    echo "  Adding position field to tasks..."

    # Auto-assign positions by createdAt order within each parent scope
    local updated_content
    updated_content=$(jq --arg ver "$target_version" '
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

        .version = $ver |
        ._meta.schemaVersion = $ver |
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
    task_count=$(echo "$updated_content" | jq --arg ver "$target_version" '[.tasks[] | select(.position != null)] | length')
    echo "  Assigned positions to $task_count tasks (by createdAt order within parent scope)"
    echo "  Schema version updated to $target_version"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then

        log_migration "$file" "todo" "$from_version" "$target_version"
    fi

    return 0
}

# Migration from 2.5.0 to 2.6.0 for todo.json
# Adds position and positionVersion fields to tasks (T805)
# Position is auto-assigned by createdAt order within each parent scope
# DEPRECATED: Semver pattern - use timestamp pattern for new migrations
# See docs/MIGRATION-SYSTEM.md for migration naming conventions
migrate_todo_to_2_6_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

    echo "  Migrating tasks to add position ordering..."
    local from_version
    from_version=$(get_from_version "$target_version")

    # Auto-assign positions by createdAt order within each parent scope
    local updated_content
    updated_content=$(jq --arg ver "$target_version" '
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

        .version = $ver |
        ._meta.schemaVersion = $ver |
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
    echo "  Schema version updated to $target_version"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        local from_version="2.5.0"  # Literal "from" version from function name
        log_migration "$file" "todo" "$from_version" "$target_version"
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

# Migrate todo.json to v2.6.1 (sessionNote maxLength 1000 → 2500)
# Args: $1 = file path
# Returns: 0 on success, 1 on failure
migrate_todo_to_2_6_1() {
    local file="$1"
    local target_version="2.6.1"

    echo "  Migrating to v2.6.1: Increased sessionNote maxLength (1000 → 2500)"
    echo "  This is a backward compatible change - no data transformation needed"

    # Version-only migration (relaxed constraint, existing data remains valid)
    bump_version_only "$file" "$target_version"
}

# Migrate todo.json to v2.7.0 (noAutoComplete field)
# Args: $1 = file path
# Returns: 0 on success, 1 on failure
migrate_todo_to_2_7_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

    echo "  Migrating to v2.7.0: Adding noAutoComplete field..."

    # Add noAutoComplete field (null by default) to tasks
    local updated_content
    updated_content=$(jq --arg ver "$target_version" '
        # Add noAutoComplete field to tasks if missing
        .tasks = [.tasks[] |
            if has("noAutoComplete") | not then
                . + {noAutoComplete: null}
            else . end
        ] |

        # Update schema version
        .version = $ver |
        ._meta.schemaVersion = $ver
    ' "$file") || {
        echo "ERROR: Failed to add noAutoComplete field" >&2
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

    local task_count
    task_count=$(echo "$updated_content" | jq '[.tasks[] | select(has("noAutoComplete"))] | length')
    echo "  Added noAutoComplete field to $task_count tasks"
    echo "  Schema version updated to $target_version"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        local from_version="2.6.1"
        log_migration "$file" "todo" "$from_version" "$target_version"
    fi

    return 0
}

# Migrate todo.json to v2.8.0 (updatedAt, relates, origin, releases, sessionNotes)
# Args: $1 = file path
# Returns: 0 on success, 1 on failure
migrate_todo_to_2_8_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

    echo "  Migrating to v2.8.0: Adding metadata and roadmap integration fields..."

    local updated_content
    updated_content=$(jq --arg ver "$target_version" '
        # 1. Backfill updatedAt with createdAt for tasks
        .tasks = [.tasks[] |
            if (.updatedAt == null) then
                .updatedAt = .createdAt
            else . end
        ] |

        # 2. Initialize empty relates arrays for tasks
        .tasks = [.tasks[] |
            if (.relates == null) then
                .relates = []
            else . end
        ] |

        # 3. Initialize origin as null for tasks without it
        .tasks = [.tasks[] |
            if (has("origin") | not) then
                . + {origin: null}
            else . end
        ] |

        # 4. Initialize releases array at project level if missing
        .project = (
            if (.project.releases == null) then
                .project + {releases: []}
            else .project end
        ) |

        # 5. Convert sessionNote to sessionNotes array
        .focus = (
            if (.focus.sessionNote != null and .focus.sessionNote != "") then
                .focus + {
                    sessionNotes: [{
                        note: .focus.sessionNote,
                        timestamp: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                        conversationId: null,
                        agent: "migration"
                    }]
                }
            elif (.focus.sessionNotes == null) then
                .focus + {sessionNotes: []}
            else .focus end
        ) |

        # Update schema version
        .version = $ver |
        ._meta.schemaVersion = $ver
    ' "$file") || {
        echo "ERROR: Failed to migrate to v2.8.0" >&2
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

    # Report migration results
    local task_count updated_count relates_count origin_count
    task_count=$(echo "$updated_content" | jq '.tasks | length')
    updated_count=$(echo "$updated_content" | jq '[.tasks[] | select(.updatedAt != null)] | length')
    relates_count=$(echo "$updated_content" | jq '[.tasks[] | select(.relates != null)] | length')
    origin_count=$(echo "$updated_content" | jq '[.tasks[] | select(has("origin"))] | length')

    echo "  Backfilled updatedAt for $updated_count tasks"
    echo "  Initialized relates arrays for $relates_count tasks"
    echo "  Added origin field to $origin_count tasks"
    echo "  Initialized project.releases array"
    local notes_count
    notes_count=$(echo "$updated_content" | jq '.focus.sessionNotes | length')
    if [[ "$notes_count" -gt 0 ]]; then
        echo "  Converted sessionNote to sessionNotes array ($notes_count entries)"
    else
        echo "  Initialized empty sessionNotes array"
    fi
    echo "  Schema version updated to $target_version"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        local from_version="2.7.0"
        log_migration "$file" "todo" "$from_version" "$target_version"
    fi

    return 0
}

# ============================================================================

migrate_todo_to_2_9_0() {
    local file="$1"
    local target_version
    target_version=$(get_target_version_from_funcname)

    echo "  Migrating to v2.9.0: Adding generation counter for cache invalidation..."

    local updated_content
    updated_content=$(jq --arg ver "$target_version" '
        # Initialize generation counter in _meta if missing
        ._meta.generation = (._meta.generation // 0) |

        # Update schema version
        .version = $ver |
        ._meta.schemaVersion = $ver
    ' "$file") || {
        echo "ERROR: Failed to migrate to v2.9.0" >&2
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

    # Report migration results
    local generation_value
    generation_value=$(echo "$updated_content" | jq '._meta.generation')
    echo "  Initialized _meta.generation to $generation_value"
    echo "  Schema version updated to $target_version"

    # Log migration if log_migration is available
    if declare -f log_migration >/dev/null 2>&1; then
        local from_version="2.8.0"
        log_migration "$file" "todo" "$from_version" "$target_version"
    fi

    return 0
}

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
            # But still check if ._meta.schemaVersion needs to be added
            local has_schema_version
            has_schema_version=$(jq -r '._meta.schemaVersion // "null"' "$file" 2>/dev/null)
            if [[ "$has_schema_version" == "null" ]]; then
                echo "Adding missing _meta.schemaVersion: $file"
                if bump_version_only "$file" "$expected_version"; then
                    echo "✓ Schema version field added"
                    return 0
                else
                    echo "✗ Failed to add schema version field" >&2
                    return 1
                fi
            fi
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

    # Get current schema version from schema file
    local schema_version
    schema_version=$(get_schema_version_from_file "todo")

    # Get canonical phases
    local canonical_phases
    canonical_phases=$(get_canonical_phases)

    # Build the repair jq filter
    # This is a complex but idempotent transformation
    local updated_content
    updated_content=$(jq --argjson canonical "$canonical_phases" --arg ver "$schema_version" '
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
        ._meta.schemaVersion = $ver |
        ._meta.configVersion = (._meta.configVersion // "2.1.0") |
        (if ._meta.checksum == null then ._meta.checksum = "pending" else . end) |

        # Ensure version field
        .version = $ver |

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
# DIRECTORY MIGRATIONS
# ============================================================================

# Migrate research-outputs directory to agent-outputs
# Part of Cross-Agent Communication Protocol Unification (T2348)
#
# This function renames the legacy directory structure:
#   claudedocs/research-outputs/ → claudedocs/agent-outputs/
#
# Also updates paths in MANIFEST.jsonl to reflect the new location.
#
# Args: $1 = project directory (default: current directory)
# Returns:
#   0   = Migration completed successfully
#   100 = Already migrated (skip)
#   1   = Error during migration
migrate_agent_outputs_dir() {
    local project_dir="${1:-.}"
    local old_dir="${project_dir}/claudedocs/research-outputs"
    local new_dir="${project_dir}/claudedocs/agent-outputs"
    local cleo_dir="${project_dir}/.cleo"
    local migration_log="${cleo_dir}/.migration.log"
    local manifest_file

    # =========================================================================
    # 1. Check if migration is needed
    # =========================================================================

    # If old dir doesn't exist, nothing to migrate
    if [[ ! -d "$old_dir" ]]; then
        # Check if new dir exists (already migrated)
        if [[ -d "$new_dir" ]]; then
            echo "INFO: Already migrated to agent-outputs/" >&2
            return 100  # EXIT_ALREADY_EXISTS - skip
        fi
        # Neither exists - nothing to do
        echo "INFO: No research-outputs directory found to migrate" >&2
        return 100
    fi

    # If new dir already exists, handle collision
    if [[ -d "$new_dir" ]]; then
        echo "WARNING: Both research-outputs/ and agent-outputs/ exist" >&2
        echo "  Old: $old_dir" >&2
        echo "  New: $new_dir" >&2
        echo "  Manual intervention required to resolve" >&2
        return 1
    fi

    echo "Migrating research-outputs/ to agent-outputs/..."

    # =========================================================================
    # 2. Create safety backup
    # =========================================================================

    local backup_dir="${cleo_dir}/backups/migration"
    local backup_name="research-outputs_$(date +%Y%m%d_%H%M%S)"
    local backup_path="${backup_dir}/${backup_name}"

    mkdir -p "$backup_dir" || {
        echo "ERROR: Failed to create backup directory: $backup_dir" >&2
        return 1
    }

    # Copy the directory for backup (not move, to be safe)
    if ! cp -r "$old_dir" "$backup_path"; then
        echo "ERROR: Failed to create backup at: $backup_path" >&2
        return 1
    fi
    echo "  Backup created: $backup_path"

    # =========================================================================
    # 3. Atomic rename (mv is atomic on same filesystem)
    # =========================================================================

    if ! mv "$old_dir" "$new_dir"; then
        echo "ERROR: Failed to rename directory" >&2
        echo "  Source: $old_dir" >&2
        echo "  Target: $new_dir" >&2
        return 1
    fi
    echo "  Renamed: research-outputs/ → agent-outputs/"

    # =========================================================================
    # 4. Update MANIFEST.jsonl file paths
    # =========================================================================

    manifest_file="${new_dir}/MANIFEST.jsonl"
    if [[ -f "$manifest_file" ]]; then
        local temp_manifest
        temp_manifest=$(mktemp)

        # Update file paths from research-outputs to agent-outputs
        # The 'file' field in manifest entries may contain the directory path
        if sed 's|research-outputs/|agent-outputs/|g' "$manifest_file" > "$temp_manifest"; then
            if mv "$temp_manifest" "$manifest_file"; then
                echo "  Updated MANIFEST.jsonl paths"
            else
                echo "WARNING: Failed to update MANIFEST.jsonl" >&2
                rm -f "$temp_manifest"
            fi
        else
            echo "WARNING: Failed to process MANIFEST.jsonl" >&2
            rm -f "$temp_manifest"
        fi
    fi

    # =========================================================================
    # 5. Update .gitignore if present
    # =========================================================================

    local gitignore="${project_dir}/.gitignore"
    if [[ -f "$gitignore" ]]; then
        local temp_gitignore
        temp_gitignore=$(mktemp)

        # Update any references to research-outputs
        if sed 's|claudedocs/research-outputs|claudedocs/agent-outputs|g' "$gitignore" > "$temp_gitignore"; then
            if ! diff -q "$gitignore" "$temp_gitignore" &>/dev/null; then
                if mv "$temp_gitignore" "$gitignore"; then
                    echo "  Updated .gitignore references"
                else
                    rm -f "$temp_gitignore"
                fi
            else
                rm -f "$temp_gitignore"
            fi
        else
            rm -f "$temp_gitignore"
        fi
    fi

    # =========================================================================
    # 6. Update config.json (research.outputDir → agentOutputs.directory)
    # =========================================================================

    local config_file="${cleo_dir}/config.json"
    if [[ -f "$config_file" ]]; then
        # Check if config has old research.outputDir setting
        if grep -q '"research"' "$config_file" 2>/dev/null; then
            local temp_config
            temp_config=$(mktemp)

            # Use jq to migrate config: remove research section, add agentOutputs
            if command -v jq &>/dev/null; then
                if jq 'del(.research) | .agentOutputs = {
                    "directory": "claudedocs/agent-outputs",
                    "manifestFile": "MANIFEST.jsonl",
                    "archiveDir": "archive",
                    "archiveDays": 30
                }' "$config_file" > "$temp_config" 2>/dev/null; then
                    if mv "$temp_config" "$config_file"; then
                        echo "  Updated config.json (research → agentOutputs)"
                    else
                        rm -f "$temp_config"
                        echo "WARNING: Failed to update config.json" >&2
                    fi
                else
                    rm -f "$temp_config"
                    echo "WARNING: Failed to process config.json with jq" >&2
                fi
            else
                # Fallback without jq: just warn
                echo "WARNING: config.json has deprecated 'research' section" >&2
                echo "  Run: cleo config set agentOutputs.directory claudedocs/agent-outputs" >&2
            fi
        fi
    fi

    # =========================================================================
    # 7. Log migration
    # =========================================================================

    mkdir -p "$(dirname "$migration_log")" 2>/dev/null || true
    echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") DIRECTORY_MIGRATION: research-outputs → agent-outputs (backup: $backup_path)" >> "$migration_log"

    echo "✓ Migration complete: research-outputs/ → agent-outputs/"
    return 0
}

# Check if agent-outputs migration is needed
# Args: $1 = project directory (default: current directory)
# Returns:
#   0 = Migration needed
#   1 = Already migrated or nothing to migrate
check_agent_outputs_migration_needed() {
    local project_dir="${1:-.}"
    local old_dir="${project_dir}/claudedocs/research-outputs"
    local new_dir="${project_dir}/claudedocs/agent-outputs"

    # Migration needed if old dir exists and new dir doesn't
    [[ -d "$old_dir" && ! -d "$new_dir" ]]
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
