#!/usr/bin/env bash
# =============================================================================
# export.sh - Export tasks to various formats
# =============================================================================
# Exports cleo tasks to different formats, primarily TodoWrite format
# for Claude Code integration.
#
# Usage:
#   cleo export --format todowrite
#   cleo export --format todowrite --status active,pending
#   cleo export --format json
# =============================================================================

set -euo pipefail

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"

# Source required libraries
source "$LIB_DIR/logging.sh"
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

# ============================================================================
# DEPENDENCY CHECK (T167)
# ============================================================================
# jq is required for all export operations
if ! command -v jq &>/dev/null; then
    if declare -f output_error &>/dev/null; then
        output_error "$E_DEPENDENCY_MISSING" "jq is required for export operations but not found"
    else
        echo "ERROR: jq is required for export operations but not found." >&2
        echo "" >&2
        echo "Install jq:" >&2
        case "$(uname -s)" in
            Linux*)  echo "  sudo apt install jq  (Debian/Ubuntu)" >&2
                     echo "  sudo yum install jq  (RHEL/CentOS)" >&2 ;;
            Darwin*) echo "  brew install jq" >&2 ;;
            *)       echo "  See: https://stedolan.github.io/jq/download/" >&2 ;;
        esac
    fi
    exit "${EXIT_DEPENDENCY_ERROR:-1}"
fi

# Colors (respects NO_COLOR and FORCE_COLOR environment variables per https://no-color.org)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

# -----------------------------------------------------------------------------
# Default values
# -----------------------------------------------------------------------------
FORMAT="todowrite"
OUTPUT_FORMAT_TYPE="todowrite"  # Tracks export format type (separate from error output FORMAT)
STATUS_FILTER="pending,active"
PRIORITY_FILTER=""
LABEL_FILTER=""
MAX_TASKS=10
TODO_FILE=".cleo/todo.json"
COMMAND_NAME="export"
OUTPUT_FILE=""
QUIET=false
DELIMITER=","
INCLUDE_HEADER=true

# -----------------------------------------------------------------------------
# Help text
# -----------------------------------------------------------------------------
show_help() {
    cat << 'EOF'
export.sh - Export tasks to various formats

Usage: cleo export [OPTIONS]

DESCRIPTION
    Exports cleo tasks to different formats for integration with
    external tools. Primary use case is exporting to TodoWrite format for
    Claude Code integration.

OPTIONS
    -f, --format FORMAT      Output format: todowrite, json, markdown, csv, tsv (default: todowrite)
        --json               Shortcut for --format json
        --human              Shortcut for --format text (alias for todowrite)
    -s, --status STATUS      Comma-separated status filter (default: pending,active)
    -p, --priority PRIORITY  Filter by priority (critical|high|medium|low)
    -l, --label LABEL        Filter by label
    -m, --max N              Maximum tasks to export (default: 10)
    -o, --output FILE        Write to file instead of stdout
    -d, --delimiter CHAR     Custom delimiter for CSV (default: comma)
        --no-header          Skip header row in CSV/TSV output
    -q, --quiet              Suppress informational messages
    -h, --help               Show this help

FORMATS
    todowrite    Claude Code TodoWrite format with content, activeForm, status
    json         Raw JSON array of tasks
    markdown     Markdown checklist format
    csv          RFC 4180 compliant CSV with quoted fields
    tsv          Tab-separated values (paste-friendly)

EXAMPLES
    # Export active tasks to TodoWrite format
    cleo export --format todowrite

    # Export only active tasks
    cleo export --format todowrite --status active

    # Export high priority tasks
    cleo export --format todowrite --priority high

    # Export tasks with specific label
    cleo export --format todowrite --label bug

    # Combine filters (status + priority)
    cleo export --format todowrite --status pending,active --priority critical

    # Export all pending/active tasks as markdown
    cleo export --format markdown --status pending,active

    # Export to file
    cleo export --format todowrite --output .cleo/todowrite-tasks.json

    # Export as CSV
    cleo export --format csv --status pending,active,done

    # Export as TSV without header
    cleo export --format tsv --no-header

    # Custom CSV delimiter
    cleo export --format csv --delimiter ';'

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

CSV/TSV FORMATS
    CSV Format (RFC 4180 compliant):
      - Header: id,status,priority,phase,title,createdAt,completedAt,labels
      - Fields are quoted to handle commas and special characters
      - Internal quotes escaped by doubling ("" for ")
      - Empty fields shown as ""
      - Labels joined with commas inside quotes

    Example CSV output:
      "T001","done","high","setup","Setup database","2025-12-08T10:00:00Z","2025-12-09T15:30:00Z","backend,db"
      "T002","active","high","core","Create user model","2025-12-09T11:00:00Z","","backend,api"

    TSV Format (tab-separated):
      - Tab character as delimiter
      - No quoting needed
      - Tabs in content replaced with spaces
      - Paste-friendly for spreadsheets

    Example TSV output:
      T001	done	high	setup	Setup database	2025-12-08T10:00:00Z	2025-12-09T15:30:00Z	backend,db
      T002	active	high	core	Create user model	2025-12-09T11:00:00Z		backend,api

EOF
}

# -----------------------------------------------------------------------------
# Parse arguments
# -----------------------------------------------------------------------------
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -f|--format)
                FORMAT="${2:-todowrite}"
                shift 2
                ;;
            --json)
                FORMAT="json"
                shift
                ;;
            --human)
                FORMAT="todowrite"
                shift
                ;;
            -s|--status)
                STATUS_FILTER="${2:-pending,active}"
                shift 2
                ;;
            -p|--priority)
                PRIORITY_FILTER="${2:-}"
                shift 2
                ;;
            -l|--label)
                LABEL_FILTER="${2:-}"
                shift 2
                ;;
            -m|--max)
                MAX_TASKS="${2:-10}"
                shift 2
                ;;
            -o|--output)
                OUTPUT_FILE="${2:-}"
                shift 2
                ;;
            -d|--delimiter)
                DELIMITER="${2:-,}"
                shift 2
                ;;
            --no-header)
                INCLUDE_HEADER=false
                shift
                ;;
            -q|--quiet)
                QUIET=true
                shift
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                # For unknown options, check if output_error is available
                if declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_INVALID" "Unknown option: $1"
                else
                    echo -e "${RED}[ERROR]${NC} Unknown option: $1" >&2
                    echo "Run 'cleo export --help' for usage." >&2
                fi
                exit "${EXIT_INVALID_INPUT:-1}"
                ;;
        esac
    done
}

