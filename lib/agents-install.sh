#!/usr/bin/env bash
# agents-install.sh - Agents installation functions for CLEO
#
# Installs agent definitions to ~/.claude/agents/ via symlinks for auto-propagating updates.
# Supports both symlink (default) and copy modes for flexibility.
#
# LAYER: 0 (Standalone utility - no lib dependencies for installer use)
# PROVIDES: install_agents, install_agent

#=== SOURCE GUARD ================================================
[[ -n "${_AGENTS_INSTALL_LOADED:-}" ]] && return 0
declare -r _AGENTS_INSTALL_LOADED=1

# ============================================================================
# CONFIGURATION
# ============================================================================

# Target directory for agents (Claude Code agents directory)
AGENTS_TARGET_DIR="${AGENTS_TARGET_DIR:-$HOME/.claude/agents}"

# Source paths (set by caller or derived)
CLEO_REPO_ROOT="${CLEO_REPO_ROOT:-}"
AGENTS_SOURCE_DIR=""

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Initialize paths based on CLEO_REPO_ROOT
_init_agents_paths() {
    if [[ -z "$CLEO_REPO_ROOT" ]]; then
        # Try to derive from this script's location
        local script_dir
        script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        CLEO_REPO_ROOT="$(dirname "$script_dir")"
    fi
    AGENTS_SOURCE_DIR="$CLEO_REPO_ROOT/templates/agents"
}

# ============================================================================
# PUBLIC FUNCTIONS
# ============================================================================

# Install a single agent via symlink or copy
# Args: $1 = agent filename (e.g., "cleo-subagent.md")
#       $2 = mode ("symlink" or "copy")
#       $3 = optional log function name
# Returns: 0 on success, 1 on error
install_agent() {
    local agent_file="$1"
    local mode="${2:-symlink}"
    local log_func="${3:-echo}"

    _init_agents_paths

    local source_file="$AGENTS_SOURCE_DIR/$agent_file"
    local target_file="$AGENTS_TARGET_DIR/$agent_file"

    # Verify source exists
    if [[ ! -f "$source_file" ]]; then
        $log_func "[WARN] Agent source file not found: $source_file"
        return 1
    fi

    # Handle existing installation
    if [[ -L "$target_file" ]]; then
        # Already a symlink - check if pointing to same location
        local existing_target
        existing_target=$(readlink -f "$target_file" 2>/dev/null || readlink "$target_file")
        local source_canonical
        source_canonical=$(cd "$(dirname "$source_file")" && pwd)/$(basename "$source_file")

        if [[ "$existing_target" == "$source_canonical" ]]; then
            $log_func "[INFO] Agent already installed: $agent_file"
            return 0
        else
            # Different target or switching modes - update
            rm -f "$target_file"
            $log_func "[INFO] Updating agent installation: $agent_file"
        fi
    elif [[ -f "$target_file" ]]; then
        # Exists as regular file (user customization) - preserve it
        $log_func "[INFO] Preserving existing agent file (not symlink): $agent_file"
        return 0
    elif [[ -e "$target_file" ]]; then
        # Some other type of file
        $log_func "[WARN] Unexpected file at target location, skipping: $target_file"
        return 1
    fi

    # Install based on mode
    case "$mode" in
        symlink)
            # Create symlink
            if ln -s "$source_file" "$target_file" 2>/dev/null; then
                $log_func "[INFO] Installed agent (symlink): $agent_file"
                return 0
            else
                $log_func "[ERROR] Failed to create symlink for: $agent_file"
                return 1
            fi
            ;;
        copy)
            # Copy file
            if cp "$source_file" "$target_file" 2>/dev/null; then
                $log_func "[INFO] Installed agent (copy): $agent_file"
                return 0
            else
                $log_func "[ERROR] Failed to copy: $agent_file"
                return 1
            fi
            ;;
        *)
            $log_func "[ERROR] Invalid mode: $mode (must be 'symlink' or 'copy')"
            return 1
            ;;
    esac
}

