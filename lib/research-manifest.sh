#!/usr/bin/env bash
# research-manifest.sh - MANIFEST.jsonl CRUD Operations for Agent Outputs
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: exit-codes.sh, config.sh, file-ops.sh
# PROVIDES: read_manifest, append_manifest, find_entry, filter_entries, archive_entry,
#           manifest_check_size, manifest_archive_old, manifest_rotate (T1678)
#
# Implements atomic append-only operations for JSONL manifest file.
# JSONL chosen for O(1) append, race-condition free concurrent writes,
# and isolated corruption (single-line vs whole-file).
#
# NOTE: This library manages the agent outputs manifest (claudedocs/agent-outputs/MANIFEST.jsonl).
# Configuration paths use agentOutputs.* with backward compatibility for research.* paths.

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
# shellcheck source=lib/file-ops.sh
source "${_RM_LIB_DIR}/file-ops.sh"

# ============================================================================
# CONFIGURATION
# ============================================================================

# Get agent outputs directory from config (project-agnostic)
# Uses get_agent_outputs_directory() which handles fallback from deprecated research.outputDir
# Default: claudedocs/agent-outputs
_rm_get_output_dir() {
    get_agent_outputs_directory
}

# Get manifest filename from config
# Uses get_agent_outputs_manifest_file() which handles fallback from deprecated research.manifestFile
# Default: MANIFEST.jsonl
_rm_get_manifest_file() {
    get_agent_outputs_manifest_file
}

# Get full manifest path
_rm_get_manifest_path() {
    local output_dir manifest_file
    output_dir=$(_rm_get_output_dir)
    manifest_file=$(_rm_get_manifest_file)
    echo "${output_dir}/${manifest_file}"
}

# Get lock file path for manifest
_rm_get_lock_path() {
    echo "$(_rm_get_manifest_path).lock"
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

    # Validate agent_type if present (optional field with default)
    # Valid types include 7 RCSD-IVTR protocol types plus additional workflow types
    local agent_type
    agent_type=$(echo "$json" | jq -r '.agent_type // "research"')
    case "$agent_type" in
        # RCSD-IVTR protocol types (7)
        research|consensus|specification|decomposition|implementation|contribution|release)
            ;;
        # Additional workflow types
        validation|documentation|analysis|testing|cleanup|design|architecture|report)
            ;;
        # Extended workflow types
        synthesis|orchestrator|handoff|verification|review)
            ;;
        # Agent-specific types (allow any ct-* prefix for extensibility)
        ct-*|task-executor)
            ;;
        *)
            echo "Invalid agent_type: $agent_type (must be protocol type or workflow type)" >&2
            return "$EXIT_VALIDATION_ERROR"
            ;;
    esac

    # Validate audit object if present (T2578 - v2.10.0)
    if ! validate_audit_object "$json"; then
        return $?
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
# INITIALIZATION & VALIDATION
# ============================================================================

