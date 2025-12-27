#!/usr/bin/env bash
# CLEO Backup Script
# Create backups of all todo system files
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.cleo/todo-archive.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
LOG_FILE="${LOG_FILE:-.cleo/todo-log.json}"
BACKUP_DIR="${BACKUP_DIR:-.cleo/backups}"

# Source logging library for should_use_color function
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  # shellcheck source=../lib/logging.sh
  source "$LIB_DIR/logging.sh"
fi

# Source output formatting and error libraries
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  # shellcheck source=../lib/output-format.sh
  source "$LIB_DIR/output-format.sh"
fi
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  # shellcheck source=../lib/exit-codes.sh
  source "$LIB_DIR/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
fi

# Source config library for unified config access (v0.24.0)
if [[ -f "$LIB_DIR/config.sh" ]]; then
  # shellcheck source=../lib/config.sh
  source "$LIB_DIR/config.sh"
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
DESTINATION=""
COMPRESS=false
VERBOSE=false
CUSTOM_NAME=""
LIST_MODE=false
VERIFY_MODE=false
VERIFY_TARGET=""
STATUS_MODE=false
FIND_MODE=false
SEARCH_MODE=false
FIND_SINCE=""
FIND_UNTIL=""
FIND_ON=""
FIND_TYPE="all"
FIND_NAME=""
FIND_GREP=""
FIND_TASK_ID=""
FIND_LIMIT=10
FORMAT=""
QUIET=false
AUTO_MODE=false
COMMAND_NAME="backup"

# Exit code for verify failure (per BACKUP-SYSTEM-SPEC.md Part 7.1)
EXIT_VERIFY_FAILED=12

usage() {
  cat << EOF
Usage: $(basename "$0") [OPTIONS]

Create timestamped backup of all todo system files.

Subcommands:
  status              Show backup system health and status
  verify <ID|PATH>    Verify backup integrity by recalculating checksums
  find [OPTIONS]      Search backups by date, type, name, or content
  search [OPTIONS]    Alias for 'find' with enhanced search options

Options:
  --destination DIR   Custom backup location (default: .cleo/backups)
  --compress          Create compressed tarball of backup
  --name NAME         Custom backup name (appended to timestamp)
  --list              List available backups
  --verbose           Show detailed output (includes matched content snippets)
  -f, --format FMT    Output format: text, json (default: auto-detect)
  --human             Force human-readable text output
  --json              Force JSON output
  -q, --quiet         Suppress non-essential output
  --auto              Run scheduled/automatic backup if due (interval-based)
  -h, --help          Show this help

Search Options (use with 'find' or 'search' subcommand):
  --since DATE        Show backups created after DATE (ISO or relative: "7d", "1w")
  --until DATE        Show backups created before DATE
  --on DATE           Show backups created on exact DATE (YYYY-MM-DD or relative)
  --type TYPE         Filter by backup type (snapshot, safety, archive, migration)
  --name PATTERN      Filter by backup name pattern (glob: "*session*")
  --contains PATTERN  Search backup content for pattern (alias: --grep)
  --grep PATTERN      Search backup content for pattern
  --task-id ID        Search for backups containing specific task ID (e.g., T001)
  --limit N           Limit results (default: 10)

Backs up:
  - todo.json
  - todo-archive.json
  - config.json
  - todo-log.json

Output:
  - Backup location
  - Files included
  - Total size
  - Validation status

JSON Output:
  {
    "_meta": {"command": "backup", "timestamp": "..."},
    "success": true,
    "backup": {"path": "/path/to/backup", "size": 1234, "tasksCount": 15, "files": [...]}
  }

Examples:
  $(basename "$0")                              # Default timestamped backup
  $(basename "$0") --name "before-refactor"     # Named backup
  $(basename "$0") --compress                   # Compressed backup
  $(basename "$0") --list                       # List all backups
  $(basename "$0") --json                       # JSON output for scripting
  $(basename "$0") status                       # Show backup system status
  $(basename "$0") status --json                # JSON status for monitoring
  $(basename "$0") verify snapshot_20251215     # Verify backup by ID
  $(basename "$0") verify .cleo/backups/safety/safety_20251215_120000  # Verify by path
  $(basename "$0") find --since 7d --type snapshot    # Find recent snapshots
  $(basename "$0") find --name "*session*"            # Find by name pattern
  $(basename "$0") find --grep "T001"                 # Search content for task ID
  $(basename "$0") search --since 7d --contains "important"   # Search with combined filters
  $(basename "$0") search --task-id T045 --type snapshot      # Find backups containing task
  $(basename "$0") search --on 2025-12-20                     # Find backups from exact date
  $(basename "$0") search --task-id T001 --verbose            # Show matched content snippets
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

  if [[ "$COMPRESS" == true ]] && ! command -v tar &> /dev/null; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_DEPENDENCY_MISSING" "tar is required for compression but not installed" "${EXIT_DEPENDENCY_ERROR:-5}" false "Install tar or use backup without --compress"
    else
      log_error "tar is required for compression but not installed"
    fi
    exit "${EXIT_DEPENDENCY_ERROR:-1}"
  fi
}

# Validate file integrity
validate_file() {
  local file="$1"
  local name="$2"

  if [[ ! -f "$file" ]]; then
    log_warn "$name not found, skipping"
    return 1
  fi

  if ! jq empty "$file" 2>/dev/null; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_VALIDATION_SCHEMA" "$name has invalid JSON syntax" "${EXIT_VALIDATION_ERROR:-2}" false "Fix the JSON syntax in $file"
    else
      log_error "$name has invalid JSON syntax"
    fi
    return 1
  fi

  log_debug "$name validated successfully"
  return 0
}

# Get file size in human-readable format
get_size() {
  local file="$1"
  if [[ -f "$file" ]]; then
    if command -v numfmt &> /dev/null; then
      numfmt --to=iec-i --suffix=B "$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)"
    else
      du -h "$file" 2>/dev/null | cut -f1 || echo "0B"
    fi
  else
    echo "0B"
  fi
}

