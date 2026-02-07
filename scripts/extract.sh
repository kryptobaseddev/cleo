#!/usr/bin/env bash
###CLEO
# command: extract
# category: sync
# synopsis: Extract/merge TodoWrite state back to cleo (session end)
# relevance: high
# flags: --format,--quiet,--dry-run
# exits: 0,2,3,6
# json-output: true
# note: Usually called via 'sync --extract'
###END
# =============================================================================
# extract.sh - Merge TodoWrite state back to cleo
# =============================================================================
# Parses TodoWrite JSON state, recovers task IDs from content prefix,
# and merges changes back to cleo. Used at session end.
#
# Research: T227 (todowrite-sync-research.md)
#
# Diff Detection:
#   - completed: Task marked completed in TodoWrite → mark done in cleo
#   - progressed: Task moved to in_progress → update notes
#   - new_tasks: Items without [T###] prefix → create in cleo
#   - removed: Injected task not in TodoWrite → log only (no delete)
#
# Usage:
#   cleo sync --extract [FILE]
#   ./extract.sh <todowrite-state.json>
#
# Options:
#   --dry-run         Show what would change without modifying
#   --quiet, -q       Suppress info messages
#   --help, -h        Show this help
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Load VERSION from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Source required libraries
source "$LIB_DIR/todowrite-integration.sh"

# Source output formatting library
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  # shellcheck source=../lib/output-format.sh
  source "$LIB_DIR/output-format.sh"
fi

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/exit-codes.sh
  source "$LIB_DIR/exit-codes.sh"
fi

# Source validation library for input validation
if [[ -f "$LIB_DIR/validation.sh" ]]; then
  # shellcheck source=../lib/validation.sh
  source "$LIB_DIR/validation.sh"
elif [[ -f "$CLEO_HOME/lib/validation.sh" ]]; then
  source "$CLEO_HOME/lib/validation.sh"
fi

# Source flags library for standardized flag parsing
if [[ -f "$LIB_DIR/flags.sh" ]]; then
  # shellcheck source=../lib/flags.sh
  source "$LIB_DIR/flags.sh"
fi

# =============================================================================
# Colors and Logging
# =============================================================================
if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' NC=''
fi

log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_warn() { [[ "${QUIET:-false}" != "true" ]] && echo -e "${YELLOW}[WARN]${NC} $1" >&2 || true; }
log_info() { [[ "${QUIET:-false}" != "true" ]] && echo -e "${GREEN}[INFO]${NC} $1" >&2 || true; }

# =============================================================================
# Configuration
# =============================================================================
TODO_FILE=".cleo/todo.json"
SYNC_DIR=".cleo/sync"
STATE_FILE="${SYNC_DIR}/todowrite-session.json"
LOG_FILE=".cleo/todo-log.json"
TODOWRITE_INPUT=""
DRY_RUN=false
QUIET=false
DEFAULT_PHASE=""
COMMAND_NAME="extract"
FORMAT=""

