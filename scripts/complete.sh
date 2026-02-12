#!/usr/bin/env bash
###CLEO
# command: complete
# category: write
# synopsis: Mark task as done with completion timestamp and cycle time
# relevance: critical
# flags: --format,--quiet,--dry-run
# exits: 0,2,4,102
# json-output: true
###END
# CLEO Complete Task Script
# Mark a task as complete and optionally trigger archive
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
LOG_SCRIPT="${SCRIPT_DIR}/log.sh"
ARCHIVE_SCRIPT="${SCRIPT_DIR}/archive.sh"

# Source paths.sh for path resolution functions
if [[ -f "$LIB_DIR/core/paths.sh" ]]; then
    source "$LIB_DIR/core/paths.sh"
fi

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"

# Command name for error-json library
COMMAND_NAME="complete"

# Source logging library for should_use_color function
if [[ -f "$LIB_DIR/core/version.sh" ]]; then
  # shellcheck source=../lib/core/version.sh
  source "$LIB_DIR/core/version.sh"
fi
if [[ -f "$LIB_DIR/core/logging.sh" ]]; then
  # shellcheck source=../lib/core/logging.sh
  source "$LIB_DIR/core/logging.sh"
fi

# Source file operations library for atomic writes with locking
if [[ -f "$LIB_DIR/data/file-ops.sh" ]]; then
  # shellcheck source=../lib/data/file-ops.sh
  source "$LIB_DIR/data/file-ops.sh"
fi

# Source backup library for unified backup management
if [[ -f "$LIB_DIR/data/backup.sh" ]]; then
  # shellcheck source=../lib/data/backup.sh
  source "$LIB_DIR/data/backup.sh"
fi

# Source output formatting library for format resolution
if [[ -f "$LIB_DIR/core/output-format.sh" ]]; then
  # shellcheck source=../lib/core/output-format.sh
  source "$LIB_DIR/core/output-format.sh"
fi

# Source error JSON library (includes exit-codes.sh)
# Note: error-json.sh sources exit-codes.sh, so we don't source it separately
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
  # shellcheck source=../lib/core/error-json.sh
  source "$LIB_DIR/core/error-json.sh"
elif [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/core/exit-codes.sh
  source "$LIB_DIR/core/exit-codes.sh"
fi

# Source config library for unified config access (v0.24.0)
if [[ -f "$LIB_DIR/core/config.sh" ]]; then
  # shellcheck source=../lib/core/config.sh
  source "$LIB_DIR/core/config.sh"
fi

# Source phase tracking library for phase context validation (v2.2.0)
if [[ -f "$LIB_DIR/tasks/phase-tracking.sh" ]]; then
  # shellcheck source=../lib/tasks/phase-tracking.sh
  source "$LIB_DIR/tasks/phase-tracking.sh"
fi

# Source validation library for input validation (Part 5.3 compliance)
if [[ -f "$LIB_DIR/validation/validation.sh" ]]; then
  # shellcheck source=../lib/validation/validation.sh
  source "$LIB_DIR/validation/validation.sh"
fi

# Source session enforcement for Epic-Bound Sessions (v0.40.0)
if [[ -f "$LIB_DIR/session/session-enforcement.sh" ]]; then
  # shellcheck source=../lib/session/session-enforcement.sh
  source "$LIB_DIR/session/session-enforcement.sh"
fi

# Source verification library for gate management (v0.44.0)
if [[ -f "$LIB_DIR/validation/verification.sh" ]]; then
  # shellcheck source=../lib/validation/verification.sh
  source "$LIB_DIR/validation/verification.sh"
fi

# Source lifecycle library for gate enforcement (T2579)
if [[ -f "$LIB_DIR/tasks/lifecycle.sh" ]]; then
  # shellcheck source=../lib/tasks/lifecycle.sh
  source "$LIB_DIR/tasks/lifecycle.sh"
fi

# Source context alert library for context monitoring (T1323)
if [[ -f "$LIB_DIR/session/context-alert.sh" ]]; then
  # shellcheck source=../lib/session/context-alert.sh
  source "$LIB_DIR/session/context-alert.sh"
fi

# Source protocol validation library for protocol enforcement (T2695)
if [[ -f "$LIB_DIR/validation/protocol-validation.sh" ]]; then
  # shellcheck source=../lib/validation/protocol-validation.sh
  source "$LIB_DIR/validation/protocol-validation.sh"
fi

# Source manifest validation library for REAL validation (T2832)
if [[ -f "$LIB_DIR/validation/manifest-validation.sh" ]]; then
  # shellcheck source=../lib/validation/manifest-validation.sh
  source "$LIB_DIR/validation/manifest-validation.sh"
fi

# Source task-mutate library for centralized mutations with updatedAt (T2067)
if [[ -f "$LIB_DIR/tasks/task-mutate.sh" ]]; then
  # shellcheck source=../lib/tasks/task-mutate.sh
  source "$LIB_DIR/tasks/task-mutate.sh"
fi

# Source centralized flag parsing
if [[ -f "$LIB_DIR/ui/flags.sh" ]]; then
  # shellcheck source=../lib/ui/flags.sh
  source "$LIB_DIR/ui/flags.sh"
fi

# Colors (respects NO_COLOR and FORCE_COLOR environment variables per https://no-color.org)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

# Defaults
TASK_ID=""
SKIP_ARCHIVE=false
NOTES=""
SKIP_NOTES=false
FORMAT=""
DRY_RUN=false
QUIET=false
SKIP_VERIFICATION=false

usage() {
  cat << EOF
Usage: cleo complete TASK_ID [OPTIONS]

Mark a task as complete (status='done') and set completedAt timestamp.

Arguments:
  TASK_ID                 Task ID to complete (e.g., T001)

Options:
  -n, --notes TEXT        Completion notes describing what was done (required)
  --skip-notes            Skip notes requirement (use for quick completions)
  --skip-archive          Don't trigger auto-archive even if configured
  --skip-verification     Skip setting verification.gates.implemented (requires allowManualOverride)
  -f, --format FORMAT     Output format: text (default) or json
  --human                 Force human-readable text output (same as --format text)
  --json                  Force JSON output (same as --format json)
  --dry-run               Show what would be completed without making changes
  -q, --quiet             Suppress informational messages
  -h, --help              Show this help

Notes Requirement:
  Completion notes are required by default for better task tracking and audit trails.
  Use --skip-notes to bypass this for quick completions.

  Good notes describe: what was done, how it was verified, and any relevant references
  (commit hashes, PR numbers, documentation links).

Output Formats:
  text    Human-readable output with colors and status messages (default for TTY)
  json    Machine-readable JSON with full task data (default for pipes/agents)

JSON Output Structure:
  {
    "_meta": {"command": "complete", "timestamp": "...", "version": "..."},
    "success": true,
    "taskId": "T042",
    "completedAt": "2025-12-17T10:00:00Z",
    "cycleTimeDays": 3.5,
    "archived": false,
    "task": { /* full completed task */ }
  }

Examples:
  cleo complete T001 --notes "Implemented auth middleware. Tested with unit tests."
  cleo complete T042 --notes "Fixed bug #123. PR merged."
  cleo complete T042 --skip-notes --skip-archive
  cleo complete T001 --json --notes "Done"     # JSON output for agents
  cleo complete T001 --format json             # Same as --json

After completion, if autoArchiveOnComplete is enabled in config,
the archive script will run automatically.
EOF
  exit "$EXIT_SUCCESS"
}

log_info()  { [[ "$QUIET" != true ]] && echo -e "${GREEN}[INFO]${NC} $1" || true; }
log_warn()  { [[ "$QUIET" != true ]] && echo -e "${YELLOW}[WARN]${NC} $1" || true; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    exit "$EXIT_DEPENDENCY_ERROR"
  fi
}

# Parse arguments
if [[ $# -eq 0 ]]; then
  log_error "Task ID required"
  usage
fi

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) usage ;;
    -q|--quiet) QUIET=true; shift ;;
    -n|--notes)
      NOTES="${2:-}"
      if [[ -z "$NOTES" ]]; then
        log_error "--notes requires a text argument"
        exit "$EXIT_INVALID_INPUT"
      fi
      shift 2
      ;;
    -f|--format)
      FORMAT="${2:-}"
      if [[ -z "$FORMAT" ]]; then
        log_error "--format requires an argument (text or json)"
        exit "$EXIT_INVALID_INPUT"
      fi
      shift 2
      ;;
    --human) FORMAT="text"; shift ;;
    --json) FORMAT="json"; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --skip-notes) SKIP_NOTES=true; shift ;;
    --skip-archive) SKIP_ARCHIVE=true; shift ;;
    --skip-verification) SKIP_VERIFICATION=true; shift ;;
    -*) log_error "Unknown option: $1"; exit "$EXIT_INVALID_INPUT" ;;
    *) TASK_ID="$1"; shift ;;
  esac