# List available backups
list_backups() {
  local backup_dir="$1"
  local json_backups="[]"  # For JSON output

  if [[ ! -d "$backup_dir" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -n \
        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --arg dir "$backup_dir" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "backup",
            "subcommand": "list",
            "timestamp": $timestamp,
            "format": "json"
          },
          "success": true,
          "backups": [],
          "count": 0,
          "directory": $dir
        }'
    else
      echo "No backups found"
    fi
    return 0
  fi

  if [[ "$FORMAT" != "json" ]]; then
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║                           AVAILABLE BACKUPS                                  ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
  fi

  # Find all backup directories and tarballs
  local found_backups=0

  # List backups from new unified taxonomy structure first
  for backup_type in snapshot safety incremental archive migration; do
    local type_dir="$backup_dir/$backup_type"
    if [[ -d "$type_dir" ]]; then
      while IFS= read -r -d '' backup; do
        if [[ -d "$backup" ]]; then
          found_backups=1
          local backup_name
          backup_name=$(basename "$backup")

          # Get metadata (new format: metadata.json)
          local metadata_file="${backup}/metadata.json"
          if [[ -f "$metadata_file" ]]; then
            local timestamp
            timestamp=$(jq -r '.timestamp // "unknown"' "$metadata_file" 2>/dev/null || echo "unknown")
            local file_count
            file_count=$(jq -r '.files | length' "$metadata_file" 2>/dev/null || echo "0")
            local total_size
            total_size=$(jq -r '.totalSize' "$metadata_file" 2>/dev/null || echo "0")
            local backup_type_label
            backup_type_label=$(jq -r '.backupType // "unknown"' "$metadata_file" 2>/dev/null || echo "unknown")

            # Convert size to human readable
            local size_human
            if command -v numfmt &> /dev/null; then
              size_human=$(numfmt --to=iec-i --suffix=B "$total_size" 2>/dev/null || echo "${total_size}B")
            else
              size_human="${total_size}B"
            fi

            if [[ "$FORMAT" == "json" ]]; then
              json_backups=$(echo "$json_backups" | jq \
                --arg name "$backup_name" \
                --arg path "$backup" \
                --arg type "$backup_type_label" \
                --arg timestamp "$timestamp" \
                --argjson fileCount "$file_count" \
                --argjson size "$total_size" \
                --arg sizeHuman "$size_human" \
                --argjson compressed false \
                '. + [{
                  "name": $name,
                  "path": $path,
                  "type": $type,
                  "timestamp": $timestamp,
                  "fileCount": $fileCount,
                  "size": $size,
                  "sizeHuman": $sizeHuman,
                  "compressed": $compressed
                }]')
            else
              echo -e "  ${GREEN}▸${NC} ${BLUE}$backup_name${NC} [$backup_type_label]"
              echo -e "    Timestamp: $timestamp"
              echo -e "    Files: $file_count | Size: $size_human"
              echo -e "    Path: $backup"
              echo ""
            fi
          fi
        fi
      done < <(find "$type_dir" -maxdepth 1 -mindepth 1 -type d -print0 2>/dev/null | sort -z)
    fi
  done

  # Also check for legacy backup_* directories (backward compatibility)
  while IFS= read -r -d '' backup; do
    if [[ -d "$backup" ]]; then
      found_backups=1
      local backup_name
      backup_name=$(basename "$backup")

      # Get metadata if available (old format: backup-metadata.json)
      local metadata_file="${backup}/backup-metadata.json"
      if [[ -f "$metadata_file" ]]; then
        local timestamp
        timestamp=$(jq -r '.timestamp // "unknown"' "$metadata_file" 2>/dev/null || echo "unknown")
        local file_count
        file_count=$(jq -r '.files | length' "$metadata_file" 2>/dev/null || echo "0")
        local total_size
        total_size=$(jq -r '.totalSize' "$metadata_file" 2>/dev/null || echo "0")

        # Convert size to human readable
        local size_human
        if command -v numfmt &> /dev/null; then
          size_human=$(numfmt --to=iec-i --suffix=B "$total_size" 2>/dev/null || echo "${total_size}B")
        else
          size_human="${total_size}B"
        fi

        if [[ "$FORMAT" == "json" ]]; then
          json_backups=$(echo "$json_backups" | jq \
            --arg name "$backup_name" \
            --arg path "$backup" \
            --arg timestamp "$timestamp" \
            --argjson fileCount "$file_count" \
            --argjson size "$total_size" \
            --arg sizeHuman "$size_human" \
            --argjson compressed false \
            '. + [{
              "name": $name,
              "path": $path,
              "type": "legacy",
              "timestamp": $timestamp,
              "fileCount": $fileCount,
              "size": $size,
              "sizeHuman": $sizeHuman,
              "compressed": $compressed
            }]')
        else
          echo -e "  ${GREEN}▸${NC} ${BLUE}$backup_name${NC}"
          echo -e "    Timestamp: $timestamp"
          echo -e "    Files: $file_count | Size: $size_human"
          echo -e "    Path: $backup"
          echo ""
        fi
      else
        # No metadata, just show basic info
        local mtime
        if [[ "$(uname)" == "Darwin" ]]; then
          mtime=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$backup" 2>/dev/null || echo "unknown")
        else
          mtime=$(stat -c "%y" "$backup" 2>/dev/null | cut -d'.' -f1 || echo "unknown")
        fi

        if [[ "$FORMAT" == "json" ]]; then
          json_backups=$(echo "$json_backups" | jq \
            --arg name "$backup_name" \
            --arg path "$backup" \
            --arg modified "$mtime" \
            --argjson compressed false \
            '. + [{
              "name": $name,
              "path": $path,
              "type": "legacy",
              "modified": $modified,
              "compressed": $compressed
            }]')
        else
          echo -e "  ${GREEN}▸${NC} ${BLUE}$backup_name${NC}"
          echo -e "    Modified: $mtime"
          echo -e "    Path: $backup"
          echo ""
        fi
      fi
    fi
  done < <(find "$backup_dir" -maxdepth 1 -type d -name "backup_*" -print0 2>/dev/null | sort -z)

  # List tarballs
  while IFS= read -r -d '' tarball; do
    if [[ -f "$tarball" ]]; then
      found_backups=1
      local tarball_name
      tarball_name=$(basename "$tarball")
      local size
      size=$(get_size "$tarball")
      local size_bytes
      size_bytes=$(stat -c%s "$tarball" 2>/dev/null || stat -f%z "$tarball" 2>/dev/null || echo 0)

      local mtime
      if [[ "$(uname)" == "Darwin" ]]; then
        mtime=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$tarball" 2>/dev/null || echo "unknown")
      else
        mtime=$(stat -c "%y" "$tarball" 2>/dev/null | cut -d'.' -f1 || echo "unknown")
      fi

      if [[ "$FORMAT" == "json" ]]; then
        json_backups=$(echo "$json_backups" | jq \
          --arg name "$tarball_name" \
          --arg path "$tarball" \
          --arg modified "$mtime" \
          --argjson size "$size_bytes" \
          --arg sizeHuman "$size" \
          --argjson compressed true \
          '. + [{
            "name": $name,
            "path": $path,
            "type": "compressed",
            "modified": $modified,
            "size": $size,
            "sizeHuman": $sizeHuman,
            "compressed": $compressed
          }]')
      else
        echo -e "  ${GREEN}▸${NC} ${BLUE}$tarball_name${NC} (compressed)"
        echo -e "    Modified: $mtime"
        echo -e "    Size: $size"
        echo -e "    Path: $tarball"
        echo ""
      fi
    fi
  done < <(find "$backup_dir" -maxdepth 1 -type f -name "backup_*.tar.gz" -print0 2>/dev/null | sort -z)

  if [[ "$FORMAT" == "json" ]]; then
    local count
    count=$(echo "$json_backups" | jq 'length')
    jq -n \
      --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
      --arg dir "$backup_dir" \
      --argjson backups "$json_backups" \
      --argjson count "$count" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "backup",
          "subcommand": "list",
          "timestamp": $timestamp,
          "format": "json"
        },
        "success": true,
        "backups": $backups,
        "count": $count,
        "directory": $dir
      }'
  else
    if [[ $found_backups -eq 0 ]]; then
      echo "  No backups found in: $backup_dir"
      echo ""
    fi
  fi

  return 0
}

# Resolve backup path from ID or path
# Supports: full path, backup ID (e.g., snapshot_20251215_120000), or partial ID
resolve_backup_path() {
  local target="$1"
  local backup_dir="$2"

  # If it's already a valid directory path, return it
  if [[ -d "$target" ]]; then
    echo "$target"
    return 0
  fi

  # Try as a path relative to backup_dir
  if [[ -d "${backup_dir}/${target}" ]]; then
    echo "${backup_dir}/${target}"
    return 0
  fi

  # Search in typed backup directories
  for backup_type in snapshot safety archive migration; do
    local type_dir="${backup_dir}/${backup_type}"
    if [[ -d "${type_dir}/${target}" ]]; then
      echo "${type_dir}/${target}"
      return 0
    fi
    # Also try partial matching
    if [[ -d "$type_dir" ]]; then
      local match
      match=$(find "$type_dir" -maxdepth 1 -mindepth 1 -type d -name "*${target}*" 2>/dev/null | head -1)
      if [[ -n "$match" && -d "$match" ]]; then
        echo "$match"
        return 0
      fi
    fi
  done

  # Try legacy backup_* directories
  if [[ -d "${backup_dir}/backup_${target}" ]]; then
    echo "${backup_dir}/backup_${target}"
    return 0
  fi

  # Direct match if target already starts with backup_
  if [[ "$target" =~ ^backup_ && -d "${backup_dir}/${target}" ]]; then
    echo "${backup_dir}/${target}"
    return 0
  fi

  # Partial match in legacy format (for timestamp-only searches like "20251220")
  local legacy_match
  legacy_match=$(find "$backup_dir" -maxdepth 1 -type d -name "backup_*${target}*" 2>/dev/null | head -1)
  if [[ -n "$legacy_match" && -d "$legacy_match" ]]; then
    echo "$legacy_match"
    return 0
  fi

  # Partial match for target already containing backup_ prefix
  if [[ "$target" =~ ^backup_ ]]; then
    legacy_match=$(find "$backup_dir" -maxdepth 1 -type d -name "${target}*" 2>/dev/null | head -1)
    if [[ -n "$legacy_match" && -d "$legacy_match" ]]; then
      echo "$legacy_match"
      return 0
    fi
  fi

  return 1
}

