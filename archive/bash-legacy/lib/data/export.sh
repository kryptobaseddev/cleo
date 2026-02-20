#!/usr/bin/env bash
# export.sh - Export package generation library for cleo system
#
# LAYER: 3 (Business Logic)
# DEPENDENCIES: validation.sh, file-ops.sh, platform-compat.sh, exit-codes.sh
# PROVIDES: calculate_export_checksum, verify_export_checksum, finalize_export_package,
#           validate_export_package, get_project_name, build_meta_object,
#           build_id_map_entry, build_relationship_graph, export_single_task

#=== SOURCE GUARD ================================================
[[ -n "${_EXPORT_SH_LOADED:-}" ]] && return 0
declare -r _EXPORT_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

# Determine library directory
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source required libraries
if [[ -f "$_LIB_DIR/core/platform-compat.sh" ]]; then
    # shellcheck source=lib/core/platform-compat.sh
    source "$_LIB_DIR/core/platform-compat.sh"
else
    echo "ERROR: Cannot find platform-compat.sh in $_LIB_DIR" >&2
    exit 1
fi

if [[ -f "$_LIB_DIR/validation/validation.sh" ]]; then
    # shellcheck source=lib/validation/validation.sh
    source "$_LIB_DIR/validation/validation.sh"
fi

# ============================================================================
# CHECKSUM CALCULATION
# ============================================================================

# Calculate SHA-256 checksum for export package integrity verification
#
# Uses canonical JSON representation (sorted keys, no whitespace) to ensure
# deterministic checksum calculation. Checksums are calculated on the tasks
# array only, not the full package, to allow metadata updates without breaking
# verification.
#
# Arguments:
#   $1 - JSON string containing tasks array
# Outputs:
#   16-character hexadecimal checksum to stdout
# Returns:
#   0 on success, 1 on error
# Example:
#   checksum=$(calculate_export_checksum "$tasks_json")
#   # Output: a1b2c3d4e5f60708
calculate_export_checksum() {
    local tasks_json="$1"

    # Validate input
    if [[ -z "$tasks_json" ]]; then
        echo "ERROR: No tasks JSON provided for checksum calculation" >&2
        return 1
    fi

    # Validate JSON syntax
    if ! echo "$tasks_json" | jq empty 2>/dev/null; then
        echo "ERROR: Invalid JSON provided for checksum calculation" >&2
        return 1
    fi

    # Generate canonical JSON (sorted keys, compact format)
    # -c = compact output (no whitespace)
    # -S = sort keys (deterministic ordering)
    local tasks_canonical
    if ! tasks_canonical=$(echo "$tasks_json" | jq -cS '.'); then
        echo "ERROR: Failed to canonicalize tasks JSON" >&2
        return 1
    fi

    # Calculate SHA-256 hash and truncate to 16 characters
    # Using echo -n to avoid trailing newline
    local checksum
    if ! checksum=$(echo -n "$tasks_canonical" | sha256sum | cut -c1-16); then
        echo "ERROR: Failed to calculate SHA-256 checksum" >&2
        return 1
    fi

    # Validate checksum format (16 hex chars)
    if [[ ! "$checksum" =~ ^[a-f0-9]{16}$ ]]; then
        echo "ERROR: Invalid checksum format: $checksum (expected 16 hex chars)" >&2
        return 1
    fi

    echo "$checksum"
    return 0
}

export -f calculate_export_checksum

# ============================================================================
# CHECKSUM VERIFICATION
# ============================================================================

