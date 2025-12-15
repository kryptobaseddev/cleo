#!/usr/bin/env bash
# CLAUDE-TODO Validate Script
# Validate todo.json against schema and business rules
set -uo pipefail
# Note: Not using -e because we track errors manually

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TODO_FILE="${TODO_FILE:-.claude/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.claude/todo-config.json}"
CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"

# Source logging library for should_use_color function
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  # shellcheck source=../lib/logging.sh
  source "$LIB_DIR/logging.sh"
fi

# Source validation library for circular dependency check
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
STRICT=false
FIX=false
JSON_OUTPUT=false
QUIET=false
FORMAT="text"

ERRORS=0
WARNINGS=0

usage() {
  cat << EOF
Usage: claude-todo validate [OPTIONS]

Validate todo.json against schema and business rules.

Options:
  --strict        Treat warnings as errors
  --fix           Auto-fix simple issues
  --json          Output as JSON (same as --format json)
  --format, -f    Output format: text (default) or json
  --quiet, -q     Suppress info messages (show only errors/warnings)
  -h, --help      Show this help

Validations:
  - JSON syntax
  - No duplicate task IDs (in todo.json, archive, and cross-file)
  - Only ONE active task
  - All depends[] references exist
  - No circular dependencies
  - blocked tasks have blockedBy
  - done tasks have completedAt
  - focus.currentTask matches active task
  - Checksum integrity
EOF
  exit 0
}

log_error() {
  # In JSON mode, don't output intermediate messages - only final summary
  if [[ "$JSON_OUTPUT" != true ]]; then
    echo -e "${RED}[ERROR]${NC} $1"
  fi
  ERRORS=$((ERRORS + 1))
}

log_warn() {
  # In JSON mode, don't output intermediate messages - only final summary
  if [[ "$JSON_OUTPUT" != true ]]; then
    echo -e "${YELLOW}[WARN]${NC} $1"
  fi
  WARNINGS=$((WARNINGS + 1))
}

log_info() {
  if [[ "$QUIET" == true ]]; then return; fi
  if [[ "$JSON_OUTPUT" != true ]]; then
    echo -e "${GREEN}[OK]${NC} $1"
  fi
}

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    echo "jq is required but not installed" >&2
    exit 1
  fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --strict) STRICT=true; shift ;;
    --fix) FIX=true; shift ;;
    --json) JSON_OUTPUT=true; FORMAT="json"; shift ;;
    --format|-f)
      FORMAT="$2"
      if [[ "$FORMAT" == "json" ]]; then
        JSON_OUTPUT=true
      fi
      shift 2
      ;;
    --quiet|-q) QUIET=true; shift ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) shift ;;
  esac
done

check_deps

# Check file exists
if [[ ! -f "$TODO_FILE" ]]; then
  log_error "File not found: $TODO_FILE"
  exit 1
fi

# 1. JSON syntax
if ! jq empty "$TODO_FILE" 2>/dev/null; then
  log_error "Invalid JSON syntax"
  exit 1
fi
log_info "JSON syntax valid"

# 2. Check for duplicate task IDs
ARCHIVE_FILE="${TODO_FILE%.json}-archive.json"
TASK_IDS=$(jq -r '.tasks[].id' "$TODO_FILE" 2>/dev/null || echo "")
DUPLICATE_IDS=$(echo "$TASK_IDS" | sort | uniq -d)

if [[ -n "$DUPLICATE_IDS" ]]; then
  log_error "Duplicate task IDs found in todo.json: $(echo "$DUPLICATE_IDS" | tr '\n' ', ' | sed 's/,$//')"
  if [[ "$FIX" == true ]]; then
    # Keep only first occurrence of each ID
    jq '
      .tasks |= (
        reduce .[] as $task ([];
          if (map(.id) | index($task.id) | not) then . + [$task] else . end
        )
      )
    ' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    echo "  Fixed: Removed duplicate tasks (kept first occurrence)"
  fi
