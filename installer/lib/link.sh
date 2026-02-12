#!/usr/bin/env bash
# CLEO Installer - Symlink Management
# Creates, verifies, and manages symlinks for CLI access
#
# Version: 1.0.0
# Task: T1860
# Based on: claudedocs/research-outputs/2026-01-20_modular-installer-architecture.md
#
# LAYER: 2 (Operations)
# DEPENDENCIES: core.sh
# PROVIDES: installer_link_create, installer_link_remove, installer_link_verify,
#           installer_link_setup_bin

# ============================================
# GUARD: Prevent double-sourcing
# ============================================
[[ -n "${_INSTALLER_LINK_LOADED:-}" ]] && return 0
readonly _INSTALLER_LINK_LOADED=1

# ============================================
# DEPENDENCIES
# ============================================
INSTALLER_LIB_DIR="${INSTALLER_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "${INSTALLER_LIB_DIR}/core.sh"

# Source agent config registry functions
CLEO_LIB_DIR="$(dirname "$(dirname "$INSTALLER_LIB_DIR")")/lib"
if [[ -f "$CLEO_LIB_DIR/skills/agent-config.sh" ]]; then
    source "$CLEO_LIB_DIR/skills/agent-config.sh"
elif [[ -f "$CLEO_LIB_DIR/agent-config.sh" ]]; then
    # Legacy flat path fallback
    source "$CLEO_LIB_DIR/agent-config.sh"
fi

# ============================================
# CONSTANTS
# ============================================
readonly LINK_BIN_DIR="${CLEO_BIN_DIR:-$HOME/.local/bin}"
readonly LINK_CLI_NAME="cleo"
readonly LINK_ALIAS_NAME="ct"

# Backup suffix for replaced links
readonly LINK_BACKUP_SUFFIX=".cleo-backup"

# ============================================
# LINK CREATION
# ============================================

# Create a symlink with backup of existing target
# Args: source target
# Returns: 0 on success, 1 on failure
installer_link_create() {
    local source="$1"
    local target="$2"

    # Verify source exists
    if [[ ! -e "$source" ]]; then
        installer_log_error "Link source does not exist: $source"
        return 1
    fi

    # Create target directory if needed
    local target_dir
    target_dir=$(dirname "$target")
    if [[ ! -d "$target_dir" ]]; then
        installer_log_debug "Creating directory: $target_dir"
        mkdir -p "$target_dir" || {
            installer_log_error "Failed to create directory: $target_dir"
            return $EXIT_PERMISSION_DENIED
        }
    fi

    # Handle existing target
    if [[ -e "$target" || -L "$target" ]]; then
        # Check if it's already correct
        if [[ -L "$target" ]]; then
            local existing_target
            existing_target=$(readlink "$target")
            if [[ "$existing_target" == "$source" ]]; then
                installer_log_debug "Link already correct: $target -> $source"
                return 0
            fi
        fi

        # Backup existing
        local backup="${target}${LINK_BACKUP_SUFFIX}"
        installer_log_debug "Backing up existing: $target -> $backup"
        mv "$target" "$backup" || {
            installer_log_error "Failed to backup existing link: $target"
            return 1
        }
    fi

    # Create the symlink
    if ln -sf "$source" "$target"; then
        installer_log_debug "Created link: $target -> $source"
        return 0
    else
        installer_log_error "Failed to create link: $target -> $source"
        return 1
    fi
}

# Remove a symlink safely (restore backup if exists)
# Args: target [restore_backup]
# Returns: 0 on success
installer_link_remove() {
    local target="$1"
    local restore_backup="${2:-true}"

    if [[ -L "$target" ]]; then
        rm -f "$target"
        installer_log_debug "Removed link: $target"
    elif [[ -e "$target" ]]; then
        installer_log_warn "Target is not a symlink: $target"
        return 1
    fi

    # Restore backup if exists and requested
    local backup="${target}${LINK_BACKUP_SUFFIX}"
    if [[ "$restore_backup" == "true" && -e "$backup" ]]; then
        mv "$backup" "$target"
        installer_log_debug "Restored backup: $backup -> $target"
    fi

    return 0
}

