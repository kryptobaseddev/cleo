#!/usr/bin/env bash

#####################################################################
# next.sh - Next Task Suggestion Command for Claude Todo System
#
# Intelligently suggests the next task to work on based on:
# - Task priority (critical > high > medium > low)
# - Dependency status (only tasks with satisfied dependencies)
# - Current phase alignment (bonus for same phase as project.currentPhase)
# - Task age (older tasks prioritized for ties)
# - Blocked status (exclude blocked tasks)
#
# Usage:
#   next.sh [OPTIONS]
#
# Options:
#   --explain         Show detailed reasoning for suggestion
#   --count N         Show top N suggestions (default: 1)
#   --format FORMAT   Output format: text | json (default: text)
#   -h, --help        Show this help message
#
# Algorithm:
#   1. Filter: status=pending AND not blocked by incomplete tasks
#   2. Sort by: priority (desc), phase alignment, created (asc)
#   3. Apply scoring: priority + dependency_readiness + phase_bonus
#
# Examples:
#   next.sh                    # Get single best suggestion
#   next.sh --explain          # Show why this task is suggested
#   next.sh --count 3          # Show top 3 suggestions
#   next.sh --format json      # JSON output for scripting
#
# Version: 0.8.0
# Part of: cleo CLI Output Enhancement (Phase 2)
#####################################################################

set -euo pipefail

# Script and library paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source version from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Source library functions
if [[ -f "${LIB_DIR}/file-ops.sh" ]]; then
  source "${LIB_DIR}/file-ops.sh"
elif [[ -f "$CLEO_HOME/lib/file-ops.sh" ]]; then
  source "$CLEO_HOME/lib/file-ops.sh"
fi

if [[ -f "${LIB_DIR}/logging.sh" ]]; then
  source "${LIB_DIR}/logging.sh"
elif [[ -f "$CLEO_HOME/lib/logging.sh" ]]; then
  source "$CLEO_HOME/lib/logging.sh"
fi

if [[ -f "${LIB_DIR}/output-format.sh" ]]; then
  source "${LIB_DIR}/output-format.sh"
elif [[ -f "$CLEO_HOME/lib/output-format.sh" ]]; then
  source "$CLEO_HOME/lib/output-format.sh"
fi

if [[ -f "${LIB_DIR}/exit-codes.sh" ]]; then
  source "${LIB_DIR}/exit-codes.sh"
elif [[ -f "$CLEO_HOME/lib/exit-codes.sh" ]]; then
  source "$CLEO_HOME/lib/exit-codes.sh"
fi

# Source error JSON library
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
fi

# Source hierarchy library for hierarchy awareness (T346)
if [[ -f "$LIB_DIR/hierarchy.sh" ]]; then
  source "$LIB_DIR/hierarchy.sh"
elif [[ -f "$CLEO_HOME/lib/hierarchy.sh" ]]; then
  source "$CLEO_HOME/lib/hierarchy.sh"
fi

# Default configuration
SHOW_EXPLAIN=false
SUGGESTION_COUNT=1
FORMAT=""
QUIET=false
COMMAND_NAME="next"

# File paths
CLEO_DIR="${CLEO_DIR:-$(pwd)/.cleo}"
TODO_FILE="${TODO_FILE:-$CLEO_DIR/todo.json}"

#####################################################################
# Usage
#####################################################################

usage() {
  cat << 'EOF'
Usage: cleo next [OPTIONS]

Suggest the next task to work on based on priority and dependencies.

Options:
    -e, --explain     Show detailed reasoning for suggestion
    -c, --count N     Show top N suggestions (default: 1)
    -f, --format FORMAT   Output format: text | json (default: text)
    --json            Shortcut for --format json
    --human           Shortcut for --format text
    -q, --quiet       Suppress decorative output (headers, footers)
    -h, --help        Show this help message

Algorithm:
    1. Filter tasks that are pending and not blocked
    2. Check dependencies - only suggest if all dependencies are done
    3. Score by priority: critical=100, high=75, medium=50, low=25
    4. Add phase bonus if matches project.currentPhase (or focused task phase)
    5. Break ties by creation date (oldest first)

Examples:
    cleo next                    # Get single best suggestion
    cleo next --explain          # Show why this task is suggested
    cleo next --count 3          # Show top 3 suggestions
    cleo next --format json      # JSON output

Output:
    Shows the suggested task with its ID, title, priority, and phase.
    With --explain, shows why this task was chosen over alternatives.
EOF
  exit "$EXIT_SUCCESS"
}

