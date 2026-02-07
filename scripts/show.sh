#!/usr/bin/env bash
###CLEO
# command: show
# category: read
# synopsis: Full task details view with history and related tasks
# relevance: high
# flags: --format,--quiet,--history,--related,--include-archive
# exits: 0,2,4
# json-output: true
###END
# CLEO Show Command
# Display detailed view of a single task with all fields
# Includes dependencies, notes, and related information
set -euo pipefail

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.cleo/todo-archive.json}"
LOG_FILE="${LOG_FILE:-.cleo/todo-log.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source libraries
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  source "$LIB_DIR/logging.sh"
fi
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  source "$LIB_DIR/output-format.sh"
fi
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  source "$LIB_DIR/exit-codes.sh"
fi

# Source error JSON library
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
fi

# Source hierarchy library
if [[ -f "$LIB_DIR/hierarchy.sh" ]]; then
  # shellcheck source=../lib/hierarchy.sh
  source "$LIB_DIR/hierarchy.sh"
fi

# Source centralized flag parsing
source "$LIB_DIR/flags.sh"

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

# Exit codes (only set if exit-codes.sh was not loaded)
if [[ -z "${_EXIT_CODES_SH_LOADED:-}" ]]; then
  EXIT_SUCCESS=0
  EXIT_NOT_FOUND=1
  EXIT_INVALID_ID=2
  EXIT_FILE_ERROR=3
else
  # Map to standard exit codes from exit-codes.sh
  EXIT_INVALID_ID="${EXIT_INVALID_INPUT:-2}"
fi

# Options
FORMAT=""
INCLUDE_ARCHIVE=false
SHOW_HISTORY=false
SHOW_RELATED=false
SHOW_VERIFICATION=false
VERBOSE=false
QUIET=false
COMMAND_NAME="show"

# Get session context if active
# Returns JSON object with session info or null if no session
get_session_context() {
  local session_id focus_task session_note next_action
  session_id=$(jq -r '._meta.activeSession // ""' "$TODO_FILE" 2>/dev/null)

  if [[ -z "$session_id" || "$session_id" == "null" ]]; then
    echo "null"
    return
  fi

  focus_task=$(jq -r '.focus.currentTask // ""' "$TODO_FILE" 2>/dev/null)
  session_note=$(jq -r '.focus.sessionNote // ""' "$TODO_FILE" 2>/dev/null)
  next_action=$(jq -r '.focus.nextAction // ""' "$TODO_FILE" 2>/dev/null)

  jq -nc \
    --arg sessionId "$session_id" \
    --arg focusTask "$focus_task" \
    --arg sessionNote "$session_note" \
    --arg nextAction "$next_action" \
    '{
      sessionId: $sessionId,
      focusTask: (if $focusTask == "" then null else $focusTask end),
      sessionNote: (if $sessionNote == "" then null else $sessionNote end),
      nextAction: (if $nextAction == "" then null else $nextAction end)
    }'
}

