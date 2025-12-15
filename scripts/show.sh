#!/usr/bin/env bash
# CLAUDE-TODO Show Command
# Display detailed view of a single task with all fields
# Includes dependencies, notes, and related information
set -uo pipefail

TODO_FILE="${TODO_FILE:-.claude/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.claude/todo-archive.json}"
LOG_FILE="${LOG_FILE:-.claude/todo-log.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source libraries
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  source "$LIB_DIR/logging.sh"
fi
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  source "$LIB_DIR/output-format.sh"
fi

# Colors (respects NO_COLOR and FORCE_COLOR environment variables)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' DIM='' NC=''
fi

# Exit codes
EXIT_SUCCESS=0
EXIT_NOT_FOUND=1
EXIT_INVALID_ID=2
EXIT_FILE_ERROR=3

# Options
FORMAT="text"
INCLUDE_ARCHIVE=false
SHOW_HISTORY=false
SHOW_RELATED=false

usage() {
  cat << EOF
Usage: claude-todo show <task-id> [OPTIONS]

Display detailed view of a single task.

Arguments:
  <task-id>           Task ID to display (e.g., T001)

Options:
  -f, --format FORMAT Output format: text (default) or json
  --include-archive   Search archive if not found in active tasks
  --history           Show task history from log
  --related           Show related tasks (same labels)
  -h, --help          Show this help message

Examples:
  claude-todo show T001                    # Show task details
  claude-todo show T001 --history          # Include task history
  claude-todo show T001 --related          # Show related tasks
  claude-todo show T001 --format json      # JSON output
  claude-todo show T050 --include-archive  # Search archive too
EOF
}

# Validate task ID format
validate_task_id() {
  local id="$1"
  if [[ ! "$id" =~ ^T[0-9]{3,}$ ]]; then
    return 1
  fi
  return 0
}

# Get priority color
priority_color() {
  case "$1" in
    critical) echo -e "${RED}" ;;
    high)     echo -e "${YELLOW}" ;;
    medium)   echo -e "${BLUE}" ;;
    low)      echo -e "${DIM}" ;;
    *)        echo -e "${NC}" ;;
  esac
}

# Get status symbol
status_symbol() {
  case "$1" in
    pending)  echo "○" ;;
    active)   echo "◉" ;;
    blocked)  echo "⊗" ;;
    done)     echo "✓" ;;
    *)        echo "?" ;;
  esac
}

# Find task in file
find_task() {
  local id="$1"
  local file="$2"

  if [[ ! -f "$file" ]]; then
    return 1
  fi

  # Use jq without -e to avoid exit code 4 on no match
  local result
  result=$(jq --arg id "$id" '.tasks[] | select(.id == $id)' "$file" 2>/dev/null) || true

  if [[ -n "$result" ]]; then
    echo "$result"
    return 0
  fi
  return 1
}

# Get tasks that depend on this task
get_dependents() {
  local id="$1"
  local file="$2"

  if [[ ! -f "$file" ]]; then
    return
  fi

  jq -r --arg id "$id" '.tasks[] | select(.depends != null) | select(.depends | index($id)) | "\(.id): \(.title)"' "$file" 2>/dev/null
}

# Get task history from log
get_task_history() {
  local id="$1"

  if [[ ! -f "$LOG_FILE" ]]; then
    return
  fi

  jq -r --arg id "$id" '.entries[] | select(.taskId == $id) | "[\(.timestamp | split("T")[0])] \(.action): \(.details // "")"' "$LOG_FILE" 2>/dev/null | tail -10
}

# Get related tasks by labels
get_related_tasks() {
  local labels="$1"
  local current_id="$2"
  local file="$3"

  if [[ -z "$labels" ]] || [[ "$labels" == "null" ]] || [[ ! -f "$file" ]]; then
    return
  fi

  # Get tasks sharing any label (exclude current task)
  jq -r --argjson labels "$labels" --arg id "$current_id" '
    .tasks[] |
    select(.id != $id) |
    select(.labels != null) |
    select(any(.labels[]; . as $l | $labels | index($l))) |
    "\(.id): \(.title) [\(.status)]"
  ' "$file" 2>/dev/null | head -5
}

