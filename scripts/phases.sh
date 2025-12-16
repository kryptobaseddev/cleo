#!/usr/bin/env bash

#####################################################################
# phases.sh - Phase Management Command for Claude Todo System
#
# Manage and display workflow phases with progress tracking:
# - Show all phases with task counts and progress
# - Visual progress bars for each phase
# - Phase statistics and completion metrics
# - Show tasks for specific phases
#
# Usage:
#   phases.sh [SUBCOMMAND] [OPTIONS]
#
# Subcommands:
#   (none)            List all phases with progress (default)
#   show PHASE        Show tasks in specific phase
#   stats             Show detailed phase statistics
#
# Options:
#   --format FORMAT   Output format: text | json (default: text)
#   -h, --help        Show this help message
#
# Examples:
#   phases.sh                      # List all phases with progress
#   phases.sh show core            # Show tasks in 'core' phase
#   phases.sh stats                # Detailed statistics
#   phases.sh --format json        # JSON output
#
# Version: 0.9.0
# Part of: claude-todo CLI (Phase 3 - T069)
#####################################################################

set -euo pipefail

# Script and library paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"

# Source library functions
if [[ -f "${LIB_DIR}/file-ops.sh" ]]; then
  source "${LIB_DIR}/file-ops.sh"
elif [[ -f "$CLAUDE_TODO_HOME/lib/file-ops.sh" ]]; then
  source "$CLAUDE_TODO_HOME/lib/file-ops.sh"
fi

if [[ -f "${LIB_DIR}/logging.sh" ]]; then
  source "${LIB_DIR}/logging.sh"
elif [[ -f "$CLAUDE_TODO_HOME/lib/logging.sh" ]]; then
  source "$CLAUDE_TODO_HOME/lib/logging.sh"
fi

if [[ -f "${LIB_DIR}/output-format.sh" ]]; then
  source "${LIB_DIR}/output-format.sh"
elif [[ -f "$CLAUDE_TODO_HOME/lib/output-format.sh" ]]; then
  source "$CLAUDE_TODO_HOME/lib/output-format.sh"
fi

# Default configuration
OUTPUT_FORMAT="text"
SUBCOMMAND="list"
PHASE_ARG=""

# File paths
CLAUDE_DIR=".claude"
TODO_FILE="${TODO_FILE:-${CLAUDE_DIR}/todo.json}"

#####################################################################
# Usage
#####################################################################

usage() {
  cat << 'EOF'
Usage: claude-todo phases [SUBCOMMAND] [OPTIONS]

Manage and display workflow phases with progress tracking.

Subcommands:
    (none)            List all phases with progress (default)
    show PHASE        Show all tasks in specific phase
    stats             Detailed phase statistics

Options:
    --format, -f FORMAT   Output format: text | json (default: text)
    -h, --help            Show this help message

Examples:
    claude-todo phases                      # List all phases with progress
    claude-todo phases show core            # Show tasks in 'core' phase
    claude-todo phases stats                # Show detailed statistics
    claude-todo phases --format json        # JSON output

Output:
    Shows phases with task counts, progress bars, and completion status.
    Phases are ordered by their defined order in the configuration.

EOF
  exit 0
}

#####################################################################
# Color and Unicode Detection
#####################################################################

# Detect color support
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
  COLORS_ENABLED=true
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  MAGENTA='\033[0;35m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  NC='\033[0m'
else
  COLORS_ENABLED=false
  RED='' GREEN='' YELLOW='' BLUE='' MAGENTA='' CYAN='' BOLD='' DIM='' NC=''
fi

# Detect Unicode support
if declare -f detect_unicode_support >/dev/null 2>&1 && detect_unicode_support; then
  UNICODE_ENABLED=true
  PROGRESS_FILLED="█"
  PROGRESS_EMPTY="░"
  CHECK_MARK="✓"
  BULLET="•"
else
  UNICODE_ENABLED=false
  PROGRESS_FILLED="#"
  PROGRESS_EMPTY="-"
  CHECK_MARK="[x]"
  BULLET="*"
fi

#####################################################################
# Helper Functions
#####################################################################

log_error() {
  echo -e "${RED}[ERROR]${NC} $1" >&2
}

log_info() {
  if [[ "$OUTPUT_FORMAT" != "json" ]]; then
    echo -e "${DIM}[INFO]${NC} $1" >&2
  fi
}

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    exit 1
  fi
}

# Draw progress bar
draw_progress_bar() {
  local percent=$1
  local width=${2:-20}
  local filled=$((percent * width / 100))
  local empty=$((width - filled))

  local bar=""
  for ((i=0; i<filled; i++)); do
    bar+="$PROGRESS_FILLED"
  done
  for ((i=0; i<empty; i++)); do
    bar+="$PROGRESS_EMPTY"
  done

  echo "$bar"
}