else
  log_info "No duplicate task IDs in todo.json"
fi

# Check archive for duplicates too
if [[ -f "$ARCHIVE_FILE" ]]; then
  ARCHIVE_IDS=$(jq -r '.archivedTasks[].id' "$ARCHIVE_FILE" 2>/dev/null || echo "")
  ARCHIVE_DUPLICATES=$(echo "$ARCHIVE_IDS" | sort | uniq -d)

  if [[ -n "$ARCHIVE_DUPLICATES" ]]; then
    log_error "Duplicate IDs in archive: $(echo "$ARCHIVE_DUPLICATES" | tr '\n' ', ' | sed 's/,$//')"
    if [[ "$FIX" == true ]]; then
      # Keep only first occurrence in archive
      jq '
        .archivedTasks |= (
          reduce .[] as $task ([];
            if (map(.id) | index($task.id) | not) then . + [$task] else . end
          )
        )
      ' "$ARCHIVE_FILE" > "${ARCHIVE_FILE}.tmp" && mv "${ARCHIVE_FILE}.tmp" "$ARCHIVE_FILE"
      echo "  Fixed: Removed duplicate tasks from archive (kept first occurrence)"
    fi
  else
    log_info "No duplicate IDs in archive"
  fi

  # Check for IDs that exist in both active and archive
  if [[ -n "$TASK_IDS" ]] && [[ -n "$ARCHIVE_IDS" ]]; then
    CROSS_DUPLICATES=$(comm -12 <(echo "$TASK_IDS" | sort) <(echo "$ARCHIVE_IDS" | sort))
    if [[ -n "$CROSS_DUPLICATES" ]]; then
      log_error "IDs exist in both todo.json and archive: $(echo "$CROSS_DUPLICATES" | tr '\n' ', ' | sed 's/,$//')"
      if [[ "$FIX" == true ]]; then
        # Remove from archive (keep in active todo.json)
        for cross_id in $CROSS_DUPLICATES; do
          jq --arg id "$cross_id" '
            .archivedTasks |= map(select(.id != $id))
          ' "$ARCHIVE_FILE" > "${ARCHIVE_FILE}.tmp" && mv "${ARCHIVE_FILE}.tmp" "$ARCHIVE_FILE"
        done
        echo "  Fixed: Removed cross-duplicates from archive (kept in todo.json)"
      fi
    else
      log_info "No cross-file duplicate IDs"
    fi
  fi
fi

# 3. Check only ONE active task
ACTIVE_COUNT=$(jq '[.tasks[] | select(.status == "active")] | length' "$TODO_FILE")
if [[ "$ACTIVE_COUNT" -gt 1 ]]; then
  log_error "Multiple active tasks found ($ACTIVE_COUNT). Only ONE allowed."
  if [[ "$FIX" == true ]]; then
    # Keep only the first active task
    FIRST_ACTIVE=$(jq -r '[.tasks[] | select(.status == "active")][0].id' "$TODO_FILE")
    jq --arg keep "$FIRST_ACTIVE" '
      .tasks |= map(if .status == "active" and .id != $keep then .status = "pending" else . end)
    ' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    echo "  Fixed: Set all but $FIRST_ACTIVE to pending"
  fi
elif [[ "$ACTIVE_COUNT" -eq 1 ]]; then
  log_info "Single active task"
else
  log_info "No active tasks"
fi

