#!/bin/bash
# =============================================================================
# export.sh - Export tasks to various formats
# =============================================================================
# Exports claude-todo tasks to different formats, primarily TodoWrite format
# for Claude Code integration.
#
# Usage:
#   claude-todo export --format todowrite
#   claude-todo export --format todowrite --status active,pending
#   claude-todo export --format json
# =============================================================================

set -euo pipefail

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

# Source required libraries
source "$LIB_DIR/logging.sh"
source "$LIB_DIR/todowrite-integration.sh"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# -----------------------------------------------------------------------------
# Default values
# -----------------------------------------------------------------------------
FORMAT="todowrite"
STATUS_FILTER="pending,active"
MAX_TASKS=10
TODO_FILE=".claude/todo.json"
OUTPUT_FILE=""
QUIET=false

# -----------------------------------------------------------------------------
# Help text
# -----------------------------------------------------------------------------
show_help() {
    cat << 'EOF'
export.sh - Export tasks to various formats

USAGE
    claude-todo export [OPTIONS]

DESCRIPTION
    Exports claude-todo tasks to different formats for integration with
    external tools. Primary use case is exporting to TodoWrite format for
    Claude Code integration.

OPTIONS
    --format FORMAT    Output format: todowrite, json, markdown (default: todowrite)
    --status STATUS    Comma-separated status filter (default: pending,active)
    --max N            Maximum tasks to export (default: 10)
    --output FILE      Write to file instead of stdout
    --quiet            Suppress informational messages
    -h, --help         Show this help

FORMATS
    todowrite    Claude Code TodoWrite format with content, activeForm, status
    json         Raw JSON array of tasks
    markdown     Markdown checklist format

EXAMPLES
    # Export active tasks to TodoWrite format
    claude-todo export --format todowrite

    # Export only active tasks
    claude-todo export --format todowrite --status active

    # Export all pending/active tasks as markdown
    claude-todo export --format markdown --status pending,active

    # Export to file
    claude-todo export --format todowrite --output .claude/todowrite-tasks.json

STATUS VALUES
    pending     Ready to start
    active      Currently in progress
    blocked     Waiting on dependency
    done        Completed

TODOWRITE FORMAT
    The TodoWrite format is designed for Claude Code's ephemeral task tracking:

    {
      "todos": [
        {
          "content": "Implement authentication",
          "activeForm": "Implementing authentication",
          "status": "in_progress"
        }
      ]
    }

    Status mapping:
      pending  → pending
      active   → in_progress
      blocked  → pending (downgraded)
      done     → completed

GRAMMAR TRANSFORMATION
    The activeForm is automatically derived from the task title using
    grammar rules:

      "Implement X" → "Implementing X"
      "Fix bug"     → "Fixing bug"
      "Add feature" → "Adding feature"
      "Setup env"   → "Setting up env"

EOF
}

# -----------------------------------------------------------------------------
# Parse arguments
# -----------------------------------------------------------------------------
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --format)
                FORMAT="${2:-todowrite}"
                shift 2
                ;;
            --status)
                STATUS_FILTER="${2:-pending,active}"
                shift 2
                ;;
            --max)
                MAX_TASKS="${2:-10}"
                shift 2
                ;;
            --output)
                OUTPUT_FILE="${2:-}"
                shift 2
                ;;
            --quiet)
                QUIET=true
                shift
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                echo -e "${RED}[ERROR]${NC} Unknown option: $1" >&2
                echo "Run 'claude-todo export --help' for usage." >&2
                exit 1
                ;;
        esac
    done
}

# -----------------------------------------------------------------------------
# Export to TodoWrite format
# -----------------------------------------------------------------------------
export_todowrite() {
    local todo_file="$1"
    local status_filter="$2"
    local max_tasks="$3"

    # Build jq filter for status
    local jq_status_filter=""
    IFS=',' read -ra statuses <<< "$status_filter"
    for s in "${statuses[@]}"; do
        s=$(echo "$s" | xargs)  # trim whitespace
        if [[ -n "$jq_status_filter" ]]; then
            jq_status_filter="${jq_status_filter} or "
        fi
        jq_status_filter="${jq_status_filter}.status == \"$s\""
    done

    # Extract matching tasks
    local tasks
    tasks=$(jq -c "[.tasks[] | select($jq_status_filter)] | .[0:$max_tasks]" "$todo_file")

    # Convert each task
    local todowrite_tasks="[]"
    while IFS= read -r task; do
        [[ -z "$task" ]] && continue

        local title=$(echo "$task" | jq -r '.title // ""')
        local status=$(echo "$task" | jq -r '.status // "pending"')

        local active_form=$(convert_to_active_form "$title")
        local todowrite_status=$(map_status_to_todowrite "$status")

        local todo_item=$(jq -n \
            --arg content "$title" \
            --arg activeForm "$active_form" \
            --arg status "$todowrite_status" \
            '{content: $content, activeForm: $activeForm, status: $status}')

        todowrite_tasks=$(echo "$todowrite_tasks" | jq --argjson item "$todo_item" '. + [$item]')
    done < <(echo "$tasks" | jq -c '.[]')

    # Output final format
    jq -n --argjson todos "$todowrite_tasks" '{todos: $todos}'
}