# Verify export package checksum integrity
#
# Reads the stored checksum from _meta.checksum and recalculates the checksum
# from the tasks array. If they match, the package is valid and unmodified.
#
# Arguments:
#   $1 - Path to export package file (.cleo-export.json)
# Returns:
#   0 if checksum valid, 1 if invalid or missing
# Example:
#   if verify_export_checksum "auth-epic.cleo-export.json"; then
#     echo "Package integrity verified"
#   fi
verify_export_checksum() {
    local export_file="$1"

    # Validate file exists
    if [[ ! -f "$export_file" ]]; then
        echo "ERROR: Export file not found: $export_file" >&2
        return 1
    fi

    # Validate JSON syntax
    if ! jq empty "$export_file" 2>/dev/null; then
        echo "ERROR: Invalid JSON in export file: $export_file" >&2
        return 1
    fi

    # Extract stored checksum from metadata
    local stored_checksum
    stored_checksum=$(jq -r '._meta.checksum // empty' "$export_file")

    if [[ -z "$stored_checksum" ]]; then
        echo "ERROR: No checksum found in export package metadata" >&2
        echo "  file: $export_file" >&2
        echo "  field: _meta.checksum" >&2
        return 1
    fi

    # Validate stored checksum format
    if [[ ! "$stored_checksum" =~ ^[a-f0-9]{16}$ ]]; then
        echo "ERROR: Invalid stored checksum format: $stored_checksum" >&2
        echo "  expected: 16 hexadecimal characters" >&2
        return 1
    fi

    # Extract tasks array for recalculation
    local tasks_json
    tasks_json=$(jq -c '.tasks' "$export_file")

    if [[ -z "$tasks_json" || "$tasks_json" == "null" ]]; then
        echo "ERROR: No tasks array found in export package" >&2
        return 1
    fi

    # Recalculate checksum from tasks array
    local calculated_checksum
    if ! calculated_checksum=$(calculate_export_checksum "$tasks_json"); then
        echo "ERROR: Failed to recalculate checksum" >&2
        return 1
    fi

    # Compare checksums
    if [[ "$stored_checksum" != "$calculated_checksum" ]]; then
        echo "ERROR: Checksum verification failed" >&2
        echo "  file: $export_file" >&2
        echo "  stored:     $stored_checksum" >&2
        echo "  calculated: $calculated_checksum" >&2
        echo "  status: PACKAGE MODIFIED OR CORRUPTED" >&2
        return 1
    fi

    # Checksums match - package is valid
    return 0
}

export -f verify_export_checksum

# ============================================================================
# EXPORT PACKAGE FINALIZATION
# ============================================================================

# Finalize export package by adding checksum to metadata
#
# Takes a partial export package (with _meta and tasks) and calculates the
# checksum from the tasks array. The checksum is inserted into _meta.checksum
# and the complete package is returned.
#
# This function should be called as the final step before writing the export
# package to disk.
#
# Arguments:
#   $1 - JSON string containing partial export package (must have tasks array)
# Outputs:
#   Complete export package JSON with checksum added to stdout
# Returns:
#   0 on success, 1 on error
# Example:
#   final_package=$(finalize_export_package "$partial_package")
#   echo "$final_package" > auth-epic.cleo-export.json
finalize_export_package() {
    local package_json="$1"

    # Validate input
    if [[ -z "$package_json" ]]; then
        echo "ERROR: No package JSON provided for finalization" >&2
        return 1
    fi

    # Validate JSON syntax
    if ! echo "$package_json" | jq empty 2>/dev/null; then
        echo "ERROR: Invalid JSON provided for package finalization" >&2
        return 1
    fi

    # Validate required fields exist
    if ! echo "$package_json" | jq -e '._meta' >/dev/null 2>&1; then
        echo "ERROR: Package missing _meta field" >&2
        return 1
    fi

    if ! echo "$package_json" | jq -e '.tasks' >/dev/null 2>&1; then
        echo "ERROR: Package missing tasks array" >&2
        return 1
    fi

    # Extract tasks array for checksum calculation
    local tasks_json
    tasks_json=$(echo "$package_json" | jq -c '.tasks')

    # Calculate checksum
    local checksum
    if ! checksum=$(calculate_export_checksum "$tasks_json"); then
        echo "ERROR: Failed to calculate checksum during package finalization" >&2
        return 1
    fi

    # Insert checksum into _meta.checksum
    local finalized_package
    if ! finalized_package=$(echo "$package_json" | jq \
        --arg checksum "$checksum" \
        '._meta.checksum = $checksum'); then
        echo "ERROR: Failed to insert checksum into package metadata" >&2
        return 1
    fi

    # Output finalized package
    echo "$finalized_package"
    return 0
}

