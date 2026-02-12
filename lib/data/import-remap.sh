#!/usr/bin/env bash
# import-remap.sh - ID remapping logic for import system
#
# LAYER: 3 (Business Logic)
# DEPENDENCIES: validation.sh, file-ops.sh, exit-codes.sh
# PROVIDES: generate_remap_table, get_next_available_id, validate_remap_table,
#           remap_task_id, get_remapped_id

#=== SOURCE GUARD ================================================
[[ -n "${_IMPORT_REMAP_SH_LOADED:-}" ]] && return 0
declare -r _IMPORT_REMAP_SH_LOADED=1

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

# Source exit codes
if [[ -f "$_LIB_DIR/core/exit-codes.sh" ]]; then
    # shellcheck source=lib/core/exit-codes.sh
    source "$_LIB_DIR/core/exit-codes.sh"
else
    echo "ERROR: Cannot find exit-codes.sh in $_LIB_DIR" >&2
    exit 1
fi

# ============================================================================
# GLOBAL DATA STRUCTURES
# ============================================================================

# ID Remap Table: Maps source task IDs to new target task IDs
# Example: ID_REMAP["T001"]="T031"
#
# This associative array is populated by generate_remap_table() and used
# throughout the import process to translate all ID references from the
# source project to the target project.
declare -gA ID_REMAP

# Reverse Remap Table: Maps new target IDs back to source IDs
# Example: REVERSE_REMAP["T031"]="T001"
#
# Used for conflict detection - ensures no two source IDs map to the same
# target ID. Also useful for debugging and audit trails.
declare -gA REVERSE_REMAP

# ============================================================================
# NEXT AVAILABLE ID CALCULATION
# ============================================================================

