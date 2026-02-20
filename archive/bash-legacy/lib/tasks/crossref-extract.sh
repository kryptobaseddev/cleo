#!/usr/bin/env bash
# crossref-extract.sh - Extract task cross-references from text content
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: None
# PROVIDES: extract_task_refs, create_relates_entries, merge_relates_arrays

#=== SOURCE GUARD ================================================
[[ -n "${_CROSSREF_EXTRACT_SH_LOADED:-}" ]] && return 0
declare -r _CROSSREF_EXTRACT_SH_LOADED=1

set -euo pipefail

# ============================================================================
# TASK REFERENCE EXTRACTION
# ============================================================================

# extract_task_refs - Extract task IDs from text content
#
# Scans text for patterns that look like CLEO task IDs (T followed by digits)
# and returns unique matches. Validates format but NOT existence.
#
# Usage: extract_task_refs "See T1234 and check T5678 for details"
# Output: JSON array ["T1234", "T5678"]
#
# Patterns matched:
#   - Standard IDs: T1234, T001, T42
#   - With context: "See T1234", "related to T5678", "from T1720"
#   - In backticks: `T1234`
#   - In parentheses: (T1234)
#
# Arguments:
#   $1 - Text to scan for task references
#   $2 - Optional: Task ID to exclude (typically the current task)
#
# Returns:
#   JSON array of unique task IDs found (empty array if none)
#
extract_task_refs() {
    local text="${1:-}"
    local exclude_id="${2:-}"

    if [[ -z "$text" ]]; then
        echo "[]"
        return 0
    fi

    # Pattern for CLEO task IDs: T followed by 3+ digits
    # Use word boundaries to avoid partial matches
    local pattern='T[0-9]{3,}'

    # Extract all matches using grep
    local matches
    matches=$(echo "$text" | grep -oE "$pattern" 2>/dev/null || true)

    if [[ -z "$matches" ]]; then
        echo "[]"
        return 0
    fi

    # Convert to JSON array, deduplicate, optionally exclude current task
    if [[ -n "$exclude_id" ]]; then
        echo "$matches" | \
            sort -u | \
            jq -R -s --arg exclude "$exclude_id" \
            'split("\n") | map(select(length > 0 and . != $exclude)) | unique'
    else
        echo "$matches" | \
            sort -u | \
            jq -R -s 'split("\n") | map(select(length > 0)) | unique'
    fi
}

# create_relates_entries - Create relates array entries from extracted refs
#
# Converts a list of task IDs into relates array entries with specified type.
#
# Usage: create_relates_entries '["T1234", "T5678"]' "relates-to"
# Output: [{"taskId": "T1234", "type": "relates-to"}, ...]
#
# Arguments:
#   $1 - JSON array of task IDs
#   $2 - Relationship type (default: "relates-to")
#        Valid types: relates-to, spawned-from, deferred-to, supersedes, duplicates
#   $3 - Optional reason string (max 200 chars)
#
# Returns:
#   JSON array of relates entries
#
create_relates_entries() {
    local refs="${1:-[]}"
    local rel_type="${2:-relates-to}"
    local reason="${3:-}"

    # Handle empty/null inputs
    if [[ "$refs" == "null" || -z "$refs" || "$refs" == "[]" ]]; then
        echo "[]"
        return 0
    fi

    # Validate relationship type
    case "$rel_type" in
        relates-to|spawned-from|deferred-to|supersedes|duplicates)
            ;;
        *)
            rel_type="relates-to"
            ;;
    esac

    # Build relates entries using jq
    if [[ -n "$reason" ]]; then
        echo "$refs" | jq --arg type "$rel_type" --arg reason "$reason" '
            map({taskId: ., type: $type, reason: $reason})
        '
    else
        echo "$refs" | jq --arg type "$rel_type" '
            map({taskId: ., type: $type})
        '
    fi
}

# merge_relates_arrays - Merge new relates entries with existing ones
#
# Combines two relates arrays, deduplicating by taskId.
# If same taskId exists with different type, keeps the existing entry.
#
# Usage: merge_relates_arrays '[{"taskId":"T1234","type":"relates-to"}]' '[{"taskId":"T5678","type":"relates-to"}]'
# Output: [{"taskId":"T1234","type":"relates-to"}, {"taskId":"T5678","type":"relates-to"}]
#
# Arguments:
#   $1 - Existing relates array (JSON)
#   $2 - New relates entries to merge (JSON)
#
# Returns:
#   JSON array of merged relates entries (existing entries take precedence)
#
merge_relates_arrays() {
    local existing="${1:-[]}"
    local new_entries="${2:-[]}"

    # Handle empty/null inputs
    if [[ "$existing" == "null" || -z "$existing" ]]; then
        existing="[]"
    fi
    if [[ "$new_entries" == "null" || -z "$new_entries" ]]; then
        new_entries="[]"
    fi

    # Merge: existing entries take precedence (dedup by taskId)
    jq -n \
        --argjson existing "$existing" \
        --argjson new "$new_entries" \
        '
        # Get existing taskIds
        ($existing | map(.taskId)) as $existing_ids |
        # Filter new entries to only include those not already present
        ($new | map(select(.taskId as $id | $existing_ids | index($id) | not))) as $filtered_new |
        # Combine existing with filtered new entries
        $existing + $filtered_new
        '
}

# validate_relates_refs - Validate that referenced task IDs exist
#
# Checks if task IDs in relates entries exist in the todo file.
# Returns list of invalid (non-existent) task IDs.
#
# Usage: validate_relates_refs '[{"taskId":"T1234","type":"relates-to"}]' ".cleo/todo.json"
# Output: JSON array of invalid task IDs, or empty array if all valid
#
# Arguments:
#   $1 - Relates array to validate (JSON)
#   $2 - Path to todo.json file
#
# Returns:
#   JSON array of task IDs that don't exist (empty if all valid)
#
validate_relates_refs() {
    local relates="${1:-[]}"
    local todo_file="${2:-.cleo/todo.json}"

    # Handle empty/null inputs
    if [[ "$relates" == "null" || -z "$relates" || "$relates" == "[]" ]]; then
        echo "[]"
        return 0
    fi

    if [[ ! -f "$todo_file" ]]; then
        # Can't validate - return empty (assume valid)
        echo "[]"
        return 0
    fi

    # Get all valid task IDs from todo file
    local valid_ids
    valid_ids=$(jq -r '[.tasks[].id] | @json' "$todo_file")

    # Find task IDs that don't exist
    echo "$relates" | jq --argjson valid "$valid_ids" '
        map(.taskId) | map(select(. as $id | $valid | index($id) | not))
    '
}

# extract_and_create_relates - Convenience function combining extract + create
#
# Extracts task references from text and creates relates entries.
#
# Usage: extract_and_create_relates "See T1234 for context" "T001" "relates-to"
# Output: [{"taskId":"T1234","type":"relates-to"}]
#
# Arguments:
#   $1 - Text to scan for task references
#   $2 - Task ID to exclude (current task)
#   $3 - Relationship type (default: "relates-to")
#   $4 - Optional reason string
#
# Returns:
#   JSON array of relates entries for found task references
#
extract_and_create_relates() {
    local text="${1:-}"
    local exclude_id="${2:-}"
    local rel_type="${3:-relates-to}"
    local reason="${4:-}"

    local refs
    refs=$(extract_task_refs "$text" "$exclude_id")

    create_relates_entries "$refs" "$rel_type" "$reason"
}
