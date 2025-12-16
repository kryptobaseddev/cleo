#!/usr/bin/env bash
# CLAUDE-TODO Archive Script
# Archive completed tasks based on config rules
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"

# Source version from central location
if [[ -f "$CLAUDE_TODO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLAUDE_TODO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="0.1.0"
fi

TODO_FILE="${TODO_FILE:-.claude/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.claude/todo-archive.json}"
CONFIG_FILE="${CONFIG_FILE:-.claude/todo-config.json}"
LOG_FILE="${LOG_FILE:-.claude/todo-log.json}"

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

usage() {
  cat << EOF
Usage: claude-todo archive [OPTIONS]

Archive completed tasks from todo.json to todo-archive.json.

Options:
  --dry-run       Preview without making changes
  --force         Bypass age-based retention (archive immediately)
                  Still respects preserveRecentCount setting
  --all           Archive ALL completed tasks immediately
                  Bypasses BOTH age retention AND preserveRecentCount
  --count N       Override maxCompletedTasks setting
  -h, --help      Show this help

Archive Behavior:
  Default:  Only archive tasks older than daysUntilArchive (default 7 days)
            Keeps preserveRecentCount most recent completed tasks (default 3)

  --force:  Ignores daysUntilArchive - archives regardless of age
            Still keeps preserveRecentCount tasks (safe for recent work)

  --all:    Archives everything marked 'done' without exceptions
            Use with caution - removes ALL completed tasks

Config (from todo-config.json):
  - daysUntilArchive: Days after completion before archiving (default: 7)
  - maxCompletedTasks: Threshold triggering archive prompt (default: 15)
  - preserveRecentCount: Recent completions to keep (default: 3)

Examples:
  claude-todo archive               # Archive based on config rules
  claude-todo archive --dry-run     # Preview what would be archived
  claude-todo archive --force       # Archive all, keep 3 most recent
  claude-todo archive --all         # Archive everything (nuclear option)
EOF
  exit 0
}

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    exit 1
  fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --force) FORCE=true; shift ;;
    --all) ARCHIVE_ALL=true; shift ;;
    --count) MAX_OVERRIDE="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) log_error "Unknown option: $1"; exit 1 ;;
    *) shift ;;
  esac
done

check_deps

# Check files exist
for f in "$TODO_FILE" "$CONFIG_FILE"; do
  if [[ ! -f "$f" ]]; then
    log_error "$f not found"
    exit 1
  fi
done

# Create archive file if missing
if [[ ! -f "$ARCHIVE_FILE" ]]; then
  # v2.2.0+: .project is an object with .name; v2.1.x: .project was a string
  PROJECT_NAME=$(jq -r '.project.name // .project // "unknown"' "$TODO_FILE")
  cat > "$ARCHIVE_FILE" << EOF
{
  "version": "$VERSION",
  "project": "$PROJECT_NAME",
  "_meta": { "totalArchived": 0, "lastArchived": null, "oldestTask": null, "newestTask": null },
  "archivedTasks": [],
  "statistics": { "byPhase": {}, "byPriority": {"critical":0,"high":0,"medium":0,"low":0}, "byLabel": {}, "averageCycleTime": null }
}
EOF
  log_info "Created $ARCHIVE_FILE"
fi

# Read config
DAYS_UNTIL_ARCHIVE=$(jq -r '.archive.daysUntilArchive // 7' "$CONFIG_FILE")
MAX_COMPLETED=$(jq -r '.archive.maxCompletedTasks // 15' "$CONFIG_FILE")
PRESERVE_COUNT=$(jq -r '.archive.preserveRecentCount // 3' "$CONFIG_FILE")

[[ -n "$MAX_OVERRIDE" ]] && MAX_COMPLETED="$MAX_OVERRIDE"

if [[ "$ARCHIVE_ALL" == true ]]; then
  log_warn "Mode: --all (bypassing retention AND preserve count)"
elif [[ "$FORCE" == true ]]; then
  log_info "Mode: --force (bypassing retention, preserving $PRESERVE_COUNT recent)"
else
  log_info "Config: daysUntilArchive=$DAYS_UNTIL_ARCHIVE, maxCompleted=$MAX_COMPLETED, preserve=$PRESERVE_COUNT"
fi

# Get completed tasks
COMPLETED_TASKS=$(jq '[.tasks[] | select(.status == "done")]' "$TODO_FILE")
COMPLETED_COUNT=$(echo "$COMPLETED_TASKS" | jq 'length')

log_info "Found $COMPLETED_COUNT completed tasks"

if [[ "$COMPLETED_COUNT" -eq 0 ]]; then
  log_info "No completed tasks to archive"
  exit 0
fi

# Calculate which tasks to archive
NOW=$(date +%s)
ARCHIVE_THRESHOLD=$((NOW - DAYS_UNTIL_ARCHIVE * 86400))