# Display task in text format
display_text() {
  local task="$1"
  local source="$2"

  local id=$(echo "$task" | jq -r '.id')
  local title=$(echo "$task" | jq -r '.title')
  local status=$(echo "$task" | jq -r '.status')
  local priority=$(echo "$task" | jq -r '.priority // "medium"')
  local description=$(echo "$task" | jq -r '.description // ""')
  local phase=$(echo "$task" | jq -r '.phase // ""')
  local labels=$(echo "$task" | jq -r '.labels // [] | join(", ")')
  local labels_json=$(echo "$task" | jq '.labels // []')
  local depends=$(echo "$task" | jq -r '.depends // [] | join(", ")')
  local created=$(echo "$task" | jq -r '.createdAt // "" | split("T")[0]')
  local completed=$(echo "$task" | jq -r '.completedAt // "" | split("T")[0]')
  local notes=$(echo "$task" | jq -r '.notes // []')
  local files=$(echo "$task" | jq -r '.files // [] | join(", ")')
  local acceptance=$(echo "$task" | jq -r '.acceptance // []')
  local blocked_by=$(echo "$task" | jq -r '.blockedBy // ""')

  local pcolor=$(priority_color "$priority")
  local symbol=$(status_symbol "$status")

  # Header
  echo ""
  echo -e "╭─────────────────────────────────────────────────────────────────╮"
  echo -e "│  ${BOLD}$id${NC} $symbol ${pcolor}[$priority]${NC}"
  echo -e "│  $title"
  echo -e "├─────────────────────────────────────────────────────────────────┤"

  # Core fields
  echo -e "│  ${DIM}Status:${NC}      $status"
  echo -e "│  ${DIM}Priority:${NC}    $priority"
  [[ -n "$phase" && "$phase" != "null" ]] && echo -e "│  ${DIM}Phase:${NC}       $phase"
  [[ -n "$labels" ]] && echo -e "│  ${DIM}Labels:${NC}      $labels"
  [[ -n "$created" && "$created" != "null" ]] && echo -e "│  ${DIM}Created:${NC}     $created"
  [[ -n "$completed" && "$completed" != "null" ]] && echo -e "│  ${DIM}Completed:${NC}   $completed"
  [[ "$source" == "archive" ]] && echo -e "│  ${DIM}Source:${NC}      ${YELLOW}archived${NC}"

  # Description
  if [[ -n "$description" && "$description" != "null" ]]; then
    echo -e "├─────────────────────────────────────────────────────────────────┤"
    echo -e "│  ${BOLD}Description${NC}"
    echo "$description" | fold -w 60 -s | while read -r line; do
      echo -e "│    $line"
    done
  fi

  # Dependencies
  if [[ -n "$depends" ]]; then
    echo -e "├─────────────────────────────────────────────────────────────────┤"
    echo -e "│  ${BOLD}Depends On${NC}"
    echo -e "│    $depends"
  fi

  # Blocked by
  if [[ -n "$blocked_by" && "$blocked_by" != "null" ]]; then
    echo -e "│  ${BOLD}Blocked By${NC}"
    echo -e "│    ${RED}$blocked_by${NC}"
  fi

  # Dependents (what depends on this task)
  local dependents=$(get_dependents "$id" "$TODO_FILE")
  if [[ -n "$dependents" ]]; then
    echo -e "├─────────────────────────────────────────────────────────────────┤"
    echo -e "│  ${BOLD}Blocking${NC} (tasks that depend on this)"
    echo "$dependents" | while read -r line; do
      [[ -n "$line" ]] && echo -e "│    → $line"
    done
  fi

  # Notes
  local notes_count=$(echo "$notes" | jq 'length')
  if [[ "$notes_count" -gt 0 ]]; then
    echo -e "├─────────────────────────────────────────────────────────────────┤"
    echo -e "│  ${BOLD}Notes${NC} ($notes_count)"
    echo "$notes" | jq -r '.[]' | tail -5 | while read -r note; do
      local short_note=$(echo "$note" | cut -c1-58)
      echo -e "│    • $short_note"
    done
    [[ "$notes_count" -gt 5 ]] && echo -e "│    ${DIM}... and $((notes_count - 5)) more${NC}"
  fi

  # Files
  if [[ -n "$files" ]]; then
    echo -e "├─────────────────────────────────────────────────────────────────┤"
    echo -e "│  ${BOLD}Files${NC}"
    echo -e "│    $files"
  fi

  # Acceptance criteria
  local acceptance_count=$(echo "$acceptance" | jq 'length')
  if [[ "$acceptance_count" -gt 0 ]]; then
    echo -e "├─────────────────────────────────────────────────────────────────┤"
    echo -e "│  ${BOLD}Acceptance Criteria${NC}"
    echo "$acceptance" | jq -r '.[]' | while read -r criterion; do
      echo -e "│    ☐ $criterion"
    done
  fi

  # Task history (if requested)
  if [[ "$SHOW_HISTORY" == true ]]; then
    local history=$(get_task_history "$id")
    if [[ -n "$history" ]]; then
      echo -e "├─────────────────────────────────────────────────────────────────┤"
      echo -e "│  ${BOLD}History${NC} (last 10 entries)"
      echo "$history" | while read -r entry; do
        echo -e "│    $entry"
      done
    fi
  fi

  # Related tasks (if requested)
  if [[ "$SHOW_RELATED" == true ]]; then
    local related=$(get_related_tasks "$labels_json" "$id" "$TODO_FILE")
    if [[ -n "$related" ]]; then
      echo -e "├─────────────────────────────────────────────────────────────────┤"
      echo -e "│  ${BOLD}Related Tasks${NC} (same labels)"
      echo "$related" | while read -r rel; do
        echo -e "│    $rel"
      done
    fi
  fi

  echo -e "╰─────────────────────────────────────────────────────────────────╯"
  echo ""
}