usage() {
  cat << EOF
Usage: cleo show <task-id> [OPTIONS]

Display detailed view of a single task.

Arguments:
  <task-id>           Task ID to display (e.g., T001)

Options:
  -f, --format FORMAT Output format: text (default) or json
  --json              Shortcut for --format json
  --human             Shortcut for --format text
  -v, --verbose       Show extended task details (history, related, all notes)
  -q, --quiet         Suppress decorative output (headers, borders)
  --include-archive   Search archive if not found in active tasks
  --history           Show task history from log
  --related           Show related tasks (same labels)
  --verification      Show detailed verification gate status
  -h, --help          Show this help message

Examples:
  cleo show T001                    # Show task details
  cleo show T001 -v                 # Extended details (history, related, all notes)
  cleo show T001 --history          # Include task history
  cleo show T001 --related          # Show related tasks
  cleo show T001 --verification     # Show verification gates
  cleo show T001 --format json      # JSON output
  cleo show T050 --include-archive  # Search archive too
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
  # Try .tasks[] first (active todo.json), then .archivedTasks[] (archive file)
  local result
  result=$(jq --arg id "$id" '.tasks[] | select(.id == $id)' "$file" 2>/dev/null) || true

  if [[ -z "$result" ]]; then
    # Try archive format (.archivedTasks[])
    result=$(jq --arg id "$id" '.archivedTasks[] | select(.id == $id)' "$file" 2>/dev/null) || true
  fi

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

# Get hierarchy context for a task as JSON
# Outputs JSON object with parent, depth, childCount, children
get_hierarchy_context_json() {
  local id="$1"
  local file="$2"

  # Check if hierarchy functions are available
  if ! declare -f get_task_parent >/dev/null 2>&1; then
    echo '{"parent":null,"depth":0,"childCount":0,"children":[]}'
    return
  fi

  # Get parent info
  local parent_id
  parent_id=$(get_task_parent "$id" "$file")

  local parent_obj="null"
  if [[ "$parent_id" != "null" && -n "$parent_id" ]]; then
    local parent_title
    parent_title=$(jq -r --arg id "$parent_id" '.tasks[] | select(.id == $id) | .title // ""' "$file" 2>/dev/null)
    parent_obj=$(jq -nc --arg id "$parent_id" --arg title "$parent_title" '{"id": $id, "title": $title}')
  fi

  # Get depth
  local depth
  depth=$(get_task_depth "$id" "$file")
  [[ -z "$depth" || "$depth" == "-1" ]] && depth="0"

  # Get children
  local children
  children=$(get_children "$id" "$file")

  local child_count=0
  local children_json="[]"

  if [[ -n "$children" ]]; then
    # Count children
    child_count=$(echo "$children" | wc -w | tr -d ' ')

    # Build JSON array of children with id and title
    children_json=$(jq -nc '[]')
    for child_id in $children; do
      local child_title
      child_title=$(jq -r --arg id "$child_id" '.tasks[] | select(.id == $id) | .title // ""' "$file" 2>/dev/null)
      children_json=$(echo "$children_json" | jq --arg id "$child_id" --arg title "$child_title" '. + [{"id": $id, "title": $title}]')
    done
  fi

  jq -nc \
    --argjson parent "$parent_obj" \
    --argjson depth "$depth" \
    --argjson childCount "$child_count" \
    --argjson children "$children_json" \
    '{
      "parent": $parent,
      "depth": $depth,
      "childCount": $childCount,
      "children": $children
    }'
}

