#!/usr/bin/env bash
#
# install-claude-todo.sh - Install the CLAUDE-TODO system globally
#
# Usage: curl -sSL <url> | bash
#    or: ./install-claude-todo.sh
#
# This script creates ~/.claude-todo with all necessary templates and scripts

set -euo pipefail

VERSION="2.0.0"
INSTALL_DIR="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"

# Colors
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' BOLD='' NC=''
fi

log_info()    { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
log_error()   { echo -e "${RED}✗${NC} $1" >&2; }

# ============================================================================
# File Contents (Embedded)
# ============================================================================

# Using heredocs to embed all file contents directly in the installer
# This makes the script self-contained with no external dependencies

create_todo_schema() {
    cat << 'SCHEMA_EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "claude-todo-schema-v2",
  "title": "CLAUDE-TODO Schema",
  "description": "LLM-optimized task tracking schema",
  "type": "object",
  "required": ["version", "project", "lastUpdated", "tasks"],
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$"
    },
    "project": {
      "type": "string",
      "minLength": 1
    },
    "lastUpdated": {
      "type": "string",
      "format": "date"
    },
    "focus": {
      "type": "object",
      "properties": {
        "currentTask": { "type": ["string", "null"], "pattern": "^T\\d{3,}$" },
        "blockedUntil": { "type": ["string", "null"] },
        "sessionNote": { "type": ["string", "null"] },
        "nextAction": { "type": ["string", "null"] }
      }
    },
    "tasks": {
      "type": "array",
      "items": { "$ref": "#/definitions/task" }
    },
    "phases": {
      "type": "object",
      "patternProperties": {
        "^[a-z][a-z0-9-]*$": {
          "type": "object",
          "required": ["order", "name"],
          "properties": {
            "order": { "type": "integer", "minimum": 1 },
            "name": { "type": "string" }
          }
        }
      }
    },
    "labels": {
      "type": "object",
      "patternProperties": {
        "^[a-z][a-z0-9-]*$": {
          "type": "array",
          "items": { "type": "string", "pattern": "^T\\d{3,}$" }
        }
      }
    },
    "archived": {
      "type": "object",
      "properties": {
        "count": { "type": "integer", "minimum": 0 },
        "lastArchived": { "type": ["string", "null"], "format": "date" }
      }
    }
  },
  "definitions": {
    "task": {
      "type": "object",
      "required": ["id", "title", "status", "priority"],
      "properties": {
        "id": { "type": "string", "pattern": "^T\\d{3,}$" },
        "title": { "type": "string", "minLength": 1, "maxLength": 120 },
        "status": { "type": "string", "enum": ["pending", "active", "blocked", "done"] },
        "priority": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
        "phase": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
        "description": { "type": "string" },
        "files": { "type": "array", "items": { "type": "string" } },
        "acceptance": { "type": "array", "items": { "type": "string" } },
        "depends": { "type": "array", "items": { "type": "string", "pattern": "^T\\d{3,}$" } },
        "blockedBy": { "type": "string" },
        "notes": { "type": "array", "items": { "type": "string" } },
        "labels": { "type": "array", "items": { "type": "string" } },
        "createdAt": { "type": "string", "format": "date" },
        "completedAt": { "type": "string", "format": "date" }
      }
    }
  }
}
SCHEMA_EOF
}

create_todo_template() {
    cat << 'TEMPLATE_EOF'
{
  "$schema": "~/.claude-todo/core/todo-schema.json",
  "version": "2.0.0",
  "project": "{{PROJECT_NAME}}",
  "lastUpdated": "{{DATE}}",

  "focus": {
    "currentTask": null,
    "blockedUntil": null,
    "sessionNote": null,
    "nextAction": null
  },

  "tasks": [],

  "phases": {
    "setup": { "order": 1, "name": "Setup & Foundation" },
    "core": { "order": 2, "name": "Core Features" },
    "polish": { "order": 3, "name": "Polish & Launch" }
  },

  "labels": {
    "feature": [],
    "bug": [],
    "security": [],
    "urgent": []
  },

  "archived": {
    "count": 0,
    "lastArchived": null
  }
}
TEMPLATE_EOF
}

create_claude_todo_md() {
    cat << 'CLAUDEMD_EOF'
## Task Management

Project tasks are tracked in `todo.json`. Read this file at session start.

### Session Protocol

**Starting:**
1. Read `todo.json`
2. Check `focus.currentTask` - if set, resume that task
3. If null, find highest priority actionable pending task
4. Set task `status: "active"` and `focus.currentTask`

**During work:**
- Add context to `notes` array
- Update `files` array as you modify files
- If blocked: set `status: "blocked"` and `blockedBy`

**Ending:**
- Update `focus.sessionNote` with progress
- Set `focus.nextAction` with next step
- If complete: `status: "done"`, `completedAt: "YYYY-MM-DD"`

### Status Values
- `pending` - Ready (all dependencies done)
- `active` - Currently working (only ONE at a time)
- `blocked` - Cannot proceed (blockedBy required)
- `done` - Completed (completedAt required)

### Rules
- **IMPORTANT**: Only ONE task `active` at a time
- Check `depends` before starting pending tasks
- Never delete notes, only append
- Archive completed tasks periodically
CLAUDEMD_EOF
}