#####################################################################
# Helper Functions
#####################################################################

# Get ANSI color codes (respects NO_COLOR)
get_colors() {
  if detect_color_support 2>/dev/null; then
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
}

# Get current focus task ID
get_current_focus() {
  jq -r '.focus.currentTask // ""' "$TODO_FILE" 2>/dev/null
}

# Get current phase - prioritizes project.currentPhase (v2.2.0+), falls back to focused task phase
get_current_phase() {
  # First try project.currentPhase (v2.2.0+)
  local project_phase
  project_phase=$(jq -r '.project.currentPhase // empty' "$TODO_FILE" 2>/dev/null)

  if [[ -n "$project_phase" && "$project_phase" != "null" ]]; then
    echo "$project_phase"
    return
  fi

  # Fallback: derive from focused task (v2.1.x behavior)
  local focus_id
  focus_id=$(get_current_focus)
  if [[ -n "$focus_id" && "$focus_id" != "null" ]]; then
    jq -r --arg id "$focus_id" '.tasks[] | select(.id == $id) | .phase // ""' "$TODO_FILE" 2>/dev/null
  else
    echo ""
  fi
}

# Check if a task's dependencies are all done
check_dependencies_satisfied() {
  local task_id="$1"

  # Get task's dependencies
  local deps
  deps=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .depends // [] | .[]' "$TODO_FILE" 2>/dev/null)

  if [[ -z "$deps" ]]; then
    # No dependencies, all satisfied
    echo "true"
    return
  fi

  # Check each dependency
  while IFS= read -r dep_id; do
    [[ -z "$dep_id" ]] && continue

    local dep_status
    dep_status=$(jq -r --arg id "$dep_id" '.tasks[] | select(.id == $id) | .status // "unknown"' "$TODO_FILE" 2>/dev/null)

    if [[ "$dep_status" != "done" ]]; then
      echo "false"
      return
    fi
  done <<< "$deps"

  echo "true"
}

# Get unsatisfied dependencies for a task
get_unsatisfied_deps() {
  local task_id="$1"

  jq -r --arg id "$task_id" '
    (.tasks[] | select(.id == $id) | .depends // []) as $deps |
    [.tasks[] | select(.id as $tid | $deps | contains([$tid])) | select(.status != "done") | .id] |
    join(", ")
  ' "$TODO_FILE" 2>/dev/null
}

# Calculate priority score
priority_score() {
  local priority="$1"
  case "$priority" in
    critical) echo 100 ;;
    high)     echo 75 ;;
    medium)   echo 50 ;;
    low)      echo 25 ;;
    *)        echo 0 ;;
  esac
}

# Get the root epic for a task (traverse up hierarchy)
get_task_epic() {
  local task_id="$1"
  local todo_file="$2"
  local current_id="$task_id"
  local max_depth=5
  local depth=0

  while [[ $depth -lt $max_depth ]]; do
    local task_data=$(jq --arg id "$current_id" '.tasks[] | select(.id == $id)' "$todo_file")
    local task_type=$(echo "$task_data" | jq -r '.type // "task"')
    local parent_id=$(echo "$task_data" | jq -r '.parentId // ""')

    if [[ "$task_type" == "epic" ]]; then
      echo "$current_id"
      return
    fi

    if [[ -z "$parent_id" || "$parent_id" == "null" ]]; then
      break
    fi

    current_id="$parent_id"
    ((depth++))
  done

  echo ""  # No epic found
}

