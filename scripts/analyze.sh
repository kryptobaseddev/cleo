#!/usr/bin/env bash

#####################################################################
# analyze.sh - Task Analysis and Prioritization Command
#
# Analyzes task dependencies to identify high-leverage work:
# - Calculates task leverage (how many tasks each unblocks)
# - Identifies bottlenecks (tasks blocking the most others)
# - Groups tasks by logical domains (labels)
# - Tiers tasks by strategic value
# - Provides actionable recommendations with action order
#
# Usage:
#   analyze.sh [OPTIONS]
#
# Options:
#   --human           Human-readable text output (default is JSON for LLM)
#   --full            Comprehensive human-readable with all details
#   --auto-focus      Automatically set focus to recommended task
#   -h, --help        Show this help message
#
# Output Modes:
#   JSON (default):   LLM-optimized structured data with all analysis
#   Human (--human):  Brief human-readable summary
#   Full (--full):    Comprehensive human-readable report
#
# Version: 0.16.0
# Part of: cleo Advanced Analysis System
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

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/exit-codes.sh
  source "$LIB_DIR/exit-codes.sh"
fi

if [[ -f "${LIB_DIR}/output-format.sh" ]]; then
  source "${LIB_DIR}/output-format.sh"
elif [[ -f "$CLEO_HOME/lib/output-format.sh" ]]; then
  source "$CLEO_HOME/lib/output-format.sh"
fi

if [[ -f "${LIB_DIR}/analysis.sh" ]]; then
  source "${LIB_DIR}/analysis.sh"
elif [[ -f "$CLEO_HOME/lib/analysis.sh" ]]; then
  source "$CLEO_HOME/lib/analysis.sh"
fi

# Default configuration - JSON output for LLM agents
OUTPUT_MODE="json"
AUTO_FOCUS=false
QUIET=false
COMMAND_NAME="analyze"

# File paths
CLEO_DIR=".cleo"
TODO_FILE="${CLEO_DIR}/todo.json"

#####################################################################
# Usage
#####################################################################

usage() {
  cat << 'EOF'
Usage: cleo analyze [OPTIONS]

Analyze task dependencies and identify high-leverage work.
Default output is LLM-optimized JSON with comprehensive analysis.

Options:
    --human         Human-readable text output (brief summary)
    --full          Comprehensive human-readable report with all tiers
    --auto-focus    Automatically set focus to recommended task
    -q, --quiet     Suppress non-essential output (exit 0 if tasks exist)
    -h, --help      Show this help message

Analysis Components:
    leverage:       Tasks ranked by downstream impact (how many they unblock)
    bottlenecks:    Tasks blocking the most others with cascade details
    domains:        Dynamic grouping by label patterns
    tiers:          Strategic grouping (1=Unblock, 2=Critical, 3=Progress, 4=Routine)
    action_order:   Suggested sequence of tasks to maximize throughput
    recommendation: Single best task to start with reasoning

Output Modes:
    JSON (default):   LLM-optimized structured data for autonomous agents
    Human (--human):  Brief summary for quick human review
    Full (--full):    Comprehensive human-readable report

Examples:
    cleo analyze                    # JSON output (LLM default)
    cleo analyze --human            # Brief human-readable
    cleo analyze --full             # Detailed human-readable
    cleo analyze --auto-focus       # Analyze and set focus

Exit Codes:
    0:  Success
    1:  Error (file not found, jq missing)
    2:  No tasks to analyze
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
    MAGENTA='\033[0;35m'
    BOLD='\033[1m'
    DIM='\033[2m'
    NC='\033[0m'
  else
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' MAGENTA='' BOLD='' DIM='' NC=''
  fi
}

#####################################################################
# Core Analysis - Single jq Query for Efficiency
#####################################################################