# ensure_research_outputs - Create agent-outputs directory and MANIFEST.jsonl if missing
# This is idempotent - safe to call multiple times
# Default directory: claudedocs/agent-outputs (configurable via agentOutputs.directory)
# Args: none
# Returns: 0 on success (created or already exists), 3 on write error
# Output: JSON with created items list
ensure_research_outputs() {
    local output_dir manifest_file manifest_path archive_dir
    local created=()
    
    output_dir=$(_rm_get_output_dir)
    manifest_file=$(_rm_get_manifest_file)
    manifest_path="${output_dir}/${manifest_file}"
    archive_dir="${output_dir}/archive"
    
    # Create output directory if not exists
    if [[ ! -d "$output_dir" ]]; then
        if ! mkdir -p "$output_dir" 2>/dev/null; then
            jq -nc --arg dir "$output_dir" '{
                "_meta": {"command": "research-manifest", "operation": "ensure"},
                "success": false,
                "error": {
                    "code": "E_FILE_WRITE_ERROR",
                    "message": ("Failed to create directory: " + $dir)
                }
            }'
            return "${EXIT_FILE_ERROR:-3}"
        fi
        created+=("$output_dir/")
    fi
    
    # Create archive directory if not exists
    if [[ ! -d "$archive_dir" ]]; then
        if ! mkdir -p "$archive_dir" 2>/dev/null; then
            jq -nc --arg dir "$archive_dir" '{
                "_meta": {"command": "research-manifest", "operation": "ensure"},
                "success": false,
                "error": {
                    "code": "E_FILE_WRITE_ERROR",
                    "message": ("Failed to create archive directory: " + $dir)
                }
            }'
            return "${EXIT_FILE_ERROR:-3}"
        fi
        created+=("archive/")
    fi
    
    # Create MANIFEST.jsonl if not exists
    if [[ ! -f "$manifest_path" ]]; then
        if ! touch "$manifest_path" 2>/dev/null; then
            jq -nc --arg file "$manifest_path" '{
                "_meta": {"command": "research-manifest", "operation": "ensure"},
                "success": false,
                "error": {
                    "code": "E_FILE_WRITE_ERROR",
                    "message": ("Failed to create manifest file: " + $file)
                }
            }'
            return "${EXIT_FILE_ERROR:-3}"
        fi
        created+=("$manifest_file")
    fi
    
    # Return success with created items
    local created_json
    if [[ ${#created[@]} -eq 0 ]]; then
        created_json="[]"
    else
        created_json=$(printf '%s\n' "${created[@]}" | jq -R . | jq -s .)
    fi
    
    jq -nc \
        --arg output_dir "$output_dir" \
        --argjson created "$created_json" \
        --argjson already_existed "$([ ${#created[@]} -eq 0 ] && echo true || echo false)" \
        '{
            "_meta": {"command": "research-manifest", "operation": "ensure"},
            "success": true,
            "result": {
                "outputDir": $output_dir,
                "created": $created,
                "alreadyExisted": $already_existed
            }
        }'
    return 0
}

# validate_research_manifest - Validate manifest file integrity
# Checks: file exists, valid JSONL format, each line has required fields
# Args: none
# Returns: 0 if valid, 4 if missing, 6 if validation errors
# Output: JSON with validation result and any errors
validate_research_manifest() {
    local manifest_path output_dir
    local errors=()
    local warnings=()
    local line_num=0
    local valid_entries=0
    local invalid_entries=0
    
    output_dir=$(_rm_get_output_dir)
    manifest_path=$(_rm_get_manifest_path)
    
    # Check directory exists
    if [[ ! -d "$output_dir" ]]; then
        jq -nc --arg dir "$output_dir" '{
            "_meta": {"command": "research-manifest", "operation": "validate"},
            "success": false,
            "valid": false,
            "error": {
                "code": "E_FILE_NOT_FOUND",
                "message": ("Agent outputs directory not found: " + $dir),
                "fixCommand": "cleo research init"
            }
        }'
        return "${EXIT_FILE_NOT_FOUND:-4}"
    fi
    
    # Check manifest file exists
    if [[ ! -f "$manifest_path" ]]; then
        jq -nc --arg file "$manifest_path" '{
            "_meta": {"command": "research-manifest", "operation": "validate"},
            "success": false,
            "valid": false,
            "error": {
                "code": "E_FILE_NOT_FOUND",
                "message": ("Manifest file not found: " + $file),
                "fixCommand": "cleo research init"
            }
        }'
        return "${EXIT_FILE_NOT_FOUND:-4}"
    fi
    
    # Check archive directory exists
    if [[ ! -d "${output_dir}/archive" ]]; then
        warnings+=("Archive directory missing: ${output_dir}/archive")
    fi
    
    # If manifest is empty, it's valid (just no entries)
    if [[ ! -s "$manifest_path" ]]; then
        local warnings_json
        if [[ ${#warnings[@]} -eq 0 ]]; then
            warnings_json="[]"
        else
            warnings_json=$(printf '%s\n' "${warnings[@]}" | jq -R . | jq -s .)
        fi
        
        jq -nc \
            --argjson warnings "$warnings_json" \
            '{
                "_meta": {"command": "research-manifest", "operation": "validate"},
                "success": true,
                "valid": true,
                "result": {
                    "totalLines": 0,
                    "validEntries": 0,
                    "invalidEntries": 0,
                    "errors": [],
                    "warnings": $warnings
                }
            }'
        return 0
    fi
    
    # Validate each line as JSON
    while IFS= read -r line || [[ -n "$line" ]]; do
        line_num=$((line_num + 1))
        
        # Skip empty lines
        [[ -z "${line// }" ]] && continue
        
        # Check if line is valid JSON
        if ! echo "$line" | jq empty 2>/dev/null; then
            errors+=("Line $line_num: Invalid JSON syntax")
            invalid_entries=$((invalid_entries + 1))
            continue
        fi
        
        # Validate entry structure
        local validation_error
        if ! validation_error=$(_rm_validate_entry "$line" 2>&1); then
            errors+=("Line $line_num: $validation_error")
            invalid_entries=$((invalid_entries + 1))
            continue
        fi
        
        valid_entries=$((valid_entries + 1))
    done < "$manifest_path"
    
    # Build result JSON
    local errors_json warnings_json
    if [[ ${#errors[@]} -eq 0 ]]; then
        errors_json="[]"
    else
        errors_json=$(printf '%s\n' "${errors[@]}" | jq -R . | jq -s .)
    fi
    
    if [[ ${#warnings[@]} -eq 0 ]]; then
        warnings_json="[]"
    else
        warnings_json=$(printf '%s\n' "${warnings[@]}" | jq -R . | jq -s .)
    fi
    
    local is_valid="true"
    local exit_code=0
    if [[ ${#errors[@]} -gt 0 ]]; then
        is_valid="false"
        exit_code="${EXIT_VALIDATION_ERROR:-6}"
    fi
    
    jq -nc \
        --argjson total "$line_num" \
        --argjson valid "$valid_entries" \
        --argjson invalid "$invalid_entries" \
        --argjson errors "$errors_json" \
        --argjson warnings "$warnings_json" \
        --argjson is_valid "$is_valid" \
        '{
            "_meta": {"command": "research-manifest", "operation": "validate"},
            "success": true,
            "valid": $is_valid,
            "result": {
                "totalLines": $total,
                "validEntries": $valid,
                "invalidEntries": $invalid,
                "errors": $errors,
                "warnings": $warnings
            }
        }'
    return "$exit_code"
}

# ============================================================================
# PUBLIC API
# ============================================================================

# read_manifest - Read all entries from MANIFEST.jsonl
# Args: none
# Output: JSON array of all entries wrapped in CLEO envelope
# Returns: 0 on success, 4 if file not found

# ============================================================================
# Manifest Statistics and Compaction
# ============================================================================

# Get comprehensive manifest statistics
# Returns: Entry count, size, age distribution, topics
get_manifest_stats() {
    local manifest_path archive_path
    manifest_path=$(_rm_get_manifest_path)
    archive_path=$(_rm_get_archive_path)
    
    if [[ ! -f "$manifest_path" ]]; then
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "stats"
            },
            "success": false,
            "error": {
                "code": "E_NOT_FOUND",
                "message": "Manifest file not found"
            }
        }'
        return "${EXIT_NOT_FOUND:-4}"
    fi
    
    local current_bytes entry_count archive_bytes archive_count
    
    current_bytes=$(stat -c %s "$manifest_path" 2>/dev/null || stat -f %z "$manifest_path" 2>/dev/null || echo 0)
    entry_count=$(wc -l < "$manifest_path" | tr -d ' ')
    
    # Archive stats
    if [[ -f "$archive_path" ]]; then
        archive_bytes=$(stat -c %s "$archive_path" 2>/dev/null || stat -f %z "$archive_path" 2>/dev/null || echo 0)
        archive_count=$(wc -l < "$archive_path" | tr -d ' ')
    else
        archive_bytes=0
        archive_count=0
    fi
    
    # Skip detailed stats if manifest is empty
    if [[ $entry_count -eq 0 ]]; then
        jq -n \
            --argjson manifest_bytes "$current_bytes" \
            --argjson manifest_entries 0 \
            --argjson archive_bytes "$archive_bytes" \
            --argjson archive_entries "$archive_count" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "stats"
                },
                "success": true,
                "result": {
                    "manifest": {
                        "bytes": $manifest_bytes,
                        "entries": 0
                    },
                    "archive": {
                        "bytes": $archive_bytes,
                        "entries": $archive_entries
                    },
                    "statusCounts": {},
                    "actionableCount": 0,
                    "topicCounts": {},
                    "ageStats": null
                }
            }'
        return 0
    fi
    
    # Calculate status counts, actionable count, and topic counts via jq
    # Use simpler approach without date arithmetic to avoid jq portability issues
    local stats_json
    stats_json=$(cat "$manifest_path" | jq -sc '
        {
            oldest: (map(.date // "") | map(select(. != "")) | sort | first // null),
            newest: (map(.date // "") | map(select(. != "")) | sort | last // null),
            statusCounts: (group_by(.status) | map({key: .[0].status, value: length}) | from_entries),
            actionableCount: (map(select(.actionable == true)) | length),
            topicCounts: ([.[].topics // [] | .[]] | group_by(.) | map({key: .[0], value: length}) | from_entries)
        }
    ' 2>/dev/null || echo '{"statusCounts":{},"actionableCount":0,"topicCounts":{},"oldest":null,"newest":null}')
    
    jq -n \
        --argjson manifest_bytes "$current_bytes" \
        --argjson manifest_entries "$entry_count" \
        --argjson archive_bytes "$archive_bytes" \
        --argjson archive_entries "$archive_count" \
        --argjson stats "$stats_json" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "stats"
            },
            "success": true,
            "result": {
                "manifest": {
                    "bytes": $manifest_bytes,
                    "entries": $manifest_entries
                },
                "archive": {
                    "bytes": $archive_bytes,
                    "entries": $archive_entries
                },
                "statusCounts": $stats.statusCounts,
                "actionableCount": $stats.actionableCount,
                "topicCounts": $stats.topicCounts,
                "ageStats": {
                    "oldestEntry": $stats.oldest,
                    "newestEntry": $stats.newest
                }
            }
        }'
    
    return 0
}

# Compact manifest by removing duplicate entries (keep newest by ID)
# and entries with status "archived" that have been archived to MANIFEST-ARCHIVE.jsonl
compact_manifest() {
    local manifest_path lock_path
    manifest_path=$(_rm_get_manifest_path)
    lock_path="${manifest_path}.compact.lock"
    
    if [[ ! -f "$manifest_path" ]]; then
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "compact"
            },
            "success": true,
            "result": {
                "entriesBefore": 0,
                "entriesAfter": 0,
                "duplicatesRemoved": 0,
                "obsoleteRemoved": 0
            }
        }'
        return "${EXIT_NO_DATA:-100}"
    fi
    
    local entries_before
    entries_before=$(wc -l < "$manifest_path" | tr -d ' ')
    
    if [[ $entries_before -eq 0 ]]; then
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "compact"
            },
            "success": true,
            "result": {
                "entriesBefore": 0,
                "entriesAfter": 0,
                "duplicatesRemoved": 0,
                "obsoleteRemoved": 0
            }
        }'
        return "${EXIT_NO_DATA:-100}"
    fi
    
    # Ensure lock file exists
    touch "$lock_path" 2>/dev/null || true
    
    # Perform compaction within exclusive lock
    local lock_result duplicates_removed obsolete_removed entries_after
    lock_result=$(
        flock -x 202 2>/dev/null
        
        # Read all entries and deduplicate by ID (keep last occurrence)
        # Also remove entries with status "archived" (they're in archive file)
        local compacted
        compacted=$(cat "$manifest_path" | jq -sc '
            # Group by ID and keep last occurrence
            group_by(.id) | 
            map(last) |
            # Filter out archived entries (they belong in archive file)
            map(select(.status != "archived")) |
            .[]
        ' | jq -c '.')
        
        local new_count=0
        if [[ -n "$compacted" ]]; then
            echo "$compacted" > "${manifest_path}.tmp"
            new_count=$(wc -l < "${manifest_path}.tmp" | tr -d ' ')
            mv "${manifest_path}.tmp" "$manifest_path"
        else
            # Empty result - truncate manifest
            : > "$manifest_path"
        fi
        
        echo "$new_count"
        exit 0
    ) 202>"$lock_path"
    local lock_exit=$?
    
    if [[ $lock_exit -ne 0 ]]; then
        jq -n \
            --arg error "Failed to acquire lock for compact operation" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "compact"
                },
                "success": false,
                "error": {
                    "code": "E_LOCK_FAILED",
                    "message": $error
                }
            }'
        return 8
    fi
    
    entries_after=${lock_result:-0}
    local total_removed=$((entries_before - entries_after))
    
    jq -n \
        --argjson before "$entries_before" \
        --argjson after "$entries_after" \
        --argjson removed "$total_removed" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "compact"
            },
            "success": true,
            "result": {
                "entriesBefore": $before,
                "entriesAfter": $after,
                "entriesRemoved": $removed
            }
        }'
    
    return 0
}

# List entries from archive file
# Usage: list_archived_entries [--limit N] [--since DATE]
list_archived_entries() {
    local limit=50
    local since=""
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --limit)
                limit="$2"
                shift 2
                ;;
            --since)
                since="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done
    
    local archive_path
    archive_path=$(_rm_get_archive_path)
    
    if [[ ! -f "$archive_path" ]]; then
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "list_archived"
            },
            "success": true,
            "result": {
                "total": 0,
                "returned": 0,
                "entries": []
            }
        }'
        return "${EXIT_NO_DATA:-100}"
    fi
    
    local total_entries
    total_entries=$(wc -l < "$archive_path" | tr -d ' ')
    
    if [[ $total_entries -eq 0 ]]; then
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "list_archived"
            },
            "success": true,
            "result": {
                "total": 0,
                "returned": 0,
                "entries": []
            }
        }'
        return "${EXIT_NO_DATA:-100}"
    fi
    
    # Build jq filter
    local jq_filter="."
    
    if [[ -n "$since" ]]; then
        jq_filter="${jq_filter} | select(.date >= \"$since\" or .archivedAt >= \"${since}T00:00:00Z\")"
    fi
    
    # Read and filter entries
    local entries filtered_count
    entries=$(cat "$archive_path" | jq -sc "map($jq_filter) | .[-${limit}:]")
    filtered_count=$(echo "$entries" | jq 'length')
    
    jq -n \
        --argjson total "$total_entries" \
        --argjson returned "$filtered_count" \
        --argjson entries "$entries" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "list_archived"
            },
            "success": true,
            "result": {
                "total": $total,
                "returned": $returned,
                "entries": $entries
            }
        }'
    
    return 0
}

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
# Returns: 0 on success, 6 if validation fails, 101 if duplicate
# Thread Safety: Uses flock for atomic duplicate check + append
#
# NOTE (@task T3148, @epic T3147):
#   This function maintains its own flock implementation because it includes
#   manifest-specific duplicate checking inside the lock block (TOCTOU prevention).
#   The generic atomic_jsonl_append() in file-ops.sh does NOT check duplicates
#   (caller responsibility), so this function keeps its specialized implementation.
#   Future refactor: Extract duplicate-checking logic to allow using atomic_jsonl_append().
append_manifest() {
    local entry="$1"
    local manifest_path lock_path
    manifest_path=$(_rm_get_manifest_path)
    lock_path=$(_rm_get_lock_path)

    # Validate entry before write (outside lock - read-only)
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

    # Extract entry ID before lock
    local entry_id
    entry_id=$(echo "$entry" | jq -r '.id')

    # Validate needs_followup task IDs exist (if present)
    # This is a read-only check, safe to do outside lock
    local needs_followup
    needs_followup=$(echo "$entry" | jq -r '.needs_followup // [] | .[]' 2>/dev/null)

    if [[ -n "$needs_followup" ]]; then
        local invalid_tasks=()
        while IFS= read -r followup_id; do
            # Skip empty lines
            [[ -z "$followup_id" ]] && continue
            # Skip BLOCKED: entries (reasons, not task IDs)
            if [[ "$followup_id" =~ ^BLOCKED: ]]; then
                continue
            fi
            # Validate task ID format and existence
            if [[ "$followup_id" =~ ^T[0-9]+$ ]]; then
                if ! cleo exists "$followup_id" --quiet 2>/dev/null; then
                    invalid_tasks+=("$followup_id")
                fi
            fi
        done <<< "$needs_followup"

        if [[ ${#invalid_tasks[@]} -gt 0 ]]; then
            jq -n \
                --arg ids "${invalid_tasks[*]}" \
                '{
                    "_meta": {"command": "research-manifest", "operation": "append"},
                    "success": false,
                    "error": {
                        "code": "E_INVALID_FOLLOWUP",
                        "message": ("needs_followup contains non-existent tasks: " + $ids),
                        "exitCode": 6
                    }
                }'
            return "$EXIT_VALIDATION_ERROR"
        fi
    fi

    # Compact JSON to single line before lock
    local compact_entry
    compact_entry=$(echo "$entry" | jq -c '.')

    # Ensure output directory exists (before lock)
    local output_dir
    output_dir=$(_rm_get_output_dir)
    mkdir -p "$output_dir"

    # Ensure lock file exists
    touch "$lock_path" 2>/dev/null || true

    # Atomic operation: duplicate check + append within exclusive flock
    # Uses subshell to scope the lock; exit code propagates
    local lock_result
    lock_result=$(
        flock -x 200 2>/dev/null

        # Duplicate check (inside lock to prevent TOCTOU race)
        if [[ -f "$manifest_path" ]] && grep -q "\"id\":\"${entry_id}\"" "$manifest_path" 2>/dev/null; then
            echo "DUPLICATE"
            exit 101
        fi

        # Append (inside lock - atomic with duplicate check)
        echo "$compact_entry" >> "$manifest_path"
        echo "SUCCESS"
        exit 0
    ) 200>"$lock_path"
    local lock_exit=$?

    # Handle duplicate case
    if [[ "$lock_result" == "DUPLICATE" ]] || [[ $lock_exit -eq 101 ]]; then
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

    # Handle other errors
    if [[ $lock_exit -ne 0 ]]; then
        jq -n \
            --arg error "Failed to acquire lock or write to manifest" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "append"
                },
                "success": false,
                "error": {
                    "code": "E_LOCK_FAILED",
                    "message": $error,
                    "exitCode": 8
                }
            }'
        return 8
    fi

    # Check if rotation is needed after successful append (T1678)
    # This is a background optimization - don't fail append if rotation fails
    # Redirect rotation output to /dev/null to keep append output clean
    manifest_rotate >/dev/null 2>&1 || true

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

# filter_entries - Filter entries by status, topic, date, actionable, agent_type
# Args:
#   --status STATUS    Filter by status (complete|partial|blocked|archived)
#   --topic TOPIC      Filter by topic tag (substring match in topics array)
#   --since DATE       Filter entries on or after date (ISO 8601)
#   --actionable       Only actionable entries
#   --limit N          Max entries (default: all)
#   --type TYPE        Filter by agent_type (research|implementation|validation|documentation|analysis)
# Output: JSON array of matching entries wrapped in CLEO envelope
# Returns: 0 on success
filter_entries() {
    local status="" topic="" since="" actionable="" limit="" agent_type=""

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
            --type)
                agent_type="$2"
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

    if [[ -n "$agent_type" ]]; then
        # Filter by agent_type, treating missing/null as "research" (default)
        jq_filter+=" | select((.agent_type // \"research\") == \"$agent_type\")"
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
# Thread Safety: Uses flock for atomic read-modify-write
archive_entry() {
    local entry_id="$1"
    local manifest_path lock_path
    manifest_path=$(_rm_get_manifest_path)
    lock_path=$(_rm_get_lock_path)

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

    # Ensure lock file exists
    touch "$lock_path" 2>/dev/null || true

    # Atomic read-modify-write within exclusive flock
    local lock_result
    lock_result=$(
        flock -x 200 2>/dev/null

        # Check if entry exists (inside lock)
        if ! grep -q "\"id\":\"${entry_id}\"" "$manifest_path" 2>/dev/null; then
            echo "NOT_FOUND"
            exit 4
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

        # Atomic move (inside lock)
        mv "$temp_file" "$manifest_path"
        echo "SUCCESS"
        exit 0
    ) 200>"$lock_path"
    local lock_exit=$?

    # Handle not found case
    if [[ "$lock_result" == "NOT_FOUND" ]] || [[ $lock_exit -eq 4 ]]; then
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

    # Handle other errors
    if [[ $lock_exit -ne 0 ]]; then
        jq -n \
            --arg error "Failed to acquire lock or update manifest" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "archive"
                },
                "success": false,
                "error": {
                    "code": "E_LOCK_FAILED",
                    "message": $error,
                    "exitCode": 8
                }
            }'
        return 8
    fi

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
# ORCHESTRATOR QUERY FUNCTIONS
# ============================================================================