# -----------------------------------------------------------------------------
# Export to JSON format (raw tasks)
# -----------------------------------------------------------------------------
export_json() {
    local todo_file="$1"
    local status_filter="$2"
    local max_tasks="$3"

    # Build jq filter for status
    local jq_status_filter=""
    IFS=',' read -ra statuses <<< "$status_filter"
    for s in "${statuses[@]}"; do
        s=$(echo "$s" | xargs)
        if [[ -n "$jq_status_filter" ]]; then
            jq_status_filter="${jq_status_filter} or "
        fi
        jq_status_filter="${jq_status_filter}.status == \"$s\""
    done

    jq "[.tasks[] | select($jq_status_filter)] | .[0:$max_tasks]" "$todo_file"
}

# -----------------------------------------------------------------------------
# Export to Markdown format
# -----------------------------------------------------------------------------
export_markdown() {
    local todo_file="$1"
    local status_filter="$2"
    local max_tasks="$3"

    # Build jq filter for status
    local jq_status_filter=""
    IFS=',' read -ra statuses <<< "$status_filter"
    for s in "${statuses[@]}"; do
        s=$(echo "$s" | xargs)
        if [[ -n "$jq_status_filter" ]]; then
            jq_status_filter="${jq_status_filter} or "
        fi
        jq_status_filter="${jq_status_filter}.status == \"$s\""
    done

    # Extract matching tasks
    local tasks
    tasks=$(jq -c "[.tasks[] | select($jq_status_filter)] | .[0:$max_tasks]" "$todo_file")

    echo "## Tasks"
    echo ""

    while IFS= read -r task; do
        [[ -z "$task" ]] && continue

        local title=$(echo "$task" | jq -r '.title // ""')
        local status=$(echo "$task" | jq -r '.status // "pending"')
        local id=$(echo "$task" | jq -r '.id // ""')
        local priority=$(echo "$task" | jq -r '.priority // "medium"')

        local checkbox="[ ]"
        case "$status" in
            done) checkbox="[x]" ;;
            active) checkbox="[-]" ;;
            blocked) checkbox="[!]" ;;
        esac

        local priority_badge=""
        case "$priority" in
            critical) priority_badge=" **CRITICAL**" ;;
            high) priority_badge=" *high*" ;;
        esac

        echo "- ${checkbox} ${title}${priority_badge} (${id})"
    done < <(echo "$tasks" | jq -c '.[]')
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
    parse_args "$@"

    # Check todo.json exists
    if [[ ! -f "$TODO_FILE" ]]; then
        echo -e "${RED}[ERROR]${NC} $TODO_FILE not found. Run 'claude-todo init' first." >&2
        exit 1
    fi

    # Validate format
    case "$FORMAT" in
        todowrite|json|markdown) ;;
        *)
            echo -e "${RED}[ERROR]${NC} Unknown format: $FORMAT" >&2
            echo "Valid formats: todowrite, json, markdown" >&2
            exit 1
            ;;
    esac

    # Count matching tasks
    local task_count
    local jq_status_filter=""
    IFS=',' read -ra statuses <<< "$STATUS_FILTER"
    for s in "${statuses[@]}"; do
        s=$(echo "$s" | xargs)
        if [[ -n "$jq_status_filter" ]]; then
            jq_status_filter="${jq_status_filter} or "
        fi
        jq_status_filter="${jq_status_filter}.status == \"$s\""
    done
    task_count=$(jq "[.tasks[] | select($jq_status_filter)] | length" "$TODO_FILE")

    if [[ "$QUIET" != "true" ]]; then
        echo -e "${BLUE}[EXPORT]${NC} Format: $FORMAT, Status: $STATUS_FILTER, Found: $task_count tasks" >&2
    fi

    # Generate output
    local output=""
    case "$FORMAT" in
        todowrite)
            output=$(export_todowrite "$TODO_FILE" "$STATUS_FILTER" "$MAX_TASKS")
            ;;
        json)
            output=$(export_json "$TODO_FILE" "$STATUS_FILTER" "$MAX_TASKS")
            ;;
        markdown)
            output=$(export_markdown "$TODO_FILE" "$STATUS_FILTER" "$MAX_TASKS")
            ;;
    esac

    # Output to file or stdout
    if [[ -n "$OUTPUT_FILE" ]]; then
        echo "$output" > "$OUTPUT_FILE"
        if [[ "$QUIET" != "true" ]]; then
            echo -e "${GREEN}[INFO]${NC} Exported to $OUTPUT_FILE" >&2
        fi
    else
        echo "$output"
    fi
}

main "$@"