# Get the next available task ID in the target project
#
# Finds the maximum existing task ID in todo.json and returns max+1.
# If todo.json is empty or has no tasks, returns 1.
#
# This function handles ID gaps correctly - it uses the maximum ID, not
# the count of tasks. For example, if tasks are [T001, T005, T010], the
# next available ID is T011, not T004.
#
# Arguments:
#   $1 - Path to target project's todo.json
# Outputs:
#   Next available ID number (integer) to stdout
# Returns:
#   0 on success
#   EXIT_NOT_FOUND (4) if todo.json doesn't exist
#   EXIT_VALIDATION_ERROR (6) if todo.json is invalid JSON
# Example:
#   next_id=$(get_next_available_id ".cleo/todo.json")
#   # If max ID is T030, returns: 31
get_next_available_id() {
    local todo_file="$1"

    # Validate todo.json exists
    if [[ ! -f "$todo_file" ]]; then
        echo "ERROR: Target project file not found: $todo_file" >&2
        echo "  Hint: Initialize project with 'cleo init' first" >&2
        return "$EXIT_NOT_FOUND"
    fi

    # Validate JSON syntax
    if ! jq empty "$todo_file" 2>/dev/null; then
        echo "ERROR: Invalid JSON in target project file: $todo_file" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Find maximum existing ID
    # - Extract all task IDs from tasks array
    # - Strip "T" prefix to get numeric part
    # - Convert to numbers
    # - Find max (returns 0 if no tasks)
    local max_id
    max_id=$(jq -r '
        [.tasks[]?.id // empty | ltrimstr("T") | tonumber] | max // 0
    ' "$todo_file" 2>/dev/null)

    # Validate max_id is a number
    if ! [[ "$max_id" =~ ^[0-9]+$ ]]; then
        echo "ERROR: Failed to calculate max ID (got: '$max_id')" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Return next available ID (max + 1)
    echo "$((max_id + 1))"
    return 0
}

export -f get_next_available_id

# ============================================================================
# ID REMAP TABLE GENERATION
# ============================================================================

# Generate ID remap table for import operation
#
# Builds the ID_REMAP and REVERSE_REMAP associative arrays by:
# 1. Finding the next available ID in the target project
# 2. Extracting all source task IDs from the export package
# 3. Assigning sequential new IDs starting from next available
# 4. Populating both forward and reverse lookup tables
#
# The mapping is deterministic - same inputs always produce the same mappings.
# This enables dry-run previews to show exact IDs that will be used.
#
# Algorithm (per IMPORT-EXPORT-ALGORITHMS.md Section 1.2):
#   1. max_id = find_max_id(todo.json)
#   2. next_id = max_id + 1
#   3. source_ids = extract_ids(export_package.tasks[])
#   4. FOR EACH source_id:
#        new_id = format("T%03d", next_id)
#        ID_REMAP[source_id] = new_id
#        REVERSE_REMAP[new_id] = source_id
#        next_id++
#
# Arguments:
#   $1 - Path to export package file (.cleo-export.json)
#   $2 - Path to target project's todo.json
# Outputs:
#   Error messages to stderr if validation fails
# Returns:
#   0 on success
#   EXIT_NOT_FOUND (4) if files don't exist
#   EXIT_VALIDATION_ERROR (6) if validation fails
# Side Effects:
#   Populates global ID_REMAP and REVERSE_REMAP arrays
# Example:
#   generate_remap_table "auth-epic.cleo-export.json" ".cleo/todo.json"
#   echo "T001 maps to: ${ID_REMAP[T001]}"  # T001 maps to: T031
generate_remap_table() {
    local export_file="$1"
    local todo_file="$2"

    # ========================================================================
    # Input Validation
    # ========================================================================

    # Validate export package exists
    if [[ ! -f "$export_file" ]]; then
        echo "ERROR: Export package not found: $export_file" >&2
        return "$EXIT_NOT_FOUND"
    fi

    # Validate export package JSON syntax
    if ! jq empty "$export_file" 2>/dev/null; then
        echo "ERROR: Invalid JSON in export package: $export_file" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate export package has required structure
    if ! jq -e '.tasks' "$export_file" >/dev/null 2>&1; then
        echo "ERROR: Export package missing 'tasks' array" >&2
        echo "  file: $export_file" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate target project exists (get_next_available_id handles this)
    local next_id
    if ! next_id=$(get_next_available_id "$todo_file"); then
        # Error already printed by get_next_available_id
        return $?
    fi

    # ========================================================================
    # Extract Source IDs
    # ========================================================================

    # Extract all task IDs from export package in order
    # Using -r (raw output) to get plain strings without quotes
    local source_ids
    source_ids=$(jq -r '.tasks[].id' "$export_file" 2>/dev/null)

    # Validate we got at least one ID
    if [[ -z "$source_ids" ]]; then
        echo "ERROR: No tasks found in export package" >&2
        echo "  file: $export_file" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # ========================================================================
    # Clear Previous Mappings (idempotent behavior)
    # ========================================================================

    # Clear any existing mappings to ensure clean state
    # This allows the function to be called multiple times safely
    unset ID_REMAP
    unset REVERSE_REMAP
    declare -gA ID_REMAP
    declare -gA REVERSE_REMAP

    # ========================================================================
    # Build Remap Tables
    # ========================================================================

    # Assign sequential IDs starting from next_available_id
    local current_id="$next_id"

    while IFS= read -r source_id; do
        # Skip empty lines
        [[ -z "$source_id" ]] && continue

        # Validate source ID format (T followed by digits)
        if ! [[ "$source_id" =~ ^T[0-9]{3,}$ ]]; then
            echo "ERROR: Invalid task ID format in export: $source_id" >&2
            echo "  Expected format: T001, T002, etc." >&2
            return "$EXIT_VALIDATION_ERROR"
        fi

        # Format new ID with zero padding (T001, T002, ..., T999, T1000, etc.)
        local new_id
        new_id=$(printf "T%03d" "$current_id")

        # Populate forward mapping (source -> new)
        ID_REMAP["$source_id"]="$new_id"

        # Populate reverse mapping (new -> source)
        REVERSE_REMAP["$new_id"]="$source_id"

        # Increment for next ID
        ((current_id++))
    done <<< "$source_ids"

    # ========================================================================
    # Validation
    # ========================================================================

    # Verify we created at least one mapping
    if [[ ${#ID_REMAP[@]} -eq 0 ]]; then
        echo "ERROR: No ID mappings were created" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Success - mappings are ready to use
    return 0
}

export -f generate_remap_table

# ============================================================================
# REMAP TABLE VALIDATION
# ============================================================================

# Validate that remap table is complete and consistent
#
# Verifies that:
# 1. ID_REMAP and REVERSE_REMAP are populated
# 2. All source IDs from export package have mappings
# 3. No collisions exist (one-to-one mapping)
# 4. All new IDs are in valid format
#
# This function should be called after generate_remap_table() to ensure
# the mapping tables are ready for use.
#
# Arguments:
#   $1 - Path to export package file (for verification)
# Outputs:
#   Error messages to stderr if validation fails
# Returns:
#   0 if remap table is valid
#   EXIT_VALIDATION_ERROR (6) if validation fails
# Example:
#   generate_remap_table "$export_file" "$todo_file"
#   if validate_remap_table "$export_file"; then
#     echo "Remap table is ready"
#   fi
validate_remap_table() {
    local export_file="$1"

    # ========================================================================
    # Check Tables Exist and Are Populated
    # ========================================================================

    # Check ID_REMAP exists and is an associative array
    if ! declare -p ID_REMAP >/dev/null 2>&1; then
        echo "ERROR: ID_REMAP not initialized" >&2
        echo "  Hint: Call generate_remap_table() first" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Check REVERSE_REMAP exists
    if ! declare -p REVERSE_REMAP >/dev/null 2>&1; then
        echo "ERROR: REVERSE_REMAP not initialized" >&2
        echo "  Hint: Call generate_remap_table() first" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Check tables are not empty
    if [[ ${#ID_REMAP[@]} -eq 0 ]]; then
        echo "ERROR: ID_REMAP is empty" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    if [[ ${#REVERSE_REMAP[@]} -eq 0 ]]; then
        echo "ERROR: REVERSE_REMAP is empty" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # ========================================================================
    # Verify Completeness (all source IDs have mappings)
    # ========================================================================

    # Extract all source IDs from export package
    local source_ids
    source_ids=$(jq -r '.tasks[].id' "$export_file" 2>/dev/null)

    local missing_mappings=()

    while IFS= read -r source_id; do
        [[ -z "$source_id" ]] && continue

        # Check if source ID has a mapping
        if [[ -z "${ID_REMAP[$source_id]:-}" ]]; then
            missing_mappings+=("$source_id")
        fi
    done <<< "$source_ids"

    # Report any missing mappings
    if [[ ${#missing_mappings[@]} -gt 0 ]]; then
        echo "ERROR: Incomplete remap table - missing mappings for:" >&2
        printf '  - %s\n' "${missing_mappings[@]}" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # ========================================================================
    # Verify Consistency (forward and reverse mappings match)
    # ========================================================================

    local inconsistent_mappings=()

    for source_id in "${!ID_REMAP[@]}"; do
        local new_id="${ID_REMAP[$source_id]}"

        # Check reverse mapping exists
        if [[ -z "${REVERSE_REMAP[$new_id]:-}" ]]; then
            inconsistent_mappings+=("$source_id -> $new_id (no reverse mapping)")
            continue
        fi

        # Check reverse mapping points back to source
        if [[ "${REVERSE_REMAP[$new_id]}" != "$source_id" ]]; then
            inconsistent_mappings+=("$source_id -> $new_id -> ${REVERSE_REMAP[$new_id]} (mismatch)")
        fi
    done

    # Report any inconsistencies
    if [[ ${#inconsistent_mappings[@]} -gt 0 ]]; then
        echo "ERROR: Inconsistent remap table:" >&2
        printf '  - %s\n' "${inconsistent_mappings[@]}" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # ========================================================================
    # Verify ID Format (all new IDs are valid)
    # ========================================================================

    local invalid_ids=()

    for new_id in "${!REVERSE_REMAP[@]}"; do
        # Check new ID format (T followed by 3+ digits)
        if ! [[ "$new_id" =~ ^T[0-9]{3,}$ ]]; then
            invalid_ids+=("$new_id (invalid format)")
        fi
    done

    # Report any invalid IDs
    if [[ ${#invalid_ids[@]} -gt 0 ]]; then
        echo "ERROR: Invalid new task IDs:" >&2
        printf '  - %s\n' "${invalid_ids[@]}" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # All validations passed
    return 0
}

export -f validate_remap_table

# ============================================================================
# REMAP LOOKUP FUNCTIONS
# ============================================================================

# Get the remapped ID for a source task ID
#
# Looks up the new ID for a given source ID in the ID_REMAP table.
# Returns empty string if no mapping exists.
#
# Arguments:
#   $1 - Source task ID (e.g., "T001")
# Outputs:
#   New task ID to stdout, or empty string if not found
# Returns:
#   0 if mapping found, 1 if not found
# Example:
#   new_id=$(get_remapped_id "T001")
#   if [[ -n "$new_id" ]]; then
#     echo "T001 remaps to $new_id"
#   fi
get_remapped_id() {
    local source_id="$1"

    # Check if ID_REMAP exists
    if ! declare -p ID_REMAP >/dev/null 2>&1; then
        return 1
    fi

    # Check if mapping exists
    if [[ -z "${ID_REMAP[$source_id]:-}" ]]; then
        return 1
    fi

    # Return mapped ID
    echo "${ID_REMAP[$source_id]}"
    return 0
}

export -f get_remapped_id

# ============================================================================
# REMAP APPLICATION FUNCTIONS
# ============================================================================

# Remap a single task ID reference
#
# Attempts to remap a task ID using the ID_REMAP table. If the ID is not
# in the remap table, returns the original ID unchanged (useful for
# dependencies that exist in target project).
#
# Arguments:
#   $1 - Task ID to remap
# Outputs:
#   Remapped ID to stdout
# Returns:
#   0 always (safe fallback to original ID)
# Example:
#   remapped=$(remap_task_id "T001")
#   # If T001 -> T031 mapping exists, returns "T031"
#   # If no mapping exists, returns "T001"
remap_task_id() {
    local task_id="$1"

    # Handle null/empty
    if [[ -z "$task_id" || "$task_id" == "null" ]]; then
        echo "null"
        return 0
    fi

    # Try to get remapped ID
    local remapped_id
    if remapped_id=$(get_remapped_id "$task_id" 2>/dev/null); then
        echo "$remapped_id"
    else
        # No mapping - return original (may exist in target)
        echo "$task_id"
    fi

    return 0
}

export -f remap_task_id

# ============================================================================
# TASK REFERENCE REMAPPING (T1281)
# ============================================================================

# Remap all ID references in a task JSON object
#
# Transforms a task from the export package by remapping:
#   - .id → new ID from remap table
#   - .parentId → remapped ID if in table, null if missing parent
#   - .depends[] → array of remapped IDs, handles missing deps per strategy
#
# Missing reference handling:
#   - Parent: If not in remap table and not in target → set to null (orphan)
#   - Dependencies: Handle per missing_dep_strategy
#
# Arguments:
#   $1 - task_json: Single task as JSON string
#   $2 - missing_dep_strategy: How to handle missing deps (strip|placeholder|fail)
#        Default: strip
#   $3 - todo_file: Path to target todo.json (for checking existing tasks)
# Outputs:
#   Remapped task JSON to stdout
# Returns:
#   0 on success
#   EXIT_VALIDATION_ERROR (6) if validation fails
# Example:
#   task='{"id":"T001","title":"Test","parentId":"T002","depends":["T003"]}'
#   remapped=$(remap_task_references "$task" "strip" ".cleo/todo.json")
remap_task_references() {
    local task_json="$1"
    local missing_dep_strategy="${2:-strip}"
    local todo_file="${3:-.cleo/todo.json}"

    # ========================================================================
    # Extract Task ID and Remap
    # ========================================================================

    local source_id
    source_id=$(echo "$task_json" | jq -r '.id')

    # Get new ID from remap table
    local new_id
    if ! new_id=$(get_remapped_id "$source_id" 2>/dev/null); then
        echo "ERROR: No mapping found for task ID: $source_id" >&2
        echo "  Hint: Call generate_remap_table() first" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # ========================================================================
    # Remap Parent ID
    # ========================================================================

    local remapped_parent
    remapped_parent=$(remap_parent_id "$task_json" "$todo_file")

    # ========================================================================
    # Remap Dependencies Array
    # ========================================================================

    local remapped_depends
    remapped_depends=$(remap_depends_array "$task_json" "$missing_dep_strategy" "$todo_file")

    # ========================================================================
    # Build Remapped Task
    # ========================================================================

    echo "$task_json" | jq \
        --arg new_id "$new_id" \
        --argjson new_parent "$remapped_parent" \
        --argjson new_depends "$remapped_depends" \
        '.id = $new_id | .parentId = $new_parent | .depends = $new_depends'

    return 0
}

export -f remap_task_references

# Remap parent ID reference
#
# Handles parent ID remapping with missing parent detection:
#   1. If parent in ID_REMAP → use remapped ID
#   2. Else if parent exists in target → keep original ID
#   3. Else → set parentId to null (orphan task)
#
# Arguments:
#   $1 - task_json: Task JSON object
#   $2 - todo_file: Path to target todo.json
# Outputs:
#   Remapped parent ID as JSON value (quoted string or null)
# Returns:
#   0 always (safe fallback to null)
# Example:
#   parent=$(remap_parent_id "$task" ".cleo/todo.json")
remap_parent_id() {
    local task_json="$1"
    local todo_file="$2"

    # Extract source parent ID
    local source_parent
    source_parent=$(echo "$task_json" | jq -r '.parentId // empty')

    # If no parent, return null
    if [[ -z "$source_parent" || "$source_parent" == "null" ]]; then
        echo "null"
        return 0
    fi

    # Check if parent is in remap table
    local remapped_id
    if remapped_id=$(get_remapped_id "$source_parent" 2>/dev/null); then
        # Parent is being imported - use remapped ID
        echo "\"$remapped_id\""
        return 0
    fi

    # Check if parent exists in target project
    if task_exists_in_target "$source_parent" "$todo_file"; then
        # Parent exists in target with same ID - keep it
        echo "\"$source_parent\""
        return 0
    fi

    # Parent not found - orphan this task
    local source_id
    source_id=$(echo "$task_json" | jq -r '.id')
    echo "WARN: Task $source_id: Parent $source_parent not found, importing as root" >&2

    echo "null"
    return 0
}

export -f remap_parent_id

# Remap dependencies array
#
# Handles dependency array remapping with missing dependency strategies:
#   - strip (default): Remove missing dependencies from array
#   - placeholder: Create stub task for missing dependency (future feature)
#   - fail: Error and abort if any dependency missing
#
# For each dependency:
#   1. If dep in ID_REMAP → use remapped ID
#   2. Else if dep exists in target → keep original ID
#   3. Else → handle per strategy
#
# Arguments:
#   $1 - task_json: Task JSON object
#   $2 - missing_dep_strategy: How to handle missing deps (strip|placeholder|fail)
#   $3 - todo_file: Path to target todo.json
# Outputs:
#   Remapped dependencies array as JSON
# Returns:
#   0 on success
#   EXIT_VALIDATION_ERROR (6) if strategy=fail and dep missing
# Example:
#   deps=$(remap_depends_array "$task" "strip" ".cleo/todo.json")
remap_depends_array() {
    local task_json="$1"
    local missing_dep_strategy="${2:-strip}"
    local todo_file="$3"

    # Extract source dependencies array
    local source_depends
    source_depends=$(echo "$task_json" | jq -c '.depends // []')

    # If no dependencies, return empty array
    if [[ "$source_depends" == "[]" ]]; then
        echo "[]"
        return 0
    fi

    # Build new dependencies array
    local new_deps=()
    local source_id
    source_id=$(echo "$task_json" | jq -r '.id')

    while IFS= read -r dep; do
        [[ -z "$dep" ]] && continue

        # Check if dep is in remap table
        local remapped_dep
        if remapped_dep=$(get_remapped_id "$dep" 2>/dev/null); then
            # Dep is being imported - use remapped ID
            new_deps+=("$remapped_dep")
            continue
        fi

        # Check if dep exists in target
        if task_exists_in_target "$dep" "$todo_file"; then
            # Dep exists in target with same ID - keep it
            new_deps+=("$dep")
            continue
        fi

        # Dep is missing - handle per strategy
        case "$missing_dep_strategy" in
            strip)
                echo "WARN: Task $source_id: Dependency $dep not found, stripping" >&2
                # Do not add to new_deps array
                ;;
            placeholder)
                echo "WARN: Task $source_id: Dependency $dep not found, placeholder creation not yet implemented" >&2
                # TODO (future): Create placeholder task
                # For now, strip it
                ;;
            fail)
                echo "ERROR: Task $source_id: Missing dependency $dep" >&2
                return "$EXIT_VALIDATION_ERROR"
                ;;
            *)
                echo "ERROR: Unknown missing dependency strategy: $missing_dep_strategy" >&2
                return "$EXIT_VALIDATION_ERROR"
                ;;
        esac
    done < <(echo "$source_depends" | jq -r '.[]')

    # Convert array to JSON
    if [[ ${#new_deps[@]} -eq 0 ]]; then
        echo "[]"
    else
        printf '%s\n' "${new_deps[@]}" | jq -R . | jq -s .
    fi

    return 0
}

export -f remap_depends_array

# Check if task exists in target project
#
# Arguments:
#   $1 - task_id: Task ID to check
#   $2 - todo_file: Path to target todo.json
# Returns:
#   0 if task exists, 1 if not
task_exists_in_target() {
    local task_id="$1"
    local todo_file="$2"

    [[ ! -f "$todo_file" ]] && return 1

    local exists
    exists=$(jq -r --arg id "$task_id" '
        .tasks[] | select(.id == $id) | .id
    ' "$todo_file" 2>/dev/null)

    [[ -n "$exists" ]]
}

export -f task_exists_in_target

# ============================================================================
# CONFLICT DETECTION (T1287-T1289)
# ============================================================================

# Detect duplicate titles between export and target project
#
# Compares task titles using case-insensitive matching. Returns an array
# of conflict objects for any export tasks that match existing target titles.
#
# Algorithm (per IMPORT-EXPORT-ALGORITHMS.md Section 3.1):
#   1. Extract existing titles from target, normalize to lowercase
#   2. For each export task:
#      - Normalize title to lowercase
#      - Check if normalized title exists in target
#      - If match found, create conflict object
#   3. Return JSON array of all conflicts
#
# Arguments:
#   $1 - export_file: Path to .cleo-export.json
#   $2 - todo_file: Target project's todo.json
# Outputs:
#   JSON array of conflict objects to stdout
# Returns:
#   0 always (empty array if no conflicts)
# Conflict Object Format:
#   {
#     "type": "duplicate_title",
#     "sourceId": "T001",
#     "title": "Original Title",
#     "existingId": "T025"
#   }
# Example:
#   conflicts=$(detect_duplicate_titles "$export" "$todo")
#   count=$(echo "$conflicts" | jq 'length')
detect_duplicate_titles() {
    local export_file="$1"
    local todo_file="$2"

    # Build lookup of existing titles (normalized) → task ID
    # Using jq to create map: {"normalized title": "T025", ...}
    local existing_titles_map
    existing_titles_map=$(jq -c '
        [.tasks[] | {key: (.title | ascii_downcase), value: .id}] |
        from_entries
    ' "$todo_file" 2>/dev/null)

    # Check each export task for duplicate titles
    local conflicts
    conflicts=$(jq --argjson existing "$existing_titles_map" '
        [.tasks[] |
         . as $task |
         ($task.title | ascii_downcase) as $normalized |
         if $existing[$normalized] then
             {
                 type: "duplicate_title",
                 sourceId: $task.id,
                 title: $task.title,
                 existingId: $existing[$normalized]
             }
         else
             empty
         end
        ]
    ' "$export_file" 2>/dev/null)

    # Return conflicts array (empty if none found)
    echo "$conflicts"
    return 0
}

export -f detect_duplicate_titles

# Detect missing dependencies
#
# For each task in export, check if all depends[] entries exist in either:
#   1. The export package (being imported together)
#   2. The target project (already exists)
#
# Returns conflict objects for any dependencies that are missing from both.
#
# Arguments:
#   $1 - export_file: Path to .cleo-export.json
#   $2 - todo_file: Target project's todo.json
# Outputs:
#   JSON array of conflict objects to stdout
# Returns:
#   0 always (empty array if no conflicts)
# Conflict Object Format:
#   {
#     "type": "missing_dependency",
#     "sourceId": "T003",
#     "missingDepId": "T999"
#   }
# Example:
#   conflicts=$(detect_missing_deps "$export" "$todo")
detect_missing_deps() {
    local export_file="$1"
    local todo_file="$2"

    # Build set of task IDs in export package
    local export_ids
    export_ids=$(jq -c '[.tasks[].id]' "$export_file" 2>/dev/null)

    # Build set of task IDs in target project
    local target_ids
    target_ids=$(jq -c '[.tasks[].id]' "$todo_file" 2>/dev/null)

    # Check each task's dependencies
    local conflicts
    conflicts=$(jq --argjson export_ids "$export_ids" \
                   --argjson target_ids "$target_ids" '
        [.tasks[] |
         . as $task |
         ($task.depends // [])[] as $dep |
         if ($export_ids | index($dep)) then
             # Dep is in export - OK
             empty
         elif ($target_ids | index($dep)) then
             # Dep exists in target - OK
             empty
         else
             # Dep is missing from both
             {
                 type: "missing_dependency",
                 sourceId: $task.id,
                 missingDepId: $dep
             }
         end
        ]
    ' "$export_file" 2>/dev/null)

    echo "$conflicts"
    return 0
}

export -f detect_missing_deps

# Detect phase mismatches
#
# Check if task phases from export exist in target project's phase definitions.
# Suggests similar phase names if available (future enhancement).
#
# Arguments:
#   $1 - export_file: Path to .cleo-export.json
#   $2 - todo_file: Target project's todo.json
# Outputs:
#   JSON array of conflict objects to stdout
# Returns:
#   0 always (empty array if no conflicts)
# Conflict Object Format:
#   {
#     "type": "phase_mismatch",
#     "sourceId": "T001",
#     "phase": "design",
#     "suggestions": []
#   }
# Example:
#   conflicts=$(detect_phase_mismatches "$export" "$todo")
detect_phase_mismatches() {
    local export_file="$1"
    local todo_file="$2"

    # Build set of valid phases from target project
    local target_phases
    target_phases=$(jq -c '[.project.phases // {} | keys[]]' "$todo_file" 2>/dev/null)

    # Check each task's phase
    local conflicts
    conflicts=$(jq --argjson target_phases "$target_phases" '
        [.tasks[] |
         select(.phase != null and .phase != "") |
         . as $task |
         if ($target_phases | index($task.phase)) then
             # Phase exists in target - OK
             empty
         else
             # Phase not found
             {
                 type: "phase_mismatch",
                 sourceId: $task.id,
                 phase: $task.phase,
                 suggestions: []
             }
         end
        ]
    ' "$export_file" 2>/dev/null)

    echo "$conflicts"
    return 0
}

export -f detect_phase_mismatches

# ============================================================================
# CONFLICT RESOLUTION (T1290-T1292)
# ============================================================================

# Resolve duplicate title by appending suffix
#
# When a duplicate title is detected, this function generates a unique title
# by appending " (imported)" suffix. If that still conflicts, appends
# " (imported-N)" with incrementing N until a unique title is found.
#
# Algorithm (per IMPORT-EXPORT-ALGORITHMS.md Section 3.2):
#   1. Try original_title + " (imported)"
#   2. While title exists: increment N, try original_title + " (imported-N)"
#   3. Return first unique title found
#
# Arguments:
#   $1 - original_title: The conflicting title
#   $2 - todo_file: Target project's todo.json (to check existence)
# Outputs:
#   Unique title to stdout
# Returns:
#   0 always (guaranteed to find unique title)
# Example:
#   new_title=$(resolve_duplicate_rename "Setup Database" ".cleo/todo.json")
#   # Returns: "Setup Database (imported)" or "Setup Database (imported-2)"
resolve_duplicate_rename() {
    local original_title="$1"
    local todo_file="$2"

    # Try base suffix first
    local new_title="$original_title (imported)"

    # Check if this title exists
    if ! title_exists_in_target "$new_title" "$todo_file"; then
        echo "$new_title"
        return 0
    fi

    # Base suffix exists, try with counter
    local suffix=2
    while true; do
        new_title="$original_title (imported-$suffix)"

        if ! title_exists_in_target "$new_title" "$todo_file"; then
            echo "$new_title"
            return 0
        fi

        ((suffix++))

        # Safety limit to prevent infinite loop
        if [[ $suffix -gt 1000 ]]; then
            echo "ERROR: Could not find unique title after 1000 attempts" >&2
            echo "$new_title"  # Return anyway
            return 1
        fi
    done
}

export -f resolve_duplicate_rename

# Check if title exists in target project
#
# Arguments:
#   $1 - title: Title to check (case-sensitive)
#   $2 - todo_file: Target project's todo.json
# Returns:
#   0 if title exists, 1 if not
title_exists_in_target() {
    local title="$1"
    local todo_file="$2"

    [[ ! -f "$todo_file" ]] && return 1

    # Normalize both title and target titles to lowercase for comparison
    local normalized_title
    normalized_title=$(echo "$title" | tr '[:upper:]' '[:lower:]')

    local existing_count
    existing_count=$(jq -r --arg title "$normalized_title" '
        [.tasks[] | select((.title | ascii_downcase) == $title)] | length
    ' "$todo_file" 2>/dev/null)

    [[ "$existing_count" -gt 0 ]]
}

export -f title_exists_in_target

# Resolve conflicts by skipping task
#
# Marks a task to be skipped during import when duplicate detected
# and --on-duplicate=skip strategy is active.
#
# This function is called during import conflict resolution to exclude
# tasks from the import when they conflict with existing tasks.
#
# Arguments:
#   $1 - task_id: ID of task to skip
#   $2 - reason: Reason for skipping (e.g., "duplicate_title")
# Outputs:
#   Log message to stderr
# Returns:
#   0 always
# Example:
#   resolve_skip "T001" "duplicate title: Setup Database"
resolve_skip() {
    local task_id="$1"
    local reason="$2"

    echo "SKIP: Task $task_id: $reason" >&2
    # In actual import, this would be logged to result summary
    return 0
}

export -f resolve_skip

# Create placeholder task for missing dependency
#
# When --on-missing-dep=placeholder strategy is active, this creates
# a minimal stub task for a missing dependency ID.
#
# Placeholder tasks have:
#   - title: "Placeholder for [original_id]"
#   - status: "pending"
#   - priority: "low"
#   - label: "placeholder"
#   - description: Auto-generated note
#
# Arguments:
#   $1 - missing_dep_id: Original dependency ID from export
#   $2 - todo_file: Target project's todo.json
# Outputs:
#   New placeholder task ID to stdout
# Returns:
#   0 on success
# Example:
#   placeholder_id=$(create_placeholder_task "T999" ".cleo/todo.json")
#   # Returns: "T031" (next available ID)
create_placeholder_task() {
    local missing_dep_id="$1"
    local todo_file="$2"

    # Get next available ID
    local next_id
    if ! next_id=$(get_next_available_id "$todo_file"); then
        echo "ERROR: Could not get next ID for placeholder" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    local new_id
    new_id=$(printf "T%03d" "$next_id")

    echo "INFO: Creating placeholder task $new_id for missing dependency $missing_dep_id" >&2

    # Return the new ID (actual task creation happens in import command)
    echo "$new_id"
    return 0
}

export -f create_placeholder_task

# ============================================================================
# INTERACTIVE CONFLICT RESOLUTION (T1293)
# ============================================================================

# Resolve conflicts interactively in TTY environment
#
# Presents each conflict to the user with resolution options:
#   - rename: Apply auto-rename strategy (append suffix)
#   - skip: Exclude task from import
#   - force: Import anyway (duplicate titles allowed)
#   - abort: Cancel entire import
#
# Uses fzf if available for interactive menu, falls back to numbered list.
#
# Arguments:
#   $1 - conflicts: JSON array of conflict objects
#   $2 - todo_file: Target project's todo.json
# Outputs:
#   JSON object mapping task IDs to resolution decisions
# Returns:
#   0 on success
#   1 on abort
# Resolution Format:
#   {
#     "T001": {"action": "rename", "newTitle": "Task (imported)"},
#     "T002": {"action": "skip", "reason": "User selected skip"},
#     "T003": {"action": "force"}
#   }
# Example:
#   resolutions=$(resolve_conflicts_interactive "$conflicts" "$TODO_FILE")
resolve_conflicts_interactive() {
    local conflicts="$1"
    local todo_file="$2"

    # Check if we're in a TTY
    if [[ ! -t 0 ]] || [[ ! -t 1 ]]; then
        echo "ERROR: Interactive resolution requires TTY" >&2
        return 1
    fi

    local conflict_count
    conflict_count=$(echo "$conflicts" | jq 'length')

    if [[ "$conflict_count" == "0" ]]; then
        echo "{}"
        return 0
    fi

    echo "===================================" >&2
    echo "IMPORT CONFLICTS DETECTED" >&2
    echo "===================================" >&2
    echo "" >&2
    echo "Found $conflict_count conflict(s) that require resolution." >&2
    echo "" >&2

    local resolutions="{}"
    local conflict_index=0

    while [[ $conflict_index -lt $conflict_count ]]; do
        local conflict
        conflict=$(echo "$conflicts" | jq -c ".[$conflict_index]")

        local conflict_type
        conflict_type=$(echo "$conflict" | jq -r '.type')

        local source_id
        source_id=$(echo "$conflict" | jq -r '.sourceId')

        # Present conflict to user
        echo "-----------------------------------" >&2
        echo "Conflict $((conflict_index + 1)) of $conflict_count" >&2
        echo "-----------------------------------" >&2

        case "$conflict_type" in
            duplicate_title)
                local title
                title=$(echo "$conflict" | jq -r '.title')
                local existing_id
                existing_id=$(echo "$conflict" | jq -r '.existingId')

                echo "Type: Duplicate Title" >&2
                echo "Task: $source_id - \"$title\"" >&2
                echo "Conflicts with: $existing_id" >&2
                ;;

            missing_dependency)
                local missing_dep
                missing_dep=$(echo "$conflict" | jq -r '.missingDepId')

                echo "Type: Missing Dependency" >&2
                echo "Task: $source_id" >&2
                echo "Missing dependency: $missing_dep" >&2
                ;;

            phase_mismatch)
                local phase
                phase=$(echo "$conflict" | jq -r '.phase')

                echo "Type: Phase Mismatch" >&2
                echo "Task: $source_id" >&2
                echo "Phase not found: $phase" >&2
                ;;
        esac

        echo "" >&2

        # Get user decision
        local decision
        decision=$(prompt_conflict_resolution "$conflict_type")

        # Apply resolution
        case "$decision" in
            rename)
                if [[ "$conflict_type" == "duplicate_title" ]]; then
                    local original_title
                    original_title=$(echo "$conflict" | jq -r '.title')
                    local new_title
                    new_title=$(resolve_duplicate_rename "$original_title" "$todo_file")

                    resolutions=$(echo "$resolutions" | jq \
                        --arg id "$source_id" \
                        --arg action "rename" \
                        --arg title "$new_title" \
                        '.[$id] = {action: $action, newTitle: $title}')

                    echo "✓ Will rename to: \"$new_title\"" >&2
                else
                    echo "ERROR: Rename not applicable to $conflict_type" >&2
                    continue
                fi
                ;;

            skip)
                resolutions=$(echo "$resolutions" | jq \
                    --arg id "$source_id" \
                    --arg action "skip" \
                    --arg reason "User selected skip" \
                    '.[$id] = {action: $action, reason: $reason}')

                echo "✓ Will skip this task" >&2
                ;;

            force)
                resolutions=$(echo "$resolutions" | jq \
                    --arg id "$source_id" \
                    --arg action "force" \
                    '.[$id] = {action: $action}')

                echo "✓ Will force import (duplicate allowed)" >&2
                ;;

            abort)
                echo "✗ Import cancelled by user" >&2
                return 1
                ;;

            *)
                echo "ERROR: Unknown decision: $decision" >&2
                continue
                ;;
        esac

        echo "" >&2
        ((conflict_index++))
    done

    echo "===================================" >&2
    echo "All conflicts resolved" >&2
    echo "===================================" >&2

    echo "$resolutions"
    return 0
}

export -f resolve_conflicts_interactive

# Prompt user for conflict resolution decision
#
# Presents menu of options appropriate for the conflict type.
# Uses simple numbered menu (fzf integration future enhancement).
#
# Arguments:
#   $1 - conflict_type: Type of conflict (duplicate_title, missing_dependency, phase_mismatch)
# Outputs:
#   User's choice: rename|skip|force|abort
# Returns:
#   0 always
prompt_conflict_resolution() {
    local conflict_type="$1"

    echo "Choose resolution:" >&2

    case "$conflict_type" in
        duplicate_title)
            echo "  1) Rename - Auto-append (imported) suffix" >&2
            echo "  2) Skip - Exclude this task from import" >&2
            echo "  3) Force - Import anyway (allow duplicate)" >&2
            echo "  4) Abort - Cancel entire import" >&2
            ;;

        missing_dependency)
            echo "  1) Skip - Exclude this task from import" >&2
            echo "  2) Force - Import and strip missing dependency" >&2
            echo "  3) Abort - Cancel entire import" >&2
            ;;

        phase_mismatch)
            echo "  1) Force - Import with phase as-is" >&2
            echo "  2) Skip - Exclude this task from import" >&2
            echo "  3) Abort - Cancel entire import" >&2
            ;;

        *)
            echo "  1) Skip - Exclude this task" >&2
            echo "  2) Abort - Cancel import" >&2
            ;;
    esac

    echo "" >&2
    read -rp "Your choice [1-4]: " choice

    case "$conflict_type" in
        duplicate_title)
            case "$choice" in
                1) echo "rename" ;;
                2) echo "skip" ;;
                3) echo "force" ;;
                4) echo "abort" ;;
                *) echo "skip" ;;  # Default to safe option
            esac
            ;;

        missing_dependency)
            case "$choice" in
                1) echo "skip" ;;
                2) echo "force" ;;
                3) echo "abort" ;;
                *) echo "skip" ;;
            esac
            ;;

        phase_mismatch)
            case "$choice" in
                1) echo "force" ;;
                2) echo "skip" ;;
                3) echo "abort" ;;
                *) echo "skip" ;;
            esac
            ;;

        *)
            case "$choice" in
                1) echo "skip" ;;
                2) echo "abort" ;;
                *) echo "skip" ;;
            esac
            ;;
    esac
}