# get_pending_followup - Get all entries with non-empty needs_followup arrays
# Args: none
# Output: JSON array of entries wrapped in CLEO envelope
# Returns: 0 on success
get_pending_followup() {
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "get_pending_followup"
            },
            "success": true,
            "result": {
                "entries": [],
                "count": 0
            }
        }'
        return 0
    fi

    # Filter entries where needs_followup array has items
    local entries count
    entries=$(jq -s '[.[] | select(.needs_followup != null and (.needs_followup | length) > 0)]' "$manifest_path" 2>/dev/null || echo '[]')
    count=$(echo "$entries" | jq 'length')

    jq -n \
        --argjson entries "$entries" \
        --argjson count "$count" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "get_pending_followup"
            },
            "success": true,
            "result": {
                "entries": $entries,
                "count": $count
            }
        }'

    return 0
}

# get_entry_by_id - Get single entry by ID (alias for find_entry with simpler output)
# Args: $1 = entry ID
# Output: Single JSON object (not wrapped) or null
# Returns: 0 if found, 4 if not found
get_entry_by_id() {
    local entry_id="$1"
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        echo "null"
        return "$EXIT_NOT_FOUND"
    fi

    # Direct lookup returning just the entry object
    local entry
    entry=$(jq -s --arg id "$entry_id" '[.[] | select(.id == $id)] | .[0] // null' "$manifest_path" 2>/dev/null)

    if [[ "$entry" == "null" ]]; then
        echo "null"
        return "$EXIT_NOT_FOUND"
    fi

    echo "$entry"
    return 0
}

