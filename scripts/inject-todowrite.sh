#!/usr/bin/env bash
# =============================================================================
# inject-todowrite.sh - Prepare cleo tasks for TodoWrite injection
# =============================================================================
# Transforms cleo tasks into TodoWrite JSON format with ID prefix
# embedding for round-trip tracking. Used at session start.
#
# Research: T227 (todowrite-sync-research.md)
#
# Format: [T###] [!]? [BLOCKED]? <title>
#   - [T###] = Task ID prefix (required for round-trip)
#   - [!] = High/critical priority marker (optional)
#   - [BLOCKED] = Blocked status marker (optional)
#
# Usage:
#   cleo sync --inject
#   ./inject-todowrite.sh [OPTIONS]
#
# Options:
#   --max-tasks N     Maximum tasks to inject (default: 8)
#   --focused-only    Only inject the focused task
#   --phase SLUG      Filter tasks to specific phase (default: project.currentPhase)
#   --output FILE     Write to file instead of stdout
#   --save-state      Save session state for extraction (default: true)
#   --help, -h        Show this help
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

# Source version library for proper version management
if [[ -f "$LIB_DIR/version.sh" ]]; then
  # shellcheck source=../lib/version.sh
  source "$LIB_DIR/version.sh"
fi

# Source version from central location (fallback)
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Source required libraries
source "$LIB_DIR/todowrite-integration.sh"

# Source validation library
if [[ -f "$LIB_DIR/validation.sh" ]]; then
  # shellcheck source=../lib/validation.sh
  source "$LIB_DIR/validation.sh"
fi

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
MAX_TASKS=8
FOCUSED_ONLY=false
PHASE_FILTER=""
COMMAND_NAME="inject"
OUTPUT_FILE=""
SAVE_STATE=true
QUIET=false
FORMAT=""
DRY_RUN=false

# =============================================================================
# Help
# =============================================================================
show_help() {
    cat << 'EOF'
inject-todowrite.sh - Prepare tasks for TodoWrite injection

USAGE
    cleo sync --inject [OPTIONS]
    ./inject-todowrite.sh [OPTIONS]

DESCRIPTION
    Transforms cleo tasks into TodoWrite JSON format with embedded
    task IDs for round-trip tracking. Called at session start to populate
    Claude's ephemeral todo list.

    Selection Strategy (tiered):
      Tier 1: Current focused task (always included)
      Tier 2: Direct dependencies of focused task
      Tier 3: Other high-priority tasks in same phase

OPTIONS
    --max-tasks N     Maximum tasks to inject (default: 8)
    --focused-only    Only inject the currently focused task
    --phase SLUG      Filter to specific phase (default: project.currentPhase if set)
    --output FILE     Write JSON to file instead of stdout
    --no-save-state   Don't save session state file
    --dry-run         Show what would be injected without saving state
    --quiet, -q       Suppress info messages
    --help, -h        Show this help

OUTPUT FORMAT
    {
      "todos": [
        {
          "content": "[T001] [!] Task title",
          "status": "in_progress",
          "activeForm": "Working on task title"
        }
      ]
    }

CONTENT PREFIX FORMAT
    [T###]           Task ID (always present)
    [!]              High/critical priority marker
    [BLOCKED]        Blocked status (mapped to pending)
    [phase]          Phase slug (if task has phase)

EXAMPLES
    # Inject focused task and dependencies
    cleo sync --inject

    # Inject only focused task
    cleo sync --inject --focused-only

    # Inject tasks for specific phase
    cleo sync --inject --phase core

    # Save to file for debugging
    cleo sync --inject --output /tmp/inject.json

EOF
    exit "$EXIT_SUCCESS"
}

# =============================================================================
# Argument Parsing
# =============================================================================
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --max-tasks)
                MAX_TASKS="$2"
                shift 2
                ;;
            --focused-only)
                FOCUSED_ONLY=true
                shift
                ;;
            --phase)
                PHASE_FILTER="$2"
                shift 2
                ;;
            --output)
                OUTPUT_FILE="$2"
                shift 2
                ;;
            --no-save-state)
                SAVE_STATE=false
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --quiet|-q)
                QUIET=true
                shift
                ;;
            -f|--format)
                FORMAT="$2"
                shift 2
                ;;
            --json)
                FORMAT="json"
                shift
                ;;
            --human)
                FORMAT="text"
                shift
                ;;
            --help|-h)
                show_help
                ;;
            *)
                if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_INVALID" "Unknown option: $1" 1 true "Use --help to see valid options"
                else
                    output_error "$E_INPUT_INVALID" "Unknown option: $1"
                fi
                exit "$EXIT_INVALID_INPUT"
                ;;
        esac
    done
}

# =============================================================================
# Core Functions
# =============================================================================

# Format task content with ID prefix and markers
format_task_content() {
    local id="$1"
    local title="$2"
    local priority="$3"
    local status="$4"
    local phase="${5:-}"

    local content="[${id}]"

    # Add priority marker for high/critical
    if [[ "$priority" == "high" || "$priority" == "critical" ]]; then
        content="${content} [!]"
    fi

    # Add blocked marker
    if [[ "$status" == "blocked" ]]; then
        content="${content} [BLOCKED]"
    fi

    # Add phase marker if present
    if [[ -n "$phase" ]]; then
        content="${content} [${phase}]"
    fi

    content="${content} ${title}"
    echo "$content"
}

