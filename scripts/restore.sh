#!/usr/bin/env bash
###CLEO
# command: restore
# category: maintenance
# synopsis: Restore todo files from backup
# relevance: low
# flags: --format,--quiet,--dry-run
# exits: 0,3,4
# json-output: true
###END
# CLEO Restore Script
# Restore todo system files from backup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.cleo/todo-archive.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
LOG_FILE="${LOG_FILE:-.cleo/todo-log.json}"
BACKUP_DIR="${BACKUP_DIR:-.cleo/backups}"

# Source logging library for should_use_color function
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source version library for proper version management
if [[ -f "$LIB_DIR/core/version.sh" ]]; then
  # shellcheck source=../lib/core/version.sh
  source "$LIB_DIR/core/version.sh"
fi

# Source version from central location (fallback)
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

if [[ -f "$LIB_DIR/core/logging.sh" ]]; then
  # shellcheck source=../lib/core/logging.sh
  source "$LIB_DIR/core/logging.sh"
fi

# Source output formatting and error libraries
if [[ -f "$LIB_DIR/core/output-format.sh" ]]; then
  # shellcheck source=../lib/core/output-format.sh
  source "$LIB_DIR/core/output-format.sh"
fi
if [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
  # shellcheck source=../lib/core/exit-codes.sh
  source "$LIB_DIR/core/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
  # shellcheck source=../lib/core/error-json.sh
  source "$LIB_DIR/core/error-json.sh"
fi

# Source config library for unified config access (v0.24.0)
if [[ -f "$LIB_DIR/core/config.sh" ]]; then
  # shellcheck source=../lib/core/config.sh
  source "$LIB_DIR/core/config.sh"
fi

# Source centralized flag parsing
source "$LIB_DIR/ui/flags.sh"

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
BACKUP_SOURCE=""
TARGET_FILE=""
FORCE=false
VERBOSE=false
FORMAT=""
QUIET=false
DRY_RUN=false
COMMAND_NAME="restore"

usage() {
  cat << EOF
Usage: $(basename "$0") <backup-source> [OPTIONS]

Restore todo system files from a backup with validation and rollback.

Arguments:
  backup-source       Path to backup directory or tarball

Options:
  --file FILE         Restore specific file only (todo.json, todo-archive.json, etc.)
  --force             Skip confirmation prompt
  --dry-run           Preview what would be restored without making changes
  --verbose           Show detailed output
  -f, --format FMT    Output format: text, json (default: auto-detect)
  --human             Force human-readable text output
  --json              Force JSON output
  -q, --quiet         Suppress non-essential output
  -h, --help          Show this help

Safety:
  - Creates safety backup before restore
  - Validates backup integrity before applying
  - Rolls back on validation failure
  - Atomic operations prevent data loss

JSON Output:
  {
    "_meta": {"command": "restore", "timestamp": "..."},
    "success": true,
    "restored": {"from": "/path/to/backup", "files": [...], "tasksCount": 15}
  }

Examples:
  $(basename "$0") .cleo/backups/snapshot/snapshot_20251205_120000
  $(basename "$0") /path/to/backup.tar.gz --force
  $(basename "$0") .cleo/backups/safety/safety_20251205_120000_update_todo.json --file todo.json
  $(basename "$0") backup_20251205 --dry-run    # Preview restore
  $(basename "$0") backup_20251205 --json       # JSON output for scripting
EOF
  exit "$EXIT_SUCCESS"
}

log_info()  { [[ "$QUIET" != true && "$FORMAT" != "json" ]] && echo -e "${GREEN}[INFO]${NC} $1" || true; }
log_warn()  { [[ "$FORMAT" != "json" ]] && echo -e "${YELLOW}[WARN]${NC} $1" || true; }
log_error() { [[ "$FORMAT" != "json" ]] && echo -e "${RED}[ERROR]${NC} $1" >&2 || true; }
log_debug() { [[ "$VERBOSE" == true && "$FORMAT" != "json" ]] && echo -e "${BLUE}[DEBUG]${NC} $1" || true; }

# Check dependencies
check_deps() {
  if ! command -v jq &> /dev/null; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed" "${EXIT_DEPENDENCY_ERROR:-5}" false "Install jq: apt install jq (Debian) or brew install jq (macOS)"
    else
      log_error "jq is required but not installed"
    fi
    exit "${EXIT_DEPENDENCY_ERROR:-1}"
  fi
}

# Validate JSON file integrity
validate_json() {
  local file="$1"
  local name="$2"

  if [[ ! -f "$file" ]]; then
    log_error "$name not found"
    return 1
  fi

  if ! jq empty "$file" 2>/dev/null; then
    log_error "$name has invalid JSON syntax"
    return 1
  fi

  log_debug "$name validated successfully"
  return 0
}

# Validate backup source
validate_backup_source() {
  local source="$1"

  if [[ ! -e "$source" ]]; then
    log_error "Backup source does not exist: $source"
    return 1
  fi

  # Check if it's a tarball
  if [[ -f "$source" ]] && [[ "$source" =~ \.tar\.gz$ ]]; then
    if ! tar -tzf "$source" &> /dev/null; then
      log_error "Invalid or corrupted tarball: $source"
      return 1
    fi
    log_debug "Valid tarball backup detected"
    return 0
  fi

  # Check if it's a directory
  if [[ -d "$source" ]]; then
    # Look for at least one JSON file
    if ! ls "$source"/*.json &> /dev/null; then
      log_error "No JSON files found in backup directory: $source"
      return 1
    fi
    log_debug "Valid directory backup detected"
    return 0
  fi

  log_error "Backup source must be a directory or .tar.gz file: $source"
  return 1
}

# Extract tarball to temporary directory
extract_tarball() {
  local tarball="$1"
  local temp_dir
  temp_dir=$(mktemp -d)

  log_info "Extracting tarball..."
  if ! tar -xzf "$tarball" -C "$temp_dir" 2>/dev/null; then
    log_error "Failed to extract tarball"
    rm -rf "$temp_dir"
    return 1
  fi

  # Find the backup directory inside temp_dir
  local backup_subdir
  backup_subdir=$(find "$temp_dir" -maxdepth 1 -type d -name "backup_*" | head -n 1)

  if [[ -z "$backup_subdir" ]]; then
    log_error "No backup directory found in tarball"
    rm -rf "$temp_dir"
    return 1
  fi

  echo "$backup_subdir"
}

# Get backup metadata if available
get_backup_metadata() {
  local source="$1"
  local metadata_file="${source}/backup-metadata.json"

  if [[ -f "$metadata_file" ]] && validate_json "$metadata_file" "metadata"; then
    echo "$metadata_file"
  else
    echo ""
  fi
}

# Display backup information
show_backup_info() {
  local source="$1"
  local metadata

  metadata=$(get_backup_metadata "$source")

  echo ""
  echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║                  BACKUP INFORMATION                      ║${NC}"
  echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""

  if [[ -n "$metadata" ]]; then
    echo -e "  ${BLUE}Backup Name:${NC} $(jq -r '.backupName // "unknown"' "$metadata")"
    echo -e "  ${BLUE}Timestamp:${NC} $(jq -r '.timestamp // "unknown"' "$metadata")"
    echo -e "  ${BLUE}Created By:${NC} $(jq -r '.user // "unknown"' "$metadata")@$(jq -r '.hostname // "unknown"' "$metadata")"
    echo ""
    echo -e "  ${BLUE}Files:${NC}"
    jq -r '.files[]? // empty' "$metadata" | while read -r file; do
      echo -e "    ✓ $file"
    done
  else
    echo -e "  ${BLUE}Backup Location:${NC} $source"
    echo ""
    echo -e "  ${BLUE}Files:${NC}"
    for file in "$source"/*.json; do
      if [[ -f "$file" ]] && [[ "$(basename "$file")" != "backup-metadata.json" ]]; then
        echo -e "    ✓ $(basename "$file")"
      fi
    done
  fi
  echo ""
}

# Confirm restore operation
confirm_restore() {
  if [[ "$FORCE" == true ]]; then
    return 0
  fi

  echo -e "${YELLOW}⚠  WARNING: This will overwrite current todo system files!${NC}"
  echo ""
  read -p "Are you sure you want to restore from this backup? (yes/no): " -r
  echo ""

  if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    log_info "Restore cancelled by user"
    exit "$EXIT_SUCCESS"
  fi
}

# Create safety backup before restore
create_safety_backup() {
  local safety_dir="${BACKUP_DIR}/pre-restore_$(date +"%Y%m%d_%H%M%S")"

  log_info "Creating safety backup before restore..."
  mkdir -p "$safety_dir"

  local backed_up=0

  for file in "$TODO_FILE" "$ARCHIVE_FILE" "$CONFIG_FILE" "$LOG_FILE"; do
    if [[ -f "$file" ]]; then
      cp "$file" "$safety_dir/$(basename "$file")"
      ((backed_up++))
      log_debug "Backed up $(basename "$file")"
    fi
  done

  if [[ $backed_up -eq 0 ]]; then
    rmdir "$safety_dir" 2>/dev/null || true
    log_warn "No existing files to backup"
    echo ""
  else
    log_info "Safety backup created: $safety_dir"
    echo "$safety_dir"
  fi
}

# Restore single file
restore_file() {
  local source_file="$1"
  local target_file="$2"
  local file_name
  file_name=$(basename "$source_file")

  if [[ ! -f "$source_file" ]]; then
    log_warn "$file_name not found in backup, skipping"
    return 0
  fi

  # Validate source file
  if ! validate_json "$source_file" "$file_name"; then
    log_error "Backup file validation failed: $file_name"
    return 1
  fi

  # Create target directory if needed
  local target_dir
  target_dir=$(dirname "$target_file")
  if [[ ! -d "$target_dir" ]]; then
    mkdir -p "$target_dir"
    log_debug "Created directory: $target_dir"
  fi

  # Copy file
  if ! cp "$source_file" "$target_file"; then
    log_error "Failed to restore $file_name"
    return 1
  fi

  # Validate restored file
  if ! validate_json "$target_file" "$file_name"; then
    log_error "Restored file validation failed: $file_name"
    return 1
  fi

  log_info "✓ Restored $file_name"
  return 0
}

# Rollback restore operation
rollback_restore() {
  local safety_backup="$1"

  if [[ -z "$safety_backup" ]] || [[ ! -d "$safety_backup" ]]; then
    log_error "Cannot rollback: no safety backup available"
    return 1
  fi

  log_warn "Rolling back restore operation..."

  local rollback_errors=0

  for file in "$safety_backup"/*.json; do
    if [[ -f "$file" ]]; then
      local target_file
      case "$(basename "$file")" in
        todo.json)
          target_file="$TODO_FILE"
          ;;
        todo-archive.json)
          target_file="$ARCHIVE_FILE"
          ;;
        config.json)
          target_file="$CONFIG_FILE"
          ;;
        todo-log.json)
          target_file="$LOG_FILE"
          ;;
        *)
          continue
          ;;
      esac

      if ! cp "$file" "$target_file"; then
        ((rollback_errors++))
        log_error "Failed to rollback $(basename "$file")"
      else
        log_debug "Rolled back $(basename "$file")"
      fi
    fi
  done

  if [[ $rollback_errors -eq 0 ]]; then
    log_info "Rollback completed successfully"
    return 0
  else
    log_error "Rollback completed with $rollback_errors errors"
    return 1
  fi
}

# Parse arguments
# Check for help first
for arg in "$@"; do
  if [[ "$arg" == "-h" ]] || [[ "$arg" == "--help" ]]; then
    usage
  fi
done

if [[ $# -eq 0 ]]; then
  log_error "Backup source required"
  usage
fi

BACKUP_SOURCE="$1"
shift

while [[ $# -gt 0 ]]; do
  case $1 in
    --file)
      TARGET_FILE="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    -f|--format)
      FORMAT="$2"
      shift 2
      ;;
    --human)
      FORMAT="human"
      shift
      ;;
    --json)
      FORMAT="json"
      shift
      ;;
    -q|--quiet)
      QUIET=true
      shift
      ;;
    -*)
      log_error "Unknown option: $1"
      exit "$EXIT_INVALID_INPUT"
      ;;
    *)
      shift
      ;;
  esac
done

# Resolve output format (CLI > env > config > TTY-aware default)
if declare -f resolve_format &>/dev/null; then
  FORMAT=$(resolve_format "$FORMAT")
else
  FORMAT="${FORMAT:-text}"
fi

# Set backup directory from config (v0.24.0+)
# Used for safety backup location during restore
if declare -f get_config_value >/dev/null 2>&1; then
  BACKUP_DIR=$(get_config_value "backup.directory" ".cleo/backups")
elif [[ -f "$CONFIG_FILE" ]]; then
  BACKUP_DIR=$(jq -r '.backup.directory // ".cleo/backups"' "$CONFIG_FILE" 2>/dev/null || echo ".cleo/backups")
fi

check_deps

# Validate backup source
if ! validate_backup_source "$BACKUP_SOURCE"; then
  exit "$EXIT_VALIDATION_ERROR"
fi

# Extract tarball if needed
TEMP_EXTRACT=""
if [[ -f "$BACKUP_SOURCE" ]] && [[ "$BACKUP_SOURCE" =~ \.tar\.gz$ ]]; then
  TEMP_EXTRACT=$(extract_tarball "$BACKUP_SOURCE")
  if [[ -z "$TEMP_EXTRACT" ]]; then
    exit "$EXIT_FILE_ERROR"
  fi
  BACKUP_SOURCE="$TEMP_EXTRACT"
  log_debug "Using extracted backup: $BACKUP_SOURCE"
fi

# Show backup information
if [[ "$FORMAT" != "json" ]]; then
  show_backup_info "$BACKUP_SOURCE"
fi

# Check for no-change condition (idempotency)
check_no_change() {
  local all_identical=true
  for file_name in todo.json todo-archive.json config.json todo-log.json; do
    if [[ -n "$TARGET_FILE" && "$TARGET_FILE" != "$file_name" ]]; then
      continue
    fi
    local source_file="${BACKUP_SOURCE}/${file_name}"
    local target_file
    case "$file_name" in
      todo.json) target_file="$TODO_FILE" ;;
      todo-archive.json) target_file="$ARCHIVE_FILE" ;;
      config.json) target_file="$CONFIG_FILE" ;;
      todo-log.json) target_file="$LOG_FILE" ;;
    esac

    if [[ -f "$source_file" && -f "$target_file" ]]; then
      if ! diff -q "$source_file" "$target_file" &>/dev/null; then
        all_identical=false
        break
      fi
    elif [[ -f "$source_file" ]]; then
      # Source exists but target doesn't - change needed
      all_identical=false
      break
    fi
  done

  [[ "$all_identical" == "true" ]]
}

# Handle dry-run mode
if [[ "$DRY_RUN" == true ]]; then
  # Collect files that would be restored
  WOULD_RESTORE_FILES=()
  for file_name in todo.json todo-archive.json config.json todo-log.json; do
    if [[ -n "$TARGET_FILE" && "$TARGET_FILE" != "$file_name" ]]; then
      continue
    fi
    if [[ -f "${BACKUP_SOURCE}/${file_name}" ]]; then
      WOULD_RESTORE_FILES+=("$file_name")
    fi
  done

  if [[ "$FORMAT" == "json" ]]; then
    jq -nc \
      --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
      --arg from "$BACKUP_SOURCE" \
      --argjson files "$(printf '%s\n' "${WOULD_RESTORE_FILES[@]}" | jq -R . | jq -s .)" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "restore",
          "timestamp": $timestamp,
          "format": "json"
        },
        "success": true,
        "dryRun": true,
        "wouldRestore": {
          "from": $from,
          "files": $files
        }
      }'
  else
    echo ""
    echo -e "${YELLOW}DRY RUN - No changes will be made${NC}"
    echo ""
    echo -e "  ${BLUE}Would restore:${NC}"
    for file in "${WOULD_RESTORE_FILES[@]}"; do
      echo -e "    → $file"
    done
    echo ""
  fi
  exit "$EXIT_SUCCESS"
fi

# Check for no-change condition (idempotency)
if check_no_change; then
  if [[ "$FORMAT" == "json" ]]; then
    jq -nc \
      --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
      --arg from "$BACKUP_SOURCE" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "restore",
          "timestamp": $timestamp,
          "format": "json"
        },
        "success": true,
        "noChange": true,
        "reason": "All files are already identical to backup",
        "from": $from
      }'
  else
    log_info "No changes needed - files are already identical to backup"
  fi
  exit "${EXIT_NO_CHANGE:-102}"
fi

# Confirm restore
confirm_restore

# Create safety backup
SAFETY_BACKUP=$(create_safety_backup)

# Track restore status
RESTORE_ERRORS=0
RESTORED_FILES=()

# Restore files
log_info "Restoring files..."

if [[ -n "$TARGET_FILE" ]]; then
  # Restore specific file only
  case "$TARGET_FILE" in
    todo.json)
      if restore_file "${BACKUP_SOURCE}/todo.json" "$TODO_FILE"; then
        RESTORED_FILES+=("todo.json")
      else
        ((RESTORE_ERRORS++))
      fi
      ;;
    todo-archive.json)
      if restore_file "${BACKUP_SOURCE}/todo-archive.json" "$ARCHIVE_FILE"; then
        RESTORED_FILES+=("todo-archive.json")
      else
        ((RESTORE_ERRORS++))
      fi
      ;;
    config.json)
      if restore_file "${BACKUP_SOURCE}/config.json" "$CONFIG_FILE"; then
        RESTORED_FILES+=("config.json")
      else
        ((RESTORE_ERRORS++))
      fi
      ;;
    todo-log.json)
      if restore_file "${BACKUP_SOURCE}/todo-log.json" "$LOG_FILE"; then
        RESTORED_FILES+=("todo-log.json")
      else
        ((RESTORE_ERRORS++))
      fi
      ;;
    *)
      log_error "Unknown file: $TARGET_FILE"
      log_error "Valid files: todo.json, todo-archive.json, config.json, todo-log.json"
      exit "$EXIT_INVALID_INPUT"
      ;;
  esac
else
  # Restore all files
  if restore_file "${BACKUP_SOURCE}/todo.json" "$TODO_FILE"; then
    RESTORED_FILES+=("todo.json")
  else
    ((RESTORE_ERRORS++))
  fi

  if restore_file "${BACKUP_SOURCE}/todo-archive.json" "$ARCHIVE_FILE"; then
    RESTORED_FILES+=("todo-archive.json")
  else
    ((RESTORE_ERRORS++))
  fi

  if restore_file "${BACKUP_SOURCE}/config.json" "$CONFIG_FILE"; then
    RESTORED_FILES+=("config.json")
  else
    ((RESTORE_ERRORS++))
  fi

  if restore_file "${BACKUP_SOURCE}/todo-log.json" "$LOG_FILE"; then
    RESTORED_FILES+=("todo-log.json")
  else
    ((RESTORE_ERRORS++))
  fi
fi

# Cleanup temp extraction
if [[ -n "$TEMP_EXTRACT" ]]; then
  rm -rf "$(dirname "$TEMP_EXTRACT")"
  log_debug "Cleaned up temporary extraction"
fi

# Check results
if [[ $RESTORE_ERRORS -gt 0 ]]; then
  log_error "Restore failed with $RESTORE_ERRORS errors"

  if [[ -n "$SAFETY_BACKUP" ]]; then
    if rollback_restore "$SAFETY_BACKUP"; then
      log_error "Restore rolled back to original state"
    else
      log_error "Rollback failed - manual intervention required"
      log_error "Safety backup available at: $SAFETY_BACKUP"
    fi
  fi

  exit "$EXIT_GENERAL_ERROR"
fi

# Validate all restored files
log_info "Validating restored files..."
VALIDATION_ERRORS=0

for file_name in "${RESTORED_FILES[@]}"; do
  case "$file_name" in
    todo.json)
      target_file="$TODO_FILE"
      ;;
    todo-archive.json)
      target_file="$ARCHIVE_FILE"
      ;;
    config.json)
      target_file="$CONFIG_FILE"
      ;;
    todo-log.json)
      target_file="$LOG_FILE"
      ;;
    *)
      continue
      ;;
  esac

  if [[ -f "$target_file" ]]; then
    if ! validate_json "$target_file" "$file_name"; then
      ((VALIDATION_ERRORS++))
    fi
  fi
done

if [[ $VALIDATION_ERRORS -gt 0 ]]; then
  log_error "Validation failed after restore"

  if [[ -n "$SAFETY_BACKUP" ]]; then
    if rollback_restore "$SAFETY_BACKUP"; then
      log_error "Restore rolled back due to validation failure"
    else
      log_error "Rollback failed - manual intervention required"
      log_error "Safety backup available at: $SAFETY_BACKUP"
    fi
  fi

  exit "$EXIT_VALIDATION_ERROR"
fi

# Get tasks count from restored todo.json
TASKS_COUNT=0
if [[ -f "$TODO_FILE" ]]; then
  TASKS_COUNT=$(jq '.tasks | length' "$TODO_FILE" 2>/dev/null || echo 0)
fi

# Success output
if [[ "$FORMAT" == "json" ]]; then
  # JSON output
  jq -nc \
    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --arg from "$BACKUP_SOURCE" \
    --arg safetyBackup "${SAFETY_BACKUP:-}" \
    --argjson tasksCount "$TASKS_COUNT" \
    --argjson dryRun "$DRY_RUN" \
    --argjson files "$(printf '%s\n' "${RESTORED_FILES[@]}" | jq -R . | jq -s .)" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "command": "restore",
        "timestamp": $timestamp,
        "format": "json"
      },
      "success": true,
      "restored": {
        "from": $from,
        "files": $files,
        "tasksCount": $tasksCount,
        "dryRun": $dryRun,
        "safetyBackup": (if $safetyBackup != "" then $safetyBackup else null end)
      }
    }'
else
  # Text output
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║              RESTORE COMPLETED SUCCESSFULLY              ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${BLUE}Restored Files:${NC}"
  for file in "${RESTORED_FILES[@]}"; do
    echo -e "    ✓ $file"
  done
  echo ""

  if [[ -n "$SAFETY_BACKUP" ]]; then
    echo -e "  ${BLUE}Safety Backup:${NC}"
    echo -e "    $SAFETY_BACKUP"
    echo -e "    ${YELLOW}(Can be removed if restore is satisfactory)${NC}"
    echo ""
  fi
fi

exit "$EXIT_SUCCESS"