# get_latest_by_topic - Get the most recent entry for a topic
# Args: $1 = topic string (substring match)
# Output: JSON entry wrapped in CLEO envelope
# Returns: 0 on success (even if no match)
get_latest_by_topic() {
    local topic="$1"
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --arg topic "$topic" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "get_latest_by_topic"
                },
                "success": true,
                "result": {
                    "entry": null,
                    "topic": $topic
                }
            }'
        return 0
    fi

    # Filter by topic and sort by date descending, take first
    local entry
    entry=$(jq -s --arg topic "$topic" '
        [.[] | select(.topics // [] | any(. | test($topic; "i")))]
        | sort_by(.date)
        | reverse
        | .[0] // null
    ' "$manifest_path" 2>/dev/null)

    jq -n \
        --argjson entry "$entry" \
        --arg topic "$topic" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "get_latest_by_topic"
            },
            "success": true,
            "result": {
                "entry": $entry,
                "topic": $topic
            }
        }'

    return 0
}

# task_has_research - Check if a task has linked research
# Args: $1 = task ID
# Output: JSON result with boolean and linked entries
# Returns: 0 always (check result.hasResearch for answer)
task_has_research() {
    local task_id="$1"
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --arg task_id "$task_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "task_has_research"
                },
                "success": true,
                "result": {
                    "taskId": $task_id,
                    "hasResearch": false,
                    "entries": [],
                    "count": 0
                }
            }'
        return 0
    fi

    # Find entries that reference this task in linked_tasks or needs_followup
    local entries count has_research
    entries=$(jq -s --arg task_id "$task_id" '
        [.[] | select(
            (.linked_tasks // [] | any(. == $task_id)) or
            (.needs_followup // [] | any(. == $task_id))
        )]
    ' "$manifest_path" 2>/dev/null || echo '[]')
    count=$(echo "$entries" | jq 'length')
    has_research=$([ "$count" -gt 0 ] && echo "true" || echo "false")

    jq -n \
        --arg task_id "$task_id" \
        --argjson has_research "$has_research" \
        --argjson entries "$entries" \
        --argjson count "$count" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "task_has_research"
            },
            "success": true,
            "result": {
                "taskId": $task_id,
                "hasResearch": $has_research,
                "entries": $entries,
                "count": $count
            }
        }'

    return 0
}

# get_followup_tasks - Get all task IDs from needs_followup arrays
# Args: none
# Output: JSON array of unique task IDs
# Returns: 0 on success
get_followup_tasks() {
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "get_followup_tasks"
            },
            "success": true,
            "result": {
                "taskIds": [],
                "count": 0
            }
        }'
        return 0
    fi

    # Collect all unique task IDs from needs_followup arrays
    local task_ids count
    task_ids=$(jq -s '
        [.[] | .needs_followup // []] | flatten | unique
        | [.[] | select(startswith("T") or startswith("t"))]
    ' "$manifest_path" 2>/dev/null || echo '[]')
    count=$(echo "$task_ids" | jq 'length')

    jq -n \
        --argjson task_ids "$task_ids" \
        --argjson count "$count" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "get_followup_tasks"
            },
            "success": true,
            "result": {
                "taskIds": $task_ids,
                "count": $count
            }
        }'

    return 0
}

# update_entry - Update a manifest entry by ID
# Args: $1 = entry ID, $2 = jq filter to apply (e.g., '.status = "archived"')
# Output: JSON result wrapped in CLEO envelope
# Returns: 0 on success, 4 if not found
# Thread Safety: Uses flock for atomic read-modify-write
update_entry() {
    local entry_id="$1"
    local jq_update="$2"
    local manifest_path lock_path
    manifest_path=$(_rm_get_manifest_path)
    lock_path=$(_rm_get_lock_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --arg id "$entry_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "update"
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

    # Ensure lock file exists
    touch "$lock_path" 2>/dev/null || true

    # Atomic read-modify-write within exclusive flock
    local lock_result
    lock_result=$(
        flock -x 200 2>/dev/null

        # Check if entry exists (inside lock)
        if ! grep -q "\"id\":\"${entry_id}\"" "$manifest_path" 2>/dev/null; then
            echo "NOT_FOUND"
            exit 4
        fi

        # Create temp file, process, atomic rename
        local temp_file
        temp_file=$(mktemp)

        # Apply update to matching entry
        while IFS= read -r line || [[ -n "$line" ]]; do
            local line_id
            line_id=$(echo "$line" | jq -r '.id' 2>/dev/null)
            if [[ "$line_id" == "$entry_id" ]]; then
                echo "$line" | jq -c "$jq_update" >> "$temp_file"
            else
                echo "$line" >> "$temp_file"
            fi
        done < "$manifest_path"

        # Atomic move (inside lock)
        mv "$temp_file" "$manifest_path"
        echo "SUCCESS"
        exit 0
    ) 200>"$lock_path"
    local lock_exit=$?

    # Handle not found case
    if [[ "$lock_result" == "NOT_FOUND" ]] || [[ $lock_exit -eq 4 ]]; then
        jq -n \
            --arg id "$entry_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "update"
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

    # Handle other errors
    if [[ $lock_exit -ne 0 ]]; then
        jq -n \
            --arg error "Failed to acquire lock or update manifest" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "update"
                },
                "success": false,
                "error": {
                    "code": "E_LOCK_FAILED",
                    "message": $error,
                    "exitCode": 8
                }
            }'
        return 8
    fi

    jq -n \
        --arg id "$entry_id" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "update"
            },
            "success": true,
            "result": {
                "id": $id,
                "action": "updated"
            }
        }'

    return 0
}

