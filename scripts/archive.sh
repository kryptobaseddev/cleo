#!/usr/bin/env bash
# CLEO Archive Script
# Archive completed tasks based on config rules
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source version from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Source version library for proper version management
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/version.sh" ]]; then
  # shellcheck source=../lib/version.sh
  source "$LIB_DIR/version.sh"
fi

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.cleo/todo-archive.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
LOG_FILE="${LOG_FILE:-.cleo/todo-log.json}"

# Source logging library for should_use_color function
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  # shellcheck source=../lib/logging.sh
  source "$LIB_DIR/logging.sh"
fi

# Source backup library for unified backup management
if [[ -f "$LIB_DIR/backup.sh" ]]; then
  # shellcheck source=../lib/backup.sh
  source "$LIB_DIR/backup.sh"
fi

# Source file-ops library for atomic writes with file locking
if [[ -f "$LIB_DIR/file-ops.sh" ]]; then
  # shellcheck source=../lib/file-ops.sh
  source "$LIB_DIR/file-ops.sh"
fi

# Source output formatting library
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  # shellcheck source=../lib/output-format.sh
  source "$LIB_DIR/output-format.sh"
fi

# Source error JSON library (includes exit-codes.sh)
# Note: error-json.sh sources exit-codes.sh, so we don't source it separately
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/exit-codes.sh
  source "$LIB_DIR/exit-codes.sh"
fi

# Source config library for unified config access (v0.24.0)
if [[ -f "$LIB_DIR/config.sh" ]]; then
  # shellcheck source=../lib/config.sh
  source "$LIB_DIR/config.sh"
fi

# Source validation library for input validation (Part 5.3 compliance)
if [[ -f "$LIB_DIR/validation.sh" ]]; then
  # shellcheck source=../lib/validation.sh
  source "$LIB_DIR/validation.sh"
fi

# Colors (respects NO_COLOR and FORCE_COLOR environment variables per https://no-color.org)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' NC=''
fi

# Defaults
DRY_RUN=false
FORCE=false
ARCHIVE_ALL=false
MAX_OVERRIDE=""
FORMAT=""
QUIET=false
SHOW_WARNINGS=""  # Empty means use config, explicit true/false from --no-warnings
COMMAND_NAME="archive"
ONLY_LABELS=""
EXCLUDE_LABELS=""
SAFE_MODE=""  # CLI override - empty means use config default
CASCADE_ARCHIVE=false  # Archive completed parents with all completed children
CASCADE_FROM=""        # Archive specific task and all its completed descendants
INTERACTIVE=false      # Interactive mode: review each task before archiving
PHASE_TRIGGER=""       # Phase-triggered archiving: archive completed tasks from specified phase

# Phase trigger tracking (populated during phase filter processing)
PHASE_TRIGGER_INFO='null'

# Relationship safety tracking (populated during safe mode checks)
BLOCKED_BY_CHILDREN='[]'
BLOCKED_BY_DEPENDENTS='[]'

# Cascade tracking (populated during cascade processing)
CASCADE_APPLIED=false
CASCADED_FAMILIES='[]'
CASCADE_FROM_INFO='null'  # Tracks --cascade-from details for JSON output

# Interactive mode tracking
INTERACTIVE_APPROVED=0
INTERACTIVE_SKIPPED=0

# Warning collection (populated before archive operation)
declare -a ARCHIVE_WARNINGS=()
WARNINGS_JSON='[]'

usage() {
  cat << EOF
Usage: cleo archive [OPTIONS]

Archive completed tasks from todo.json to todo-archive.json.

Options:
  --dry-run           Preview without making changes
  --force             Bypass age-based retention (archive immediately)
                      Still respects preserveRecentCount setting
  --all               Archive ALL completed tasks immediately
                      Bypasses BOTH age retention AND preserveRecentCount
  --count N           Override maxCompletedTasks setting
  --only-labels LABELS  Archive ONLY tasks with these labels (comma-separated)
                        Cannot be used with --exclude-labels
                        Example: --only-labels "cleanup,temp"
  --exclude-labels LABELS  Additional labels to exclude (comma-separated)
                           Merges with config exemptLabels
                           Cannot be used with --only-labels
                           Example: --exclude-labels "important,keep"
  --safe              Enable safe mode (default from config)
                      Prevents archiving tasks with:
                      - Active children (would orphan them)
                      - Active dependents (would break references)
  --no-safe           Disable safe mode (override config)
  --cascade           Archive completed parent with all completed children
                      together (respects --safe for incomplete families)
                      If a parent is done but has non-done children, cascade
                      is skipped for that family with a warning
  --cascade-from ID   Archive task and all its completed descendants
                      Useful for archiving completed epics with subtasks
                      Only archives the specified task and descendants that
                      are status=done; warns about incomplete descendants
                      Example: --cascade-from T001
  --phase-complete PHASE  Archive all completed tasks from specified phase
                          Use when a project phase is finished
                          Example: --phase-complete setup
  -i, --interactive   Review each task before archiving
                      Prompts: (y)es, (n)o, (a)ll remaining, (q)uit
  --no-warnings       Suppress relationship warnings
  -f, --format FMT    Output format: text, json (default: auto-detect)
  --human             Force human-readable text output
  --json              Force JSON output (shorthand for --format json)
  -q, --quiet         Suppress non-essential output
  -h, --help          Show this help

Archive Behavior:
  Default:  Only archive tasks older than daysUntilArchive (default 7 days)
            Keeps preserveRecentCount most recent completed tasks (default 3)
            Safe mode is ON by default (checks relationships)

  --force:  Ignores daysUntilArchive - archives regardless of age
            Still keeps preserveRecentCount tasks (safe for recent work)

  --all:    Archives everything marked 'done' without exceptions
            Use with caution - removes ALL completed tasks

  --cascade: When a parent task is completed and ALL its children are also
             completed, archives the entire family together. Incomplete
             families (parent done, some children not done) are skipped.

Config (from config.json):
  - daysUntilArchive: Days after completion before archiving (default: 7)
  - maxCompletedTasks: Threshold triggering archive prompt (default: 15)
  - preserveRecentCount: Recent completions to keep (default: 3)
  - labelPolicies: Per-label retention rules (see below)
  - relationshipSafety.preventOrphanChildren: Block orphaning (default: true)
  - relationshipSafety.preventBrokenDependencies: Block broken deps (default: true)

Label Policies (optional):
  Configure per-label retention in config.json:
    "archive": {
      "labelPolicies": {
        "security": { "daysUntilArchive": 30 },
        "temp": { "daysUntilArchive": 1 },
        "important": { "neverArchive": true }
      }
    }

JSON Output (--format json):
  Returns structured JSON with archived task IDs, counts, and remaining
  task statistics. Useful for LLM agent automation workflows.

Examples:
  cleo archive               # Archive based on config rules (safe mode on)
  cleo archive --dry-run     # Preview what would be archived
  cleo archive --force       # Archive all, keep 3 most recent
  cleo archive --all         # Archive everything (nuclear option)
  cleo archive --cascade     # Archive complete families together
  cleo archive --cascade-from T001  # Archive epic T001 and all done descendants
  cleo archive --phase-complete setup  # Archive completed tasks from 'setup' phase
  cleo archive --interactive # Review each task before archiving
  cleo archive --no-safe     # Disable relationship safety checks
  cleo archive --json        # JSON output for scripting
EOF
  exit "$EXIT_SUCCESS"
}

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    if [[ "$FORMAT" == "json" ]]; then
      echo '{"success":false,"error":{"code":"E_DEPENDENCY_MISSING","message":"jq is required but not installed"}}'
    else
      log_error "jq is required but not installed"
    fi
    exit "${EXIT_DEPENDENCY_ERROR:-5}"
  fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --force) FORCE=true; shift ;;
    --all) ARCHIVE_ALL=true; shift ;;
    --count) MAX_OVERRIDE="$2"; shift 2 ;;
    --only-labels) ONLY_LABELS="$2"; shift 2 ;;
    --exclude-labels) EXCLUDE_LABELS="$2"; shift 2 ;;
    --exclude-labels=*) EXCLUDE_LABELS="${1#*=}"; shift ;;
    --only-labels=*) ONLY_LABELS="${1#*=}"; shift ;;
    --no-warnings) SHOW_WARNINGS=false; shift ;;
    --safe) SAFE_MODE=true; shift ;;
    --no-safe) SAFE_MODE=false; shift ;;
    --cascade) CASCADE_ARCHIVE=true; shift ;;
    --cascade-from) CASCADE_FROM="$2"; shift 2 ;;
    --cascade-from=*) CASCADE_FROM="${1#*=}"; shift ;;
    --phase-complete) PHASE_TRIGGER="$2"; shift 2 ;;
    --phase-complete=*) PHASE_TRIGGER="${1#*=}"; shift ;;
    -i|--interactive) INTERACTIVE=true; shift ;;
    -f|--format) FORMAT="$2"; shift 2 ;;
    --human) FORMAT="text"; shift ;;
    --json) FORMAT="json"; shift ;;
    -q|--quiet) QUIET=true; shift ;;
    -h|--help) usage ;;
    -*) log_error "Unknown option: $1"; exit "${EXIT_INVALID_INPUT:-1}" ;;
    *) shift ;;
  esac
done

# Resolve output format (CLI > env > config > TTY-aware default)
if declare -f resolve_format >/dev/null 2>&1; then
  FORMAT=$(resolve_format "$FORMAT")
else
  FORMAT="${FORMAT:-text}"
fi

check_deps

# Mutual exclusion check for --only-labels and --exclude-labels
if [[ -n "$ONLY_LABELS" && -n "$EXCLUDE_LABELS" ]]; then
  if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
    output_error "$E_INPUT_INVALID" "--only-labels and --exclude-labels cannot be used together" "${EXIT_INVALID_INPUT:-1}" true
  else
    log_error "--only-labels and --exclude-labels cannot be used together"
  fi
  exit "${EXIT_INVALID_INPUT:-1}"
fi

