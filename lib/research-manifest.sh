#!/usr/bin/env bash
# research-manifest.sh - MANIFEST.jsonl CRUD Operations for Research Outputs
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: exit-codes.sh, config.sh
# PROVIDES: read_manifest, append_manifest, find_entry, filter_entries, archive_entry
#
# Implements atomic append-only operations for JSONL manifest file.
# JSONL chosen for O(1) append, race-condition free concurrent writes,
# and isolated corruption (single-line vs whole-file).

#=== SOURCE GUARD ================================================
[[ -n "${_RESEARCH_MANIFEST_LOADED:-}" ]] && return 0
declare -r _RESEARCH_MANIFEST_LOADED=1

set -euo pipefail

# Determine library directory
_RM_LIB_DIR="${BASH_SOURCE[0]%/*}"
[[ "$_RM_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _RM_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/exit-codes.sh
source "${_RM_LIB_DIR}/exit-codes.sh"
# shellcheck source=lib/config.sh
source "${_RM_LIB_DIR}/config.sh"

# ============================================================================
# CONFIGURATION
# ============================================================================

# Get research output directory from config (project-agnostic)
_rm_get_output_dir() {
    local dir
    dir=$(get_config_value "research.outputDir" "docs/claudedocs/research-outputs")
    echo "$dir"
}

# Get manifest filename from config
_rm_get_manifest_file() {
    local file
    file=$(get_config_value "research.manifestFile" "MANIFEST.jsonl")
    echo "$file"
}

# Get full manifest path
_rm_get_manifest_path() {
    local output_dir manifest_file
    output_dir=$(_rm_get_output_dir)
    manifest_file=$(_rm_get_manifest_file)
    echo "${output_dir}/${manifest_file}"
}

# ============================================================================
# VALIDATION HELPERS
# ============================================================================

# Validate a single JSON line for manifest entry requirements
# Args: $1 = JSON string
# Returns: 0 if valid, 6 (EXIT_VALIDATION_ERROR) if invalid
_rm_validate_entry() {
    local json="$1"

    # Check if it's valid JSON
    if ! echo "$json" | jq empty 2>/dev/null; then
        echo "Invalid JSON syntax" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Check required fields exist
    local required_fields=("id" "file" "title" "date" "status" "topics" "key_findings" "actionable")
    local missing_fields=()

    for field in "${required_fields[@]}"; do
        if ! echo "$json" | jq -e "has(\"$field\")" >/dev/null 2>&1; then
            missing_fields+=("$field")
        fi
    done

    if [[ ${#missing_fields[@]} -gt 0 ]]; then
        echo "Missing required fields: ${missing_fields[*]}" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate status enum
    local status
    status=$(echo "$json" | jq -r '.status')
    case "$status" in
        complete|partial|blocked|archived) ;;
        *)
            echo "Invalid status: $status (must be complete|partial|blocked|archived)" >&2
            return "$EXIT_VALIDATION_ERROR"
            ;;
    esac

    # Validate date format (YYYY-MM-DD)
    local date
    date=$(echo "$json" | jq -r '.date')
    if ! [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
        echo "Invalid date format: $date (must be YYYY-MM-DD)" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate topics is array
    if ! echo "$json" | jq -e '.topics | type == "array"' >/dev/null 2>&1; then
        echo "topics must be an array" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate key_findings is array
    if ! echo "$json" | jq -e '.key_findings | type == "array"' >/dev/null 2>&1; then
        echo "key_findings must be an array" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Validate actionable is boolean
    if ! echo "$json" | jq -e '.actionable | type == "boolean"' >/dev/null 2>&1; then
        echo "actionable must be a boolean" >&2
        return "$EXIT_VALIDATION_ERROR"
    fi

    return 0
}

# Check if manifest file exists
_rm_manifest_exists() {
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)
    [[ -f "$manifest_path" ]]
}

# ============================================================================
# PUBLIC API
# ============================================================================

# read_manifest - Read all entries from MANIFEST.jsonl
# Args: none
# Output: JSON array of all entries wrapped in CLEO envelope
# Returns: 0 on success, 4 if file not found
read_manifest() {
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        # Return empty result with CLEO envelope
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "read"
            },
            "success": true,
            "result": {
                "entries": [],
                "count": 0
            }
        }'
        return 0
    fi

    # Read all lines and convert to JSON array
    local entries count
    entries=$(jq -s '.' "$manifest_path" 2>/dev/null || echo '[]')
    count=$(echo "$entries" | jq 'length')

    jq -n \
        --argjson entries "$entries" \
        --argjson count "$count" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "read"
            },
            "success": true,
            "result": {
                "entries": $entries,
                "count": $count
            }
        }'

    return 0
}