# =============================================================================
# Help
# =============================================================================
show_help() {
    cat << 'EOF'
extract.sh - Merge TodoWrite state back to cleo

USAGE
    cleo sync --extract [FILE]
    ./extract.sh <todowrite-state.json>

DESCRIPTION
    Parses TodoWrite JSON state from Claude's session, recovers task IDs
    from content prefixes, detects changes, and merges updates back to
    the persistent cleo system.

DIFF DETECTION
    completed    Task status=completed → mark done in cleo
    progressed   Task status=in_progress (was pending) → update to active
    new_tasks    No [T###] prefix → create new task in cleo
    removed      Injected ID missing → log only (no deletion)

CONFLICT RESOLUTION
    - cleo is authoritative for task existence
    - TodoWrite is authoritative for session progress
    - Warn but don't fail on conflicts

OPTIONS
    --default-phase SLUG  Override default phase for new tasks (without [T###] prefix)
    --dry-run             Show changes without modifying files
    --quiet, -q           Suppress info messages
    --help, -h            Show this help

INPUT FORMAT
    {
      "todos": [
        {"content": "[T001] Task", "status": "completed", "activeForm": "..."},
        {"content": "New task", "status": "pending", "activeForm": "..."}
      ]
    }

EXAMPLES
    # Extract from file
    cleo sync --extract /tmp/todowrite-state.json

    # Dry run to preview changes
    cleo sync --extract --dry-run /tmp/todowrite-state.json

    # Override default phase for new tasks
    cleo sync --extract --default-phase polish /tmp/todowrite-state.json

EOF
    exit "$EXIT_SUCCESS"
}

# =============================================================================
# Argument Parsing
# =============================================================================
parse_args() {
    # Parse common flags first using lib/flags.sh
    init_flag_defaults
    parse_common_flags "$@"
    set -- "${REMAINING_ARGS[@]}"

    # Bridge to legacy variables for compatibility
    apply_flags_to_globals

    # Handle help early if requested
    if [[ "$FLAG_HELP" == "true" ]]; then
        show_help
    fi

    # Parse command-specific flags
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --default-phase)
                DEFAULT_PHASE="$2"
                shift 2
                ;;
            --help|-h)
                show_help
                ;;
            -*)
                if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                    output_error "E_INPUT_INVALID" "Unknown option: $1" 1 true "Use --help to see valid options"
                else
                    log_error "Unknown option: $1"
                fi
                exit "$EXIT_INVALID_INPUT"
                ;;
            *)
                if [[ -z "$TODOWRITE_INPUT" ]]; then
                    TODOWRITE_INPUT="$1"
                else
                    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                        output_error "E_INPUT_INVALID" "Unexpected argument: $1" 1 true "Only one input file expected"
                    else
                        log_error "Unexpected argument: $1"
                    fi
                    exit "$EXIT_INVALID_INPUT"
                fi
                shift
                ;;
        esac
    done
}

# =============================================================================
# Core Functions
# =============================================================================

# Parse task ID from content prefix: "[T001] ..." → "T001"
parse_task_id() {
    local content="$1"
    if [[ "$content" =~ ^\[T([0-9]+)\] ]]; then
        echo "T${BASH_REMATCH[1]}"
    else
        echo ""
    fi
}

# Strip prefixes from content to get clean title
strip_prefixes() {
    local content="$1"
    # Remove [T###], [!], [BLOCKED] prefixes
    echo "$content" | sed -E 's/^\[T[0-9]+\]\s*//' | sed -E 's/^\[!\]\s*//' | sed -E 's/^\[BLOCKED\]\s*//'
}

# Load session state (injected task IDs)
load_session_state() {
    if [[ -f "$STATE_FILE" ]]; then
        jq -r '.injected_tasks[]' "$STATE_FILE" 2>/dev/null || true
    fi
}

# Analyze TodoWrite state and detect changes
analyze_changes() {
    local todowrite_json="$1"
    local state_file="$2"

    # Get injected task IDs from session state
    local injected_ids=()
    if [[ -f "$state_file" ]]; then
        while IFS= read -r id; do
            [[ -n "$id" ]] && injected_ids+=("$id")
        done < <(jq -r '.injected_tasks[]' "$state_file" 2>/dev/null || true)
    fi

    # Track what we find in TodoWrite
    local found_ids=()
    local completed_ids=()
    local progressed_ids=()
    local new_tasks=()

    # Process each TodoWrite item
    while IFS= read -r item; do
        local content=$(echo "$item" | jq -r '.content // ""')
        local status=$(echo "$item" | jq -r '.status // "pending"')

        local task_id
        task_id=$(parse_task_id "$content")

        if [[ -n "$task_id" ]]; then
            found_ids+=("$task_id")

            if [[ "$status" == "completed" ]]; then
                completed_ids+=("$task_id")
            elif [[ "$status" == "in_progress" ]]; then
                progressed_ids+=("$task_id")
            fi
        else
            # New task (no ID prefix)
            local clean_title
            clean_title=$(strip_prefixes "$content")
            new_tasks+=("$clean_title")
        fi
    done < <(echo "$todowrite_json" | jq -c '.todos[]' 2>/dev/null || true)

    # Find removed IDs (in injected but not in found)
    local removed_ids=()
    for id in "${injected_ids[@]}"; do
        local found=false
        for fid in "${found_ids[@]}"; do
            [[ "$id" == "$fid" ]] && found=true && break
        done
        [[ "$found" == "false" ]] && removed_ids+=("$id")
    done

    # Output as JSON
    jq -nc \
        --argjson completed "$(printf '%s\n' "${completed_ids[@]}" | jq -R . | jq -s .)" \
        --argjson progressed "$(printf '%s\n' "${progressed_ids[@]}" | jq -R . | jq -s .)" \
        --argjson new_tasks "$(printf '%s\n' "${new_tasks[@]}" | jq -R . | jq -s .)" \
        --argjson removed "$(printf '%s\n' "${removed_ids[@]}" | jq -R . | jq -s .)" \
        '{completed: $completed, progressed: $progressed, new_tasks: $new_tasks, removed: $removed}'
}

