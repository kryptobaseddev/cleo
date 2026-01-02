#!/usr/bin/env bash
# CLEO Init Script
# Initialize the todo system in a project directory
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source paths.sh for path resolution functions
if [[ -f "$CLEO_HOME/lib/paths.sh" ]]; then
    source "$CLEO_HOME/lib/paths.sh"
elif [[ -f "$SCRIPT_DIR/../lib/paths.sh" ]]; then
    source "$SCRIPT_DIR/../lib/paths.sh"
fi

# Source version from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Unset any existing log functions to prevent conflicts on re-initialization
unset -f log_info log_error log_warn log_debug 2>/dev/null || true

# Guard for re-sourcing libraries
if [[ -n "${_INIT_LOGGING_SOURCED:-}" ]]; then
    # Already sourced, skip
    :
else
    # Source library functions
    if [[ -f "$CLEO_HOME/lib/logging.sh" ]]; then
        source "$CLEO_HOME/lib/logging.sh"
        _INIT_LOGGING_SOURCED=true
    fi
fi

# Always define console logging functions (lib/logging.sh provides task logging, not console output)
log_info()    { echo "[INFO] $1"; }
log_warn()    { echo "[WARN] $1" >&2; }
log_success() { echo "[SUCCESS] $1"; }
# Only define log_error if not already defined by library
type -t log_error &>/dev/null || log_error() { echo "[ERROR] $1" >&2; }

# Optional: source other libraries if needed (with guards)
if [[ -z "${_INIT_FILE_OPS_SOURCED:-}" ]]; then
    [[ -f "$CLEO_HOME/lib/file-ops.sh" ]] && source "$CLEO_HOME/lib/file-ops.sh" && _INIT_FILE_OPS_SOURCED=true || true
fi
if [[ -z "${_INIT_VALIDATION_SOURCED:-}" ]]; then
    [[ -f "$CLEO_HOME/lib/validation.sh" ]] && source "$CLEO_HOME/lib/validation.sh" && _INIT_VALIDATION_SOURCED=true || true
fi
if [[ -z "${_INIT_BACKUP_SOURCED:-}" ]]; then
    [[ -f "$CLEO_HOME/lib/backup.sh" ]] && source "$CLEO_HOME/lib/backup.sh" && _INIT_BACKUP_SOURCED=true || true
fi

# Defaults
FORCE=false
CONFIRM_WIPE=false
NO_CLAUDE_MD=false
UPDATE_CLAUDE_MD=false
PROJECT_NAME=""
FORMAT=""
QUIET=false
COMMAND_NAME="init"

# Source required libraries for LLM-Agent-First compliance
LIB_DIR="$CLEO_HOME/lib"
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
    source "$LIB_DIR/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
    source "$LIB_DIR/error-json.sh"
fi

# Source output formatting and error libraries
LIB_DIR="$CLEO_HOME/lib"
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  source "$LIB_DIR/output-format.sh"
fi
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  source "$LIB_DIR/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  source "$LIB_DIR/error-json.sh"
fi

usage() {
  cat << EOF
Usage: cleo init [PROJECT_NAME] [OPTIONS]

Initialize CLEO in the current directory.

Options:
  --force             Signal intent to reinitialize (requires --confirm-wipe)
  --confirm-wipe      Confirm data destruction when used with --force
  --no-claude-md      Skip CLAUDE.md integration
  --update-claude-md  Update existing CLAUDE.md injection (idempotent)
  --update-docs       Alias for --update-claude-md
  --target FILE       Target doc file for injection (CLAUDE.md, AGENTS.md, GEMINI.md)
  -f, --format FMT    Output format: text, json (default: auto-detect)
  --human             Force human-readable text output
  --json              Force JSON output
  -q, --quiet         Suppress non-essential output
  -h, --help          Show this help

DESTRUCTIVE REINITIALIZE:
  Both --force AND --confirm-wipe are required to reinitialize an existing
  project. This will:
  1. Create a safety backup of ALL existing data files
  2. PERMANENTLY WIPE: todo.json, todo-archive.json, config.json, todo-log.json
  3. Initialize fresh data files

  Example: cleo init --force --confirm-wipe

Exit Codes:
  0   - Success
  101 - Project already initialized (use --force --confirm-wipe to reinitialize)
  2   - Invalid input (--force without --confirm-wipe)

Creates:
  .cleo/todo.json         Active tasks
  .cleo/todo-archive.json Completed tasks
  .cleo/config.json       Configuration
  .cleo/todo-log.json     Change history
  .cleo/sessions.json     Multi-session management
  .cleo/schemas/          JSON Schema files
  .cleo/.backups/         Backup directory

JSON Output:
  {
    "_meta": {"command": "init", "timestamp": "..."},
    "success": true,
    "initialized": {"directory": ".cleo", "files": ["todo.json", ...]}
  }

Examples:
  cleo init                    # Initialize in current directory
  cleo init my-project         # Initialize with project name
  cleo init --json             # JSON output for scripting
  cleo init --update-claude-md # Update CLAUDE.md injection
EOF
  exit 0
}