# Get all candidate tasks with scores
get_scored_tasks() {
  local current_phase="$1"
  
  # Get current focus epic for hierarchy scoring
  local focus_epic=""
  if [[ -f "$TODO_FILE" ]]; then
    local focus_task=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
    if [[ -n "$focus_task" ]]; then
      focus_epic=$(get_task_epic "$focus_task" "$TODO_FILE")
    fi
  fi

  # Get all pending tasks that aren't blocked
  jq -r --arg phase "$current_phase" --arg focus_epic "$focus_epic" '
    [.tasks[] |
      select(.status == "pending") |
      {
        id: .id,
        title: .title,
        priority: .priority,
        phase: (.phase // ""),
        createdAt: .createdAt,
        depends: (.depends // []),
        labels: (.labels // []),
        parentId: (.parentId // null),
        type: (.type // "task")
      }
    ] |
    map(. + {
      priorityScore: (if .priority == "critical" then 100
                      elif .priority == "high" then 75
                      elif .priority == "medium" then 50
                      else 25 end),
      phaseBonus: (if .phase == $phase and $phase != "" then 30 else 0 end),
      focusEpic: (if $focus_epic != "" then $focus_epic else null end),
      hierarchyScore: 0  # Will be calculated later
    })
  ' "$TODO_FILE" 2>/dev/null
}

# Filter tasks with satisfied dependencies
filter_ready_tasks() {
  local tasks_json="$1"

  local result="[]"

  # Process each task
  while IFS= read -r task; do
    [[ -z "$task" ]] && continue

    local task_id
    task_id=$(echo "$task" | jq -r '.id')

    local deps_ok
    deps_ok=$(check_dependencies_satisfied "$task_id")

    if [[ "$deps_ok" == "true" ]]; then
      # Add to result
      result=$(echo "$result" | jq --argjson task "$task" '. += [$task + {depsReady: true}]')
    fi
  done < <(echo "$tasks_json" | jq -c '.[]')

  echo "$result"
}

# Calculate hierarchy scores for tasks
apply_hierarchy_scoring() {
  local tasks_json="$1"

  # Get current focus epic for hierarchy scoring
  local focus_epic=""
  if [[ -f "$TODO_FILE" ]]; then
    local focus_task=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
    if [[ -n "$focus_task" ]]; then
      focus_epic=$(get_task_epic "$focus_task" "$TODO_FILE")
    fi
  fi

  # Get the current tasks data for leaf checking
  # Use slurpfile to avoid jq warnings on large projects (fixes argument size limit)
  local tmp_tasks
  tmp_tasks=$(mktemp)
  jq -c '.tasks' "$TODO_FILE" > "$tmp_tasks"

  echo "$tasks_json" | jq --arg focus_epic "$focus_epic" --slurpfile tasks_data "$tmp_tasks" '
    ($tasks_data[0] // []) as $all_tasks |
    map(. as $task |
      . + {
        hierarchyScore: (
          # Same epic bonus (+30)
          (if $focus_epic != "" and $focus_epic != null then
            (if (.parentId // null) != null and (.type // "task") != "epic" then
              30
            else 0 end)
          else 0 end) +
          # Leaf task bonus (+10) - tasks with no children
          (if ([$all_tasks[] | select(.parentId == $task.id)] | length) == 0 then
            10
          else 0 end)
        )
      }
    )
  '
  rm -f "$tmp_tasks"
}

# Sort tasks by score (priority + phase bonus + hierarchy) and creation date
sort_tasks() {
  local tasks_json="$1"

  echo "$tasks_json" | jq '
    sort_by(-(.priorityScore + .phaseBonus + .hierarchyScore), .createdAt)
  '
}

# Get the top N suggestions
get_suggestions() {
  local count="$1"
  local current_phase
  current_phase=$(get_current_phase)

  # Get all pending tasks with scores
  local scored_tasks
  scored_tasks=$(get_scored_tasks "$current_phase")

  # Apply hierarchy scoring
  local scored_with_hierarchy
  scored_with_hierarchy=$(apply_hierarchy_scoring "$scored_tasks")

  # Filter to only tasks with satisfied dependencies
  local ready_tasks
  ready_tasks=$(filter_ready_tasks "$scored_with_hierarchy")

  # Sort by score and get top N
  local sorted_tasks
  sorted_tasks=$(sort_tasks "$ready_tasks")

  echo "$sorted_tasks" | jq --argjson n "$count" '.[:$n]'
}

#####################################################################
# Output Formatters
#####################################################################

# Output quiet text format (minimal, no decorations)
output_text_quiet() {
  local suggestions="$1"
  local count
  count=$(echo "$suggestions" | jq -r 'length')

  if [[ "$count" -eq 0 ]]; then
    # In quiet mode, just output nothing for no suggestions
    return
  fi

  # Output just the essential task info: ID, title, priority, phase
  echo "$suggestions" | jq -c '.[]' | while read -r task; do
    local task_id title priority phase
    task_id=$(echo "$task" | jq -r '.id')
    title=$(echo "$task" | jq -r '.title')
    priority=$(echo "$task" | jq -r '.priority')
    phase=$(echo "$task" | jq -r '.phase // ""')

    if [[ -n "$phase" && "$phase" != "null" ]]; then
      echo "$task_id $title [$priority] ($phase)"
    else
      echo "$task_id $title [$priority]"
    fi
  done
}

# Output text format
output_text_format() {
  local suggestions="$1"
  local count
  count=$(echo "$suggestions" | jq -r 'length')

  get_colors

  if [[ "$count" -eq 0 ]]; then
    echo ""
    echo -e "${YELLOW}No tasks available to work on.${NC}"
    echo ""
    echo "Possible reasons:"
    echo "  - All pending tasks have unsatisfied dependencies"
    echo "  - All tasks are completed or blocked"
    echo "  - No tasks exist"
    echo ""
    return
  fi

  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  echo ""
  if [[ "$count" -eq 1 ]]; then
    echo -e "${BOLD}Suggested Next Task${NC}"
  else
    echo -e "${BOLD}Top $count Suggested Tasks${NC}"
  fi
  echo ""

  local rank=1
  echo "$suggestions" | jq -c '.[]' | while read -r task; do
    local task_id title priority phase score hierarchy_score parent_context
    task_id=$(echo "$task" | jq -r '.id')
    title=$(echo "$task" | jq -r '.title')
    priority=$(echo "$task" | jq -r '.priority')
    phase=$(echo "$task" | jq -r '.phase // "none"')
    
    # Calculate hierarchy score
    hierarchy_score=0
    parent_context=""
    
    # Check if task is in same epic as focused task
    local focus_epic=$(echo "$task" | jq -r '.focusEpic // ""')
    local task_epic=$(get_task_epic "$task_id" "$TODO_FILE")
    if [[ "$task_epic" == "$focus_epic" && -n "$focus_epic" ]]; then
      hierarchy_score=$((hierarchy_score + 30))
    fi
    
    # Prefer leaf tasks (no children)
    local child_count=$(jq --arg id "$task_id" '[.tasks[] | select(.parentId == $id)] | length' "$TODO_FILE")
    if [[ "$child_count" -eq 0 ]]; then
      hierarchy_score=$((hierarchy_score + 10))
    fi
    
    # Bonus if siblings are mostly done (momentum)
    local task_parent=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .parentId // ""' "$TODO_FILE")
    if [[ -n "$task_parent" && "$task_parent" != "null" ]]; then
      local sibling_total=$(jq --arg pid "$task_parent" '[.tasks[] | select(.parentId == $pid)] | length' "$TODO_FILE")
      local sibling_done=$(jq --arg pid "$task_parent" '[.tasks[] | select(.parentId == $pid and .status == "done")] | length' "$TODO_FILE")
      if [[ $sibling_total -gt 0 ]]; then
        local completion_pct=$((sibling_done * 100 / sibling_total))
        if [[ $completion_pct -ge 50 ]]; then
          hierarchy_score=$((hierarchy_score + 5))  # Momentum bonus
        fi
      fi

      # Build parent context for output
      local parent_title=$(jq -r --arg id "$task_parent" '.tasks[] | select(.id == $id) | .title' "$TODO_FILE")
      parent_context="Parent: $task_parent - $parent_title"
    fi
    
    score=$(echo "$task" | jq -r '.priorityScore + .phaseBonus')
    score=$((score + hierarchy_score))

    local priority_sym
    priority_sym=$(priority_symbol "$priority" "$unicode")

    if [[ "$rank" -eq 1 ]]; then
      echo -e "${CYAN}${priority_sym} ${BOLD}[$task_id]${NC} $title"
    else
      echo -e "   ${priority_sym} [$task_id] $title"
    fi
    echo -e "     Priority: ${priority}  Phase: ${phase}"
    [[ -n "$parent_context" ]] && echo -e "     $parent_context"

    if [[ "$SHOW_EXPLAIN" == "true" ]]; then
      local phase_bonus
      phase_bonus=$(echo "$task" | jq -r '.phaseBonus')

      echo ""
      echo -e "     ${DIM}Score: $score (priority:$(echo "$task" | jq -r '.priorityScore'), phase:$phase_bonus, hierarchy:$hierarchy_score)${NC}"

      local deps
      deps=$(echo "$task" | jq -r '.depends | if length > 0 then join(", ") else "none" end')
      echo -e "     ${DIM}Dependencies: $deps (all satisfied)${NC}"

      if [[ "$phase_bonus" -gt 0 ]]; then
        echo -e "     ${GREEN}+ Same phase as current focus${NC}"
      fi
      
      if [[ "$hierarchy_score" -gt 0 ]]; then
        echo -e "     ${GREEN}+ Hierarchy bonus: $hierarchy_score${NC}"
      fi
    fi

    echo ""
    rank=$((rank + 1))
  done

  # Show command to start working
  local first_id
  first_id=$(echo "$suggestions" | jq -r '.[0].id')
  echo -e "${DIM}To start working:${NC}"
  echo -e "  cleo focus set $first_id"
  echo ""
}

# Output explain format (more detailed reasoning)
output_explain_format() {
  local suggestions="$1"
  local count
  count=$(echo "$suggestions" | jq -r 'length')

  get_colors

  if [[ "$count" -eq 0 ]]; then
    output_text_format "$suggestions"
    return
  fi

  echo ""
  echo -e "${BOLD}Task Suggestion Analysis${NC}"
  echo ""

  # Get statistics
  local total_pending
  total_pending=$(jq -r '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")
  local blocked_by_deps
  blocked_by_deps=$((total_pending - count))

  echo "Analysis:"
  echo "  Total pending tasks: $total_pending"
  echo "  Tasks with satisfied deps: $count"
  if [[ "$blocked_by_deps" -gt 0 ]]; then
    echo -e "  ${YELLOW}Tasks blocked by dependencies: $blocked_by_deps${NC}"
  fi
  echo ""

  # Show current phase context
  local current_phase
  current_phase=$(get_current_phase)
  if [[ -n "$current_phase" ]]; then
    # Determine phase source (project.currentPhase or focused task)
    local project_phase
    project_phase=$(jq -r '.project.currentPhase // empty' "$TODO_FILE" 2>/dev/null)

    if [[ -n "$project_phase" && "$project_phase" != "null" ]]; then
      echo "Current project phase: $current_phase"
      echo "  (From project.currentPhase - tasks in this phase get +30 bonus score)"
    else
      echo "Current focus phase: $current_phase"
      echo "  (From focused task - tasks in this phase get +30 bonus score)"
    fi
    echo ""
  fi

  echo -e "${BOLD}Scoring Breakdown:${NC}"
  echo "  Priority:  critical=100, high=75, medium=50, low=25"
  echo "  Phase match: +30"
  echo "  Dependencies: Must all be 'done'"
  echo ""

  # Now show the suggestions with full reasoning
  SHOW_EXPLAIN=true
  output_text_format "$suggestions"

  # Show what's blocked
  if [[ "$blocked_by_deps" -gt 0 ]]; then
    echo -e "${DIM}Tasks blocked by dependencies:${NC}"
    jq -r '.tasks[] | select(.status == "pending") | select(.depends != null) | select((.depends | length) > 0) | "\(.id) \(.title)"' "$TODO_FILE" 2>/dev/null | head -5 | while read -r line; do
      local task_id="${line%% *}"
      local unsatisfied
      unsatisfied=$(get_unsatisfied_deps "$task_id")
      if [[ -n "$unsatisfied" ]]; then
        echo "  $line"
        echo -e "    ${YELLOW}Waiting on: $unsatisfied${NC}"
      fi
    done
    echo ""
  fi
}

# Output JSON format
output_json_format() {
  local suggestions="$1"

  local current_phase
  current_phase=$(get_current_phase)

  local current_focus
  current_focus=$(get_current_focus)

  local total_pending
  total_pending=$(jq -r '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")

  jq -n \
    --argjson suggestions "$suggestions" \
    --arg currentPhase "$current_phase" \
    --arg currentFocus "$current_focus" \
    --argjson totalPending "$total_pending" \
    --argjson requestedCount "$SUGGESTION_COUNT" \
    --arg version "$VERSION" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "next",
        "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
      },
      "context": {
        "currentFocus": (if $currentFocus == "" then null else $currentFocus end),
        "currentPhase": (if $currentPhase == "" then null else $currentPhase end),
        "totalPending": $totalPending,
        "eligibleCount": ($suggestions | length)
      },
      "suggestions": ($suggestions | map({
        taskId: .id,
        title: .title,
        priority: .priority,
        phase: .phase,
        score: (.priorityScore + .phaseBonus + .hierarchyScore),
        scoring: {
          priorityScore: .priorityScore,
          phaseBonus: .phaseBonus,
          hierarchyScore: .hierarchyScore,
          depsReady: .depsReady
        },
        labels: .labels
      })),
      "success": true,
      "recommendation": (if ($suggestions | length) > 0 then {
        taskId: $suggestions[0].id,
        command: ("cleo focus set " + $suggestions[0].id)
      } else null end)
    }'
}

#####################################################################
# Argument Parsing
#####################################################################

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --explain|-e)
        SHOW_EXPLAIN=true
        shift
        ;;
      --count|-c|-n)
        SUGGESTION_COUNT="$2"
        if ! [[ "$SUGGESTION_COUNT" =~ ^[0-9]+$ ]] || [[ "$SUGGESTION_COUNT" -lt 1 ]]; then
          if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "$E_INPUT_INVALID" "--count must be a positive integer" "${EXIT_INVALID_INPUT:-1}" true "Example: --count 3"
          else
            output_error "$E_INPUT_INVALID" "--count must be a positive integer"
          fi
          exit "${EXIT_INVALID_INPUT:-1}"
        fi
        shift 2
        ;;
      -f|--format)
        FORMAT="$2"
        if ! validate_format "$FORMAT" "text,json"; then
          exit "$EXIT_INVALID_INPUT"
        fi
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
      -q|--quiet)
        QUIET=true
        shift
        ;;
      --help|-h)
        usage
        ;;
      *)
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
          output_error "$E_INPUT_INVALID" "Unknown option: $1" "${EXIT_INVALID_INPUT:-1}" true "Run 'cleo next --help' for usage"
        else
          output_error "$E_INPUT_INVALID" "Unknown option: $1"
          echo "Run 'cleo next --help' for usage" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-1}"
        ;;
    esac
  done
}