# Apply changes to cleo
apply_changes() {
    local changes_json="$1"
    local todo_file="$2"
    local dry_run="$3"

    local completed=$(echo "$changes_json" | jq -r '.completed[]' 2>/dev/null || true)
    local progressed=$(echo "$changes_json" | jq -r '.progressed[]' 2>/dev/null || true)
    local new_tasks=$(echo "$changes_json" | jq -r '.new_tasks[]' 2>/dev/null || true)
    local removed=$(echo "$changes_json" | jq -r '.removed[]' 2>/dev/null || true)

    local changes_made=0

    # Phase inheritance for new tasks (T258)
    # Priority order:
    # 1. --default-phase flag (explicit override)
    # 2. focus task phase from session metadata
    # 3. most active phase (phase with most non-done tasks)
    # 4. project.currentPhase (automatic via add.sh)
    # 5. config.defaults.phase (automatic via add.sh)
    local inherit_phase=""
    local phase_source=""

    # 1. Check for explicit --default-phase flag override
    if [[ -n "$DEFAULT_PHASE" ]]; then
        inherit_phase="$DEFAULT_PHASE"
        phase_source="flag"
    # 2. Try focused task's phase from session metadata
    elif [[ -f "$STATE_FILE" ]]; then
        local focus_id
        focus_id=$(jq -r '.injected_tasks[0] // ""' "$STATE_FILE" 2>/dev/null || echo "")

        if [[ -n "$focus_id" ]]; then
            inherit_phase=$(jq -r ".task_metadata.\"$focus_id\".phase // \"\"" "$STATE_FILE" 2>/dev/null || echo "")
            if [[ -n "$inherit_phase" && "$inherit_phase" != "null" ]]; then
                phase_source="focus"
            fi
        fi
    fi

    # 3. Fallback to most active phase (phase with most non-done tasks)
    if [[ -z "$inherit_phase" || "$inherit_phase" == "null" ]]; then
        inherit_phase=$(jq -r '
            [.tasks[] | select(.status != "done") | .phase // empty] |
            group_by(.) |
            map({phase: .[0], count: length}) |
            sort_by(-.count) |
            .[0].phase // ""
        ' "$todo_file" 2>/dev/null || echo "")

        if [[ -n "$inherit_phase" && "$inherit_phase" != "null" ]]; then
            phase_source="most-active"
        else
            inherit_phase=""
        fi
    fi

    # 4. Final fallback to project.currentPhase handled by add.sh

    # Process completed tasks
    while IFS= read -r task_id; do
        [[ -z "$task_id" ]] && continue

        # Check if task exists and isn't already done
        local current_status
        current_status=$(jq -r ".tasks[] | select(.id == \"$task_id\") | .status" "$todo_file" 2>/dev/null || echo "")

        if [[ -z "$current_status" ]]; then
            log_warn "Task $task_id not found in cleo (may have been deleted)"
            continue
        fi

        if [[ "$current_status" == "done" ]]; then
            log_info "Task $task_id already done (idempotent)"
            continue
        fi

        if [[ "$dry_run" == "true" ]]; then
            log_info "[DRY RUN] Would complete: $task_id"
        else
            # Use complete.sh for proper completion
            "$SCRIPT_DIR/complete.sh" "$task_id" --notes "Completed via TodoWrite session sync" --skip-archive >/dev/null 2>&1 || {
                log_warn "Failed to complete $task_id"
                continue
            }
            log_info "Completed: $task_id"
        fi
        ((changes_made++))
    done <<< "$completed"

    # Process progressed tasks (in_progress → active)
    while IFS= read -r task_id; do
        [[ -z "$task_id" ]] && continue

        local current_status
        current_status=$(jq -r ".tasks[] | select(.id == \"$task_id\") | .status" "$todo_file" 2>/dev/null || echo "")

        if [[ -z "$current_status" ]]; then
            log_warn "Task $task_id not found"
            continue
        fi

        # Only update if was pending/blocked, now progressed
        if [[ "$current_status" == "pending" || "$current_status" == "blocked" ]]; then
            if [[ "$dry_run" == "true" ]]; then
                log_info "[DRY RUN] Would mark active: $task_id"
            else
                "$SCRIPT_DIR/update.sh" "$task_id" --status active --notes "Progressed during TodoWrite session" >/dev/null 2>&1 || {
                    log_warn "Failed to update $task_id"
                    continue
                }
                log_info "Marked active: $task_id"
            fi
            ((changes_made++))
        fi
    done <<< "$progressed"

    # Process new tasks
    # Phase inheritance strategy:
    # 1. Use focused task's phase from session metadata (if available)
    # 2. Fall back to project.currentPhase (automatic via add.sh)
    # 3. Fall back to config.defaults.phase (automatic via add.sh)
    while IFS= read -r title; do
        [[ -z "$title" ]] && continue

        if [[ "$dry_run" == "true" ]]; then
            log_info "[DRY RUN] Would create: $title"
        else
            local new_id
            local add_args=(
                "$title"
                --labels "session-created"
                --description "Created during TodoWrite session"
                --quiet
            )

            # Add phase flag if we have phase metadata from session
            if [[ -n "$inherit_phase" ]]; then
                add_args+=(--phase "$inherit_phase")
            fi

            new_id=$("$SCRIPT_DIR/add.sh" "${add_args[@]}" 2>/dev/null || echo "")
            if [[ -n "$new_id" ]]; then
                if [[ -n "$inherit_phase" ]]; then
                    log_info "Created: $new_id - $title (phase: $inherit_phase, source: $phase_source)"
                else
                    log_info "Created: $new_id - $title (no phase inherited)"
                fi
            else
                log_warn "Failed to create task: $title"
            fi
        fi
        ((changes_made++))
    done <<< "$new_tasks"

    # Log removed tasks (no action, just informational)
    while IFS= read -r task_id; do
        [[ -z "$task_id" ]] && continue
        log_info "Removed from session (no action): $task_id"
    done <<< "$removed"

    echo "$changes_made"
}

# =============================================================================
# Main
# =============================================================================
main() {
    parse_args "$@"

    # Resolve format (TTY-aware auto-detection)
    FORMAT=$(resolve_format "${FORMAT:-}")

    # Validate inputs
    if [[ -z "$TODOWRITE_INPUT" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_INPUT_MISSING" "TodoWrite state file required" 1 true "Usage: extract.sh <todowrite-state.json>"
        else
            log_error "TodoWrite state file required"
            echo "Usage: extract.sh <todowrite-state.json>"
        fi
        exit "$EXIT_INVALID_INPUT"
    fi

    if [[ ! -f "$TODOWRITE_INPUT" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_FILE_NOT_FOUND" "File not found: $TODOWRITE_INPUT" 1 true "Check the file path exists"
        else
            log_error "File not found: $TODOWRITE_INPUT"
        fi
        exit "$EXIT_NOT_FOUND"
    fi

    if [[ ! -f "$TODO_FILE" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_NOT_INITIALIZED" "todo.json not found at $TODO_FILE" 1 true "Run 'cleo init' first"
        else
            log_error "todo.json not found at $TODO_FILE"
        fi
        exit "$EXIT_NOT_INITIALIZED"
    fi

    # Load TodoWrite state
    local todowrite_json
    todowrite_json=$(cat "$TODOWRITE_INPUT")

    # Validate JSON
    if ! echo "$todowrite_json" | jq . >/dev/null 2>&1; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_INPUT_INVALID" "Invalid JSON in $TODOWRITE_INPUT" 1 true "Ensure file contains valid JSON"
        else
            log_error "Invalid JSON in $TODOWRITE_INPUT"
        fi
        exit "$EXIT_INVALID_INPUT"
    fi

    log_info "Analyzing TodoWrite state..."

    # Check for phase changes during session
    if [[ -f "$STATE_FILE" ]]; then
        local injected_phase
        injected_phase=$(jq -r '.injectedPhase // ""' "$STATE_FILE" 2>/dev/null || echo "")

        local current_phase
        current_phase=$(jq -r '(if (.project | type) == "object" then .project.currentPhase else null end) // ""' "$TODO_FILE" 2>/dev/null || echo "")

        # Warn if phase changed during session
        if [[ -n "$injected_phase" && -n "$current_phase" && "$injected_phase" != "$current_phase" ]]; then
            log_warn "Project phase changed during session: '$injected_phase' → '$current_phase'"
            log_warn "New tasks will use current phase unless --default-phase is specified"
        fi
    fi

    # Analyze changes
    local changes_json
    changes_json=$(analyze_changes "$todowrite_json" "$STATE_FILE")

    # Show summary
    local completed_count=$(echo "$changes_json" | jq '.completed | length')
    local progressed_count=$(echo "$changes_json" | jq '.progressed | length')
    local new_count=$(echo "$changes_json" | jq '.new_tasks | length')
    local removed_count=$(echo "$changes_json" | jq '.removed | length')

    log_info "Changes detected: $completed_count completed, $progressed_count progressed, $new_count new, $removed_count removed"

    if [[ "$completed_count" -eq 0 && "$progressed_count" -eq 0 && "$new_count" -eq 0 ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local version
            if [[ -f "${SCRIPT_DIR}/../VERSION" ]]; then
                version=$(cat "${SCRIPT_DIR}/../VERSION")
            else
                version="0.16.0"
            fi
            jq -nc \
                --arg version "$version" \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "extract",
                        "timestamp": $timestamp
                    },
                    "success": true,
                    "message": "No changes to apply",
                    "changes": {
                        "completed": 0,
                        "progressed": 0,
                        "new": 0,
                        "removed": 0,
                        "applied": 0
                    }
                }'
        else
            log_info "No changes to apply"
        fi
        exit "$EXIT_SUCCESS"
    fi

    # Apply changes
    local changes_made
    changes_made=$(apply_changes "$changes_json" "$TODO_FILE" "$DRY_RUN")

    if [[ "$FORMAT" == "json" ]]; then
        local version
        if [[ -f "${SCRIPT_DIR}/../VERSION" ]]; then
            version=$(cat "${SCRIPT_DIR}/../VERSION")
        else
            version="0.16.0"
        fi

        if [[ "$DRY_RUN" == "true" ]]; then
            jq -nc \
                --arg version "$version" \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                --argjson completed "$completed_count" \
                --argjson progressed "$progressed_count" \
                --argjson new "$new_count" \
                --argjson removed "$removed_count" \
                --argjson applied "$changes_made" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "extract",
                        "timestamp": $timestamp
                    },
                    "success": true,
                    "dryRun": true,
                    "message": "Dry run complete",
                    "changes": {
                        "completed": $completed,
                        "progressed": $progressed,
                        "new": $new,
                        "removed": $removed,
                        "wouldApply": $applied
                    }
                }'
        else
            # Clean up session state file
            if [[ -f "$STATE_FILE" ]]; then
                rm -f "$STATE_FILE"
            fi

            jq -nc \
                --arg version "$version" \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                --argjson completed "$completed_count" \
                --argjson progressed "$progressed_count" \
                --argjson new "$new_count" \
                --argjson removed "$removed_count" \
                --argjson applied "$changes_made" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "extract",
                        "timestamp": $timestamp
                    },
                    "success": true,
                    "dryRun": false,
                    "message": "Changes applied successfully",
                    "changes": {
                        "completed": $completed,
                        "progressed": $progressed,
                        "new": $new,
                        "removed": $removed,
                        "applied": $applied
                    },
                    "sessionCleared": true
                }'
        fi
    else
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "Dry run complete. Would apply $changes_made changes."
        else
            log_info "Applied $changes_made changes"

            # Clean up session state file
            if [[ -f "$STATE_FILE" ]]; then
                rm -f "$STATE_FILE"
                log_info "Session state cleared"
            fi
        fi
    fi
}

main "$@"