calculate_checksum() {
  # Calculate SHA-256 checksum of empty tasks array, truncated to 16 chars
  # Must match validate.sh: jq -c '.tasks' outputs with newline
  echo '[]' | sha256sum | cut -c1-16
}

generate_timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --force) FORCE=true; shift ;;
    --confirm-wipe) CONFIRM_WIPE=true; shift ;;
    --no-claude-md) NO_CLAUDE_MD=true; shift ;;
    --update-claude-md|--update-docs) UPDATE_CLAUDE_MD=true; shift ;;
    --target) TARGET_FILE="$2"; UPDATE_CLAUDE_MD=true; shift 2 ;;
    -f|--format) FORMAT="$2"; shift 2 ;;
    --human) FORMAT="text"; shift ;;
    --json) FORMAT="json"; shift ;;
    -q|--quiet) QUIET=true; shift ;;
    -h|--help) usage ;;
    -*)
      if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_INPUT_INVALID" "Unknown option: $1" "${EXIT_INVALID_INPUT:-1}" true "Run 'cleo init --help' for usage"
      else
        output_error "$E_INPUT_INVALID" "Unknown option: $1"
      fi
      exit "${EXIT_INVALID_INPUT:-1}"
      ;;
    *) PROJECT_NAME="$1"; shift ;;
  esac
done

# Resolve output format (CLI > env > config > TTY-aware default)
if declare -f resolve_format &>/dev/null; then
  FORMAT=$(resolve_format "$FORMAT")
else
  FORMAT="${FORMAT:-text}"
fi

# Redefine log functions to respect FORMAT
log_info()    { [[ "$QUIET" != true && "$FORMAT" != "json" ]] && echo "[INFO] $1" || true; }
log_warn()    { [[ "$FORMAT" != "json" ]] && echo "[WARN] $1" >&2 || true; }
log_success() { [[ "$FORMAT" != "json" ]] && echo "[SUCCESS] $1" || true; }
log_error()   { [[ "$FORMAT" != "json" ]] && echo "[ERROR] $1" >&2 || true; }