# Get tasks to inject based on tiered selection
get_tasks_to_inject() {
    local todo_file="$1"
    local max_tasks="$2"
    local focused_only="$3"
    local phase_filter="$4"

    # Get focused task ID
    local focus_id
    focus_id=$(jq -r '.focus.currentTask // ""' "$todo_file")

    # Determine phase filter: explicit --phase > project.currentPhase > no filter
    local effective_phase="$phase_filter"
    if [[ -z "$effective_phase" ]]; then
        effective_phase=$(jq -r '.project.currentPhase // ""' "$todo_file")
    fi

    if [[ "$focused_only" == "true" && -n "$focus_id" ]]; then
        # Only return focused task (exclude if cancelled)
        jq -c "[.tasks[] | select(.id == \"$focus_id\" and .status != \"cancelled\")]" "$todo_file"
        return
    fi

    # Get focused task's phase for tier 3 filtering
    local focus_phase=""
    if [[ -n "$focus_id" ]]; then
        focus_phase=$(jq -r ".tasks[] | select(.id == \"$focus_id\") | .phase // \"\"" "$todo_file")
    fi

    # Build task list with tiers and phase filtering
    jq -c --arg focus_id "$focus_id" --arg focus_phase "$focus_phase" --arg phase_filter "$effective_phase" --argjson max "$max_tasks" '
        # Get focused task (tier 1) - exclude done and cancelled
        (.tasks[] | select(.id == $focus_id and .status != "done" and .status != "cancelled")) as $focused |

        # Get all active tasks (exclude done and cancelled), optionally filtered by phase
        [.tasks[] | select(.status != "done" and .status != "cancelled") |
         if $phase_filter != "" then select(.phase == $phase_filter) else . end] |

        # Sort by tier priority
        sort_by(
            if .id == $focus_id then 0                           # Tier 1: focused
            elif (.depends // []) | any(. == $focus_id) then 1   # Tier 2: depends on focused
            elif .priority == "critical" then 2                   # Tier 3a: critical
            elif .priority == "high" then 3                       # Tier 3b: high priority
            elif .phase == $focus_phase and $focus_phase != "" then 4  # Tier 3c: same phase
            else 5                                                # Everything else
            end
        ) |

        # Take max tasks
        .[0:$max]
    ' "$todo_file"
}

# Convert tasks to TodoWrite format
convert_to_todowrite() {
    local tasks_json="$1"

    local todowrite_todos="[]"

    while IFS= read -r task; do
        local id=$(echo "$task" | jq -r '.id')
        local title=$(echo "$task" | jq -r '.title // ""')
        local status=$(echo "$task" | jq -r '.status // "pending"')
        local priority=$(echo "$task" | jq -r '.priority // "medium"')
        local phase=$(echo "$task" | jq -r '.phase // ""')

        # Format content with ID prefix and phase
        local content
        content=$(format_task_content "$id" "$title" "$priority" "$status" "$phase")

        # Get activeForm
        local active_form
        active_form=$(convert_to_active_form "$title")

        # Map status
        local todowrite_status
        todowrite_status=$(map_status_to_todowrite "$status")

        # Build todo item
        local todo_item
        todo_item=$(jq -n \
            --arg content "$content" \
            --arg activeForm "$active_form" \
            --arg status "$todowrite_status" \
            '{content: $content, activeForm: $activeForm, status: $status}')

        todowrite_todos=$(echo "$todowrite_todos" | jq --argjson item "$todo_item" '. + [$item]')
    done < <(echo "$tasks_json" | jq -c '.[]')

    # Return final format
    jq -n --argjson todos "$todowrite_todos" '{todos: $todos}'
}

# Save session state for extraction phase
save_session_state() {
    local injected_ids="$1"
    local output_json="$2"

    mkdir -p "$SYNC_DIR"

    # Get current session ID if active
    local session_id
    session_id=$(jq -r '._meta.activeSession // "manual"' "$TODO_FILE" 2>/dev/null || echo "manual")

    # Get current project phase
    local current_phase
    current_phase=$(jq -r '.project.currentPhase // ""' "$TODO_FILE" 2>/dev/null || echo "")

    # Build task metadata map (id -> {phase, priority, status})
    local task_metadata
    task_metadata=$(jq -c '[.tasks[] | {id, phase, priority, status}] | map({(.id): {phase, priority, status}}) | add' "$TODO_FILE")

    jq -n \
        --arg session_id "$session_id" \
        --arg injected_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --arg injected_phase "$current_phase" \
        --argjson injected_ids "$injected_ids" \
        --argjson snapshot "$output_json" \
        --argjson task_metadata "$task_metadata" \
        '{
            session_id: $session_id,
            injected_at: $injected_at,
            injectedPhase: $injected_phase,
            injected_tasks: $injected_ids,
            snapshot: $snapshot,
            task_metadata: $task_metadata
        }' > "$STATE_FILE"

    if [[ -n "$current_phase" ]]; then
        log_info "Session state saved: $STATE_FILE (phase: $current_phase)"
    else
        log_info "Session state saved: $STATE_FILE (no phase set)"
    fi
}