# ============================================================================
# BIDIRECTIONAL LINKING FUNCTIONS
# ============================================================================

# link_research_to_task - Create bidirectional link between research and task
# Args: $1 = task ID, $2 = research ID, $3 = optional note text
# Output: JSON result wrapped in CLEO envelope
# Returns: 0 on success, 4 if research not found
# Thread Safety: Uses flock for atomic read-modify-write
link_research_to_task() {
    local task_id="$1"
    local research_id="$2"
    local note_text="${3:-}"
    local manifest_path lock_path
    manifest_path=$(_rm_get_manifest_path)
    lock_path=$(_rm_get_lock_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --arg task_id "$task_id" \
            --arg research_id "$research_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "link_research_to_task"
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

    # Ensure lock file exists
    touch "$lock_path" 2>/dev/null || true

    # Atomic read-modify-write within exclusive flock
    local lock_result
    lock_result=$(
        flock -x 200 2>/dev/null

        # Verify research entry exists (inside lock)
        if ! grep -q "\"id\":\"${research_id}\"" "$manifest_path" 2>/dev/null; then
            echo "NOT_FOUND"
            exit 4
        fi

        # Update manifest entry: add task_id to linked_tasks array if not already present
        local temp_file
        temp_file=$(mktemp)
        local link_added=false

        while IFS= read -r line || [[ -n "$line" ]]; do
            local line_id
            line_id=$(echo "$line" | jq -r '.id' 2>/dev/null)
            if [[ "$line_id" == "$research_id" ]]; then
                # Check if already linked
                local already_linked
                already_linked=$(echo "$line" | jq --arg tid "$task_id" '.linked_tasks // [] | any(. == $tid)')
                if [[ "$already_linked" == "true" ]]; then
                    echo "$line" >> "$temp_file"
                else
                    # Add task_id to linked_tasks array
                    echo "$line" | jq -c --arg tid "$task_id" '.linked_tasks = ((.linked_tasks // []) + [$tid] | unique)' >> "$temp_file"
                    link_added=true
                fi
            else
                echo "$line" >> "$temp_file"
            fi
        done < "$manifest_path"

        # Atomic move (inside lock)
        mv "$temp_file" "$manifest_path"

        # Output result for parent to parse
        if [[ "$link_added" == "true" ]]; then
            echo "LINKED"
        else
            echo "ALREADY_LINKED"
        fi
        exit 0
    ) 200>"$lock_path"
    local lock_exit=$?

    # Handle not found case
    if [[ "$lock_result" == "NOT_FOUND" ]] || [[ $lock_exit -eq 4 ]]; then
        jq -n \
            --arg task_id "$task_id" \
            --arg research_id "$research_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "link_research_to_task"
                },
                "success": false,
                "error": {
                    "code": "E_NOT_FOUND",
                    "message": ("Research entry \"" + $research_id + "\" not found"),
                    "exitCode": 4
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # Handle other errors
    if [[ $lock_exit -ne 0 ]]; then
        jq -n \
            --arg error "Failed to acquire lock or update manifest" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "link_research_to_task"
                },
                "success": false,
                "error": {
                    "code": "E_LOCK_FAILED",
                    "message": $error,
                    "exitCode": 8
                }
            }'
        return 8
    fi

    # Convert result to action string
    local action_str manifest_updated_json
    if [[ "$lock_result" == "LINKED" ]]; then
        action_str="linked"
        manifest_updated_json="true"
    else
        action_str="already_linked"
        manifest_updated_json="false"
    fi

    jq -n \
        --arg task_id "$task_id" \
        --arg research_id "$research_id" \
        --arg action "$action_str" \
        --argjson manifest_updated "$manifest_updated_json" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "link_research_to_task"
            },
            "success": true,
            "result": {
                "taskId": $task_id,
                "researchId": $research_id,
                "action": $action,
                "manifestUpdated": $manifest_updated
            }
        }'

    return 0
}

# unlink_research_from_task - Remove link between research and task
# Args: $1 = task ID, $2 = research ID
# Output: JSON result wrapped in CLEO envelope
# Returns: 0 on success, 4 if not found
# Thread Safety: Uses flock for atomic read-modify-write
unlink_research_from_task() {
    local task_id="$1"
    local research_id="$2"
    local manifest_path lock_path
    manifest_path=$(_rm_get_manifest_path)
    lock_path=$(_rm_get_lock_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --arg task_id "$task_id" \
            --arg research_id "$research_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "unlink_research_from_task"
                },
                "success": false,
                "error": {
                    "code": "E_NOT_FOUND",
                    "message": "Manifest file not found",
                    "exitCode": 4
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # Ensure lock file exists
    touch "$lock_path" 2>/dev/null || true

    # Atomic read-modify-write within exclusive flock
    local lock_result
    lock_result=$(
        flock -x 200 2>/dev/null

        # Verify research entry exists (inside lock)
        if ! grep -q "\"id\":\"${research_id}\"" "$manifest_path" 2>/dev/null; then
            echo "NOT_FOUND"
            exit 4
        fi

        # Update manifest entry: remove task_id from linked_tasks array
        local temp_file
        temp_file=$(mktemp)
        local link_removed=false

        while IFS= read -r line || [[ -n "$line" ]]; do
            local line_id
            line_id=$(echo "$line" | jq -r '.id' 2>/dev/null)
            if [[ "$line_id" == "$research_id" ]]; then
                # Check if linked
                local is_linked
                is_linked=$(echo "$line" | jq --arg tid "$task_id" '.linked_tasks // [] | any(. == $tid)')
                if [[ "$is_linked" == "true" ]]; then
                    # Remove task_id from linked_tasks array
                    echo "$line" | jq -c --arg tid "$task_id" '.linked_tasks = [.linked_tasks[] | select(. != $tid)]' >> "$temp_file"
                    link_removed=true
                else
                    echo "$line" >> "$temp_file"
                fi
            else
                echo "$line" >> "$temp_file"
            fi
        done < "$manifest_path"

        # Atomic move (inside lock)
        mv "$temp_file" "$manifest_path"

        # Output result for parent to parse
        if [[ "$link_removed" == "true" ]]; then
            echo "UNLINKED"
        else
            echo "NOT_LINKED"
        fi
        exit 0
    ) 200>"$lock_path"
    local lock_exit=$?

    # Handle not found case
    if [[ "$lock_result" == "NOT_FOUND" ]] || [[ $lock_exit -eq 4 ]]; then
        jq -n \
            --arg task_id "$task_id" \
            --arg research_id "$research_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "unlink_research_from_task"
                },
                "success": false,
                "error": {
                    "code": "E_NOT_FOUND",
                    "message": ("Research entry \"" + $research_id + "\" not found"),
                    "exitCode": 4
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # Handle other errors
    if [[ $lock_exit -ne 0 ]]; then
        jq -n \
            --arg error "Failed to acquire lock or update manifest" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "unlink_research_from_task"
                },
                "success": false,
                "error": {
                    "code": "E_LOCK_FAILED",
                    "message": $error,
                    "exitCode": 8
                }
            }'
        return 8
    fi

    # Convert result to action string
    local action_str manifest_updated_json
    if [[ "$lock_result" == "UNLINKED" ]]; then
        action_str="unlinked"
        manifest_updated_json="true"
    else
        action_str="not_linked"
        manifest_updated_json="false"
    fi

    jq -n \
        --arg task_id "$task_id" \
        --arg research_id "$research_id" \
        --arg action "$action_str" \
        --argjson manifest_updated "$manifest_updated_json" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "unlink_research_from_task"
            },
            "success": true,
            "result": {
                "taskId": $task_id,
                "researchId": $research_id,
                "action": $action,
                "manifestUpdated": $manifest_updated
            }
        }'

    return 0
}