# Display task in JSON format
display_json() {
  local task="$1"
  local source="$2"
  local id=$(echo "$task" | jq -r '.id')

  # Build enhanced JSON with additional context
  local output=$(echo "$task" | jq --arg source "$source" '. + {_source: $source}')

  # Add dependents
  local dependents=$(get_dependents "$id" "$TODO_FILE" | jq -R -s 'split("\n") | map(select(length > 0))')
  output=$(echo "$output" | jq --argjson deps "$dependents" '. + {_dependents: $deps}')

  # Add history if requested
  if [[ "$SHOW_HISTORY" == true ]]; then
    local history=$(get_task_history "$id" | jq -R -s 'split("\n") | map(select(length > 0))')
    output=$(echo "$output" | jq --argjson hist "$history" '. + {_history: $hist}')
  fi

  # Add related if requested
  if [[ "$SHOW_RELATED" == true ]]; then
    local labels_json=$(echo "$task" | jq '.labels // []')
    local related=$(get_related_tasks "$labels_json" "$id" "$TODO_FILE" | jq -R -s 'split("\n") | map(select(length > 0))')
    output=$(echo "$output" | jq --argjson rel "$related" '. + {_related: $rel}')
  fi

  echo "$output" | jq .
}

# Parse arguments
TASK_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -f|--format)
      FORMAT="$2"
      shift 2
      ;;
    --include-archive)
      INCLUDE_ARCHIVE=true
      shift
      ;;
    --history)
      SHOW_HISTORY=true
      shift
      ;;
    --related)
      SHOW_RELATED=true
      shift
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -z "$TASK_ID" ]]; then
        TASK_ID="$1"
      else
        echo "Error: Multiple task IDs provided" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

# Validate task ID provided
if [[ -z "$TASK_ID" ]]; then
  echo "Error: Task ID required" >&2
  echo "Usage: claude-todo show <task-id>" >&2
  exit $EXIT_INVALID_ID
fi

# Validate task ID format
if ! validate_task_id "$TASK_ID"; then
  echo "Error: Invalid task ID format: $TASK_ID" >&2
  echo "Task IDs must be in format: T001, T002, etc." >&2
  exit $EXIT_INVALID_ID
fi

# Check todo file exists
if [[ ! -f "$TODO_FILE" ]]; then
  echo "Error: Todo file not found: $TODO_FILE" >&2
  echo "Run 'claude-todo init' to initialize." >&2
  exit $EXIT_FILE_ERROR
fi

# Search for task
TASK=""
SOURCE=""

# Check active tasks first
if TASK=$(find_task "$TASK_ID" "$TODO_FILE"); then
  SOURCE="active"
fi

# Check archive if not found and flag is set
if [[ -z "$TASK" ]] && [[ "$INCLUDE_ARCHIVE" == true ]]; then
  if TASK=$(find_task "$TASK_ID" "$ARCHIVE_FILE"); then
    SOURCE="archive"
  fi
fi

# Task not found
if [[ -z "$TASK" ]]; then
  if [[ "$INCLUDE_ARCHIVE" == true ]]; then
    echo "Error: Task $TASK_ID not found in active tasks or archive" >&2
  else
    echo "Error: Task $TASK_ID not found" >&2
    echo "Tip: Use --include-archive to search archived tasks" >&2
  fi
  exit $EXIT_NOT_FOUND
fi

# Display task
case "$FORMAT" in
  json)
    display_json "$TASK" "$SOURCE"
    ;;
  text|*)
    display_text "$TASK" "$SOURCE"
    ;;
esac

exit $EXIT_SUCCESS