export -f prompt_conflict_resolution

# ============================================================================
# MAIN (for testing)
# ============================================================================

# If script is executed directly (not sourced), run tests
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "Testing import-remap functions..."
    echo "===================================="

    # Create test directories
    TEST_DIR=$(mktemp -d /tmp/import-remap-test.XXXXXX)
    trap 'rm -rf "$TEST_DIR"' EXIT

    # Test 1: get_next_available_id with empty project
    echo ""
    echo "Test 1: Next available ID in empty project"
    cat > "$TEST_DIR/todo.json" <<'EOF'
{
  "tasks": [],
  "project": {"name": "test-project"}
}
EOF

    NEXT_ID=$(get_next_available_id "$TEST_DIR/todo.json")
    echo "  Next ID: $NEXT_ID"
    if [[ "$NEXT_ID" == "1" ]]; then
        echo "  ✓ Correct (empty project starts at 1)"
    else
        echo "  ✗ Expected 1, got $NEXT_ID"
        exit 1
    fi

    # Test 2: get_next_available_id with existing tasks
    echo ""
    echo "Test 2: Next available ID with existing tasks"
    cat > "$TEST_DIR/todo.json" <<'EOF'
{
  "tasks": [
    {"id": "T001", "title": "Task 1", "status": "pending", "priority": "medium"},
    {"id": "T005", "title": "Task 5", "status": "pending", "priority": "medium"},
    {"id": "T010", "title": "Task 10", "status": "done", "priority": "low"}
  ],
  "project": {"name": "test-project"}
}
EOF

    NEXT_ID=$(get_next_available_id "$TEST_DIR/todo.json")
    echo "  Next ID: $NEXT_ID"
    if [[ "$NEXT_ID" == "11" ]]; then
        echo "  ✓ Correct (max is 10, next is 11)"
    else
        echo "  ✗ Expected 11, got $NEXT_ID"
        exit 1
    fi

    # Test 3: generate_remap_table
    echo ""
    echo "Test 3: Generate remap table"
    cat > "$TEST_DIR/export.json" <<'EOF'
{
  "_meta": {"format": "cleo-export", "version": "1.0.0"},
  "tasks": [
    {"id": "T001", "title": "Epic", "type": "epic"},
    {"id": "T002", "title": "Task", "type": "task", "parentId": "T001"},
    {"id": "T003", "title": "Subtask", "type": "subtask", "parentId": "T002"}
  ]
}
EOF

    if generate_remap_table "$TEST_DIR/export.json" "$TEST_DIR/todo.json"; then
        echo "  ✓ Remap table generated"
        echo "  Mappings:"
        echo "    T001 -> ${ID_REMAP[T001]}"
        echo "    T002 -> ${ID_REMAP[T002]}"
        echo "    T003 -> ${ID_REMAP[T003]}"

        # Verify mappings
        if [[ "${ID_REMAP[T001]}" == "T011" && \
              "${ID_REMAP[T002]}" == "T012" && \
              "${ID_REMAP[T003]}" == "T013" ]]; then
            echo "  ✓ Mappings correct (T001->T011, T002->T012, T003->T013)"
        else
            echo "  ✗ Unexpected mappings"
            exit 1
        fi
    else
        echo "  ✗ Failed to generate remap table"
        exit 1
    fi

    # Test 4: validate_remap_table
    echo ""
    echo "Test 4: Validate remap table"
    if validate_remap_table "$TEST_DIR/export.json"; then
        echo "  ✓ Remap table validation passed"
    else
        echo "  ✗ Remap table validation failed"
        exit 1
    fi

    # Test 5: get_remapped_id
    echo ""
    echo "Test 5: Lookup remapped IDs"
    REMAPPED=$(get_remapped_id "T001")
    echo "  get_remapped_id('T001') = $REMAPPED"
    if [[ "$REMAPPED" == "T011" ]]; then
        echo "  ✓ Correct lookup"
    else
        echo "  ✗ Expected T011, got $REMAPPED"
        exit 1
    fi

    # Test 6: remap_task_id with missing mapping
    echo ""
    echo "Test 6: Remap ID not in table (fallback behavior)"
    REMAPPED=$(remap_task_id "T999")
    echo "  remap_task_id('T999') = $REMAPPED"
    if [[ "$REMAPPED" == "T999" ]]; then
        echo "  ✓ Correctly returned original ID"
    else
        echo "  ✗ Expected T999, got $REMAPPED"
        exit 1
    fi

    # Test 7: Large ID set (100+ tasks)
    echo ""
    echo "Test 7: Large export (100+ tasks)"

    # Generate export with 150 tasks
    {
        echo '{"_meta": {"format": "cleo-export", "version": "1.0.0"}, "tasks": ['
        for i in $(seq 1 150); do
            id=$(printf "T%03d" "$i")
            echo "{\"id\": \"$id\", \"title\": \"Task $i\", \"type\": \"task\"}"
            [[ $i -lt 150 ]] && echo ","
        done
        echo ']}'
    } > "$TEST_DIR/large-export.json"

    if generate_remap_table "$TEST_DIR/large-export.json" "$TEST_DIR/todo.json"; then
        echo "  ✓ Generated mappings for 150 tasks"
        echo "  First: T001 -> ${ID_REMAP[T001]}"
        echo "  Last: T150 -> ${ID_REMAP[T150]}"

        if [[ "${ID_REMAP[T001]}" == "T011" && "${ID_REMAP[T150]}" == "T160" ]]; then
            echo "  ✓ Mappings correct (T001->T011, T150->T160)"
        else
            echo "  ✗ Unexpected mappings"
            exit 1
        fi
    else
        echo "  ✗ Failed to generate large remap table"
        exit 1
    fi

    # Test 8: remap_task_references - simple case
    echo ""
    echo "Test 8: Remap task references (simple)"
    TASK_JSON='{"id":"T001","title":"Epic","type":"epic","status":"pending","priority":"high","parentId":null,"depends":[]}'

    REMAPPED=$(remap_task_references "$TASK_JSON" "strip" "$TEST_DIR/todo.json")
    REMAPPED_ID=$(echo "$REMAPPED" | jq -r '.id')

    echo "  Original: T001"
    echo "  Remapped: $REMAPPED_ID"

    if [[ "$REMAPPED_ID" == "T011" ]]; then
        echo "  ✓ Task ID correctly remapped"
    else
        echo "  ✗ Expected T011, got $REMAPPED_ID"
        exit 1
    fi

    # Test 9: remap_parent_id - parent in remap table
    echo ""
    echo "Test 9: Remap parent ID (parent being imported)"
    CHILD_JSON='{"id":"T002","title":"Child","parentId":"T001"}'

    REMAPPED_PARENT=$(remap_parent_id "$CHILD_JSON" "$TEST_DIR/todo.json")
    echo "  Original parent: T001"
    echo "  Remapped parent: $REMAPPED_PARENT"

    if [[ "$REMAPPED_PARENT" == '"T011"' ]]; then
        echo "  ✓ Parent ID correctly remapped"
    else
        echo "  ✗ Expected \"T011\", got $REMAPPED_PARENT"
        exit 1
    fi

    # Test 10: remap_parent_id - missing parent (orphan)
    echo ""
    echo "Test 10: Remap parent ID (missing parent → orphan)"
    ORPHAN_JSON='{"id":"T002","title":"Orphan","parentId":"T999"}'

    REMAPPED_PARENT=$(remap_parent_id "$ORPHAN_JSON" "$TEST_DIR/todo.json")
    echo "  Original parent: T999 (not in remap table or target)"
    echo "  Remapped parent: $REMAPPED_PARENT"

    if [[ "$REMAPPED_PARENT" == "null" ]]; then
        echo "  ✓ Missing parent correctly set to null"
    else
        echo "  ✗ Expected null, got $REMAPPED_PARENT"
        exit 1
    fi

    # Test 11: remap_depends_array - deps in remap table
    echo ""
    echo "Test 11: Remap dependencies (deps being imported)"
    DEP_JSON='{"id":"T003","title":"Task","depends":["T001","T002"]}'

    REMAPPED_DEPS=$(remap_depends_array "$DEP_JSON" "strip" "$TEST_DIR/todo.json")
    echo "  Original deps: [T001, T002]"
    echo "  Remapped deps: $(echo "$REMAPPED_DEPS" | jq -c .)"

    EXPECTED='["T011","T012"]'
    REMAPPED_COMPACT=$(echo "$REMAPPED_DEPS" | jq -c .)
    if [[ "$REMAPPED_COMPACT" == "$EXPECTED" ]]; then
        echo "  ✓ Dependencies correctly remapped"
    else
        echo "  ✗ Expected $EXPECTED, got $REMAPPED_COMPACT"
        exit 1
    fi

    # Test 12: remap_depends_array - missing dep with strip strategy
    echo ""
    echo "Test 12: Remap dependencies (missing dep, strip strategy)"
    MISSING_DEP_JSON='{"id":"T002","title":"Task","depends":["T001","T999"]}'

    REMAPPED_DEPS=$(remap_depends_array "$MISSING_DEP_JSON" "strip" "$TEST_DIR/todo.json" 2>&1 | grep -v "^WARN:")
    echo "  Original deps: [T001, T999]"
    echo "  Remapped deps: $(echo "$REMAPPED_DEPS" | jq -c .)"

    EXPECTED='["T011"]'
    REMAPPED_COMPACT=$(echo "$REMAPPED_DEPS" | jq -c .)
    if [[ "$REMAPPED_COMPACT" == "$EXPECTED" ]]; then
        echo "  ✓ Missing dependency correctly stripped"
    else
        echo "  ✗ Expected $EXPECTED, got $REMAPPED_COMPACT"
        exit 1
    fi

    # Test 13: remap_depends_array - missing dep with fail strategy
    echo ""
    echo "Test 13: Remap dependencies (missing dep, fail strategy)"
    if REMAPPED_DEPS=$(remap_depends_array "$MISSING_DEP_JSON" "fail" "$TEST_DIR/todo.json" 2>/dev/null); then
        echo "  ✗ Should have failed with missing dependency"
        exit 1
    else
        echo "  ✓ Correctly failed with missing dependency"
    fi

    # Test 14: Full task remap with parent and deps
    echo ""
    echo "Test 14: Full task remap (parent + deps)"
    FULL_TASK='{"id":"T003","title":"Feature","type":"task","status":"active","priority":"high","parentId":"T001","depends":["T002"]}'

    REMAPPED=$(remap_task_references "$FULL_TASK" "strip" "$TEST_DIR/todo.json")

    REMAPPED_ID=$(echo "$REMAPPED" | jq -r '.id')
    REMAPPED_PARENT=$(echo "$REMAPPED" | jq -r '.parentId')
    REMAPPED_DEPS=$(echo "$REMAPPED" | jq -c '.depends')

    echo "  Original: id=T003, parentId=T001, depends=[T002]"
    echo "  Remapped: id=$REMAPPED_ID, parentId=$REMAPPED_PARENT, depends=$REMAPPED_DEPS"

    if [[ "$REMAPPED_ID" == "T013" && \
          "$REMAPPED_PARENT" == "T011" && \
          "$REMAPPED_DEPS" == '["T012"]' ]]; then
        echo "  ✓ All references correctly remapped"
    else
        echo "  ✗ Unexpected remapping results"
        exit 1
    fi

    echo ""
    echo "===================================="
    echo "All tests passed! ✓"
fi
