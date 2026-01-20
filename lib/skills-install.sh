#!/usr/bin/env bash
# skills-install.sh - Skills installation functions for CLEO
#
# Installs skills to ~/.claude/skills/ via symlinks for auto-propagating updates.
# Reads skill definitions from skills/manifest.json.
#
# LAYER: 0 (Standalone utility - no lib dependencies for installer use)
# PROVIDES: install_skills, install_skill, get_skills_from_manifest, uninstall_skills

#=== SOURCE GUARD ================================================
[[ -n "${_SKILLS_INSTALL_LOADED:-}" ]] && return 0
declare -r _SKILLS_INSTALL_LOADED=1

# ============================================================================
# CONFIGURATION
# ============================================================================

# Target directory for skills (Claude Code skills directory)
SKILLS_TARGET_DIR="${SKILLS_TARGET_DIR:-$HOME/.claude/skills}"

# Source paths (set by caller or derived)
CLEO_REPO_ROOT="${CLEO_REPO_ROOT:-}"
SKILLS_MANIFEST=""

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Initialize paths based on CLEO_REPO_ROOT
_init_skills_paths() {
    if [[ -z "$CLEO_REPO_ROOT" ]]; then
        # Try to derive from this script's location
        local script_dir
        script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        CLEO_REPO_ROOT="$(dirname "$script_dir")"
    fi
    SKILLS_MANIFEST="$CLEO_REPO_ROOT/skills/manifest.json"
}

# ============================================================================
# PUBLIC FUNCTIONS
# ============================================================================

# Get list of skill names from manifest
# Returns newline-separated list of skill names
get_skills_from_manifest() {
    _init_skills_paths

    if [[ ! -f "$SKILLS_MANIFEST" ]]; then
        echo "ERROR: Skills manifest not found: $SKILLS_MANIFEST" >&2
        return 1
    fi

    if ! command -v jq &>/dev/null; then
        echo "ERROR: jq is required but not installed" >&2
        return 1
    fi

    # Return only active skills
    jq -r '.skills[] | select(.status == "active") | .name' "$SKILLS_MANIFEST" 2>/dev/null
}

# Get skill path from manifest by name
# Args: $1 = skill name
# Returns: relative path to skill directory
get_skill_path() {
    local skill_name="$1"
    _init_skills_paths

    if [[ ! -f "$SKILLS_MANIFEST" ]]; then
        return 1
    fi

    jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name) | .path' \
        "$SKILLS_MANIFEST" 2>/dev/null
}

# Install a single skill via symlink
# Args: $1 = skill name
# Returns: 0 on success, 1 on error
install_skill() {
    local skill_name="$1"
    local log_func="${2:-echo}"  # Optional logging function

    _init_skills_paths

    # Get skill path from manifest
    local skill_rel_path
    skill_rel_path=$(get_skill_path "$skill_name")

    if [[ -z "$skill_rel_path" ]]; then
        $log_func "[WARN] Skill not found in manifest: $skill_name"
        return 1
    fi

    local source_dir="$CLEO_REPO_ROOT/$skill_rel_path"
    local target_link="$SKILLS_TARGET_DIR/$skill_name"

    # Verify source exists
    if [[ ! -d "$source_dir" ]]; then
        $log_func "[WARN] Skill source directory not found: $source_dir"
        return 1
    fi

    # Handle existing installation
    if [[ -L "$target_link" ]]; then
        # Already a symlink - check if pointing to same location
        local existing_target
        existing_target=$(readlink -f "$target_link" 2>/dev/null || readlink "$target_link")
        local source_canonical
        source_canonical=$(cd "$source_dir" && pwd)

        if [[ "$existing_target" == "$source_canonical" ]]; then
            $log_func "[INFO] Skill already installed: $skill_name"
            return 0
        else
            # Different target - update symlink
            rm -f "$target_link"
            $log_func "[INFO] Updating skill symlink: $skill_name"
        fi
    elif [[ -d "$target_link" ]]; then
        # Exists as regular directory - don't overwrite
        $log_func "[WARN] Skill exists as directory (not symlink), skipping: $skill_name"
        return 0
    elif [[ -e "$target_link" ]]; then
        # Some other type of file
        $log_func "[WARN] Unexpected file at target location, skipping: $target_link"
        return 1
    fi

    # Create symlink
    if ln -s "$source_dir" "$target_link" 2>/dev/null; then
        $log_func "[INFO] Installed skill: $skill_name"
        return 0
    else
        $log_func "[ERROR] Failed to create symlink for: $skill_name"
        return 1
    fi
}