# Sort by completedAt (newest first) and determine which to archive
TASKS_TO_ARCHIVE=$(echo "$COMPLETED_TASKS" | jq --argjson threshold "$ARCHIVE_THRESHOLD" --argjson preserve "$PRESERVE_COUNT" --argjson force "$FORCE" --argjson all "$ARCHIVE_ALL" '
  sort_by(.completedAt) | reverse |
  to_entries |
  map(select(
    if $all then
      true  # Archive ALL completed tasks
    elif $force then
      .key >= $preserve  # Bypass retention, respect preserve count
    else
      .key >= $preserve and
      ((.value.completedAt | fromdateiso8601) < $threshold)
    end
  )) |
  map(.value)
')

ARCHIVE_COUNT=$(echo "$TASKS_TO_ARCHIVE" | jq 'length')

if [[ "$ARCHIVE_COUNT" -eq 0 ]]; then
  log_info "No tasks eligible for archiving (all within retention period or preserved)"
  exit 0
fi

log_info "Tasks to archive: $ARCHIVE_COUNT"

if [[ "$DRY_RUN" == true ]]; then
  echo ""
  echo "DRY RUN - Would archive these tasks:"
  echo "$TASKS_TO_ARCHIVE" | jq -r '.[] | "  - \(.id): \(.title)"'
  echo ""
  echo "No changes made."
  exit 0
fi

# Get task IDs to archive
ARCHIVE_IDS=$(echo "$TASKS_TO_ARCHIVE" | jq -r '.[].id')

# Add archive metadata to tasks
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION_ID=$(jq -r '._meta.activeSession // "system"' "$TODO_FILE")

TASKS_WITH_METADATA=$(echo "$TASKS_TO_ARCHIVE" | jq --arg ts "$TIMESTAMP" --arg sid "$SESSION_ID" '
  map(. + {
    "_archive": {
      "archivedAt": $ts,
      "reason": "auto",
      "sessionId": $sid,
      "cycleTimeDays": (
        if .completedAt and .createdAt then
          (((.completedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)) / 86400 | floor)
        else null end
      )
    }
  })
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

# Step 1: Generate archive file update
if ! jq --argjson tasks "$TASKS_WITH_METADATA" --arg ts "$TIMESTAMP" '
  .archivedTasks += $tasks |
  ._meta.totalArchived += ($tasks | length) |
  ._meta.lastArchived = $ts |
  ._meta.newestTask = ($tasks | max_by(.completedAt) | .completedAt) |
  ._meta.oldestTask = (if ._meta.oldestTask then ._meta.oldestTask else ($tasks | min_by(.completedAt) | .completedAt) end)
' "$ARCHIVE_FILE" > "$ARCHIVE_TMP"; then
  log_error "Failed to generate archive update"
  exit 1
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

if ! jq --argjson tasks "$REMAINING_TASKS" --arg checksum "$NEW_CHECKSUM" --arg ts "$TIMESTAMP" '
  .tasks = $tasks |
  ._meta.checksum = $checksum |
  .lastUpdated = $ts
' "$TODO_FILE" > "$TODO_TMP"; then
  log_error "Failed to generate todo update"
  exit 1
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
    log_error "Failed to generate log update"
    exit 1
  fi
fi

# Step 4: Validate ALL generated JSON files before committing
for temp_file in "$ARCHIVE_TMP" "$TODO_TMP" ${LOG_TMP:+"$LOG_TMP"}; do
  if [[ ! -f "$temp_file" ]]; then
    continue
  fi

  if ! jq empty "$temp_file" 2>/dev/null; then
    log_error "Generated invalid JSON: $temp_file"
    cat "$temp_file" >&2
    exit 1
  fi
done

# Step 5: Create archive backup before committing changes using unified backup library
if declare -f create_archive_backup >/dev/null 2>&1; then
  BACKUP_PATH=$(create_archive_backup 2>&1) || {
    log_warn "Backup library failed, using fallback backup method"
    # Fallback to inline backup if library fails
    BACKUP_SUFFIX=".backup.$(date +%s)"
    cp "$ARCHIVE_FILE" "${ARCHIVE_FILE}${BACKUP_SUFFIX}"
    cp "$TODO_FILE" "${TODO_FILE}${BACKUP_SUFFIX}"
    [[ -f "$LOG_FILE" ]] && cp "$LOG_FILE" "${LOG_FILE}${BACKUP_SUFFIX}"
  }
  if [[ -n "$BACKUP_PATH" ]]; then
    log_info "Archive backup created: $BACKUP_PATH"
  fi
else
  # Fallback if backup library not available
  BACKUP_SUFFIX=".backup.$(date +%s)"
  cp "$ARCHIVE_FILE" "${ARCHIVE_FILE}${BACKUP_SUFFIX}"
  cp "$TODO_FILE" "${TODO_FILE}${BACKUP_SUFFIX}"
  [[ -f "$LOG_FILE" ]] && cp "$LOG_FILE" "${LOG_FILE}${BACKUP_SUFFIX}"
fi

# Step 6: Atomic commit - move all temp files to final locations
mv "$ARCHIVE_TMP" "$ARCHIVE_FILE"
mv "$TODO_TMP" "$TODO_FILE"
[[ -f "$LOG_TMP" ]] && mv "$LOG_TMP" "$LOG_FILE"

# Remove trap since we succeeded
trap - EXIT

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
fi
