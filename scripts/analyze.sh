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

# Source config library for hierarchy weights
if [[ -f "${LIB_DIR}/config.sh" ]]; then
  # shellcheck source=../lib/config.sh
  source "${LIB_DIR}/config.sh"
elif [[ -f "$CLEO_HOME/lib/config.sh" ]]; then
  source "$CLEO_HOME/lib/config.sh"
fi

# Source phase-tracking library for phase boost calculations
if [[ -f "${LIB_DIR}/phase-tracking.sh" ]]; then
  # shellcheck source=../lib/phase-tracking.sh
  source "${LIB_DIR}/phase-tracking.sh"
elif [[ -f "$CLEO_HOME/lib/phase-tracking.sh" ]]; then
  source "$CLEO_HOME/lib/phase-tracking.sh"
fi

# Source staleness library for stale task detection
if [[ -f "${LIB_DIR}/staleness.sh" ]]; then
  # shellcheck source=../lib/staleness.sh
  source "${LIB_DIR}/staleness.sh"
elif [[ -f "$CLEO_HOME/lib/staleness.sh" ]]; then
  source "$CLEO_HOME/lib/staleness.sh"
fi

# Source size-weighting library for size-based leverage scoring
if [[ -f "${LIB_DIR}/size-weighting.sh" ]]; then
  # shellcheck source=../lib/size-weighting.sh
  source "${LIB_DIR}/size-weighting.sh"
elif [[ -f "$CLEO_HOME/lib/size-weighting.sh" ]]; then
  source "$CLEO_HOME/lib/size-weighting.sh"
fi

# Source lock-detection library for concurrent operation awareness
if [[ -f "${LIB_DIR}/lock-detection.sh" ]]; then
  # shellcheck source=../lib/lock-detection.sh
  source "${LIB_DIR}/lock-detection.sh"
elif [[ -f "$CLEO_HOME/lib/lock-detection.sh" ]]; then
  source "$CLEO_HOME/lib/lock-detection.sh"
fi

# Source HITL warnings library for human-in-the-loop warnings
if [[ -f "${LIB_DIR}/hitl-warnings.sh" ]]; then
  # shellcheck source=../lib/hitl-warnings.sh
  source "${LIB_DIR}/hitl-warnings.sh"
elif [[ -f "$CLEO_HOME/lib/hitl-warnings.sh" ]]; then
  source "$CLEO_HOME/lib/hitl-warnings.sh"
fi

# Source centralized flag parsing
if [[ -f "${LIB_DIR}/flags.sh" ]]; then
  # shellcheck source=../lib/flags.sh
  source "${LIB_DIR}/flags.sh"
elif [[ -f "$CLEO_HOME/lib/flags.sh" ]]; then
  source "$CLEO_HOME/lib/flags.sh"
fi

# Default configuration - JSON output for LLM agents
OUTPUT_MODE="json"
AUTO_FOCUS=false
QUIET=false
COMMAND_NAME="analyze"
PARENT_ID=""  # Epic scoping: filter to parent and all descendants

# Lock awareness flags
IGNORE_LOCKS=false
WAIT_FOR_LOCKS=false
WAIT_TIMEOUT=30
SHOW_LOCKS_ONLY=false

# File paths
CLEO_DIR=".cleo"
TODO_FILE="${CLEO_DIR}/todo.json"

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

#####################################################################
# Usage
#####################################################################