# Verify a symlink is valid and points to expected target
# Args: link [expected_target]
# Returns: 0 if valid, 1 otherwise
installer_link_verify() {
    local link="$1"
    local expected_target="${2:-}"

    # Check link exists
    if [[ ! -L "$link" ]]; then
        if [[ -e "$link" ]]; then
            installer_log_error "Path exists but is not a symlink: $link"
        else
            installer_log_error "Link does not exist: $link"
        fi
        return 1
    fi

    # Check link target exists
    if [[ ! -e "$link" ]]; then
        installer_log_error "Symlink is broken: $link"
        return 1
    fi

    # Check expected target if provided
    if [[ -n "$expected_target" ]]; then
        local actual_target
        actual_target=$(readlink "$link")

        # Resolve both to absolute paths for comparison
        local resolved_actual resolved_expected
        resolved_actual=$(cd "$(dirname "$link")" && cd "$(dirname "$actual_target")" && pwd)/$(basename "$actual_target")
        resolved_expected=$(cd "$(dirname "$expected_target")" 2>/dev/null && pwd)/$(basename "$expected_target")

        if [[ "$resolved_actual" != "$resolved_expected" && "$actual_target" != "$expected_target" ]]; then
            installer_log_error "Link target mismatch: $link"
            installer_log_error "  Expected: $expected_target"
            installer_log_error "  Actual:   $actual_target"
            return 1
        fi
    fi

    installer_log_debug "Link verified: $link"
    return 0
}

# ============================================
# BIN DIRECTORY SETUP
# ============================================

# Ensure bin directory exists and is in PATH
# Returns: 0 on success, 1 on failure
installer_link_ensure_bin_dir() {
    if [[ ! -d "$LINK_BIN_DIR" ]]; then
        installer_log_info "Creating bin directory: $LINK_BIN_DIR"
        mkdir -p "$LINK_BIN_DIR" || {
            installer_log_error "Failed to create bin directory: $LINK_BIN_DIR"
            return 1
        }
    fi

    # Check if bin dir is in PATH
    if [[ ":$PATH:" != *":$LINK_BIN_DIR:"* ]]; then
        installer_log_warn "Bin directory not in PATH: $LINK_BIN_DIR"
        installer_log_warn "Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
        return 2  # Warning, not failure
    fi

    return 0
}

# Setup all CLI symlinks
# Args: install_dir
# Returns: 0 on success, non-zero on failure
installer_link_setup_bin() {
    local install_dir="${1:-$INSTALL_DIR}"
    local wrapper=""
    local failed=0

    installer_log_step "Setting up CLI symlinks..."

    # Ensure bin directory exists
    installer_link_ensure_bin_dir || true  # Continue even if PATH warning

    # Find or create the wrapper script
    # Check locations in order of preference
    local wrapper_locations=(
        "$install_dir/cleo"
        "$install_dir/bin/cleo"
        "$install_dir/scripts/cleo"
    )

    for loc in "${wrapper_locations[@]}"; do
        if [[ -f "$loc" ]]; then
            wrapper="$loc"
            installer_log_debug "Found wrapper at: $wrapper"
            break
        fi
    done

    # If no wrapper found, create one
    if [[ -z "$wrapper" ]]; then
        installer_log_info "Creating CLI wrapper script..."
        wrapper="$install_dir/cleo"
        if ! installer_link_create_wrapper "$wrapper" "$install_dir"; then
            installer_log_error "Failed to create wrapper script"
            return $EXIT_INSTALL_FAILED
        fi
    fi

    # Make wrapper executable
    chmod +x "$wrapper" 2>/dev/null || true

    # Create main CLI symlink (cleo)
    if installer_link_create "$wrapper" "$LINK_BIN_DIR/$LINK_CLI_NAME"; then
        installer_log_info "Created symlink: $LINK_CLI_NAME -> $wrapper"
    else
        installer_log_error "Failed to create $LINK_CLI_NAME symlink"
        ((failed++))
    fi

    # Create alias symlink (ct)
    if installer_link_create "$wrapper" "$LINK_BIN_DIR/$LINK_ALIAS_NAME"; then
        installer_log_info "Created symlink: $LINK_ALIAS_NAME -> $wrapper"
    else
        installer_log_error "Failed to create $LINK_ALIAS_NAME symlink"
        ((failed++))
    fi

    if [[ $failed -gt 0 ]]; then
        return $EXIT_INSTALL_FAILED
    fi

    return 0
}

