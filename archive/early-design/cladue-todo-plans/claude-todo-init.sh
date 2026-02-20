#!/usr/bin/env bash
#
# claude-todo-init - Initialize CLAUDE-TODO system in a project
#
# Usage: claude-todo-init [project-name] [options]
#
# This script copies TODO system templates to the current directory
# and optionally appends task management instructions to CLAUDE.md

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"
VERSION="2.0.0"
SCRIPT_NAME="$(basename "$0")"

# Colors (disabled if not a terminal)
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m' # No Color
else
    RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

# ============================================================================
# Helper Functions
# ============================================================================

log_info()    { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
log_error()   { echo -e "${RED}✗${NC} $1" >&2; }

usage() {
    cat << EOF
Usage: $SCRIPT_NAME [project-name] [options]

Initialize CLAUDE-TODO task management system in the current directory.

Arguments:
  project-name    Name for the project (default: current directory name)

Options:
  -f, --force         Overwrite existing todo.json
  -n, --no-claude-md  Don't modify CLAUDE.md
  -d, --dry-run       Show what would be done without doing it
  -h, --help          Show this help message
  -v, --version       Show version

Examples:
  $SCRIPT_NAME                    # Use directory name as project
  $SCRIPT_NAME my-app             # Name project "my-app"
  $SCRIPT_NAME --dry-run          # Preview changes
  $SCRIPT_NAME -f                 # Reinitialize (overwrite todo.json)

Files created:
  todo.json              - Task tracking file
  .claude-todo-version   - Version marker

Files modified (unless --no-claude-md):
  CLAUDE.md              - Task management instructions appended

EOF
}

# ============================================================================
# Validation Functions
# ============================================================================

check_system_installed() {
    if [[ ! -d "$CLAUDE_TODO_HOME" ]]; then
        log_error "CLAUDE-TODO system not found at $CLAUDE_TODO_HOME"
        log_info "Run the system installer first, or set CLAUDE_TODO_HOME"
        exit 1
    fi

    if [[ ! -f "$CLAUDE_TODO_HOME/core/todo-schema.json" ]]; then
        log_error "Invalid CLAUDE-TODO installation: missing core/todo-schema.json"
        exit 1
    fi

    if [[ ! -f "$CLAUDE_TODO_HOME/templates/todo.template.json" ]]; then
        log_error "Invalid CLAUDE-TODO installation: missing templates/todo.template.json"
        exit 1
    fi
}

check_project_directory() {
    # Warn if initializing in home directory
    if [[ "$PWD" == "$HOME" ]]; then
        log_error "Cannot initialize in home directory"
        exit 1
    fi

    # Warn if no obvious project markers
    if [[ ! -f "package.json" && ! -f "Cargo.toml" && ! -f "pyproject.toml" && \
          ! -f "go.mod" && ! -f "Makefile" && ! -d ".git" ]]; then
        log_warn "No common project files detected. Are you in a project directory?"
    fi
}

# ============================================================================
# Main Functions
# ============================================================================

get_today() {
    date +%Y-%m-%d
}

create_todo_json() {
    local project_name="$1"
    local dry_run="$2"
    local today
    today=$(get_today)

    local template="$CLAUDE_TODO_HOME/templates/todo.template.json"
    local output="todo.json"

    if [[ "$dry_run" == "true" ]]; then
        log_info "[DRY RUN] Would create $output from template"
        log_info "[DRY RUN] Project name: $project_name"
        log_info "[DRY RUN] Date: $today"
        return 0
    fi

    # Read template and replace placeholders
    sed -e "s/{{PROJECT_NAME}}/$project_name/g" \
        -e "s/{{DATE}}/$today/g" \
        "$template" > "$output"

    log_success "Created $output"
}

update_claude_md() {
    local dry_run="$1"
    local claude_md="CLAUDE.md"
    local snippet="$CLAUDE_TODO_HOME/templates/CLAUDE.todo.md"
    local marker_start="<!-- CLAUDE-TODO:START -->"
    local marker_end="<!-- CLAUDE-TODO:END -->"

    # Check if already initialized
    if [[ -f "$claude_md" ]] && grep -q "$marker_start" "$claude_md" 2>/dev/null; then
        log_info "CLAUDE.md already contains TODO integration (skipping)"
        return 0
    fi

    if [[ "$dry_run" == "true" ]]; then
        if [[ -f "$claude_md" ]]; then
            log_info "[DRY RUN] Would append TODO integration to existing $claude_md"
        else
            log_info "[DRY RUN] Would create $claude_md with TODO integration"
        fi
        return 0
    fi

    # Build content to append
    local content
    content=$(cat << EOF

$marker_start
$(cat "$snippet")
$marker_end
EOF
)

    if [[ -f "$claude_md" ]]; then
        # Append to existing
        echo "$content" >> "$claude_md"
        log_success "Appended TODO integration to $claude_md"
    else
        # Create new file
        echo "$content" > "$claude_md"
        log_success "Created $claude_md with TODO integration"
    fi
}

create_version_marker() {
    local dry_run="$1"
    local marker=".claude-todo-version"

    if [[ "$dry_run" == "true" ]]; then
        log_info "[DRY RUN] Would create $marker with version $VERSION"
        return 0
    fi

    echo "$VERSION" > "$marker"
    log_success "Created $marker"
}

print_success_message() {
    local project_name="$1"

    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  CLAUDE-TODO initialized successfully!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Project: $project_name"
    echo ""
    echo "  Quick start:"
    echo "    1. Open todo.json and add your first task"
    echo "    2. Start Claude Code in this directory"
    echo "    3. Ask: \"What tasks are pending?\""
    echo ""
    echo "  Task structure:"
    echo "    {\"id\": \"T001\", \"title\": \"...\", \"status\": \"pending\", \"priority\": \"high\"}"
    echo ""
    echo "  Status values: pending → active → done (or blocked)"
    echo ""
}

# ============================================================================
# Main Entry Point
# ============================================================================

main() {
    local project_name=""
    local force="false"
    local no_claude_md="false"
    local dry_run="false"

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help)
                usage
                exit 0
                ;;
            -v|--version)
                echo "claude-todo-init version $VERSION"
                exit 0
                ;;
            -f|--force)
                force="true"
                shift
                ;;
            -n|--no-claude-md)
                no_claude_md="true"
                shift
                ;;
            -d|--dry-run)
                dry_run="true"
                shift
                ;;
            -*)
                log_error "Unknown option: $1"
                usage
                exit 1
                ;;
            *)
                if [[ -z "$project_name" ]]; then
                    project_name="$1"
                else
                    log_error "Unexpected argument: $1"
                    usage
                    exit 1
                fi
                shift
                ;;
        esac
    done

    # Default project name to directory name
    if [[ -z "$project_name" ]]; then
        project_name="$(basename "$PWD")"
    fi

    # Sanitize project name (remove special chars, keep alphanumeric and hyphens)
    project_name=$(echo "$project_name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//')

    if [[ -z "$project_name" ]]; then
        log_error "Could not determine project name"
        exit 1
    fi

    # Validation
    check_system_installed
    check_project_directory

    # Check for existing todo.json
    if [[ -f "todo.json" && "$force" != "true" ]]; then
        log_error "todo.json already exists. Use --force to overwrite."
        exit 1
    fi

    if [[ -f "todo.json" && "$force" == "true" ]]; then
        log_warn "Overwriting existing todo.json"
    fi

    # Check for existing version marker
    if [[ -f ".claude-todo-version" && "$force" != "true" ]]; then
        local existing_version
        existing_version=$(cat .claude-todo-version)
        log_warn "Project was previously initialized with version $existing_version"
    fi

    echo ""
    log_info "Initializing CLAUDE-TODO for: $project_name"
    echo ""

    # Execute
    create_todo_json "$project_name" "$dry_run"

    if [[ "$no_claude_md" != "true" ]]; then
        update_claude_md "$dry_run"
    fi

    create_version_marker "$dry_run"

    # Success message
    if [[ "$dry_run" != "true" ]]; then
        print_success_message "$project_name"
    else
        echo ""
        log_info "[DRY RUN] No files were modified"
    fi
}

main "$@"