export -f finalize_export_package

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# Validate export package structure (without importing)
#
# Performs basic validation of export package format:
#   - JSON syntax
#   - Required top-level fields (_meta, selection, tasks)
#   - Checksum integrity
#   - Metadata field validation
#
# Arguments:
#   $1 - Path to export package file
# Returns:
#   0 if valid, 1 if validation fails
# Example:
#   if validate_export_package "package.cleo-export.json"; then
#     echo "Package is valid"
#   fi
validate_export_package() {
    local export_file="$1"

    # Check file exists
    if [[ ! -f "$export_file" ]]; then
        echo "ERROR: Export file not found: $export_file" >&2
        return 1
    fi

    # Validate JSON syntax
    if ! jq empty "$export_file" 2>/dev/null; then
        echo "ERROR: Invalid JSON syntax in export file" >&2
        return 1
    fi

    # Check required top-level fields
    local missing_fields=()

    if ! jq -e '._meta' "$export_file" >/dev/null 2>&1; then
        missing_fields+=("_meta")
    fi

    if ! jq -e '.selection' "$export_file" >/dev/null 2>&1; then
        missing_fields+=("selection")
    fi

    if ! jq -e '.tasks' "$export_file" >/dev/null 2>&1; then
        missing_fields+=("tasks")
    fi

    if [[ ${#missing_fields[@]} -gt 0 ]]; then
        echo "ERROR: Export package missing required fields:" >&2
        printf '  - %s\n' "${missing_fields[@]}" >&2
        return 1
    fi

    # Validate _meta.format
    local format
    format=$(jq -r '._meta.format // empty' "$export_file")
    if [[ "$format" != "cleo-export" ]]; then
        echo "ERROR: Invalid or missing _meta.format (expected 'cleo-export', got '$format')" >&2
        return 1
    fi

    # Validate _meta.version format (semver)
    local version
    version=$(jq -r '._meta.version // empty' "$export_file")
    if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "ERROR: Invalid _meta.version format (expected semver, got '$version')" >&2
        return 1
    fi

    # Validate _meta.taskCount matches tasks array length
    local task_count actual_count
    task_count=$(jq -r '._meta.taskCount // 0' "$export_file")
    actual_count=$(jq '.tasks | length' "$export_file")
    if [[ "$task_count" != "$actual_count" ]]; then
        echo "ERROR: Task count mismatch (_meta.taskCount=$task_count, actual=$actual_count)" >&2
        return 1
    fi

    # Verify checksum integrity
    if ! verify_export_checksum "$export_file"; then
        # Error message already printed by verify_export_checksum
        return 1
    fi

    return 0
}

export -f validate_export_package

# ============================================================================
# EXPORT PACKAGE BUILDING
# ============================================================================

# Source exit codes if not already loaded
if [[ -f "$_LIB_DIR/core/exit-codes.sh" ]] && [[ -z "${_EXIT_CODES_SH_LOADED:-}" ]]; then
    # shellcheck source=lib/core/exit-codes.sh
    source "$_LIB_DIR/core/exit-codes.sh"
fi

# Constants for export format
readonly EXPORT_FORMAT_VERSION="1.0.0"
readonly EXPORT_SCHEMA="https://cleo-dev.com/schemas/v1/export-package.schema.json"

# Default file paths
TODO_FILE="${TODO_FILE:-.cleo/todo.json}"

# Get CLEO version from VERSION file (fail loudly if missing)
if [[ -f "${CLEO_HOME:-$HOME/.cleo}/VERSION" ]]; then
    CLEO_VERSION="$(cat "${CLEO_HOME:-$HOME/.cleo}/VERSION" | tr -d '[:space:]')"
elif [[ -n "${CLEO_VERSION:-}" ]]; then
    # Already set from lib/core/version.sh
    :
else
    echo "ERROR: CLEO_VERSION not set and VERSION file not found" >&2
    exit "${EXIT_FILE_READ_ERROR:-3}"
fi

#######################################
# Get project name from todo.json
# Globals:
#   TODO_FILE
# Arguments:
#   None
# Outputs:
#   Project name to stdout, or "unknown" if not found
# Returns:
#   0 on success
#######################################
get_project_name() {
    local project_name
    project_name=$(jq -r '.project.name // "unknown"' "$TODO_FILE" 2>/dev/null || echo "unknown")
    echo "$project_name"
}

#######################################
# Build metadata object for export package
# Globals:
#   EXPORT_FORMAT_VERSION, CLEO_VERSION, TODO_FILE
# Arguments:
#   $1 - export_mode (single, subtree, filter, etc.)
#   $2 - task_count (number of tasks being exported)
#   $3 - project_name
# Outputs:
#   JSON metadata object to stdout
# Returns:
#   0 on success
#######################################
build_meta_object() {
    local export_mode="$1"
    local task_count="$2"
    local project_name="$3"

    # Get next available ID from todo.json
    local next_id
    next_id=$(jq -r '._meta.nextId // 1' "$TODO_FILE" 2>/dev/null || echo "1")

    # Get current timestamp in ISO 8601 format
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Checksum placeholder (will be replaced by finalize_export_package)
    local checksum="placeholder0000"

    jq -n \
        --arg format "cleo-export" \
        --arg version "$EXPORT_FORMAT_VERSION" \
        --arg exportedAt "$timestamp" \
        --arg project "$project_name" \
        --arg cleo_version "$CLEO_VERSION" \
        --argjson nextId "$next_id" \
        --arg checksum "$checksum" \
        --argjson taskCount "$task_count" \
        --arg exportMode "$export_mode" \
        '{
            format: $format,
            version: $version,
            exportedAt: $exportedAt,
            source: {
                project: $project,
                cleo_version: $cleo_version,
                nextId: $nextId
            },
            checksum: $checksum,
            taskCount: $taskCount,
            exportMode: $exportMode
        }'
}

#######################################
# Build ID map entry for a single task
# Arguments:
#   $1 - task_json (full task object as JSON string)
# Outputs:
#   JSON object with task summary to stdout
# Returns:
#   0 on success
#######################################
build_id_map_entry() {
    local task_json="$1"

    echo "$task_json" | jq '{
        type: (.type // "task"),
        title: .title,
        status: (.status // "pending"),
        parentId: (.parentId // null),
        depends: (.depends // [])
    }'
}

#######################################
# Build relationship graph for tasks
# Arguments:
#   $1 - tasks_json (array of task objects as JSON string)
# Outputs:
#   JSON relationship graph object to stdout
# Returns:
#   0 on success
#######################################
build_relationship_graph() {
    local tasks_json="$1"

    # Validate input is array
    if ! echo "$tasks_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
        echo '{"hierarchy": {}, "dependencies": {}, "roots": []}' >&2
        return 1
    fi

    # Build the relationship graph using jq
    echo "$tasks_json" | jq -c '
        # Create a set of all task IDs in the export for reference checks
        (map(.id) | unique) as $exported_ids |

        # Build hierarchy map (parent -> [children])
        (
            group_by(.parentId) |
            map(
                select(.[0].parentId != null and (.[0].parentId | IN($exported_ids[]))) |
                {
                    key: .[0].parentId,
                    value: map(.id)
                }
            ) |
            from_entries
        ) as $hierarchy |

        # Build dependencies map (task -> [deps])
        (
            map(
                select(.depends != null and (.depends | type == "array") and (.depends | length > 0)) |
                {
                    id: .id,
                    deps: [.depends[] | select(. | IN($exported_ids[]))]
                } |
                select(.deps | length > 0)
            ) |
            map({key: .id, value: .deps}) |
            from_entries
        ) as $dependencies |

        # Build roots array (tasks with no parent in export AND no deps in export)
        (
            map(
                select(
                    # No parent, OR parent not in export
                    (.parentId == null or (.parentId | IN($exported_ids[]) | not)) and
                    # No dependencies, OR all dependencies outside export
                    (.depends == null or (.depends | type != "array") or (.depends | length == 0) or ([.depends[] | select(. | IN($exported_ids[]))] | length == 0))
                ) |
                .id
            )
        ) as $roots |

        # Return final graph
        {
            hierarchy: $hierarchy,
            dependencies: $dependencies,
            roots: $roots
        }
    '
}

#######################################
# Export a single task by ID (no children)
# Globals:
#   TODO_FILE, EXPORT_SCHEMA
# Arguments:
#   $1 - task_id (e.g., "T001")
#   $2 - output_file (optional, defaults to stdout)
# Outputs:
#   Export package JSON to file or stdout
# Returns:
#   0 on success
#   EXIT_NOT_FOUND if task doesn't exist
#   EXIT_INVALID_INPUT if task ID format invalid
#   EXIT_FILE_ERROR on file operation failure
#######################################
export_single_task() {
    local task_id="$1"
    local output_file="${2:-}"

    # Validate task ID format
    if ! [[ "$task_id" =~ ^T[0-9]{3,}$ ]]; then
        echo "ERROR: Invalid task ID format: $task_id" >&2
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Check if task exists
    if ! jq -e --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TODO_FILE" >/dev/null 2>&1; then
        echo "ERROR: Task $task_id not found in $TODO_FILE" >&2
        return "${EXIT_NOT_FOUND:-4}"
    fi

    # Get project name
    local project_name
    project_name=$(get_project_name)

    # Extract task
    local task_json
    task_json=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TODO_FILE")

    # Build idMap entry
    local id_map_entry
    id_map_entry=$(build_id_map_entry "$task_json")

    # Build metadata (without real checksum yet)
    local meta
    meta=$(build_meta_object "single" 1 "$project_name")

    # Build selection object
    local selection
    selection=$(jq -n \
        --arg mode "single" \
        --arg taskId "$task_id" \
        '{
            mode: $mode,
            rootTaskIds: [$taskId],
            includeChildren: false,
            includeDeps: false
        }')

    # Build relationship graph
    local tasks_array
    tasks_array=$(echo "$task_json" | jq -s '.')
    local relationship_graph
    relationship_graph=$(build_relationship_graph "$tasks_array")

    # Build partial export package (without final checksum)
    local partial_package
    partial_package=$(jq -n \
        --arg schema "$EXPORT_SCHEMA" \
        --argjson meta "$meta" \
        --argjson selection "$selection" \
        --arg taskId "$task_id" \
        --argjson idMapEntry "$id_map_entry" \
        --argjson task "$task_json" \
        --argjson relationshipGraph "$relationship_graph" \
        '{
            "$schema": $schema,
            _meta: $meta,
            selection: $selection,
            idMap: {
                ($taskId): $idMapEntry
            },
            tasks: [$task],
            relationshipGraph: $relationshipGraph
        }')

    # Finalize package with real checksum
    local export_package
    export_package=$(finalize_export_package "$partial_package")
    if [[ $? -ne 0 ]]; then
        echo "ERROR: Failed to finalize export package" >&2
        return "${EXIT_GENERAL_ERROR:-1}"
    fi

    # Output to file or stdout
    if [[ -n "$output_file" ]]; then
        echo "$export_package" | jq '.' > "$output_file"
        if [[ $? -ne 0 ]]; then
            echo "ERROR: Failed to write export package to $output_file" >&2
            return "${EXIT_FILE_ERROR:-3}"
        fi
    else
        echo "$export_package" | jq '.'
    fi

    return 0
}

export -f get_project_name
export -f build_meta_object
export -f build_id_map_entry
export -f build_relationship_graph
export -f export_single_task


# ============================================================================
# INTERACTIVE TASK SELECTION (T1295)
# ============================================================================

# interactive_select_tasks - Interactive task selection UI
#
# Presents interactive interface for task selection using fzf if available,
# falling back to numbered list with manual input otherwise.
#
# Arguments:
#   $1 - Path to todo.json file
# Outputs:
#   Space-separated task IDs to stdout
# Returns:
#   0 on success, 1 on error or no selection
# Example:
#   selected=$(interactive_select_tasks ".cleo/todo.json")
#   # Output: "T001 T003 T005"
interactive_select_tasks() {
    local todo_file="$1"
    
    # Validate file exists
    if [[ ! -f "$todo_file" ]]; then
        echo "ERROR: Todo file not found: $todo_file" >&2
        return 1
    fi
    
    # Extract all tasks for selection
    local tasks_json
    tasks_json=$(jq -r '.tasks[] | "\(.id)|\(.title)|\(.status)|\(.priority // "medium")|\(.phase // "none")"' "$todo_file" 2>/dev/null)
    
    if [[ -z "$tasks_json" ]]; then
        echo "WARNING: No tasks available for selection" >&2
        return 0
    fi
    
    # Check if fzf is available
    if command -v fzf &>/dev/null; then
        # FZF MODE: Multi-select with preview
        local selected_lines
        selected_lines=$(echo "$tasks_json" | fzf \
            --multi \
            --delimiter='|' \
            --with-nth=1,2 \
            --preview='echo "ID: {1}\nTitle: {2}\nStatus: {3}\nPriority: {4}\nPhase: {5}"' \
            --preview-window=right:40% \
            --header='Select tasks (TAB to multi-select, ENTER to confirm)' \
            --prompt='Tasks> ')
        
        if [[ -z "$selected_lines" ]]; then
            echo "INFO: No tasks selected" >&2
            return 0
        fi
        
        # Extract task IDs (first column)
        local selected_ids
        selected_ids=$(echo "$selected_lines" | cut -d'|' -f1 | tr '\n' ' ' | sed 's/ $//')
        echo "$selected_ids"
        return 0
    else
        # FALLBACK MODE: Numbered list with comma-separated input
        echo "Available tasks:" >&2
        echo "" >&2
        
        local -a task_array=()
        local idx=1
        
        while IFS='|' read -r id title status priority phase; do
            printf "%3d) %-10s %-50s [%s/%s/%s]\n" "$idx" "$id" "${title:0:50}" "$status" "$priority" "$phase" >&2
            task_array+=("$id")
            ((idx++))
        done <<< "$tasks_json"
        
        echo "" >&2
        echo "Enter task numbers (comma-separated, e.g., 1,3,5): " >&2
        read -r user_input
        
        if [[ -z "$user_input" ]]; then
            echo "INFO: No tasks selected" >&2
            return 0
        fi
        
        # Parse comma-separated input
        local selected_ids=""
        IFS=',' read -ra indices <<< "$user_input"
        
        for num in "${indices[@]}"; do
            num=$(echo "$num" | xargs)  # Trim whitespace
            
            if ! [[ "$num" =~ ^[0-9]+$ ]]; then
                echo "WARNING: Skipping invalid input: $num" >&2
                continue
            fi
            
            local array_idx=$((num - 1))
            if [[ $array_idx -lt 0 || $array_idx -ge ${#task_array[@]} ]]; then
                echo "WARNING: Number $num out of range (1-${#task_array[@]})" >&2
                continue
            fi
            
            selected_ids="$selected_ids ${task_array[$array_idx]}"
        done
        
        selected_ids=$(echo "$selected_ids" | xargs)  # Trim leading/trailing spaces
        
        if [[ -z "$selected_ids" ]]; then
            echo "INFO: No valid tasks selected" >&2
            return 0
        fi
        
        echo "$selected_ids"
        return 0
    fi
}

export -f interactive_select_tasks

# ============================================================================
# MAIN (for testing)
# ============================================================================

# If script is executed directly (not sourced), run tests
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "Testing export checksum functions..."
    echo "======================================="

    # Test 1: Calculate checksum for sample tasks
    echo "Test 1: Calculate checksum for sample tasks"
    echo "(Skipping export tests - function moved to separate test suite)"
fi

# ============================================================================
# DEPENDENCY EXPANSION (T1298)
# ============================================================================

# expand_dependencies - Recursively include all task dependencies
#
# Performs BFS traversal of task dependency graph to include all transitive
# dependencies. Detects and handles circular dependencies.
#
# Arguments:
#   $1 - Space-separated task IDs to expand
#   $2 - Path to todo.json file
# Outputs:
#   Space-separated task IDs (original + all dependencies) to stdout
# Returns:
#   0 on success, 1 on error
# Example:
#   all_ids=$(expand_dependencies "T001 T005" ".cleo/todo.json")
#   # Output: "T001 T005 T002 T003" (if T001/T005 depend on T002, T003)
expand_dependencies() {
    local initial_ids="$1"
    local todo_file="$2"
    
    # Validate file exists
    if [[ ! -f "$todo_file" ]]; then
        echo "ERROR: Todo file not found: $todo_file" >&2
        return 1
    fi
    
    # Initialize tracking
    local -A visited=()
    local -a result=()
    local -a queue=()
    
    # Add initial IDs to queue
    for id in $initial_ids; do
        queue+=("$id")
    done
    
    # BFS traversal
    while [[ ${#queue[@]} -gt 0 ]]; do
        # Pop from queue
        local current_id="${queue[0]}"
        queue=("${queue[@]:1}")
        
        # Skip if already visited
        if [[ -n "${visited[$current_id]:-}" ]]; then
            continue
        fi
        
        # Mark as visited
        visited[$current_id]=1
        
        # Check if task exists in todo.json
        local task_exists
        task_exists=$(jq --arg id "$current_id" '[.tasks[] | select(.id == $id)] | length' "$todo_file" 2>/dev/null)
        
        if [[ "$task_exists" -eq 0 ]]; then
            # Task not in project, skip
            continue
        fi
        
        # Add to result
        result+=("$current_id")
        
        # Get dependencies
        local deps
        deps=$(jq -r --arg id "$current_id" '.tasks[] | select(.id == $id) | .depends // [] | .[]' "$todo_file" 2>/dev/null)
        
        # Add dependencies to queue
        for dep in $deps; do
            if [[ -z "${visited[$dep]:-}" ]]; then
                queue+=("$dep")
            fi
        done
    done
    
    # Output result as space-separated list
    echo "${result[@]}"
    return 0
}

export -f expand_dependencies

# ============================================================================
# ID MAP AND RELATIONSHIP GRAPH GENERATION (T1273, T1275)
# build_id_map - Generate idMap object from tasks for quick reference
#
# Creates a quick-reference map of task IDs to key properties without
# parsing full task objects. Used for relationship validation during import.
#
# Arguments:
#   $1 - JSON array of tasks to export
# Outputs:
#   JSON object mapping task IDs to {type, title, status, parentId, depends}
# Returns:
#   0 on success, 1 on error
build_id_map() {
    local tasks_json="$1"

    # Validate input is array
    if ! echo "$tasks_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
        echo '{}' >&2
        return 1
    fi

    # Build ID map using jq
    echo "$tasks_json" | jq -c '
        map({
            key: .id,
            value: {
                type: (.type // "task"),
                title: .title,
                status: (.status // "pending"),
                parentId: (.parentId // null),
                depends: (.depends // [])
            }
        }) |
        from_entries
    '
}

export -f build_id_map

# build_relationship_graph - Generate relationshipGraph object from tasks
#
# Generates a relationship graph containing:
# - hierarchy: Map of parent IDs to their children arrays
# - dependencies: Map of task IDs to their dependency arrays
# - roots: Array of task IDs with no parent in the export
#
# This graph enables efficient import ordering via topological sort.
#
# Arguments:
#   $1 - JSON array of tasks to export
# Outputs:
#   JSON object with relationshipGraph structure
# Returns:
#   0 on success, 1 on error
build_relationship_graph() {
    local tasks_json="$1"

    # Validate input is array
    if ! echo "$tasks_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
        echo '{"hierarchy": {}, "dependencies": {}, "roots": []}' >&2
        return 1
    fi

    # Build the relationship graph using jq
    echo "$tasks_json" | jq -c '
        # Create set of all task IDs in the export
        (map(.id) | unique) as $exported_ids |

        # Build hierarchy map (parent -> [children])
        (
            group_by(.parentId) |
            map(
                select(.[0].parentId != null and (.[0].parentId | IN($exported_ids[]))) |
                {
                    key: .[0].parentId,
                    value: map(.id)
                }
            ) |
            from_entries
        ) as $hierarchy |

        # Build dependencies map (task -> [deps])
        (
            map(
                select(.depends != null and (.depends | type == "array") and (.depends | length > 0)) |
                {
                    id: .id,
                    deps: [.depends[] | select(. | IN($exported_ids[]))]
                } |
                select(.deps | length > 0)
            ) |
            map({key: .id, value: .deps}) |
            from_entries
        ) as $dependencies |

        # Build roots array (tasks with no parent in export)
        (
            map(
                select((.parentId == null or (.parentId | IN($exported_ids[]) | not)))
                | .id
            )
        ) as $roots |

        # Return final graph
        {
            hierarchy: $hierarchy,
            dependencies: $dependencies,
            roots: $roots
        }
    '
}

export -f build_relationship_graph

# ============================================================================
# METADATA HELPERS (T1273)
# ============================================================================

# get_cleo_version - Get current cleo version
get_cleo_version() {
    local version_file="${_LIB_DIR}/../VERSION"
    if [[ -f "$version_file" ]]; then
        cat "$version_file"
    else
        echo "0.48.0"
    fi
}

export -f get_cleo_version

# get_project_name - Extract project name from todo.json
get_project_name() {
    local todo_file="$1"
    local project_name
    project_name=$(jq -r '.project.name // "unknown-project"' "$todo_file" 2>/dev/null)
    echo "${project_name:-unknown-project}"
}

export -f get_project_name

# get_next_id - Get next available task ID from todo.json
get_next_id() {
    local todo_file="$1"
    local max_id
    max_id=$(jq -r '[.tasks[].id | ltrimstr("T") | tonumber] | max // 0' "$todo_file" 2>/dev/null)
    echo "$((max_id + 1))"
}

export -f get_next_id

# ============================================================================
# EXPORT PACKAGE CONSTRUCTION (T1273, T1274, T1275)
# ============================================================================

# build_export_package - Construct complete export package
#
# Assembles all components according to export-package.schema.json
#
# Arguments:
#   $1 - Export mode (single|subtree|filter|interactive|full)
#   $2 - Root task IDs (JSON array)
#   $3 - Tasks JSON array
#   $4 - Todo file path
#   $5 - Include children flag (true|false)
#   $6 - (Optional) Filters JSON object
# Outputs:
#   Complete export package JSON
# Returns:
#   0 on success, 1 on error
build_export_package() {
    local export_mode="$1"
    local root_task_ids="$2"
    local tasks_json="$3"
    local todo_file="$4"
    local include_children="$5"
    local filters="${6:-null}"

    # Constants
    local schema_url="https://cleo-dev.com/schemas/v1/export-package.schema.json"
    local format_version="1.0.0"

    # Get metadata
    local cleo_ver project_name next_id exported_at task_count
    cleo_ver=$(get_cleo_version)
    project_name=$(get_project_name "$todo_file")
    next_id=$(get_next_id "$todo_file")
    exported_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    task_count=$(echo "$tasks_json" | jq 'length')

    # Build components
    local id_map relationship_graph
    id_map=$(build_id_map "$tasks_json") || return 1
    relationship_graph=$(build_relationship_graph "$tasks_json") || return 1

    # Build package without checksum
    local partial
    partial=$(jq -nc \
        --arg schema "$schema_url" \
        --arg ver "$format_version" \
        --arg at "$exported_at" \
        --arg proj "$project_name" \
        --arg cv "$cleo_ver" \
        --argjson nid "$next_id" \
        --argjson tc "$task_count" \
        --arg mode "$export_mode" \
        --argjson roots "$root_task_ids" \
        --arg ic "$include_children" \
        --argjson filt "$filters" \
        --argjson im "$id_map" \
        --argjson tasks "$tasks_json" \
        --argjson rg "$relationship_graph" \
        '{
            "$schema": $schema,
            "_meta": {
                "format": "cleo-export",
                "version": $ver,
                "exportedAt": $at,
                "source": {
                    "project": $proj,
                    "cleo_version": $cv,
                    "nextId": $nid
                },
                "taskCount": $tc,
                "exportMode": $mode
            },
            "selection": {
                "mode": $mode,
                "rootTaskIds": $roots,
                "includeChildren": ($ic == "true"),
                "filters": $filt
            },
            "idMap": $im,
            "tasks": $tasks,
            "relationshipGraph": $rg
        }')

    # Finalize with checksum
    finalize_export_package "$partial"
}

export -f build_export_package

# ============================================================================
# SINGLE TASK EXPORT (T1274)
# ============================================================================

# export_single - Export a single task without children
export_single() {
    local task_id="$1"
    local todo_file="$2"

    # Get task
    local task
    task=$(jq -c --arg id "$task_id" '.tasks[] | select(.id == $id)' "$todo_file" 2>/dev/null)

    [[ -z "$task" ]] && { echo "ERROR: Task $task_id not found" >&2; return 1; }

    # Build arrays
    local tasks_array root_ids
    tasks_array=$(jq -nc --argjson t "$task" '[$t]')
    root_ids=$(jq -nc --arg id "$task_id" '[$id]')

    # Build package
    build_export_package "single" "$root_ids" "$tasks_array" "$todo_file" "false" "null"
}

export -f export_single

# ============================================================================
# SUBTREE EXPORT (T1275)
# ============================================================================

# get_all_descendants - Recursively collect all descendant task IDs
#
# Arguments:
#   $1 - Task ID (ancestor)
#   $2 - Path to todo.json
# Outputs:
#   Space-separated list of all descendant IDs
get_all_descendants() {
    local task_id="$1"
    local todo_file="$2"

    # Use get_descendants from hierarchy.sh if available
    if declare -f get_descendants >/dev/null 2>&1; then
        get_descendants "$task_id" "$todo_file"
        return 0
    fi

    # Fallback implementation
    local descendants=""
    local children
    children=$(jq -r --arg pid "$task_id" '.tasks[] | select(.parentId == $pid) | .id' "$todo_file" 2>/dev/null | tr '\n' ' ')

    for child in $children; do
        descendants="$descendants $child"
        local grandchildren
        grandchildren=$(get_all_descendants "$child" "$todo_file")
        [[ -n "$grandchildren" ]] && descendants="$descendants $grandchildren"
    done

    echo "${descendants# }"
}

export -f get_all_descendants

# export_subtree - Export task and all its descendants
#
# Implements subtree export mode per IMPORT-EXPORT-SPEC.md
#
# Arguments:
#   $1 - Root task ID to export
#   $2 - Path to todo.json
# Outputs:
#   Export package JSON
# Returns:
#   0 on success, 1 on error
export_subtree() {
    local root_task_id="$1"
    local todo_file="$2"

    # Verify root exists
    local root
    root=$(jq -c --arg id "$root_task_id" '.tasks[] | select(.id == $id)' "$todo_file" 2>/dev/null)

    [[ -z "$root" ]] && { echo "ERROR: Task $root_task_id not found" >&2; return 1; }

    # Get all descendants recursively
    local descendants
    descendants=$(get_all_descendants "$root_task_id" "$todo_file")

    # Build complete task list
    local all_ids="$root_task_id${descendants:+ }$descendants"

    # Extract all tasks as JSON array
    local tasks_array="[]"
    for tid in $all_ids; do
        local task
        task=$(jq -c --arg id "$tid" '.tasks[] | select(.id == $id)' "$todo_file" 2>/dev/null)
        [[ -n "$task" ]] && tasks_array=$(echo "$tasks_array" | jq --argjson t "$task" '. + [$t]')
    done

    # Build root IDs array
    local root_ids
    root_ids=$(jq -nc --arg id "$root_task_id" '[$id]')

    # Build package with includeChildren=true
    build_export_package "subtree" "$root_ids" "$tasks_array" "$todo_file" "true" "null"
}

export -f export_subtree