# Get phase color based on completion percentage
get_phase_color() {
  local percent=$1
  if [[ $percent -ge 100 ]]; then
    echo "$GREEN"
  elif [[ $percent -ge 75 ]]; then
    echo "$CYAN"
  elif [[ $percent -ge 50 ]]; then
    echo "$YELLOW"
  elif [[ $percent -ge 25 ]]; then
    echo "$MAGENTA"
  else
    echo "$RED"
  fi
}

# Get phase status text
get_phase_status() {
  local done=$1
  local total=$2

  if [[ $total -eq 0 ]]; then
    echo "Empty"
  elif [[ $done -eq $total ]]; then
    echo "Completed"
  elif [[ $done -gt 0 ]]; then
    echo "In Progress"
  else
    echo "Pending"
  fi
}

#####################################################################
# Core Functions
#####################################################################

# Get all phases with their statistics
get_phase_stats() {
  jq -r '
    # Get phase definitions from project.phases (v2.2.0+) or .phases (legacy)
    (.project.phases // .phases // {}) as $phase_defs |

    # Get all tasks
    .tasks as $tasks |

    # Get unique phases from tasks
    [$tasks[].phase | select(. != null)] | unique as $used_phases |

    # Combine defined phases with used phases
    (($phase_defs | keys) + $used_phases) | unique as $all_phases |

    # Build stats for each phase
    [
      $all_phases[] | . as $slug |
      {
        slug: $slug,
        name: ($phase_defs[$slug].name // $slug),
        description: ($phase_defs[$slug].description // ""),
        order: ($phase_defs[$slug].order // 999),
        status: ($phase_defs[$slug].status // "pending"),
        tasks: [$tasks[] | select(.phase == $slug)],
        total: ([$tasks[] | select(.phase == $slug)] | length),
        done: ([$tasks[] | select(.phase == $slug and .status == "done")] | length),
        pending: ([$tasks[] | select(.phase == $slug and .status == "pending")] | length),
        active: ([$tasks[] | select(.phase == $slug and .status == "active")] | length),
        blocked: ([$tasks[] | select(.phase == $slug and .status == "blocked")] | length)
      }
    ] | sort_by(.order)
  ' "$TODO_FILE"
}

# List all phases
list_phases() {
  local phase_stats
  phase_stats=$(get_phase_stats)

  # Get current phase from focus.currentPhase (fallback to project.currentPhase for v2.2+)
  local current_phase
  current_phase=$(jq -r '
    if (.focus.currentPhase != null) then .focus.currentPhase
    elif (.project | type == "object" and .project.currentPhase != null) then .project.currentPhase
    else empty
    end
  ' "$TODO_FILE")

  local count
  count=$(echo "$phase_stats" | jq 'length')

  if [[ "$OUTPUT_FORMAT" == "json" ]]; then
    # Get currentPhase from todo.json
    local current_phase
    current_phase=$(jq -r '.focus.currentPhase // .project.currentPhase // null' "$TODO_FILE")

    echo "$phase_stats" | jq --arg cp "$current_phase" '{
      currentPhase: $cp,
      phases: [.[] | {
        slug: .slug,
        name: .name,
        description: .description,
        order: .order,
        status: .status,
        total: .total,
        done: .done,
        pending: .pending,
        active: .active,
        blocked: .blocked,
        percent: (if .total > 0 then ((.done * 100) / .total | floor) else 0 end)
      }],
      summary: {
        totalPhases: length,
        totalTasks: (reduce .[] as $p (0; . + $p.total)),
        completedTasks: (reduce .[] as $p (0; . + $p.done))
      }
    }'
    return
  fi

  if [[ $count -eq 0 ]]; then
    echo "No phases defined."
    echo ""
    echo "Add phases to .claude/todo.json under \"phases\" key:"
    echo '  "phases": {'
    echo '    "setup": {"name": "Setup", "description": "Initial setup", "order": 1},'
    echo '    "core": {"name": "Core", "description": "Core features", "order": 2}'
    echo '  }'
    return
  fi

  # Header
  echo -e "${BOLD}PHASES${NC}"
  echo "────────────────────────────────────────────────────────────"
  printf "%-12s %-20s %6s %6s %6s  %-20s  %s\n" "PHASE" "NAME" "DONE" "TOTAL" "%" "PROGRESS" "STATUS"
  echo "────────────────────────────────────────────────────────────"

  # List each phase
  echo "$phase_stats" | jq -c '.[]' | while IFS= read -r phase; do
    local slug name total done percent status bar color indicator

    slug=$(echo "$phase" | jq -r '.slug')
    name=$(echo "$phase" | jq -r '.name')
    total=$(echo "$phase" | jq -r '.total')
    done=$(echo "$phase" | jq -r '.done')

    if [[ $total -gt 0 ]]; then
      percent=$((done * 100 / total))
    else
      percent=0
    fi

    status=$(get_phase_status "$done" "$total")
    bar=$(draw_progress_bar "$percent" 20)
    color=$(get_phase_color "$percent")

    # Add current phase indicator
    if [[ -n "$current_phase" && "$slug" == "$current_phase" ]]; then
      indicator="${YELLOW}★${NC} "
    else
      indicator="  "
    fi

    printf "${indicator}%-12s %-20s %6d %6d %5d%%  ${color}%-20s${NC}  %s\n" \
      "$slug" "$name" "$done" "$total" "$percent" "$bar" "$status"
  done

  echo "────────────────────────────────────────────────────────────"

  # Summary
  local total_tasks total_done overall_percent
  total_tasks=$(echo "$phase_stats" | jq '[.[].total] | add // 0')
  total_done=$(echo "$phase_stats" | jq '[.[].done] | add // 0')

  if [[ $total_tasks -gt 0 ]]; then
    overall_percent=$((total_done * 100 / total_tasks))
  else
    overall_percent=0
  fi

  echo -e "${BOLD}Overall Progress:${NC} $total_done/$total_tasks tasks ($overall_percent%)"

  # Add legend if current phase is set
  if [[ -n "$current_phase" ]]; then
    echo ""
    echo -e "${YELLOW}★${NC} = Current project phase"
  fi
}

# Show tasks in specific phase
show_phase() {
  local phase_slug="$1"

  # Check if phase exists (support v2.2.0 project.phases and legacy .phases)
  local phase_exists
  phase_exists=$(jq --arg p "$phase_slug" '
    ((.project.phases // .phases)[$p] != null) or ([.tasks[].phase] | index($p) != null)
  ' "$TODO_FILE")

  if [[ "$phase_exists" != "true" ]]; then
    log_error "Phase '$phase_slug' not found"
    exit 1
  fi

  # Get phase info (support v2.2.0 project.phases and legacy .phases)
  local phase_info
  phase_info=$(jq --arg p "$phase_slug" '
    (.project.phases // .phases // {}) as $phases |
    {
      slug: $p,
      name: ($phases[$p].name // $p),
      description: ($phases[$p].description // ""),
      tasks: [.tasks[] | select(.phase == $p)]
    }
  ' "$TODO_FILE")

  if [[ "$OUTPUT_FORMAT" == "json" ]]; then
    echo "$phase_info"
    return
  fi

  local name description
  name=$(echo "$phase_info" | jq -r '.name')
  description=$(echo "$phase_info" | jq -r '.description')

  echo -e "${BOLD}Phase: $name${NC} ($phase_slug)"
  if [[ -n "$description" && "$description" != "" ]]; then
    echo -e "${DIM}$description${NC}"
  fi
  echo ""

  # List tasks
  local task_count
  task_count=$(echo "$phase_info" | jq '.tasks | length')

  if [[ $task_count -eq 0 ]]; then
    echo "No tasks in this phase."
    return
  fi

  echo "Tasks ($task_count):"
  echo "────────────────────────────────────────────────────────────"

  echo "$phase_info" | jq -r '.tasks[] | "\(.id)\t\(.status)\t\(.priority)\t\(.title)"' | \
  while IFS=$'\t' read -r id status priority title; do
    local status_icon color
    case "$status" in
      done) status_icon="$CHECK_MARK"; color="$GREEN" ;;
      active) status_icon="◉"; color="$CYAN" ;;
      blocked) status_icon="⊗"; color="$RED" ;;
      *) status_icon="○"; color="$NC" ;;
    esac

    printf "  ${color}%s${NC} %-6s %-8s %-8s %s\n" "$status_icon" "$id" "$status" "$priority" "$title"
  done
}

# Show detailed phase statistics
show_stats() {
  local phase_stats
  phase_stats=$(get_phase_stats)

  if [[ "$OUTPUT_FORMAT" == "json" ]]; then
    echo "$phase_stats" | jq '{
      phases: [.[] | {
        slug: .slug,
        name: .name,
        total: .total,
        done: .done,
        pending: .pending,
        active: .active,
        blocked: .blocked,
        percent: (if .total > 0 then ((.done * 100) / .total | floor) else 0 end),
        tasksByPriority: {
          critical: ([.tasks[] | select(.priority == "critical")] | length),
          high: ([.tasks[] | select(.priority == "high")] | length),
          medium: ([.tasks[] | select(.priority == "medium")] | length),
          low: ([.tasks[] | select(.priority == "low")] | length)
        }
      }],
      summary: {
        totalPhases: length,
        totalTasks: (reduce .[] as $p (0; . + $p.total)),
        completedTasks: (reduce .[] as $p (0; . + $p.done)),
        activeTasks: (reduce .[] as $p (0; . + $p.active)),
        blockedTasks: (reduce .[] as $p (0; . + $p.blocked))
      }
    }'
    return
  fi

  echo -e "${BOLD}PHASE STATISTICS${NC}"
  echo "════════════════════════════════════════════════════════════"
  echo ""

  echo "$phase_stats" | jq -c '.[]' | while IFS= read -r phase; do
    local slug name total done pending active blocked percent

    slug=$(echo "$phase" | jq -r '.slug')
    name=$(echo "$phase" | jq -r '.name')
    total=$(echo "$phase" | jq -r '.total')
    done=$(echo "$phase" | jq -r '.done')
    pending=$(echo "$phase" | jq -r '.pending')
    active=$(echo "$phase" | jq -r '.active')
    blocked=$(echo "$phase" | jq -r '.blocked')

    if [[ $total -gt 0 ]]; then
      percent=$((done * 100 / total))
    else
      percent=0
    fi

    local bar color
    bar=$(draw_progress_bar "$percent" 30)
    color=$(get_phase_color "$percent")

    echo -e "${BOLD}$name${NC} ($slug)"
    echo -e "  ${color}$bar${NC} $percent%"
    echo "  Done: $done | Pending: $pending | Active: $active | Blocked: $blocked"

    # Priority breakdown
    local critical high medium low
    critical=$(echo "$phase" | jq '[.tasks[] | select(.priority == "critical")] | length')
    high=$(echo "$phase" | jq '[.tasks[] | select(.priority == "high")] | length')
    medium=$(echo "$phase" | jq '[.tasks[] | select(.priority == "medium")] | length')
    low=$(echo "$phase" | jq '[.tasks[] | select(.priority == "low")] | length')

    echo -e "  Priority: ${RED}$critical critical${NC} | ${YELLOW}$high high${NC} | ${BLUE}$medium medium${NC} | ${DIM}$low low${NC}"
    echo ""
  done

  # Overall summary
  local total_tasks total_done total_active total_blocked overall_percent
  total_tasks=$(echo "$phase_stats" | jq '[.[].total] | add // 0')
  total_done=$(echo "$phase_stats" | jq '[.[].done] | add // 0')
  total_active=$(echo "$phase_stats" | jq '[.[].active] | add // 0')
  total_blocked=$(echo "$phase_stats" | jq '[.[].blocked] | add // 0')

  if [[ $total_tasks -gt 0 ]]; then
    overall_percent=$((total_done * 100 / total_tasks))
  else
    overall_percent=0
  fi

  echo "════════════════════════════════════════════════════════════"
  echo -e "${BOLD}OVERALL SUMMARY${NC}"
  echo "  Total Phases: $(echo "$phase_stats" | jq 'length')"
  echo "  Total Tasks: $total_tasks"
  echo "  Completed: $total_done ($overall_percent%)"
  echo "  Active: $total_active"
  echo "  Blocked: $total_blocked"
}

#####################################################################
# Main
#####################################################################

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      usage
      ;;
    -f|--format)
      OUTPUT_FORMAT="$2"
      shift 2
      ;;
    show)
      SUBCOMMAND="show"
      if [[ $# -gt 1 && ! "$2" =~ ^- ]]; then
        PHASE_ARG="$2"
        shift
      fi
      shift
      ;;
    stats)
      SUBCOMMAND="stats"
      shift
      ;;
    list)
      SUBCOMMAND="list"
      shift
      ;;
    *)
      # If it looks like a phase slug and we haven't set a subcommand
      if [[ "$SUBCOMMAND" == "list" && ! "$1" =~ ^- ]]; then
        SUBCOMMAND="show"
        PHASE_ARG="$1"
      fi
      shift
      ;;
  esac
done

# Validate format
if [[ "$OUTPUT_FORMAT" != "text" && "$OUTPUT_FORMAT" != "json" ]]; then
  log_error "Invalid format: $OUTPUT_FORMAT (must be text or json)"
  exit 1
fi

check_deps

# Check if todo.json exists
if [[ ! -f "$TODO_FILE" ]]; then
  log_error "todo.json not found. Run 'claude-todo init' first."
  exit 1
fi

# Execute subcommand
case "$SUBCOMMAND" in
  list)
    list_phases
    ;;
  show)
    if [[ -z "$PHASE_ARG" ]]; then
      log_error "Phase slug required. Usage: claude-todo phases show <phase>"
      exit 1
    fi
    show_phase "$PHASE_ARG"
    ;;
  stats)
    show_stats
    ;;
  *)
    log_error "Unknown subcommand: $SUBCOMMAND"
    usage
    ;;
esac