# Handle --update-claude-md as standalone operation
if [[ "$UPDATE_CLAUDE_MD" == true ]]; then
  # Set default target file if not specified
  TARGET_FILE="${TARGET_FILE:-CLAUDE.md}"

  # Validate target file is one of the supported doc files
  case "$TARGET_FILE" in
    CLAUDE.md|AGENTS.md|GEMINI.md) ;;
    *)
      if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
        output_error "$E_INPUT_INVALID" "Invalid target file: $TARGET_FILE. Must be CLAUDE.md, AGENTS.md, or GEMINI.md" "${EXIT_INVALID_INPUT:-2}" true "Use --target CLAUDE.md, AGENTS.md, or GEMINI.md"
      else
        log_error "Invalid target file: $TARGET_FILE. Must be CLAUDE.md, AGENTS.md, or GEMINI.md"
      fi
      exit "${EXIT_INVALID_INPUT:-2}"
      ;;
  esac

  if [[ ! -f "$TARGET_FILE" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_FILE_NOT_FOUND" "$TARGET_FILE not found in current directory" "${EXIT_NOT_FOUND:-4}" true "Create $TARGET_FILE first or run from a directory with $TARGET_FILE"
    else
      log_error "$TARGET_FILE not found in current directory"
    fi
    exit "${EXIT_NOT_FOUND:-1}"
  fi

  injection_template="$CLEO_HOME/templates/AGENT-INJECTION.md"
  if [[ ! -f "$injection_template" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
      output_error "$E_FILE_NOT_FOUND" "Injection template not found: $injection_template" "${EXIT_NOT_FOUND:-4}" false "Reinstall cleo to restore templates"
    else
      log_error "Injection template not found: $injection_template"
    fi
    exit "${EXIT_NOT_FOUND:-1}"
  fi

  action_taken="updated"
  if grep -q "CLEO:START" "$TARGET_FILE" 2>/dev/null; then
    # Remove ALL existing injection blocks (handles multiple/duplicates)
    # and place new injection at TOP of file
    temp_file=$(mktemp)

    # First, add the new injection template at the top
    cat "$injection_template" > "$temp_file"

    # Strip ALL injection blocks using awk (handles multiple START/END pairs)
    # Also removes any leading blank lines from the cleaned content
    awk '
      /<!-- CLEO:START/ { skip = 1; next }
      /<!-- CLEO:END -->/ { skip = 0; next }
      !skip { print }
    ' "$TARGET_FILE" | sed '/./,$!d' >> "$temp_file"

    # Replace original file
    mv "$temp_file" "$TARGET_FILE"
    action_taken="updated"
  else
    # No existing block, prepend new injection at TOP
    temp_file=$(mktemp)
    cat "$injection_template" > "$temp_file"
    echo "" >> "$temp_file"
    cat "$TARGET_FILE" >> "$temp_file"
    mv "$temp_file" "$TARGET_FILE"
    action_taken="added"
  fi

  if [[ "$FORMAT" == "json" ]]; then
    jq -nc \
      --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
      --arg action "$action_taken" \
      --arg version "$VERSION" \
      --arg target "$TARGET_FILE" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "init",
          "subcommand": "update-docs",
          "timestamp": $timestamp,
          "format": "json",
          "version": $version
        },
        "success": true,
        "injection": {
          "action": $action,
          "file": $target
        }
      }'
  else
    if [[ "$action_taken" == "updated" ]]; then
      log_success "$TARGET_FILE injection updated"
    else
      log_success "$TARGET_FILE injection added"
    fi
  fi
  exit 0
fi

# Determine project name
[[ -z "$PROJECT_NAME" ]] && PROJECT_NAME=$(basename "$PWD")
PROJECT_NAME=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')

# ============================================================================
# CHECK FOR EXISTING INITIALIZATION (with proper safeguards)
# ============================================================================

# List of data files that would be wiped during reinitialize
DATA_FILES=("todo.json" "todo-archive.json" "config.json" "todo-log.json")
TODO_DIR=".cleo"

# Check if project is already initialized
_project_initialized() {
    [[ -f "$TODO_DIR/todo.json" ]]
}

# Count existing data files for reporting
_count_existing_files() {
    local count=0
    for file in "${DATA_FILES[@]}"; do
        [[ -f "$TODO_DIR/$file" ]] && ((count++))
    done
    echo "$count"
}

# Create safety backup of ALL data files before destructive reinit
_create_init_safety_backup() {
    local backup_timestamp
    backup_timestamp=$(date +"%Y%m%d_%H%M%S")
    local backup_id="safety_${backup_timestamp}_init_reinitialize"
    local backup_path="$TODO_DIR/backups/safety/$backup_id"
    local files_backed_up=0
    local total_size=0

    # Ensure backup directory exists
    mkdir -p "$backup_path" 2>/dev/null || {
        log_error "Failed to create backup directory: $backup_path"
        return 1
    }

    # Backup each existing data file
    for file in "${DATA_FILES[@]}"; do
        local source_file="$TODO_DIR/$file"
        if [[ -f "$source_file" ]]; then
            cp "$source_file" "$backup_path/$file" || {
                log_error "Failed to backup $file"
                return 1
            }
            ((files_backed_up++))
            # Get file size
            if command -v stat &>/dev/null; then
                local fsize
                fsize=$(stat -c%s "$source_file" 2>/dev/null || stat -f%z "$source_file" 2>/dev/null || echo 0)
                total_size=$((total_size + fsize))
            fi
        fi
    done

    # Create metadata.json for the backup
    if command -v jq &>/dev/null; then
        local ts_iso
        ts_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -nc \
            --arg type "safety" \
            --arg ts "$ts_iso" \
            --arg ver "$VERSION" \
            --arg trigger "init_reinitialize" \
            --arg op "reinitialize" \
            --argjson size "$total_size" \
            --argjson count "$files_backed_up" \
            '{
                backupType: $type,
                timestamp: $ts,
                version: $ver,
                trigger: $trigger,
                operation: $op,
                totalSize: $size,
                fileCount: $count,
                files: [],
                neverDelete: false
            }' > "$backup_path/metadata.json"
    fi

    echo "$backup_path"
    return 0
}

if _project_initialized; then
    existing_count=$(_count_existing_files)

    if [[ "$FORCE" != true ]]; then
        # Project exists, --force not provided
        # Exit with EXIT_ALREADY_EXISTS (101) per LLM-Agent-First spec
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            jq -nc \
                --arg version "$VERSION" \
                --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
                --argjson existingFiles "$existing_count" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "init",
                        "timestamp": $timestamp
                    },
                    "success": false,
                    "error": {
                        "code": "E_ALREADY_INITIALIZED",
                        "message": "Project already initialized at .cleo/todo.json",
                        "exitCode": 101,
                        "recoverable": true,
                        "suggestion": "Use --force --confirm-wipe to reinitialize (DESTRUCTIVE: will wipe all existing data after creating safety backup)",
                        "context": {
                            "existingFiles": $existingFiles,
                            "dataDirectory": ".cleo",
                            "affectedFiles": ["todo.json", "todo-archive.json", "config.json", "todo-log.json"]
                        }
                    }
                }'
        else
            log_warn "Project already initialized at .cleo/todo.json"
            log_warn "Found $existing_count data file(s) that would be WIPED:"
            for file in "${DATA_FILES[@]}"; do
                [[ -f "$TODO_DIR/$file" ]] && log_warn "  - $TODO_DIR/$file"
            done
            log_warn ""
            log_warn "To reinitialize, use BOTH flags: --force --confirm-wipe"
            log_warn "This will create a safety backup before wiping ALL existing data."
        fi
        exit "${EXIT_ALREADY_EXISTS:-101}"
    fi

    if [[ "$CONFIRM_WIPE" != true ]]; then
        # --force provided but --confirm-wipe not provided
        # Exit with EXIT_INVALID_INPUT (2) - missing required confirmation
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            jq -nc \
                --arg version "$VERSION" \
                --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
                --argjson existingFiles "$existing_count" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "init",
                        "timestamp": $timestamp
                    },
                    "success": false,
                    "error": {
                        "code": "E_CONFIRMATION_REQUIRED",
                        "message": "--force requires --confirm-wipe to proceed with destructive reinitialize",
                        "exitCode": 2,
                        "recoverable": true,
                        "suggestion": "Add --confirm-wipe to confirm you want to WIPE all existing data (a safety backup will be created first)",
                        "context": {
                            "existingFiles": $existingFiles,
                            "dataDirectory": ".cleo",
                            "affectedFiles": ["todo.json", "todo-archive.json", "config.json", "todo-log.json"],
                            "safetyBackupLocation": ".cleo/backups/safety/"
                        }
                    }
                }'
        else
            log_error "--force requires --confirm-wipe for destructive reinitialize"
            log_warn ""
            log_warn "⚠️  DESTRUCTIVE OPERATION WARNING ⚠️"
            log_warn "This will PERMANENTLY WIPE $existing_count data file(s):"
            for file in "${DATA_FILES[@]}"; do
                [[ -f "$TODO_DIR/$file" ]] && log_warn "  - $TODO_DIR/$file"
            done
            log_warn ""
            log_warn "A safety backup will be created at: .cleo/backups/safety/"
            log_warn ""
            log_warn "To proceed, run: cleo init --force --confirm-wipe"
        fi
        exit "${EXIT_INVALID_INPUT:-2}"
    fi

    # Both --force and --confirm-wipe provided - proceed with backup then wipe
    log_info "Creating safety backup before reinitialize..."
    backup_path=$(_create_init_safety_backup)
    backup_result=$?

    if [[ $backup_result -ne 0 ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "E_FILE_WRITE_ERROR" "Failed to create safety backup - aborting reinitialize" "${EXIT_FILE_ERROR:-3}" false "Check disk space and permissions for .cleo/backups/safety/"
        else
            log_error "Failed to create safety backup - aborting reinitialize"
            log_error "Existing data has NOT been modified."
        fi
        exit "${EXIT_FILE_ERROR:-3}"
    fi

    log_info "Safety backup created at: $backup_path"
    log_warn "Proceeding with DESTRUCTIVE reinitialize - wiping existing data..."

    # Remove existing data files (backup already created)
    for file in "${DATA_FILES[@]}"; do
        [[ -f "$TODO_DIR/$file" ]] && rm -f "$TODO_DIR/$file"
    done
fi

TIMESTAMP=$(generate_timestamp)
CHECKSUM=$(calculate_checksum)
# TODO_DIR already set above in the safeguard section

# Determine templates and schemas directories (installed or source)
if [[ -d "$CLEO_HOME/templates" ]]; then
  TEMPLATES_DIR="$CLEO_HOME/templates"
elif [[ -d "$SCRIPT_DIR/../templates" ]]; then
  TEMPLATES_DIR="$SCRIPT_DIR/../templates"
else
  if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
    output_error "$E_FILE_NOT_FOUND" "Templates directory not found at $CLEO_HOME/templates/ or $SCRIPT_DIR/../templates/" "${EXIT_FILE_ERROR:-4}" true "Run install.sh to set up CLEO globally, or run from source directory."
  else
    output_error "$E_FILE_NOT_FOUND" "Templates directory not found at $CLEO_HOME/templates/ or $SCRIPT_DIR/../templates/"
    log_error "Run install.sh to set up CLEO globally, or run from source directory."
  fi
  exit "${EXIT_FILE_ERROR:-1}"
fi

if [[ -d "$CLEO_HOME/schemas" ]]; then
  SCHEMAS_DIR="$CLEO_HOME/schemas"
elif [[ -d "$SCRIPT_DIR/../schemas" ]]; then
  SCHEMAS_DIR="$SCRIPT_DIR/../schemas"
else
  SCHEMAS_DIR=""
fi

log_info "Initializing CLEO for project: $PROJECT_NAME"

# Create .cleo directory structure
mkdir -p "$TODO_DIR"
mkdir -p "$TODO_DIR/schemas"

# Copy backup directory structure from templates
if [[ -d "$TEMPLATES_DIR/backups" ]]; then
  # Create backups directory first
  mkdir -p "$TODO_DIR/backups"
  # Copy backup type directories and .gitkeep files
  for backup_type in snapshot safety incremental archive migration; do
    if [[ -d "$TEMPLATES_DIR/backups/$backup_type" ]]; then
      mkdir -p "$TODO_DIR/backups/$backup_type"
      # Copy .gitkeep if it exists
      if [[ -f "$TEMPLATES_DIR/backups/$backup_type/.gitkeep" ]]; then
        cp "$TEMPLATES_DIR/backups/$backup_type/.gitkeep" "$TODO_DIR/backups/$backup_type/"
      fi
    fi
  done
  log_info "Created $TODO_DIR/ directory with backup type subdirectories from templates"
else
  # Fallback: create directories manually if templates not available
  mkdir -p "$TODO_DIR/backups/snapshot"
  mkdir -p "$TODO_DIR/backups/safety"
  mkdir -p "$TODO_DIR/backups/incremental"
  mkdir -p "$TODO_DIR/backups/archive"
  mkdir -p "$TODO_DIR/backups/migration"
  # Create .gitkeep files to preserve directory structure in git
  touch "$TODO_DIR/backups/snapshot/.gitkeep"
  touch "$TODO_DIR/backups/safety/.gitkeep"
  touch "$TODO_DIR/backups/incremental/.gitkeep"
  touch "$TODO_DIR/backups/archive/.gitkeep"
  touch "$TODO_DIR/backups/migration/.gitkeep"
  log_info "Created $TODO_DIR/ directory with backup type subdirectories"
fi

# Copy schemas for local validation
if [[ -n "$SCHEMAS_DIR" ]]; then
  cp "$SCHEMAS_DIR/"*.json "$TODO_DIR/schemas/"
  log_info "Copied schemas to $TODO_DIR/schemas/"
else
  log_warn "Schemas not found (schema validation may fail)"
fi

# Create todo.json from template
log_info "Creating todo.json from template..."
if [[ -f "$TEMPLATES_DIR/todo.template.json" ]]; then
  cp "$TEMPLATES_DIR/todo.template.json" "$TODO_DIR/todo.json"

  # Substitute placeholders
  sed -i "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" "$TODO_DIR/todo.json"
  sed -i "s/{{TIMESTAMP}}/$TIMESTAMP/g" "$TODO_DIR/todo.json"
  sed -i "s/{{CHECKSUM}}/$CHECKSUM/g" "$TODO_DIR/todo.json"
  sed -i "s/{{VERSION}}/$VERSION/g" "$TODO_DIR/todo.json"

  # Fix schema path from relative to local
  sed -i 's|"\$schema": "../schemas/todo.schema.json"|"$schema": "./schemas/todo.schema.json"|' "$TODO_DIR/todo.json"

  log_info "Created $TODO_DIR/todo.json"
else
  log_error "Template not found: $TEMPLATES_DIR/todo.template.json"
  exit 1
fi

# Create todo-archive.json from template
log_info "Creating todo-archive.json from template..."
if [[ -f "$TEMPLATES_DIR/archive.template.json" ]]; then
  cp "$TEMPLATES_DIR/archive.template.json" "$TODO_DIR/todo-archive.json"

  # Substitute placeholders
  sed -i "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" "$TODO_DIR/todo-archive.json"
  sed -i "s/{{VERSION}}/$VERSION/g" "$TODO_DIR/todo-archive.json"

  # Fix schema path from relative to local
  sed -i 's|"\$schema": "../schemas/archive.schema.json"|"$schema": "./schemas/archive.schema.json"|' "$TODO_DIR/todo-archive.json"

  log_info "Created $TODO_DIR/todo-archive.json"
else
  log_error "Template not found: $TEMPLATES_DIR/archive.template.json"
  exit 1
fi

# Create config.json from template
log_info "Creating config.json from template..."
if [[ -f "$TEMPLATES_DIR/config.template.json" ]]; then
  cp "$TEMPLATES_DIR/config.template.json" "$TODO_DIR/config.json"

  # Substitute placeholders
  sed -i "s/{{VERSION}}/$VERSION/g" "$TODO_DIR/config.json"

  # Fix schema path from relative to local
  sed -i 's|"\$schema": "../schemas/config.schema.json"|"$schema": "./schemas/config.schema.json"|' "$TODO_DIR/config.json"

  log_info "Created $TODO_DIR/config.json"
else
  log_error "Template not found: $TEMPLATES_DIR/config.template.json"
  exit 1
fi

# Create todo-log.json from template
log_info "Creating todo-log.json from template..."
if [[ -f "$TEMPLATES_DIR/log.template.json" ]]; then
  cp "$TEMPLATES_DIR/log.template.json" "$TODO_DIR/todo-log.json"

  # Substitute placeholders
  sed -i "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" "$TODO_DIR/todo-log.json"
  sed -i "s/{{VERSION}}/$VERSION/g" "$TODO_DIR/todo-log.json"

  # Fix schema path from relative to local
  sed -i 's|"\$schema": "../schemas/log.schema.json"|"$schema": "./schemas/log.schema.json"|' "$TODO_DIR/todo-log.json"

  # Add initialization log entry
  # Generate random log ID
  LOG_ID="log_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 12)"

  # Update meta information and add entry using jq
  if command -v jq &> /dev/null; then
    jq --arg timestamp "$TIMESTAMP" \
       --arg log_id "$LOG_ID" \
       --arg project "$PROJECT_NAME" \
       '._meta.totalEntries = 1 |
        ._meta.firstEntry = $timestamp |
        ._meta.lastEntry = $timestamp |
        .entries = [{
          "id": $log_id,
          "timestamp": $timestamp,
          "sessionId": null,
          "action": "system_initialized",
          "actor": "system",
          "taskId": null,
          "before": null,
          "after": null,
          "details": ("CLEO system initialized for project: " + $project)
        }]' "$TODO_DIR/todo-log.json" > "$TODO_DIR/todo-log.json.tmp"

    mv "$TODO_DIR/todo-log.json.tmp" "$TODO_DIR/todo-log.json"
  else
    log_warn "jq not installed - log entry not added"
  fi

  log_info "Created $TODO_DIR/todo-log.json"
else
  log_error "Template not found: $TEMPLATES_DIR/log.template.json"
  exit 1
fi

# Create sessions.json from template (for Epic-Bound Session architecture)
log_info "Creating sessions.json from template..."
if [[ -f "$TEMPLATES_DIR/sessions.template.json" ]]; then
  cp "$TEMPLATES_DIR/sessions.template.json" "$TODO_DIR/sessions.json"

  # Substitute placeholders
  sed -i "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" "$TODO_DIR/sessions.json"
  sed -i "s/{{TIMESTAMP}}/$TIMESTAMP/g" "$TODO_DIR/sessions.json"

  # Fix schema path from relative to local
  sed -i 's|"\$schema": "../schemas/sessions.schema.json"|"$schema": "./schemas/sessions.schema.json"|' "$TODO_DIR/sessions.json"

  log_info "Created $TODO_DIR/sessions.json"
else
  log_warn "Template not found: $TEMPLATES_DIR/sessions.template.json (multi-session will initialize on first use)"
fi

# Recalculate checksum from actual tasks array to ensure validity
log_info "Recalculating checksum from actual tasks array..."
if command -v jq &> /dev/null && [[ -f "$TODO_DIR/todo.json" ]]; then
  ACTUAL_TASKS=$(jq -c '.tasks' "$TODO_DIR/todo.json")
  FINAL_CHECKSUM=$(echo "$ACTUAL_TASKS" | sha256sum | cut -c1-16)

  # Update checksum in the file
  jq --arg cs "$FINAL_CHECKSUM" '._meta.checksum = $cs' "$TODO_DIR/todo.json" > "$TODO_DIR/todo.json.tmp"
  mv "$TODO_DIR/todo.json.tmp" "$TODO_DIR/todo.json"
  log_info "Updated checksum to: $FINAL_CHECKSUM"
else
  log_warn "jq not installed - skipping checksum recalculation"
fi

# Validate created files
log_info "Validating created files..."
if command -v jq &> /dev/null; then
  # Validate JSON syntax for required files
  for file in "$TODO_DIR/todo.json" "$TODO_DIR/todo-archive.json" "$TODO_DIR/config.json" "$TODO_DIR/todo-log.json"; do
    if jq empty "$file" 2>/dev/null; then
      log_info "✓ Valid JSON: $(basename "$file")"
    else
      log_error "✗ Invalid JSON: $file"
      exit 1
    fi
  done
  # Validate optional sessions.json if it was created
  if [[ -f "$TODO_DIR/sessions.json" ]]; then
    if jq empty "$TODO_DIR/sessions.json" 2>/dev/null; then
      log_info "✓ Valid JSON: sessions.json"
    else
      log_error "✗ Invalid JSON: $TODO_DIR/sessions.json"
      exit 1
    fi
  fi
else
  log_warn "jq not installed - skipping JSON validation"
fi

# Update CLAUDE.md
if [[ "$NO_CLAUDE_MD" != true ]]; then
  if [[ -f "CLAUDE.md" ]]; then
    if grep -q "CLEO:START" CLAUDE.md 2>/dev/null; then
      log_warn "CLAUDE.md already has task integration (skipped)"
    else
      # Inject CLI-based task management instructions from template
      # PREPEND to top of file (injection should be first thing in CLAUDE.md)
      local injection_template="$CLEO_HOME/templates/AGENT-INJECTION.md"
      if [[ -f "$injection_template" ]]; then
        local temp_file
        temp_file=$(mktemp)
        cat "$injection_template" > "$temp_file"
        echo "" >> "$temp_file"
        cat CLAUDE.md >> "$temp_file"
        mv "$temp_file" CLAUDE.md
        log_info "Updated CLAUDE.md (from template, prepended)"
      else
        # Fallback minimal injection if template missing
        local temp_file
        temp_file=$(mktemp)
        cat > "$temp_file" << 'CLAUDE_EOF'
<!-- CLEO:START -->
## Task Management (cleo)

Use `ct` (alias for `cleo`) for all task operations. Full docs: `~/.cleo/docs/TODO_Task_Management.md`

### Essential Commands
```bash
ct list                    # View tasks
ct add "Task"              # Create task
ct done <id>               # Complete task
ct focus set <id>          # Set active task
ct session start|end       # Session lifecycle
ct exists <id>             # Verify task exists
```

### Anti-Hallucination
- **CLI only** - Never edit `.cleo/*.json` directly
- **Verify state** - Use `ct list` before assuming
<!-- CLEO:END -->

CLAUDE_EOF
        cat CLAUDE.md >> "$temp_file"
        mv "$temp_file" CLAUDE.md
        log_info "Updated CLAUDE.md (fallback, prepended)"
      fi
    fi
  else
    log_warn "No CLAUDE.md found (skipped)"
  fi
fi

# Check/setup Claude Code statusline integration for context monitoring
if [[ -f "$LIB_DIR/statusline-setup.sh" ]] || [[ -f "$CLEO_HOME/lib/statusline-setup.sh" ]]; then
    if [[ -f "$LIB_DIR/statusline-setup.sh" ]]; then
        source "$LIB_DIR/statusline-setup.sh"
    else
        source "$CLEO_HOME/lib/statusline-setup.sh"
    fi

    echo ""
    log_info "Checking Claude Code statusline integration..."
    install_statusline_integration "install" "true"
fi

# Build list of created files
CREATED_FILES=(
  "todo.json"
  "todo-archive.json"
  "config.json"
  "todo-log.json"
)
# Only include sessions.json if it was actually created
[[ -f "$TODO_DIR/sessions.json" ]] && CREATED_FILES+=("sessions.json")

if [[ "$FORMAT" == "json" ]]; then
  # JSON output
  jq -nc \
    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --arg projectName "$PROJECT_NAME" \
    --arg directory "$TODO_DIR" \
    --arg version "$VERSION" \
    --argjson files "$(printf '%s\n' "${CREATED_FILES[@]}" | jq -R . | jq -s .)" \
    '{
      "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
      "_meta": {
        "command": "init",
        "timestamp": $timestamp,
        "format": "json",
        "version": $version
      },
      "success": true,
      "initialized": {
        "projectName": $projectName,
        "directory": $directory,
        "version": $version,
        "files": $files,
        "schemas": true,
        "backups": true
      }
    }'
else
  # Text output
  echo ""
  log_success "CLEO initialized successfully!"
  echo ""
  echo "Files created in .cleo/:"
  echo "  - .cleo/todo.json         (active tasks)"
  echo "  - .cleo/todo-archive.json (completed tasks)"
  echo "  - .cleo/config.json       (settings)"
  echo "  - .cleo/todo-log.json     (change history)"
  echo "  - .cleo/sessions.json     (multi-session management)"
  echo "  - .cleo/schemas/          (JSON schemas for validation)"
  echo "  - .cleo/backups/          (automatic backups)"
  echo "    ├── snapshot/             (point-in-time snapshots)"
  echo "    ├── safety/               (pre-operation backups)"
  echo "    ├── incremental/          (file version history)"
  echo "    ├── archive/              (long-term archives)"
  echo "    └── migration/            (schema migration backups)"
  echo ""
  echo "Add to .gitignore (recommended):"
  echo "  .cleo/*.json"
  echo "  .cleo/backups/"
  echo ""
  echo "Next steps:"
  echo "  1. cleo add \"Your first task\""
  echo "  2. cleo focus set <task-id>"
  echo "  3. cleo session start"
fi