# append_manifest - Append single JSON entry to MANIFEST.jsonl
# Args: $1 = JSON entry (single line)
# Output: JSON result wrapped in CLEO envelope
# Returns: 0 on success, 6 if validation fails
append_manifest() {
    local entry="$1"
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    # Validate entry before write
    local validation_error
    if ! validation_error=$(_rm_validate_entry "$entry" 2>&1); then
        jq -n \
            --arg error "$validation_error" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "append"
                },
                "success": false,
                "error": {
                    "code": "E_VALIDATION",
                    "message": $error,
                    "exitCode": 6
                }
            }'
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Check for duplicate ID
    local entry_id
    entry_id=$(echo "$entry" | jq -r '.id')

    if [[ -f "$manifest_path" ]] && grep -q "\"id\":\"${entry_id}\"" "$manifest_path" 2>/dev/null; then
        jq -n \
            --arg id "$entry_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "append"
                },
                "success": false,
                "error": {
                    "code": "E_ALREADY_EXISTS",
                    "message": ("Entry with id " + $id + " already exists"),
                    "exitCode": 101
                }
            }'
        return "$EXIT_ALREADY_EXISTS"
    fi

    # Ensure output directory exists
    local output_dir
    output_dir=$(_rm_get_output_dir)
    mkdir -p "$output_dir"

    # Compact JSON to single line and append (atomic on POSIX)
    local compact_entry
    compact_entry=$(echo "$entry" | jq -c '.')
    echo "$compact_entry" >> "$manifest_path"

    jq -n \
        --arg id "$entry_id" \
        --arg file "$manifest_path" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "append"
            },
            "success": true,
            "result": {
                "id": $id,
                "manifestFile": $file,
                "action": "appended"
            }
        }'

    return 0
}

# find_entry - Find entry by ID
# Args: $1 = entry ID
# Output: JSON entry wrapped in CLEO envelope
# Returns: 0 if found, 4 if not found
find_entry() {
    local entry_id="$1"
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --arg id "$entry_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "find"
                },
                "success": false,
                "error": {
                    "code": "E_NOT_FOUND",
                    "message": "Manifest file not found. Run: cleo research init",
                    "exitCode": 4
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # Search for entry by ID using jq with slurp
    local entry
    entry=$(jq -s --arg id "$entry_id" '.[] | select(.id == $id)' "$manifest_path" 2>/dev/null)

    if [[ -z "$entry" || "$entry" == "null" ]]; then
        jq -n \
            --arg id "$entry_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "find"
                },
                "success": false,
                "error": {
                    "code": "E_NOT_FOUND",
                    "message": ("Research entry \"" + $id + "\" not found"),
                    "exitCode": 4
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    jq -n \
        --argjson entry "$entry" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "find"
            },
            "success": true,
            "result": {
                "entry": $entry
            }
        }'

    return 0
}