# Install all skills from manifest
# Args: $1 = skip_skills flag (true/false)
#       $2 = optional log function name
# Returns: 0 on success (even with some skill failures)
install_skills() {
    local skip_skills="${1:-false}"
    local log_func="${2:-echo}"

    if [[ "$skip_skills" == "true" ]]; then
        $log_func "[INFO] Skipping skills installation (--skip-skills)"
        return 0
    fi

    _init_skills_paths

    # Verify manifest exists
    if [[ ! -f "$SKILLS_MANIFEST" ]]; then
        $log_func "[WARN] Skills manifest not found, skipping skills installation"
        return 0
    fi

    # Ensure target directory exists
    if ! mkdir -p "$SKILLS_TARGET_DIR" 2>/dev/null; then
        $log_func "[WARN] Could not create skills directory: $SKILLS_TARGET_DIR"
        return 1
    fi

    # Get list of skills to install
    local skills
    skills=$(get_skills_from_manifest)

    if [[ -z "$skills" ]]; then
        $log_func "[WARN] No active skills found in manifest"
        return 0
    fi

    # Install each skill
    local installed=0
    local failed=0
    local skipped=0

    while IFS= read -r skill_name; do
        [[ -z "$skill_name" ]] && continue

        if install_skill "$skill_name" "$log_func"; then
            ((installed++)) || true
        else
            ((failed++)) || true
        fi
    done <<< "$skills"

    # Summary
    local total=$((installed + failed + skipped))
    $log_func "[INFO] Skills installation complete: $installed installed, $failed failed (total: $total)"

    return 0
}

# Uninstall skills (remove symlinks only, preserves directories)
# Args: $1 = optional log function name
uninstall_skills() {
    local log_func="${1:-echo}"

    _init_skills_paths

    if [[ ! -d "$SKILLS_TARGET_DIR" ]]; then
        $log_func "[INFO] Skills directory does not exist, nothing to uninstall"
        return 0
    fi

    # Get list of skills from manifest
    local skills
    skills=$(get_skills_from_manifest)

    if [[ -z "$skills" ]]; then
        return 0
    fi

    local removed=0

    while IFS= read -r skill_name; do
        [[ -z "$skill_name" ]] && continue

        local target_link="$SKILLS_TARGET_DIR/$skill_name"

        # Only remove if it's a symlink (don't touch directories)
        if [[ -L "$target_link" ]]; then
            rm -f "$target_link"
            $log_func "[INFO] Removed skill symlink: $skill_name"
            ((removed++))
        fi
    done <<< "$skills"

    $log_func "[INFO] Uninstalled $removed skill symlinks"
    return 0
}

# List installed skills with status
# Returns: JSON array of skill status
list_installed_skills() {
    _init_skills_paths

    if [[ ! -d "$SKILLS_TARGET_DIR" ]]; then
        echo "[]"
        return 0
    fi

    local skills
    skills=$(get_skills_from_manifest)

    local result="["
    local first=true

    while IFS= read -r skill_name; do
        [[ -z "$skill_name" ]] && continue

        local target_link="$SKILLS_TARGET_DIR/$skill_name"
        local status="not_installed"
        local is_symlink="false"

        if [[ -L "$target_link" ]]; then
            status="installed"
            is_symlink="true"
        elif [[ -d "$target_link" ]]; then
            status="installed_directory"
            is_symlink="false"
        fi

        $first || result+=","
        first=false
        result+="{\"name\":\"$skill_name\",\"status\":\"$status\",\"isSymlink\":$is_symlink}"
    done <<< "$skills"

    result+="]"
    echo "$result"
}