# get_task_research - Get all research entries linked to a task
# Args: $1 = task ID
# Output: JSON array of entries wrapped in CLEO envelope
# Returns: 0 on success
get_task_research() {
    local task_id="$1"
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --arg task_id "$task_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "get_task_research"
                },
                "success": true,
                "result": {
                    "taskId": $task_id,
                    "entries": [],
                    "count": 0
                }
            }'
        return 0
    fi

    # Find entries where linked_tasks contains task_id
    local entries count
    entries=$(jq -s --arg task_id "$task_id" '
        [.[] | select(.linked_tasks // [] | any(. == $task_id))]
    ' "$manifest_path" 2>/dev/null || echo '[]')
    count=$(echo "$entries" | jq 'length')

    jq -n \
        --arg task_id "$task_id" \
        --argjson entries "$entries" \
        --argjson count "$count" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "get_task_research"
            },
            "success": true,
            "result": {
                "taskId": $task_id,
                "entries": $entries,
                "count": $count
            }
        }'

    return 0
}

# get_research_tasks - Get all tasks linked to a research entry
# Args: $1 = research ID
# Output: JSON array of task IDs wrapped in CLEO envelope
# Returns: 0 on success, 4 if not found
get_research_tasks() {
    local research_id="$1"
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --arg research_id "$research_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "get_research_tasks"
                },
                "success": false,
                "error": {
                    "code": "E_NOT_FOUND",
                    "message": "Manifest file not found",
                    "exitCode": 4
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    # Get the entry and return its linked_tasks
    local entry
    entry=$(jq -s --arg id "$research_id" '[.[] | select(.id == $id)] | .[0] // null' "$manifest_path" 2>/dev/null)

    if [[ "$entry" == "null" || -z "$entry" ]]; then
        jq -n \
            --arg research_id "$research_id" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "get_research_tasks"
                },
                "success": false,
                "error": {
                    "code": "E_NOT_FOUND",
                    "message": ("Research entry \"" + $research_id + "\" not found"),
                    "exitCode": 4
                }
            }'
        return "$EXIT_NOT_FOUND"
    fi

    local linked_tasks count
    linked_tasks=$(echo "$entry" | jq '.linked_tasks // []')
    count=$(echo "$linked_tasks" | jq 'length')

    jq -n \
        --arg research_id "$research_id" \
        --argjson linked_tasks "$linked_tasks" \
        --argjson count "$count" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "get_research_tasks"
            },
            "success": true,
            "result": {
                "researchId": $research_id,
                "taskIds": $linked_tasks,
                "count": $count
            }
        }'

    return 0
}

# validate_research_links - Validate all links exist (tasks and research entries)
# Args: none
# Output: JSON report of validation results
# Returns: 0 on success
validate_research_links() {
    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "validate_research_links"
            },
            "success": true,
            "result": {
                "totalEntries": 0,
                "entriesWithLinks": 0,
                "totalLinks": 0,
                "invalidLinks": [],
                "orphanedLinks": [],
                "isValid": true
            }
        }'
        return 0
    fi

    local total_entries entries_with_links total_links invalid_links orphaned_links
    local all_linked_tasks

    # Count entries and gather all linked task IDs
    total_entries=$(wc -l < "$manifest_path" | tr -d ' ')

    # Get entries with linked_tasks and collect all task IDs
    all_linked_tasks=$(jq -s '
        [.[] | select(.linked_tasks != null and (.linked_tasks | length) > 0)] as $entries_with_links |
        {
            "entries_with_links": ($entries_with_links | length),
            "total_links": ([$entries_with_links[].linked_tasks[]] | length),
            "all_task_ids": ([$entries_with_links[] | {research_id: .id, task_ids: .linked_tasks}])
        }
    ' "$manifest_path" 2>/dev/null)

    entries_with_links=$(echo "$all_linked_tasks" | jq '.entries_with_links')
    total_links=$(echo "$all_linked_tasks" | jq '.total_links')

    # Validate each linked task exists (using cleo exists)
    invalid_links="[]"
    local task_entries
    task_entries=$(echo "$all_linked_tasks" | jq -c '.all_task_ids[]')

    while IFS= read -r entry; do
        [[ -z "$entry" ]] && continue
        local research_id task_ids
        research_id=$(echo "$entry" | jq -r '.research_id')
        task_ids=$(echo "$entry" | jq -r '.task_ids[]')

        for task_id in $task_ids; do
            if ! cleo exists "$task_id" --quiet 2>/dev/null; then
                invalid_links=$(echo "$invalid_links" | jq --arg rid "$research_id" --arg tid "$task_id" '. + [{researchId: $rid, taskId: $tid, reason: "task_not_found"}]')
            fi
        done
    done <<< "$task_entries"

    local invalid_count is_valid
    invalid_count=$(echo "$invalid_links" | jq 'length')
    is_valid=$([ "$invalid_count" -eq 0 ] && echo "true" || echo "false")

    jq -n \
        --argjson total_entries "$total_entries" \
        --argjson entries_with_links "$entries_with_links" \
        --argjson total_links "$total_links" \
        --argjson invalid_links "$invalid_links" \
        --argjson is_valid "$is_valid" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "validate_research_links"
            },
            "success": true,
            "result": {
                "totalEntries": $total_entries,
                "entriesWithLinks": $entries_with_links,
                "totalLinks": $total_links,
                "invalidLinks": $invalid_links,
                "isValid": $is_valid
            }
        }'

    return 0
}


# ============================================================================
# MANIFEST ARCHIVAL FUNCTIONS (T1678 - Retention Policy)
# ============================================================================

# Default archival threshold: 50K tokens (~200KB at 4 chars/token)
# Archive 50% oldest entries when exceeded
_RM_ARCHIVE_THRESHOLD_BYTES=200000
_RM_ARCHIVE_PERCENTAGE=50

# Get archive file path
# Returns path to MANIFEST-ARCHIVE.jsonl in agent outputs directory
_rm_get_archive_path() {
    local output_dir
    output_dir=$(_rm_get_output_dir)
    echo "${output_dir}/MANIFEST-ARCHIVE.jsonl"
}

# manifest_check_size - Check if MANIFEST.jsonl exceeds threshold
# Returns JSON with size info and whether archival is needed
# Exit codes: 0 = success, 100 = file doesn't exist
manifest_check_size() {
    local manifest_path threshold_bytes
    manifest_path=$(_rm_get_manifest_path)
    threshold_bytes="${1:-$_RM_ARCHIVE_THRESHOLD_BYTES}"

    if [[ ! -f "$manifest_path" ]]; then
        jq -n \
            --argjson threshold "$threshold_bytes" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "check_size"
                },
                "success": true,
                "result": {
                    "fileExists": false,
                    "currentBytes": 0,
                    "thresholdBytes": $threshold,
                    "needsArchival": false,
                    "percentUsed": 0
                }
            }'
        return "$EXIT_NO_DATA"
    fi

    local current_bytes entry_count percent_used needs_archival
    current_bytes=$(stat -c %s "$manifest_path" 2>/dev/null || stat -f %z "$manifest_path" 2>/dev/null || echo 0)
    entry_count=$(wc -l < "$manifest_path" | tr -d ' ')
    
    # Calculate percent used (avoid division by zero)
    if [[ $threshold_bytes -gt 0 ]]; then
        percent_used=$(( (current_bytes * 100) / threshold_bytes ))
    else
        percent_used=0
    fi
    
    # Determine if archival needed
    if [[ $current_bytes -ge $threshold_bytes ]]; then
        needs_archival="true"
    else
        needs_archival="false"
    fi

    jq -n \
        --argjson current "$current_bytes" \
        --argjson threshold "$threshold_bytes" \
        --argjson entries "$entry_count" \
        --argjson percent "$percent_used" \
        --argjson needs_archival "$needs_archival" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "check_size"
            },
            "success": true,
            "result": {
                "fileExists": true,
                "currentBytes": $current,
                "thresholdBytes": $threshold,
                "entryCount": $entries,
                "percentUsed": $percent,
                "needsArchival": $needs_archival
            }
        }'
    
    return 0
}

