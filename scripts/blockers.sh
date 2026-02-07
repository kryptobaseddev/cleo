#!/usr/bin/env bash
###CLEO
# command: blockers
# category: read
# synopsis: Show blocked tasks and analyze blocking chains/critical path
# relevance: high
# flags: --format,--quiet,--analyze
# exits: 0,100
# json-output: true
###END
# CLEO Blockers Command Script
# Analyze blocked tasks and their dependency chains
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Capture start time for execution metrics (nanoseconds)
START_TIME_NS=$(date +%s%N 2>/dev/null || echo "0")

# Source version from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"

# Source logging library for should_use_color function
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  # shellcheck source=../lib/logging.sh
  source "$LIB_DIR/logging.sh"
fi

# Source output-format library for Unicode detection
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  # shellcheck source=../lib/output-format.sh
  source "$LIB_DIR/output-format.sh"
fi

# Source analysis library for critical path analysis
if [[ -f "$LIB_DIR/analysis.sh" ]]; then
  # shellcheck source=../lib/analysis.sh
  source "$LIB_DIR/analysis.sh"
fi

# shellcheck source=../lib/flags.sh
source "$LIB_DIR/flags.sh"

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/exit-codes.sh
  source "$LIB_DIR/exit-codes.sh"
fi

# Detect Unicode support (respects NO_COLOR, LANG=C, config)
if declare -f detect_unicode_support >/dev/null 2>&1 && detect_unicode_support; then
  UNICODE_ENABLED=true
else
  UNICODE_ENABLED=false
fi

# Colors (respects NO_COLOR and FORCE_COLOR environment variables per https://no-color.org)
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

# Defaults
SUBCOMMAND=""
COMMAND_NAME="blockers"

# Initialize flag defaults
init_flag_defaults

usage() {
  cat << EOF
Usage: $(basename "$0") [SUBCOMMAND] [OPTIONS]

Analyze blocked tasks and their dependency chains.

Subcommands:
  list          List all blocked tasks (default)
  analyze       Analyze blocking chains and show recommendations

Options:
  -f, --format FORMAT   Output format: text|json|markdown (default: text)
  --json                Shortcut for --format json
  --human               Shortcut for --format text
  -q, --quiet           Suppress informational messages
  -h, --help            Show this help

Examples:
  $(basename "$0")                    # List all blocked tasks
  $(basename "$0") list               # Same as above
  $(basename "$0") analyze            # Show detailed analysis
  $(basename "$0") analyze -f json    # JSON output with analysis
EOF
  exit 0
}

log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_DEPENDENCY_MISSING" "jq is required but not installed" "${EXIT_DEPENDENCY_ERROR:-5}" true "Install jq: https://stedolan.github.io/jq/download/"
    else
      log_error "jq is required but not installed"
    fi
    exit "${EXIT_DEPENDENCY_ERROR:-5}"
  fi
}

# Parse common flags first
parse_common_flags "$@"
set -- "${REMAINING_ARGS[@]}"

# Bridge to legacy variables
apply_flags_to_globals
FORMAT="${FORMAT:-}"
QUIET="${QUIET:-false}"

# Handle help flag
if [[ "$FLAG_HELP" == true ]]; then
  usage
fi

# Parse command-specific arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    list|analyze)
      SUBCOMMAND="$1"
      shift
      ;;
    -*)
      if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_INPUT_INVALID" "Unknown option: $1" "${EXIT_INVALID_INPUT:-2}" true "Run 'cleo blockers --help' for usage"
      else
        log_error "Unknown option: $1"
      fi
      exit "${EXIT_INVALID_INPUT:-2}"
      ;;
    *)
      # First positional argument is subcommand if not already set
      if [[ -z "$SUBCOMMAND" ]]; then
        SUBCOMMAND="$1"
      fi
      shift
      ;;
  esac
done

# Default subcommand
[[ -z "$SUBCOMMAND" ]] && SUBCOMMAND="list"