done

# Resolve format (CLI > env > config > TTY-aware default)
if declare -f resolve_format >/dev/null 2>&1; then
  FORMAT=$(resolve_format "$FORMAT" true "text,json")
else
  # Fallback if output-format.sh not available
  FORMAT="${FORMAT:-text}"
fi

# Require notes unless --skip-notes is provided
if [[ -z "$NOTES" && "$SKIP_NOTES" == false ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_INPUT_MISSING" "Completion notes required. Use --notes 'description' or --skip-notes to bypass." \
      "${EXIT_INVALID_INPUT:-2}" true "Example: cleo complete $TASK_ID --notes 'Implemented feature. Tests passing.'"
    exit "${EXIT_INVALID_INPUT:-2}"
  else
    log_error "Completion notes required. Use --notes 'description' or --skip-notes to bypass."
    echo "" >&2
    echo "Example:" >&2
    echo "  cleo complete $TASK_ID --notes 'Implemented feature. Tests passing.'" >&2
    echo "  cleo complete $TASK_ID --skip-notes" >&2
    exit "$EXIT_INVALID_INPUT"
  fi
fi

check_deps

# Validate task ID format
if [[ ! "$TASK_ID" =~ ^T[0-9]{3,}$ ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_TASK_INVALID_ID" "Invalid task ID format: $TASK_ID (must be T### format)" \
      "${EXIT_INVALID_INPUT:-2}" false "Task IDs must be in T### format (e.g., T001, T042)"
    exit "${EXIT_INVALID_INPUT:-2}"
  else
    log_error "Invalid task ID format: $TASK_ID (must be T### format)"
    exit "$EXIT_INVALID_INPUT"
  fi
fi

# ============================================================================
# SESSION ENFORCEMENT (Epic-Bound Sessions v0.40.0)
# Require active session for write operations when multiSession.enabled=true
# ============================================================================
if declare -f require_active_session >/dev/null 2>&1; then
  if ! require_active_session "complete" "$FORMAT"; then
    exit $?
  fi
fi

# Check files exist
if [[ ! -f "$TODO_FILE" ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_NOT_INITIALIZED" "$TODO_FILE not found. Run cleo init first." \
      "${EXIT_FILE_ERROR:-3}" true "Run 'cleo init' to initialize the project"
    exit "${EXIT_FILE_ERROR:-3}"
  else
    log_error "$TODO_FILE not found. Run cleo init first."
    exit "$EXIT_FILE_ERROR"
  fi
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_NOT_INITIALIZED" "$CONFIG_FILE not found. Run cleo init first." \
      "${EXIT_FILE_ERROR:-3}" true "Run 'cleo init' to initialize the project"
    exit "${EXIT_FILE_ERROR:-3}"
  else
    log_error "$CONFIG_FILE not found. Run cleo init first."
    exit "$EXIT_FILE_ERROR"
  fi
fi

# Check for external modifications (informational, not blocking)
# Note: Checksum verification is for audit/detection, not write-gating.
# In multi-writer scenarios (TodoWrite + CLI), external modifications are expected.
CURRENT_CHECKSUM=$(jq -r '._meta.checksum // ""' "$TODO_FILE")
CURRENT_TASKS=$(jq -c '.tasks' "$TODO_FILE")
CALCULATED_CHECKSUM=$(echo "$CURRENT_TASKS" | sha256sum | cut -c1-16)

if [[ -n "$CURRENT_CHECKSUM" && "$CURRENT_CHECKSUM" != "$CALCULATED_CHECKSUM" ]]; then
  [[ "$FORMAT" != "json" ]] && log_info "External modification detected (checksum: $CURRENT_CHECKSUM → $CALCULATED_CHECKSUM)"
fi

# Check task exists
TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")

if [[ -z "$TASK" ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_TASK_NOT_FOUND" "Task $TASK_ID not found" \
      "${EXIT_NOT_FOUND:-4}" true "Use 'cleo list' to see available tasks or 'cleo exists $TASK_ID --include-archive' to check archive"
    exit "${EXIT_NOT_FOUND:-4}"
  else
    log_error "Task $TASK_ID not found"
    exit "$EXIT_NOT_FOUND"
  fi
fi

# Check current status
CURRENT_STATUS=$(echo "$TASK" | jq -r '.status')

# Capture createdAt for cycle time calculation
CREATED_AT=$(echo "$TASK" | jq -r '.createdAt // empty')

# Idempotency check: Per LLM-AGENT-FIRST-SPEC.md Part 5.6
# Completing already-done task returns EXIT_NO_CHANGE (102)
# Agents should treat EXIT_NO_CHANGE as success, not retry
if [[ "$CURRENT_STATUS" == "done" ]]; then
  TASK_TITLE=$(echo "$TASK" | jq -r '.title')
  COMPLETED_AT=$(echo "$TASK" | jq -r '.completedAt')

  if [[ "$FORMAT" == "json" ]]; then
    # JSON output with noChange: true per spec Part 5.6
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq -nc \
      --arg version "${CLEO_VERSION:-unknown}" \
      --arg timestamp "$TIMESTAMP" \
      --arg taskId "$TASK_ID" \
      --arg completedAt "$COMPLETED_AT" \
      --arg message "Task $TASK_ID is already complete" \
      --argjson task "$TASK" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "command": "complete",
          "timestamp": $timestamp,
          "version": $version
        },
        "success": true,
        "noChange": true,
        "taskId": $taskId,
        "message": $message,
        "completedAt": $completedAt,
        "task": $task
      }'
    exit "${EXIT_NO_CHANGE:-102}"
  else
    log_warn "Task $TASK_ID is already completed"
    echo ""
    echo "Task: $TASK_TITLE"
    echo "Completed at: $COMPLETED_AT"
    exit "${EXIT_NO_CHANGE:-102}"
  fi
fi

# Debug output for parent auto-complete (remove after testing)
# Debug output removed - functionality verified

# Validate status transition (pending/active/blocked → done)
if [[ ! "$CURRENT_STATUS" =~ ^(pending|active|blocked)$ ]]; then
  if declare -f output_error >/dev/null 2>&1; then
    output_error "$E_TASK_INVALID_STATUS" "Invalid status transition: $CURRENT_STATUS → done" \
      "${EXIT_VALIDATION_ERROR:-6}" false "Tasks can only be completed from pending, active, or blocked status"
    exit "${EXIT_VALIDATION_ERROR:-6}"
  else
    log_error "Invalid status transition: $CURRENT_STATUS → done"
    exit "$EXIT_VALIDATION_ERROR"
  fi
fi

# DRY-RUN: Show what would be completed without making changes
if [[ "$DRY_RUN" == true ]]; then
  TASK_TITLE=$(echo "$TASK" | jq -r '.title')
  DRY_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Calculate cycle time for dry-run preview
  DRY_CYCLE_TIME=""
  if [[ -n "$CREATED_AT" ]]; then
    CREATED_EPOCH=$(date -d "$CREATED_AT" +%s 2>/dev/null || echo "")
    DRY_EPOCH=$(date -d "$DRY_TIMESTAMP" +%s 2>/dev/null || echo "")
    if [[ -n "$CREATED_EPOCH" && -n "$DRY_EPOCH" ]]; then
      DIFF_SECONDS=$((DRY_EPOCH - CREATED_EPOCH))
      DRY_CYCLE_TIME=$(awk "BEGIN {printf \"%.1f\", $DIFF_SECONDS / 86400}")
    fi
  fi

  # Check if verification would be updated
  DRY_VERIF_WOULD_UPDATE=false
  DRY_TASK_TYPE=$(echo "$TASK" | jq -r '.type // "task"')
  if declare -f should_require_verification >/dev/null 2>&1; then
    if [[ "$SKIP_VERIFICATION" != "true" ]] && should_require_verification "$DRY_TASK_TYPE"; then
      AUTO_SET_IMPL=$(get_config_value "verification.autoSetImplementedOnComplete" "true")
      if [[ "$AUTO_SET_IMPL" == "true" ]]; then
        DRY_VERIF_WOULD_UPDATE=true
      fi
    fi
  fi

  if [[ "$FORMAT" == "json" ]]; then
    jq -nc \
      --arg version "${CLEO_VERSION:-unknown}" \
      --arg timestamp "$DRY_TIMESTAMP" \
      --arg taskId "$TASK_ID" \
      --arg completedAt "$DRY_TIMESTAMP" \
      --arg cycleTime "${DRY_CYCLE_TIME:-null}" \
      --arg currentStatus "$CURRENT_STATUS" \
      --argjson wouldUpdateVerification "$DRY_VERIF_WOULD_UPDATE" \
      --argjson task "$TASK" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "command": "complete",
          "timestamp": $timestamp,
          "version": $version
        },
        "success": true,
        "dryRun": true,
        "wouldComplete": {
          "taskId": $taskId,
          "title": $task.title,
          "currentStatus": $currentStatus,
          "completedAt": $completedAt,
          "cycleTimeDays": (if $cycleTime == "null" then null else ($cycleTime | tonumber) end),
          "wouldUpdateVerification": $wouldUpdateVerification
        },
        "task": $task
      }'
  else
    echo -e "${YELLOW}[DRY-RUN]${NC} Would complete task:"
    echo ""
    echo -e "${BLUE}Task:${NC} $TASK_TITLE"
    echo -e "${BLUE}ID:${NC} $TASK_ID"
    echo -e "${BLUE}Status:${NC} $CURRENT_STATUS → done"
    echo -e "${BLUE}Would Complete:${NC} $DRY_TIMESTAMP"
    if [[ -n "$NOTES" ]]; then
      echo -e "${BLUE}Notes:${NC} $NOTES"
    fi
    if [[ -n "$DRY_CYCLE_TIME" ]]; then
      echo -e "${BLUE}Cycle Time:${NC} ${DRY_CYCLE_TIME} days"
    fi
    if [[ "$DRY_VERIF_WOULD_UPDATE" == "true" ]]; then
      echo -e "${BLUE}Verification:${NC} Would set gates.implemented = true"
    fi
    echo ""
    echo -e "${YELLOW}No changes made (dry-run mode)${NC}"
  fi
  exit "$EXIT_SUCCESS"
fi

# Create safety backup before modification using unified backup library
if declare -f create_safety_backup >/dev/null 2>&1; then
  BACKUP_PATH=$(create_safety_backup "$TODO_FILE" "complete" 2>&1) || {
    [[ "$FORMAT" != "json" ]] && log_warn "Backup library failed, using fallback backup method"
    # Fallback to inline backup if library fails
    BACKUP_DIR=".cleo/backups/safety"
    mkdir -p "$BACKUP_DIR"
    BACKUP_FILE="${BACKUP_DIR}/todo.json.$(date +%Y%m%d_%H%M%S)"
    cp "$TODO_FILE" "$BACKUP_FILE"
    BACKUP_PATH="$BACKUP_FILE"
  }
  [[ "$FORMAT" != "json" ]] && log_info "Backup created: $BACKUP_PATH"
else
  # Fallback if backup library not available
  BACKUP_DIR=".cleo/backups/safety"
  mkdir -p "$BACKUP_DIR"
  BACKUP_FILE="${BACKUP_DIR}/todo.json.$(date +%Y%m%d_%H%M%S)"
  cp "$TODO_FILE" "$BACKUP_FILE"
  [[ "$FORMAT" != "json" ]] && log_info "Backup created: $BACKUP_FILE"
fi

# Capture before state
BEFORE_STATE=$(echo "$TASK" | jq '{status, completedAt}')

# T2832: REAL manifest validation before completion
# Uses actual subagent output from MANIFEST.jsonl, not fake entries
# Logs real compliance metrics instead of hardcoded 100%
if declare -f validate_and_log >/dev/null 2>&1; then
  TASK_LABELS=$(echo "$TASK" | jq -c '.labels // []')
  TASK_TYPE=$(echo "$TASK" | jq -r '.type // "task"')

  # Check if task has subagent-related labels (any RCSD-IVTR protocol)
  HAS_SUBAGENT_LABEL=$(echo "$TASK_LABELS" | jq 'map(select(
    . == "implementation" or . == "ivtr-i" or
    . == "research" or . == "rcsd-r" or
    . == "consensus" or . == "rcsd-c" or
    . == "specification" or . == "rcsd-s" or
    . == "decomposition" or . == "rcsd-d" or
    . == "validation" or . == "ivtr-v" or
    . == "testing" or . == "ivtr-t" or
    . == "release" or . == "ivtr-r"
  )) | length > 0')

  # Run validation for subagent tasks
  if [[ "$HAS_SUBAGENT_LABEL" == "true" || "$TASK_TYPE" == "implementation" ]]; then
    # Use REAL manifest validation - finds actual subagent output and validates it
    VALIDATION_RESULT=$(validate_and_log "$TASK_ID" 2>/dev/null || echo '{"valid":false,"score":0,"pass":false,"violations":[{"requirement":"MANIFEST-001","severity":"warning","message":"No manifest entry found (may be non-subagent task)"}]}')

    IS_VALID=$(echo "$VALIDATION_RESULT" | jq -r '.valid // .pass // false')
    SCORE=$(echo "$VALIDATION_RESULT" | jq -r '.score // 0')

    if [[ "$IS_VALID" != "true" ]]; then
      VIOLATIONS=$(echo "$VALIDATION_RESULT" | jq -c '.violations // []')
      ERROR_COUNT=$(echo "$VIOLATIONS" | jq '[.[] | select(.severity == "error")] | length')

      if [[ $ERROR_COUNT -gt 0 && "$SCORE" -lt 50 ]]; then
        # Severe protocol violation - block completion
        AGENT_TYPE=$(echo "$VALIDATION_RESULT" | jq -r '.agent_type // "unknown"')
        if [[ "$FORMAT" == "json" ]]; then
          jq -n \
            --arg task_id "$TASK_ID" \
            --arg agent_type "$AGENT_TYPE" \
            --argjson score "$SCORE" \
            --argjson violations "$VIOLATIONS" \
            '{
              "_meta": {
                "command": "complete",
                "timestamp": (now | todate),
                "version": "'"${VERSION:-unknown}"'"
              },
              "success": false,
              "error": {
                "code": "E_PROTOCOL_VIOLATION",
                "message": ("Protocol requirements not met (score: " + ($score | tostring) + "/100). Cannot complete task."),
                "fix": "Fix protocol violations listed below",
                "alternatives": [
                  {
                    "action": "Review protocol requirements",
                    "command": ("cat protocols/" + $agent_type + ".md")
                  },
                  {
                    "action": "Skip validation (not recommended)",
                    "command": ("cleo complete " + $task_id + " --skip-validation")
                  }
                ],
                "context": {
                  "taskId": $task_id,
                  "protocol": $agent_type,
                  "score": $score,
                  "violations": $violations
                }
              }
            }'
        else
          log_error "Protocol validation failed (score: $SCORE/100)"
          echo "Violations:" >&2
          echo "$VIOLATIONS" | jq -r '.[] | "  - [\(.severity | ascii_upcase)] \(.requirement): \(.message)"' >&2
          echo "" >&2
          echo "Fix violations or use --skip-validation to bypass (not recommended)" >&2
        fi
        exit "${EXIT_PROTOCOL_IMPLEMENTATION:-64}"
      elif [[ $(echo "$VIOLATIONS" | jq 'length') -gt 0 ]]; then
        # Warnings only - log but allow completion
        [[ "$FORMAT" != "json" ]] && log_warn "Protocol validation score: $SCORE/100 (warnings present, proceeding)"
      fi
    else
      # Validation passed - log success
      [[ "$FORMAT" != "json" && -n "${CLEO_VERBOSE:-}" ]] && log_info "Protocol validation passed (score: $SCORE/100)"
    fi
  fi
elif declare -f validate_implementation_protocol >/dev/null 2>&1; then
  # Fallback to old behavior if manifest-validation not available
  TASK_LABELS=$(echo "$TASK" | jq -c '.labels // []')
  HAS_IMPL_LABEL=$(echo "$TASK_LABELS" | jq 'map(select(. == "implementation" or . == "ivtr-i")) | length > 0')

  if [[ "$HAS_IMPL_LABEL" == "true" ]]; then
    [[ "$FORMAT" != "json" ]] && log_warn "Using legacy validation (manifest-validation.sh not available)"
  fi
fi

# Update task with completion
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION_ID=$(jq -r '._meta.activeSession // "system"' "$TODO_FILE")

# Update task: set status=done, add completedAt, clear blockedBy, set updatedAt, and add completion note
# T2067: updatedAt is set on all mutations per centralized mutation library
if [[ -n "$NOTES" ]]; then
  COMPLETION_NOTE="[COMPLETED $TIMESTAMP] $NOTES"
  UPDATED_TASKS=$(jq --arg id "$TASK_ID" --arg ts "$TIMESTAMP" --arg note "$COMPLETION_NOTE" '
    .tasks |= map(
      if .id == $id then
        .status = "done" |
        .completedAt = $ts |
        .updatedAt = $ts |
        del(.blockedBy) |
        .notes = ((.notes // []) + [$note])
      else . end
    )
  ' "$TODO_FILE") || {
    log_error "jq failed to update tasks (with notes)"
    exit "$EXIT_FILE_ERROR"
  }
else
  UPDATED_TASKS=$(jq --arg id "$TASK_ID" --arg ts "$TIMESTAMP" '
    .tasks |= map(
      if .id == $id then
        .status = "done" |
        .completedAt = $ts |
        .updatedAt = $ts |
        del(.blockedBy)
      else . end
    )
  ' "$TODO_FILE") || {
    log_error "jq failed to update tasks (no notes)"
    exit "$EXIT_FILE_ERROR"
  }
fi

# Verify UPDATED_TASKS is valid JSON and not empty
if [[ -z "$UPDATED_TASKS" ]]; then
  log_error "Generated empty JSON structure"
  exit "$EXIT_FILE_ERROR"
fi

if ! echo "$UPDATED_TASKS" | jq empty 2>/dev/null; then
  log_error "Generated invalid JSON structure"
  exit "$EXIT_FILE_ERROR"
fi

# Recalculate checksum
NEW_TASKS=$(echo "$UPDATED_TASKS" | jq -c '.tasks')
NEW_CHECKSUM=$(echo "$NEW_TASKS" | sha256sum | cut -c1-16)

# Update file with new checksum and lastUpdated
FINAL_JSON=$(echo "$UPDATED_TASKS" | jq --arg checksum "$NEW_CHECKSUM" --arg ts "$TIMESTAMP" '
  ._meta.checksum = $checksum |
  .lastUpdated = $ts
')

# Atomic write with file locking (prevents race conditions)
# Using save_json from lib/data/file-ops.sh which includes:
# - File locking to prevent concurrent writes
# - Atomic write with backup
# - JSON validation
# - Proper error handling
if ! save_json "$TODO_FILE" "$FINAL_JSON"; then
  log_error "Failed to write todo file. Rolling back."
  exit "$EXIT_FILE_ERROR"
fi

# Verify task was actually updated
VERIFY_STATUS=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .status' "$TODO_FILE")
if [[ "$VERIFY_STATUS" != '"done"' ]]; then
  log_error "Failed to update task status."
  exit "$EXIT_FILE_ERROR"
fi

# ============================================================================
# LIFECYCLE GATE ENFORCEMENT (T2579)
# Check circular validation before allowing completion
# ============================================================================

# Check if lifecycle enforcement is enabled
if declare -f check_circular_validation >/dev/null 2>&1; then
  LIFECYCLE_ENFORCE=$(get_config_value "lifecycle.enforce" "false")

  if [[ "$LIFECYCLE_ENFORCE" == "true" ]]; then
    # Get current agent ID from environment or config
    CURRENT_AGENT="${CLEO_AGENT_ID:-user}"

    # Check circular validation (prevent self-approval)
    if ! check_circular_validation "$TASK_ID" "$CURRENT_AGENT" "$TODO_FILE"; then
      # Error already logged by check_circular_validation
      exit 70  # EXIT_SELF_APPROVAL
    fi
  fi
fi

# ============================================================================
# VERIFICATION GATE INITIALIZATION (v0.44.0)
# Set gates.implemented = true when completing a task
# ============================================================================
VERIFICATION_UPDATED=false

if declare -f should_require_verification >/dev/null 2>&1; then
  # Get task type to check if verification applies
  TASK_TYPE=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .type // "task"' "$TODO_FILE")

  # Handle --skip-verification flag
  if [[ "$SKIP_VERIFICATION" == "true" ]]; then
    ALLOW_OVERRIDE=$(get_config_value "verification.allowManualOverride" "true")
    if [[ "$ALLOW_OVERRIDE" != "true" ]]; then
      [[ "$FORMAT" != "json" ]] && log_warn "--skip-verification requires allowManualOverride=true in config"
    else
      [[ "$FORMAT" != "json" ]] && log_info "Skipping verification gate update (--skip-verification)"
    fi
  # Check if verification should be applied (skip epics)
  elif should_require_verification "$TASK_TYPE"; then
    # Check if autoSetImplementedOnComplete is enabled
    AUTO_SET_IMPLEMENTED=$(get_config_value "verification.autoSetImplementedOnComplete" "true")

    if [[ "$AUTO_SET_IMPLEMENTED" == "true" ]]; then
      # Get current verification object (may be null)
      CURRENT_VERIFICATION=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .verification // "null"' "$TODO_FILE")

      # Initialize verification if null
      if [[ "$CURRENT_VERIFICATION" == "null" || -z "$CURRENT_VERIFICATION" ]]; then
        CURRENT_VERIFICATION=$(init_verification)
      fi

      # Set gates.implemented = true
      UPDATED_VERIFICATION=$(update_gate "$CURRENT_VERIFICATION" "implemented" "true" "coder")

      # Compute verification.passed based on requiredGates
      VERIFICATION_PASSED=$(compute_passed "$UPDATED_VERIFICATION")
      UPDATED_VERIFICATION=$(set_verification_passed "$UPDATED_VERIFICATION" "$VERIFICATION_PASSED")

      # Update task with new verification object
      UPDATED_JSON=$(jq --arg id "$TASK_ID" --argjson verification "$UPDATED_VERIFICATION" '
        .tasks |= map(
          if .id == $id then
            .verification = $verification
          else . end
        )
      ' "$TODO_FILE")

      # Recalculate checksum for verification update
      VERIF_TASKS=$(echo "$UPDATED_JSON" | jq -c '.tasks')
      VERIF_CHECKSUM=$(echo "$VERIF_TASKS" | sha256sum | cut -c1-16)
      VERIF_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

      UPDATED_JSON=$(echo "$UPDATED_JSON" | jq --arg checksum "$VERIF_CHECKSUM" --arg ts "$VERIF_TS" '
        ._meta.checksum = $checksum |
        .lastUpdated = $ts
      ')

      # Save the updated file with verification
      if save_json "$TODO_FILE" "$UPDATED_JSON"; then
        VERIFICATION_UPDATED=true
        [[ "$FORMAT" != "json" ]] && log_info "Verification gates.implemented set to true"
        if [[ "$VERIFICATION_PASSED" == "true" ]]; then
          [[ "$FORMAT" != "json" ]] && log_info "Verification passed (all required gates complete)"

          # T1156: Check for epic lifecycle transition when verification passes
          if declare -f check_epic_lifecycle_transition >/dev/null 2>&1; then
            check_epic_lifecycle_transition "$TASK_ID" "$TODO_FILE" "$FORMAT" || true
          fi
        fi
      else
        [[ "$FORMAT" != "json" ]] && log_warn "Failed to update verification gates"
      fi
    fi
  else
    # Skip verification for epics (they derive from children)
    [[ "$FORMAT" != "json" && "$TASK_TYPE" == "epic" ]] && log_info "Skipping verification for epic (derived from children)"
  fi
fi

# Capture after state
AFTER_STATE=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | {status, completedAt}' "$TODO_FILE")

# Get full completed task for output
COMPLETED_TASK=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$TODO_FILE")
TASK_TITLE=$(echo "$COMPLETED_TASK" | jq -r '.title')

# Check context alert before outputting (T1324)
if declare -f check_context_alert >/dev/null 2>&1; then
  check_context_alert || true
fi

# Phase context check (permissive - warn only, never block completion)
if declare -f check_phase_context >/dev/null 2>&1; then
  TASK_PHASE=$(echo "$COMPLETED_TASK" | jq -r '.phase // empty')
  if [[ -n "$TASK_PHASE" ]]; then
    check_phase_context "$TASK_PHASE" "$TODO_FILE" || true  # Never block completion
  fi
fi

# Calculate cycle time (days between created and completed)
CYCLE_TIME_DAYS=""
if [[ -n "$CREATED_AT" ]]; then
  # Calculate using date epoch conversion
  CREATED_EPOCH=$(date -d "$CREATED_AT" +%s 2>/dev/null || echo "")
  COMPLETED_EPOCH=$(date -d "$TIMESTAMP" +%s 2>/dev/null || echo "")

  if [[ -n "$CREATED_EPOCH" && -n "$COMPLETED_EPOCH" ]]; then
    # Calculate days with one decimal precision
    DIFF_SECONDS=$((COMPLETED_EPOCH - CREATED_EPOCH))
    # Use awk for floating point division
    CYCLE_TIME_DAYS=$(awk "BEGIN {printf \"%.1f\", $DIFF_SECONDS / 86400}")
  fi
fi

# Log the operation (before output, so log entry is created regardless of format)
if [[ -f "$LOG_SCRIPT" ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    # Suppress all log output in JSON mode
    "$LOG_SCRIPT" \
      --action "status_changed" \
      --task-id "$TASK_ID" \
      --before "$BEFORE_STATE" \
      --after "$AFTER_STATE" \
      --details "{\"field\":\"status\",\"operation\":\"complete\"}" \
      --actor "system" >/dev/null 2>&1 || true
  else
    "$LOG_SCRIPT" \
      --action "status_changed" \
      --task-id "$TASK_ID" \
      --before "$BEFORE_STATE" \
      --after "$AFTER_STATE" \
      --details "{\"field\":\"status\",\"operation\":\"complete\"}" \
      --actor "system" 2>/dev/null || log_warn "Failed to write log entry"
  fi
fi

# Check if current focus was this task and clear it
FOCUS_CLEARED=false
CURRENT_FOCUS=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
if [[ "$CURRENT_FOCUS" == "$TASK_ID" ]]; then
  updated_todo=$(jq '.focus.currentTask = null' "$TODO_FILE")
  save_json "$TODO_FILE" "$updated_todo"
  FOCUS_CLEARED=true
  [[ "$FORMAT" != "json" ]] && log_info "Clearing focus from completed task"
fi

# Check auto-archive configuration using config.sh library for priority resolution
ARCHIVED=false
if [[ "$SKIP_ARCHIVE" == false ]]; then
  if declare -f get_config_value >/dev/null 2>&1; then
    AUTO_ARCHIVE=$(get_config_value "archive.autoArchiveOnComplete" "false")
  else
    # Fallback to direct jq if config.sh not available
    AUTO_ARCHIVE=$(jq -r '.archive.autoArchiveOnComplete // false' "$CONFIG_FILE")
  fi

  if [[ "$AUTO_ARCHIVE" == "true" ]]; then
    if [[ "$FORMAT" != "json" ]]; then
      echo ""
      log_info "Auto-archive is enabled, checking archive policy..."
    fi

    if [[ -f "$ARCHIVE_SCRIPT" ]]; then
      # Run archive script (suppress output for JSON mode)
      if [[ "$FORMAT" == "json" ]]; then
        "$ARCHIVE_SCRIPT" >/dev/null 2>&1 && ARCHIVED=true
      else
        "$ARCHIVE_SCRIPT" 2>&1 | sed 's/^/  /' || log_warn "Archive script encountered issues"
        ARCHIVED=true
      fi
    else
      [[ "$FORMAT" != "json" ]] && log_warn "Archive script not found at $ARCHIVE_SCRIPT"
    fi
  fi
fi

# Check for parent auto-complete functionality
AUTO_COMPLETED_PARENTS=()

# Read configuration with proper fallback
AUTO_COMPLETE_PARENT="false"
AUTO_COMPLETE_MODE="off"

# Check if config.sh library is available and loaded
if declare -f get_config_value >/dev/null 2>&1; then
  # Use config library (preferred method)
  AUTO_COMPLETE_PARENT=$(get_config_value "hierarchy.autoCompleteParent" "false")
  AUTO_COMPLETE_MODE=$(get_config_value "hierarchy.autoCompleteMode" "off")
elif [[ -f "$CONFIG_FILE" ]]; then
  # Fallback: direct JSON reading
  AUTO_COMPLETE_PARENT=$(jq -r '.hierarchy.autoCompleteParent // false' "$CONFIG_FILE")
  AUTO_COMPLETE_MODE=$(jq -r '.hierarchy.autoCompleteMode // "off"' "$CONFIG_FILE")
fi

# === SOLID/DRY REFACTOR: Parent Auto-Complete Functions ===

# Check if all siblings of a task are completed
# Args: $1 - parentId, $2 - currentTaskId, $3 - todoFile
# Returns: 0 if all siblings completed, 1 if any incomplete
all_siblings_completed() {
  local parent_id="$1"
  local current_task_id="$2"
  local todo_file="$3"
  
  # Check if any siblings are incomplete (pending, active, or blocked)
  local incomplete_siblings
  incomplete_siblings=$(jq --arg parentId "$parent_id" --arg currentId "$current_task_id" '
    .tasks[] | 
    select(.parentId == $parentId and .id != $currentId and 
           (.status == "pending" or .status == "active" or .status == "blocked"))
  ' "$todo_file")
  
  [[ -z "$incomplete_siblings" ]]
}

# Generate completion note based on auto-complete mode
# Args: $1 - mode (auto/suggest/off), $2 - timestamp, $3 - userConfirmed (optional)
# Returns: completion note or empty string
generate_completion_note() {
  local mode="$1"
  local timestamp="$2"
  local user_confirmed="${3:-false}"
  
  case "$mode" in
    "auto")
      echo "[AUTO-COMPLETED $timestamp] All child tasks completed"
      ;;
    "suggest")
      if [[ "$user_confirmed" == "true" ]]; then
        echo "[AUTO-COMPLETED $timestamp] All child tasks completed (user confirmed)"
      else
        # In suggest mode without confirmation, return empty to skip completion
        echo ""
      fi
      ;;
    "off")
      echo ""
      ;;
    *)
      echo ""
      ;;
  esac
}

# Prompt user for parent auto-complete confirmation (for suggest mode)
# Args: $1 - parentId, $2 - parentTitle, $3 - format
# Returns: 0 if user confirms, 1 if user declines
prompt_parent_completion() {
  local parent_id="$1"
  local parent_title="$2"
  local format="$3"
  
  # Skip prompting in JSON mode
  if [[ "$format" == "json" ]]; then
    return 0
  fi
  
  echo ""
  log_info "Parent task $parent_id is ready for completion (all children done)"
  echo -e "${BLUE}Parent:${NC} $parent_title"
  echo -e "${YELLOW}Auto-complete parent?${NC} [Y/n] "
  
  read -r -p "" response
  [[ ! "$response" =~ ^[Nn]$ ]]
}

# Complete a parent task and update the todo file
# Args: $1 - parentId, $2 - completionNote, $3 - timestamp, $4 - todoFile, $5 - format
# Returns: 0 on success, 1 on failure
complete_parent_task() {
  local parent_id="$1"
  local completion_note="$2"
  local timestamp="$3"
  local todo_file="$4"
  local format="$5"
  
  # Update parent task
  # T2067: updatedAt is set on all mutations per centralized mutation library
  local updated_tasks
  updated_tasks=$(jq --arg id "$parent_id" --arg ts "$timestamp" --arg note "$completion_note" '
    .tasks |= map(
      if .id == $id then
        .status = "done" |
        .completedAt = $ts |
        .updatedAt = $ts |
        del(.blockedBy) |
        .notes = ((.notes // []) + [$note])
      else . end
    )
  ' "$todo_file") || {
    [[ "$format" != "json" ]] && log_warn "Failed to auto-complete parent task $parent_id"
    return 1
  }
  
  # Verify updated tasks is valid JSON
  if [[ -z "$updated_tasks" ]] || ! echo "$updated_tasks" | jq empty 2>/dev/null; then
    [[ "$format" != "json" ]] && log_warn "Generated invalid JSON for parent task $parent_id"
    return 1
  fi
  
  # Generate fresh checksum for parent update
  local parent_tasks_json
  parent_tasks_json=$(echo "$updated_tasks" | jq -c '.tasks')
  local parent_checksum
  parent_checksum=$(echo "$parent_tasks_json" | sha256sum | cut -c1-16)
  
  # Update file with new checksum and lastUpdated
  local final_json
  final_json=$(echo "$updated_tasks" | jq --arg checksum "$parent_checksum" --arg ts "$timestamp" '
    ._meta.checksum = $checksum |
    .lastUpdated = $ts
  ')
  
  # Save the updated file
  if save_json "$todo_file" "$final_json"; then
    return 0
  else
    [[ "$format" != "json" ]] && log_warn "Failed to save updated todo file for parent $parent_id"
    return 1
  fi
}

# Log parent auto-completion operation
# Args: $1 - parentId, $2 - parentTask (JSON), $3 - timestamp, $4 - logScript
log_parent_completion() {
  local parent_id="$1"
  local parent_task="$2"
  local timestamp="$3"
  local log_script="$4"
  
  if [[ -f "$log_script" ]]; then
    local parent_before_state
    parent_before_state=$(echo "$parent_task" | jq '{status, completedAt}')
    local parent_after_state
    parent_after_state=$(echo "$parent_task" | jq --arg ts "$timestamp" '{status: "done", completedAt: $ts}')
    
    "$log_script" \
      --action "status_changed" \
      --task-id "$parent_id" \
      --before "$parent_before_state" \
      --after "$parent_after_state" \
      --details "{\"field\":\"status\",\"operation\":\"auto_complete\"}" \
      --actor "system" >/dev/null 2>&1 || true
  fi
}

# Handle auto-complete for a single parent task (non-recursive)
# Args: $1 - parentId, $2 - completedTaskId, $3 - todoFile, $4 - format, $5 - autoCompleteMode, $6 - timestamp
# Returns: 0 if parent was auto-completed, 1 if not
handle_single_parent_auto_complete() {
  local parent_id="$1"
  local completed_task_id="$2"
  local todo_file="$3"
  local format="$4"
  local auto_complete_mode="$5"
  local timestamp="$6"
  
  # Get parent task
  local parent_task
  parent_task=$(jq --arg id "$parent_id" '.tasks[] | select(.id == $id)' "$todo_file")
  
  # Return if parent doesn't exist
  [[ -z "$parent_task" ]] && return 1
  
  local parent_status
  parent_status=$(echo "$parent_task" | jq -r '.status')

  # Return if parent is already completed
  [[ ! "$parent_status" =~ ^(pending|active|blocked)$ ]] && return 1

  # Check if parent has noAutoComplete flag set (T1984)
  local no_auto_complete
  no_auto_complete=$(echo "$parent_task" | jq -r '.noAutoComplete // false')
  if [[ "$no_auto_complete" == "true" ]]; then
    [[ "$format" != "json" ]] && log_info "Parent auto-complete blocked: noAutoComplete flag set ($parent_id)"
    return 1
  fi

  # Check if all siblings are completed
  if ! all_siblings_completed "$parent_id" "$completed_task_id" "$todo_file"; then
    return 1
  fi

  # Check if verification is required for parent auto-complete (T1160)
  if declare -f require_verification_for_parent_auto_complete >/dev/null 2>&1; then
    if require_verification_for_parent_auto_complete; then
      # Verification required - check all siblings have verification.passed = true
      if ! all_siblings_verified "$parent_id" "$completed_task_id" "$todo_file"; then
        [[ "$format" != "json" ]] && log_info "Parent auto-complete blocked: not all children verified ($parent_id)"
        return 1
      fi
    fi
  fi

  # All conditions met, prepare for auto-completion
  local parent_title
  parent_title=$(echo "$parent_task" | jq -r '.title')
  local user_confirmed="false"
  local completion_note=""
  
  # Handle different modes
  if [[ "$auto_complete_mode" == "suggest" ]]; then
    # Prompt user for confirmation (skip in JSON mode)
    if [[ "$format" == "json" ]]; then
      user_confirmed="true"
    else
      if prompt_parent_completion "$parent_id" "$parent_title" "$format"; then
        user_confirmed="true"
      else
        # User declined, skip auto-complete
        [[ "$format" != "json" ]] && log_info "Parent auto-complete skipped by user"
        return 1
      fi
    fi
  elif [[ "$auto_complete_mode" == "auto" ]]; then
    user_confirmed="true"
  else
    # Mode is off, skip auto-complete
    return 1
  fi
  
  # Generate completion note
  completion_note=$(generate_completion_note "$auto_complete_mode" "$timestamp" "$user_confirmed")
  
  # Skip if no completion note (e.g., suggest mode without confirmation)
  [[ -z "$completion_note" ]] && return 1
  
  # Complete the parent task
  if complete_parent_task "$parent_id" "$completion_note" "$timestamp" "$todo_file" "$format"; then
    # Log the operation
    log_parent_completion "$parent_id" "$parent_task" "$timestamp" "$LOG_SCRIPT"
    
    # Output success message
    [[ "$format" != "json" ]] && log_info "Auto-completed parent task: $parent_id - $parent_title"
    
    # Return success
    return 0
  else
    return 1
  fi
}

# Recursive function to handle parent auto-complete with cascade
# Args: $1 - taskId, $2 - todoFile, $3 - format, $4 - autoCompleteMode, $5 - timestamp, $6 - autoCompletedParentsArrayName
# Returns: 0 on success, updates autoCompletedParents array
cascade_parent_auto_complete() {
  local task_id="$1"
  local todo_file="$2"
  local format="$3"
  local auto_complete_mode="$4"
  local timestamp="$5"
  local auto_completed_parents_array="$6"
  
  # Get parent ID of the current task
  local parent_id
  parent_id=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .parentId // ""' "$todo_file")
  
  # Return if no parent
  [[ -z "$parent_id" || "$parent_id" == "null" ]] && return 0
  
  # Try to auto-complete the parent
  if handle_single_parent_auto_complete "$parent_id" "$task_id" "$todo_file" "$format" "$auto_complete_mode" "$timestamp"; then
    # Add parent to auto-completed list
    eval "$auto_completed_parents_array+=(\"$parent_id\")"
    
    # Recursively check if the grandparent can also be auto-completed
    cascade_parent_auto_complete "$parent_id" "$todo_file" "$format" "$auto_complete_mode" "$timestamp" "$auto_completed_parents_array"
  fi
  
  return 0
}

# === SESSION-AWARE COMPLETION PROMPT ===
# Check if we're in an active session and all scope tasks are complete
# If so, prompt agent instead of auto-completing Epic
check_session_scope_completion() {
  local task_id="$1"
  local todo_file="$2"
  local format="$3"

  # Check if session enforcement is enabled and we have an active session
  if ! declare -f get_active_session_info >/dev/null 2>&1; then
    return 1  # Session lib not available
  fi

  local session_info
  session_info=$(get_active_session_info 2>/dev/null) || return 1

  # Get session scope (T4267: dynamic recomputation)
  local scope_ids
  if declare -f recompute_session_scope >/dev/null 2>&1; then
    scope_ids=$(recompute_session_scope "$session_info")
  else
    scope_ids=$(echo "$session_info" | jq -c '.scope.computedTaskIds // []')
  fi

  # Check if all tasks in scope are complete
  local incomplete_count
  incomplete_count=$(jq --argjson ids "$scope_ids" '
    [.tasks[] | select(.id as $id | $ids | index($id)) | select(.status != "done")] | length
  ' "$todo_file")

  if [[ "$incomplete_count" -gt 0 ]]; then
    return 1  # Still have incomplete tasks
  fi

  # Get root task (Epic) for the session
  local root_task_id
  root_task_id=$(echo "$session_info" | jq -r '.scope.rootTaskId // ""')

  if [[ -z "$root_task_id" ]]; then
    return 1  # No Epic in scope
  fi

  # All scope tasks complete - output completion prompt instead of auto-completing
  prompt_session_completion "$root_task_id" "$todo_file" "$format"
  return 0
}

# Prompt agent for session completion action
prompt_session_completion() {
  local epic_id="$1"
  local todo_file="$2"
  local format="$3"

  # Get Epic details
  local epic_task epic_title
  epic_task=$(jq --arg id "$epic_id" '.tasks[] | select(.id == $id)' "$todo_file")
  epic_title=$(echo "$epic_task" | jq -r '.title')

  if [[ "$format" == "json" ]]; then
    # JSON output with completion prompt for LLM agents
    jq -nc \
      --arg epicId "$epic_id" \
      --arg epicTitle "$epic_title" \
      --argjson epic "$epic_task" \
      '{
        "completionPrompt": true,
        "message": "All tasks in session scope complete",
        "epic": {
          "id": $epicId,
          "title": $epicTitle,
          "status": $epic.status
        },
        "options": [
          {
            "action": "close",
            "command": "cleo session close",
            "description": "Close session and mark Epic as complete"
          },
          {
            "action": "add_tasks",
            "command": "cleo add \"Task title\" --parent " + $epicId,
            "description": "Add more tasks to the Epic"
          },
          {
            "action": "review",
            "command": "cleo list --tree --parent " + $epicId,
            "description": "Review Epic tasks before closing"
          }
        ],
        "suggestion": "Review completed tasks and choose an action: close session, add more tasks, or continue review"
      }' >&2
  else
    # Human-readable prompt
    echo "" >&2
    echo -e "${YELLOW}[SESSION COMPLETE]${NC} All tasks in scope are done" >&2
    echo "" >&2
    echo -e "${BLUE}Epic:${NC} $epic_title ($epic_id)" >&2
    echo "" >&2
    echo "What would you like to do?" >&2
    echo "  1. Close session and complete Epic: cleo session close" >&2
    echo "  2. Add more tasks: cleo add \"Task\" --parent $epic_id" >&2
    echo "  3. Review tasks: cleo list --tree --parent $epic_id" >&2
    echo "" >&2
    echo -e "${YELLOW}Epic will not auto-complete until you close the session${NC}" >&2
  fi
}

# Handle parent auto-complete with recursive cascade using SOLID/DRY functions
# BUT: skip if session scope is complete (delegate to session close)
if [[ "$AUTO_COMPLETE_PARENT" == "true" && "$AUTO_COMPLETE_MODE" != "off" ]]; then
  # Check if we should prompt instead of auto-completing
  if ! check_session_scope_completion "$TASK_ID" "$TODO_FILE" "$FORMAT"; then
    # Not in session or scope not complete - proceed with normal auto-complete
    cascade_parent_auto_complete "$TASK_ID" "$TODO_FILE" "$FORMAT" "$AUTO_COMPLETE_MODE" "$TIMESTAMP" "AUTO_COMPLETED_PARENTS"
  else
    # Session scope complete - prompt was output, skip auto-complete
    [[ "$FORMAT" != "json" ]] && log_info "Session scope complete - Epic will be completed on session close"
  fi
fi
# End of refactored parent auto-complete section

# Output based on format
if [[ "$FORMAT" == "json" ]]; then
  # Build JSON output with all completion details
  AUTO_COMPLETED_JSON=$(printf '%s\n' "${AUTO_COMPLETED_PARENTS[@]}" | jq -R . | jq -s .)

  # Get verification status for output
  VERIFICATION_STATUS_OUT="null"
  if [[ "$VERIFICATION_UPDATED" == "true" ]]; then
    VERIFICATION_STATUS_OUT=$(jq --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .verification' "$TODO_FILE")
  fi

  jq -nc \
    --arg version "${CLEO_VERSION:-unknown}" \
    --arg timestamp "$TIMESTAMP" \
    --arg taskId "$TASK_ID" \
    --arg completedAt "$TIMESTAMP" \
    --arg cycleTime "${CYCLE_TIME_DAYS:-null}" \
    --argjson archived "$ARCHIVED" \
    --argjson focusCleared "$FOCUS_CLEARED" \
    --argjson verificationUpdated "$VERIFICATION_UPDATED" \
    --argjson verification "$VERIFICATION_STATUS_OUT" \
    --argjson task "$COMPLETED_TASK" \
    --argjson autoCompletedParents "$AUTO_COMPLETED_JSON" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "format": "json",
        "command": "complete",
        "timestamp": $timestamp,
        "version": $version
      },
      "success": true,
      "taskId": $taskId,
      "completedAt": $completedAt,
      "cycleTimeDays": (if $cycleTime == "null" then null else ($cycleTime | tonumber) end),
      "archived": $archived,
      "focusCleared": $focusCleared,
      "verificationUpdated": $verificationUpdated,
      "verification": $verification,
      "autoCompletedParents": $autoCompletedParents,
      "task": $task
    }'
else
  # Human-readable text output
  log_info "Task $TASK_ID marked as complete"
  echo ""
  echo -e "${BLUE}Task:${NC} $TASK_TITLE"
  echo -e "${BLUE}ID:${NC} $TASK_ID"
  echo -e "${BLUE}Status:${NC} $CURRENT_STATUS → done"
  echo -e "${BLUE}Completed:${NC} $TIMESTAMP"
  if [[ -n "$NOTES" ]]; then
    echo -e "${BLUE}Notes:${NC} $NOTES"
  fi
  if [[ -n "$CYCLE_TIME_DAYS" ]]; then
    echo -e "${BLUE}Cycle Time:${NC} ${CYCLE_TIME_DAYS} days"
  fi

  # Show verification status if updated
  if [[ "$VERIFICATION_UPDATED" == "true" ]]; then
    VERIF_PASSED=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .verification.passed // false' "$TODO_FILE")
    if [[ "$VERIF_PASSED" == "true" ]]; then
      echo -e "${BLUE}Verification:${NC} ${GREEN}passed${NC} (all required gates complete)"
    else
      MISSING_GATES=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .verification.gates | to_entries | map(select(.value != true)) | map(.key) | join(", ")' "$TODO_FILE")
      echo -e "${BLUE}Verification:${NC} ${YELLOW}in-progress${NC} (gates.implemented set, remaining: $MISSING_GATES)"
    fi
  fi

  # Show auto-completed parents if any
  if [[ ${#AUTO_COMPLETED_PARENTS[@]} -gt 0 ]]; then
    echo ""
    log_info "Auto-completed parent tasks:"
    for parent_id in "${AUTO_COMPLETED_PARENTS[@]}"; do
      PARENT_TASK=$(jq --arg id "$parent_id" '.tasks[] | select(.id == $id)' "$TODO_FILE")
      PARENT_TITLE=$(echo "$PARENT_TASK" | jq -r '.title')
      echo -e "  ${GREEN}✓${NC} $parent_id - $PARENT_TITLE"
    done
  fi
fi