# =============================================================================
# Main
# =============================================================================
main() {
    parse_args "$@"

    # Resolve format (TTY-aware auto-detection)
    FORMAT=$(resolve_format "${FORMAT:-}")

    # Validate todo.json exists
    if [[ ! -f "$TODO_FILE" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_NOT_INITIALIZED" "todo.json not found at $TODO_FILE" 1 true "Run 'cleo init' first"
        else
            output_error "$E_NOT_INITIALIZED" "todo.json not found at $TODO_FILE"
        fi
        exit "$EXIT_NOT_FOUND"
    fi

    # Determine effective phase filter
    local effective_phase="$PHASE_FILTER"
    if [[ -z "$effective_phase" ]]; then
        effective_phase=$(jq -r '.project.currentPhase // ""' "$TODO_FILE")
    fi

    if [[ -n "$effective_phase" ]]; then
        log_info "Phase filter: $effective_phase"
    fi

    # Get tasks to inject
    local tasks_json
    tasks_json=$(get_tasks_to_inject "$TODO_FILE" "$MAX_TASKS" "$FOCUSED_ONLY" "$PHASE_FILTER")

    local task_count
    task_count=$(echo "$tasks_json" | jq 'length')

    if [[ "$task_count" -eq 0 ]]; then
        log_warn "No tasks to inject"
        # Get VERSION for JSON output
        local version
        CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
        if [[ -f "$CLEO_HOME/VERSION" ]]; then
            version=$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')
        elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
            version=$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')
        else
            version="0.16.0"
        fi

        if [[ "$FORMAT" == "json" ]]; then
            jq -n \
                --arg version "$version" \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "inject",
                        "timestamp": $timestamp
                    },
                    "success": true,
                    "injected": {
                        "taskCount": 0,
                        "taskIds": [],
                        "todos": []
                    }
                }'
        else
            echo '{"todos": []}'
        fi
        exit "$EXIT_SUCCESS"
    fi

    log_info "Injecting $task_count tasks to TodoWrite format"

    # Convert to TodoWrite format
    local output_json
    output_json=$(convert_to_todowrite "$tasks_json")

    # Extract injected task IDs for state file
    local injected_ids
    injected_ids=$(echo "$tasks_json" | jq '[.[].id]')

    # DRY-RUN: Show what would be injected without saving state
    if [[ "$DRY_RUN" == true ]]; then
        # Get VERSION for JSON output
        local version
        CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
        if [[ -f "$CLEO_HOME/VERSION" ]]; then
            version=$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')
        elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
            version=$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')
        else
            version="0.16.0"
        fi

        if [[ "$FORMAT" == "json" ]]; then
            jq -n \
                --arg version "$version" \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                --argjson taskCount "$task_count" \
                --argjson injectedIds "$injected_ids" \
                --argjson todos "$output_json" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "inject",
                        "timestamp": $timestamp
                    },
                    "success": true,
                    "dryRun": true,
                    "wouldInject": {
                        "taskCount": $taskCount,
                        "taskIds": $injectedIds,
                        "todos": $todos.todos
                    }
                }'
        else
            echo -e "${YELLOW}[DRY-RUN]${NC} Would inject $task_count tasks:"
            echo ""
            echo "Task IDs: $(echo "$injected_ids" | jq -r 'join(", ")')"
            echo ""
            echo "TodoWrite format:"
            echo "$output_json" | jq '.'
            echo ""
            echo -e "${YELLOW}No state file created (dry-run mode)${NC}"
        fi
        exit "$EXIT_SUCCESS"
    fi

    # Save session state if requested
    if [[ "$SAVE_STATE" == "true" ]]; then
        save_session_state "$injected_ids" "$output_json"
    fi

    # Get VERSION for JSON output
    local version
    CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
    if [[ -f "$CLEO_HOME/VERSION" ]]; then
        version=$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')
    elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
        version=$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')
    else
        version="0.16.0"
    fi

    # Output result with proper JSON envelope
    local final_output
    if [[ "$FORMAT" == "json" ]]; then
        final_output=$(jq -n \
            --arg version "$version" \
            --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --argjson taskCount "$task_count" \
            --argjson injectedIds "$injected_ids" \
            --argjson todos "$output_json" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "inject",
                    "timestamp": $timestamp
                },
                "success": true,
                "injected": {
                    "taskCount": $taskCount,
                    "taskIds": $injectedIds,
                    "todos": $todos.todos
                }
            }')
    else
        final_output="$output_json"
    fi

    if [[ -n "$OUTPUT_FILE" ]]; then
        echo "$final_output" > "$OUTPUT_FILE"
        log_info "Output written to: $OUTPUT_FILE"
    else
        echo "$final_output"
    fi
}

main "$@"