# Display task in quiet text format (no decorations)
display_text_quiet() {
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
  local blocked_by=$(echo "$task" | jq -r '.blockedBy // ""')

  local symbol=$(status_symbol "$status")

  # Core info - compact format
  echo "$id $symbol $title [$priority]"
  echo "Status: $status"
  [[ -n "$phase" && "$phase" != "null" ]] && echo "Phase: $phase"

  # Hierarchy context
  local hierarchy_json
  hierarchy_json=$(get_hierarchy_context_json "$id" "$TODO_FILE")

  local h_parent_id h_parent_title h_depth h_child_count
  h_parent_id=$(echo "$hierarchy_json" | jq -r '.parent.id // "null"')
  h_parent_title=$(echo "$hierarchy_json" | jq -r '.parent.title // ""')
  h_depth=$(echo "$hierarchy_json" | jq -r '.depth')
  h_child_count=$(echo "$hierarchy_json" | jq -r '.childCount')

  if [[ "$h_parent_id" != "null" && -n "$h_parent_id" ]]; then
    echo "Parent: $h_parent_id ($h_parent_title)"
  fi
  echo "Depth: $h_depth"
  echo "Children: $h_child_count"

  [[ -n "$labels" ]] && echo "Labels: $labels"
  [[ -n "$depends" ]] && echo "Depends: $depends"
  [[ -n "$blocked_by" && "$blocked_by" != "null" ]] && echo "Blocked by: $blocked_by"

  if [[ -n "$description" && "$description" != "null" ]]; then
    echo "Description: $description"
  fi

  [[ "$source" == "archive" ]] && echo "Source: archived"

  # Notes count
  local notes_count=$(echo "$notes" | jq 'length')
  [[ "$notes_count" -gt 0 ]] && echo "Notes: $notes_count"

  # Dependents
  local dependents=$(get_dependents "$id" "$TODO_FILE")
  [[ -n "$dependents" ]] && echo "Blocking: $(echo "$dependents" | wc -l | tr -d ' ') tasks"

  # History (if requested)
  if [[ "$SHOW_HISTORY" == true ]]; then
    local history=$(get_task_history "$id")
    [[ -n "$history" ]] && echo "History: $(echo "$history" | wc -l | tr -d ' ') entries"
  fi

  # Related (if requested)
  if [[ "$SHOW_RELATED" == true ]]; then
    local related=$(get_related_tasks "$labels_json" "$id" "$TODO_FILE")
    [[ -n "$related" ]] && echo "Related: $(echo "$related" | wc -l | tr -d ' ') tasks"
  fi
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

  # Hierarchy context
  local hierarchy_json
  hierarchy_json=$(get_hierarchy_context_json "$id" "$TODO_FILE")

  local h_parent_id h_parent_title h_depth h_child_count
  h_parent_id=$(echo "$hierarchy_json" | jq -r '.parent.id // "null"')
  h_parent_title=$(echo "$hierarchy_json" | jq -r '.parent.title // ""')
  h_depth=$(echo "$hierarchy_json" | jq -r '.depth')
  h_child_count=$(echo "$hierarchy_json" | jq -r '.childCount')

  echo -e "├─────────────────────────────────────────────────────────────────┤"
  echo -e "│  ${BOLD}Hierarchy${NC}"
  if [[ "$h_parent_id" != "null" && -n "$h_parent_id" ]]; then
    echo -e "│  ${DIM}Parent:${NC}      $h_parent_id ($h_parent_title)"
  fi
  echo -e "│  ${DIM}Depth:${NC}       $h_depth"
  echo -e "│  ${DIM}Children:${NC}    $h_child_count"

  # List direct children if any
  if [[ "$h_child_count" -gt 0 ]]; then
    echo "$hierarchy_json" | jq -r '.children[] | "\(.id): \(.title)"' 2>/dev/null | while read -r child_line; do
      [[ -n "$child_line" ]] && echo -e "│    → $child_line"
    done
  fi

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
    if [[ "$VERBOSE" == true ]]; then
      # Show all notes in verbose mode
      echo "$notes" | jq -r '.[]' | while read -r note; do
        local short_note=$(echo "$note" | cut -c1-58)
        echo -e "│    • $short_note"
      done
    else
      # Show last 5 notes in normal mode
      echo "$notes" | jq -r '.[]' | tail -5 | while read -r note; do
        local short_note=$(echo "$note" | cut -c1-58)
        echo -e "│    • $short_note"
      done
      [[ "$notes_count" -gt 5 ]] && echo -e "│    ${DIM}... and $((notes_count - 5)) more${NC}"
    fi
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

  # Verification gates (if requested) - T1158
  if [[ "$SHOW_VERIFICATION" == true ]]; then
    local verification
    verification=$(echo "$task" | jq '.verification // null')
    echo -e "├─────────────────────────────────────────────────────────────────┤"
    echo -e "│  ${BOLD}Verification Gates${NC}"
    if [[ "$verification" != "null" && -n "$verification" ]]; then
      local v_passed v_round v_status
      v_passed=$(echo "$verification" | jq -r '.passed // false')
      v_round=$(echo "$verification" | jq -r '.round // 0')

      # Source verification.sh if available
      if [[ -f "$LIB_DIR/verification.sh" ]]; then
        source "$LIB_DIR/verification.sh"
        v_status=$(get_verification_status "$verification")
      else
        v_status="unknown"
      fi

      local status_color="$YELLOW"
      [[ "$v_passed" == "true" ]] && status_color="$GREEN"
      [[ "$v_status" == "failed" ]] && status_color="$RED"

      echo -e "│  ${DIM}Status:${NC}      ${status_color}${v_status}${NC}"
      echo -e "│  ${DIM}Passed:${NC}      $v_passed"
      echo -e "│  ${DIM}Round:${NC}       $v_round"
      echo -e "│"

      # Show each gate
      for gate in implemented testsPassed qaPassed cleanupDone securityPassed documented; do
        local gate_value
        gate_value=$(echo "$verification" | jq -r ".gates.$gate // \"null\"")
        local indicator="○"
        local gate_color="$DIM"
        if [[ "$gate_value" == "true" ]]; then
          indicator="✓"
          gate_color="$GREEN"
        elif [[ "$gate_value" == "false" ]]; then
          indicator="✗"
          gate_color="$RED"
        fi
        printf "│    ${gate_color}%s${NC} %-15s: %s\n" "$indicator" "$gate" "$gate_value"
      done
    else
      echo -e "│  ${DIM}(no verification data)${NC}"
    fi
  fi

  # Session context (only if session is active)
  local session_ctx
  session_ctx=$(get_session_context)
  if [[ "$session_ctx" != "null" ]]; then
    local sess_id sess_focus sess_note sess_next is_focused
    sess_id=$(echo "$session_ctx" | jq -r '.sessionId')
    sess_focus=$(echo "$session_ctx" | jq -r '.focusTask // ""')
    sess_note=$(echo "$session_ctx" | jq -r '.sessionNote // ""')
    sess_next=$(echo "$session_ctx" | jq -r '.nextAction // ""')

    echo -e "├─────────────────────────────────────────────────────────────────┤"
    echo -e "│  ${BOLD}Session Context${NC}"
    echo -e "│  ${DIM}Session:${NC}     $sess_id"

    # Indicate if this task is the focused task
    if [[ "$sess_focus" == "$id" ]]; then
      echo -e "│  ${DIM}Focus:${NC}       ${GREEN}◉ THIS TASK${NC}"
    elif [[ -n "$sess_focus" && "$sess_focus" != "null" ]]; then
      echo -e "│  ${DIM}Focus:${NC}       $sess_focus"
    fi

    if [[ -n "$sess_note" && "$sess_note" != "null" ]]; then
      local short_sess_note=$(echo "$sess_note" | cut -c1-50)
      [[ ${#sess_note} -gt 50 ]] && short_sess_note="${short_sess_note}…"
      echo -e "│  ${DIM}Note:${NC}        $short_sess_note"
    fi

    if [[ -n "$sess_next" && "$sess_next" != "null" ]]; then
      local short_next=$(echo "$sess_next" | cut -c1-50)
      [[ ${#sess_next} -gt 50 ]] && short_next="${short_next}…"
      echo -e "│  ${DIM}Next:${NC}        $short_next"
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

  # Get version
  local version=""
  local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local cleo_home="${CLEO_HOME:-$HOME/.cleo}"
  if [[ -f "$cleo_home/VERSION" ]]; then
    version=$(head -n 1 "$cleo_home/VERSION" | tr -d '[:space:]')
  elif [[ -f "$script_dir/../VERSION" ]]; then
    version=$(head -n 1 "$script_dir/../VERSION" | tr -d '[:space:]')
  else
    version="0.1.0"
  fi

  local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Build enhanced JSON with additional context
  local task_data=$(echo "$task" | jq --arg source "$source" '. + {_source: $source}')

  # Add dependents
  local dependents=$(get_dependents "$id" "$TODO_FILE" | jq -R -s 'split("\n") | map(select(length > 0))')
  task_data=$(echo "$task_data" | jq --argjson deps "$dependents" '. + {_dependents: $deps}')

  # Add hierarchy context
  local hierarchy_json
  hierarchy_json=$(get_hierarchy_context_json "$id" "$TODO_FILE")

  task_data=$(echo "$task_data" | jq --argjson hierarchy "$hierarchy_json" '. + {hierarchy: $hierarchy}')

  # Add history if requested
  if [[ "$SHOW_HISTORY" == true ]]; then
    local history=$(get_task_history "$id" | jq -R -s 'split("\n") | map(select(length > 0))')
    task_data=$(echo "$task_data" | jq --argjson hist "$history" '. + {_history: $hist}')
  fi

  # Add related if requested
  if [[ "$SHOW_RELATED" == true ]]; then
    local labels_json=$(echo "$task" | jq '.labels // []')
    local related=$(get_related_tasks "$labels_json" "$id" "$TODO_FILE" | jq -R -s 'split("\n") | map(select(length > 0))')
    task_data=$(echo "$task_data" | jq --argjson rel "$related" '. + {_related: $rel}')
  fi

  # Add verification details if requested (T1158)
  if [[ "$SHOW_VERIFICATION" == true ]]; then
    local verification
    verification=$(echo "$task" | jq '.verification // null')
    if [[ "$verification" != "null" ]]; then
      # Source verification.sh for helper functions
      if [[ -f "$LIB_DIR/verification.sh" ]]; then
        source "$LIB_DIR/verification.sh"
        local verif_status
        verif_status=$(get_verification_status "$verification")
        local required_gates
        required_gates=$(get_config_value "verification.requiredGates" '["implemented","testsPassed","qaPassed","securityPassed","documented"]' 2>/dev/null || echo '["implemented","testsPassed","qaPassed","securityPassed","documented"]')
        local missing_gates
        missing_gates=$(get_missing_gates "$verification" "$required_gates" 2>/dev/null || echo '[]')
        task_data=$(echo "$task_data" | jq \
          --arg verifStatus "$verif_status" \
          --argjson requiredGates "$required_gates" \
          --argjson missingGates "$missing_gates" \
          '. + {_verificationStatus: $verifStatus, _requiredGates: $requiredGates, _missingGates: $missingGates}')
      fi
    fi
  fi

  # Get session context
  local session_ctx
  session_ctx=$(get_session_context)

  # Check if this task is the focused task
  local is_focused="false"
  if [[ "$session_ctx" != "null" ]]; then
    local focus_task
    focus_task=$(echo "$session_ctx" | jq -r '.focusTask // ""')
    if [[ "$focus_task" == "$id" ]]; then
      is_focused="true"
    fi
  fi

  # Output with standard schema and meta wrapper
  jq -nc \
    --arg version "$version" \
    --arg timestamp "$timestamp" \
    --argjson task "$task_data" \
    --argjson session "$session_ctx" \
    --argjson isFocused "$is_focused" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "command": "show",
        "timestamp": $timestamp,
        "version": $version,
        "session": $session
      },
      "success": true,
      "task": ($task + {_isFocused: $isFocused})
    }'
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
    --json)
      FORMAT="json"
      shift
      ;;
    --human)
      FORMAT="human"
      shift
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
    --verification)
      SHOW_VERIFICATION=true
      shift
      ;;
    -v|--verbose)
      VERBOSE=true
      shift
      ;;
    -q|--quiet)
      QUIET=true
      shift
      ;;
    -*)
      if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_INPUT_INVALID" "Unknown option: $1" "$EXIT_INVALID_INPUT" true "Run 'cleo show --help' for usage"
      else
        echo "Error: Unknown option: $1" >&2
      fi
      exit "${EXIT_INVALID_INPUT:-1}"
      ;;
    *)
      if [[ -z "$TASK_ID" ]]; then
        TASK_ID="$1"
      else
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
          output_error "E_INPUT_INVALID" "Multiple task IDs provided" "$EXIT_INVALID_INPUT" true "Provide only one task ID"
        else
          echo "Error: Multiple task IDs provided" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-1}"
      fi
      shift
      ;;
  esac