# Create CLI wrapper script
# Args: wrapper_path install_dir
# Returns: 0 on success, 1 on failure
installer_link_create_wrapper() {
    local wrapper_path="$1"
    local install_dir="$2"

    cat > "$wrapper_path" << 'WRAPPER_EOF'
#!/usr/bin/env bash
# CLEO CLI Wrapper - Task management for AI agents
# Generated by CLEO installer

# Early Bash version check - try to find and use Bash 4+ on macOS
# System Bash 3.2 doesn't support associative arrays used by CLEO scripts
if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
    # Check if we haven't already tried to re-exec (prevent infinite loop)
    if [[ -z "${_CLEO_REEXEC:-}" ]]; then
        # Look for Bash 4+ in common locations (Homebrew paths)
        _BASH4_PATHS=(
            "/opt/homebrew/bin/bash"  # macOS Apple Silicon
            "/usr/local/bin/bash"     # macOS Intel / Linux Homebrew
            "/home/linuxbrew/.linuxbrew/bin/bash"  # Linux Homebrew
        )

        for _bash_path in "${_BASH4_PATHS[@]}"; do
            if [[ -x "$_bash_path" ]]; then
                # Check version of this bash
                _bash_ver=$("$_bash_path" -c 'echo ${BASH_VERSINFO[0]}' 2>/dev/null || echo 0)
                if [[ "$_bash_ver" -ge 4 ]]; then
                    export _CLEO_REEXEC=1
                    exec "$_bash_path" "$0" "$@"
                fi
            fi
        done

        # No Bash 4+ found, warn and exit
        echo "ERROR: CLEO requires Bash 4.0+ but found ${BASH_VERSION:-unknown}" >&2
        echo "On macOS: brew install bash && echo 'export PATH=\"/opt/homebrew/bin:\$PATH\"' >> ~/.zshrc" >&2
        exit 1
    fi
fi

set -uo pipefail

CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
SCRIPT_DIR="$CLEO_HOME/scripts"
LIB_DIR="$CLEO_HOME/lib"

# Source the main dispatcher if it exists
if [[ -f "$SCRIPT_DIR/cleo" ]]; then
    exec "$SCRIPT_DIR/cleo" "$@"
fi

# Fallback: direct script execution
# Convention-based command discovery - scripts named <command>.sh
# No manual case statement needed. Adding a new command = adding a script.
_get_cmd_script() {
    local cmd="$1"
    local script="${cmd}.sh"
    if [[ -f "$SCRIPT_DIR/$script" ]]; then
        echo "$script"
    else
        echo ""
    fi
}

# Alias resolution (Bash 3.2 compatible)
# Generated from ###CLEO headers + standard convenience aliases
_resolve_alias() {
    case "$1" in
        # Standard aliases
        ls) echo "list" ;; done) echo "complete" ;; new) echo "add" ;; edit) echo "update" ;;
        rm) echo "archive" ;; check) echo "validate" ;; overview) echo "dash" ;; search) echo "find" ;;
        tags) echo "labels" ;; dig) echo "research" ;;
        # Task lifecycle aliases
        cancel) echo "delete" ;; restore-cancelled) echo "uncancel" ;; restore-done) echo "reopen" ;;
        # Hierarchy aliases
        swap) echo "reorder" ;; tree) echo "list" ;;
        *) echo "$1" ;;
    esac
}