# Verify backup integrity by recalculating checksums
# Per BACKUP-SYSTEM-SPEC.md Part 6.4
verify_backup() {
  local target="$1"
  local backup_dir="$2"

  # Resolve the backup path
  local backup_path
  if ! backup_path=$(resolve_backup_path "$target" "$backup_dir"); then
    if [[ "$FORMAT" == "json" ]]; then
      jq -n \
        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --arg target "$target" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "backup",
            "subcommand": "verify",
            "timestamp": $timestamp,
            "format": "json"
          },
          "success": false,
          "error": {
            "code": "NOT_FOUND",
            "message": ("Backup not found: " + $target),
            "recoverable": true,
            "suggestion": "Run '\''cleo backup --list'\'' to see available backups"
          }
        }'
    else
      log_error "Backup not found: $target"
      echo "Run 'cleo backup --list' to see available backups"
    fi
    exit $EXIT_NOT_FOUND
  fi

  local backup_id
  backup_id=$(basename "$backup_path")

  # Find metadata file (new format: metadata.json, legacy: backup-metadata.json)
  local metadata_file=""
  if [[ -f "${backup_path}/metadata.json" ]]; then
    metadata_file="${backup_path}/metadata.json"
  elif [[ -f "${backup_path}/backup-metadata.json" ]]; then
    metadata_file="${backup_path}/backup-metadata.json"
  fi

  if [[ -z "$metadata_file" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -n \
        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --arg backup_id "$backup_id" \
        --arg path "$backup_path" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "backup",
            "subcommand": "verify",
            "timestamp": $timestamp,
            "format": "json"
          },
          "success": false,
          "error": {
            "code": "INVALID_BACKUP",
            "message": "No metadata file found in backup",
            "recoverable": false,
            "suggestion": "This backup may be corrupted or incomplete"
          },
          "backup_id": $backup_id,
          "path": $path
        }'
    else
      log_error "No metadata file found in backup: $backup_path"
      echo "This backup may be corrupted or incomplete"
    fi
    exit $EXIT_INVALID_INPUT
  fi

  log_info "Verifying backup: $backup_id"
  log_debug "Backup path: $backup_path"
  log_debug "Metadata file: $metadata_file"

  # Read metadata
  local metadata
  if ! metadata=$(cat "$metadata_file" 2>/dev/null); then
    if [[ "$FORMAT" == "json" ]]; then
      jq -n \
        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --arg backup_id "$backup_id" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "backup",
            "subcommand": "verify",
            "timestamp": $timestamp,
            "format": "json"
          },
          "success": false,
          "error": {
            "code": "FILE_ERROR",
            "message": "Cannot read metadata file",
            "recoverable": false
          },
          "backup_id": $backup_id
        }'
    else
      log_error "Cannot read metadata file: $metadata_file"
    fi
    exit $EXIT_FILE_ERROR
  fi

  # Determine metadata format and extract file info
  local files_checked=0
  local files_passed=0
  local files_failed=0
  local details_json="[]"

  # Check if new format (files array with checksum) or legacy format (just file names)
  local has_checksums
  has_checksums=$(echo "$metadata" | jq -r 'if .files[0].checksum then "true" else "false" end' 2>/dev/null || echo "false")

  if [[ "$has_checksums" == "true" ]]; then
    # New format: files is array of objects with checksum field
    local file_count
    file_count=$(echo "$metadata" | jq '.files | length')

    for ((i=0; i<file_count; i++)); do
      local file_info
      file_info=$(echo "$metadata" | jq -r ".files[$i]")
      local file_name
      file_name=$(echo "$file_info" | jq -r '.backup // .source')
      local stored_checksum
      stored_checksum=$(echo "$file_info" | jq -r '.checksum')
      local file_path="${backup_path}/${file_name}"

      ((files_checked++)) || true

      if [[ ! -f "$file_path" ]]; then
        log_warn "File missing: $file_name"
        ((files_failed++)) || true
        details_json=$(echo "$details_json" | jq \
          --arg file "$file_name" \
          '. + [{"file": $file, "status": "missing", "error": "File not found in backup"}]')
        continue
      fi

      # Calculate current checksum
      local current_checksum
      current_checksum=$(sha256sum "$file_path" 2>/dev/null | cut -d' ' -f1)

      if [[ -z "$current_checksum" ]]; then
        log_warn "Cannot calculate checksum: $file_name"
        ((files_failed++)) || true
        details_json=$(echo "$details_json" | jq \
          --arg file "$file_name" \
          '. + [{"file": $file, "status": "error", "error": "Cannot calculate checksum"}]')
        continue
      fi

      if [[ "$current_checksum" == "$stored_checksum" ]]; then
        log_debug "Checksum OK: $file_name"
        ((files_passed++)) || true
        details_json=$(echo "$details_json" | jq \
          --arg file "$file_name" \
          '. + [{"file": $file, "status": "passed"}]')
      else
        log_warn "Checksum mismatch: $file_name"
        log_debug "  Expected: $stored_checksum"
        log_debug "  Got:      $current_checksum"
        ((files_failed++)) || true
        details_json=$(echo "$details_json" | jq \
          --arg file "$file_name" \
          --arg expected "$stored_checksum" \
          --arg actual "$current_checksum" \
          '. + [{"file": $file, "status": "failed", "expected": $expected, "actual": $actual}]')
      fi
    done
  else
    # Legacy format: files is array of strings, no stored checksums
    # Check if checksums object exists (alternative legacy format)
    local has_checksums_obj
    has_checksums_obj=$(echo "$metadata" | jq -r 'if .checksums then "true" else "false" end' 2>/dev/null || echo "false")

    if [[ "$has_checksums_obj" == "true" ]]; then
      # Alternative format: separate checksums object
      local file_names
      file_names=$(echo "$metadata" | jq -r '.files[]')

      while IFS= read -r file_name; do
        [[ -z "$file_name" ]] && continue
        ((files_checked++)) || true

        local stored_checksum
        stored_checksum=$(echo "$metadata" | jq -r --arg f "$file_name" '.checksums[$f] // empty')
        local file_path="${backup_path}/${file_name}"

        if [[ ! -f "$file_path" ]]; then
          log_warn "File missing: $file_name"
          ((files_failed++)) || true
          details_json=$(echo "$details_json" | jq \
            --arg file "$file_name" \
            '. + [{"file": $file, "status": "missing", "error": "File not found in backup"}]')
          continue
        fi

        if [[ -z "$stored_checksum" ]]; then
          log_debug "No stored checksum for: $file_name (file exists)"
          ((files_passed++)) || true
          details_json=$(echo "$details_json" | jq \
            --arg file "$file_name" \
            '. + [{"file": $file, "status": "passed", "note": "No checksum stored, file exists"}]')
          continue
        fi

        local current_checksum
        current_checksum=$(sha256sum "$file_path" 2>/dev/null | cut -d' ' -f1)

        if [[ "$current_checksum" == "$stored_checksum" ]]; then
          log_debug "Checksum OK: $file_name"
          ((files_passed++)) || true
          details_json=$(echo "$details_json" | jq \
            --arg file "$file_name" \
            '. + [{"file": $file, "status": "passed"}]')
        else
          log_warn "Checksum mismatch: $file_name"
          ((files_failed++)) || true
          details_json=$(echo "$details_json" | jq \
            --arg file "$file_name" \
            --arg expected "$stored_checksum" \
            --arg actual "$current_checksum" \
            '. + [{"file": $file, "status": "failed", "expected": $expected, "actual": $actual}]')
        fi
      done <<< "$file_names"
    else
      # Pure legacy format: no checksums at all, just verify files exist
      local file_names
      file_names=$(echo "$metadata" | jq -r '.files[]')

      while IFS= read -r file_name; do
        [[ -z "$file_name" ]] && continue
        ((files_checked++)) || true

        local file_path="${backup_path}/${file_name}"

        if [[ -f "$file_path" ]]; then
          log_debug "File exists: $file_name"
          ((files_passed++)) || true
          details_json=$(echo "$details_json" | jq \
            --arg file "$file_name" \
            '. + [{"file": $file, "status": "passed", "note": "Legacy backup - no checksums stored"}]')
        else
          log_warn "File missing: $file_name"
          ((files_failed++)) || true
          details_json=$(echo "$details_json" | jq \
            --arg file "$file_name" \
            '. + [{"file": $file, "status": "missing", "error": "File not found in backup"}]')
        fi
      done <<< "$file_names"
    fi
  fi

  # Determine overall verification status
  local verified=false
  if [[ $files_failed -eq 0 && $files_checked -gt 0 ]]; then
    verified=true
  fi

  # Output results
  if [[ "$FORMAT" == "json" ]]; then
    jq -n \
      --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
      --arg backup_id "$backup_id" \
      --arg path "$backup_path" \
      --argjson verified "$verified" \
      --argjson files_checked "$files_checked" \
      --argjson files_passed "$files_passed" \
      --argjson files_failed "$files_failed" \
      --argjson details "$details_json" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "backup",
          "subcommand": "verify",
          "timestamp": $timestamp,
          "format": "json"
        },
        "success": true,
        "backup_id": $backup_id,
        "path": $path,
        "verified": $verified,
        "files_checked": $files_checked,
        "files_passed": $files_passed,
        "files_failed": $files_failed,
        "details": $details
      }'
  else
    echo ""
    if [[ "$verified" == true ]]; then
      echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
      echo -e "${GREEN}║              BACKUP VERIFICATION PASSED                  ║${NC}"
      echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
    else
      echo -e "${RED}╔══════════════════════════════════════════════════════════╗${NC}"
      echo -e "${RED}║              BACKUP VERIFICATION FAILED                  ║${NC}"
      echo -e "${RED}╚══════════════════════════════════════════════════════════╝${NC}"
    fi
    echo ""
    echo -e "  ${BLUE}Backup ID:${NC} $backup_id"
    echo -e "  ${BLUE}Path:${NC} $backup_path"
    echo ""
    echo -e "  ${BLUE}Summary:${NC}"
    echo -e "    Files checked: $files_checked"
    echo -e "    Files passed:  ${GREEN}$files_passed${NC}"
    if [[ $files_failed -gt 0 ]]; then
      echo -e "    Files failed:  ${RED}$files_failed${NC}"
    else
      echo -e "    Files failed:  $files_failed"
    fi
    echo ""
    echo -e "  ${BLUE}Details:${NC}"
    echo "$details_json" | jq -r '.[] | "    " + (if .status == "passed" then "✓" else "✗" end) + " " + .file + " (" + .status + ")" + (if .error then " - " + .error else "" end)'
    echo ""
  fi

  # Exit with appropriate code
  if [[ "$verified" == true ]]; then
    exit $EXIT_SUCCESS
  else
    exit $EXIT_VERIFY_FAILED
  fi
}