done

# Verbose mode enables additional details
if [[ "$VERBOSE" == true ]]; then
  SHOW_HISTORY=true
  SHOW_RELATED=true
fi

# Resolve format (TTY-aware auto-detection)
FORMAT=$(resolve_format "${FORMAT:-}")

# Validate task ID provided
if [[ -z "$TASK_ID" ]]; then
  if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
    output_error "E_INPUT_MISSING" "Task ID required" "$EXIT_INVALID_ID" true "Usage: cleo show <task-id>"
  else
    echo "Error: Task ID required" >&2
    echo "Usage: cleo show <task-id>" >&2
  fi
  exit $EXIT_INVALID_ID
fi

# Validate task ID format
if ! validate_task_id "$TASK_ID"; then
  if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
    output_error "E_INPUT_INVALID" "Invalid task ID format: $TASK_ID" "$EXIT_INVALID_ID" true "Task IDs must be in format: T001, T002, etc."
  else
    echo "Error: Invalid task ID format: $TASK_ID" >&2
    echo "Task IDs must be in format: T001, T002, etc." >&2
  fi
  exit $EXIT_INVALID_ID
fi

# Check todo file exists
if [[ ! -f "$TODO_FILE" ]]; then
  if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
    output_error "E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "$EXIT_FILE_ERROR" true "Run 'cleo init' to initialize"
  else
    echo "Error: Todo file not found: $TODO_FILE" >&2
    echo "Run 'cleo init' to initialize." >&2
  fi
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
  if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
    if [[ "$INCLUDE_ARCHIVE" == true ]]; then
      output_error "E_TASK_NOT_FOUND" "Task $TASK_ID not found in active tasks or archive" "$EXIT_NOT_FOUND" true "Verify task ID exists"
    else
      output_error "E_TASK_NOT_FOUND" "Task $TASK_ID not found" "$EXIT_NOT_FOUND" true "Use --include-archive to search archived tasks"
    fi
  else
    if [[ "$INCLUDE_ARCHIVE" == true ]]; then
      echo "Error: Task $TASK_ID not found in active tasks or archive" >&2
    else
      echo "Error: Task $TASK_ID not found" >&2
      echo "Tip: Use --include-archive to search archived tasks" >&2
    fi
  fi
  exit $EXIT_NOT_FOUND
fi

# Display task
case "$FORMAT" in
  json)
    display_json "$TASK" "$SOURCE"
    ;;
  text|*)
    if [[ "$QUIET" == true ]]; then
      display_text_quiet "$TASK" "$SOURCE"
    else
      display_text "$TASK" "$SOURCE"
    fi
    ;;
esac

exit $EXIT_SUCCESS