# filter_entries - Filter entries by status, topic, date, actionable
# Args:
#   --status STATUS    Filter by status (complete|partial|blocked|archived)
#   --topic TOPIC      Filter by topic tag (substring match in topics array)
#   --since DATE       Filter entries on or after date (ISO 8601)
#   --actionable       Only actionable entries
#   --limit N          Max entries (default: all)
# Output: JSON array of matching entries wrapped in CLEO envelope
# Returns: 0 on success
filter_entries() {
    local status="" topic="" since="" actionable="" limit=""

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --status)
                status="$2"
                shift 2
                ;;
            --topic)
                topic="$2"
                shift 2
                ;;
            --since)
                since="$2"
                shift 2
                ;;
            --actionable)
                actionable="true"
                shift
                ;;
            --limit)
                limit="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        # Return empty result
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "filter"
            },
            "success": true,
            "result": {
                "entries": [],
                "total": 0,
                "filtered": 0
            }
        }'
        return 0
    fi

    # Build jq filter chain
    local jq_filter="."

    if [[ -n "$status" ]]; then
        jq_filter+=" | select(.status == \"$status\")"
    fi

    if [[ -n "$topic" ]]; then
        jq_filter+=" | select(.topics // [] | any(. | test(\"$topic\"; \"i\")))"
    fi

    if [[ -n "$since" ]]; then
        jq_filter+=" | select(.date >= \"$since\")"
    fi

    if [[ -n "$actionable" ]]; then
        jq_filter+=" | select(.actionable == true)"
    fi

    # Get total count first
    local total
    total=$(wc -l < "$manifest_path" | tr -d ' ')

    # Apply filters
    local entries
    if [[ -n "$limit" ]]; then
        entries=$(jq -s "[ .[] | $jq_filter ] | .[:$limit]" "$manifest_path" 2>/dev/null || echo '[]')
    else
        entries=$(jq -s "[ .[] | $jq_filter ]" "$manifest_path" 2>/dev/null || echo '[]')
    fi

    local filtered
    filtered=$(echo "$entries" | jq 'length')

    jq -n \
        --argjson entries "$entries" \
        --argjson total "$total" \
        --argjson filtered "$filtered" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "filter"
            },
            "success": true,
            "result": {
                "entries": $entries,
                "total": $total,
                "filtered": $filtered
            }
        }'

    return 0
}

# archive_entry - Update entry status to "archived"
# Args: $1 = entry ID
# Output: JSON result wrapped in CLEO envelope
# Returns: 0 on success, 4 if not found
archive_entry() {
    local entry_id="$1"
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --arg id "$entry_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "archive"
                },
                "success": false,
                "error": {
                    "code": "E_NOT_FOUND",
                    "message": "Manifest file not found. Run: cleo research init",
                    "exitCode": 4
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # Check if entry exists
    if ! grep -q "\"id\":\"${entry_id}\"" "$manifest_path" 2>/dev/null; then
        jq -n \
            --arg id "$entry_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "archive"
                },
                "success": false,
                "error": {
                    "code": "E_NOT_FOUND",
                    "message": ("Research entry \"" + $id + "\" not found"),
                    "exitCode": 4
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # For JSONL, we need to rewrite the file with the updated entry
    # This is the tradeoff: updates are O(n) but appends are O(1)
    # Create temp file, process, atomic rename
    local temp_file
    temp_file=$(mktemp)

    # Update the matching entry's status to "archived"
    while IFS= read -r line || [[ -n "$line" ]]; do
        local line_id
        line_id=$(echo "$line" | jq -r '.id' 2>/dev/null)
        if [[ "$line_id" == "$entry_id" ]]; then
            echo "$line" | jq -c '.status = "archived"' >> "$temp_file"
        else
            echo "$line" >> "$temp_file"
        fi
    done < "$manifest_path"

    # Atomic move
    mv "$temp_file" "$manifest_path"

    jq -n \
        --arg id "$entry_id" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "archive"
            },
            "success": true,
            "result": {
                "id": $id,
                "status": "archived",
                "action": "updated"
            }
        }'

    return 0
}

# ============================================================================
# EXPORT FUNCTIONS
# ============================================================================

export -f read_manifest
export -f append_manifest
export -f find_entry
export -f filter_entries
export -f archive_entry