# Show backup system status and health
show_status() {
  local backup_dir="$1"

  # Backup type definitions
  local -a BACKUP_TYPES=("snapshot" "safety" "archive" "migration" "operational")

  # Get retention limits from config
  local max_snapshot max_safety max_archive max_operational
  if declare -f get_config_value >/dev/null 2>&1; then
    max_snapshot=$(get_config_value "backup.maxSnapshots" "5")
    max_safety=$(get_config_value "backup.maxSafetyBackups" "5")
    max_archive=$(get_config_value "backup.maxArchiveBackups" "3")
    max_operational=$(get_config_value "backup.maxIncremental" "10")
  elif [[ -f "$CONFIG_FILE" ]]; then
    max_snapshot=$(jq -r '.backup.maxSnapshots // 5' "$CONFIG_FILE" 2>/dev/null || echo 5)
    max_safety=$(jq -r '.backup.maxSafetyBackups // 5' "$CONFIG_FILE" 2>/dev/null || echo 5)
    max_archive=$(jq -r '.backup.maxArchiveBackups // 3' "$CONFIG_FILE" 2>/dev/null || echo 3)
    max_operational=$(jq -r '.backup.maxIncremental // 10' "$CONFIG_FILE" 2>/dev/null || echo 10)
  else
    max_snapshot=5
    max_safety=5
    max_archive=3
    max_operational=10
  fi

  # Initialize tracking variables
  local total_size=0
  local overall_health="healthy"
  local -a health_issues=()
  local -a health_checks=()

  # JSON tracking
  local json_by_type="{}"
  local json_latest="{}"

  # Check if backup directory exists
  if [[ ! -d "$backup_dir" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -n \
        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --arg dir "$backup_dir" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "backup",
            "subcommand": "status",
            "timestamp": $timestamp,
            "format": "json"
          },
          "status": "healthy",
          "total_size_bytes": 0,
          "total_size_human": "0B",
          "by_type": {},
          "latest": {},
          "health": {
            "status": "healthy",
            "checks": ["No backups exist yet (this is normal for new projects)"],
            "issues": []
          },
          "directory": $dir
        }'
    else
      echo ""
      echo -e "${BLUE}Backup System Status${NC}"
      echo "===================="
      echo ""
      echo "No backup directory found at: $backup_dir"
      echo "This is normal for new projects."
      echo ""
      echo -e "Health: ${GREEN}GOOD${NC}"
      echo "  ✓ No backups exist yet (normal for new projects)"
    fi
    return 0
  fi

  # Start text output
  if [[ "$FORMAT" != "json" ]]; then
    echo ""
    echo -e "${BLUE}Backup System Status${NC}"
    echo "===================="
    echo ""
    echo -e "${BLUE}Disk Usage:${NC}"
  fi

  # Process each backup type
  for backup_type in "${BACKUP_TYPES[@]}"; do
    local type_dir="$backup_dir/$backup_type"
    local type_count=0
    local type_size=0
    local latest_timestamp=""
    local max_limit=0

    # Set max limit based on type
    case "$backup_type" in
      snapshot)    max_limit=$max_snapshot ;;
      safety)      max_limit=$max_safety ;;
      archive)     max_limit=$max_archive ;;
      operational) max_limit=$max_operational ;;
      migration)   max_limit=0 ;;  # 0 = unlimited (never deleted)
    esac

    if [[ -d "$type_dir" ]]; then
      # Count backups and calculate size
      while IFS= read -r -d '' backup; do
        ((type_count++)) || true

        # Get directory size
        local dir_size
        if [[ -d "$backup" ]]; then
          dir_size=$(du -sb "$backup" 2>/dev/null | cut -f1 || echo 0)
        elif [[ -f "$backup" ]]; then
          dir_size=$(stat -c%s "$backup" 2>/dev/null || stat -f%z "$backup" 2>/dev/null || echo 0)
        else
          dir_size=0
        fi
        type_size=$((type_size + dir_size))

        # Get timestamp from metadata or directory name
        local backup_timestamp=""
        if [[ -f "${backup}/metadata.json" ]]; then
          backup_timestamp=$(jq -r '.timestamp // empty' "${backup}/metadata.json" 2>/dev/null)
        elif [[ -f "${backup}/backup-metadata.json" ]]; then
          backup_timestamp=$(jq -r '.timestamp // empty' "${backup}/backup-metadata.json" 2>/dev/null)
        fi

        # Extract from directory name if no metadata
        if [[ -z "$backup_timestamp" ]]; then
          local dirname
          dirname=$(basename "$backup")
          if [[ "$dirname" =~ ([0-9]{8})_([0-9]{6}) ]]; then
            local date_part="${BASH_REMATCH[1]}"
            local time_part="${BASH_REMATCH[2]}"
            backup_timestamp="${date_part:0:4}-${date_part:4:2}-${date_part:6:2}T${time_part:0:2}:${time_part:2:2}:${time_part:4:2}Z"
          fi
        fi

        # Track latest timestamp
        if [[ -n "$backup_timestamp" ]]; then
          if [[ -z "$latest_timestamp" ]] || [[ "$backup_timestamp" > "$latest_timestamp" ]]; then
            latest_timestamp="$backup_timestamp"
          fi
        fi
      done < <(find "$type_dir" -maxdepth 1 -mindepth 1 \( -type d -o -type f \) -print0 2>/dev/null)
    fi

    # Also check operational backups (numbered format like todo.json.1)
    if [[ "$backup_type" == "operational" && -d "$backup_dir/operational" ]]; then
      while IFS= read -r -d '' op_file; do
        ((type_count++)) || true
        local file_size
        file_size=$(stat -c%s "$op_file" 2>/dev/null || stat -f%z "$op_file" 2>/dev/null || echo 0)
        type_size=$((type_size + file_size))

        local mtime_epoch
        mtime_epoch=$(stat -c%Y "$op_file" 2>/dev/null || stat -f%m "$op_file" 2>/dev/null || echo 0)
        if [[ $mtime_epoch -gt 0 ]]; then
          local file_timestamp
          file_timestamp=$(date -u -d "@$mtime_epoch" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                          date -u -r "$mtime_epoch" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")
          if [[ -n "$file_timestamp" ]]; then
            if [[ -z "$latest_timestamp" ]] || [[ "$file_timestamp" > "$latest_timestamp" ]]; then
              latest_timestamp="$file_timestamp"
            fi
          fi
        fi
      done < <(find "$backup_dir/operational" -maxdepth 1 -type f \( -name "*.1" -o -name "*.2" -o -name "*.3" -o -name "*.4" -o -name "*.5" \) -print0 2>/dev/null)
    fi

    total_size=$((total_size + type_size))

    # Convert size to human readable
    local size_human
    if command -v numfmt &> /dev/null; then
      size_human=$(numfmt --to=iec-i --suffix=B "$type_size" 2>/dev/null || echo "${type_size}B")
    else
      if [[ $type_size -ge 1048576 ]]; then
        size_human="$(awk "BEGIN {printf \"%.1f\", $type_size/1048576}") MB"
      elif [[ $type_size -ge 1024 ]]; then
        size_human="$(awk "BEGIN {printf \"%.1f\", $type_size/1024}") KB"
      else
        size_human="${type_size}B"
      fi
    fi

    # Determine retention status text
    local retention_status
    if [[ "$backup_type" == "migration" ]]; then
      retention_status="never deleted"
    elif [[ $max_limit -eq 0 ]]; then
      retention_status="unlimited"
    elif [[ $type_count -ge $max_limit ]]; then
      retention_status="at limit"
    else
      retention_status="under limit"
    fi

    # Text output for this type
    if [[ "$FORMAT" != "json" && $type_count -gt 0 ]]; then
      local plural_s=""
      [[ $type_count -ne 1 ]] && plural_s="s"
      printf "  %-12s %8s (%d backup%s)\n" "$backup_type:" "$size_human" "$type_count" "$plural_s"
    fi

    # Build JSON for this type
    if [[ $type_count -gt 0 ]]; then
      json_by_type=$(echo "$json_by_type" | jq \
        --arg type "$backup_type" \
        --argjson count "$type_count" \
        --argjson max "$max_limit" \
        --argjson size "$type_size" \
        --arg sizeHuman "$size_human" \
        --arg status "$retention_status" \
        '. + {($type): {"count": $count, "max": $max, "size_bytes": $size, "size_human": $sizeHuman, "retention_status": $status}}')

      if [[ -n "$latest_timestamp" ]]; then
        json_latest=$(echo "$json_latest" | jq \
          --arg type "$backup_type" \
          --arg timestamp "$latest_timestamp" \
          '. + {($type): $timestamp}')
      fi

      # Check for health issues
      if [[ "$backup_type" != "migration" && $max_limit -gt 0 && $type_count -gt $max_limit ]]; then
        overall_health="warning"
        health_issues+=("$backup_type: $type_count backups exceeds limit of $max_limit")
      fi
    fi
  done

  # Total size human readable
  local total_size_human
  if command -v numfmt &> /dev/null; then
    total_size_human=$(numfmt --to=iec-i --suffix=B "$total_size" 2>/dev/null || echo "${total_size}B")
  else
    if [[ $total_size -ge 1048576 ]]; then
      total_size_human="$(awk "BEGIN {printf \"%.1f\", $total_size/1048576}") MB"
    elif [[ $total_size -ge 1024 ]]; then
      total_size_human="$(awk "BEGIN {printf \"%.1f\", $total_size/1024}") KB"
    else
      total_size_human="${total_size}B"
    fi
  fi

  # Check disk space availability
  local disk_available
  disk_available=$(df -B1 "$backup_dir" 2>/dev/null | awk 'NR==2 {print $4}' || echo "0")
  if [[ $disk_available -lt 10485760 ]]; then
    overall_health="critical"
    health_issues+=("Low disk space: less than 10MB available")
  elif [[ $disk_available -lt 104857600 ]]; then
    [[ "$overall_health" == "healthy" ]] && overall_health="warning"
    health_issues+=("Disk space warning: less than 100MB available")
  else
    health_checks+=("Disk space available")
  fi

  # Check for orphaned backups
  local orphan_count=0
  while IFS= read -r -d '' orphan; do
    local orphan_name
    orphan_name=$(basename "$orphan")
    if [[ "$orphan_name" =~ ^backup_ ]]; then
      ((orphan_count++)) || true
    fi
  done < <(find "$backup_dir" -maxdepth 1 -type d -name "backup_*" -print0 2>/dev/null)

  if [[ $orphan_count -gt 0 ]]; then
    [[ "$overall_health" == "healthy" ]] && overall_health="warning"
    health_issues+=("$orphan_count legacy backup(s) in root directory (consider migrating)")
  else
    health_checks+=("No orphaned backups")
  fi

  # Retention policies enforced check
  local retention_ok=true
  for bt in snapshot safety archive; do
    local tc tc_max
    tc=$(echo "$json_by_type" | jq -r --arg t "$bt" '.[$t].count // 0')
    tc_max=$(echo "$json_by_type" | jq -r --arg t "$bt" '.[$t].max // 0')
    if [[ $tc -gt $tc_max && $tc_max -gt 0 ]]; then
      retention_ok=false
      break
    fi
  done
  [[ "$retention_ok" == true ]] && health_checks+=("Retention policies enforced")

  # Text output continuation
  if [[ "$FORMAT" != "json" ]]; then
    echo "  ---------------------------------"
    printf "  %-12s %8s\n" "Total:" "$total_size_human"
    echo ""

    echo -e "${BLUE}Retention Status:${NC}"
    for backup_type in "${BACKUP_TYPES[@]}"; do
      local cnt mx st
      cnt=$(echo "$json_by_type" | jq -r --arg t "$backup_type" '.[$t].count // 0')
      mx=$(echo "$json_by_type" | jq -r --arg t "$backup_type" '.[$t].max // 0')
      st=$(echo "$json_by_type" | jq -r --arg t "$backup_type" '.[$t].retention_status // "n/a"')

      if [[ "$cnt" != "0" && "$cnt" != "null" ]]; then
        local limit_disp
        if [[ "$backup_type" == "migration" ]] || [[ "$mx" == "0" ]]; then
          limit_disp="∞"
        else
          limit_disp="$mx"
        fi
        printf "  %-12s %d/%s (%s)\n" "$backup_type:" "$cnt" "$limit_disp" "$st"
      fi
    done
    echo ""

    echo -e "${BLUE}Latest Backups:${NC}"
    local has_latest=false
    for backup_type in "${BACKUP_TYPES[@]}"; do
      local ts
      ts=$(echo "$json_latest" | jq -r --arg t "$backup_type" '.[$t] // empty')
      if [[ -n "$ts" && "$ts" != "null" ]]; then
        has_latest=true
        local relative_time="" ts_epoch now_epoch
        ts_epoch=$(date -d "$ts" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null || echo 0)
        now_epoch=$(date +%s)
        if [[ $ts_epoch -gt 0 ]]; then
          local diff=$((now_epoch - ts_epoch))
          if [[ $diff -lt 60 ]]; then
            relative_time="just now"
          elif [[ $diff -lt 3600 ]]; then
            relative_time="$((diff / 60)) minutes ago"
          elif [[ $diff -lt 86400 ]]; then
            relative_time="$((diff / 3600)) hours ago"
          else
            relative_time="$((diff / 86400)) days ago"
          fi
        fi
        local display_ts
        display_ts=$(echo "$ts" | sed 's/T/ /; s/Z$//')
        if [[ -n "$relative_time" ]]; then
          printf "  %-12s %s (%s)\n" "$backup_type:" "$display_ts" "$relative_time"
        else
          printf "  %-12s %s\n" "$backup_type:" "$display_ts"
        fi
      fi
    done
    [[ "$has_latest" == false ]] && echo "  No backups found"
    echo ""

    local health_color health_text
    case "$overall_health" in
      healthy)  health_color="$GREEN"; health_text="GOOD" ;;
      warning)  health_color="$YELLOW"; health_text="WARNING" ;;
      critical) health_color="$RED"; health_text="CRITICAL" ;;
      *)        health_color="$NC"; health_text="UNKNOWN" ;;
    esac

    echo -e "Health: ${health_color}${health_text}${NC}"
    for check in "${health_checks[@]}"; do
      echo -e "  ${GREEN}✓${NC} $check"
    done
    for issue in "${health_issues[@]}"; do
      echo -e "  ${YELLOW}⚠${NC} $issue"
    done
    echo ""
  fi

  # JSON output
  if [[ "$FORMAT" == "json" ]]; then
    local health_checks_json="[]"
    local health_issues_json="[]"
    for check in "${health_checks[@]}"; do
      health_checks_json=$(echo "$health_checks_json" | jq --arg c "$check" '. + [$c]')
    done
    for issue in "${health_issues[@]}"; do
      health_issues_json=$(echo "$health_issues_json" | jq --arg i "$issue" '. + [$i]')
    done

    jq -n \
      --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
      --arg dir "$backup_dir" \
      --arg status "$overall_health" \
      --argjson totalSize "$total_size" \
      --arg totalSizeHuman "$total_size_human" \
      --argjson byType "$json_by_type" \
      --argjson latest "$json_latest" \
      --argjson checks "$health_checks_json" \
      --argjson issues "$health_issues_json" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "backup",
          "subcommand": "status",
          "timestamp": $timestamp,
          "format": "json"
        },
        "status": $status,
        "total_size_bytes": $totalSize,
        "total_size_human": $totalSizeHuman,
        "by_type": $byType,
        "latest": $latest,
        "health": {
          "status": $status,
          "checks": $checks,
          "issues": $issues
        },
        "directory": $dir
      }'
  fi

  return 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --destination)
      DESTINATION="$2"
      shift 2
      ;;
    --compress)
      COMPRESS=true
      shift
      ;;
    --name|-n)
      CUSTOM_NAME="$2"
      shift 2
      ;;
    --list|-l)
      LIST_MODE=true
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
      FORMAT="text"
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
    --auto)
      AUTO_MODE=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    verify)
      VERIFY_MODE=true
      shift
      if [[ $# -gt 0 && ! "$1" =~ ^- ]]; then
        VERIFY_TARGET="$1"
        shift
      fi
      ;;
    status)
      STATUS_MODE=true
      shift
      ;;
    find|search)
      FIND_MODE=true
      [[ "$1" == "search" ]] && SEARCH_MODE=true
      shift
      # Parse find/search-specific options
      while [[ $# -gt 0 ]]; do
        case $1 in
          --since)
            FIND_SINCE="$2"
            shift 2
            ;;
          --until)
            FIND_UNTIL="$2"
            shift 2
            ;;
          --on)
            FIND_ON="$2"
            shift 2
            ;;
          --type)
            FIND_TYPE="$2"
            shift 2
            ;;
          --name)
            FIND_NAME="$2"
            shift 2
            ;;
          --grep|--contains)
            FIND_GREP="$2"
            shift 2
            ;;
          --task-id)
            FIND_TASK_ID="$2"
            shift 2
            ;;
          --limit)
            FIND_LIMIT="$2"
            shift 2
            ;;
          -f|--format)
            FORMAT="$2"
            shift 2
            ;;
          --human)
            FORMAT="text"
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
          --verbose)
            VERBOSE=true
            shift
            ;;
          -h|--help)
            usage
            ;;
          -*)
            log_error "Unknown find/search option: $1"
            exit "${EXIT_USAGE_ERROR:-64}"
            ;;
          *)
            break
            ;;
        esac
      done
      ;;
    -*)
      if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_INPUT_INVALID" "Unknown option: $1" "${EXIT_USAGE_ERROR:-64}" false "Run 'cleo backup --help' for usage"
      else
        log_error "Unknown option: $1"
      fi
      exit "${EXIT_USAGE_ERROR:-64}"
      ;;
    *)
      # Capture positional arguments (like backup ID for verify)
      if [[ "$VERIFY_MODE" == true && -z "$VERIFY_TARGET" ]]; then
        VERIFY_TARGET="$1"
      fi
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