# -----------------------------------------------------------------------------
# Build combined filter (status, priority, label)
# -----------------------------------------------------------------------------
build_task_filter() {
    local status_filter="$1"
    local priority_filter="$2"
    local label_filter="$3"

    local filters=()

    # Status filter
    if [[ -n "$status_filter" ]]; then
        local status_parts=()
        IFS=',' read -ra statuses <<< "$status_filter"
        for s in "${statuses[@]}"; do
            s=$(echo "$s" | xargs)
            status_parts+=(".status == \"$s\"")
        done
        # Join status parts with ' or ' and wrap in parentheses
        local status_expr=""
        for i in "${!status_parts[@]}"; do
            if [[ $i -eq 0 ]]; then
                status_expr="${status_parts[i]}"
            else
                status_expr="${status_expr} or ${status_parts[i]}"
            fi
        done
        filters+=("($status_expr)")
    fi

    # Priority filter
    if [[ -n "$priority_filter" ]]; then
        filters+=("(.priority == \"$priority_filter\")")
    fi

    # Label filter
    if [[ -n "$label_filter" ]]; then
        filters+=("(.labels != null and (.labels | contains([\"$label_filter\"])))")
    fi

    # Combine all filters with 'and'
    if [[ ${#filters[@]} -eq 0 ]]; then
        echo "true"
    else
        local combined=""
        for i in "${!filters[@]}"; do
            if [[ $i -eq 0 ]]; then
                combined="${filters[i]}"
            else
                combined="${combined} and ${filters[i]}"
            fi
        done
        echo "$combined"
    fi
}

# -----------------------------------------------------------------------------
# Export to TodoWrite format
# -----------------------------------------------------------------------------
export_todowrite() {
    local todo_file="$1"
    local status_filter="$2"
    local max_tasks="$3"
    local priority_filter="${4:-}"
    local label_filter="${5:-}"

    # Build combined filter
    local jq_filter=$(build_task_filter "$status_filter" "$priority_filter" "$label_filter")

    # Extract matching tasks
    local tasks
    tasks=$(jq -c "[.tasks[] | select($jq_filter)] | .[0:$max_tasks]" "$todo_file")

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
# Export to JSON format (with _meta envelope)
# -----------------------------------------------------------------------------
export_json() {
    local todo_file="$1"
    local status_filter="$2"
    local max_tasks="$3"
    local priority_filter="${4:-}"
    local label_filter="${5:-}"

    # Build combined filter
    local jq_filter=$(build_task_filter "$status_filter" "$priority_filter" "$label_filter")

    # Extract tasks
    local tasks
    tasks=$(jq "[.tasks[] | select($jq_filter)] | .[0:$max_tasks]" "$todo_file")

    # Get version
    local version
    version=$(cat "${SCRIPT_DIR}/../VERSION" 2>/dev/null || echo "0.8.3")

    # Wrap in _meta envelope for programmatic detection
    jq -n \
      --argjson tasks "$tasks" \
      --arg version "$version" \
      --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg status "$status_filter" \
      --argjson max "$max_tasks" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $version,
          "command": "export",
          "timestamp": $timestamp
        },
        "success": true,
        "filters": {
          "status": ($status | split(",")),
          "maxTasks": $max
        },
        "summary": {
          "exported": ($tasks | length)
        },
        "tasks": $tasks
      }'
}

# -----------------------------------------------------------------------------
# Export to Markdown format
# -----------------------------------------------------------------------------
export_markdown() {
    local todo_file="$1"
    local status_filter="$2"
    local max_tasks="$3"
    local priority_filter="${4:-}"
    local label_filter="${5:-}"

    # Build combined filter
    local jq_filter=$(build_task_filter "$status_filter" "$priority_filter" "$label_filter")

    # Extract matching tasks
    local tasks
    tasks=$(jq -c "[.tasks[] | select($jq_filter)] | .[0:$max_tasks]" "$todo_file")

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
# CSV Helper: Escape and quote field according to RFC 4180
# -----------------------------------------------------------------------------
csv_quote() {
    local value="$1"
    local delimiter="${2:-,}"

    # Empty value
    if [[ -z "$value" ]]; then
        echo '""'
        return
    fi

    # Check if quoting is needed (contains delimiter, quote, or newline)
    if [[ "$value" == *"$delimiter"* ]] || [[ "$value" == *'"'* ]] || [[ "$value" == *$'\n'* ]]; then
        # Escape internal quotes by doubling them
        value="${value//\"/\"\"}"
        echo "\"$value\""
    else
        # Quote anyway for consistency (RFC 4180 allows this)
        echo "\"$value\""
    fi
}

# -----------------------------------------------------------------------------
# Export to CSV format (RFC 4180 compliant)
# -----------------------------------------------------------------------------
export_csv() {
    local todo_file="$1"
    local status_filter="$2"
    local max_tasks="$3"
    local delimiter="${4:-,}"
    local include_header="${5:-true}"
    local priority_filter="${6:-}"
    local label_filter="${7:-}"

    # Build combined filter
    local jq_filter=$(build_task_filter "$status_filter" "$priority_filter" "$label_filter")

    # Extract matching tasks
    local tasks
    tasks=$(jq -c "[.tasks[] | select($jq_filter)] | .[0:$max_tasks]" "$todo_file")

    # Header row
    if [[ "$include_header" == "true" ]]; then
        # Quote header fields too for consistency
        printf "%s${delimiter}%s${delimiter}%s${delimiter}%s${delimiter}%s${delimiter}%s${delimiter}%s${delimiter}%s\n" \
            '"id"' '"status"' '"priority"' '"phase"' '"title"' '"createdAt"' '"completedAt"' '"labels"'
    fi

    # Data rows
    while IFS= read -r task; do
        [[ -z "$task" ]] && continue

        local id=$(echo "$task" | jq -r '.id // ""')
        local status=$(echo "$task" | jq -r '.status // ""')
        local priority=$(echo "$task" | jq -r '.priority // ""')
        local phase=$(echo "$task" | jq -r '.phase // ""')
        local title=$(echo "$task" | jq -r '.title // ""')
        local created_at=$(echo "$task" | jq -r '.createdAt // ""')
        local completed_at=$(echo "$task" | jq -r '.completedAt // ""')
        local labels=$(echo "$task" | jq -r '.labels // [] | join(",")')

        # Quote each field
        local id_quoted=$(csv_quote "$id" "$delimiter")
        local status_quoted=$(csv_quote "$status" "$delimiter")
        local priority_quoted=$(csv_quote "$priority" "$delimiter")
        local phase_quoted=$(csv_quote "$phase" "$delimiter")
        local title_quoted=$(csv_quote "$title" "$delimiter")
        local created_at_quoted=$(csv_quote "$created_at" "$delimiter")
        local completed_at_quoted=$(csv_quote "$completed_at" "$delimiter")
        local labels_quoted=$(csv_quote "$labels" "$delimiter")

        echo "${id_quoted}${delimiter}${status_quoted}${delimiter}${priority_quoted}${delimiter}${phase_quoted}${delimiter}${title_quoted}${delimiter}${created_at_quoted}${delimiter}${completed_at_quoted}${delimiter}${labels_quoted}"
    done < <(echo "$tasks" | jq -c '.[]')
}

# -----------------------------------------------------------------------------
# Export to TSV format (Tab-separated values)
# -----------------------------------------------------------------------------
export_tsv() {
    local todo_file="$1"
    local status_filter="$2"
    local max_tasks="$3"
    local include_header="${4:-true}"
    local priority_filter="${5:-}"
    local label_filter="${6:-}"

    # Build combined filter
    local jq_filter=$(build_task_filter "$status_filter" "$priority_filter" "$label_filter")

    # Extract matching tasks
    local tasks
    tasks=$(jq -c "[.tasks[] | select($jq_filter)] | .[0:$max_tasks]" "$todo_file")

    # Header row
    if [[ "$include_header" == "true" ]]; then
        printf "id\tstatus\tpriority\tphase\ttitle\tcreatedAt\tcompletedAt\tlabels\n"
    fi

    # Data rows
    while IFS= read -r task; do
        [[ -z "$task" ]] && continue

        local id=$(echo "$task" | jq -r '.id // ""')
        local status=$(echo "$task" | jq -r '.status // ""')
        local priority=$(echo "$task" | jq -r '.priority // ""')
        local phase=$(echo "$task" | jq -r '.phase // ""')
        local title=$(echo "$task" | jq -r '.title // ""')
        local created_at=$(echo "$task" | jq -r '.createdAt // ""')
        local completed_at=$(echo "$task" | jq -r '.completedAt // ""')
        local labels=$(echo "$task" | jq -r '.labels // [] | join(",")')

        # Replace tabs in content with spaces to avoid breaking TSV structure
        title="${title//$'\t'/ }"

        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
            "$id" "$status" "$priority" "$phase" "$title" "$created_at" "$completed_at" "$labels"
    done < <(echo "$tasks" | jq -c '.[]')
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
    parse_args "$@"

    # Resolve format (TTY-aware auto-detection)
    FORMAT=$(resolve_format "${FORMAT:-}")

    # Check todo.json exists
    if [[ ! -f "$TODO_FILE" ]]; then
        if declare -f output_error >/dev/null 2>&1; then
            output_error "$E_NOT_INITIALIZED" "$TODO_FILE not found"
        else
            echo -e "${RED}[ERROR]${NC} $TODO_FILE not found. Run 'cleo init' first." >&2
        fi
        exit "${EXIT_NOT_INITIALIZED:-1}"
    fi

    # Validate format
    case "$FORMAT" in
        todowrite|json|markdown|csv|tsv) ;;
        *)
            if declare -f output_error >/dev/null 2>&1; then
                output_error "$E_INPUT_INVALID" "Unknown format: $FORMAT"
            else
                echo -e "${RED}[ERROR]${NC} Unknown format: $FORMAT" >&2
                echo "Valid formats: todowrite, json, markdown, csv, tsv" >&2
            fi
            exit "${EXIT_INVALID_INPUT:-1}"
            ;;
    esac

    # Count matching tasks using combined filter
    local task_count
    local jq_filter=$(build_task_filter "$STATUS_FILTER" "$PRIORITY_FILTER" "$LABEL_FILTER")
    task_count=$(jq "[.tasks[] | select($jq_filter)] | length" "$TODO_FILE")

    if [[ "$QUIET" != "true" && "$FORMAT" != "json" ]]; then
        local filter_desc="Status: $STATUS_FILTER"
        [[ -n "$PRIORITY_FILTER" ]] && filter_desc="$filter_desc, Priority: $PRIORITY_FILTER"
        [[ -n "$LABEL_FILTER" ]] && filter_desc="$filter_desc, Label: $LABEL_FILTER"
        echo -e "${BLUE}[EXPORT]${NC} Format: $FORMAT, $filter_desc, Found: $task_count tasks" >&2
    fi

    # Generate output
    local output=""
    case "$FORMAT" in
        todowrite)
            output=$(export_todowrite "$TODO_FILE" "$STATUS_FILTER" "$MAX_TASKS" "$PRIORITY_FILTER" "$LABEL_FILTER")
            ;;
        json)
            output=$(export_json "$TODO_FILE" "$STATUS_FILTER" "$MAX_TASKS" "$PRIORITY_FILTER" "$LABEL_FILTER")
            ;;
        markdown)
            output=$(export_markdown "$TODO_FILE" "$STATUS_FILTER" "$MAX_TASKS" "$PRIORITY_FILTER" "$LABEL_FILTER")
            ;;
        csv)
            output=$(export_csv "$TODO_FILE" "$STATUS_FILTER" "$MAX_TASKS" "$DELIMITER" "$INCLUDE_HEADER" "$PRIORITY_FILTER" "$LABEL_FILTER")
            ;;
        tsv)
            output=$(export_tsv "$TODO_FILE" "$STATUS_FILTER" "$MAX_TASKS" "$INCLUDE_HEADER" "$PRIORITY_FILTER" "$LABEL_FILTER")
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
