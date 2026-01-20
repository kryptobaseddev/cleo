#!/usr/bin/env bash
# =============================================================================
# epic-architect-install.sh - Install epic-architect skill
# =============================================================================
# Installs the epic-architect skill to either:
# - Global: ~/.claude/skills/epic-architect/ (--global)
# - Project: .claude/skills/epic-architect/ (default)
#
# Usage:
#   cleo epic-architect install [--global] [--force]
#   ./scripts/epic-architect-install.sh [--global] [--force]
# =============================================================================

set -euo pipefail

# Source library functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/output.sh" 2>/dev/null || true

# =============================================================================
# Configuration
# =============================================================================

SKILL_NAME="epic-architect"
SOURCE_DIR="${SCRIPT_DIR}/../skills/${SKILL_NAME}"

# Default to project-local installation
GLOBAL_INSTALL=false
FORCE=false

# =============================================================================
# Functions
# =============================================================================

show_help() {
    cat << 'EOF'
epic-architect-install - Install the epic-architect skill

USAGE:
    cleo epic-architect install [OPTIONS]
    ./scripts/epic-architect-install.sh [OPTIONS]

OPTIONS:
    --global    Install to ~/.claude/skills/ (global for all projects)
    --force     Overwrite existing installation
    --help      Show this help message

EXAMPLES:
    # Install to current project
    cleo epic-architect install

    # Install globally for all projects
    cleo epic-architect install --global

    # Force reinstall
    cleo epic-architect install --global --force

LOCATIONS:
    Global:  ~/.claude/skills/epic-architect/
    Project: .claude/skills/epic-architect/

NOTES:
    - Global installation requires ~/.claude/ directory
    - Project installation creates .claude/skills/ if needed
    - Installation creates symlinks to CLEO repo (not copies)
    - Updates are automatic when CLEO is updated
EOF
}

log_info() {
    echo "INFO: $*"
}

log_error() {
    echo "ERROR: $*" >&2
}

log_success() {
    echo "SUCCESS: $*"
}

validate_source() {
    if [[ ! -d "$SOURCE_DIR" ]]; then
        log_error "Source directory not found: $SOURCE_DIR"
        exit 1
    fi

    if [[ ! -f "$SOURCE_DIR/SKILL.md" ]]; then
        log_error "SKILL.md not found in source directory"
        exit 1
    fi
}

get_target_dir() {
    if [[ "$GLOBAL_INSTALL" == "true" ]]; then
        echo "${HOME}/.claude/skills/${SKILL_NAME}"
    else
        echo ".claude/skills/${SKILL_NAME}"
    fi
}

ensure_parent_dir() {
    local target_dir="$1"
    local parent_dir
    parent_dir="$(dirname "$target_dir")"

    if [[ ! -d "$parent_dir" ]]; then
        log_info "Creating directory: $parent_dir"
        mkdir -p "$parent_dir"
    fi
}

check_existing() {
    local target_dir="$1"

    if [[ -e "$target_dir" ]]; then
        if [[ "$FORCE" == "true" ]]; then
            log_info "Removing existing installation: $target_dir"
            rm -rf "$target_dir"
        else
            log_error "Skill already installed at: $target_dir"
            log_error "Use --force to overwrite"
            exit 1
        fi
    fi
}

create_symlink() {
    local source="$1"
    local target="$2"

    # Resolve absolute path for source
    local abs_source
    abs_source="$(cd "$source" && pwd)"

    log_info "Creating symlink: $target -> $abs_source"
    ln -s "$abs_source" "$target"
}

validate_installation() {
    local target_dir="$1"

    if [[ ! -L "$target_dir" ]]; then
        log_error "Installation failed: symlink not created"
        exit 1
    fi

    if [[ ! -f "$target_dir/SKILL.md" ]]; then
        log_error "Installation failed: SKILL.md not accessible"
        exit 1
    fi

    # Validate SKILL.md has required frontmatter
    if ! grep -q "^name: ${SKILL_NAME}$" "$target_dir/SKILL.md"; then
        log_error "Installation validation failed: name field mismatch"
        exit 1
    fi
}

output_json() {
    local target_dir="$1"
    local install_type="$2"

    cat << EOF
{
  "success": true,
  "skill": "${SKILL_NAME}",
  "installType": "${install_type}",
  "location": "${target_dir}",
  "version": "$(grep '^version:' "$target_dir/SKILL.md" | awk '{print $2}')",
  "message": "Skill installed successfully"
}
EOF
}

# =============================================================================
# Main
# =============================================================================

main() {
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --global)
                GLOBAL_INSTALL=true
                shift
                ;;
            --force)
                FORCE=true
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done

    # Validate source exists
    validate_source

    # Determine target directory
    local target_dir
    target_dir="$(get_target_dir)"

    local install_type
    if [[ "$GLOBAL_INSTALL" == "true" ]]; then
        install_type="global"
    else
        install_type="project"
    fi

    # Check for existing installation
    check_existing "$target_dir"

    # Create parent directory if needed
    ensure_parent_dir "$target_dir"

    # Create symlink
    create_symlink "$SOURCE_DIR" "$target_dir"

    # Validate installation
    validate_installation "$target_dir"

    # Output success
    if [[ -t 1 ]]; then
        # Human-readable output for TTY
        log_success "Skill '${SKILL_NAME}' installed to: $target_dir"
        echo ""
        echo "The skill is now available. Trigger phrases:"
        echo "  - 'create epic'"
        echo "  - 'plan epic'"
        echo "  - 'decompose into tasks'"
        echo "  - 'architect the work'"
        echo "  - 'break down this project'"
        echo ""
        echo "To use: Ask Claude to create an epic and the skill will activate automatically."
    else
        # JSON output for piped/scripted usage
        output_json "$target_dir" "$install_type"
    fi
}

main "$@"