create_task_status_command() {
    cat << 'COMMAND_EOF'
Read todo.json and provide a status report:

1. **Current Focus**
   - Active task (if any) with session note
   - Next action hint

2. **Summary**
   - Count by status: pending, active, blocked, done
   - Any critical/high priority items

3. **Recommendations**
   - Next actionable task if none active
   - Any blockers needing attention

4. **Recent Activity**
   - Last 3 completed tasks (if any)

Keep response concise. Use the task IDs (T001, etc.) when referencing tasks.
COMMAND_EOF
}

create_init_script() {
    cat << 'INIT_EOF'
#!/usr/bin/env bash
set -euo pipefail

CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"
VERSION="2.0.0"

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' BLUE='\033[0;34m' NC='\033[0m'
[[ ! -t 1 ]] && RED='' && GREEN='' && YELLOW='' && BLUE='' && NC=''

log_info()    { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
log_error()   { echo -e "${RED}✗${NC} $1" >&2; }

usage() {
    cat << EOF
Usage: claude-todo-init [project-name] [options]

Initialize CLAUDE-TODO in the current directory.

Options:
  -f, --force         Overwrite existing todo.json
  -n, --no-claude-md  Don't modify CLAUDE.md
  -d, --dry-run       Preview without changes
  -h, --help          Show help

EOF
}

main() {
    local project_name="" force="false" no_claude_md="false" dry_run="false"
    
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help) usage; exit 0 ;;
            -f|--force) force="true"; shift ;;
            -n|--no-claude-md) no_claude_md="true"; shift ;;
            -d|--dry-run) dry_run="true"; shift ;;
            -*) log_error "Unknown: $1"; exit 1 ;;
            *) project_name="$1"; shift ;;
        esac
    done
    
    [[ -z "$project_name" ]] && project_name="$(basename "$PWD")"
    project_name=$(echo "$project_name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')
    
    [[ ! -d "$CLAUDE_TODO_HOME" ]] && log_error "System not installed" && exit 1
    [[ "$PWD" == "$HOME" ]] && log_error "Cannot init in home dir" && exit 1
    [[ -f "todo.json" && "$force" != "true" ]] && log_error "todo.json exists. Use --force" && exit 1
    
    local today=$(date +%Y-%m-%d)
    
    log_info "Initializing: $project_name"
    
    if [[ "$dry_run" != "true" ]]; then
        sed -e "s/{{PROJECT_NAME}}/$project_name/g" -e "s/{{DATE}}/$today/g" \
            "$CLAUDE_TODO_HOME/templates/todo.template.json" > todo.json
        log_success "Created todo.json"
        
        if [[ "$no_claude_md" != "true" ]]; then
            local marker="<!-- CLAUDE-TODO:START -->"
            if [[ -f "CLAUDE.md" ]] && grep -q "$marker" CLAUDE.md 2>/dev/null; then
                log_info "CLAUDE.md already has TODO integration"
            else
                echo -e "\n$marker\n$(cat "$CLAUDE_TODO_HOME/templates/CLAUDE.todo.md")\n<!-- CLAUDE-TODO:END -->" >> CLAUDE.md
                log_success "Updated CLAUDE.md"
            fi
        fi
        
        echo "$VERSION" > .claude-todo-version
        log_success "Created .claude-todo-version"
        
        echo -e "\n${GREEN}Done!${NC} Add tasks to todo.json and start Claude Code.\n"
    else
        log_info "[DRY RUN] Would create todo.json, update CLAUDE.md"
    fi
}

main "$@"
INIT_EOF
}

# ============================================================================
# Installation
# ============================================================================

main() {
    echo ""
    echo -e "${BOLD}CLAUDE-TODO System Installer v${VERSION}${NC}"
    echo "═══════════════════════════════════════════════════"
    echo ""

    # Check for existing installation
    if [[ -d "$INSTALL_DIR" ]]; then
        log_warn "Existing installation found at $INSTALL_DIR"
        read -p "Overwrite? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Installation cancelled"
            exit 0
        fi
        rm -rf "$INSTALL_DIR"
    fi

    log_info "Installing to $INSTALL_DIR"
    echo ""

    # Create directory structure
    mkdir -p "$INSTALL_DIR"/{core,templates/commands,bin}

    # Create core files
    create_todo_schema > "$INSTALL_DIR/core/todo-schema.json"
    log_success "Created core/todo-schema.json"

    echo "$VERSION" > "$INSTALL_DIR/core/VERSION"
    log_success "Created core/VERSION"

    # Create templates
    create_todo_template > "$INSTALL_DIR/templates/todo.template.json"
    log_success "Created templates/todo.template.json"

    create_claude_todo_md > "$INSTALL_DIR/templates/CLAUDE.todo.md"
    log_success "Created templates/CLAUDE.todo.md"

    create_task_status_command > "$INSTALL_DIR/templates/commands/task-status.md"
    log_success "Created templates/commands/task-status.md"

    # Create init script
    create_init_script > "$INSTALL_DIR/bin/claude-todo-init"
    chmod +x "$INSTALL_DIR/bin/claude-todo-init"
    log_success "Created bin/claude-todo-init"

    # Add to PATH instructions
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Installation complete!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Add to your PATH (add to ~/.bashrc or ~/.zshrc):"
    echo ""
    echo -e "    ${BOLD}export PATH=\"\$HOME/.claude-todo/bin:\$PATH\"${NC}"
    echo ""
    echo "  Then initialize any project:"
    echo ""
    echo "    cd your-project"
    echo "    claude-todo-init"
    echo ""
    echo "  Or run directly:"
    echo ""
    echo "    ~/.claude-todo/bin/claude-todo-init"
    echo ""
}

main "$@"
