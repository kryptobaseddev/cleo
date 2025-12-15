#!/usr/bin/env bash
# CLAUDE-TODO Init Script
# Initialize the todo system in a project directory
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"

# Source version from central location
if [[ -f "$CLAUDE_TODO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLAUDE_TODO_HOME/VERSION" | tr -d '[:space:]')"
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
    if [[ -f "$CLAUDE_TODO_HOME/lib/logging.sh" ]]; then
        source "$CLAUDE_TODO_HOME/lib/logging.sh"
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
    [[ -f "$CLAUDE_TODO_HOME/lib/file-ops.sh" ]] && source "$CLAUDE_TODO_HOME/lib/file-ops.sh" && _INIT_FILE_OPS_SOURCED=true || true
fi
if [[ -z "${_INIT_VALIDATION_SOURCED:-}" ]]; then
    [[ -f "$CLAUDE_TODO_HOME/lib/validation.sh" ]] && source "$CLAUDE_TODO_HOME/lib/validation.sh" && _INIT_VALIDATION_SOURCED=true || true
fi
if [[ -z "${_INIT_BACKUP_SOURCED:-}" ]]; then
    [[ -f "$CLAUDE_TODO_HOME/lib/backup.sh" ]] && source "$CLAUDE_TODO_HOME/lib/backup.sh" && _INIT_BACKUP_SOURCED=true || true
fi

# Defaults
FORCE=false
NO_CLAUDE_MD=false
PROJECT_NAME=""

usage() {
  cat << EOF
Usage: claude-todo init [PROJECT_NAME] [OPTIONS]

Initialize CLAUDE-TODO in the current directory.

Options:
  --force         Overwrite existing files
  --no-claude-md  Skip CLAUDE.md integration
  -h, --help      Show this help

Creates:
  .claude/todo.json         Active tasks
  .claude/todo-archive.json Completed tasks
  .claude/todo-config.json  Configuration
  .claude/todo-log.json     Change history
  .claude/schemas/          JSON Schema files
  .claude/.backups/         Backup directory
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
    --no-claude-md) NO_CLAUDE_MD=true; shift ;;
    -h|--help) usage ;;
    -*) log_error "Unknown option: $1"; exit 1 ;;
    *) PROJECT_NAME="$1"; shift ;;
  esac
done

# Determine project name
[[ -z "$PROJECT_NAME" ]] && PROJECT_NAME=$(basename "$PWD")
PROJECT_NAME=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')

# Check for existing files
if [[ -f ".claude/todo.json" ]] && [[ "$FORCE" != true ]]; then
  log_warn "Project already initialized at .claude/todo.json"
  log_warn "Use --force to reinitialize (will preserve existing tasks but reset config)"
  exit 1
fi

TIMESTAMP=$(generate_timestamp)
CHECKSUM=$(calculate_checksum)
TODO_DIR=".claude"

# Determine templates and schemas directories (installed or source)
if [[ -d "$CLAUDE_TODO_HOME/templates" ]]; then
  TEMPLATES_DIR="$CLAUDE_TODO_HOME/templates"
elif [[ -d "$SCRIPT_DIR/../templates" ]]; then
  TEMPLATES_DIR="$SCRIPT_DIR/../templates"
else
  log_error "Templates directory not found at $CLAUDE_TODO_HOME/templates/ or $SCRIPT_DIR/../templates/"
  log_error "Run install.sh to set up CLAUDE-TODO globally, or run from source directory."
  exit 1
fi

if [[ -d "$CLAUDE_TODO_HOME/schemas" ]]; then
  SCHEMAS_DIR="$CLAUDE_TODO_HOME/schemas"
elif [[ -d "$SCRIPT_DIR/../schemas" ]]; then
  SCHEMAS_DIR="$SCRIPT_DIR/../schemas"
else
  SCHEMAS_DIR=""
fi

log_info "Initializing CLAUDE-TODO for project: $PROJECT_NAME"

# Create .claude directory structure
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

# Create todo-config.json from template
log_info "Creating todo-config.json from template..."
if [[ -f "$TEMPLATES_DIR/config.template.json" ]]; then
  cp "$TEMPLATES_DIR/config.template.json" "$TODO_DIR/todo-config.json"

  # Substitute placeholders
  sed -i "s/{{VERSION}}/$VERSION/g" "$TODO_DIR/todo-config.json"

  # Fix schema path from relative to local
  sed -i 's|"\$schema": "../schemas/config.schema.json"|"$schema": "./schemas/config.schema.json"|' "$TODO_DIR/todo-config.json"

  log_info "Created $TODO_DIR/todo-config.json"
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
          "details": ("CLAUDE-TODO system initialized for project: " + $project)
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
  # Validate JSON syntax
  for file in "$TODO_DIR/todo.json" "$TODO_DIR/todo-archive.json" "$TODO_DIR/todo-config.json" "$TODO_DIR/todo-log.json"; do
    if jq empty "$file" 2>/dev/null; then
      log_info "✓ Valid JSON: $(basename "$file")"
    else
      log_error "✗ Invalid JSON: $file"
      exit 1
    fi
  done
else
  log_warn "jq not installed - skipping JSON validation"
fi

# Update CLAUDE.md
if [[ "$NO_CLAUDE_MD" != true ]]; then
  if [[ -f "CLAUDE.md" ]]; then
    if grep -q "CLAUDE-TODO:START" CLAUDE.md 2>/dev/null; then
      log_warn "CLAUDE.md already has task integration (skipped)"
    else
      # Inject CLI-based task management instructions from template
      local injection_template="$CLAUDE_TODO_HOME/templates/CLAUDE-INJECTION.md"
      if [[ -f "$injection_template" ]]; then
        echo "" >> CLAUDE.md
        cat "$injection_template" >> CLAUDE.md
        log_info "Updated CLAUDE.md (from template)"
      else
        # Fallback minimal injection if template missing
        cat >> CLAUDE.md << 'CLAUDE_EOF'

<!-- CLAUDE-TODO:START -->
## Task Management (claude-todo)

Use `ct` (alias for `claude-todo`) for all task operations. Full docs: `~/.claude-todo/docs/TODO_Task_Management.md`

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
- **CLI only** - Never edit `.claude/*.json` directly
- **Verify state** - Use `ct list` before assuming
<!-- CLAUDE-TODO:END -->
CLAUDE_EOF
        log_info "Updated CLAUDE.md (fallback)"
      fi
    fi
  else
    log_warn "No CLAUDE.md found (skipped)"
  fi
fi

echo ""
log_success "CLAUDE-TODO initialized successfully!"
echo ""
echo "Files created in .claude/:"
echo "  - .claude/todo.json         (active tasks)"
echo "  - .claude/todo-archive.json (completed tasks)"
echo "  - .claude/todo-config.json  (settings)"
echo "  - .claude/todo-log.json     (change history)"
echo "  - .claude/schemas/          (JSON schemas for validation)"
echo "  - .claude/backups/          (automatic backups)"
echo "    ├── snapshot/             (point-in-time snapshots)"
echo "    ├── safety/               (pre-operation backups)"
echo "    ├── incremental/          (file version history)"
echo "    ├── archive/              (long-term archives)"
echo "    └── migration/            (schema migration backups)"
echo ""
echo "Add to .gitignore (recommended):"
echo "  .claude/*.json"
echo "  .claude/backups/"
echo ""
echo "Next steps:"
echo "  1. claude-todo add \"Your first task\""
echo "  2. claude-todo focus set <task-id>"
echo "  3. claude-todo session start"