# Resolve format (TTY-aware auto-detection)
FORMAT=$(resolve_format "${FORMAT:-}")

check_deps

# Check if todo.json exists
if [[ ! -f "$TODO_FILE" ]]; then
  if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
    output_error "E_NOT_INITIALIZED" "$TODO_FILE not found" "${EXIT_FILE_ERROR:-3}" true "Run 'cleo init' to initialize project"
  else
    log_error "$TODO_FILE not found. Run cleo init first."
  fi
  exit "${EXIT_FILE_ERROR:-3}"
fi

# Load tasks from todo.json
TASKS=$(jq -c '.tasks[]' "$TODO_FILE" 2>/dev/null || echo "")

# Handle empty task list
if [[ -z "$TASKS" ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    echo '{"blockedTasks":[],"count":0}'
  elif [[ "$QUIET" != true ]]; then
    echo "No tasks found."
  fi
  exit 0
fi

# Get blocked tasks (status=blocked OR has depends array with incomplete tasks)
get_blocked_tasks() {
  echo "$TASKS" | jq -s '
    # Create lookup map of task statuses
    (reduce .[] as $t ({}; .[$t.id] = $t.status)) as $statusMap |

    # Find blocked tasks
    map(
      select(
        .status == "blocked" or
        ((.depends // [] | length) > 0 and
         (.depends // [] | map($statusMap[.] // "done" | . != "done") | any))
      )
    )
  '
}

# Build blocking chain for a task (recursive dependency lookup)
get_blocking_chain() {
  local task_id="$1"
  local visited="$2"

  # Prevent infinite loops
  if echo "$visited" | grep -q "$task_id"; then
    echo "[]"
    return
  fi

  local new_visited="$visited $task_id"
  local depends
  depends=$(echo "$TASKS" | jq -s --arg id "$task_id" '
    map(select(.id == $id)) | .[0].depends // []
  ')

  if [[ "$depends" == "[]" ]]; then
    echo "[]"
    return
  fi

  # Find incomplete dependencies
  echo "$TASKS" | jq -s --argjson deps "$depends" --arg visited "$new_visited" '
    # Create task lookup map
    (reduce .[] as $t ({}; .[$t.id] = {
      id: $t.id,
      status: $t.status,
      title: $t.title,
      depends: ($t.depends // [])
    })) as $lookup |

    # Get incomplete dependencies
    $deps | map(
      $lookup[.] | select(. != null and .status != "done") |
      {
        id: .id,
        title: .title,
        status: .status,
        depends: .depends
      }
    )
  '
}

# Calculate chain depth (max dependency depth)
calculate_chain_depth() {
  local task_id="$1"
  local visited="${2:-}"
  local max_depth=0

  # Prevent infinite loops
  if echo "$visited" | grep -q "$task_id"; then
    echo "0"
    return
  fi

  local new_visited="$visited $task_id"
  local depends
  depends=$(echo "$TASKS" | jq -s --arg id "$task_id" '
    map(select(.id == $id)) | .[0].depends // []
  ')

  if [[ "$depends" == "[]" || "$depends" == "null" ]]; then
    echo "0"
    return
  fi

  # Check each dependency
  local dep_ids
  dep_ids=$(echo "$depends" | jq -r '.[]')

  while IFS= read -r dep_id; do
    [[ -z "$dep_id" ]] && continue
    local depth
    depth=$(calculate_chain_depth "$dep_id" "$new_visited")
    depth=$((depth + 1))
    [[ $depth -gt $max_depth ]] && max_depth=$depth
  done <<< "$dep_ids"

  echo "$max_depth"
}

# Count tasks impacted by a blocker (how many tasks depend on this)
count_impacted_tasks() {
  local blocker_id="$1"

  echo "$TASKS" | jq -s --arg id "$blocker_id" '
    map(select(.depends // [] | index($id))) | length
  '
}

# List blocked tasks
list_blocked_tasks() {
  local blocked_tasks
  blocked_tasks=$(get_blocked_tasks)

  local count
  count=$(echo "$blocked_tasks" | jq 'length')

  if [[ "$count" -eq 0 ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      echo '{"blockedTasks":[],"count":0}'
    elif [[ "$QUIET" != true ]]; then
      echo "No blocked tasks found."
    fi
    return 0
  fi

  case "$FORMAT" in
    json)
      # JSON format with metadata
      local current_timestamp
      current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

      jq -nc --argjson tasks "$blocked_tasks" \
        --arg version "$VERSION" \
        --arg timestamp "$current_timestamp" \
        --argjson count "$count" '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          format: "json",
          version: $version,
          command: "blockers list",
          timestamp: $timestamp,
          resultsField: "blockedTasks"
        },
        "success": true,
        summary: {
          blockedCount: $count
        },
        blockedTasks: $tasks
      }'
      ;;

    markdown)
      echo "# Blocked Tasks"
      echo ""
      echo "**Total:** $count tasks"
      echo ""

      echo "$blocked_tasks" | jq -r '.[] |
        "## \(.id): \(.title)\n\n" +
        "- **Status:** \(.status)\n" +
        "- **Priority:** \(.priority)\n" +
        if .blockedBy then "- **Blocked by:** \(.blockedBy)\n" else "" end +
        if (.depends // [] | length) > 0 then "- **Depends on:** \(.depends | join(", "))\n" else "" end +
        "\n"
      '
      ;;

    text|*)
      # Human-readable text format
      if [[ "$QUIET" != true ]]; then
        echo ""
        if [[ "$UNICODE_ENABLED" == true ]]; then
          echo -e "${BOLD}╭─────────────────────────────────────────────────────────────────╮${NC}"
          echo -e "${BOLD}│${NC}  ${RED}⊗${NC} ${BOLD}BLOCKED TASKS${NC}                                               ${BOLD}│${NC}"
          echo -e "${BOLD}╰─────────────────────────────────────────────────────────────────╯${NC}"
        else
          echo -e "${BOLD}+-------------------------------------------------------------------+${NC}"
          echo -e "${BOLD}|${NC}  ${RED}x${NC} ${BOLD}BLOCKED TASKS${NC}                                                 ${BOLD}|${NC}"
          echo -e "${BOLD}+-------------------------------------------------------------------+${NC}"
        fi
        echo ""
      fi

      # Render each blocked task
      echo "$blocked_tasks" | jq -c '.[]' | while IFS= read -r task; do
        local id title status priority blockedBy depends
        id=$(echo "$task" | jq -r '.id')
        title=$(echo "$task" | jq -r '.title')
        status=$(echo "$task" | jq -r '.status')
        priority=$(echo "$task" | jq -r '.priority')
        blockedBy=$(echo "$task" | jq -r '.blockedBy // ""')
        depends=$(echo "$task" | jq -r '.depends // [] | join(", ")')

        local chain
        chain=$(get_blocking_chain "$id" "")
        local chain_count
        chain_count=$(echo "$chain" | jq 'length')

        echo -e "  ${BOLD}$id${NC} ${RED}⊗${NC} ${BOLD}$title${NC}"

        if [[ -n "$blockedBy" ]]; then
          echo -e "      ${RED}Blocked by:${NC} $blockedBy"
        fi

        if [[ -n "$depends" ]]; then
          if [[ $chain_count -gt 0 ]]; then
            local chain_ids
            chain_ids=$(echo "$chain" | jq -r '.[].id' | paste -sd, -)
            echo -e "      ${CYAN}→ Depends on:${NC} $depends ${DIM}(chain: $chain_ids)${NC}"
          else
            echo -e "      ${CYAN}→ Depends on:${NC} $depends"
          fi
        fi

        echo ""
      done

      if [[ "$QUIET" != true ]]; then
        if [[ "$UNICODE_ENABLED" == true ]]; then
          echo -e "${DIM}─────────────────────────────────────────────────────────────────${NC}"
        else
          echo -e "${DIM}---------------------------------------------------------------------${NC}"
        fi
        echo -e "${DIM}Total: $count blocked tasks${NC}"
      fi
      ;;
  esac
}

# Analyze blocking chains
analyze_blocking_chains() {
  local _tmp_analysis
  _tmp_analysis=$(mktemp)
  trap "rm -f '$_tmp_analysis'" RETURN

  local blocked_tasks
  blocked_tasks=$(get_blocked_tasks)

  local count
  count=$(echo "$blocked_tasks" | jq 'length')

  if [[ "$count" -eq 0 ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      echo '{"blockedTasks":[],"count":0,"analysis":{"criticalPath":[],"recommendations":[]}}'
    elif [[ "$QUIET" != true ]]; then
      echo "No blocked tasks found."
    fi
    return 0
  fi

  # Calculate metrics for each blocked task
  local analysis="[]"

  echo "$blocked_tasks" | jq -c '.[]' | while IFS= read -r task; do
    local id
    id=$(echo "$task" | jq -r '.id')

    local chain_depth
    chain_depth=$(calculate_chain_depth "$id" "")

    local impact_count
    impact_count=$(count_impacted_tasks "$id")

    local chain
    chain=$(get_blocking_chain "$id" "")

    # Store analysis data
    echo "$task" | jq --argjson depth "$chain_depth" \
      --argjson impact "$impact_count" \
      --argjson chain "$chain" \
      '. + {
        chainDepth: $depth,
        impactCount: $impact,
        blockingChain: $chain
      }'
  done | jq -s '.' > "$_tmp_analysis"

  # If the file is empty or doesn't exist, use empty array
  if [[ -s "$_tmp_analysis" ]]; then
    analysis=$(cat "$_tmp_analysis")
  else
    analysis="[]"
  fi

  # Find critical path using comprehensive analysis (all tasks, not just blocked)
  local critical_path
  if declare -f find_critical_path >/dev/null 2>&1; then
    # Use new comprehensive critical path analysis
    critical_path=$(find_critical_path "$TODO_FILE")
  else
    # Fallback to old method (only blocked tasks)
    critical_path=$(echo "$analysis" | jq '[.[] | {id, title, chainDepth, impactCount}] | sort_by(-.chainDepth) | .[0] // {}')
  fi

  # Find bottlenecks (tasks blocking the most others)
  local bottlenecks="[]"
  if declare -f find_bottlenecks >/dev/null 2>&1; then
    bottlenecks=$(find_bottlenecks "$TODO_FILE")
  fi

  # Generate recommendations
  local recommendations="[]"

  # Recommend tasks with highest impact
  local high_impact
  high_impact=$(echo "$analysis" | jq '[.[] | select(.impactCount > 0)] | sort_by(-.impactCount) | .[0:3] | map({id, title, impactCount, reason: "Unblocking this task will enable \(.impactCount) other tasks"})')

  # Recommend tasks with shortest chains
  local quick_wins
  quick_wins=$(echo "$analysis" | jq '[.[] | select(.chainDepth <= 1)] | sort_by(.chainDepth) | .[0:3] | map({id, title, chainDepth, reason: "Short dependency chain - quick to unblock"})')

  recommendations=$(jq -nc --argjson impact "$high_impact" --argjson quick "$quick_wins" '
    {
      highImpact: $impact,
      quickWins: $quick
    }
  ')

  case "$FORMAT" in
    json)
      # JSON format with full analysis
      local current_timestamp
      current_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

      jq -nc --argjson tasks "$analysis" \
        --arg version "$VERSION" \
        --arg timestamp "$current_timestamp" \
        --argjson count "$count" \
        --argjson critical "$critical_path" \
        --argjson bottlenecks "$bottlenecks" \
        --argjson recs "$recommendations" '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          format: "json",
          version: $version,
          command: "blockers analyze",
          timestamp: $timestamp,
          resultsField: "blockedTasks"
        },
        "success": true,
        summary: {
          blockedCount: $count,
          maxChainDepth: ($tasks | map(.chainDepth) | max // 0),
          totalImpactedTasks: ($tasks | map(.impactCount) | add // 0),
          criticalPathLength: ($critical.length // 0),
          bottleneckCount: ($bottlenecks | map(select(.blocks_count > 0)) | length)
        },
        criticalPath: $critical,
        bottlenecks: ($bottlenecks | map(select(.blocks_count > 0)) | sort_by(-.blocks_count)),
        recommendations: $recs,
        blockedTasks: $tasks
      }'
      ;;

    markdown)
      echo "# Blocker Analysis"
      echo ""
      echo "**Total Blocked:** $count tasks"
      echo ""

      # Critical path
      local critical_id critical_title critical_depth
      critical_id=$(echo "$critical_path" | jq -r '.id // "none"')
      critical_title=$(echo "$critical_path" | jq -r '.title // "none"')
      critical_depth=$(echo "$critical_path" | jq -r '.chainDepth // 0')

      echo "## Critical Path"
      echo ""
      echo "**Longest Chain:** $critical_depth levels"
      if [[ "$critical_id" != "none" ]]; then
        echo "- $critical_id: $critical_title"
      fi
      echo ""

      # Recommendations
      echo "## Recommendations"
      echo ""

      echo "### High Impact (Unblock Multiple Tasks)"
      echo ""
      echo "$recommendations" | jq -r '.highImpact[] | "- **\(.id)**: \(.title) - \(.reason)"'
      echo ""

      echo "### Quick Wins (Short Chains)"
      echo ""
      echo "$recommendations" | jq -r '.quickWins[] | "- **\(.id)**: \(.title) - \(.reason)"'
      echo ""
      ;;

    text|*)
      # Human-readable analysis
      if [[ "$QUIET" != true ]]; then
        echo ""
        if [[ "$UNICODE_ENABLED" == true ]]; then
          echo -e "${BOLD}╭─────────────────────────────────────────────────────────────────╮${NC}"
          echo -e "${BOLD}│${NC}  ${YELLOW}📊${NC} ${BOLD}BLOCKER ANALYSIS${NC}                                           ${BOLD}│${NC}"
          echo -e "${BOLD}╰─────────────────────────────────────────────────────────────────╯${NC}"
        else
          echo -e "${BOLD}+-------------------------------------------------------------------+${NC}"
          echo -e "${BOLD}|${NC}  ${BOLD}BLOCKER ANALYSIS${NC}                                                ${BOLD}|${NC}"
          echo -e "${BOLD}+-------------------------------------------------------------------+${NC}"
        fi
        echo ""
      fi

      # Summary stats
      local max_depth total_impact
      max_depth=$(echo "$analysis" | jq 'map(.chainDepth) | max // 0')
      total_impact=$(echo "$analysis" | jq 'map(.impactCount) | add // 0')

      echo -e "${BOLD}Summary:${NC}"
      echo "  Blocked tasks: $count"
      echo "  Max chain depth: $max_depth"
      echo "  Total impacted tasks: $total_impact"
      echo ""

      # Critical path (comprehensive view)
      local critical_length
      critical_length=$(echo "$critical_path" | jq -r '.length // 0')

      echo -e "${BOLD}${YELLOW}Critical Path${NC} ${DIM}(longest dependency chain across all tasks)${NC}:"
      if [[ "$critical_length" -gt 0 ]]; then
        echo "  Chain length: $critical_length tasks"
        echo ""
        local task_idx=1
        echo "$critical_path" | jq -c '.path[]?' | while IFS= read -r task; do
          [[ -z "$task" || "$task" == "null" ]] && continue
          local task_id task_title task_status
          task_id=$(echo "$task" | jq -r '.id')
          task_title=$(echo "$task" | jq -r '.title')
          task_status=$(echo "$task" | jq -r '.status')

          local status_marker
          case "$task_status" in
            done) status_marker="${GREEN}✓${NC}" ;;
            active) status_marker="${YELLOW}→${NC}" ;;
            blocked) status_marker="${RED}⊗${NC}" ;;
            *) status_marker=" " ;;
          esac

          echo -e "  $task_idx. [$status_marker] ${BOLD}$task_id${NC} $task_title"
          task_idx=$((task_idx + 1))
        done
      else
        echo "  No dependency chains found"
      fi
      echo ""

      # Bottlenecks (if available)
      local bottleneck_count
      bottleneck_count=$(echo "$bottlenecks" | jq '[.[] | select(.blocks_count > 0)] | length')
      if [[ "$bottleneck_count" -gt 0 ]]; then
        echo -e "${BOLD}${RED}Bottlenecks${NC} ${DIM}(tasks blocking the most others)${NC}:"
        echo "$bottlenecks" | jq -c '[.[] | select(.blocks_count > 0)] | sort_by(-.blocks_count) | limit(5; .[])' | while IFS= read -r task; do
          [[ -z "$task" || "$task" == "null" ]] && continue
          local task_id task_title blocks_count
          task_id=$(echo "$task" | jq -r '.id')
          task_title=$(echo "$task" | jq -r '.title')
          blocks_count=$(echo "$task" | jq -r '.blocks_count')

          echo -e "  • ${BOLD}$task_id${NC} \"$task_title\" ${DIM}- blocks $blocks_count task(s)${NC}"
        done
        echo ""
      fi

      # Recommendations
      echo -e "${BOLD}${GREEN}Recommendations:${NC}"
      echo ""

      echo -e "${CYAN}High Impact${NC} ${DIM}(unblock multiple tasks)${NC}:"
      local high_impact_list
      high_impact_list=$(echo "$recommendations" | jq -r '.highImpact[] | "  • \(.id): \(.title) - \(.reason)"')
      if [[ -n "$high_impact_list" ]]; then
        echo "$high_impact_list"
      else
        echo "  None"
      fi
      echo ""

      echo -e "${CYAN}Quick Wins${NC} ${DIM}(short chains)${NC}:"
      local quick_wins_list
      quick_wins_list=$(echo "$recommendations" | jq -r '.quickWins[] | "  • \(.id): \(.title) - \(.reason)"')
      if [[ -n "$quick_wins_list" ]]; then
        echo "$quick_wins_list"
      else
        echo "  None"
      fi
      echo ""

      # Detailed task list
      echo -e "${BOLD}Blocked Tasks Detail:${NC}"
      echo ""

      echo "$analysis" | jq -c 'sort_by(-.impactCount, -.chainDepth) | .[]' | while IFS= read -r task; do
        local id title chain_depth impact_count
        id=$(echo "$task" | jq -r '.id')
        title=$(echo "$task" | jq -r '.title')
        chain_depth=$(echo "$task" | jq -r '.chainDepth')
        impact_count=$(echo "$task" | jq -r '.impactCount')

        echo -e "  ${BOLD}$id${NC} $title"
        echo -e "      ${DIM}Chain depth: $chain_depth | Impact: $impact_count tasks${NC}"
      done

      if [[ "$QUIET" != true ]]; then
        echo ""
        if [[ "$UNICODE_ENABLED" == true ]]; then
          echo -e "${DIM}─────────────────────────────────────────────────────────────────${NC}"
        else
          echo -e "${DIM}---------------------------------------------------------------------${NC}"
        fi
      fi
      ;;
  esac
}

# Execute subcommand
case "$SUBCOMMAND" in
  list)
    list_blocked_tasks
    ;;
  analyze)
    analyze_blocking_chains
    ;;
  *)
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_INPUT_INVALID" "Unknown subcommand: $SUBCOMMAND" "${EXIT_INVALID_INPUT:-2}" true "Use 'list' or 'analyze'"
    else
      log_error "Unknown subcommand: $SUBCOMMAND"
      echo "Use 'list' or 'analyze'" >&2
    fi
    exit "${EXIT_INVALID_INPUT:-2}"
    ;;
esac