# Check if backups are enabled via config (v0.24.0+)
# Skip this check for --list and verify modes as they should always work
if [[ "$LIST_MODE" != true && "$VERIFY_MODE" != true ]]; then
  BACKUP_ENABLED="true"
  if declare -f get_config_value >/dev/null 2>&1; then
    BACKUP_ENABLED=$(get_config_value "backup.enabled" "true")
  elif [[ -f "$CONFIG_FILE" ]]; then
    BACKUP_ENABLED=$(jq -r '.backup.enabled // true' "$CONFIG_FILE" 2>/dev/null || echo "true")
  fi

  if [[ "$BACKUP_ENABLED" != "true" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -n \
        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "backup",
            "timestamp": $timestamp,
            "format": "json"
          },
          "success": true,
          "skipped": true,
          "reason": "Backups disabled by config (backup.enabled=false)"
        }'
    else
      log_info "Backups disabled by config (backup.enabled=false)"
    fi
    exit "$EXIT_SUCCESS"
  fi
fi

check_deps

# Set backup directory from config or CLI override (v0.24.0+)
# Priority: CLI --destination > config backup.directory > default
if [[ -n "$DESTINATION" ]]; then
  BACKUP_DIR="$DESTINATION"
elif declare -f get_config_value >/dev/null 2>&1; then
  BACKUP_DIR=$(get_config_value "backup.directory" ".cleo/backups")