# Complete analysis in a single jq pass for performance
run_complete_analysis() {
  local todo_file="$1"

  jq --arg version "$VERSION" '
    # ================================================================
    # SETUP: Build dependency graphs and helper data
    # ================================================================

    .tasks as $all_tasks |

    # Reverse dependency map: task_id -> [tasks that depend on it]
    (
      reduce $all_tasks[] as $task (
        {};
        if $task.depends then
          reduce $task.depends[] as $dep (
            .;
            .[$dep] += [$task.id]
          )
        else
          .
        end
      )
    ) as $reverse_deps |

    # Set of done task IDs for dependency checking
    ([$all_tasks[] | select(.status == "done") | .id]) as $done_ids |

    # Pending tasks only
    [$all_tasks[] | select(.status == "pending" or .status == "active")] as $pending_tasks |

    # ================================================================
    # LEVERAGE: Calculate leverage scores for all pending tasks
    # ================================================================

    [
      $pending_tasks[] |
      . as $task |
      ($reverse_deps[$task.id] // []) as $blocked_by_this |
      {
        id: $task.id,
        title: $task.title,
        status: $task.status,
        priority: ($task.priority // "medium"),
        phase: ($task.phase // null),
        labels: ($task.labels // []),
        depends: ($task.depends // []),
        unlocks_count: ($blocked_by_this | length),
        unlocks_tasks: $blocked_by_this,
        # Check if this task is actionable (all deps satisfied)
        is_actionable: (
          if $task.depends then
            all($task.depends[]; . as $dep | $done_ids | index($dep) | type == "number")
          else
            true
          end
        ),
        priority_score: (
          if ($task.priority // "medium") == "critical" then 100
          elif ($task.priority // "medium") == "high" then 75
          elif ($task.priority // "medium") == "medium" then 50
          else 25
          end
        )
      } |
      .leverage_score = (.unlocks_count * 15) + .priority_score
    ] | sort_by(-(.leverage_score // 0)) as $leverage_data |

    # ================================================================
    # BOTTLENECKS: Tasks that block the most others
    # ================================================================

    [
      $leverage_data[] |
      select(.unlocks_count >= 2) |
      {
        id: .id,
        title: .title,
        priority: .priority,
        blocks_count: .unlocks_count,
        blocked_tasks: .unlocks_tasks,
        is_actionable: .is_actionable
      }
    ] | sort_by(-(.blocks_count // 0)) as $bottlenecks |

    # ================================================================
    # TIERS: Group tasks by strategic value
    # Only actionable tasks in Tiers 1-2, blocked tasks in Tier 3
    # ================================================================

    {
      tier1_unblock: [
        $leverage_data[] |
        select(.unlocks_count >= 3 and .is_actionable) |
        {id, title, priority, unlocks_count, unlocks_tasks, leverage_score}
      ] | sort_by(-(.unlocks_count // 0)),

      tier2_critical: [
        $leverage_data[] |
        select(
          .is_actionable and
          .unlocks_count < 3 and
          (.priority == "critical" or .priority == "high")
        ) |
        {id, title, priority, unlocks_count, leverage_score}
      ] | sort_by(-(.leverage_score // 0)),

      tier3_blocked: [
        $leverage_data[] |
        select((.is_actionable // false) == false) |
        {
          id,
          title,
          priority,
          blocked_by: [.depends[] | select(. as $d | $done_ids | index($d) | type == "null")]
        }
      ],

      tier4_routine: [
        $leverage_data[] |
        select(
          .is_actionable and
          .unlocks_count < 3 and
          (.priority == "medium" or .priority == "low")
        ) |
        {id, title, priority, unlocks_count, leverage_score}
      ] | sort_by(-(.leverage_score // 0))
    } as $tiers |

    # ================================================================
    # DOMAINS: Dynamic grouping by label patterns
    # ================================================================

    (
      # Extract unique label prefixes/categories
      [
        $leverage_data[] |
        select(.labels | length > 0) |
        .labels[]
      ] | unique |

      # Group tasks by each label
      . as $all_labels |
      [
        $all_labels[] |
        . as $label |
        {
          domain: $label,
          tasks: [
            $leverage_data[] |
            select(.labels | index($label) | type == "number") |
            {id, title, priority, is_actionable, unlocks_count}
          ],
          count: ([$leverage_data[] | select(.labels | index($label) | type == "number")] | length),
          actionable_count: ([$leverage_data[] | select(.labels | index($label) | type == "number") | select(.is_actionable)] | length)
        } |
        select(.count >= 2)  # Only show domains with 2+ tasks
      ] | sort_by(-(.count // 0))
    ) as $domains |

    # ================================================================
    # ACTION ORDER: Suggested sequence to maximize throughput
    # Priority: Tier1 by leverage -> Tier2 by leverage -> Tier4 by leverage
    # ================================================================

    (
      ($tiers.tier1_unblock | map({id, title, priority, reason: "Unblocks \(.unlocks_count) tasks", tier: 1})) +
      ($tiers.tier2_critical | map({id, title, priority, reason: "High priority, actionable", tier: 2})) +
      ($tiers.tier4_routine[0:5] | map({id, title, priority, reason: "Quick win", tier: 4}))
    )[0:10] as $action_order |

    # ================================================================
    # RECOMMENDATION: Single best task with reasoning
    # ================================================================

    (
      if ($tiers.tier1_unblock | length) > 0 then
        $tiers.tier1_unblock | sort_by(-(.unlocks_count // 0)) | .[0] |
        {
          task_id: .id,
          title: .title,
          priority: .priority,
          reason: "Highest leverage - unblocks \(.unlocks_count) tasks",
          unlocks: .unlocks_tasks,
          command: "ct focus set \(.id)"
        }
      elif ($tiers.tier2_critical | length) > 0 then
        $tiers.tier2_critical[0] |
        {
          task_id: .id,
          title: .title,
          priority: .priority,
          reason: "Critical/high priority with clear path",
          unlocks: [],
          command: "ct focus set \(.id)"
        }
      elif ($tiers.tier4_routine | length) > 0 then
        $tiers.tier4_routine[0] |
        {
          task_id: .id,
          title: .title,
          priority: .priority,
          reason: "Actionable task in backlog",
          unlocks: [],
          command: "ct focus set \(.id)"
        }
      else
        null
      end
    ) as $recommendation |

    # ================================================================
    # SUMMARY STATISTICS
    # ================================================================

    {
      total_pending: ($pending_tasks | length),
      actionable: ([$leverage_data[] | select(.is_actionable)] | length),
      blocked: ([$leverage_data[] | select(.is_actionable == false)] | length),
      total_done: ($done_ids | length),
      bottleneck_count: ($bottlenecks | length)
    } as $summary |

    # ================================================================
    # FINAL OUTPUT: Complete analysis object
    # ================================================================

    {
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "analyze",
        "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
        "algorithm": "leverage_scoring_v2"
      },
      "success": true,

      "summary": $summary,

      "recommendation": $recommendation,

      "action_order": $action_order,

      "bottlenecks": ($bottlenecks | .[0:5]),

      "leverage": ($leverage_data | map(select(.unlocks_count > 0)) | .[0:10]),

      "tiers": {
        "tier1_unblock": {
          "description": "High leverage - unblock multiple tasks",
          "count": ($tiers.tier1_unblock | length),
          "tasks": $tiers.tier1_unblock
        },
        "tier2_critical": {
          "description": "Critical/high priority, actionable",
          "count": ($tiers.tier2_critical | length),
          "tasks": ($tiers.tier2_critical | .[0:10])
        },
        "tier3_blocked": {
          "description": "Blocked by incomplete dependencies",
          "count": ($tiers.tier3_blocked | length),
          "tasks": ($tiers.tier3_blocked | .[0:10])
        },
        "tier4_routine": {
          "description": "Medium/low priority, actionable",
          "count": ($tiers.tier4_routine | length),
          "tasks": ($tiers.tier4_routine | .[0:10])
        }
      },

      "domains": $domains
    }
  ' "$todo_file"
}

#####################################################################
# Output Formatters
#####################################################################

# Output LLM-optimized JSON (default)
output_json() {
  local todo_file="$1"
  local pending_count
  pending_count=$(jq -r '[.tasks[] | select(.status == "pending")] | length' "$todo_file")

  if [[ "$pending_count" -eq 0 ]]; then
    jq -n --arg version "$VERSION" '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {"format": "json", "command": "analyze", "version": $version, "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))},
      "success": true,
      "summary": {"total_pending": 0, "actionable": 0, "blocked": 0},
      "recommendation": null,
      "action_order": [],
      "message": "No pending tasks to analyze"
    }'
    exit "$EXIT_NO_DATA"
  fi

  run_complete_analysis "$todo_file"
}

# Output human-readable brief format
output_human() {
  get_colors

  local todo_file="$1"
  local analysis
  analysis=$(run_complete_analysis "$todo_file")

  local pending actionable blocked
  pending=$(echo "$analysis" | jq -r '.summary.total_pending')
  actionable=$(echo "$analysis" | jq -r '.summary.actionable')
  blocked=$(echo "$analysis" | jq -r '.summary.blocked')

  if [[ "$pending" -eq 0 ]]; then
    echo ""
    echo -e "${YELLOW}No pending tasks to analyze.${NC}"
    echo ""
    exit "$EXIT_NO_DATA"
  fi

  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  echo ""
  if [[ "$unicode" == "true" ]]; then
    echo -e "${BOLD}⚡ TASK ANALYSIS${NC} ${DIM}($pending pending, $actionable actionable, $blocked blocked)${NC}"
    echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  else
    echo -e "${BOLD}TASK ANALYSIS${NC} ${DIM}($pending pending, $actionable actionable, $blocked blocked)${NC}"
    echo -e "===================================================================="
  fi
  echo ""

  # Recommendation
  local rec_task rec_reason rec_unlocks
  rec_task=$(echo "$analysis" | jq -r '.recommendation.task_id // empty')
  if [[ -n "$rec_task" ]]; then
    rec_reason=$(echo "$analysis" | jq -r '.recommendation.reason')
    echo -e "${BOLD}${GREEN}RECOMMENDATION${NC}"
    echo -e "  ${CYAN}→ ct focus set $rec_task${NC}"
    echo -e "  ${DIM}$rec_reason${NC}"

    # Show what it unblocks
    local unlocks_list
    unlocks_list=$(echo "$analysis" | jq -r '.recommendation.unlocks | join(", ")')
    if [[ -n "$unlocks_list" && "$unlocks_list" != "" ]]; then
      echo -e "  ${DIM}Unblocks: $unlocks_list${NC}"
    fi
    echo ""
  fi

  # Action Order
  echo -e "${BOLD}${CYAN}ACTION ORDER${NC} ${DIM}(suggested sequence)${NC}"
  local action_count
  action_count=$(echo "$analysis" | jq '.action_order | length')
  if [[ "$action_count" -gt 0 ]]; then
    echo "$analysis" | jq -r '.action_order[0:5][] | "  \(.id) [\(.priority)] \(.reason)"'
  else
    echo -e "  ${DIM}No actionable tasks available${NC}"
  fi
  echo ""

  # Bottlenecks
  local bottleneck_count
  bottleneck_count=$(echo "$analysis" | jq '.bottlenecks | length')
  if [[ "$bottleneck_count" -gt 0 ]]; then
    echo -e "${BOLD}${RED}BOTTLENECKS${NC} ${DIM}(tasks blocking others)${NC}"
    echo "$analysis" | jq -r '.bottlenecks[0:3][] | "  \(.id) blocks \(.blocks_count) tasks: \(.blocked_tasks | join(", "))"'
    echo ""
  fi

  # Tier Summary
  echo -e "${BOLD}${BLUE}TIERS${NC}"
  local t1 t2 t3 t4
  t1=$(echo "$analysis" | jq '.tiers.tier1_unblock.count')
  t2=$(echo "$analysis" | jq '.tiers.tier2_critical.count')
  t3=$(echo "$analysis" | jq '.tiers.tier3_blocked.count')
  t4=$(echo "$analysis" | jq '.tiers.tier4_routine.count')

  echo -e "  ${BOLD}Tier 1${NC} (Unblock):  ${CYAN}$t1${NC} task(s)"
  echo -e "  ${BOLD}Tier 2${NC} (Critical): ${YELLOW}$t2${NC} task(s)"
  echo -e "  ${BOLD}Tier 3${NC} (Blocked):  ${RED}$t3${NC} task(s)"
  echo -e "  ${BOLD}Tier 4${NC} (Routine):  ${DIM}$t4${NC} task(s)"
  echo ""

  # Domains (if any)
  local domain_count
  domain_count=$(echo "$analysis" | jq '.domains | length')
  if [[ "$domain_count" -gt 0 ]]; then
    echo -e "${BOLD}${MAGENTA}DOMAINS${NC} ${DIM}(by label)${NC}"
    echo "$analysis" | jq -r '.domains[0:5][] | "  \(.domain): \(.actionable_count)/\(.count) actionable"'
    echo ""
  fi
}

# Output comprehensive human-readable format
output_full() {
  get_colors

  local todo_file="$1"
  local analysis
  analysis=$(run_complete_analysis "$todo_file")

  # Start with brief output
  output_human "$todo_file"

  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  if [[ "$unicode" == "true" ]]; then
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════════${NC}"
  else
    echo -e "${BOLD}===================================================================${NC}"
  fi
  echo -e "${BOLD}DETAILED BREAKDOWN${NC}"
  if [[ "$unicode" == "true" ]]; then
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════════${NC}"
  else
    echo -e "${BOLD}===================================================================${NC}"
  fi
  echo ""

  # Tier 1 Details
  echo -e "${BOLD}${CYAN}Tier 1 - UNBLOCK${NC} ${DIM}(High leverage - work on these first)${NC}"
  local tier1_tasks
  tier1_tasks=$(echo "$analysis" | jq -c '.tiers.tier1_unblock.tasks[]' 2>/dev/null)
  if [[ -n "$tier1_tasks" ]]; then
    echo "$tier1_tasks" | while read -r task; do
      local id title priority unlocks unlocks_list
      id=$(echo "$task" | jq -r '.id')
      title=$(echo "$task" | jq -r '.title')
      priority=$(echo "$task" | jq -r '.priority')
      unlocks=$(echo "$task" | jq -r '.unlocks_count')
      unlocks_list=$(echo "$task" | jq -r '.unlocks_tasks | join(", ")')

      if [[ ${#title} -gt 50 ]]; then
        title="${title:0:47}..."
      fi

      echo -e "  ${BOLD}$id${NC} [$priority] $title"
      echo -e "    ${DIM}Unlocks $unlocks: $unlocks_list${NC}"
    done
  else
    echo -e "  ${DIM}None${NC}"
  fi
  echo ""

  # Tier 2 Details
  echo -e "${BOLD}${YELLOW}Tier 2 - CRITICAL${NC} ${DIM}(High priority, actionable)${NC}"
  local tier2_tasks
  tier2_tasks=$(echo "$analysis" | jq -c '.tiers.tier2_critical.tasks[0:7][]' 2>/dev/null)
  if [[ -n "$tier2_tasks" ]]; then
    echo "$tier2_tasks" | while read -r task; do
      local id title priority
      id=$(echo "$task" | jq -r '.id')
      title=$(echo "$task" | jq -r '.title')
      priority=$(echo "$task" | jq -r '.priority')

      if [[ ${#title} -gt 55 ]]; then
        title="${title:0:52}..."
      fi

      echo -e "  ${BOLD}$id${NC} [$priority] $title"
    done
  else
    echo -e "  ${DIM}None${NC}"
  fi
  echo ""

  # Tier 3 Details (Blocked)
  echo -e "${BOLD}${RED}Tier 3 - BLOCKED${NC} ${DIM}(Waiting on dependencies)${NC}"
  local tier3_tasks
  tier3_tasks=$(echo "$analysis" | jq -c '.tiers.tier3_blocked.tasks[0:7][]' 2>/dev/null)
  if [[ -n "$tier3_tasks" ]]; then
    echo "$tier3_tasks" | while read -r task; do
      local id title blocked_by
      id=$(echo "$task" | jq -r '.id')
      title=$(echo "$task" | jq -r '.title')
      blocked_by=$(echo "$task" | jq -r '.blocked_by | join(", ")')

      if [[ ${#title} -gt 45 ]]; then
        title="${title:0:42}..."
      fi

      echo -e "  ${BOLD}$id${NC} $title"
      echo -e "    ${DIM}Blocked by: $blocked_by${NC}"
    done
  else
    echo -e "  ${DIM}None${NC}"
  fi
  echo ""

  # Tier 4 Summary
  local tier4_count
  tier4_count=$(echo "$analysis" | jq '.tiers.tier4_routine.count')
  echo -e "${BOLD}${DIM}Tier 4 - ROUTINE${NC} ${DIM}($tier4_count tasks - use ct list --priority medium,low to view)${NC}"
  echo ""

  # Domain breakdown
  local domain_count
  domain_count=$(echo "$analysis" | jq '.domains | length')
  if [[ "$domain_count" -gt 0 ]]; then
    echo -e "${BOLD}${MAGENTA}DOMAIN BREAKDOWN${NC}"
    echo "$analysis" | jq -r '.domains[0:8][] |
      "  \(.domain) (\(.count) tasks, \(.actionable_count) actionable)\n    \(.tasks[0:3] | map(.id) | join(", "))\(.tasks | if length > 3 then "..." else "" end)"'
    echo ""
  fi
}

#####################################################################
# Argument Parsing
#####################################################################

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --human)
        OUTPUT_MODE="human"
        shift
        ;;
      --full)
        OUTPUT_MODE="full"
        shift
        ;;
      --json)
        OUTPUT_MODE="json"
        shift
        ;;
      --auto-focus)
        AUTO_FOCUS=true
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
        if [[ "${OUTPUT_MODE:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
          output_error "E_INPUT_INVALID" "Unknown option: $1" "${EXIT_INVALID_INPUT:-2}" true "Run 'cleo analyze --help' for usage"
        else
          log_error "Unknown option: $1"
          echo "Run 'cleo analyze --help' for usage" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-2}"
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
  # Note: analyze.sh uses OUTPUT_MODE instead of FORMAT
  OUTPUT_MODE=$(resolve_format "${OUTPUT_MODE:-}")

  # Check if in a todo-enabled project
  if [[ ! -f "$TODO_FILE" ]]; then
    if [[ "$OUTPUT_MODE" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "${EXIT_FILE_ERROR:-3}" true "Run 'cleo init' to initialize project"
    else
      log_error "Todo file not found: $TODO_FILE"
      echo "Run 'cleo init' first" >&2
    fi
    exit "${EXIT_FILE_ERROR:-3}"
  fi

  # Check required commands
  if ! command -v jq &>/dev/null; then
    if [[ "$OUTPUT_MODE" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_DEPENDENCY_MISSING" "jq is required but not installed" "${EXIT_DEPENDENCY_ERROR:-5}" true "Install jq: https://stedolan.github.io/jq/download/"
    else
      log_error "jq is required but not installed"
    fi
    exit "${EXIT_DEPENDENCY_ERROR:-5}"
  fi

  # Quiet mode: just check if pending tasks exist and exit
  if [[ "$QUIET" == "true" ]]; then
    local pending_count
    pending_count=$(jq -r '[.tasks[] | select(.status == "pending" or .status == "active")] | length' "$TODO_FILE")
    if [[ "$pending_count" -gt 0 ]]; then
      exit "$EXIT_SUCCESS"
    else
      exit "$EXIT_NO_DATA"
    fi
  fi

  # Output in requested format
  case "$OUTPUT_MODE" in
    json)
      output_json "$TODO_FILE"
      ;;
    full)
      output_full "$TODO_FILE"
      ;;
    human)
      output_human "$TODO_FILE"
      ;;
  esac

  # Auto-focus if requested
  if [[ "$AUTO_FOCUS" == "true" ]]; then
    local analysis
    analysis=$(run_complete_analysis "$TODO_FILE")
    local rec_task
    rec_task=$(echo "$analysis" | jq -r '.recommendation.task_id // empty')

    if [[ -n "$rec_task" ]]; then
      if [[ "$OUTPUT_MODE" != "json" ]]; then
        echo ""
        echo "Setting focus to $rec_task..."
      fi
      "$SCRIPT_DIR/focus-command.sh" set "$rec_task" >/dev/null 2>&1

      if [[ "$OUTPUT_MODE" == "json" ]]; then
        echo ""
        jq -n --arg task "$rec_task" '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "auto_focus": {"set": $task, "status": "success"}
        }'
      fi
    fi
  fi
}

main "$@"