#####################################################################
# Main Execution
#####################################################################

main() {
  parse_arguments "$@"

  # Resolve format (TTY-aware auto-detection)
  FORMAT=$(resolve_format "${FORMAT:-}")

  # Check if in a todo-enabled project
  if [[ ! -f "$TODO_FILE" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "$E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "${EXIT_NOT_INITIALIZED:-1}" true "Run 'cleo init' first"
    else
      output_error "$E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE"
      echo "Run 'cleo init' first" >&2
    fi
    exit "${EXIT_NOT_INITIALIZED:-1}"
  fi

  # Check required commands
  if ! command -v jq &>/dev/null; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed" "${EXIT_DEPENDENCY_MISSING:-1}" true "Install jq: https://stedolan.github.io/jq/download/"
    else
      output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed"
    fi
    exit "${EXIT_DEPENDENCY_MISSING:-1}"
  fi

  # Get suggestions
  local suggestions
  suggestions=$(get_suggestions "$SUGGESTION_COUNT")

  # Output in requested format
  case "$FORMAT" in
    json)
      output_json_format "$suggestions"
      ;;
    text)
      if [[ "$QUIET" == "true" ]]; then
        output_text_quiet "$suggestions"
      elif [[ "$SHOW_EXPLAIN" == "true" ]]; then
        output_explain_format "$suggestions"
      else
        output_text_format "$suggestions"
      fi
      ;;
  esac
}

main "$@"