# Check files exist
for f in "$TODO_FILE" "$CONFIG_FILE"; do
  if [[ ! -f "$f" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_FILE_NOT_FOUND" "$f not found" "${EXIT_FILE_ERROR:-3}" true "Run 'cleo init' to initialize project"
    else
      log_error "$f not found"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
  fi
done

# Create archive file if missing
if [[ ! -f "$ARCHIVE_FILE" ]]; then
  # v2.2.0+: .project is an object with .name; v2.1.x: .project was a string
  PROJECT_NAME=$(jq -r '.project.name // .project // "unknown"' "$TODO_FILE")
  INITIAL_ARCHIVE_CONTENT=$(cat << EOF
{
  "version": "${CLEO_VERSION:-$(get_version)}",
  "project": "$PROJECT_NAME",
  "_meta": { "totalArchived": 0, "lastArchived": null, "oldestTask": null, "newestTask": null },
  "archivedTasks": [],
  "phaseSummary": {},
  "statistics": { "byPhase": {}, "byPriority": {"critical":0,"high":0,"medium":0,"low":0}, "byLabel": {}, "averageCycleTime": null }
}
EOF
)
  if declare -f save_json >/dev/null 2>&1; then
    save_json "$ARCHIVE_FILE" "$INITIAL_ARCHIVE_CONTENT"
  else
    echo "$INITIAL_ARCHIVE_CONTENT" > "$ARCHIVE_FILE"
  fi
  [[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_info "Created $ARCHIVE_FILE"
fi

# Validate --cascade-from task exists and is completed
if [[ -n "$CASCADE_FROM" ]]; then
  # Verify task exists
  ROOT_TASK=$(jq --arg id "$CASCADE_FROM" '.tasks[] | select(.id == $id)' "$TODO_FILE")
  if [[ -z "$ROOT_TASK" || "$ROOT_TASK" == "null" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_TASK_NOT_FOUND" "Task $CASCADE_FROM not found" "${EXIT_INVALID_INPUT:-1}" true
    else
      log_error "Task $CASCADE_FROM not found"
    fi
    exit "${EXIT_INVALID_INPUT:-1}"
  fi

  # Verify task is completed
  ROOT_STATUS=$(echo "$ROOT_TASK" | jq -r '.status')
  if [[ "$ROOT_STATUS" != "done" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_INVALID_STATE" "Task $CASCADE_FROM is not completed (status: $ROOT_STATUS)" "${EXIT_INVALID_INPUT:-1}" true "Complete the task before archiving with --cascade-from"
    else
      log_error "Task $CASCADE_FROM is not completed (status: $ROOT_STATUS)"
    fi
    exit "${EXIT_INVALID_INPUT:-1}"
  fi

  [[ "$QUIET" != true && "$FORMAT" != "json" ]] && \
    log_info "Cascade-from: archiving $CASCADE_FROM and all completed descendants"
fi

# Read config using config.sh library for priority resolution (env > project > global > default)
if declare -f get_config_value >/dev/null 2>&1; then
  DAYS_UNTIL_ARCHIVE=$(get_config_value "archive.daysUntilArchive" "7")
  MAX_COMPLETED=$(get_config_value "archive.maxCompletedTasks" "15")
  PRESERVE_COUNT=$(get_config_value "archive.preserveRecentCount" "3")
  EXEMPT_LABELS=$(get_config_value "archive.exemptLabels" '["pinned", "keep"]')
else
  # Fallback to direct jq if config.sh not available
  DAYS_UNTIL_ARCHIVE=$(jq -r '.archive.daysUntilArchive // 7' "$CONFIG_FILE")
  MAX_COMPLETED=$(jq -r '.archive.maxCompletedTasks // 15' "$CONFIG_FILE")
  PRESERVE_COUNT=$(jq -r '.archive.preserveRecentCount // 3' "$CONFIG_FILE")
  EXEMPT_LABELS=$(jq -r '.archive.exemptLabels // ["pinned", "keep"]' "$CONFIG_FILE")
fi

# Validate EXEMPT_LABELS is valid JSON array, fallback to default if not
if ! echo "$EXEMPT_LABELS" | jq -e 'type == "array"' >/dev/null 2>&1; then
  [[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_warn "Invalid exemptLabels config, using default"
  EXEMPT_LABELS='["pinned", "keep"]'
fi


# Track if --exclude-labels was applied for output
EXCLUDE_LABELS_APPLIED=false

# Merge CLI --exclude-labels with config exemptLabels
if [[ -n "$EXCLUDE_LABELS" ]]; then
  EXCLUDE_LABELS_APPLIED=true
  # Parse comma-separated labels into JSON array (trim whitespace)
  CLI_LABELS=$(echo "$EXCLUDE_LABELS" | jq -R 'split(",") | map(gsub("^\\s+|\\s+$"; ""))')
  # Merge with config exemptLabels (deduplicate)
  EXEMPT_LABELS=$(echo "$EXEMPT_LABELS" "$CLI_LABELS" | jq -s 'add | unique')

  # Log the merge if not quiet and not JSON
  if [[ "$QUIET" != true && "$FORMAT" != "json" ]]; then
    CLI_LABELS_DISPLAY=$(echo "$CLI_LABELS" | jq -r 'join(", ")')
    log_info "Including additional exempt labels from CLI: $CLI_LABELS_DISPLAY"
    EFFECTIVE_LABELS_DISPLAY=$(echo "$EXEMPT_LABELS" | jq -r 'join(", ")')
    log_info "Effective exempt labels: [$EFFECTIVE_LABELS_DISPLAY]"
  fi
fi
# Load labelPolicies from config (v0.31.0+)
# Allows per-label retention rules:
#   {"security": {"daysUntilArchive": 30}, "temp": {"daysUntilArchive": 1}, "important": {"neverArchive": true}}
if declare -f get_config_value >/dev/null 2>&1; then
  LABEL_POLICIES=$(get_config_value "archive.labelPolicies" '{}')
else
  LABEL_POLICIES=$(jq -r '.archive.labelPolicies // {}' "$CONFIG_FILE")
fi

# Validate LABEL_POLICIES is valid JSON object, fallback to empty if not
if ! echo "$LABEL_POLICIES" | jq -e 'type == "object"' >/dev/null 2>&1; then
  [[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_warn "Invalid labelPolicies config, using empty"
  LABEL_POLICIES='{}'
fi

# Load relationship safety settings for --safe mode
if declare -f get_config_value >/dev/null 2>&1; then
  PREVENT_ORPHAN_CHILDREN=$(get_config_value "archive.relationshipSafety.preventOrphanChildren" "true")
  PREVENT_BROKEN_DEPS=$(get_config_value "archive.relationshipSafety.preventBrokenDependencies" "true")
else
  PREVENT_ORPHAN_CHILDREN=$(jq -r '.archive.relationshipSafety.preventOrphanChildren // true' "$CONFIG_FILE")
  PREVENT_BROKEN_DEPS=$(jq -r '.archive.relationshipSafety.preventBrokenDependencies // true' "$CONFIG_FILE")
fi

# Resolve SAFE_MODE: CLI override > config default
if [[ -z "$SAFE_MODE" ]]; then
  # No CLI override - use config values (safe if either setting is true)
  if [[ "$PREVENT_ORPHAN_CHILDREN" == "true" || "$PREVENT_BROKEN_DEPS" == "true" ]]; then
    SAFE_MODE=true
  else
    SAFE_MODE=false
  fi
fi

# Check if we have any label policies configured
if [[ "$LABEL_POLICIES" != "{}" ]]; then
  [[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_info "Label policies active: $(echo "$LABEL_POLICIES" | jq -r 'keys | join(", ")')"
fi

# Load phase trigger settings from config (v0.31.0+)
# Allows automatic phase-triggered archiving when a phase is marked complete
if declare -f get_config_value >/dev/null 2>&1; then
  PHASE_TRIGGERS_ENABLED=$(get_config_value "archive.phaseTriggers.enabled" "false")
  PHASE_TRIGGERS_PHASES=$(get_config_value "archive.phaseTriggers.phases" '[]')
  PHASE_TRIGGERS_PHASE_ONLY=$(get_config_value "archive.phaseTriggers.archivePhaseOnly" "true")
else
  PHASE_TRIGGERS_ENABLED=$(jq -r '.archive.phaseTriggers.enabled // false' "$CONFIG_FILE")
  PHASE_TRIGGERS_PHASES=$(jq -r '.archive.phaseTriggers.phases // []' "$CONFIG_FILE")
  PHASE_TRIGGERS_PHASE_ONLY=$(jq -r '.archive.phaseTriggers.archivePhaseOnly // true' "$CONFIG_FILE")
fi

# Apply SHOW_WARNINGS: CLI override > config default
if [[ -z "$SHOW_WARNINGS" ]]; then
  if declare -f get_config_value >/dev/null 2>&1; then
    SHOW_WARNINGS=$(get_config_value "archive.interactive.showWarnings" "true")
  else
    SHOW_WARNINGS=$(jq -r '.archive.interactive.showWarnings // true' "$CONFIG_FILE")
  fi
fi

# Load interactive config (v0.31.0+)
# Config can enable interactive mode by default: archive.interactive.confirmBeforeArchive
CONFIRM_BEFORE_ARCHIVE="false"
if declare -f get_config_value >/dev/null 2>&1; then
  CONFIRM_BEFORE_ARCHIVE=$(get_config_value "archive.interactive.confirmBeforeArchive" "false")
else
  CONFIRM_BEFORE_ARCHIVE=$(jq -r '.archive.interactive.confirmBeforeArchive // false' "$CONFIG_FILE")
fi

# CLI --interactive flag overrides config
if [[ "$INTERACTIVE" == "true" ]]; then
  CONFIRM_BEFORE_ARCHIVE="true"
fi

# Skip interactive mode if not a terminal (non-TTY environments)
if [[ "$CONFIRM_BEFORE_ARCHIVE" == "true" && ! -t 0 ]]; then
  [[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_warn "Interactive mode requires a terminal, falling back to non-interactive"
  CONFIRM_BEFORE_ARCHIVE="false"
  INTERACTIVE=false
fi

[[ -n "$MAX_OVERRIDE" ]] && MAX_COMPLETED="$MAX_OVERRIDE"

if [[ "$QUIET" != true && "$FORMAT" != "json" ]]; then
  if [[ "$ARCHIVE_ALL" == true ]]; then
    log_warn "Mode: --all (bypassing retention AND preserve count)"
  elif [[ "$FORCE" == true ]]; then
    log_info "Mode: --force (bypassing retention, preserving $PRESERVE_COUNT recent)"
  else
    log_info "Config: daysUntilArchive=$DAYS_UNTIL_ARCHIVE, maxCompleted=$MAX_COMPLETED, preserve=$PRESERVE_COUNT"
  fi
fi

# Get completed tasks
COMPLETED_TASKS=$(jq '[.tasks[] | select(.status == "done")]' "$TODO_FILE")
COMPLETED_COUNT=$(echo "$COMPLETED_TASKS" | jq 'length')

[[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_info "Found $COMPLETED_COUNT completed tasks"

if [[ "$COMPLETED_COUNT" -eq 0 ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    # Get remaining task counts for JSON output
    REMAINING_TOTAL=$(jq '.tasks | length' "$TODO_FILE")
    REMAINING_PENDING=$(jq '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")
    REMAINING_ACTIVE=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
    REMAINING_BLOCKED=$(jq '[.tasks[] | select(.status == "blocked")] | length' "$TODO_FILE")
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build onlyLabelsFilter JSON (null if not specified)
    ONLY_LABELS_OUTPUT="null"
    [[ -n "$ONLY_LABELS" ]] && ONLY_LABELS_OUTPUT=$(echo "$ONLY_LABELS" | jq -R 'split(",") | map(gsub("^\\s+|\\s+$"; ""))')

    jq -n \
      --arg ts "$TIMESTAMP" \
      --arg ver "${CLEO_VERSION:-$(get_version)}" \
      --argjson total "$REMAINING_TOTAL" \
      --argjson pending "$REMAINING_PENDING" \
      --argjson active "$REMAINING_ACTIVE" \
      --argjson blocked "$REMAINING_BLOCKED" \
      --argjson excludeLabelsApplied "$EXCLUDE_LABELS_APPLIED" \
      --argjson effectiveExemptLabels "$EXEMPT_LABELS" \
      --argjson onlyLabelsFilter "$ONLY_LABELS_OUTPUT" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {"format": "json", "command": "archive", "timestamp": $ts, "version": $ver},
        "success": true,
        "archived": {"count": 0, "taskIds": []},
        "exempted": {"count": 0, "taskIds": []},
        "excludeLabelsApplied": $excludeLabelsApplied,
        "effectiveExemptLabels": $effectiveExemptLabels,
        "filters": {"onlyLabels": $onlyLabelsFilter, "excludeLabels": (if $excludeLabelsApplied then $effectiveExemptLabels else null end)},
        "remaining": {"total": $total, "pending": $pending, "active": $active, "blocked": $blocked}
      }'
  else
    log_info "No completed tasks to archive"
  fi
  exit "${EXIT_SUCCESS:-0}"
fi

# Calculate which tasks to archive
NOW=$(date +%s)
ARCHIVE_THRESHOLD=$((NOW - DAYS_UNTIL_ARCHIVE * 86400))

# First, identify tasks that would be exempted due to labels
# This is done separately to track exempted tasks for logging/output
EXEMPTED_TASKS=$(echo "$COMPLETED_TASKS" | jq --argjson exemptLabels "$EXEMPT_LABELS" '
  [.[] | select(
    (.labels // []) as $taskLabels |
    ($exemptLabels | any(. as $exempt | $taskLabels | index($exempt) | type == "number"))
  )]
')

EXEMPTED_COUNT=$(echo "$EXEMPTED_TASKS" | jq 'length')
EXEMPTED_IDS=$(echo "$EXEMPTED_TASKS" | jq '[.[].id]')

# Log exempted tasks if any
if [[ "$EXEMPTED_COUNT" -gt 0 && "$QUIET" != true && "$FORMAT" != "json" ]]; then
  echo "$EXEMPTED_TASKS" | jq -r --argjson exemptLabels "$EXEMPT_LABELS" '
    .[] |
    (.labels // []) as $taskLabels |
    ($exemptLabels | map(select(. as $exempt | $taskLabels | index($exempt) | type == "number")) | first) as $matchedLabel |
    "Skipping task \(.id): has exempt label \u0027\($matchedLabel)\u0027"
  ' | while read -r msg; do
    log_info "$msg"
  done
fi

# Apply --phase-complete filter: ONLY archive completed tasks from specified phase
# This runs BEFORE other filters to scope the archive operation to a single phase
if [[ -n "$PHASE_TRIGGER" ]]; then
  # Count tasks in phase before filtering for statistics
  PHASE_TASKS_COUNT=$(echo "$COMPLETED_TASKS" | jq --arg phase "$PHASE_TRIGGER" '
    [.[] | select(.phase == $phase)] | length
  ')

  # Filter to only tasks from the specified phase
  COMPLETED_TASKS=$(echo "$COMPLETED_TASKS" | jq --arg phase "$PHASE_TRIGGER" '
    [.[] | select(.phase == $phase)]
  ')

  # Update completed count after phase filtering
  COMPLETED_COUNT=$(echo "$COMPLETED_TASKS" | jq 'length')

  # Build phase trigger info for JSON output
  PHASE_TRIGGER_INFO=$(jq -n \
    --arg phase "$PHASE_TRIGGER" \
    --argjson tasksInPhase "$PHASE_TASKS_COUNT" \
    --argjson tasksAfterFilter "$COMPLETED_COUNT" \
    '{
      "enabled": true,
      "phase": $phase,
      "tasksInPhase": $tasksInPhase,
      "tasksAfterFilter": $tasksAfterFilter
    }'
  )

  [[ "$QUIET" != true && "$FORMAT" != "json" ]] && \
    log_info "Phase-triggered archive: filtering to phase '$PHASE_TRIGGER' ($COMPLETED_COUNT tasks)"

  # If no tasks in the specified phase, exit early with appropriate output
  if [[ "$COMPLETED_COUNT" -eq 0 ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      REMAINING_TOTAL=$(jq '.tasks | length' "$TODO_FILE")
      REMAINING_PENDING=$(jq '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")
      REMAINING_ACTIVE=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
      REMAINING_BLOCKED=$(jq '[.tasks[] | select(.status == "blocked")] | length' "$TODO_FILE")
      TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

      jq -n \
        --arg ts "$TIMESTAMP" \
        --arg ver "${CLEO_VERSION:-$(get_version)}" \
        --argjson total "$REMAINING_TOTAL" \
        --argjson pending "$REMAINING_PENDING" \
        --argjson active "$REMAINING_ACTIVE" \
        --argjson blocked "$REMAINING_BLOCKED" \
        --argjson phaseTrigger "$PHASE_TRIGGER_INFO" \
        --argjson excludeLabelsApplied "$EXCLUDE_LABELS_APPLIED" \
        --argjson effectiveExemptLabels "$EXEMPT_LABELS" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {"format": "json", "command": "archive", "timestamp": $ts, "version": $ver},
          "success": true,
          "archived": {"count": 0, "taskIds": []},
          "exempted": {"count": 0, "taskIds": []},
          "phaseTrigger": $phaseTrigger,
          "excludeLabelsApplied": $excludeLabelsApplied,
          "effectiveExemptLabels": $effectiveExemptLabels,
          "remaining": {"total": $total, "pending": $pending, "active": $active, "blocked": $blocked}
        }'
    else
      log_info "No completed tasks in phase '$PHASE_TRIGGER' to archive"
    fi
    exit "${EXIT_SUCCESS:-0}"
  fi
fi

# Apply --only-labels filter: ONLY archive tasks with specified labels
if [[ -n "$ONLY_LABELS" ]]; then
  ONLY_LABELS_JSON=$(echo "$ONLY_LABELS" | jq -R 'split(",") | map(gsub("^\\s+|\\s+$"; ""))')

  COMPLETED_TASKS=$(echo "$COMPLETED_TASKS" | jq --argjson onlyLabels "$ONLY_LABELS_JSON" '
    [.[] | select(
      (.labels // []) as $taskLabels |
      ($onlyLabels | any(. as $only | $taskLabels | index($only) | type == "number"))
    )]
  ')

  [[ "$QUIET" != true && "$FORMAT" != "json" ]] && \
    log_info "Filtered to tasks with labels: $(echo "$ONLY_LABELS_JSON" | jq -r 'join(", ")')"
fi

# Sort by completedAt (newest first) and determine which to archive
# Excludes tasks with exempt labels and applies per-label retention policies
TASKS_TO_ARCHIVE=$(echo "$COMPLETED_TASKS" | jq \
  --argjson threshold "$ARCHIVE_THRESHOLD" \
  --argjson preserve "$PRESERVE_COUNT" \
  --argjson force "$FORCE" \
  --argjson all "$ARCHIVE_ALL" \
  --argjson exemptLabels "$EXEMPT_LABELS" \
  --argjson labelPolicies "$LABEL_POLICIES" \
  --argjson defaultDays "$DAYS_UNTIL_ARCHIVE" \
  --argjson now "$NOW" \
  '
  # Helper function to check if a task passes label policy retention check
  def check_label_policy($labels; $policies; $defaultDays; $completedAt; $now):
    # Check if any label has neverArchive: true
    if ($labels | any(. as $l | $policies[$l].neverArchive == true)) then
      false  # Never archive this task
    else
      # Find the longest retention period from all task labels
      ([$labels[] | $policies[.].daysUntilArchive // null] | map(select(. != null)) | max // $defaultDays) as $effectiveDays |
      # Check if task is old enough based on effective retention
      (($completedAt | fromdateiso8601) + ($effectiveDays * 86400)) < $now
    end;

  # First filter out exempt tasks (tasks with any label in exemptLabels)
  [.[] |
    (.labels // []) as $taskLabels |
    if ($taskLabels | any(. as $label | $exemptLabels | index($label) | type == "number"))
    then empty
    # Also filter out tasks with neverArchive labels (from labelPolicies)
    elif ($taskLabels | any(. as $l | $labelPolicies[$l].neverArchive == true))
    then empty
    else .
    end
  ] |
  # Then apply normal archive logic with per-label retention
  sort_by(.completedAt) | reverse |
  to_entries |
  map(select(
    if $all then
      true  # Archive ALL completed tasks (except exempt and neverArchive)
    elif $force then
      .key >= $preserve  # Bypass retention, respect preserve count
    else
      # Apply per-label retention policy or default threshold
      (.value.labels // []) as $taskLabels |
      .key >= $preserve and
      check_label_policy($taskLabels; $labelPolicies; $defaultDays; .value.completedAt; $now)
    end
  )) |
  map(.value)
')

ARCHIVE_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq 'length')

# Idempotency check: Filter out tasks that are already in the archive
# Per spec Part 5.6: Re-archiving already-archived tasks is a no-op
ARCHIVED_IDS=$(jq '[.archivedTasks[].id]' "$ARCHIVE_FILE" 2>/dev/null || echo '[]')
ALREADY_ARCHIVED_IDS='[]'
ALREADY_ARCHIVED_COUNT=0

if [[ "$ARCHIVE_COUNT" -gt 0 ]]; then
  CANDIDATE_IDS=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[].id]')
  ALREADY_ARCHIVED_IDS=$(echo "$CANDIDATE_IDS" "$ARCHIVED_IDS" | jq -s '
    .[0] as $candidates | .[1] as $existing |
    [$candidates[] | select(. as $id | $existing | index($id))]
  ')
  ALREADY_ARCHIVED_COUNT=$(echo "$ALREADY_ARCHIVED_IDS" | jq 'length')

  if [[ "$ALREADY_ARCHIVED_COUNT" -gt 0 ]]; then
    # Filter out already-archived tasks
    TASKS_TO_ARCHIVE=$(echo "$TASKS_TO_ARCHIVE" | jq --argjson alreadyArchived "$ALREADY_ARCHIVED_IDS" '
      [.[] | select(.id as $id | $alreadyArchived | index($id) | not)]
    ')
    ARCHIVE_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq 'length')

    if [[ "$QUIET" != true && "$FORMAT" != "json" ]]; then
      log_warn "Skipping $ALREADY_ARCHIVED_COUNT task(s) already in archive:"
      echo "$ALREADY_ARCHIVED_IDS" | jq -r '.[] | "  - \(.)"'
    fi
  fi
fi

# If ALL eligible tasks were already archived, return no-change (idempotent)
if [[ "$ARCHIVE_COUNT" -eq 0 && "$ALREADY_ARCHIVED_COUNT" -gt 0 ]]; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  REMAINING_TOTAL=$(jq '.tasks | length' "$TODO_FILE")
  REMAINING_PENDING=$(jq '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")
  REMAINING_ACTIVE=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
  REMAINING_BLOCKED=$(jq '[.tasks[] | select(.status == "blocked")] | length' "$TODO_FILE")

  if [[ "$FORMAT" == "json" ]]; then
    jq -n \
      --arg ts "$TIMESTAMP" \
      --arg ver "${CLEO_VERSION:-$(get_version)}" \
      --argjson tasksSkipped "$ALREADY_ARCHIVED_IDS" \
      --argjson total "$REMAINING_TOTAL" \
      --argjson pending "$REMAINING_PENDING" \
      --argjson active "$REMAINING_ACTIVE" \
      --argjson blocked "$REMAINING_BLOCKED" \
      --argjson excludeLabelsApplied "$EXCLUDE_LABELS_APPLIED" \
      --argjson effectiveExemptLabels "$EXEMPT_LABELS" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {"format": "json", "command": "archive", "timestamp": $ts, "version": $ver},
        "success": true,
        "noChange": true,
        "message": "All tasks already archived",
        "tasksSkipped": $tasksSkipped,
        "archived": {"count": 0, "taskIds": []},
        "excludeLabelsApplied": $excludeLabelsApplied,
        "effectiveExemptLabels": $effectiveExemptLabels,
        "remaining": {"total": $total, "pending": $pending, "active": $active, "blocked": $blocked}
      }'
  else
    [[ "$QUIET" != true ]] && log_info "No changes made - all eligible tasks already archived"
  fi
  exit "${EXIT_NO_CHANGE:-102}"
fi


# Cascade-from mode: Archive specific task and ALL its completed descendants
# This is different from --cascade: we start from a specified root task and include all descendants
if [[ -n "$CASCADE_FROM" ]]; then
  # NOTE: Using --slurpfile with process substitution to avoid "Argument list too long" error
  # when tasks array exceeds ARG_MAX (~128KB-2MB)

  # Recursively find all descendants (children, grandchildren, etc.)
  ALL_DESCENDANTS=$(jq --arg rootId "$CASCADE_FROM" --slurpfile tasks <(jq '.tasks' "$TODO_FILE") '
    # Recursive function to find all descendants (slurpfile wraps in array, use [0])
    def descendants($id):
      [$tasks[0][] | select(.parentId == $id) | .id] as $children |
      if ($children | length) == 0 then []
      else $children + ([$children[] | descendants(.)] | flatten)
      end;

    # Include root task plus all descendants
    [$rootId] + descendants($rootId) | unique
  ' <<< 'null')

  TOTAL_DESCENDANTS=$(echo "$ALL_DESCENDANTS" | jq 'length - 1')  # Exclude root from count

  # Get completed descendants only (filter to status=="done")
  # Note: We must explicitly filter for done status since ALL_DESCENDANTS includes all descendants
  COMPLETED_DESCENDANTS=$(jq --argjson ids "$ALL_DESCENDANTS" '
    [.tasks[] | select(.id as $id | $ids | index($id)) | select(.status == "done")]
  ' "$TODO_FILE")

  COMPLETED_COUNT=$(echo "$COMPLETED_DESCENDANTS" | jq 'length')

  # Get incomplete descendants for warning
  INCOMPLETE_DESCENDANTS=$(jq --argjson ids "$ALL_DESCENDANTS" '
    [.tasks[] | select(.id as $id | $ids | index($id)) | select(.status != "done")]
  ' "$TODO_FILE")

  INCOMPLETE_COUNT=$(echo "$INCOMPLETE_DESCENDANTS" | jq 'length')

  # Warn about incomplete descendants
  if [[ "$INCOMPLETE_COUNT" -gt 0 && "$QUIET" != true && "$FORMAT" != "json" ]]; then
    log_warn "$INCOMPLETE_COUNT descendants are not completed and will NOT be archived:"
    echo "$INCOMPLETE_DESCENDANTS" | jq -r '.[] | "  - \(.id): \(.title) [\(.status)]"'
  fi

  # Replace TASKS_TO_ARCHIVE with the completed descendants
  # This bypasses normal retention rules since we explicitly requested this cascade
  TASKS_TO_ARCHIVE="$COMPLETED_DESCENDANTS"
  ARCHIVE_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq 'length')

  # Build cascade-from info for JSON output
  CASCADE_FROM_INFO=$(jq -n \
    --arg rootTask "$CASCADE_FROM" \
    --argjson totalDescendants "$TOTAL_DESCENDANTS" \
    --argjson completedDescendants "$((COMPLETED_COUNT - 1))" \
    --argjson incompleteDescendants "$INCOMPLETE_COUNT" \
    '{
      "rootTask": $rootTask,
      "totalDescendants": $totalDescendants,
      "completedDescendants": $completedDescendants,
      "incompleteDescendants": $incompleteDescendants
    }'
  )

  [[ "$QUIET" != true && "$FORMAT" != "json" ]] && \
    log_info "Cascade from $CASCADE_FROM: archiving $ARCHIVE_COUNT tasks ($TOTAL_DESCENDANTS descendants, $INCOMPLETE_COUNT incomplete)"
fi

# Cascade mode: Archive completed parents with all completed children together
# This runs BEFORE safe mode so cascaded families bypass the orphan check
if [[ "$CASCADE_ARCHIVE" == "true" && "$ARCHIVE_COUNT" -gt 0 ]]; then
  # Get all tasks for cascade analysis
  ALL_TASKS=$(jq '.tasks' "$TODO_FILE")
  CANDIDATE_IDS_FOR_CASCADE=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[].id]')

  # Find completed parent tasks in our archive candidates that have children
  # A "cascadable family" requires:
  # 1. Parent is in TASKS_TO_ARCHIVE (completed and eligible)
  # 2. ALL children of that parent are also status=done
  CASCADE_RESULT=$(jq -n \
    --argjson tasks "$ALL_TASKS" \
    --argjson candidates "$CANDIDATE_IDS_FOR_CASCADE" \
    '
    # Find parent IDs that are candidates for archive
    ($tasks | map(select(.id as $id | $candidates | index($id))) | map(select(.parentId == null or .parentId == "null"))) as $rootCandidates |

    # For each potential parent in candidates, check if ALL its children are done
    [
      $tasks[] |
      select(.id as $id | $candidates | index($id)) |
      . as $parent |
      # Find all children of this parent
      [$tasks[] | select(.parentId == $parent.id)] as $children |
      select($children | length > 0) |  # Only parents with children
      {
        parent: $parent.id,
        children: [$children[].id],
        allChildrenDone: ([$children[] | .status == "done"] | all),
        doneChildren: [$children[] | select(.status == "done") | .id],
        notDoneChildren: [$children[] | select(.status != "done") | .id]
      }
    ] |
    # Separate complete families from incomplete ones
    {
      completeFamilies: [.[] | select(.allChildrenDone)],
      incompleteFamilies: [.[] | select(.allChildrenDone | not)]
    }
    '
  )

  COMPLETE_FAMILIES=$(echo "$CASCADE_RESULT" | jq '.completeFamilies')
  INCOMPLETE_FAMILIES=$(echo "$CASCADE_RESULT" | jq '.incompleteFamilies')
  COMPLETE_FAMILY_COUNT=$(echo "$COMPLETE_FAMILIES" | jq 'length')
  INCOMPLETE_FAMILY_COUNT=$(echo "$INCOMPLETE_FAMILIES" | jq 'length')

  # Process complete families - ensure all children are added to archive list
  if [[ "$COMPLETE_FAMILY_COUNT" -gt 0 ]]; then
    CASCADE_APPLIED=true
    CASCADED_FAMILIES="$COMPLETE_FAMILIES"

    # Get all children IDs from complete families that need to be added
    CHILDREN_TO_ADD=$(echo "$COMPLETE_FAMILIES" | jq '[.[].children[]] | unique')

    # Add children to archive list if not already there
    TASKS_TO_ARCHIVE=$(jq -n \
      --argjson current "$TASKS_TO_ARCHIVE" \
      --argjson allTasks "$ALL_TASKS" \
      --argjson childrenIds "$CHILDREN_TO_ADD" \
      '
      # Get current archive IDs
      [$current[].id] as $currentIds |
      # Find children not yet in archive list
      [$allTasks[] | select(.id as $id | ($childrenIds | index($id)) and ($currentIds | index($id) | not))] as $newChildren |
      # Combine
      $current + $newChildren
      '
    )

    if [[ "$QUIET" != true && "$FORMAT" != "json" ]]; then
      log_info "Cascade mode: $COMPLETE_FAMILY_COUNT complete family/families will be archived together"
      echo "$COMPLETE_FAMILIES" | jq -r '.[] | "  - Parent \(.parent) with children: \(.children | join(", "))"'
    fi
  fi

  # Warn about incomplete families
  if [[ "$INCOMPLETE_FAMILY_COUNT" -gt 0 && "$QUIET" != true && "$FORMAT" != "json" ]]; then
    log_warn "Cascade mode: $INCOMPLETE_FAMILY_COUNT family/families skipped (incomplete children)"
    echo "$INCOMPLETE_FAMILIES" | jq -r '.[] | "  - Parent \(.parent): not done children: \(.notDoneChildren | join(", "))"'
  fi

  # Update archive count after cascade additions
  ARCHIVE_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq 'length')
fi

# Safe mode: Block archiving tasks that would orphan children or break dependencies
if [[ "$SAFE_MODE" == "true" && "$ARCHIVE_COUNT" -gt 0 ]]; then
  # Get IDs of tasks we're considering for archive
  CANDIDATE_IDS=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[].id]')

  # For cascade-from mode, incomplete descendants are intentionally left behind
  # so we should NOT block the parent from being archived due to those children
  CASCADE_FROM_DESCENDANTS="${ALL_DESCENDANTS:-[]}"

  # Check for active children that would be orphaned
  # Exclude cascade-from descendants since those are handled intentionally
  BLOCKED_BY_CHILDREN=$(jq --argjson candidateIds "$CANDIDATE_IDS" \
    --argjson cascadeDescendants "$CASCADE_FROM_DESCENDANTS" '
    [.tasks[] |
     select(.status != "done" and .parentId != null) |
     # Skip if this task is part of cascade-from hierarchy (intentionally left behind)
     select(.id as $id | $cascadeDescendants | index($id) | not) |
     select(.parentId as $p | $candidateIds | index($p)) |
     .parentId
    ] | unique
  ' "$TODO_FILE")

  CHILDREN_BLOCKED_COUNT=$(echo "$BLOCKED_BY_CHILDREN" | jq 'length')

  if [[ "$CHILDREN_BLOCKED_COUNT" -gt 0 ]]; then
    # Remove tasks with active children from archive candidates
    TASKS_TO_ARCHIVE=$(echo "$TASKS_TO_ARCHIVE" | jq --argjson blockedIds "$BLOCKED_BY_CHILDREN" '
      [.[] | select(.id as $id | $blockedIds | index($id) | not)]
    ')

    if [[ "$QUIET" != true && "$FORMAT" != "json" ]]; then
      log_warn "Safe mode: Skipping $CHILDREN_BLOCKED_COUNT task(s) with active children"
      echo "$BLOCKED_BY_CHILDREN" | jq -r '.[] | "  - \(.)"'
    fi
  fi

  # Recalculate candidate IDs after removing blocked parents
  CANDIDATE_IDS=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[].id]')

  # Check for active tasks that depend on archive candidates
  BLOCKED_BY_DEPENDENTS=$(jq --argjson candidateIds "$CANDIDATE_IDS" '
    [.tasks[] |
     select(.status != "done" and .depends != null and (.depends | length) > 0) |
     .depends | map(select(. as $d | $candidateIds | index($d)))
    ] | flatten | unique
  ' "$TODO_FILE")

  DEPS_BLOCKED_COUNT=$(echo "$BLOCKED_BY_DEPENDENTS" | jq 'length')

  if [[ "$DEPS_BLOCKED_COUNT" -gt 0 ]]; then
    # Remove tasks that have active dependents from archive candidates
    TASKS_TO_ARCHIVE=$(echo "$TASKS_TO_ARCHIVE" | jq --argjson blockedIds "$BLOCKED_BY_DEPENDENTS" '
      [.[] | select(.id as $id | $blockedIds | index($id) | not)]
    ')

    if [[ "$QUIET" != true && "$FORMAT" != "json" ]]; then
      log_warn "Safe mode: Skipping $DEPS_BLOCKED_COUNT task(s) with active dependents"
      echo "$BLOCKED_BY_DEPENDENTS" | jq -r '.[] | "  - \(.)"'
    fi
  fi

  # Update archive count after safe mode filtering
  ARCHIVE_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq 'length')
fi

# Collect warnings about relationship impacts (before archive operation)
# These warnings inform the user even when not blocking the operation
if [[ "$ARCHIVE_COUNT" -gt 0 ]]; then
  ARCHIVE_IDS_JSON=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[].id]')

  # Check for tasks with active children (would orphan them)
  ORPHAN_CHILDREN=$(jq --argjson archiveIds "$ARCHIVE_IDS_JSON" '
    [.tasks[] | select(.status != "done" and .parentId != null) |
     select(.parentId as $p | $archiveIds | index($p))]
  ' "$TODO_FILE")

  if [[ $(echo "$ORPHAN_CHILDREN" | jq 'length') -gt 0 ]]; then
    while IFS= read -r child; do
      parentId=$(echo "$child" | jq -r '.parentId')
      childId=$(echo "$child" | jq -r '.id')
      ARCHIVE_WARNINGS+=("Task $childId will lose parent $parentId (active child)")
    done < <(echo "$ORPHAN_CHILDREN" | jq -c '.[]')
  fi

  # Check for broken dependencies (tasks depending on archiving tasks)
  BROKEN_DEPS=$(jq --argjson archiveIds "$ARCHIVE_IDS_JSON" '
    [.tasks[] | select(.status != "done" and .depends != null) |
     {id: .id, brokenDeps: [.depends[] | select(. as $d | $archiveIds | index($d))]}
     | select(.brokenDeps | length > 0)]
  ' "$TODO_FILE")

  if [[ $(echo "$BROKEN_DEPS" | jq 'length') -gt 0 ]]; then
    while IFS= read -r dep; do
      taskId=$(echo "$dep" | jq -r '.id')
      broken=$(echo "$dep" | jq -r '.brokenDeps | join(", ")')
      ARCHIVE_WARNINGS+=("Task $taskId depends on archiving tasks: $broken")
    done < <(echo "$BROKEN_DEPS" | jq -c '.[]')
  fi

  # Build JSON array of warnings for output
  if [[ ${#ARCHIVE_WARNINGS[@]} -gt 0 ]]; then
    WARNINGS_JSON=$(printf '%s\n' "${ARCHIVE_WARNINGS[@]}" | jq -R . | jq -s .)
  fi

  # Display warnings if enabled and not in quiet mode
  if [[ "$SHOW_WARNINGS" == "true" && ${#ARCHIVE_WARNINGS[@]} -gt 0 && "$QUIET" != true && "$FORMAT" != "json" ]]; then
    echo ""
    log_warn "Archive will affect task relationships:"
    for warning in "${ARCHIVE_WARNINGS[@]}"; do
      echo "  - $warning"
    done
    echo ""
  fi
fi

if [[ "$ARCHIVE_COUNT" -eq 0 ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    # Get remaining task counts for JSON output
    REMAINING_TOTAL=$(jq '.tasks | length' "$TODO_FILE")
    REMAINING_PENDING=$(jq '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")
    REMAINING_ACTIVE=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
    REMAINING_BLOCKED=$(jq '[.tasks[] | select(.status == "blocked")] | length' "$TODO_FILE")
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build onlyLabelsFilter JSON (null if not specified)
    ONLY_LABELS_OUTPUT="null"
    [[ -n "$ONLY_LABELS" ]] && ONLY_LABELS_OUTPUT="$ONLY_LABELS_JSON"

    jq -n \
      --arg ts "$TIMESTAMP" \
      --arg ver "${CLEO_VERSION:-$(get_version)}" \
      --argjson total "$REMAINING_TOTAL" \
      --argjson pending "$REMAINING_PENDING" \
      --argjson active "$REMAINING_ACTIVE" \
      --argjson blocked "$REMAINING_BLOCKED" \
      --argjson excludeLabelsApplied "$EXCLUDE_LABELS_APPLIED" \
      --argjson effectiveExemptLabels "$EXEMPT_LABELS" \
      --argjson exemptedCount "$EXEMPTED_COUNT" \
      --argjson exemptedIds "$EXEMPTED_IDS" \
      --argjson warnings "$WARNINGS_JSON" \
      --argjson onlyLabelsFilter "$ONLY_LABELS_OUTPUT" \
      --argjson safeMode "$SAFE_MODE" \
      --argjson blockedByChildren "$BLOCKED_BY_CHILDREN" \
      --argjson blockedByDependents "$BLOCKED_BY_DEPENDENTS" \
      --argjson cascadeApplied "$CASCADE_APPLIED" \
      --argjson cascadedFamilies "$CASCADED_FAMILIES" \
      --argjson cascadeFrom "$CASCADE_FROM_INFO" \
      --argjson phaseTrigger "$PHASE_TRIGGER_INFO" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {"format": "json", "command": "archive", "timestamp": $ts, "version": $ver},
        "success": true,
        "safeMode": $safeMode,
        "cascadeApplied": $cascadeApplied,
        "cascadedFamilies": $cascadedFamilies,
        "cascadeFrom": $cascadeFrom,
        "phaseTrigger": $phaseTrigger,
        "archived": {"count": 0, "taskIds": []},
        "exempted": {"count": $exemptedCount, "taskIds": $exemptedIds},
        "blockedByRelationships": {"byChildren": $blockedByChildren, "byDependents": $blockedByDependents},
        "excludeLabelsApplied": $excludeLabelsApplied,
        "effectiveExemptLabels": $effectiveExemptLabels,
        "filters": {"onlyLabels": $onlyLabelsFilter, "excludeLabels": (if $excludeLabelsApplied then $effectiveExemptLabels else null end)},
        "warnings": $warnings,
        "warningCount": ($warnings | length),
        "remaining": {"total": $total, "pending": $pending, "active": $active, "blocked": $blocked}
      }'
  elif [[ "$QUIET" != true ]]; then
    log_info "No tasks eligible for archiving (all within retention period or preserved)"
  fi
  exit "${EXIT_SUCCESS:-0}"
fi

[[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_info "Tasks to archive: $ARCHIVE_COUNT"

# Interactive mode: Review each task before archiving
# Only applies if confirmBeforeArchive is true, not in dry-run mode, and text output
if [[ "$CONFIRM_BEFORE_ARCHIVE" == "true" && "$DRY_RUN" != "true" && "$FORMAT" != "json" ]]; then
  APPROVED_TASKS='[]'
  SKIPPED_TASKS='[]'

  echo ""
  echo "Interactive Archive Mode - Review each task:"
  echo "  (y)es to archive, (n)o to skip, (a)ll remaining, (q)uit"
  echo ""

  ARCHIVE_ALL_REMAINING=false

  while IFS= read -r task; do
    if [[ "$ARCHIVE_ALL_REMAINING" == "true" ]]; then
      APPROVED_TASKS=$(echo "$APPROVED_TASKS" | jq --argjson task "$task" '. + [$task]')
      INTERACTIVE_APPROVED=$((INTERACTIVE_APPROVED + 1))
      continue
    fi

    TASK_ID=$(echo "$task" | jq -r '.id')
    TASK_TITLE=$(echo "$task" | jq -r '.title')
    TASK_COMPLETED=$(echo "$task" | jq -r '.completedAt // "unknown"')
    TASK_LABELS=$(echo "$task" | jq -r '(.labels // []) | join(", ")')

    echo "Task: $TASK_ID - $TASK_TITLE"
    echo "  Completed: $TASK_COMPLETED"
    [[ -n "$TASK_LABELS" ]] && echo "  Labels: $TASK_LABELS"

    read -p "Archive this task? [y/n/a/q]: " -n 1 -r REPLY
    echo ""

    case "$REPLY" in
      y|Y)
        APPROVED_TASKS=$(echo "$APPROVED_TASKS" | jq --argjson task "$task" '. + [$task]')
        INTERACTIVE_APPROVED=$((INTERACTIVE_APPROVED + 1))
        ;;
      n|N)
        SKIPPED_TASKS=$(echo "$SKIPPED_TASKS" | jq --argjson task "$task" '. + [$task]')
        INTERACTIVE_SKIPPED=$((INTERACTIVE_SKIPPED + 1))
        ;;
      a|A)
        ARCHIVE_ALL_REMAINING=true
        APPROVED_TASKS=$(echo "$APPROVED_TASKS" | jq --argjson task "$task" '. + [$task]')
        INTERACTIVE_APPROVED=$((INTERACTIVE_APPROVED + 1))
        ;;
      q|Q)
        log_info "Archive cancelled by user"
        exit "${EXIT_SUCCESS:-0}"
        ;;
      *)
        # Default to skip for any other input
        SKIPPED_TASKS=$(echo "$SKIPPED_TASKS" | jq --argjson task "$task" '. + [$task]')
        INTERACTIVE_SKIPPED=$((INTERACTIVE_SKIPPED + 1))
        ;;
    esac
  done < <(echo "$TASKS_TO_ARCHIVE" | jq -c '.[]')

  # Update TASKS_TO_ARCHIVE with only approved tasks
  TASKS_TO_ARCHIVE="$APPROVED_TASKS"
  ARCHIVE_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq 'length')

  echo ""
  log_info "Approved: $INTERACTIVE_APPROVED tasks, Skipped: $INTERACTIVE_SKIPPED tasks"

  # If no tasks were approved, exit early
  if [[ "$ARCHIVE_COUNT" -eq 0 ]]; then
    log_info "No tasks approved for archiving"
    exit "${EXIT_SUCCESS:-0}"
  fi
fi


if [[ "$DRY_RUN" == true ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    # Get remaining task counts for JSON output (would-be state after archive)
    REMAINING_TOTAL=$(jq '.tasks | length' "$TODO_FILE")
    REMAINING_AFTER=$((REMAINING_TOTAL - ARCHIVE_COUNT))
    REMAINING_PENDING=$(jq '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")
    REMAINING_ACTIVE=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
    REMAINING_BLOCKED=$(jq '[.tasks[] | select(.status == "blocked")] | length' "$TODO_FILE")
    ARCHIVE_IDS_JSON=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[].id]')
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build onlyLabelsFilter JSON (null if not specified)
    ONLY_LABELS_OUTPUT="null"
    [[ -n "$ONLY_LABELS" ]] && ONLY_LABELS_OUTPUT="$ONLY_LABELS_JSON"

    jq -n \
      --arg ts "$TIMESTAMP" \
      --arg ver "${CLEO_VERSION:-$(get_version)}" \
      --argjson count "$ARCHIVE_COUNT" \
      --argjson ids "$ARCHIVE_IDS_JSON" \
      --argjson total "$REMAINING_AFTER" \
      --argjson pending "$REMAINING_PENDING" \
      --argjson active "$REMAINING_ACTIVE" \
      --argjson blocked "$REMAINING_BLOCKED" \
      --argjson excludeLabelsApplied "$EXCLUDE_LABELS_APPLIED" \
      --argjson effectiveExemptLabels "$EXEMPT_LABELS" \
      --argjson exemptedCount "$EXEMPTED_COUNT" \
      --argjson exemptedIds "$EXEMPTED_IDS" \
      --argjson warnings "$WARNINGS_JSON" \
      --argjson onlyLabelsFilter "$ONLY_LABELS_OUTPUT" \
      --argjson safeMode "$SAFE_MODE" \
      --argjson blockedByChildren "$BLOCKED_BY_CHILDREN" \
      --argjson blockedByDependents "$BLOCKED_BY_DEPENDENTS" \
      --argjson cascadeApplied "$CASCADE_APPLIED" \
      --argjson cascadedFamilies "$CASCADED_FAMILIES" \
      --argjson cascadeFrom "$CASCADE_FROM_INFO" \
      --argjson phaseTrigger "$PHASE_TRIGGER_INFO" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {"format": "json", "command": "archive", "timestamp": $ts, "version": $ver},
        "success": true,
        "dryRun": true,
        "wouldArchive": {"count": $count, "taskIds": $ids},
        "safeMode": $safeMode,
        "cascadeApplied": $cascadeApplied,
        "cascadedFamilies": $cascadedFamilies,
        "cascadeFrom": $cascadeFrom,
        "phaseTrigger": $phaseTrigger,
        "exempted": {"count": $exemptedCount, "taskIds": $exemptedIds},
        "blockedByRelationships": {"byChildren": $blockedByChildren, "byDependents": $blockedByDependents},
        "excludeLabelsApplied": $excludeLabelsApplied,
        "effectiveExemptLabels": $effectiveExemptLabels,
        "filters": {"onlyLabels": $onlyLabelsFilter, "excludeLabels": (if $excludeLabelsApplied then $effectiveExemptLabels else null end)},
        "warnings": $warnings,
        "warningCount": ($warnings | length),
        "remaining": {"total": $total, "pending": $pending, "active": $active, "blocked": $blocked}
      }'
  else
    echo ""
    echo "DRY RUN - Would archive these tasks:"
    echo "$TASKS_TO_ARCHIVE" | jq -r '.[] | "  - \(.id): \(.title)"'
    if [[ "$EXEMPTED_COUNT" -gt 0 ]]; then
      echo ""
      echo "Exempted tasks (protected by labels):"
      echo "$EXEMPTED_TASKS" | jq -r '.[] | "  - \(.id): \(.title) [\(.labels | join(", "))]"'
    fi
    # Show cascade information in dry-run text output
    if [[ "$CASCADE_APPLIED" == "true" ]]; then
      echo ""
      echo "Cascade families to archive together:"
      echo "$CASCADED_FAMILIES" | jq -r '.[] | "  - Parent \(.parent) with children: \(.children | join(", "))"'
    fi
    # Show cascade-from information in dry-run text output
    if [[ -n "$CASCADE_FROM" ]]; then
      echo ""
      echo "Cascade from $CASCADE_FROM:"
      echo "  Root task: $CASCADE_FROM"
      echo "  Total descendants: $(echo "$CASCADE_FROM_INFO" | jq -r '.totalDescendants')"
      echo "  Completed (to archive): $(echo "$CASCADE_FROM_INFO" | jq -r '.completedDescendants + 1') (including root)"
      echo "  Incomplete (skipped): $(echo "$CASCADE_FROM_INFO" | jq -r '.incompleteDescendants')"
    fi
    echo ""
    echo "No changes made."
  fi
  exit "${EXIT_SUCCESS:-0}"
fi

# Get task IDs to archive
ARCHIVE_IDS=$(echo "$TASKS_TO_ARCHIVE" | jq -r '.[].id')
ARCHIVE_IDS_ARRAY=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[].id]')

# Add archive metadata to tasks
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION_ID=$(jq -r '._meta.activeSession // "system"' "$TODO_FILE")

# Determine archive source based on CLI flags
if [[ "$ARCHIVE_ALL" == "true" ]]; then
  ARCHIVE_SOURCE="all"
elif [[ "$FORCE" == "true" ]]; then
  ARCHIVE_SOURCE="force"
elif [[ -n "$PHASE_TRIGGER" ]]; then
  ARCHIVE_SOURCE="phase-trigger"
elif [[ -n "$CASCADE_FROM" ]]; then
  ARCHIVE_SOURCE="cascade-from"
elif [[ -n "$ONLY_LABELS" ]]; then
  ARCHIVE_SOURCE="manual"
else
  ARCHIVE_SOURCE="auto"
fi

# Override: --phase-complete takes precedence over --all
if [[ -n "${PHASE_TRIGGER:-}" ]]; then
  ARCHIVE_SOURCE='phase-trigger'
fi

# Build trigger details JSON
TRIGGER_DETAILS=$(jq -n \
  --arg configRule "daysUntilArchive=$DAYS_UNTIL_ARCHIVE" \
  '{
    "configRule": $configRule
  }'
)

# Add phase trigger info to trigger details if applicable
if [[ -n "$PHASE_TRIGGER" ]]; then
  TRIGGER_DETAILS=$(echo "$TRIGGER_DETAILS" | jq --arg phase "$PHASE_TRIGGER" '. + {phase: $phase}')
fi

# Capture relationship state for each task being archived
# Get all tasks to check relationships
ALL_TASKS=$(jq '.tasks' "$TODO_FILE")

# Build relationship state data: which tasks have children, which have dependents
# Children: tasks where parentId matches an archiving task's ID
CHILDREN_BY_PARENT=$(echo "$ALL_TASKS" | jq --argjson archiveIds "$ARCHIVE_IDS_ARRAY" '
  [.[] | select(.parentId != null) | {parentId: .parentId, childId: .id}] |
  group_by(.parentId) |
  map({key: .[0].parentId, value: [.[].childId]}) |
  from_entries
')

# Dependents: tasks that depend on archiving tasks
DEPENDENTS_BY_TASK=$(echo "$ALL_TASKS" | jq --argjson archiveIds "$ARCHIVE_IDS_ARRAY" '
  [.[] | select(.depends != null and (.depends | length) > 0) |
   .id as $taskId | .depends[] | select(. as $d | $archiveIds | index($d)) |
   {dependencyId: ., dependentId: $taskId}
  ] |
  group_by(.dependencyId) |
  map({key: .[0].dependencyId, value: [.[].dependentId]}) |
  from_entries
')

# Generate enhanced metadata for each task
TASKS_WITH_METADATA=$(echo "$TASKS_TO_ARCHIVE" | jq \
  --arg ts "$TIMESTAMP" \
  --arg sid "$SESSION_ID" \
  --arg source "$ARCHIVE_SOURCE" \
  --argjson trigger "$TRIGGER_DETAILS" \
  --argjson childrenByParent "$CHILDREN_BY_PARENT" \
  --argjson dependentsByTask "$DEPENDENTS_BY_TASK" \
  --argjson labelPolicies "$LABEL_POLICIES" \
  '
  map(
    # Determine reason based on labels and policies
    ((.labels // []) | any(. as $l | $labelPolicies[$l].daysUntilArchive != null)) as $hasLabelPolicy |

    . + {
      "_archive": {
        "archivedAt": $ts,
        "reason": (
          if $hasLabelPolicy then "label-policy"
          elif $source == "force" then "force"
          elif $source == "all" then "force"
          elif $source == "manual" then "manual"
          else "auto"
          end
        ),
        "archiveSource": $source,
        "sessionId": $sid,
        "cycleTimeDays": (
          if .completedAt and .createdAt then
            (((.completedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)) / 86400 | floor)
          else null end
        ),
        "triggerDetails": (
          $trigger |
          # Add label policy info if applicable
          if $hasLabelPolicy then
            . + {"labelPolicy": ((.labels // []) | map(select($labelPolicies[.] != null)) | first // null)}
          else . end
        ),
        "relationshipState": {
          "hadChildren": (($childrenByParent[.id] // []) | length > 0),
          "childIds": ($childrenByParent[.id] // []),
          "hadDependents": (($dependentsByTask[.id] // []) | length > 0),
          "dependentIds": ($dependentsByTask[.id] // []),
          "parentId": (.parentId // null)
        },
        "restoreInfo": {
          "originalStatus": .status,
          "canRestore": true,
          "restoreBlockers": []
        }
      }
    }
  )
')

# ATOMIC TRANSACTION: Generate all temp files, validate, then commit
# This prevents partial writes that corrupt JSON files

ARCHIVE_TMP="${ARCHIVE_FILE}.tmp"
TODO_TMP="${TODO_FILE}.tmp"
LOG_TMP="${LOG_FILE}.tmp"

# Cleanup function for rollback on failure
cleanup_temp_files() {
  rm -f "$ARCHIVE_TMP" "$TODO_TMP" "$LOG_TMP"
}

# Trap to ensure cleanup on error
trap cleanup_temp_files EXIT

# Step 1: Generate archive file update with full statistics
# NOTE: Using --slurpfile with process substitution instead of --argjson to avoid
# "Argument list too long" error when tasks array exceeds ARG_MAX (~128KB-2MB)
if ! jq --slurpfile tasks <(echo "$TASKS_WITH_METADATA") --arg ts "$TIMESTAMP" '
  # Add tasks to archive (slurpfile wraps in array, so use [0])
  .archivedTasks += $tasks[0] |
  ._meta.totalArchived += ($tasks[0] | length) |
  ._meta.lastArchived = $ts |
  ._meta.newestTask = ($tasks[0] | max_by(.completedAt) | .completedAt) |
  ._meta.oldestTask = (if ._meta.oldestTask then ._meta.oldestTask else ($tasks[0] | min_by(.completedAt) | .completedAt) end) |

  # Update statistics.byPhase with counts
  .statistics.byPhase = (
    [.archivedTasks[].phase // "no-phase"] | group_by(.) |
    map({key: .[0], value: length}) | from_entries
  ) |

  # Update statistics.byPriority with counts
  # Note: Filter out null priorities to avoid using null as object key in from_entries
  .statistics.byPriority = (
    {critical: 0, high: 0, medium: 0, low: 0} +
    ([.archivedTasks[].priority | select(. != null)] | group_by(.) |
     map({key: .[0], value: length}) | from_entries)
  ) |

  # Update statistics.byLabel with counts
  .statistics.byLabel = (
    [.archivedTasks[].labels // [] | .[]] | group_by(.) |
    map({key: .[0], value: length}) | from_entries
  ) |

  # Calculate averageCycleTime from _archive.cycleTimeDays
  .statistics.averageCycleTime = (
    [.archivedTasks[] | ._archive.cycleTimeDays // empty] |
    if length > 0 then (add / length | . * 100 | floor / 100) else null end
  ) |

  # Update phaseSummary with detailed phase statistics
  # Note: Map phase to string before grouping to handle null phases correctly
  # The .phase field can be null, which cannot be used as an object key in from_entries
  # Filter out null phases from phaseSummary to avoid jq error with null object keys
  .phaseSummary = (
    [.archivedTasks[] | select(.phase != null) | . + {_phaseKey: .phase}] |
    group_by(._phaseKey) |
    map({
      key: .[0]._phaseKey,
      value: {
        totalTasks: length,
        firstCompleted: (map(.completedAt // empty) | sort | first // null),
        lastCompleted: (map(.completedAt // empty) | sort | last // null)
      }
    }) | from_entries
  )
' "$ARCHIVE_FILE" > "$ARCHIVE_TMP"; then
  if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
    output_error "E_FILE_WRITE_ERROR" "Failed to generate archive update" "${EXIT_FILE_ERROR:-3}" false
  else
    log_error "Failed to generate archive update"
  fi
  exit "${EXIT_FILE_ERROR:-3}"
fi

# Step 2: Remove archived tasks from todo.json and clean up orphaned dependencies
REMAINING_TASKS=$(jq --argjson ids "$(echo "$ARCHIVE_IDS" | jq -R . | jq -s .)" '
  .tasks |
  map(select(.id as $id | $ids | index($id) | not)) |
  map(
    if .depends then
      .depends = (.depends | map(select(. as $d | $ids | index($d) | not)))
    else . end
  ) |
  map(if .depends and (.depends | length == 0) then del(.depends) else . end)
' "$TODO_FILE")

NEW_CHECKSUM=$(echo "$REMAINING_TASKS" | jq -c '.' | sha256sum | cut -c1-16)

# NOTE: Using --slurpfile with process substitution to avoid ARG_MAX limit
if ! jq --slurpfile tasks <(echo "$REMAINING_TASKS") --arg checksum "$NEW_CHECKSUM" --arg ts "$TIMESTAMP" '
  .tasks = $tasks[0] |
  ._meta.checksum = $checksum |
  .lastUpdated = $ts
' "$TODO_FILE" > "$TODO_TMP"; then
  if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
    output_error "E_FILE_WRITE_ERROR" "Failed to generate todo update" "${EXIT_FILE_ERROR:-3}" false
  else
    log_error "Failed to generate todo update"
  fi
  exit "${EXIT_FILE_ERROR:-3}"
fi

# Step 3: Generate log entry
if [[ -f "$LOG_FILE" ]]; then
  LOG_ID="log_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 12)"
  if ! jq --arg id "$LOG_ID" --arg ts "$TIMESTAMP" --arg sid "$SESSION_ID" --argjson count "$ARCHIVE_COUNT" --argjson ids "$(echo "$ARCHIVE_IDS" | jq -R . | jq -s .)" '
    .entries += [{
      "id": $id,
      "timestamp": $ts,
      "sessionId": $sid,
      "action": "task_archived",
      "actor": "system",
      "taskId": null,
      "before": null,
      "after": null,
      "details": {"count": $count, "taskIds": $ids}
    }] |
    ._meta.totalEntries += 1 |
    ._meta.lastEntry = $ts
  ' "$LOG_FILE" > "$LOG_TMP"; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_FILE_WRITE_ERROR" "Failed to generate log update" "${EXIT_FILE_ERROR:-3}" false
    else
      log_error "Failed to generate log update"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
  fi
fi

# Step 4: Validate ALL generated JSON files before committing
for temp_file in "$ARCHIVE_TMP" "$TODO_TMP" ${LOG_TMP:+"$LOG_TMP"}; do
  if [[ ! -f "$temp_file" ]]; then
    continue
  fi

  if ! jq empty "$temp_file" 2>/dev/null; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_VALIDATION_SCHEMA" "Generated invalid JSON: $temp_file" "${EXIT_VALIDATION_ERROR:-6}" false
    else
      log_error "Generated invalid JSON: $temp_file"
      cat "$temp_file" >&2
    fi
    exit "${EXIT_VALIDATION_ERROR:-6}"
  fi
done

# Step 5: Create archive backup before committing changes using unified backup library
# Uses auto_backup_on_archive() which respects config setting backup.scheduled.onArchive
# Set CLEO_DIR for backup library to locate source files correctly
export CLEO_DIR="$(dirname "$TODO_FILE")"
if declare -f auto_backup_on_archive >/dev/null 2>&1; then
  BACKUP_PATH=$(auto_backup_on_archive "$CONFIG_FILE" 2>&1) || {
    [[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_warn "Backup library failed, using fallback backup method"
    # Fallback to inline backup if library fails
    BACKUP_SUFFIX=".backup.$(date +%s)"
    cp "$ARCHIVE_FILE" "${ARCHIVE_FILE}${BACKUP_SUFFIX}"
    cp "$TODO_FILE" "${TODO_FILE}${BACKUP_SUFFIX}"
    [[ -f "$LOG_FILE" ]] && cp "$LOG_FILE" "${LOG_FILE}${BACKUP_SUFFIX}"
  }
  if [[ -n "$BACKUP_PATH" && "$QUIET" != true && "$FORMAT" != "json" ]]; then
    log_info "Archive backup created: $BACKUP_PATH"
  fi
elif declare -f create_archive_backup >/dev/null 2>&1; then
  # Fallback to direct create_archive_backup if auto_backup_on_archive not available
  BACKUP_PATH=$(create_archive_backup 2>&1) || {
    [[ "$QUIET" != true && "$FORMAT" != "json" ]] && log_warn "Backup library failed, using fallback backup method"
    BACKUP_SUFFIX=".backup.$(date +%s)"
    cp "$ARCHIVE_FILE" "${ARCHIVE_FILE}${BACKUP_SUFFIX}"
    cp "$TODO_FILE" "${TODO_FILE}${BACKUP_SUFFIX}"
    [[ -f "$LOG_FILE" ]] && cp "$LOG_FILE" "${LOG_FILE}${BACKUP_SUFFIX}"
  }
  if [[ -n "$BACKUP_PATH" && "$QUIET" != true && "$FORMAT" != "json" ]]; then
    log_info "Archive backup created: $BACKUP_PATH"
  fi
else
  # Fallback if backup library not available at all
  BACKUP_SUFFIX=".backup.$(date +%s)"
  cp "$ARCHIVE_FILE" "${ARCHIVE_FILE}${BACKUP_SUFFIX}"
  cp "$TODO_FILE" "${TODO_FILE}${BACKUP_SUFFIX}"
  [[ -f "$LOG_FILE" ]] && cp "$LOG_FILE" "${LOG_FILE}${BACKUP_SUFFIX}"
fi

# Step 6: Atomic commit with file locking via save_json()
# Note: save_json() handles locking, validation, and atomic rename internally
if declare -f save_json >/dev/null 2>&1; then
  # Use save_json for locked atomic writes
  ARCHIVE_CONTENT=$(cat "$ARCHIVE_TMP")
  if ! save_json "$ARCHIVE_FILE" "$ARCHIVE_CONTENT"; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_FILE_WRITE_ERROR" "Failed to save archive file with locking" "${EXIT_FILE_ERROR:-3}" false
    else
      log_error "Failed to save archive file with locking"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
  fi
  rm -f "$ARCHIVE_TMP"

  TODO_CONTENT=$(cat "$TODO_TMP")
  if ! save_json "$TODO_FILE" "$TODO_CONTENT"; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_FILE_WRITE_ERROR" "Failed to save todo file with locking" "${EXIT_FILE_ERROR:-3}" false
    else
      log_error "Failed to save todo file with locking"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
  fi
  rm -f "$TODO_TMP"

  if [[ -f "$LOG_TMP" ]]; then
    LOG_CONTENT=$(cat "$LOG_TMP")
    if ! save_json "$LOG_FILE" "$LOG_CONTENT"; then
      if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_FILE_WRITE_ERROR" "Failed to save log file with locking" "${EXIT_FILE_ERROR:-3}" false
      else
        log_error "Failed to save log file with locking"
      fi
      exit "${EXIT_FILE_ERROR:-3}"
    fi
    rm -f "$LOG_TMP"
  fi
else
  # Fallback: direct mv if file-ops.sh not available
  mv "$ARCHIVE_TMP" "$ARCHIVE_FILE"
  mv "$TODO_TMP" "$TODO_FILE"
  [[ -f "$LOG_TMP" ]] && mv "$LOG_TMP" "$LOG_FILE"
fi

# Remove trap since we succeeded
trap - EXIT

# Get remaining task counts for output
REMAINING_TOTAL=$(jq '.tasks | length' "$TODO_FILE")
REMAINING_PENDING=$(jq '[.tasks[] | select(.status == "pending")] | length' "$TODO_FILE")
REMAINING_ACTIVE=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
REMAINING_BLOCKED=$(jq '[.tasks[] | select(.status == "blocked")] | length' "$TODO_FILE")

# Generate archived task IDs as JSON array
ARCHIVE_IDS_JSON=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[].id]')

if [[ "$FORMAT" == "json" ]]; then
  # JSON output for LLM agents
  OUTPUT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Build onlyLabelsFilter JSON (null if not specified)
  ONLY_LABELS_OUTPUT="null"
  [[ -n "$ONLY_LABELS" ]] && ONLY_LABELS_OUTPUT="$ONLY_LABELS_JSON"

  jq -n \
    --arg ts "$OUTPUT_TIMESTAMP" \
    --arg ver "${CLEO_VERSION:-$(get_version)}" \
    --argjson count "$ARCHIVE_COUNT" \
    --argjson ids "$ARCHIVE_IDS_JSON" \
    --argjson total "$REMAINING_TOTAL" \
    --argjson pending "$REMAINING_PENDING" \
    --argjson active "$REMAINING_ACTIVE" \
    --argjson blocked "$REMAINING_BLOCKED" \
    --argjson excludeLabelsApplied "$EXCLUDE_LABELS_APPLIED" \
    --argjson effectiveExemptLabels "$EXEMPT_LABELS" \
    --argjson exemptedCount "$EXEMPTED_COUNT" \
    --argjson exemptedIds "$EXEMPTED_IDS" \
    --argjson warnings "$WARNINGS_JSON" \
    --argjson onlyLabelsFilter "$ONLY_LABELS_OUTPUT" \
    --argjson safeMode "$SAFE_MODE" \
    --argjson blockedByChildren "$BLOCKED_BY_CHILDREN" \
    --argjson blockedByDependents "$BLOCKED_BY_DEPENDENTS" \
    --argjson cascadeApplied "$CASCADE_APPLIED" \
    --argjson cascadedFamilies "$CASCADED_FAMILIES" \
    --argjson cascadeFrom "$CASCADE_FROM_INFO" \
    --argjson interactiveEnabled "${INTERACTIVE:-false}" \
    --argjson interactiveApproved "$INTERACTIVE_APPROVED" \
    --argjson interactiveSkipped "$INTERACTIVE_SKIPPED" \
      --argjson phaseTrigger "$PHASE_TRIGGER_INFO" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {"format": "json", "command": "archive", "timestamp": $ts, "version": $ver},
      "success": true,
      "safeMode": $safeMode,
      "cascadeApplied": $cascadeApplied,
      "cascadedFamilies": $cascadedFamilies,
      "cascadeFrom": $cascadeFrom,
      "interactive": (if $interactiveEnabled then {"enabled": true, "approved": $interactiveApproved, "skipped": $interactiveSkipped} else null end),
      "phaseTrigger": $phaseTrigger,
      "archived": {"count": $count, "taskIds": $ids},
      "exempted": {"count": $exemptedCount, "taskIds": $exemptedIds},
      "blockedByRelationships": {"byChildren": $blockedByChildren, "byDependents": $blockedByDependents},
      "excludeLabelsApplied": $excludeLabelsApplied,
      "effectiveExemptLabels": $effectiveExemptLabels,
      "filters": {"onlyLabels": $onlyLabelsFilter, "excludeLabels": (if $excludeLabelsApplied then $effectiveExemptLabels else null end)},
      "warnings": $warnings,
      "warningCount": ($warnings | length),
      "remaining": {"total": $total, "pending": $pending, "active": $active, "blocked": $blocked}
    }'
else
  # Human-readable text output
  if [[ "$QUIET" != true ]]; then
    log_info "Archived $ARCHIVE_COUNT tasks"
    echo ""
    echo "Archived tasks:"
    echo "$ARCHIVE_IDS" | while read -r id; do
      echo "  - $id"
    done

    # Calculate and display archive statistics
    if [[ -n "$TASKS_TO_ARCHIVE" ]]; then
      TOTAL_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq 'length')
      CRITICAL_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[] | select(.priority == "critical")] | length')
      HIGH_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[] | select(.priority == "high")] | length')
      MEDIUM_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[] | select(.priority == "medium")] | length')
      LOW_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq '[.[] | select(.priority == "low")] | length')

      echo ""
      echo "[ARCHIVE] Summary Statistics:"
      echo "  Total archived: $TOTAL_COUNT"
      echo "  By priority:"
      [[ $CRITICAL_COUNT -gt 0 ]] && echo "    Critical: $CRITICAL_COUNT"
      [[ $HIGH_COUNT -gt 0 ]] && echo "    High: $HIGH_COUNT"
      [[ $MEDIUM_COUNT -gt 0 ]] && echo "    Medium: $MEDIUM_COUNT"
      [[ $LOW_COUNT -gt 0 ]] && echo "    Low: $LOW_COUNT"

      # Show labels breakdown if any tasks have labels
      LABEL_STATS=$(echo "$TASKS_TO_ARCHIVE" | jq -r '[.[] | .labels // [] | .[]] | group_by(.) | map({label: .[0], count: length}) | sort_by(-.count) | .[:5] | .[] | "    \(.label): \(.count)"' 2>/dev/null)
      if [[ -n "$LABEL_STATS" ]]; then
        echo "  Top labels:"
        echo "$LABEL_STATS"
      fi

      # Calculate average cycle time if available
      AVG_CYCLE_TIME=$(echo "$TASKS_WITH_METADATA" | jq '[.[]._archive.cycleTimeDays | select(. != null)] | if length > 0 then (add / length | floor) else null end')
      if [[ "$AVG_CYCLE_TIME" != "null" && -n "$AVG_CYCLE_TIME" ]]; then
        echo "  Average cycle time: $AVG_CYCLE_TIME days"
      fi

      # Show exempted tasks if any
      if [[ "$EXEMPTED_COUNT" -gt 0 ]]; then
        echo ""
        echo "  Exempted tasks (protected by labels): $EXEMPTED_COUNT"
        echo "$EXEMPTED_TASKS" | jq -r '.[] | "    - \(.id): \(.title)"'
      fi

      # Show cascade information if applied
      if [[ "$CASCADE_APPLIED" == "true" ]]; then
        echo ""
        echo "  Cascaded families archived together:"
        echo "$CASCADED_FAMILIES" | jq -r '.[] | "    - Parent \(.parent) with children: \(.children | join(", "))"'
      fi

      # Show cascade-from information if applied
      if [[ -n "$CASCADE_FROM" ]]; then
        echo ""
        echo "  Cascade from $CASCADE_FROM:"
        echo "    Root task: $CASCADE_FROM"
        echo "    Total descendants: $(echo "$CASCADE_FROM_INFO" | jq -r '.totalDescendants')"
        echo "    Completed (archived): $(echo "$CASCADE_FROM_INFO" | jq -r '.completedDescendants + 1') (including root)"
        echo "    Incomplete (skipped): $(echo "$CASCADE_FROM_INFO" | jq -r '.incompleteDescendants')"
      fi
    fi
  fi
fi

exit "${EXIT_SUCCESS:-0}"