usage() {
  cat << 'EOF'
Usage: cleo analyze [OPTIONS]

Analyze task dependencies and identify high-leverage work.
Default output is LLM-optimized JSON with comprehensive analysis.

Options:
    --parent ID     Scope analysis to epic/task and all descendants
    --human         Human-readable text output (brief summary)
    --full          Comprehensive human-readable report with all tiers
    --auto-focus    Automatically set focus to recommended task
    -q, --quiet     Suppress non-essential output (exit 0 if tasks exist)
    -h, --help      Show this help message

Lock Awareness Options:
    --ignore-locks          Bypass lock detection entirely
    --wait-for-locks [SEC]  Wait for locks to release (default: 30s)
    --show-locks            Only show current lock status, don't analyze

Analysis Components:
    leverage:       Tasks ranked by downstream impact (how many they unblock)
    bottlenecks:    Tasks blocking the most others with cascade details
    domains:        Dynamic grouping by label patterns
    tiers:          Strategic grouping (1=Unblock, 2=Critical, 3=Progress, 4=Routine)
    action_order:   Suggested sequence of tasks to maximize throughput
    recommendation: Single best task to start with reasoning
    concurrency:    Active locks and concurrent operation warnings

Epic-Scoped Analysis (--parent):
    phases:         Progress and waves grouped by phase
    inventory:      Tasks categorized as completed/ready/blocked
    executionPlan:  Critical path and parallel execution waves

Output Modes:
    JSON (default):   LLM-optimized structured data for autonomous agents
    Human (--human):  Brief summary for quick human review
    Full (--full):    Comprehensive human-readable report

Examples:
    cleo analyze                    # JSON output (LLM default)
    cleo analyze --parent T998      # Epic-scoped analysis
    cleo analyze --parent T998 --human  # Epic analysis with ASCII viz
    cleo analyze --human            # Brief human-readable
    cleo analyze --full             # Detailed human-readable
    cleo analyze --auto-focus       # Analyze and set focus
    cleo analyze --show-locks       # Just show lock status
    cleo analyze --wait-for-locks   # Wait for locks before analyzing

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
# Epic-Scoped Analysis Functions
#####################################################################

# Get all tasks scoped to a parent (parent + all descendants)
# Arguments:
#   $1 - Path to todo.json file
#   $2 - Parent task ID
# Outputs:
#   JSON array of scoped tasks
get_scoped_tasks() {
  local todo_file="$1"
  local parent_id="$2"

  jq --arg parent "$parent_id" '
    # Build parent-child relationships
    .tasks as $all_tasks |

    # Recursive function to collect all descendant IDs
    def collect_descendants($id):
      [$all_tasks[] | select(.parentId == $id) | .id] as $children |
      if ($children | length) == 0 then []
      else $children + [$children[] | collect_descendants(.) | .[]]
      end;

    # Get parent task + all descendants
    [$parent] + collect_descendants($parent) | unique as $scoped_ids |

    # Filter tasks to scoped set
    [$all_tasks[] | select(.id as $id | $scoped_ids | index($id))]
  ' "$todo_file"
}

# Run epic-scoped analysis with full schema output
# Arguments:
#   $1 - Path to todo.json file
#   $2 - Parent task ID (epic root)
# Outputs:
#   JSON object with epic analysis (phases, waves, inventory, execution plan)
run_epic_analysis() {
  local todo_file="$1"
  local parent_id="$2"

  jq --arg parent "$parent_id" --arg version "$VERSION" '
    # ================================================================
    # SETUP: Filter to scoped tasks
    # ================================================================

    .tasks as $all_tasks |

    # Recursive function to collect all descendant IDs
    def collect_descendants($id):
      [$all_tasks[] | select(.parentId == $id) | .id] as $children |
      if ($children | length) == 0 then []
      else $children + [$children[] | collect_descendants(.) | .[]]
      end;

    # Get parent task + all descendants
    ([$parent] + collect_descendants($parent) | unique) as $scoped_ids |

    # Filter tasks to scoped set
    [$all_tasks[] | select(.id as $id | $scoped_ids | index($id))] as $scoped_tasks |

    # Get the epic (parent) task info
    ($scoped_tasks[] | select(.id == $parent)) as $epic_task |

    # Build lookup maps
    (reduce $scoped_tasks[] as $t ({}; .[$t.id] = $t)) as $lookup |
    ([.tasks[] | select(.status == "done") | .id]) as $done_ids |

    # ================================================================
    # WAVE COMPUTATION: Calculate dependency depth
    # ================================================================

    # Compute waves within scoped tasks
    # Wave 0 = no in-scope deps, Wave N = max(dep waves) + 1
    # NOTE: Use any(. == $x) instead of index($x) because in jq, index() returns
    # a numeric index (0, 1, 2...) and 0 is falsy in boolean context, causing
    # elements at index 0 to incorrectly fail the filter.
    def compute_wave($id; $memo; $visiting):
      if ($memo | has($id)) then $memo
      elif ($visiting | any(. == $id)) then $memo | .[$id] = 0  # Cycle - treat as 0
      elif ($lookup[$id].status == "done") then $memo | .[$id] = -1
      else
        ($lookup[$id].depends // []) as $deps |
        # Filter to in-scope, non-done dependencies
        # Use any(. == $d) for proper boolean membership test
        [$deps[] | select(
          (. as $d | $scoped_ids | any(. == $d)) and
          (. as $d | $done_ids | any(. == $d) | not)
        )] as $active_deps |

        if ($active_deps | length) == 0 then
          $memo | .[$id] = 0
        else
          # Compute waves for all deps first (with cycle detection)
          (reduce $active_deps[] as $dep ($memo;
            compute_wave($dep; .; $visiting + [$id])
          )) as $updated_memo |
          # Max dep wave + 1
          ([$active_deps[] | $updated_memo[.] // 0] | max + 1) as $wave |
          $updated_memo | .[$id] = $wave
        end
      end;

    (reduce $scoped_ids[] as $id ({}; compute_wave($id; .; []))) as $waves |

    # ================================================================
    # PHASE GROUPING: Group tasks by phase with progress
    # ================================================================

    # Phase order mapping
    {"setup": 1, "core": 2, "testing": 3, "polish": 4, "maintenance": 5} as $phase_order |

    # Exclude the epic itself from child counts, group remaining by phase
    [$scoped_tasks[] | select(.id != $parent)] as $child_tasks |

    ($child_tasks | group_by(.phase // "core") | map({
      phase: (.[0].phase // "core"),
      displayOrder: ($phase_order[.[0].phase // "core"] // 99),
      tasks: .,
      progress: {
        done: ([.[] | select(.status == "done")] | length),
        total: (. | length),
        percent: (if (. | length) == 0 then 0 else (([.[] | select(.status == "done")] | length) * 100 / (. | length) | floor) end)
      },
      status: (
        if ([.[] | select(.status == "done")] | length) == (. | length) then "complete"
        elif ([.[] | select(.status == "done")] | length) > 0 then "in_progress"
        else "pending"
        end
      ),
      waves: (
        . as $phase_tasks |
        [.[] | . + {wave: ($waves[.id] // 0)}] |
        group_by(.wave) |
        [.[] | select(.[0].wave >= 0) | {
          depth: .[0].wave,
          tasks: [.[].id],
          status: (
            if all(.[]; .status == "done") then "complete"
            elif any(.[]; .status == "done") then "partial"
            else "pending"
            end
          )
        }] | sort_by(.depth)
      )
    }) | sort_by(.displayOrder)) as $phases |

    # ================================================================
    # INVENTORY: Categorize tasks
    # ================================================================

    # Reverse dependency map (who depends on each task)
    (reduce $scoped_tasks[] as $task ({};
      if $task.depends then
        reduce $task.depends[] as $dep (.;
          .[$dep] += [$task.id]
        )
      else . end
    )) as $reverse_deps |

    {
      completed: [$child_tasks[] | select(.status == "done") | {
        id: .id,
        title: .title,
        phase: (.phase // "core"),
        completedAt: .completedAt,
        depends: (.depends // [])
      }],
      ready: [$child_tasks[] | select(.status != "done") | select(
        (.depends == null) or (.depends | length == 0) or
        ((.depends // []) | all(. as $d | $done_ids | index($d)))
      ) | {
        id: .id,
        title: .title,
        phase: (.phase // "core"),
        priority: (.priority // "medium"),
        depends: (.depends // []),
        unlocks: (($reverse_deps[.id] // []) | length),
        reason: (
          if (.depends == null) or (.depends | length == 0) then "No dependencies"
          else "All dependencies satisfied"
          end
        )
      }] | sort_by(-.unlocks),
      blocked: [$child_tasks[] | select(.status != "done") | select(
        (.depends != null) and (.depends | length > 0) and
        ((.depends // []) | any(. as $d | $done_ids | index($d) | not))
      ) | {
        id: .id,
        title: .title,
        phase: (.phase // "core"),
        priority: (.priority // "medium"),
        depends: (.depends // []),
        waitingOn: [(.depends // [])[] | select(. as $d | $done_ids | index($d) | not)],
        chainDepth: ($waves[.id] // 0)
      }]
    } as $inventory |

    # ================================================================
    # EXECUTION PLAN: Critical path and waves
    # ================================================================

    # Find task with maximum wave (longest chain endpoint)
    ([$child_tasks[] | select(.status != "done") | {id: .id, wave: ($waves[.id] // 0)}] |
      sort_by(-.wave) | .[0]) as $deepest |

    # Build critical path by tracing back from deepest
    # NOTE: Use explicit variable binding (. as $d) because in jq, bare dot inside
    # nested filters like select($arr | index($d)) does not correctly reference the
    # current iteration item - it references the filters input instead.
    (if $deepest then
      def trace_path($id; $path):
        $lookup[$id] as $task |
        # Filter deps to those in scope - use any(. == $d) for proper boolean test
        [($task.depends // [])[] | . as $d | select($scoped_ids | any(. == $d))] as $scope_deps |
        # Filter to active (non-done) deps
        [$scope_deps[] | . as $d | select($done_ids | any(. == $d) | not)] as $active_deps |
        if ($active_deps | length) == 0 then $path
        else
          # Find dep with highest wave
          ($active_deps | map({id: ., wave: ($waves[.] // 0)}) | sort_by(-.wave) | .[0].id) as $next |
          trace_path($next; [$lookup[$next]] + $path)
        end;
      trace_path($deepest.id; [$lookup[$deepest.id]])
    else [] end) as $critical_path |

    # Group ALL pending tasks into execution waves (ready + blocked)
    # Wave numbering: wave 0 = ready to start, wave N = depends on wave N-1
    ([$child_tasks[] | select(.status != "done") | {id: .id, wave: ($waves[.id] // 0)}] |
      group_by(.wave) | sort_by(.[0].wave) | map({
        wave: .[0].wave,
        parallel: [.[].id],
        count: (. | length),
        status: (if .[0].wave == 0 then "ready" else "blocked" end)
      })) as $exec_waves |

    {
      summary: {
        totalWaves: ($exec_waves | length),
        criticalPathLength: ($critical_path | length),
        parallelOpportunities: ([$exec_waves[] | select(.count > 1)] | length)
      },
      criticalPath: {
        path: [$critical_path[] | {id: .id, title: .title, phase: (.phase // "core")}],
        length: ($critical_path | length),
        entryTask: (if ($critical_path | length) > 0 then $critical_path[0].id else null end)
      },
      waves: $exec_waves,
      recommendation: (
        if ($inventory.ready | length) > 0 then
          ($inventory.ready | sort_by(-.unlocks) | .[0]) as $best |
          {
            nextTask: $best.id,
            reason: (if $best.unlocks > 0 then "Unblocks \($best.unlocks) tasks" else "Ready to start" end),
            command: "ct focus set \($best.id)"
          }
        else null end
      )
    } as $execution_plan |

    # ================================================================
    # FINAL OUTPUT
    # ================================================================

    {
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "analyze --parent",
        "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
        "algorithm": "epic_scoped_analysis",
        "scope": {
          "type": "epic",
          "rootTaskId": $parent,
          "includesRoot": true
        }
      },
      "success": true,

      "epic": {
        "id": $epic_task.id,
        "title": $epic_task.title,
        "type": ($epic_task.type // "epic"),
        "status": $epic_task.status,
        "priority": ($epic_task.priority // "high"),
        "phase": ($epic_task.phase // "core"),
        "progress": {
          "done": ([$child_tasks[] | select(.status == "done")] | length),
          "total": ($child_tasks | length),
          "percent": (if ($child_tasks | length) == 0 then 0 else (([$child_tasks[] | select(.status == "done")] | length) * 100 / ($child_tasks | length) | floor) end),
          "byStatus": (reduce $child_tasks[] as $t ({};
            .[$t.status] = ((.[$t.status] // 0) + 1)
          ))
        }
      },

      "phases": $phases,

      "inventory": $inventory,

      "executionPlan": $execution_plan,

      "summary": {
        "totalTasks": ($child_tasks | length),
        "byStatus": (reduce $child_tasks[] as $t ({};
          .[$t.status] = ((.[$t.status] // 0) + 1)
        )),
        "byPhase": (reduce $phases[] as $p ({};
          .[$p.phase] = {done: $p.progress.done, total: $p.progress.total}
        )),
        "readyCount": ($inventory.ready | length),
        "blockedCount": ($inventory.blocked | length),
        "criticalPathLength": ($critical_path | length)
      }
    }
  ' "$todo_file"
}

# Render a linear chain with arrows (for chains with single root)
# Format: ✅T001 → ✅T002 → ⏳T003
# Arguments:
#   $1 - JSON array of task details
render_chain_linear() {
  local task_details="$1"

  # Build dependency-ordered list using topological sort
  # Start from root (no deps), follow children
  local ordered_output
  ordered_output=$(echo "$task_details" | jq -r '
    # Build adjacency: task -> children
    (reduce .[] as $t ({}; .[$t.id] = $t.children)) as $children_map |
    (reduce .[] as $t ({}; .[$t.id] = $t)) as $lookup |

    # Find root (no deps)
    [.[] | select(.deps | length == 0) | .id][0] as $root |

    # BFS from root to build order
    def bfs_order($start):
      {queue: [$start], visited: [$start], order: [$start]} |
      until(.queue | length == 0;
        . as $state |
        $state.queue[0] as $current |
        $state.queue[1:] as $rest |
        (($children_map[$current] // []) | sort) as $kids |
        # Filter kids not in visited - use explicit $state reference
        ([$kids[] | select(. as $k | $state.visited | index($k) | not)]) as $new_nodes |
        {
          queue: ($rest + $new_nodes),
          visited: ($state.visited + $new_nodes),
          order: ($state.order + $new_nodes)
        }
      ) | .order;

    if $root then
      bfs_order($root) | map(
        . as $id |
        $lookup[$id] |
        (if .status == "done" then "✅" else "⏳" end) + .id
      ) | join(" → ")
    else
      # Fallback: just list by ID
      [.[] | (if .status == "done" then "✅" else "⏳" end) + .id] | sort | join(" → ")
    end
  ')

  echo "  $ordered_output"
}

# Render a tree-structured chain (for chains with multiple roots or branching)
# Format with branching arrows:
#   ✅T001 ─┬→ ⏳T002 → ⏳T004
#           └→ ⏳T003 → ⏳T005
# Arguments:
#   $1 - JSON array of task details
#   $2 - JSON array of root task IDs
render_chain_tree() {
  local task_details="$1"
  local roots_json="$2"

  # For complex chains, render as a dependency list with branching indicators
  echo "$task_details" | jq -r --argjson roots "$roots_json" '
    # Build maps
    (reduce .[] as $t ({}; .[$t.id] = $t)) as $lookup |
    (reduce .[] as $t ({}; .[$t.id] = $t.children)) as $children_map |

    # Status icon helper
    def icon: if .status == "done" then "✅" else "⏳" end;

    # Render function for a subtree
    def render_subtree($id; $prefix; $is_last):
      $lookup[$id] as $task |
      ($task | icon) as $status_icon |
      ($children_map[$id] // []) | sort as $kids |

      # Current node
      ($prefix + $status_icon + $id) as $line |

      if ($kids | length) == 0 then
        [$line]
      elif ($kids | length) == 1 then
        # Single child - continue on same line
        [$line + " → " + ($lookup[$kids[0]] | icon) + $kids[0]] +
        (if ($children_map[$kids[0]] // []) | length > 0 then
          render_subtree($kids[0]; $prefix + "        "; true) | .[1:]
        else [] end)
      else
        # Multiple children - branch
        [$line + " ─┬→ " + ($lookup[$kids[0]] | icon) + $kids[0]] +
        (if ($children_map[$kids[0]] // []) | length > 0 then
          render_subtree($kids[0]; $prefix + "   │     "; false) | .[1:]
        else [] end) +
        ([$kids[1:-1][] | . as $kid |
          $prefix + "   ├→ " + ($lookup[$kid] | icon) + $kid
        ]) +
        (if ($kids | length) > 1 then
          [$prefix + "   └→ " + ($lookup[$kids[-1]] | icon) + $kids[-1]] +
          (if ($children_map[$kids[-1]] // []) | length > 0 then
            render_subtree($kids[-1]; $prefix + "         "; true) | .[1:]
          else [] end)
        else [] end)
      end;

    # Render from each root
    if ($roots | length) == 1 then
      render_subtree($roots[0]; "  "; true) | .[]
    else
      # Multiple roots - render each
      [$roots[] | . as $root |
        render_subtree($root; "  "; true)
      ] | add | .[]
    end
  '
}

# Output epic analysis in human-readable format
# Arguments:
#   $1 - Path to todo.json file
#   $2 - Parent task ID (epic root)
output_epic_human() {
  get_colors

  local todo_file="$1"
  local parent_id="$2"
  local analysis
  analysis=$(run_epic_analysis "$todo_file" "$parent_id")

  local unicode
  detect_unicode_support 2>/dev/null && unicode="true" || unicode="false"

  # Epic header
  local epic_title epic_progress_done epic_progress_total epic_progress_pct
  epic_title=$(echo "$analysis" | jq -r '.epic.title')
  epic_progress_done=$(echo "$analysis" | jq -r '.epic.progress.done')
  epic_progress_total=$(echo "$analysis" | jq -r '.epic.progress.total')
  epic_progress_pct=$(echo "$analysis" | jq -r '.epic.progress.percent')

  echo ""
  if [[ "$unicode" == "true" ]]; then
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}📊 EPIC ANALYSIS: ${parent_id}${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════════${NC}"
  else
    echo -e "${BOLD}====================================================================${NC}"
    echo -e "${BOLD}EPIC ANALYSIS: ${parent_id}${NC}"
    echo -e "${BOLD}====================================================================${NC}"
  fi
  echo ""
  echo -e "${BOLD}$epic_title${NC}"
  echo -e "Progress: ${GREEN}$epic_progress_done${NC}/$epic_progress_total tasks (${epic_progress_pct}%)"
  echo ""

  # Phase breakdown with wave details
  echo -e "${BOLD}${CYAN}PHASES${NC}"
  if [[ "$unicode" == "true" ]]; then
    echo -e "───────────────────────────────────────────────────────────────────"
  else
    echo -e "-------------------------------------------------------------------"
  fi

  # Render phases with waves using jq for efficient single-pass rendering
  # This avoids nested while loops with large JSON data
  local phases_output
  phases_output=$(echo "$analysis" | jq -r --arg green "$GREEN" --arg yellow "$YELLOW" --arg dim "$DIM" --arg nc "$NC" '
    .phases[] |
    # Status icon and text
    (if .status == "complete" then {icon: ($green + "✓" + $nc), text: "COMPLETE"}
     elif .status == "in_progress" then {icon: ($yellow + "→" + $nc), text: "IN PROGRESS"}
     elif .status == "pending" then {icon: ($dim + "○" + $nc), text: "PENDING"}
     else {icon: " ", text: ""} end) as $st |

    # Phase header
    "\n\($st.icon) PHASE: \(.phase | ascii_upcase) (\($st.text) \(.progress.done)/\(.progress.total))",

    # Waves within phase
    ((.waves | length) as $wave_count |
     if $wave_count > 0 then
      .waves | sort_by(.depth) | to_entries[] |
      (if .key == ($wave_count - 1) then "└─" else "├─" end) as $branch |
      (if .value.status == "complete" then ($green + "✓" + $nc)
       elif .value.status == "partial" then ($yellow + "~" + $nc)
       elif .value.status == "pending" then ($dim + "○" + $nc)
       else " " end) as $wave_icon |
      (if .value.depth == 0 then "no dependencies"
       else "depends on Wave \(.value.depth - 1)" end) as $wave_desc |
      "   \($branch) Wave \(.value.depth): \($wave_icon) \(.value.tasks | join(", ")) (\($wave_desc))"
    else empty end)
  ')

  echo -e "$phases_output"
  echo ""

  # Ready tasks
  local ready_count
  ready_count=$(echo "$analysis" | jq '.inventory.ready | length')
  echo -e "${BOLD}${GREEN}READY TO START${NC} ${DIM}($ready_count tasks)${NC}"
  if [[ "$unicode" == "true" ]]; then
    echo -e "───────────────────────────────────────────────────────────────────"
  else
    echo -e "-------------------------------------------------------------------"
  fi

  if [[ "$ready_count" -gt 0 ]]; then
    echo "$analysis" | jq -r '.inventory.ready[0:5][] | "  \(.id) [\(.priority)] \(.title) (unlocks: \(.unlocks))"'
    if [[ "$ready_count" -gt 5 ]]; then
      echo -e "  ${DIM}... and $((ready_count - 5)) more${NC}"
    fi
  else
    echo -e "  ${DIM}No ready tasks${NC}"
  fi
  echo ""

  # Blocked tasks
  local blocked_count
  blocked_count=$(echo "$analysis" | jq '.inventory.blocked | length')
  if [[ "$blocked_count" -gt 0 ]]; then
    echo -e "${BOLD}${RED}BLOCKED${NC} ${DIM}($blocked_count tasks)${NC}"
    if [[ "$unicode" == "true" ]]; then
      echo -e "───────────────────────────────────────────────────────────────────"
    else
      echo -e "-------------------------------------------------------------------"
    fi
    echo "$analysis" | jq -r '.inventory.blocked[0:5][] | "  \(.id) [\(.priority)] \(.title) → waiting on: \(.waitingOn | join(", "))"'
    if [[ "$blocked_count" -gt 5 ]]; then
      echo -e "  ${DIM}... and $((blocked_count - 5)) more${NC}"
    fi
    echo ""
  fi

  # Execution plan
  echo -e "${BOLD}${MAGENTA}EXECUTION PLAN${NC}"
  if [[ "$unicode" == "true" ]]; then
    echo -e "───────────────────────────────────────────────────────────────────"
  else
    echo -e "-------------------------------------------------------------------"
  fi

  local critical_length
  critical_length=$(echo "$analysis" | jq -r '.executionPlan.criticalPath.length')
  echo -e "  Critical path length: ${BOLD}$critical_length${NC} tasks"

  # Show execution waves
  local wave_count
  wave_count=$(echo "$analysis" | jq '.executionPlan.waves | length')
  if [[ "$wave_count" -gt 0 ]]; then
    echo ""
    echo -e "  ${CYAN}Execution Waves:${NC}"
    echo "$analysis" | jq -r '.executionPlan.waves[0:5][] | "    Wave \(.wave): \(.parallel | join(", ")) (\(.count) parallel)"'
  fi
  echo ""

  # Recommendation
  local rec_task rec_reason
  rec_task=$(echo "$analysis" | jq -r '.executionPlan.recommendation.nextTask // empty')
  if [[ -n "$rec_task" ]]; then
    rec_reason=$(echo "$analysis" | jq -r '.executionPlan.recommendation.reason')
    echo -e "${BOLD}${GREEN}RECOMMENDATION${NC}"
    echo -e "  ${CYAN}→ ct focus set $rec_task${NC}"
    echo -e "  ${DIM}$rec_reason${NC}"
    echo ""
  fi

  # Dependency Chains Section
  # Computed at render time from depends[] edges (not stored)
  # Per TASK-HIERARCHY-SPEC Part 8: Find connected components, identify roots, render ASCII

  local chains_json
  chains_json=$(echo "$analysis" | jq '
    # ================================================================
    # CHAIN COMPUTATION: Connected Components Algorithm
    # Per TASK-HIERARCHY-SPEC Part 8: Chains are COMPUTED, not stored
    # ================================================================

    # Collect all scoped tasks (completed + ready + blocked, exclude epic itself)
    # IMPORTANT: Use .depends (original dependency array) for chain computation,
    # NOT .waitingOn (filtered to active deps only). Chain detection needs ALL edges.
    (
      [.inventory.completed[]? | {id: .id, title: .title, status: "done", phase: .phase, depends: .depends}] +
      [.inventory.ready[]? | {id: .id, title: .title, status: "pending", phase: .phase, depends: .depends}] +
      [.inventory.blocked[]? | {id: .id, title: .title, status: "pending", phase: .phase, depends: .depends}]
    ) | unique_by(.id) as $all_tasks |

    # Handle empty case
    if ($all_tasks | length) == 0 then
      {chains: [], totalChains: 0, totalTasks: 0}
    else
      # Build scoped task ID set
      [$all_tasks[].id] as $scope_ids |

      # Build lookup map for task info
      (reduce $all_tasks[] as $t ({}; .[$t.id] = $t)) as $lookup |

      # Build bidirectional adjacency for component detection
      # Forward: task -> tasks it depends on (filtered to scope)
      (reduce $all_tasks[] as $t ({};
        .[$t.id] = (($t.depends // []) | map(select(. as $d | $scope_ids | index($d))))
      )) as $forward_deps |

      # Reverse: task -> tasks that depend on it
      (reduce $all_tasks[] as $t ({};
        reduce ($t.depends // [])[] as $dep (.;
          if ($scope_ids | index($dep)) then
            .[$dep] += [$t.id]
          else . end
        )
      )) as $reverse_deps |

      # Bidirectional adjacency: union of forward and reverse edges
      (reduce $scope_ids[] as $id ({};
        .[$id] = ((($forward_deps[$id] // []) + ($reverse_deps[$id] // [])) | unique)
      )) as $adj |

      # BFS to find connected component from a starting node
      def bfs_component($start; $all_visited):
        if ($all_visited | index($start)) then {visited: $all_visited, component: []}
        else
          # BFS queue-based traversal
          {queue: [$start], visited: ($all_visited + [$start]), component: [$start]} |
          until(.queue | length == 0;
            . as $state |
            $state.queue[0] as $current |
            $state.queue[1:] as $rest |
            ($adj[$current] // []) as $neighbors |
            # Filter neighbors not yet visited - use $state to access .visited
            ([$neighbors[] | select(. as $n | $state.visited | index($n) | not)]) as $new_nodes |
            {
              queue: ($rest + $new_nodes),
              visited: ($state.visited + $new_nodes),
              component: ($state.component + $new_nodes)
            }
          ) | {visited: .visited, component: (.component | unique | sort)}
        end;

      # Find all connected components
      (reduce $scope_ids[] as $id ({visited: [], components: []};
        if (.visited | index($id)) then .
        else
          bfs_component($id; .visited) as $result |
          if ($result.component | length) > 0 then
            {
              visited: $result.visited,
              components: (.components + [$result.component])
            }
          else
            {visited: $result.visited, components: .components}
          end
        end
      )) as $component_result |

      # For each component, find roots (tasks with no deps within component)
      ($component_result.components | map(. as $comp |
        # Root = task where all its deps are outside the component (or no deps)
        ($comp | map(select(
          . as $id |
          (($forward_deps[$id] // []) | map(select(. as $d | $comp | index($d)))) | length == 0
        ))) as $roots |
        {
          tasks: $comp,
          roots: $roots,
          root: ($roots | sort | .[0] // $comp[0]),
          taskCount: ($comp | length)
        }
      )) as $components_with_roots |

      # Sort components by root ID and assign labels A, B, C...
      ($components_with_roots | sort_by(.root) | to_entries | map(
        .value + {
          label: (65 + .key | [.] | implode),
          rootTitle: ($lookup[.value.root].title // "Unknown")[:40]
        }
      )) as $labeled_chains |

      # Build task details for rendering each chain
      ($labeled_chains | map(. as $chain |
        ($chain.tasks | map(. as $id | {
          id: $id,
          title: ($lookup[$id].title // "")[:35],
          status: ($lookup[$id].status // "pending"),
          phase: ($lookup[$id].phase // ""),
          deps: (($forward_deps[$id] // []) | map(select(. as $d | $chain.tasks | index($d)))),
          children: (($reverse_deps[$id] // []) | map(select(. as $d | $chain.tasks | index($d))))
        }) | sort_by(.id)) as $task_details |
        $chain + {taskDetails: $task_details}
      )) |

      # Return final chain data
      {
        chains: .,
        totalChains: (. | length),
        totalTasks: ([.[].taskCount] | add // 0)
      }
    end
  ')

  local chain_count total_tasks
  chain_count=$(echo "$chains_json" | jq -r '.totalChains')
  total_tasks=$(echo "$chains_json" | jq -r '.totalTasks')

  if [[ "$chain_count" -gt 0 ]]; then
    echo -e "${BOLD}${BLUE}DEPENDENCY CHAINS${NC} ${DIM}(computed from depends[])${NC}"
    if [[ "$unicode" == "true" ]]; then
      echo -e "───────────────────────────────────────────────────────────────────"
    else
      echo -e "-------------------------------------------------------------------"
    fi

    # Render each chain with ASCII visualization
    echo "$chains_json" | jq -r '.chains[] | @base64' | while read -r chain_b64; do
      local chain_data label root_id root_title task_count
      chain_data=$(echo "$chain_b64" | base64 -d)
      label=$(echo "$chain_data" | jq -r '.label')
      root_id=$(echo "$chain_data" | jq -r '.root')
      root_title=$(echo "$chain_data" | jq -r '.rootTitle')
      task_count=$(echo "$chain_data" | jq -r '.taskCount')

      # Chain header with task count
      echo -e "${YELLOW}CHAIN $label:${NC} ${DIM}$root_title ($task_count tasks)${NC}"

      # Render chain as ASCII dependency flow
      # Get task details for this chain
      local task_details
      task_details=$(echo "$chain_data" | jq -r '.taskDetails')

      # Render using topological order with status icons
      # Format: ✅T001 → ✅T002 → ⏳T003 for linear chains
      # Or tree format for branching chains
      local roots_in_chain num_roots
      roots_in_chain=$(echo "$task_details" | jq -r '[.[] | select(.deps | length == 0) | .id]')
      num_roots=$(echo "$roots_in_chain" | jq -r 'length')

      if [[ "$task_count" -eq 1 ]]; then
        # Single task chain - standalone
        local single_id single_status single_icon
        single_id=$(echo "$task_details" | jq -r '.[0].id')
        single_status=$(echo "$task_details" | jq -r '.[0].status')
        [[ "$single_status" == "done" ]] && single_icon="✅" || single_icon="⏳"
        echo "  ${single_icon}${single_id}"
      elif [[ "$num_roots" -eq 1 ]]; then
        # Single root - render linear chain with arrows
        render_chain_linear "$task_details"
      else
        # Multiple roots or complex - render tree structure
        render_chain_tree "$task_details" "$roots_in_chain"
      fi

      echo ""
    done

    echo -e "${DIM}Note: Chains computed at render time from depends[] edges${NC}"
    echo ""
  fi

  # Stale Tasks (if enabled) - scoped to epic
  local stale_enabled
  stale_enabled=$(get_stale_detection_enabled 2>/dev/null || echo "true")

  if [[ "$stale_enabled" == "true" ]] && declare -f get_stale_tasks >/dev/null 2>&1; then
    local all_stale_tasks scoped_ids scoped_stale stale_count
    all_stale_tasks=$(get_stale_tasks "$todo_file" 2>/dev/null || echo "[]")

    # Get scoped task IDs from epic analysis
    scoped_ids=$(echo "$analysis" | jq -r '[.inventory.completed[].id, .inventory.ready[].id, .inventory.blocked[].id] | unique')

    # Filter stale tasks to only those in epic scope
    scoped_stale=$(echo "$all_stale_tasks" | jq --argjson scopedIds "$scoped_ids" '
      [.[] | select(.taskId as $id | $scopedIds | index($id))]
    ')
    stale_count=$(echo "$scoped_stale" | jq 'length')

    if [[ "$stale_count" -gt 0 ]]; then
      echo -e "${BOLD}${YELLOW}STALE TASKS${NC} ${DIM}(need review - $stale_count in this epic)${NC}"
      if [[ "$unicode" == "true" ]]; then
        echo -e "───────────────────────────────────────────────────────────────────"
      else
        echo -e "-------------------------------------------------------------------"
      fi
      # Show top 5 stale tasks, sorted by severity
      echo "$scoped_stale" | jq -r '.[0:5][] |
        "  \(.taskId) [\(.priority)] - \(.staleness.reason)"'
      if [[ "$stale_count" -gt 5 ]]; then
        echo -e "  ${DIM}... and $((stale_count - 5)) more${NC}"
      fi
      echo ""
    fi
  fi

  if [[ "$unicode" == "true" ]]; then
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════════${NC}"
  else
    echo -e "${BOLD}====================================================================${NC}"
  fi
}

#####################################################################
# Core Analysis - Single jq Query for Efficiency
#####################################################################

# Complete analysis in a single jq pass for performance
run_complete_analysis() {
  local todo_file="$1"

  # Read hierarchy weight configs with defaults
  local weight_parent_child weight_cross_epic weight_cross_phase
  weight_parent_child=$(get_config_value "analyze.hierarchyWeight.parentChild" "0.3" 2>/dev/null || echo "0.3")
  weight_cross_epic=$(get_config_value "analyze.hierarchyWeight.crossEpic" "1.0" 2>/dev/null || echo "1.0")
  weight_cross_phase=$(get_config_value "analyze.hierarchyWeight.crossPhase" "1.5" 2>/dev/null || echo "1.5")

  # Read phase boost config values with defaults
  local boost_current boost_adjacent boost_distant current_phase
  boost_current=$(get_config_value "analyze.phaseBoost.current" "1.5" 2>/dev/null || echo "1.5")
  boost_adjacent=$(get_config_value "analyze.phaseBoost.adjacent" "1.25" 2>/dev/null || echo "1.25")
  boost_distant=$(get_config_value "analyze.phaseBoost.distant" "1.0" 2>/dev/null || echo "1.0")

  # Get current project phase for phase boost calculation
  current_phase=$(get_current_phase "$todo_file")

  # Read size weighting strategy config
  local size_strategy
  size_strategy=$(get_config_value "analyze.sizeStrategy" "balanced" 2>/dev/null || echo "balanced")

  jq --arg version "$VERSION" \
     --argjson w_parent_child "$weight_parent_child" \
     --argjson w_cross_epic "$weight_cross_epic" \
     --argjson w_cross_phase "$weight_cross_phase" \
     --argjson boost_current "$boost_current" \
     --argjson boost_adjacent "$boost_adjacent" \
     --argjson boost_distant "$boost_distant" \
     --arg current_phase "$current_phase" \
     --arg size_strategy "$size_strategy" '
    # ================================================================
    # SETUP: Build dependency graphs and helper data
    # ================================================================

    .tasks as $all_tasks |

    # Build lookup maps for hierarchy analysis
    (reduce $all_tasks[] as $t ({}; .[$t.id] = ($t.parentId // null))) as $parent_map |
    (reduce $all_tasks[] as $t ({}; .[$t.id] = ($t.phase // null))) as $phase_map |
    (reduce $all_tasks[] as $t ({}; .[$t.id] = ($t.type // "task"))) as $type_map |

    # Function to get epic ancestor (first ancestor with type="epic")
    # Returns null if no epic ancestor exists
    def get_epic_ancestor($task_id):
      if $task_id == null then null
      else
        $parent_map[$task_id] as $parent_id |
        if $parent_id == null then null
        elif $type_map[$parent_id] == "epic" then $parent_id
        else get_epic_ancestor($parent_id)
        end
      end;

    # Build epic ancestor map for all tasks
    (reduce $all_tasks[] as $t ({}; .[$t.id] = get_epic_ancestor($t.id))) as $epic_map |

    # Function to check if two tasks are parent-child
    def is_parent_child($id1; $id2):
      ($parent_map[$id1] == $id2) or ($parent_map[$id2] == $id1);

    # Function to check if two tasks share same epic ancestor
    def same_epic($id1; $id2):
      ($epic_map[$id1] != null) and ($epic_map[$id1] == $epic_map[$id2]);

    # Function to check if two tasks have different phases (cross-phase)
    def is_cross_phase($id1; $id2):
      ($phase_map[$id1] != null) and ($phase_map[$id2] != null) and 
      ($phase_map[$id1] != $phase_map[$id2]);

    # Function to get dependency weight for a blocker->blocked relationship
    def get_dep_weight($blocker_id; $blocked_id):
      if is_parent_child($blocker_id; $blocked_id) then $w_parent_child
      elif is_cross_phase($blocker_id; $blocked_id) then $w_cross_phase
      elif same_epic($blocker_id; $blocked_id) then $w_cross_epic
      else 1.0
      end;

    # Phase order map for distance calculation
    {"setup": 1, "core": 2, "testing": 3, "polish": 4, "maintenance": 5} as $phase_orders |

    # Function to get phase boost multiplier for a task based on phase distance
    # Distance 0 (same phase) = boost_current, Distance 1 (adjacent) = boost_adjacent, Distance 2+ = boost_distant
    def get_phase_boost($task_phase):
      if $current_phase == "" or $current_phase == null then 1.0
      elif $task_phase == null or $task_phase == "" then 1.0
      elif $task_phase == $current_phase then $boost_current
      else
        # Calculate phase distance
        (($phase_orders[$task_phase] // 0) - ($phase_orders[$current_phase] // 0)) as $diff |
        (if $diff < 0 then -$diff else $diff end) as $distance |
        if $distance == 1 then $boost_adjacent
        else $boost_distant
        end
      end;

    # Function to get size weight multiplier based on strategy
    # Returns: 1, 2, or 3 based on strategy and task size
    def get_size_weight($task_size):
      if $task_size == null or $task_size == "" then 1
      elif $size_strategy == "quick-wins" then
        if $task_size == "small" then 3
        elif $task_size == "medium" then 2
        elif $task_size == "large" then 1
        else 1 end
      elif $size_strategy == "big-impact" then
        if $task_size == "small" then 1
        elif $task_size == "medium" then 2
        elif $task_size == "large" then 3
        else 1 end
      else
        # balanced or unknown strategy
        1
      end;

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

    # Pending task IDs for quick lookup
    ([$pending_tasks[] | .id]) as $pending_ids |

    # Build forward dependency map: task_id -> [tasks it depends on]
    (reduce $pending_tasks[] as $task ({};
      .[$task.id] = ($task.depends // [])
    )) as $forward_deps |

    # ================================================================
    # WAVE COMPUTATION: Calculate dependency depth for each task
    # Wave 0 = no pending deps, Wave N = max(dep waves) + 1
    # ================================================================

    def compute_wave($id; $memo; $visiting):
      if ($memo | has($id)) then $memo
      elif ($visiting | any(. == $id)) then $memo | .[$id] = 0  # Cycle detection
      else
        ($forward_deps[$id] // []) as $deps |
        # Filter to pending dependencies only
        [$deps[] | select(. as $d | $pending_ids | any(. == $d))] as $active_deps |
        if ($active_deps | length) == 0 then
          $memo | .[$id] = 0
        else
          # Compute waves for all deps first (with cycle detection)
          (reduce $active_deps[] as $dep ($memo;
            compute_wave($dep; .; $visiting + [$id])
          )) as $updated_memo |
          # Max dep wave + 1
          ([$active_deps[] | $updated_memo[.] // 0] | max + 1) as $wave |
          $updated_memo | .[$id] = $wave
        end
      end;

    # Compute waves for all pending tasks
    (reduce $pending_ids[] as $id ({}; compute_wave($id; .; []))) as $waves |

    # ================================================================
    # LEVERAGE: Calculate hierarchy-aware leverage scores
    # ================================================================

    [
      $pending_tasks[] |
      . as $task |
      ($reverse_deps[$task.id] // []) as $blocked_by_this |
      # Calculate weighted unlocks
      (reduce $blocked_by_this[] as $blocked_id (
        0;
        . + get_dep_weight($task.id; $blocked_id)
      )) as $weighted_unlocks |
      # Calculate phase boost for this task
      get_phase_boost($task.phase // null) as $phase_boost |
      # Calculate size weight multiplier for this task
      get_size_weight($task.size // null) as $size_weight |
      # Calculate phase distance for phaseAlignment
      (if $current_phase == "" or $current_phase == null then null
       elif ($task.phase // null) == null then null
       elif ($task.phase // null) == $current_phase then 0
       else
         (($phase_orders[$task.phase] // 0) - ($phase_orders[$current_phase] // 0)) |
         if . < 0 then -. else . end
       end) as $phase_distance |
      {
        id: $task.id,
        title: $task.title,
        status: $task.status,
        priority: ($task.priority // "medium"),
        phase: ($task.phase // null),
        size: ($task.size // null),
        labels: ($task.labels // []),
        depends: ($task.depends // []),
        unlocks_count: ($blocked_by_this | length),
        weighted_unlocks: $weighted_unlocks,
        unlocks_tasks: $blocked_by_this,
        phase_boost: $phase_boost,
        size_weight: $size_weight,
        phaseAlignment: {
          taskPhase: ($task.phase // null),
          projectPhase: (if $current_phase == "" then null else $current_phase end),
          distance: $phase_distance,
          boost: $phase_boost,
          indicator: (
            if $phase_boost >= 1.5 then "🎯"
            elif $phase_boost >= 1.25 then "↔️"
            else null
            end
          )
        },
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
      # Use weighted unlocks for leverage score (scaled by 15), multiplied by phase boost and size weight
      .leverage_score = (((((.weighted_unlocks * 15) | floor) + .priority_score) * .phase_boost * .size_weight) | floor) |
      # ================================================================
      # CONFIDENCE: Normalized 0.0-1.0 score for anti-hallucination
      # Helps agents know when to proceed vs. ask for clarification
      # ================================================================
      .confidence = (
        # Base confidence
        0.50
        # Phase alignment: +0.0 to +0.20 (based on phase_boost 1.0-1.5)
        + ((.phase_boost - 1.0) * 0.40)
        # Actionability: +0.20 if ready, -0.10 if blocked
        + (if .is_actionable then 0.20 else -0.10 end)
        # Metadata completeness: +0.05 each for size and labels
        + (if .size != null then 0.05 else 0 end)
        + (if (.labels | length) > 0 then 0.05 else 0 end)
        # Priority boost: +0.10 critical, +0.05 high
        + (if .priority == "critical" then 0.10
           elif .priority == "high" then 0.05
           else 0 end)
        # Strategic value: +0.05 if unblocks other tasks
        + (if .unlocks_count > 0 then 0.05 else 0 end)
      ) |
      # Clamp confidence to [0.10, 1.00] and round to 2 decimal places
      .confidence as $c |
      .confidence = ((if $c > 1.0 then 1.0 elif $c < 0.1 then 0.1 else $c end) * 100 | floor / 100)
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
        weighted_blocks: .weighted_unlocks,
        blocked_tasks: .unlocks_tasks,
        is_actionable: .is_actionable
      }
    ] | sort_by(-(.weighted_blocks // 0)) as $bottlenecks |

    # ================================================================
    # CRITICAL PATH: Longest dependency chain
    # ================================================================

    # Build task lookup for path tracing
    (reduce $pending_tasks[] as $t ({}; .[$t.id] = $t)) as $task_lookup |

    # Find task with maximum wave (end of longest chain)
    ([$pending_tasks[] | {id: .id, wave: ($waves[.id] // 0)}] |
      sort_by(-.wave) | .[0]) as $deepest |

    # Trace critical path by following highest-wave dependencies backward
    (if $deepest and ($deepest.wave // 0) > 0 then
      def trace_path($id; $path):
        $task_lookup[$id] as $task |
        # Get pending dependencies
        [($task.depends // [])[] | select(. as $d | $pending_ids | any(. == $d))] as $active_deps |
        if ($active_deps | length) == 0 then $path
        else
          # Find dep with highest wave (on critical path)
          ($active_deps | map({id: ., wave: ($waves[.] // 0)}) | sort_by(-.wave) | .[0].id) as $next |
          trace_path($next; [$task_lookup[$next]] + $path)
        end;
      trace_path($deepest.id; [$task_lookup[$deepest.id]])
    else [] end) as $critical_path |

    # Calculate cascade impact for critical path tasks
    ($critical_path | map({
      id: .id,
      title: .title,
      phase: (.phase // "core"),
      wave: ($waves[.id] // 0),
      cascadeImpact: (($reverse_deps[.id] // []) | length)
    })) as $critical_path_detailed |

    # ================================================================
    # TIERS: Group tasks by strategic value
    # Only actionable tasks in Tiers 1-2, blocked tasks in Tier 3
    # ================================================================

    {
      tier1_unblock: [
        $leverage_data[] |
        select(.unlocks_count >= 3 and .is_actionable) |
        {id, title, priority, size, unlocks_count, weighted_unlocks, unlocks_tasks, leverage_score, confidence, phase_boost, size_weight, phaseAlignment}
      ] | sort_by(-(.weighted_unlocks // 0)),

      tier2_critical: [
        $leverage_data[] |
        select(
          .is_actionable and
          .unlocks_count < 3 and
          (.priority == "critical" or .priority == "high")
        ) |
        {id, title, priority, size, unlocks_count, leverage_score, confidence, phase_boost, size_weight, phaseAlignment}
      ] | sort_by(-(.leverage_score // 0)),

      tier3_blocked: [
        $leverage_data[] |
        select((.is_actionable // false) == false) |
        {
          id,
          title,
          priority,
          size,
          confidence,
          phase_boost,
          size_weight,
          phaseAlignment,
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
        {id, title, priority, size, unlocks_count, leverage_score, confidence, phase_boost, size_weight, phaseAlignment}
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
            {id, title, priority, is_actionable, unlocks_count, weighted_unlocks, confidence}
          ],
          count: ([$leverage_data[] | select(.labels | index($label) | type == "number")] | length),
          actionable_count: ([$leverage_data[] | select(.labels | index($label) | type == "number") | select(.is_actionable)] | length)
        } |
        select(.count >= 2)  # Only show domains with 2+ tasks
      ] | sort_by(-(.count // 0))
    ) as $domains |

    # ================================================================
    # ACTION ORDER: Suggested sequence to maximize throughput
    # Priority: Tier1 by weighted leverage -> Tier2 by leverage -> Tier4 by leverage
    # ================================================================

    (
      ($tiers.tier1_unblock | map({
        id, title, priority, confidence,
        reason: ("Unblocks \(.unlocks_count) tasks (weighted: \(.weighted_unlocks | tostring | split(".")[0]))" +
          if .phase_boost > 1.0 then " (phase-aligned +\(((.phase_boost - 1) * 100) | floor)%)"
          else "" end),
        tier: 1,
        phaseAlignment
      })) +
      ($tiers.tier2_critical | map({
        id, title, priority, confidence,
        reason: ("High priority, actionable" +
          if .phase_boost > 1.0 then " (phase-aligned +\(((.phase_boost - 1) * 100) | floor)%)"
          else "" end),
        tier: 2,
        phaseAlignment
      })) +
      ($tiers.tier4_routine[0:5] | map({
        id, title, priority, confidence,
        reason: ("Quick win" +
          if .phase_boost > 1.0 then " (phase-aligned +\(((.phase_boost - 1) * 100) | floor)%)"
          else "" end),
        tier: 4,
        phaseAlignment
      }))
    )[0:10] as $action_order |

    # ================================================================
    # RECOMMENDATION: Single best task with reasoning
    # ================================================================

    (
      if ($tiers.tier1_unblock | length) > 0 then
        $tiers.tier1_unblock | sort_by(-(.weighted_unlocks // 0)) | .[0] |
        {
          task_id: .id,
          title: .title,
          priority: .priority,
          confidence: .confidence,
          reason: ("Highest leverage - unblocks \(.unlocks_count) tasks (weighted: \(.weighted_unlocks | tostring | split(".")[0]))" +
            if .phase_boost > 1.0 then " (phase-aligned +\(((.phase_boost - 1) * 100) | floor)%)"
            else "" end),
          unlocks: .unlocks_tasks,
          phaseAlignment,
          command: "ct focus set \(.id)"
        }
      elif ($tiers.tier2_critical | length) > 0 then
        $tiers.tier2_critical[0] |
        {
          task_id: .id,
          title: .title,
          priority: .priority,
          confidence: .confidence,
          reason: ("Critical/high priority with clear path" +
            if .phase_boost > 1.0 then " (phase-aligned +\(((.phase_boost - 1) * 100) | floor)%)"
            else "" end),
          unlocks: [],
          phaseAlignment,
          command: "ct focus set \(.id)"
        }
      elif ($tiers.tier4_routine | length) > 0 then
        $tiers.tier4_routine[0] |
        {
          task_id: .id,
          title: .title,
          priority: .priority,
          confidence: .confidence,
          reason: ("Actionable task in backlog" +
            if .phase_boost > 1.0 then " (phase-aligned +\(((.phase_boost - 1) * 100) | floor)%)"
            else "" end),
          unlocks: [],
          phaseAlignment,
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
        "algorithm": "hierarchy_aware_leverage",
        "weights": {
          "parentChild": $w_parent_child,
          "crossEpic": $w_cross_epic,
          "crossPhase": $w_cross_phase
        },
        "phaseBoost": {
          "currentPhase": (if $current_phase == "" then null else $current_phase end),
          "boostCurrent": $boost_current,
          "boostAdjacent": $boost_adjacent,
          "boostDistant": $boost_distant
        },
        "sizeWeighting": {
          "strategy": $size_strategy
        }
      },
      "success": true,

      "summary": $summary,

      "recommendation": $recommendation,

      "action_order": $action_order,

      "bottlenecks": ($bottlenecks | .[0:5]),

      "criticalPath": {
        "description": "Longest dependency chain - delays here cascade to all downstream tasks",
        "length": ($critical_path | length),
        "maxWave": ($deepest.wave // 0),
        "path": $critical_path_detailed,
        "entryTask": (if ($critical_path | length) > 0 then $critical_path[0].id else null end),
        "exitTask": (if ($critical_path | length) > 0 then $critical_path[-1].id else null end),
        "totalCascadeImpact": ($critical_path_detailed | map(.cascadeImpact) | add // 0)
      },

      "leverage": ($leverage_data | map(select(.unlocks_count > 0)) | .[0:10]),

      "tiers": {
        "tier1_unblock": {
          "description": "High leverage - unblock multiple tasks (hierarchy-weighted)",
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
    jq -nc --arg version "$VERSION" '{
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

  # Run core analysis
  local analysis
  analysis=$(run_complete_analysis "$todo_file")

  # Check if stale detection is enabled
  local stale_enabled
  stale_enabled=$(get_stale_detection_enabled 2>/dev/null || echo "true")

  if [[ "$stale_enabled" == "true" ]] && declare -f get_stale_tasks >/dev/null 2>&1; then
    # Get stale tasks and merge into analysis output
    local stale_tasks stale_count
    stale_tasks=$(get_stale_tasks "$todo_file" 2>/dev/null || echo "[]")
    stale_count=$(echo "$stale_tasks" | jq 'length')

    # Merge stale data and adjust confidence for stale tasks (-0.15 penalty)
    analysis=$(echo "$analysis" | jq --argjson staleTasks "$stale_tasks" --argjson staleCount "$stale_count" '
      # Build set of stale task IDs for fast lookup
      ([$staleTasks[].taskId] | map({(.): true}) | add // {}) as $staleIds |

      # Helper to adjust confidence for stale tasks
      def adjust_confidence:
        if .id and $staleIds[.id] then
          ((.confidence - 0.15) | if . < 0.1 then 0.1 else . end) as $adj |
          .confidence = ($adj * 100 | floor / 100) |
          .isStale = true
        else . end;

      # Helper for recommendation (uses task_id instead of id)
      def adjust_recommendation_confidence:
        if .task_id and $staleIds[.task_id] then
          ((.confidence - 0.15) | if . < 0.1 then 0.1 else . end) as $adj |
          .confidence = ($adj * 100 | floor / 100) |
          .isStale = true
        else . end;

      # Adjust confidence in all task arrays
      .recommendation |= (if . then adjust_recommendation_confidence else . end) |
      .action_order |= map(adjust_confidence) |
      .leverage |= map(adjust_confidence) |
      .tiers.tier1_unblock.tasks |= map(adjust_confidence) |
      .tiers.tier2_critical.tasks |= map(adjust_confidence) |
      .tiers.tier3_blocked.tasks |= map(adjust_confidence) |
      .tiers.tier4_routine.tasks |= map(adjust_confidence) |
      .domains |= map(.tasks |= map(adjust_confidence)) |
      . + {
        staleTasks: $staleTasks,
        staleCount: $staleCount
      }
    ')
  fi

  # Add concurrency/lock awareness data if enabled and not ignored
  if [[ "$IGNORE_LOCKS" != "true" ]] && declare -f get_concurrency_json >/dev/null 2>&1; then
    local concurrency_data
    concurrency_data=$(get_concurrency_json "$CLEO_DIR" 2>/dev/null || echo '{"enabled": false}')
    analysis=$(echo "$analysis" | jq --argjson concurrency "$concurrency_data" '. + {concurrency: $concurrency}')
  fi

  echo "$analysis"
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
  local rec_task rec_reason rec_unlocks rec_indicator
  rec_task=$(echo "$analysis" | jq -r '.recommendation.task_id // empty')
  if [[ -n "$rec_task" ]]; then
    rec_reason=$(echo "$analysis" | jq -r '.recommendation.reason')
    rec_indicator=$(echo "$analysis" | jq -r '.recommendation.phaseAlignment.indicator // empty')
    echo -e "${BOLD}${GREEN}RECOMMENDATION${NC}"
    if [[ -n "$rec_indicator" ]]; then
      echo -e "  ${CYAN}→ ct focus set $rec_task${NC} $rec_indicator"
    else
      echo -e "  ${CYAN}→ ct focus set $rec_task${NC}"
    fi
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
    # Include phase indicator if present
    echo "$analysis" | jq -r '.action_order[0:5][] |
      (if .phaseAlignment.indicator then .phaseAlignment.indicator + " " else "" end) as $ind |
      "  \(.id) [\(.priority)] \($ind)\(.reason)"'
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

  # Stale Tasks (if enabled)
  local stale_enabled
  stale_enabled=$(get_stale_detection_enabled 2>/dev/null || echo "true")

  if [[ "$stale_enabled" == "true" ]] && declare -f get_stale_tasks >/dev/null 2>&1; then
    local stale_tasks stale_count
    stale_tasks=$(get_stale_tasks "$todo_file" 2>/dev/null || echo "[]")
    stale_count=$(echo "$stale_tasks" | jq 'length')

    if [[ "$stale_count" -gt 0 ]]; then
      echo -e "${BOLD}${YELLOW}STALE TASKS${NC} ${DIM}(need review - $stale_count total)${NC}"
      # Show top 5 stale tasks, sorted by severity (already sorted by get_stale_tasks)
      echo "$stale_tasks" | jq -r '.[0:5][] |
        "  \(.taskId) [\(.priority)] - \(.staleness.reason)"'
      if [[ "$stale_count" -gt 5 ]]; then
        echo -e "  ${DIM}... and $((stale_count - 5)) more${NC}"
      fi
      echo ""
    fi
  fi

  # Concurrency Warnings (if enabled and not ignored)
  if [[ "$IGNORE_LOCKS" != "true" ]] && declare -f format_concurrency_section >/dev/null 2>&1; then
    format_concurrency_section "$CLEO_DIR"
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
      --parent)
        PARENT_ID="$2"
        shift 2
        ;;
      -f|--format)
        OUTPUT_MODE="$2"
        shift 2
        ;;
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
      --ignore-locks)
        IGNORE_LOCKS=true
        shift
        ;;
      --wait-for-locks)
        WAIT_FOR_LOCKS=true
        # Check if next arg is a number (timeout)
        if [[ -n "${2:-}" ]] && [[ "$2" =~ ^[0-9]+$ ]]; then
          WAIT_TIMEOUT="$2"
          shift
        fi
        shift
        ;;
      --show-locks)
        SHOW_LOCKS_ONLY=true
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

  # Handle --show-locks mode (just show lock status and exit)
  if [[ "$SHOW_LOCKS_ONLY" == "true" ]]; then
    if declare -f get_all_locks >/dev/null 2>&1; then
      local all_locks
      all_locks=$(get_all_locks "$CLEO_DIR")

      if [[ "$OUTPUT_MODE" == "json" ]]; then
        jq -nc \
          --arg version "$VERSION" \
          --argjson locks "$all_locks" \
          '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {"format": "json", "command": "analyze --show-locks", "version": $version, "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))},
            "success": true,
            "locks": $locks,
            "count": ($locks | length),
            "byStatus": ($locks | group_by(.status) | map({key: .[0].status, value: length}) | from_entries)
          }'
      else
        if declare -f format_lock_info >/dev/null 2>&1; then
          format_lock_info "$all_locks"
        else
          echo "$all_locks" | jq -r '.[] | "\(.resource) - \(.status) (\(.age_human))"'
        fi
      fi
      exit "$EXIT_SUCCESS"
    else
      log_error "Lock detection not available"
      exit "${EXIT_DEPENDENCY_ERROR:-5}"
    fi
  fi

  # Handle --wait-for-locks mode
  if [[ "$WAIT_FOR_LOCKS" == "true" ]] && [[ "$IGNORE_LOCKS" != "true" ]]; then
    if declare -f wait_for_locks >/dev/null 2>&1; then
      if [[ "$OUTPUT_MODE" != "json" ]]; then
        echo "Waiting for active locks to release (timeout: ${WAIT_TIMEOUT}s)..."
      fi
      if ! wait_for_locks "$WAIT_TIMEOUT" "$CLEO_DIR"; then
        if [[ "$OUTPUT_MODE" == "json" ]]; then
          jq -nc \
            --arg version "$VERSION" \
            --argjson timeout "$WAIT_TIMEOUT" \
            '{
              "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
              "_meta": {"format": "json", "command": "analyze", "version": $version, "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))},
              "success": false,
              "error": {
                "code": "E_LOCK_TIMEOUT",
                "message": "Timeout waiting for locks to release",
                "timeout": $timeout
              }
            }'
        fi
        exit "${EXIT_TIMEOUT:-7}"
      fi
    fi
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

  # Epic-scoped analysis mode (--parent)
  if [[ -n "$PARENT_ID" ]]; then
    # Validate parent task exists
    local parent_exists
    parent_exists=$(jq -r --arg id "$PARENT_ID" '.tasks[] | select(.id == $id) | .id' "$TODO_FILE")
    if [[ -z "$parent_exists" ]]; then
      if [[ "$OUTPUT_MODE" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_NOT_FOUND" "Parent task not found: $PARENT_ID" "${EXIT_NOT_FOUND:-4}" true "Use 'ct list --type epic' to see available epics"
      else
        log_error "Parent task not found: $PARENT_ID"
      fi
      exit "${EXIT_NOT_FOUND:-4}"
    fi

    # Run epic-scoped analysis
    case "$OUTPUT_MODE" in
      json)
        # Run core epic analysis
        local epic_analysis
        epic_analysis=$(run_epic_analysis "$TODO_FILE" "$PARENT_ID")

        # Check if stale detection is enabled
        local stale_enabled
        stale_enabled=$(get_stale_detection_enabled 2>/dev/null || echo "true")

        if [[ "$stale_enabled" == "true" ]] && declare -f get_stale_tasks >/dev/null 2>&1; then
          # Get stale tasks and filter to epic scope
          local all_stale_tasks scoped_ids scoped_stale stale_count
          all_stale_tasks=$(get_stale_tasks "$TODO_FILE" 2>/dev/null || echo "[]")

          # Get scoped task IDs from epic analysis
          scoped_ids=$(echo "$epic_analysis" | jq -r '[.inventory.completed[].id, .inventory.ready[].id, .inventory.blocked[].id] | unique')

          # Filter stale tasks to only those in epic scope
          scoped_stale=$(echo "$all_stale_tasks" | jq --argjson scopedIds "$scoped_ids" '
            [.[] | select(.taskId as $id | $scopedIds | index($id))]
          ')
          stale_count=$(echo "$scoped_stale" | jq 'length')

          # Merge stale data into epic analysis JSON
          echo "$epic_analysis" | jq --argjson staleTasks "$scoped_stale" --argjson staleCount "$stale_count" '
            . + {
              staleTasks: $staleTasks,
              staleCount: $staleCount
            }
          '
        else
          # Output epic analysis without stale data
          echo "$epic_analysis"
        fi
        ;;
      human|full)
        output_epic_human "$TODO_FILE" "$PARENT_ID"
        ;;
    esac

    # Auto-focus if requested (for epic mode)
    if [[ "$AUTO_FOCUS" == "true" ]]; then
      local analysis
      analysis=$(run_epic_analysis "$TODO_FILE" "$PARENT_ID")
      local rec_task
      rec_task=$(echo "$analysis" | jq -r '.executionPlan.recommendation.nextTask // empty')

      if [[ -n "$rec_task" ]]; then
        if [[ "$OUTPUT_MODE" != "json" ]]; then
          echo ""
          echo "Setting focus to $rec_task..."
        fi
        "$SCRIPT_DIR/focus-command.sh" set "$rec_task" >/dev/null 2>&1

        if [[ "$OUTPUT_MODE" == "json" ]]; then
          echo ""
          jq -nc --arg task "$rec_task" '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "auto_focus": {"set": $task, "status": "success"}
          }'
        fi
      fi
    fi
    exit "$EXIT_SUCCESS"
  fi

  # Standard project-wide analysis
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
        jq -nc --arg task "$rec_task" '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "auto_focus": {"set": $task, "status": "success"}
        }'
      fi
    fi
  fi
}

main "$@"