# manifest_archive_old - Move oldest entries to MANIFEST-ARCHIVE.jsonl
# Removes oldest N% of entries from MANIFEST.jsonl and appends to archive
# Args: [archive_percentage] - Percentage of entries to archive (default: 50)
# Exit codes: 0 = success, 8 = lock failed, 100 = no entries to archive
manifest_archive_old() {
    local archive_pct manifest_path archive_path lock_path
    archive_pct="${1:-$_RM_ARCHIVE_PERCENTAGE}"
    manifest_path=$(_rm_get_manifest_path)
    archive_path=$(_rm_get_archive_path)
    lock_path="${manifest_path}.archive.lock"

    if [[ ! -f "$manifest_path" ]]; then
        jq -n '{
            "_meta": {
                "command": "research-manifest",
                "operation": "archive_old"
            },
            "success": true,
            "result": {
                "entriesArchived": 0,
                "entriesKept": 0,
                "message": "No manifest file to archive"
            }
        }'
        return "$EXIT_NO_DATA"
    fi

    local total_entries entries_to_archive entries_to_keep
    total_entries=$(wc -l < "$manifest_path" | tr -d ' ')
    
    if [[ $total_entries -le 1 ]]; then
        jq -n \
            --argjson total "$total_entries" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "archive_old"
                },
                "success": true,
                "result": {
                    "entriesArchived": 0,
                    "entriesKept": $total,
                    "message": "Too few entries to archive"
                }
            }'
        return "$EXIT_NO_DATA"
    fi

    # Calculate how many entries to archive (oldest N%)
    entries_to_archive=$(( (total_entries * archive_pct) / 100 ))
    [[ $entries_to_archive -lt 1 ]] && entries_to_archive=1
    entries_to_keep=$(( total_entries - entries_to_archive ))

    # Ensure lock file exists (use different lock file to avoid fd collision)
    touch "$lock_path" 2>/dev/null || true

    # Atomic operation: archive + truncate within exclusive flock
    # Use fd 201 to avoid collision with append_manifest's fd 200
    local lock_result archive_timestamp
    archive_timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    
    lock_result=$(
        flock -x 201 2>/dev/null

        # Read entries to archive (oldest = first N lines)
        local archived_entries
        archived_entries=$(head -n "$entries_to_archive" "$manifest_path")
        
        # Add archive metadata to each entry
        while IFS= read -r entry; do
            [[ -z "$entry" ]] && continue
            # Add archivedAt timestamp to entry
            echo "$entry" | jq -c --arg ts "$archive_timestamp" '. + {archivedAt: $ts}'
        done <<< "$archived_entries" >> "$archive_path"

        # Keep only the newest entries (tail)
        local kept_entries
        kept_entries=$(tail -n "$entries_to_keep" "$manifest_path")
        
        # Atomic overwrite of manifest with kept entries
        echo "$kept_entries" > "${manifest_path}.tmp"
        mv "${manifest_path}.tmp" "$manifest_path"

        echo "SUCCESS"
        exit 0
    ) 201>"$lock_path"
    local lock_exit=$?

    if [[ $lock_exit -ne 0 ]]; then
        jq -n \
            --arg error "Failed to acquire lock for archive operation" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "archive_old"
                },
                "success": false,
                "error": {
                    "code": "E_LOCK_FAILED",
                    "message": $error,
                    "exitCode": 8
                }
            }'
        return 8
    fi

    jq -n \
        --argjson archived "$entries_to_archive" \
        --argjson kept "$entries_to_keep" \
        --arg archive_file "$archive_path" \
        --arg timestamp "$archive_timestamp" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "archive_old"
            },
            "success": true,
            "result": {
                "entriesArchived": $archived,
                "entriesKept": $kept,
                "archiveFile": $archive_file,
                "archivedAt": $timestamp
            }
        }'
    
    return 0
}

# manifest_rotate - Check size and archive if needed
# Orchestrates check_size + archive_old operations
# Args: [threshold_bytes] [archive_percentage]
# Exit codes: 0 = success, 100 = no action needed
manifest_rotate() {
    local threshold_bytes archive_pct
    threshold_bytes="${1:-$_RM_ARCHIVE_THRESHOLD_BYTES}"
    archive_pct="${2:-$_RM_ARCHIVE_PERCENTAGE}"

    # Check current size
    local size_result needs_archival
    size_result=$(manifest_check_size "$threshold_bytes")
    needs_archival=$(echo "$size_result" | jq -r '.result.needsArchival')

    if [[ "$needs_archival" != "true" ]]; then
        local current_bytes percent_used
        current_bytes=$(echo "$size_result" | jq '.result.currentBytes')
        percent_used=$(echo "$size_result" | jq '.result.percentUsed')
        
        jq -n \
            --argjson current "$current_bytes" \
            --argjson threshold "$threshold_bytes" \
            --argjson percent "$percent_used" \
            '{
                "_meta": {
                    "command": "research-manifest",
                    "operation": "rotate"
                },
                "success": true,
                "result": {
                    "action": "none",
                    "reason": "Below threshold",
                    "currentBytes": $current,
                    "thresholdBytes": $threshold,
                    "percentUsed": $percent
                }
            }'
        return "$EXIT_NO_CHANGE"
    fi

    # Archive old entries
    local archive_result
    archive_result=$(manifest_archive_old "$archive_pct")
    local archive_exit=$?

    if [[ $archive_exit -ne 0 ]] && [[ $archive_exit -ne "$EXIT_NO_DATA" ]]; then
        echo "$archive_result"
        return $archive_exit
    fi

    # Get post-archive stats
    local post_size_result post_bytes post_percent entries_archived entries_kept
    post_size_result=$(manifest_check_size "$threshold_bytes")
    post_bytes=$(echo "$post_size_result" | jq '.result.currentBytes')
    post_percent=$(echo "$post_size_result" | jq '.result.percentUsed')
    entries_archived=$(echo "$archive_result" | jq '.result.entriesArchived')
    entries_kept=$(echo "$archive_result" | jq '.result.entriesKept')

    jq -n \
        --argjson archived "$entries_archived" \
        --argjson kept "$entries_kept" \
        --argjson bytes_before "$(echo "$size_result" | jq '.result.currentBytes')" \
        --argjson bytes_after "$post_bytes" \
        --argjson threshold "$threshold_bytes" \
        --argjson percent_after "$post_percent" \
        '{
            "_meta": {
                "command": "research-manifest",
                "operation": "rotate"
            },
            "success": true,
            "result": {
                "action": "archived",
                "entriesArchived": $archived,
                "entriesKept": $kept,
                "bytesBefore": $bytes_before,
                "bytesAfter": $bytes_after,
                "thresholdBytes": $threshold,
                "percentUsedAfter": $percent_after
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
# ============================================================================
# AUDIT FIELD HELPERS (T2578 - Lifecycle Enforcement v2.10.0)
# ============================================================================

# create_audit_object - Generate audit object for new manifest entries
# Args:
#   $1 = created_by (agent ID, format: {role}-agent-{taskId})
#   $2 = lifecycle_state (research|consensus|specification|decomposition|implementation|validation|testing|release)
#   $3 = provenance_chain (optional, JSON array as string)
# Returns: JSON object for audit field
# Exit codes: 0 on success, 6 on validation error
create_audit_object() {
    local created_by="$1"
    local lifecycle_state="$2"
    local provenance_chain="${3:-[]}"

    # Validate created_by format
    if ! [[ "$created_by" =~ ^[a-z]+-agent-T[0-9]+$ ]]; then
        echo "ERROR: Invalid created_by format: $created_by (must match {role}-agent-T####)" >&2
        return "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # Validate lifecycle_state
    case "$lifecycle_state" in
        research|consensus|specification|decomposition|implementation|validation|testing|release) ;;
        *)
            echo "ERROR: Invalid lifecycle_state: $lifecycle_state" >&2
            return "${EXIT_VALIDATION_ERROR:-6}"
            ;;
    esac

    # Generate current timestamp
    local created_at
    created_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build audit object
    jq -nc \
        --arg created_by "$created_by" \
        --arg created_at "$created_at" \
        --arg lifecycle_state "$lifecycle_state" \
        --argjson provenance_chain "$provenance_chain" \
        '{
            created_by: $created_by,
            created_at: $created_at,
            validated_by: null,
            validated_at: null,
            validation_status: "pending",
            tested_by: null,
            tested_at: null,
            lifecycle_state: $lifecycle_state,
            provenance_chain: $provenance_chain
        }'
}