# Dynamic command discovery from scripts directory
_get_all_commands() {
    local cmds=""
    for script in "$SCRIPT_DIR"/*.sh; do
        [[ -f "$script" ]] || continue
        local name
        name=$(basename "$script" .sh)
        cmds="$cmds $name"
    done
    echo "${cmds# }"
}

cmd="${1:-help}"
shift 2>/dev/null || true

# Resolve aliases - track original command for special handling
original_cmd="$cmd"
cmd="$(_resolve_alias "$cmd")"

# Handle tree alias: inject --tree flag for list command
if [[ "$original_cmd" == "tree" && "$cmd" == "list" ]]; then
    set -- "--tree" "$@"
fi

# Handle special commands
case "$cmd" in
    version|--version|-v)
        version=$(head -1 "$CLEO_HOME/VERSION" 2>/dev/null || echo "unknown")

        # Check for JSON flag
        if [[ "${1:-}" == "--json" ]]; then
            # Source migrate.sh to get schema version
            if [[ -f "$LIB_DIR/data/migrate.sh" ]]; then
                source "$LIB_DIR/data/migrate.sh"
                schema_version=$(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")
            elif [[ -f "$LIB_DIR/migrate.sh" ]]; then
                source "$LIB_DIR/migrate.sh"
                schema_version=$(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")
            else
                schema_version="unknown"
            fi

            cat <<EOF
{
  "\$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "version": "$version",
    "command": "version",
    "timestamp": "$(date -Iseconds 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%S%z")"
  },
  "success": true,
  "version": "$version",
  "schemaVersion": "$schema_version"
}
EOF
        else
            echo "$version"
        fi
        exit 0
        ;;
    --validate|--debug)
        echo "[INFO] Validating CLEO CLI configuration..."
        errors=0
        for c in $(_get_all_commands); do
            script_name="$(_get_cmd_script "$c")"
            script="$SCRIPT_DIR/$script_name"
            if [[ ! -f "$script" ]]; then
                echo "[ERROR] Missing script for '$c': $script" >&2
                errors=$((errors + 1))
            fi
        done
        if [[ $errors -eq 0 ]]; then
            echo "[INFO] All command scripts found"
            exit 0
        else
            echo "[ERROR] Validation failed with $errors error(s)" >&2
            exit 1
        fi
        ;;
    help|--help|-h)
        echo "CLEO - Task management for AI agents"
        echo "Usage: cleo <command> [options]"
        echo ""
        echo "Commands: init, add, list, update, complete, focus, session, show, find"
        echo "          dash, analyze, config, backup, restore, archive, validate"
        echo ""
        echo "Run 'cleo help <command>' for detailed options."
        exit 0
        ;;
esac

# Execute command
script_name="$(_get_cmd_script "$cmd")"
if [[ -n "$script_name" ]]; then
    script="$SCRIPT_DIR/$script_name"
    if [[ -x "$script" ]]; then
        exec "$script" "$@"
    elif [[ -f "$script" ]]; then
        exec bash "$script" "$@"
    fi
fi

echo "Unknown command: $cmd" >&2
echo "Run 'cleo help' for available commands." >&2
exit 1
WRAPPER_EOF

    chmod +x "$wrapper_path"
    installer_log_debug "Created wrapper: $wrapper_path"
    return 0
}

# Remove all CLI symlinks
# Returns: 0 on success
installer_link_remove_bin() {
    installer_log_info "Removing CLI symlinks..."

    installer_link_remove "$LINK_BIN_DIR/$LINK_CLI_NAME" "true" || true
    installer_link_remove "$LINK_BIN_DIR/$LINK_ALIAS_NAME" "true" || true

    return 0
}

# ============================================
# VERIFICATION
# ============================================

# Verify all symlinks are correct
# Args: install_dir
# Returns: 0 if all valid, 1 otherwise
installer_link_verify_all() {
    local install_dir="${1:-$INSTALL_DIR}"
    local wrapper="$install_dir/cleo"
    local failed=0

    installer_log_info "Verifying CLI symlinks..."

    # Find wrapper
    if [[ ! -f "$wrapper" ]]; then
        wrapper="$install_dir/bin/cleo"
    fi

    # Verify main CLI
    if [[ -L "$LINK_BIN_DIR/$LINK_CLI_NAME" ]]; then
        installer_link_verify "$LINK_BIN_DIR/$LINK_CLI_NAME" || ((failed++))
    else
        installer_log_error "Missing symlink: $LINK_BIN_DIR/$LINK_CLI_NAME"
        ((failed++))
    fi

    # Verify alias
    if [[ -L "$LINK_BIN_DIR/$LINK_ALIAS_NAME" ]]; then
        installer_link_verify "$LINK_BIN_DIR/$LINK_ALIAS_NAME" || ((failed++))
    else
        installer_log_error "Missing symlink: $LINK_BIN_DIR/$LINK_ALIAS_NAME"
        ((failed++))
    fi

    # Test execution
    if [[ $failed -eq 0 ]]; then
        if "$LINK_BIN_DIR/$LINK_CLI_NAME" version &>/dev/null; then
            installer_log_debug "CLI execution test passed"
        else
            installer_log_warn "CLI symlink exists but execution failed"
            ((failed++))
        fi
    fi

    if [[ $failed -gt 0 ]]; then
        installer_log_error "Symlink verification failed: $failed issue(s)"
        return 1
    fi

    installer_log_info "All symlinks verified"
    return 0
}

# ============================================
# SKILLS INTEGRATION
# ============================================

# Target directories for skill symlinks (Claude, Gemini, Codex)
readonly SKILLS_TARGET_DIRS=(
    "$HOME/.claude/skills"
    "$HOME/.gemini/skills"
    "$HOME/.codex/skills"
)

# Clean up old umbrella cleo symlink and broken ct-* symlinks
# Returns: 0 always (cleanup is best-effort)
installer_link_cleanup_old_skills() {
    local cleaned=0

    for skills_dir in "${SKILLS_TARGET_DIRS[@]}"; do
        if [[ ! -d "$skills_dir" ]]; then
            continue
        fi

        # Remove old umbrella cleo symlink (legacy approach)
        if [[ -L "$skills_dir/cleo" ]]; then
            installer_log_info "Removing old umbrella symlink: $skills_dir/cleo"
            rm -f "$skills_dir/cleo"
            ((cleaned++))
        fi

        # Remove broken or stale ct-* symlinks
        for skill in "$skills_dir"/ct-*; do
            if [[ -L "$skill" ]]; then
                local target
                target=$(readlink -f "$skill" 2>/dev/null || true)

                # Remove if target doesn't exist
                if [[ ! -e "$target" ]]; then
                    installer_log_info "Removing broken skill symlink: $(basename "$skill")"
                    rm -f "$skill"
                    ((cleaned++))
                fi
            fi
        done
    done

    if [[ $cleaned -gt 0 ]]; then
        installer_log_info "Cleaned up $cleaned old/broken skill symlinks"
    fi

    return 0
}

# Setup individual ct-* skill symlinks to agent skills directories
# Creates symlinks for EACH ct-* directory found in source
# Args: source_skills_dir
# Returns: 0 on success, 1 on failure
installer_link_setup_skills() {
    local source_dir="${1:-$INSTALL_DIR/skills}"
    local linked=0
    local failed=0

    if [[ ! -d "$source_dir" ]]; then
        installer_log_debug "No skills directory to link: $source_dir"
        return 0
    fi

    installer_log_info "Setting up skills integration..."

    # Clean up old umbrella symlink and broken links first
    installer_link_cleanup_old_skills

    # Process each target directory (Claude, Gemini, Codex)
    for target_dir in "${SKILLS_TARGET_DIRS[@]}"; do
        # Ensure target directory exists
        mkdir -p "$target_dir" 2>/dev/null || {
            installer_log_debug "Could not create directory: $target_dir"
            continue
        }

        # Create symlinks for each ct-* directory
        for skill_dir in "$source_dir"/ct-*; do
            if [[ -d "$skill_dir" ]]; then
                local skill_name
                skill_name=$(basename "$skill_dir")
                local target_link="$target_dir/$skill_name"

                if installer_link_create "$skill_dir" "$target_link"; then
                    installer_log_debug "Linked skill: $skill_name -> $target_link"
                    ((linked++))
                else
                    installer_log_warn "Failed to link skill: $skill_name to $target_dir"
                    ((failed++))
                fi
            fi
        done
    done

    if [[ $linked -gt 0 ]]; then
        installer_log_info "Created $linked skill symlinks across agent directories"
    fi

    if [[ $failed -gt 0 ]]; then
        installer_log_warn "Failed to create $failed skill symlinks"
        return 1
    fi

    return 0
}

# Remove all ct-* skill symlinks from agent directories
installer_link_remove_skills() {
    local removed=0

    for target_dir in "${SKILLS_TARGET_DIRS[@]}"; do
        if [[ ! -d "$target_dir" ]]; then
            continue
        fi

        # Remove old umbrella cleo symlink if exists
        if [[ -L "$target_dir/cleo" ]]; then
            installer_link_remove "$target_dir/cleo" "false"
            ((removed++))
        fi

        # Remove all ct-* symlinks
        for skill in "$target_dir"/ct-*; do
            if [[ -L "$skill" ]]; then
                installer_link_remove "$skill" "false"
                ((removed++))
            fi
        done
    done

    if [[ $removed -gt 0 ]]; then
        installer_log_info "Removed $removed skill symlinks"
    fi

    return 0
}

# ============================================
# CLAUDE.md INTEGRATION
# ============================================

# Detect Claude.md location
# Returns: Path to CLAUDE.md or empty
installer_link_detect_claudemd() {
    local locations=(
        "$HOME/.claude/CLAUDE.md"
        "$HOME/CLAUDE.md"
    )

    for loc in "${locations[@]}"; do
        if [[ -f "$loc" ]]; then
            echo "$loc"
            return 0
        fi
    done

    echo ""
}

# Inject CLEO reference into CLAUDE.md
# Args: claudemd_path
# Returns: 0 on success, 1 on failure
installer_link_inject_claudemd() {
    local claudemd="${1:-$(installer_link_detect_claudemd)}"

    if [[ -z "$claudemd" || ! -f "$claudemd" ]]; then
        installer_log_debug "No CLAUDE.md found to inject"
        return 0
    fi

    local cleo_marker="<!-- CLEO:START"

    # Check if already injected
    if grep -q "$cleo_marker" "$claudemd" 2>/dev/null; then
        installer_log_debug "CLEO already present in CLAUDE.md"
        return 0
    fi

    installer_log_info "Adding CLEO reference to CLAUDE.md..."

    # Backup original
    cp "$claudemd" "${claudemd}${LINK_BACKUP_SUFFIX}"

    # Add CLEO reference at the beginning
    local temp_file="${claudemd}.tmp.$$"
    {
        echo "<!-- CLEO:START -->"
        echo "# Task Management"
        echo "@~/.cleo/templates/CLEO-INJECTION.md"
        echo "<!-- CLEO:END -->"
        echo ""
        cat "$claudemd"
    } > "$temp_file"

    mv "$temp_file" "$claudemd"
    installer_log_info "CLEO reference added to: $claudemd"

    return 0
}

# Remove CLEO reference from CLAUDE.md
# Args: claudemd_path
installer_link_remove_claudemd() {
    local claudemd="${1:-$(installer_link_detect_claudemd)}"

    if [[ -z "$claudemd" || ! -f "$claudemd" ]]; then
        return 0
    fi

    # Remove CLEO section using sed
    local temp_file="${claudemd}.tmp.$$"
    sed '/<!-- CLEO:START/,/<!-- CLEO:END -->/d' "$claudemd" > "$temp_file"
    mv "$temp_file" "$claudemd"

    installer_log_debug "CLEO reference removed from CLAUDE.md"
}

# ============================================
# GLOBAL AGENT CONFIGURATION
# ============================================

# Agent configurations loaded dynamically from schemas/agent-registry.json
# See lib/agent-config.sh for registry management functions

# Get CLEO version for agent config injection
# Returns: version string
installer_link_get_cleo_version() {
    local version=""

    # Try multiple sources for version
    if [[ -n "${INSTALL_DIR:-}" && -f "$INSTALL_DIR/VERSION" ]]; then
        version=$(head -1 "$INSTALL_DIR/VERSION" 2>/dev/null)
    elif [[ -f "$HOME/.cleo/VERSION" ]]; then
        version=$(head -1 "$HOME/.cleo/VERSION" 2>/dev/null)
    elif [[ -n "${INSTALLER_DIR:-}" && -f "$INSTALLER_DIR/../VERSION" ]]; then
        version=$(head -1 "$INSTALLER_DIR/../VERSION" 2>/dev/null)
    fi

    # Strip any 'v' prefix for consistency
    version="${version#v}"

    # Fallback
    echo "${version:-0.57.0}"
}

# Generate CLEO injection content (versionless - content is external)
# Returns: injection content (stdout)
# All instructions are in CLEO-INJECTION.md (single source of truth)
installer_link_generate_cleo_content() {
    cat <<'EOF'
<!-- CLEO:START -->
# Task Management
@~/.cleo/templates/CLEO-INJECTION.md
<!-- CLEO:END -->
EOF
}

# Inject CLEO content into a single agent config file
# Args: config_path agent_name [--force]
# Returns: 0 on success, 1 on error, 2 on skip (already has block)
# Note: No version tracking - block presence = configured (content is external)
installer_link_inject_agent_config() {
    local config_path="$1"
    local agent_name="$2"
    local force="${3:-}"
    local config_dir config_file

    config_dir=$(dirname "$config_path")
    config_file=$(basename "$config_path")

    local cleo_marker="<!-- CLEO:START"

    # Check if already has CLEO injection
    if [[ -f "$config_path" ]] && grep -q "$cleo_marker" "$config_path" 2>/dev/null; then
        if [[ "$force" != "--force" ]]; then
            installer_log_debug "Agent $agent_name already configured"
            return 2  # Skip - already has block
        fi

        # Force update - refresh markers (strip old, add new)
        installer_log_info "Refreshing $agent_name config markers"

        local temp_file="${config_path}.tmp.$$"
        local new_content
        new_content=$(installer_link_generate_cleo_content)

        # Extract content before and after markers
        local before after
        before=$(sed -n '1,/<!-- CLEO:START/p' "$config_path" | sed '$d')
        after=$(sed -n '/<!-- CLEO:END -->/,$p' "$config_path" | tail -n +2)

        # Reconstruct file
        {
            [[ -n "$before" ]] && printf '%s\n' "$before"
            printf '%s\n' "$new_content"
            [[ -n "$after" ]] && printf '%s\n' "$after"
        } > "$temp_file"

        mv "$temp_file" "$config_path"
        return 0
    fi

    # New injection
    local new_content
    new_content=$(installer_link_generate_cleo_content)

    if [[ -f "$config_path" ]]; then
        # Prepend to existing file
        installer_log_info "Adding CLEO to existing $agent_name config"

        # Backup original
        cp "$config_path" "${config_path}${LINK_BACKUP_SUFFIX}"

        local temp_file="${config_path}.tmp.$$"
        {
            printf '%s\n\n' "$new_content"
            cat "$config_path"
        } > "$temp_file"
        mv "$temp_file" "$config_path"
    else
        # Create new file
        installer_log_info "Creating $agent_name config with CLEO"
        printf '%s\n' "$new_content" > "$config_path"
    fi

    return 0
}

# Setup all global agent configurations
# Auto-discovers installed agent CLIs and injects CLEO instructions
# Returns: 0 on success (at least one configured), 1 on error, 2 on no agents found
installer_link_setup_all_agents() {
    local configured=0
    local updated=0
    local skipped=0
    local current=0

    installer_log_step "Setting up global agent configurations..."

    # Load agent registry
    if ! load_agent_registry; then
        installer_log_error "Failed to load agent registry"
        return 1
    fi

    # Iterate through all agents from registry
    local agent_id
    for agent_id in $(get_all_agents); do
        local agent_dir config_file config_path

        agent_dir=$(get_agent_dir "$agent_id")
        config_file=$(get_agent_config_file "$agent_id")

        [[ -z "$agent_dir" ]] && continue
        [[ -z "$config_file" ]] && continue

        # Check if agent directory exists (agent CLI installed)
        if [[ ! -d "$agent_dir" ]]; then
            installer_log_debug "Skipping $agent_id: not installed ($agent_dir)"
            ((skipped++))
            continue
        fi

        config_path="${agent_dir}/${config_file}"

        # Inject CLEO config
        local result
        installer_link_inject_agent_config "$config_path" "$agent_id"
        result=$?

        case $result in
            0)
                if [[ -f "$config_path" ]] && grep -q "<!-- CLEO:START" "$config_path"; then
                    ((configured++))
                else
                    ((updated++))
                fi
                ;;
            2) ((current++)) ;;
            *) installer_log_warn "Failed to configure $agent_id" ;;
        esac
    done

    # Summary
    local total=$((configured + updated + current))
    if [[ $total -gt 0 ]]; then
        installer_log_info "Agent configs: $configured new, $updated updated, $current current, $skipped skipped"
        return 0
    elif [[ $skipped -gt 0 ]]; then
        installer_log_info "No agent directories found (skipped $skipped)"
        return 2
    else
        installer_log_warn "No agent configurations processed"
        return 1
    fi
}

# ============================================
# CLAUDE CODE PLUGIN INTEGRATION
# ============================================

# Setup Claude Code plugin symlink (opt-in)
# Creates ~/.claude/plugins/cleo -> ~/.cleo/.claude-plugin/
# Args: install_dir
# Returns: 0 on success, 1 on failure
installer_link_setup_plugin() {
    local install_dir="${1:-$INSTALL_DIR}"
    local plugin_source="$install_dir/.claude-plugin"
    local plugin_target="$HOME/.claude/plugins/cleo"

    # Verify source plugin directory exists
    if [[ ! -d "$plugin_source" ]]; then
        installer_log_error "Plugin source directory not found: $plugin_source"
        return 1
    fi

    # Create ~/.claude/plugins directory if needed
    local plugin_dir
    plugin_dir=$(dirname "$plugin_target")
    if [[ ! -d "$plugin_dir" ]]; then
        installer_log_info "Creating Claude plugins directory: $plugin_dir"
        mkdir -p "$plugin_dir" || {
            installer_log_error "Failed to create directory: $plugin_dir"
            return 1
        }
    fi

    # Create symlink
    if installer_link_create "$plugin_source" "$plugin_target"; then
        installer_log_info "Created Claude Code plugin symlink: $plugin_target"
        return 0
    else
        installer_log_error "Failed to create plugin symlink"
        return 1
    fi
}

# Remove Claude Code plugin symlink
# Returns: 0 on success
installer_link_remove_plugin() {
    local plugin_target="$HOME/.claude/plugins/cleo"

    if [[ -L "$plugin_target" ]]; then
        installer_link_remove "$plugin_target" "false"
        installer_log_info "Removed Claude Code plugin symlink"
    fi

    return 0
}

# ============================================
# GLOBAL AGENTS DIRECTORY SETUP
# ============================================

# Setup global CLEO agents directory
# Creates ~/.cleo/agents/ and copies agent templates
# Args: install_dir
# Returns: 0 on success, 1 on failure
installer_link_setup_global_agents() {
    local install_dir="${1:-$INSTALL_DIR}"
    local global_agents_dir="$HOME/.cleo/agents"
    local agent_template="$install_dir/templates/agents/cleo-subagent.md"

    installer_log_step "Setting up global CLEO agents directory..."

    # Create global agents directory
    if ! mkdir -p "$global_agents_dir" 2>/dev/null; then
        installer_log_error "Failed to create directory: $global_agents_dir"
        return 1
    fi

    installer_log_debug "Created directory: $global_agents_dir"

    # Copy cleo-subagent template if it exists
    if [[ -f "$agent_template" ]]; then
        if cp "$agent_template" "$global_agents_dir/cleo-subagent.md"; then
            # Set proper permissions (644)
            chmod 644 "$global_agents_dir/cleo-subagent.md" 2>/dev/null || true
            installer_log_info "Installed cleo-subagent to $global_agents_dir"
        else
            installer_log_warn "Failed to install cleo-subagent template"
            return 1
        fi
    else
        installer_log_warn "Agent template not found: $agent_template"
        return 1
    fi

    return 0
}

# ============================================
# POST-INSTALL SETUP
# ============================================

# Create plugins directory with README
# Args: install_dir
# Returns: 0 on success
installer_link_setup_plugins() {
    local install_dir="${1:-$INSTALL_DIR}"
    local plugins_dir="$install_dir/plugins"

    mkdir -p "$plugins_dir"

    if [[ ! -f "$plugins_dir/README.md" ]]; then
        installer_log_info "Creating plugins directory with README..."
        cat > "$plugins_dir/README.md" << 'PLUGINS_EOF'
# CLEO Plugins

Place custom command scripts here. Each `.sh` file becomes a command.

## Plugin Format

```bash
#!/usr/bin/env bash
###PLUGIN
# description: Brief description
###END

echo "Hello from my plugin!"
```

## Usage

1. Create: `~/.cleo/plugins/my-command.sh`
2. Make executable: `chmod +x ~/.cleo/plugins/my-command.sh`
3. Run: `cleo my-command`
PLUGINS_EOF
        installer_log_debug "Created plugins README: $plugins_dir/README.md"
    fi

    return 0
}

# Generate checksums for installed scripts
# Args: install_dir
# Returns: 0 on success
installer_link_generate_checksums() {
    local install_dir="${1:-$INSTALL_DIR}"
    local scripts_dir="$install_dir/scripts"
    local checksum_file="$install_dir/checksums.sha256"

    if [[ ! -d "$scripts_dir" ]]; then
        installer_log_debug "Scripts directory not found, skipping checksum generation"
        return 0
    fi

    installer_log_info "Generating script checksums..."

    if command -v sha256sum &>/dev/null; then
        (cd "$scripts_dir" && sha256sum *.sh > "$checksum_file" 2>/dev/null) || true
    elif command -v shasum &>/dev/null; then
        (cd "$scripts_dir" && shasum -a 256 *.sh > "$checksum_file" 2>/dev/null) || true
    else
        installer_log_debug "No checksum utility available, skipping"
        return 0
    fi

    if [[ -f "$checksum_file" ]]; then
        installer_log_debug "Checksums written to: $checksum_file"
    fi

    return 0
}

# Update template version markers
# Args: install_dir
# Returns: 0 on success
# Convert any legacy versioned markers to versionless format
# No longer updates versions - just ensures markers are versionless
installer_link_update_template_versions() {
    local install_dir="${1:-$INSTALL_DIR}"
    local templates_dir="$install_dir/templates"

    if [[ ! -d "$templates_dir" ]]; then
        installer_log_debug "Templates directory not found, skipping marker cleanup"
        return 0
    fi

    installer_log_debug "Cleaning up any legacy versioned markers in templates..."

    # Convert legacy versioned markers to versionless format
    for template in "$templates_dir"/*.md; do
        [[ -f "$template" ]] || continue

        # Check for legacy versioned markers
        if grep -q "CLEO:START v[0-9]" "$template" 2>/dev/null; then
            # Convert "CLEO:START vX.X.X -->" to "CLEO:START -->"
            if sed --version 2>&1 | grep -q GNU; then
                # GNU sed
                sed -i "s/CLEO:START v[0-9.]\+ -->/CLEO:START -->/g" "$template" 2>/dev/null || true
            else
                # BSD sed (macOS)
                sed -i '' "s/CLEO:START v[0-9.][0-9.]* -->/CLEO:START -->/g" "$template" 2>/dev/null || true
            fi
            installer_log_debug "Cleaned up versioned markers in: $(basename "$template")"
        fi
    done

    return 0
}

# Run all post-install setup tasks
# Args: install_dir
# Returns: 0 on success
installer_link_post_install() {
    local install_dir="${1:-$INSTALL_DIR}"

    installer_log_step "Running post-install setup..."

    # Create plugins directory
    installer_link_setup_plugins "$install_dir" || true

    # Generate checksums (non-critical)
    installer_link_generate_checksums "$install_dir" || true

    # Update template version markers (non-critical)
    installer_link_update_template_versions "$install_dir" || true

    return 0
}

# ============================================
# EXPORT PUBLIC API
# ============================================
export -f installer_link_create
export -f installer_link_remove
export -f installer_link_verify
export -f installer_link_ensure_bin_dir
export -f installer_link_setup_bin
export -f installer_link_create_wrapper
export -f installer_link_remove_bin
export -f installer_link_verify_all
export -f installer_link_cleanup_old_skills
export -f installer_link_setup_skills
export -f installer_link_remove_skills
export -f installer_link_detect_claudemd
export -f installer_link_inject_claudemd
export -f installer_link_remove_claudemd
export -f installer_link_get_cleo_version
export -f installer_link_generate_cleo_content
export -f installer_link_inject_agent_config
export -f installer_link_setup_all_agents
export -f installer_link_setup_plugin
export -f installer_link_remove_plugin
export -f installer_link_setup_global_agents
export -f installer_link_setup_plugins
export -f installer_link_generate_checksums
export -f installer_link_update_template_versions
export -f installer_link_post_install