elif [[ -f "$CONFIG_FILE" ]]; then
  BACKUP_DIR=$(jq -r '.backup.directory // ".cleo/backups"' "$CONFIG_FILE" 2>/dev/null || echo ".cleo/backups")
fi

# Handle --list mode
if [[ "$LIST_MODE" == true ]]; then
  list_backups "$BACKUP_DIR"
  exit "$EXIT_SUCCESS"
fi

# Handle verify subcommand
if [[ "$VERIFY_MODE" == true ]]; then
  if [[ -z "$VERIFY_TARGET" ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -n \
        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "backup",
            "subcommand": "verify",
            "timestamp": $timestamp,
            "format": "json"
          },
          "success": false,
          "error": {
            "code": "INVALID_INPUT",
            "message": "Missing backup ID or path",
            "recoverable": true,
            "suggestion": "Usage: cleo backup verify <backup-id|path>"
          }
        }'
    else
      log_error "Missing backup ID or path"
      echo "Usage: cleo backup verify <backup-id|path>"
      echo ""
      echo "Examples:"
      echo "  cleo backup verify snapshot_20251215_120000"
      echo "  cleo backup verify .cleo/backups/safety/safety_20251215"
    fi
    exit $EXIT_INVALID_INPUT
  fi
  verify_backup "$VERIFY_TARGET" "$BACKUP_DIR"
  # verify_backup calls exit internally
fi

# Handle status subcommand
if [[ "$STATUS_MODE" == true ]]; then
  show_status "$BACKUP_DIR"
  exit "$EXIT_SUCCESS"
fi

# Handle --auto mode (scheduled/interval-based backups)
if [[ "$AUTO_MODE" == true ]]; then
  # Source the backup library for scheduled backup functions
  if [[ -f "$LIB_DIR/backup.sh" ]]; then
    # shellcheck source=../lib/backup.sh
    source "$LIB_DIR/backup.sh"
  else
    log_error "Cannot find backup library"
    exit "${EXIT_FILE_ERROR:-4}"
  fi

  # Check if scheduled backup is due and perform it
  is_due=$(should_auto_backup "$CONFIG_FILE")

  if [[ "$is_due" == "true" ]]; then
    backup_path=$(perform_scheduled_backup "$CONFIG_FILE")

    if [[ -n "$backup_path" ]]; then
      if [[ "$FORMAT" == "json" ]]; then
        jq -n \
          --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
          --arg path "$backup_path" \
          '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
              "command": "backup",
              "subcommand": "auto",
              "timestamp": $timestamp,
              "format": "json"
            },
            "success": true,
            "performed": true,
            "backup": {
              "path": $path,
              "type": "scheduled"
            }
          }'
      else
        log_info "Scheduled backup created: $backup_path"
      fi
    else
      if [[ "$FORMAT" == "json" ]]; then
        jq -n \
          --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
          '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
              "command": "backup",
              "subcommand": "auto",
              "timestamp": $timestamp,
              "format": "json"
            },
            "success": false,
            "performed": false,
            "reason": "Backup creation failed"
          }'
      else
        log_error "Failed to create scheduled backup"
      fi
      exit "$EXIT_GENERAL_ERROR"
    fi
  else
    # Backup not due
    if [[ "$FORMAT" == "json" ]]; then
      last_backup=$(get_last_backup_time "$CONFIG_FILE")
      jq -n \
        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --arg lastBackup "${last_backup:-null}" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "command": "backup",
            "subcommand": "auto",
            "timestamp": $timestamp,
            "format": "json"
          },
          "success": true,
          "performed": false,
          "reason": "Backup not due (interval not elapsed)",
          "lastBackup": (if $lastBackup == "" or $lastBackup == "null" then null else $lastBackup end)
        }'
    else
      if [[ "$QUIET" != true ]]; then
        log_info "Scheduled backup not due (interval not elapsed)"
      fi
    fi
  fi
  exit "$EXIT_SUCCESS"