# validate_audit_object - Validate audit object against schema requirements
# Args: $1 = JSON entry with audit object
# Returns: 0 if valid, 6 (EXIT_VALIDATION_ERROR) if invalid, 82 (EXIT_CIRCULAR_VALIDATION) if circular
# Output: Error message to stderr on failure
validate_audit_object() {
    local json="$1"

    # Check if audit object exists
    if ! echo "$json" | jq -e 'has("audit")' >/dev/null 2>&1; then
        # Audit is optional for backward compatibility
        return 0
    fi

    local audit
    audit=$(echo "$json" | jq -r '.audit')

    # Validate required audit fields
    local required_fields=("created_by" "created_at" "lifecycle_state")
    local missing_fields=()

    for field in "${required_fields[@]}"; do
        if ! echo "$audit" | jq -e "has(\"$field\")" >/dev/null 2>&1; then
            missing_fields+=("$field")
        fi
    done

    if [[ ${#missing_fields[@]} -gt 0 ]]; then
        echo "ERROR: Missing required audit fields: ${missing_fields[*]}" >&2
        return "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # Validate created_by format
    local created_by
    created_by=$(echo "$audit" | jq -r '.created_by')
    if ! [[ "$created_by" =~ ^[a-z]+-agent-T[0-9]+$ ]]; then
        echo "ERROR: Invalid audit.created_by format: $created_by" >&2
        return "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # Validate lifecycle_state enum
    local lifecycle_state
    lifecycle_state=$(echo "$audit" | jq -r '.lifecycle_state')
    case "$lifecycle_state" in
        research|consensus|specification|decomposition|implementation|validation|testing|release) ;;
        *)
            echo "ERROR: Invalid audit.lifecycle_state: $lifecycle_state" >&2
            return "${EXIT_VALIDATION_ERROR:-6}"
            ;;
    esac

    # Validate validation_status if present
    local validation_status
    validation_status=$(echo "$audit" | jq -r '.validation_status // "pending"')
    case "$validation_status" in
        pending|in_review|approved|rejected|needs_revision) ;;
        *)
            echo "ERROR: Invalid audit.validation_status: $validation_status" >&2
            return "${EXIT_VALIDATION_ERROR:-6}"
            ;;
    esac

    # Check circular validation (1-hop)
    local validated_by tested_by
    validated_by=$(echo "$audit" | jq -r '.validated_by // empty')
    tested_by=$(echo "$audit" | jq -r '.tested_by // empty')

    if [[ -n "$validated_by" && "$validated_by" == "$created_by" ]]; then
        echo "ERROR: Circular validation detected: validated_by ($validated_by) == created_by ($created_by)" >&2
        return "${EXIT_CIRCULAR_VALIDATION:-82}"
    fi

    if [[ -n "$tested_by" && "$tested_by" == "$created_by" ]]; then
        echo "ERROR: Circular validation detected: tested_by ($tested_by) == created_by ($created_by)" >&2
        return "${EXIT_CIRCULAR_VALIDATION:-82}"
    fi

    if [[ -n "$tested_by" && -n "$validated_by" && "$tested_by" == "$validated_by" ]]; then
        echo "ERROR: Circular validation detected: tested_by ($tested_by) == validated_by ($validated_by)" >&2
        return "${EXIT_CIRCULAR_VALIDATION:-82}"
    fi

    return 0
}

# check_circular_validation - Check for circular validation in provenance chain (N-hop)
# Args:
#   $1 = agent_id to check
#   $2 = provenance_chain (JSON array)
# Returns: 0 if no cycles, 82 (EXIT_CIRCULAR_VALIDATION) if cycle detected
check_circular_validation() {
    local agent_id="$1"
    local provenance_chain="$2"

    # Extract all agent IDs from provenance chain
    local chain_agents
    chain_agents=$(echo "$provenance_chain" | jq -r '.[] | select(type == "object") | .id // empty')

    # Check if agent_id appears in chain
    while IFS= read -r chain_agent; do
        if [[ "$chain_agent" == "$agent_id" ]]; then
            echo "ERROR: Circular validation detected: $agent_id appears in provenance chain" >&2
            return "${EXIT_CIRCULAR_VALIDATION:-82}"
        fi
    done <<< "$chain_agents"

    return 0
}

# update_audit_validation - Update audit object with validation information
# Args:
#   $1 = entry_id (manifest entry ID)
#   $2 = validated_by (agent ID)
#   $3 = validation_status (pending|in_review|approved|rejected|needs_revision)
# Returns: 0 on success, error code on failure
update_audit_validation() {
    local entry_id="$1"
    local validated_by="$2"
    local validation_status="$3"

    # Validate validated_by format
    if ! [[ "$validated_by" =~ ^[a-z]+-agent-T[0-9]+$ ]]; then
        echo "ERROR: Invalid validated_by format: $validated_by" >&2
        return "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # Validate validation_status enum
    case "$validation_status" in
        pending|in_review|approved|rejected|needs_revision) ;;
        *)
            echo "ERROR: Invalid validation_status: $validation_status" >&2
            return "${EXIT_VALIDATION_ERROR:-6}"
            ;;
    esac

    local manifest_path
    manifest_path=$(_rm_get_manifest_path)

    if [[ ! -f "$manifest_path" ]]; then
        echo "ERROR: Manifest file not found: $manifest_path" >&2
        return "${EXIT_FILE_NOT_FOUND:-4}"
    fi

    # Get entry
    local entry
    entry=$(grep -F "\"id\":\"$entry_id\"" "$manifest_path" || true)

    if [[ -z "$entry" ]]; then
        echo "ERROR: Entry not found: $entry_id" >&2
        return "${EXIT_NOT_FOUND:-4}"
    fi

    # Check circular validation
    local created_by
    created_by=$(echo "$entry" | jq -r '.audit.created_by // empty')

    if [[ "$validated_by" == "$created_by" ]]; then
        echo "ERROR: Circular validation: validated_by ($validated_by) == created_by ($created_by)" >&2
        return "${EXIT_CIRCULAR_VALIDATION:-82}"
    fi

    # Update entry (this would typically use the update_entry function)
    # For now, this is a placeholder - full implementation would modify the manifest
    echo "TODO: Implement manifest update with validation fields" >&2
    return 0
}

export -f create_audit_object
export -f validate_audit_object
export -f check_circular_validation
export -f update_audit_validation
export -f get_pending_followup
export -f get_entry_by_id
export -f get_latest_by_topic
export -f task_has_research
export -f get_followup_tasks
export -f update_entry
export -f link_research_to_task
export -f unlink_research_from_task
export -f get_task_research
export -f get_research_tasks
export -f validate_research_links
export -f manifest_check_size
export -f manifest_archive_old
export -f manifest_rotate
export -f get_manifest_stats
export -f compact_manifest
export -f list_archived_entries