# 4. Check all depends[] references exist
# Re-fetch TASK_IDS to get clean list after potential duplicate removal
TASK_IDS=$(jq -r '[.tasks[].id] | @json' "$TODO_FILE")
MISSING_DEPS=$(jq --argjson ids "$TASK_IDS" '
  [.tasks[] | select(.depends != null) | .depends[] | select(. as $d | $ids | index($d) | not)]
' "$TODO_FILE")
MISSING_COUNT=$(echo "$MISSING_DEPS" | jq 'length')
if [[ "$MISSING_COUNT" -gt 0 ]]; then
  log_error "Missing dependency references: $(echo "$MISSING_DEPS" | jq -r 'join(", ")')"
else
  log_info "All dependencies exist"
fi

# 5. Check for circular dependencies (full DFS)
CIRCULAR_DETECTED=false
while IFS=':' read -r task_id deps; do
  if [[ -n "$task_id" && -n "$deps" ]]; then
    if ! validate_no_circular_deps "$TODO_FILE" "$task_id" "$deps" 2>/dev/null; then
      # Capture error message for display (disable pipefail to avoid grep exit code issues)
      set +o pipefail
      ERROR_MSG=$(validate_no_circular_deps "$TODO_FILE" "$task_id" "$deps" 2>&1 | grep "ERROR:" | sed 's/ERROR: //')
      set -o pipefail
      log_error "$ERROR_MSG"
      CIRCULAR_DETECTED=true
    fi
  fi
done < <(jq -r '
  .tasks[] |
  select(has("depends") and (.depends | length > 0)) |
  "\(.id):\(.depends | join(","))"
' "$TODO_FILE")

if [[ "$CIRCULAR_DETECTED" != "true" ]]; then
  log_info "No circular dependencies"
fi

# 6. Check blocked tasks have blockedBy
BLOCKED_NO_REASON=$(jq '[.tasks[] | select(.status == "blocked" and (.blockedBy == null or .blockedBy == ""))] | length' "$TODO_FILE")
if [[ "$BLOCKED_NO_REASON" -gt 0 ]]; then
  log_error "$BLOCKED_NO_REASON blocked task(s) missing blockedBy reason"
else
  log_info "All blocked tasks have reasons"
fi

# 7. Check done tasks have completedAt
DONE_NO_DATE=$(jq '[.tasks[] | select(.status == "done" and (.completedAt == null or .completedAt == ""))] | length' "$TODO_FILE")
if [[ "$DONE_NO_DATE" -gt 0 ]]; then
  log_error "$DONE_NO_DATE done task(s) missing completedAt"
  if [[ "$FIX" == true ]]; then
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq --arg now "$NOW" '
      .tasks |= map(if .status == "done" and (.completedAt == null or .completedAt == "") then .completedAt = $now else . end)
    ' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    echo "  Fixed: Set completedAt to now"
  fi
else
  log_info "All done tasks have completedAt"
fi

# 7.5. Check schema version compatibility
# Check _meta.version first, fall back to root .version
SCHEMA_VERSION=$(jq -r '._meta.version // .version // ""' "$TODO_FILE")
EXPECTED_MAJOR=2
DEFAULT_VERSION="2.0.0"

if [[ -n "$SCHEMA_VERSION" ]]; then
  # Extract major version (first number before dot)
  MAJOR_VERSION=$(echo "$SCHEMA_VERSION" | cut -d. -f1)

  if [[ "$MAJOR_VERSION" != "$EXPECTED_MAJOR" ]]; then
    log_error "Incompatible schema version: $SCHEMA_VERSION (expected major version $EXPECTED_MAJOR)"
  else
    log_info "Schema version compatible ($SCHEMA_VERSION)"
  fi
else
  if [[ "$FIX" == true ]]; then
    jq --arg ver "$DEFAULT_VERSION" '._meta.version = $ver' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    echo "  Fixed: Added _meta.version = $DEFAULT_VERSION"
    log_info "Schema version compatible ($DEFAULT_VERSION) (after fix)"
  else
    log_warn "No schema version found. Run with --fix to add _meta.version"
  fi
fi

# 7.6. Check required task fields
MISSING_FIELD_COUNT=0
while IFS= read -r task_index; do
  TASK_ID=$(jq -r ".tasks[$task_index].id // \"(unknown)\"" "$TODO_FILE")

  # Check for required fields per schema: id, title, status, priority, createdAt
  MISSING_FIELDS=()

  if ! jq -e ".tasks[$task_index].id" "$TODO_FILE" >/dev/null 2>&1; then
    MISSING_FIELDS+=("id")
  fi
  if ! jq -e ".tasks[$task_index].title" "$TODO_FILE" >/dev/null 2>&1; then
    MISSING_FIELDS+=("title")
  fi
  if ! jq -e ".tasks[$task_index].status" "$TODO_FILE" >/dev/null 2>&1; then
    MISSING_FIELDS+=("status")
  fi
  if ! jq -e ".tasks[$task_index].priority" "$TODO_FILE" >/dev/null 2>&1; then
    MISSING_FIELDS+=("priority")
  fi
  if ! jq -e ".tasks[$task_index].createdAt" "$TODO_FILE" >/dev/null 2>&1; then
    MISSING_FIELDS+=("createdAt")
  fi

  if [[ ${#MISSING_FIELDS[@]} -gt 0 ]]; then
    log_error "Task $TASK_ID missing required fields: ${MISSING_FIELDS[*]}"
    ((MISSING_FIELD_COUNT++))
  fi
done < <(jq -r 'range(0; .tasks | length)' "$TODO_FILE")

if [[ "$MISSING_FIELD_COUNT" -eq 0 ]]; then
  log_info "All tasks have required fields"
fi

# 8. Check focus.currentTask matches active task
FOCUS_TASK=$(jq -r '.focus.currentTask // ""' "$TODO_FILE")
ACTIVE_TASK=$(jq -r '[.tasks[] | select(.status == "active")][0].id // ""' "$TODO_FILE")
if [[ -n "$FOCUS_TASK" ]] && [[ "$FOCUS_TASK" != "$ACTIVE_TASK" ]]; then
  log_error "focus.currentTask ($FOCUS_TASK) doesn't match active task ($ACTIVE_TASK)"
  if [[ "$FIX" == true ]]; then
    if [[ -n "$ACTIVE_TASK" ]]; then
      jq --arg task "$ACTIVE_TASK" '.focus.currentTask = $task' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
      echo "  Fixed: Set focus.currentTask to $ACTIVE_TASK"
    else
      jq '.focus.currentTask = null' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
      echo "  Fixed: Cleared focus.currentTask"
    fi
  fi
elif [[ -z "$FOCUS_TASK" ]] && [[ -n "$ACTIVE_TASK" ]]; then
  log_warn "Active task ($ACTIVE_TASK) but focus.currentTask is null"
  if [[ "$FIX" == true ]]; then
    jq --arg task "$ACTIVE_TASK" '.focus.currentTask = $task' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    echo "  Fixed: Set focus.currentTask to $ACTIVE_TASK"
  fi
else
  log_info "Focus matches active task"
fi

# 9. Verify checksum
STORED_CHECKSUM=$(jq -r '._meta.checksum // ""' "$TODO_FILE")
if [[ -n "$STORED_CHECKSUM" ]]; then
  COMPUTED_CHECKSUM=$(jq -c '.tasks' "$TODO_FILE" | sha256sum | cut -c1-16)
  if [[ "$STORED_CHECKSUM" != "$COMPUTED_CHECKSUM" ]]; then
    if [[ "$FIX" == true ]]; then
      # Don't log error yet - try to fix first
      if jq --arg cs "$COMPUTED_CHECKSUM" '._meta.checksum = $cs' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"; then
        echo "  Fixed: Updated checksum (was: $STORED_CHECKSUM, now: $COMPUTED_CHECKSUM)"
        log_info "Checksum valid (after fix)"
      else
        log_error "Checksum mismatch: stored=$STORED_CHECKSUM, computed=$COMPUTED_CHECKSUM (fix failed)"
      fi
    else
      log_error "Checksum mismatch: stored=$STORED_CHECKSUM, computed=$COMPUTED_CHECKSUM"
    fi
  else
    log_info "Checksum valid"
  fi
else
  log_warn "No checksum found"
fi

# 10. WARNINGS: Stale tasks
STALE_DAYS=30
STALE_THRESHOLD=$(($(date +%s) - STALE_DAYS * 86400))
STALE_TASKS=$(jq --argjson threshold "$STALE_THRESHOLD" '
  [.tasks[] | select(.status == "pending" and .createdAt != null and ((.createdAt | fromdateiso8601) < $threshold))]
' "$TODO_FILE" 2>/dev/null || echo "[]")
STALE_COUNT=$(echo "$STALE_TASKS" | jq 'length')
if [[ "$STALE_COUNT" -gt 0 ]]; then
  log_warn "$STALE_COUNT task(s) pending for >$STALE_DAYS days"
fi

# 11. Check CLAUDE.md injection version
if [[ -f "CLAUDE.md" ]] && [[ -f "$CLAUDE_TODO_HOME/templates/CLAUDE-INJECTION.md" ]]; then
  # Check for versioned tag first, then unversioned (legacy)
  CURRENT_INJECTION_VERSION=$(grep -oP 'CLAUDE-TODO:START v\K[0-9.]+' CLAUDE.md 2>/dev/null || echo "")
  HAS_LEGACY_INJECTION=$(grep -q 'CLAUDE-TODO:START' CLAUDE.md 2>/dev/null && echo "true" || echo "false")
  INSTALLED_INJECTION_VERSION=$(grep -oP 'CLAUDE-TODO:START v\K[0-9.]+' "$CLAUDE_TODO_HOME/templates/CLAUDE-INJECTION.md" 2>/dev/null || echo "")

  if [[ -z "$CURRENT_INJECTION_VERSION" ]] && [[ "$HAS_LEGACY_INJECTION" == "true" ]]; then
    # Has unversioned legacy injection - needs update
    if [[ "$FIX" == true ]]; then
      "$CLAUDE_TODO_HOME/scripts/init.sh" --update-claude-md 2>/dev/null
      NEW_VERSION=$(grep -oP 'CLAUDE-TODO:START v\K[0-9.]+' CLAUDE.md 2>/dev/null || echo "")
      if [[ "$NEW_VERSION" == "$INSTALLED_INJECTION_VERSION" ]]; then
        echo "  Fixed: Updated legacy CLAUDE.md injection (unversioned → v${INSTALLED_INJECTION_VERSION})"
        log_info "CLAUDE.md injection current (v${INSTALLED_INJECTION_VERSION})"
      else
        log_warn "CLAUDE.md has legacy (unversioned) injection. Run: claude-todo init --update-claude-md"
      fi
    else
      log_warn "CLAUDE.md has legacy (unversioned) injection. Run with --fix or: claude-todo init --update-claude-md"
    fi
  elif [[ -z "$CURRENT_INJECTION_VERSION" ]]; then
    # No injection at all
    if [[ "$FIX" == true ]]; then
      "$CLAUDE_TODO_HOME/scripts/init.sh" --update-claude-md 2>/dev/null
      if grep -qP 'CLAUDE-TODO:START v[0-9.]+' CLAUDE.md 2>/dev/null; then
        echo "  Fixed: Added CLAUDE.md injection (v${INSTALLED_INJECTION_VERSION})"
        log_info "CLAUDE.md injection current (v${INSTALLED_INJECTION_VERSION})"
      else
        log_warn "No CLAUDE-TODO injection found in CLAUDE.md. Run: claude-todo init --update-claude-md"
      fi
    else
      log_warn "No CLAUDE-TODO injection found in CLAUDE.md. Run with --fix or: claude-todo init --update-claude-md"
    fi
  elif [[ -n "$INSTALLED_INJECTION_VERSION" ]] && [[ "$CURRENT_INJECTION_VERSION" != "$INSTALLED_INJECTION_VERSION" ]]; then
    # Has versioned injection but outdated
    if [[ "$FIX" == true ]]; then
      "$CLAUDE_TODO_HOME/scripts/init.sh" --update-claude-md 2>/dev/null
      NEW_VERSION=$(grep -oP 'CLAUDE-TODO:START v\K[0-9.]+' CLAUDE.md 2>/dev/null || echo "")
      if [[ "$NEW_VERSION" == "$INSTALLED_INJECTION_VERSION" ]]; then
        echo "  Fixed: Updated CLAUDE.md injection (${CURRENT_INJECTION_VERSION} → ${INSTALLED_INJECTION_VERSION})"
        log_info "CLAUDE.md injection current (v${INSTALLED_INJECTION_VERSION})"
      else
        log_warn "CLAUDE.md injection outdated (${CURRENT_INJECTION_VERSION} → ${INSTALLED_INJECTION_VERSION}). Run: claude-todo init --update-claude-md"
      fi
    else
      log_warn "CLAUDE.md injection outdated (${CURRENT_INJECTION_VERSION} → ${INSTALLED_INJECTION_VERSION}). Run with --fix or: claude-todo init --update-claude-md"
    fi
  else
    log_info "CLAUDE.md injection current (v${CURRENT_INJECTION_VERSION})"
  fi
elif [[ -f "CLAUDE.md" ]]; then
  # CLAUDE.md exists but no injection template to compare against
  HAS_LEGACY_INJECTION=$(grep -q 'CLAUDE-TODO:START' CLAUDE.md 2>/dev/null && echo "true" || echo "false")
  CURRENT_INJECTION_VERSION=$(grep -oP 'CLAUDE-TODO:START v\K[0-9.]+' CLAUDE.md 2>/dev/null || echo "")
  if [[ -n "$CURRENT_INJECTION_VERSION" ]]; then
    log_info "CLAUDE.md injection present (v${CURRENT_INJECTION_VERSION})"
  elif [[ "$HAS_LEGACY_INJECTION" == "true" ]]; then
    log_warn "CLAUDE.md has legacy (unversioned) injection. Run with --fix or: claude-todo init --update-claude-md"
  else
    log_warn "CLAUDE.md exists but has no claude-todo injection. Run with --fix or: claude-todo init --update-claude-md"
  fi
fi

# Summary
if [[ "$FORMAT" == "json" ]]; then
  # Don't print blank line for JSON output
  # Get version from config or default
  VERSION=$(jq -r '._meta.version // "0.8.3"' "$TODO_FILE" 2>/dev/null || echo "0.8.3")
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  VALID=$([[ $ERRORS -eq 0 ]] && echo "true" || echo "false")

  jq -n \
    --argjson errors "$ERRORS" \
    --argjson warnings "$WARNINGS" \
    --argjson valid "$VALID" \
    --arg version "$VERSION" \
    --arg timestamp "$TIMESTAMP" \
    '{
      "_meta": {
        "format": "json",
        "version": $version,
        "command": "validate",
        "timestamp": $timestamp
      },
      "valid": $valid,
      "errors": $errors,
      "warnings": $warnings,
      "details": []
    }'

  # Exit with appropriate code
  if [[ "$ERRORS" -eq 0 ]]; then
    exit 0
  else
    exit 1
  fi
else
  # Add blank line before text summary
  echo ""
  if [[ "$ERRORS" -eq 0 ]]; then
    echo -e "${GREEN}Validation passed${NC} ($WARNINGS warnings)"
    exit 0
  else
    echo -e "${RED}Validation failed${NC} ($ERRORS errors, $WARNINGS warnings)"
    if [[ "$STRICT" == true ]] && [[ "$WARNINGS" -gt 0 ]]; then
      exit 1
    fi
    exit 1
  fi
fi