fi

# Handle find/search subcommand
if [[ "$FIND_MODE" == true ]]; then
  # Source the backup library for find_backups function
  if [[ -f "$LIB_DIR/backup.sh" ]]; then
    # shellcheck source=../lib/backup.sh
    source "$LIB_DIR/backup.sh"
  else
    log_error "Cannot find backup library"
    exit "${EXIT_FILE_ERROR:-4}"
  fi

  # Determine verbose mode string
  VERBOSE_STR="false"
  [[ "$VERBOSE" == true ]] && VERBOSE_STR="true"

  # Run the search with all parameters
  # Args: since, until, type, name, grep, limit, on, task_id, verbose
  results_json=$(find_backups "$FIND_SINCE" "$FIND_UNTIL" "$FIND_TYPE" "$FIND_NAME" "$FIND_GREP" "$FIND_LIMIT" "$FIND_ON" "$FIND_TASK_ID" "$VERBOSE_STR")

  result_count=$(echo "$results_json" | jq 'length')

  # Determine subcommand name
  SUBCOMMAND_NAME="find"
  [[ "$SEARCH_MODE" == true ]] && SUBCOMMAND_NAME="search"

  if [[ "$FORMAT" == "json" ]]; then
    # JSON output
    jq -n \
      --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
      --arg dir "$BACKUP_DIR" \
      --argjson results "$results_json" \
      --argjson count "$result_count" \
      --argjson limit "$FIND_LIMIT" \
      --arg since "${FIND_SINCE:-}" \
      --arg until "${FIND_UNTIL:-}" \
      --arg onDate "${FIND_ON:-}" \
      --arg type "$FIND_TYPE" \
      --arg namePattern "${FIND_NAME:-}" \
      --arg grepPattern "${FIND_GREP:-}" \
      --arg taskId "${FIND_TASK_ID:-}" \
      --argjson verbose "$([[ "$VERBOSE" == true ]] && echo true || echo false)" \
      --arg subcommand "$SUBCOMMAND_NAME" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "backup",
          "subcommand": $subcommand,
          "timestamp": $timestamp,
          "format": "json"
        },
        "success": true,
        "count": $count,
        "limit": $limit,
        "filters": {
          "since": (if $since == "" then null else $since end),
          "until": (if $until == "" then null else $until end),
          "on": (if $onDate == "" then null else $onDate end),
          "type": $type,
          "namePattern": (if $namePattern == "" then null else $namePattern end),
          "grepPattern": (if $grepPattern == "" then null else $grepPattern end),
          "taskId": (if $taskId == "" then null else $taskId end),
          "verbose": $verbose
        },
        "backups": $results,
        "directory": $dir
      }'
  else
    # Text output
    echo ""
    if [[ $result_count -eq 0 ]]; then
      echo "No backups found matching criteria."
      echo ""
      echo -e "${BLUE}Filters applied:${NC}"
      [[ -n "$FIND_SINCE" ]] && echo "  Since: $FIND_SINCE"
      [[ -n "$FIND_UNTIL" ]] && echo "  Until: $FIND_UNTIL"
      [[ -n "$FIND_ON" ]] && echo "  On date: $FIND_ON"
      [[ "$FIND_TYPE" != "all" ]] && echo "  Type: $FIND_TYPE"
      [[ -n "$FIND_NAME" ]] && echo "  Name pattern: $FIND_NAME"
      [[ -n "$FIND_GREP" ]] && echo "  Content grep: $FIND_GREP"
      [[ -n "$FIND_TASK_ID" ]] && echo "  Task ID: $FIND_TASK_ID"
      echo ""
      echo "Try 'cleo backup --list' to see all backups."
    else
      truncated=""
      if [[ $result_count -ge $FIND_LIMIT ]]; then
        truncated=" (limit: $FIND_LIMIT)"
      fi

      echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
      echo -e "${BLUE}║                           BACKUP SEARCH RESULTS                              ║${NC}"
      echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
      echo ""
      echo -e "Found ${GREEN}$result_count${NC} backup(s)${truncated}"
      echo ""

      # Print filters if any active
      if [[ -n "$FIND_SINCE" || -n "$FIND_UNTIL" || -n "$FIND_ON" || "$FIND_TYPE" != "all" || -n "$FIND_NAME" || -n "$FIND_GREP" || -n "$FIND_TASK_ID" ]]; then
        echo -e "${BLUE}Filters:${NC}"
        [[ -n "$FIND_SINCE" ]] && echo "  Since: $FIND_SINCE"
        [[ -n "$FIND_UNTIL" ]] && echo "  Until: $FIND_UNTIL"
        [[ -n "$FIND_ON" ]] && echo "  On date: $FIND_ON"
        [[ "$FIND_TYPE" != "all" ]] && echo "  Type: $FIND_TYPE"
        [[ -n "$FIND_NAME" ]] && echo "  Name pattern: $FIND_NAME"
        [[ -n "$FIND_GREP" ]] && echo "  Content grep: $FIND_GREP"
        [[ -n "$FIND_TASK_ID" ]] && echo "  Task ID: $FIND_TASK_ID"
        echo ""
      fi

      # Table header
      printf "  ${BLUE}%-12s${NC} ${BLUE}%-20s${NC} ${BLUE}%-35s${NC} ${BLUE}%10s${NC}\n" "TYPE" "TIMESTAMP" "NAME" "SIZE"
      printf "  %-12s %-20s %-35s %10s\n" "------------" "--------------------" "-----------------------------------" "----------"

      # Print each result
      echo "$results_json" | jq -r '.[] | "\(.type)\t\(.timestamp)\t\(.name)\t\(.sizeHuman)\t\(.matchedSnippets // [] | join("; "))"' | while IFS=$'\t' read -r btype btimestamp bname bsize bsnippets; do
        # Format timestamp for display (remove T and Z)
        display_ts=$(echo "$btimestamp" | sed 's/T/ /; s/Z$//' | cut -c1-19)

        # Truncate name if too long
        display_name="$bname"
        if [[ ${#display_name} -gt 35 ]]; then
          display_name="${display_name:0:32}..."
        fi

        printf "  %-12s %-20s %-35s %10s\n" "$btype" "$display_ts" "$display_name" "$bsize"

        # Show matched snippets in verbose mode
        if [[ "$VERBOSE" == true && -n "$bsnippets" && "$bsnippets" != "null" ]]; then
          echo -e "    ${YELLOW}Matched:${NC} $bsnippets"
        fi
      done

      echo ""
      echo -e "Use '${GREEN}cleo backup verify <NAME>${NC}' to verify a backup."
      echo -e "Use '${GREEN}cleo restore <NAME>${NC}' to restore from a backup."
    fi
    echo ""
  fi

  exit "$EXIT_SUCCESS"
fi

# Create timestamped backup directory
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Build backup name with optional custom name
if [[ -n "$CUSTOM_NAME" ]]; then
  # Sanitize custom name (remove special chars, replace spaces with hyphens)
  SAFE_NAME=$(echo "$CUSTOM_NAME" | tr -cs '[:alnum:]-' '-' | tr '[:upper:]' '[:lower:]' | sed 's/^-//;s/-$//')
  BACKUP_NAME="backup_${TIMESTAMP}_${SAFE_NAME}"
else
  BACKUP_NAME="backup_${TIMESTAMP}"
fi

BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

log_info "Creating backup: $BACKUP_NAME"

# Create backup directory if it doesn't exist
if [[ ! -d "$BACKUP_DIR" ]]; then
  mkdir -p "$BACKUP_DIR"
  log_debug "Created backup directory: $BACKUP_DIR"
fi

# Create timestamped subdirectory
mkdir -p "$BACKUP_PATH"
log_debug "Created backup path: $BACKUP_PATH"

# Track backed up files and total size
BACKED_UP_FILES=()
TOTAL_SIZE=0
VALIDATION_ERRORS=0

# Backup function
backup_file() {
  local source="$1"
  local name="$2"

  if validate_file "$source" "$name"; then
    cp "$source" "${BACKUP_PATH}/$(basename "$source")"
    BACKED_UP_FILES+=("$name")

    local size
    size=$(stat -c%s "$source" 2>/dev/null || stat -f%z "$source" 2>/dev/null || echo 0)
    TOTAL_SIZE=$((TOTAL_SIZE + size))

    log_debug "Backed up $name ($(get_size "$source"))"
  else
    ((VALIDATION_ERRORS++))
  fi
}

# Backup all files
log_info "Backing up files..."
backup_file "$TODO_FILE" "todo.json"
backup_file "$ARCHIVE_FILE" "todo-archive.json"
backup_file "$CONFIG_FILE" "config.json"
backup_file "$LOG_FILE" "todo-log.json"

# Check if any files were backed up
if [[ ${#BACKED_UP_FILES[@]} -eq 0 ]]; then
  if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
    output_error "$E_FILE_NOT_FOUND" "No files were backed up" "${EXIT_FILE_ERROR:-4}" true "Ensure todo files exist in .cleo/ directory"
  else
    log_error "No files were backed up"
  fi
  rmdir "$BACKUP_PATH" 2>/dev/null || true
  exit "${EXIT_FILE_ERROR:-4}"
fi

# Create metadata file
METADATA_FILE="${BACKUP_PATH}/backup-metadata.json"

# Build JSON with optional customName field
if [[ -n "$CUSTOM_NAME" ]]; then
  CUSTOM_NAME_JSON="\"customName\": \"$CUSTOM_NAME\","
else
  CUSTOM_NAME_JSON=""
fi

cat > "$METADATA_FILE" << EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "backupName": "$BACKUP_NAME",
  ${CUSTOM_NAME_JSON}
  "files": $(printf '%s\n' "${BACKED_UP_FILES[@]}" | jq -R . | jq -s .),
  "totalSize": $TOTAL_SIZE,
  "validationErrors": $VALIDATION_ERRORS,
  "compressed": $COMPRESS,
  "hostname": "$(hostname)",
  "user": "${USER:-unknown}"
}
EOF

log_debug "Created metadata file"

# Validate all backed up files
log_info "Validating backup integrity..."
BACKUP_VALIDATION_ERRORS=0

for file in "${BACKUP_PATH}"/*.json; do
  if [[ "$(basename "$file")" != "backup-metadata.json" ]]; then
    if ! jq empty "$file" 2>/dev/null; then
      if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_VALIDATION_SCHEMA" "Backup validation failed for $(basename "$file")" "${EXIT_VALIDATION_ERROR:-2}" false "Fix JSON syntax before retry"
      else
        log_error "Backup validation failed for $(basename "$file")"
      fi
      ((BACKUP_VALIDATION_ERRORS++))
    fi
  fi
done

if [[ $BACKUP_VALIDATION_ERRORS -gt 0 ]]; then
  if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
    output_error "$E_VALIDATION_SCHEMA" "Backup validation failed with $BACKUP_VALIDATION_ERRORS errors" "${EXIT_VALIDATION_ERROR:-2}" false "Review and fix the corrupted backup files"
  else
    log_error "Backup validation failed with $BACKUP_VALIDATION_ERRORS errors"
  fi
  exit "${EXIT_VALIDATION_ERROR:-2}"
fi

log_info "Backup validation successful"

# Compress if requested
if [[ "$COMPRESS" == true ]]; then
  log_info "Compressing backup..."

  TARBALL="${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
  tar -czf "$TARBALL" -C "$BACKUP_DIR" "$BACKUP_NAME"

  if [[ -f "$TARBALL" ]]; then
    TARBALL_SIZE=$(get_size "$TARBALL")
    log_info "Created compressed archive: $TARBALL ($TARBALL_SIZE)"

    # Remove uncompressed directory
    rm -rf "$BACKUP_PATH"
    BACKUP_PATH="$TARBALL"
  else
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_FILE_WRITE_ERROR" "Failed to create compressed archive" "${EXIT_FILE_ERROR:-4}" false "Check disk space and tar installation"
    else
      log_error "Failed to create compressed archive"
    fi
    exit "${EXIT_FILE_ERROR:-4}"
  fi
fi

# Calculate total size in human-readable format
if command -v numfmt &> /dev/null; then
  TOTAL_SIZE_HUMAN=$(numfmt --to=iec-i --suffix=B "$TOTAL_SIZE")
else
  TOTAL_SIZE_HUMAN="${TOTAL_SIZE}B"
fi

# Get tasks count from todo.json for JSON output
TASKS_COUNT=0
if [[ -f "$TODO_FILE" ]]; then
  TASKS_COUNT=$(jq '.tasks | length' "$TODO_FILE" 2>/dev/null || echo 0)
fi

# Summary
if [[ "$FORMAT" == "json" ]]; then
  # JSON output
  jq -n \
    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --arg path "$BACKUP_PATH" \
    --arg name "$BACKUP_NAME" \
    --argjson size "$TOTAL_SIZE" \
    --arg sizeHuman "$TOTAL_SIZE_HUMAN" \
    --argjson tasksCount "$TASKS_COUNT" \
    --argjson compressed "$COMPRESS" \
    --argjson validationWarnings "$VALIDATION_ERRORS" \
    --argjson files "$(printf '%s\n' "${BACKED_UP_FILES[@]}" | jq -R . | jq -s .)" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "command": "backup",
        "timestamp": $timestamp,
        "version": $version,
        "format": "json"
      },
      "success": true,
      "backup": {
        "path": $path,
        "name": $name,
        "size": $size,
        "sizeHuman": $sizeHuman,
        "tasksCount": $tasksCount,
        "files": $files,
        "compressed": $compressed,
        "validationWarnings": $validationWarnings
      }
    }'
else
  # Text output
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║              BACKUP COMPLETED SUCCESSFULLY               ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${BLUE}Backup Location:${NC}"
  echo -e "    $BACKUP_PATH"
  echo ""
  echo -e "  ${BLUE}Files Included:${NC}"
  for file in "${BACKED_UP_FILES[@]}"; do
    echo -e "    ✓ $file"
  done
  echo ""
  echo -e "  ${BLUE}Total Size:${NC} $TOTAL_SIZE_HUMAN"
  echo ""

  if [[ $VALIDATION_ERRORS -gt 0 ]]; then
    echo -e "  ${YELLOW}⚠  Warning:${NC} $VALIDATION_ERRORS file(s) had issues during backup"
    echo ""
  fi
fi

# Clean old backups if configured using config.sh library for priority resolution
# Uses backup.maxSnapshots config setting (v0.24.0+)
if declare -f get_config_value >/dev/null 2>&1; then
  MAX_BACKUPS=$(get_config_value "backup.maxSnapshots" "10")
elif [[ -f "$CONFIG_FILE" ]]; then
  # Fallback to direct jq if config.sh not available
  MAX_BACKUPS=$(jq -r '.backup.maxSnapshots // 10' "$CONFIG_FILE" 2>/dev/null || echo 10)
else
  MAX_BACKUPS=10
fi

if [[ "$MAX_BACKUPS" -gt 0 ]]; then
  log_debug "Checking backup retention (max: $MAX_BACKUPS)"

  # Count backups (both directories and tarballs)
  BACKUP_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 \( -type d -name "backup_*" -o -type f -name "backup_*.tar.gz" \) | wc -l)

  if [[ $BACKUP_COUNT -gt $MAX_BACKUPS ]]; then
    REMOVE_COUNT=$((BACKUP_COUNT - MAX_BACKUPS))
    log_info "Removing $REMOVE_COUNT old backup(s) (retention: $MAX_BACKUPS)"

    # Remove oldest backups
    find "$BACKUP_DIR" -maxdepth 1 \( -type d -name "backup_*" -o -type f -name "backup_*.tar.gz" \) -printf '%T+ %p\n' | \
      sort | \
      head -n "$REMOVE_COUNT" | \
      cut -d' ' -f2- | \
      while read -r old_backup; do
        rm -rf "$old_backup"
        log_debug "Removed old backup: $(basename "$old_backup")"
      done
  fi
fi

exit "$EXIT_SUCCESS"