# Install all agents from templates/agents/
# Args: $1 = mode ("symlink" or "copy", default: symlink)
#       $2 = optional log function name
# Returns: 0 on success (even with some agent failures)
install_agents() {
    local mode="${1:-symlink}"
    local log_func="${2:-echo}"

    _init_agents_paths

    # Verify source directory exists
    if [[ ! -d "$AGENTS_SOURCE_DIR" ]]; then
        $log_func "[WARN] Agents source directory not found: $AGENTS_SOURCE_DIR"
        return 0
    fi

    # Ensure target directory exists
    if ! mkdir -p "$AGENTS_TARGET_DIR" 2>/dev/null; then
        $log_func "[WARN] Could not create agents directory: $AGENTS_TARGET_DIR"
        return 1
    fi

    # Get list of agent files
    local agent_files
    agent_files=$(find "$AGENTS_SOURCE_DIR" -maxdepth 1 -name "*.md" -type f 2>/dev/null)

    if [[ -z "$agent_files" ]]; then
        $log_func "[WARN] No agent files found in: $AGENTS_SOURCE_DIR"
        return 0
    fi

    # Install each agent
    local installed=0
    local failed=0
    local skipped=0

    while IFS= read -r agent_path; do
        [[ -z "$agent_path" ]] && continue

        local agent_file
        agent_file=$(basename "$agent_path")

        if install_agent "$agent_file" "$mode" "$log_func"; then
            ((installed++)) || true
        else
            # Check if it was skipped (preserved) vs failed
            if [[ -f "$AGENTS_TARGET_DIR/$agent_file" && ! -L "$AGENTS_TARGET_DIR/$agent_file" ]]; then
                ((skipped++)) || true
            else
                ((failed++)) || true
            fi
        fi
    done <<< "$agent_files"

    # Summary
    local total=$((installed + failed + skipped))
    $log_func "[INFO] Agents installation complete: $installed installed, $skipped preserved, $failed failed (total: $total)"

    return 0
}

# Uninstall agents (remove symlinks only, preserves regular files)
# Args: $1 = optional log function name
uninstall_agents() {
    local log_func="${1:-echo}"

    _init_agents_paths

    if [[ ! -d "$AGENTS_TARGET_DIR" ]]; then
        $log_func "[INFO] Agents directory does not exist, nothing to uninstall"
        return 0
    fi

    # Remove only symlinks, preserve regular files (user customizations)
    local removed=0

    for agent_file in "$AGENTS_TARGET_DIR"/*.md; do
        [[ -L "$agent_file" ]] || continue

        # Only remove if it's a symlink
        rm -f "$agent_file"
        $log_func "[INFO] Removed agent symlink: $(basename "$agent_file")"
        ((removed++))
    done

    $log_func "[INFO] Uninstalled $removed agent symlinks (preserved regular files)"
    return 0
}

# List installed agents with status
# Returns: JSON array of agent status
list_installed_agents() {
    _init_agents_paths

    if [[ ! -d "$AGENTS_TARGET_DIR" ]]; then
        echo "[]"
        return 0
    fi

    local result="["
    local first=true

    for agent_file in "$AGENTS_TARGET_DIR"/*.md; do
        [[ -e "$agent_file" ]] || continue

        local agent_name
        agent_name=$(basename "$agent_file")
        local status="not_installed"
        local is_symlink="false"

        if [[ -L "$agent_file" ]]; then
            # Check if symlink is valid
            if [[ -e "$agent_file" ]]; then
                status="installed"
                is_symlink="true"
            else
                status="broken_symlink"
                is_symlink="true"
            fi
        elif [[ -f "$agent_file" ]]; then
            status="installed_file"
            is_symlink="false"
        fi

        $first || result+=","
        first=false
        result+="{\"name\":\"$agent_name\",\"status\":\"$status\",\"isSymlink\":$is_symlink}"
    done

    result+="]"
    echo "$result"
}
