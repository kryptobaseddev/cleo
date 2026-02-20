#!/usr/bin/env bash
# skill-paths.sh - Multi-source skill path resolver for CAAMP integration
#
# Resolves skills, protocols, and shared resources from multiple locations.
# Supports CAAMP canonical paths, project-embedded paths, and explicit overrides.
#
# LAYER: 1 (Foundation - no lib dependencies beyond core)
# PROVIDES:
#   get_skill_search_paths  - Ordered newline-separated search paths
#   resolve_skill_path      - Find skill directory containing SKILL.md
#   resolve_protocol_path   - Find protocol .md file
#   resolve_shared_path     - Find shared resource .md file
#   get_skill_source_type   - Classify source as embedded|caamp|project-link|global-link
#
# ENVIRONMENT VARIABLES:
#   CLEO_SKILL_SOURCE  - "auto" (default), "caamp", "embedded"
#   CLEO_SKILL_PATH    - Colon-separated explicit override paths (highest priority)
#   AGENTS_HOME        - CAAMP root directory, default ~/.agents
#
# USAGE:
#   source lib/skills/skill-paths.sh
#
#   # Resolve a skill directory
#   skill_dir=$(resolve_skill_path "ct-research-agent")
#
#   # Resolve a protocol file
#   proto=$(resolve_protocol_path "research")
#
#   # Resolve a shared resource
#   shared=$(resolve_shared_path "subagent-protocol-base")
#
#   # Check where a skill came from
#   source_type=$(get_skill_source_type "$skill_dir")

#=== SOURCE GUARD ================================================
[[ -n "${_SKILL_PATHS_LOADED:-}" ]] && return 0
declare -r _SKILL_PATHS_LOADED=1

set -euo pipefail

# ============================================================================
# CONSTANTS
# ============================================================================

# CAAMP canonical skill location
_SP_CAAMP_CANONICAL="${AGENTS_HOME:-$HOME/.agents}/skills"

# Determine project root from this script's location (lib/skills/ -> project root)
_SP_SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
[[ "$_SP_SCRIPT_DIR" == "${BASH_SOURCE[0]}" ]] && _SP_SCRIPT_DIR="."
_SP_PROJECT_ROOT="${_SP_SCRIPT_DIR}/../.."
# Normalize to absolute path if possible
if command -v realpath &>/dev/null; then
    _SP_PROJECT_ROOT="$(realpath "$_SP_PROJECT_ROOT" 2>/dev/null || echo "$_SP_PROJECT_ROOT")"
fi

# Project-embedded skill location
_SP_PROJECT_EMBEDDED="${_SP_PROJECT_ROOT}/skills"

# ============================================================================
# FUNCTIONS
# ============================================================================

# get_skill_search_paths - Return newline-separated ordered search paths
#
# Priority order:
#   1. CLEO_SKILL_PATH entries (explicit overrides, highest priority)
#   2. Source-determined paths based on CLEO_SKILL_SOURCE
#
# CLEO_SKILL_SOURCE modes:
#   auto     - CAAMP canonical + embedded (default)
#   caamp    - CAAMP canonical only
#   embedded - Project embedded only
#
# Output: One path per line, in priority order. Only existing directories are included.
get_skill_search_paths() {
    local source_mode="${CLEO_SKILL_SOURCE:-auto}"
    local paths=()

    # Explicit override paths get highest priority
    if [[ -n "${CLEO_SKILL_PATH:-}" ]]; then
        local IFS=':'
        local override_paths
        read -ra override_paths <<< "$CLEO_SKILL_PATH"
        for p in "${override_paths[@]}"; do
            [[ -d "$p" ]] && paths+=("$p")
        done
    fi

    # Source-determined paths
    case "$source_mode" in
        caamp)
            [[ -d "$_SP_CAAMP_CANONICAL" ]] && paths+=("$_SP_CAAMP_CANONICAL")
            ;;
        embedded)
            [[ -d "$_SP_PROJECT_EMBEDDED" ]] && paths+=("$_SP_PROJECT_EMBEDDED")
            ;;
        auto|*)
            # CAAMP first (external package takes precedence), then embedded
            [[ -d "$_SP_CAAMP_CANONICAL" ]] && paths+=("$_SP_CAAMP_CANONICAL")
            [[ -d "$_SP_PROJECT_EMBEDDED" ]] && paths+=("$_SP_PROJECT_EMBEDDED")
            ;;
    esac

    # Output one path per line
    local p
    for p in "${paths[@]}"; do
        printf '%s\n' "$p"
    done
}

# resolve_skill_path - Find skill directory containing SKILL.md
#
# Searches all paths from get_skill_search_paths() in priority order.
# First match wins.
#
# Arguments:
#   $1 - skill_name (e.g. "ct-research-agent")
#
# Output: Absolute path to skill directory
# Returns: 0 on success, 1 if not found
resolve_skill_path() {
    local skill_name="${1:?resolve_skill_path requires skill_name}"
    local search_path

    while IFS= read -r search_path; do
        local candidate="${search_path}/${skill_name}"
        if [[ -f "${candidate}/SKILL.md" ]]; then
            # Return absolute path
            if command -v realpath &>/dev/null; then
                realpath "$candidate" 2>/dev/null || echo "$candidate"
            else
                echo "$candidate"
            fi
            return 0
        fi
    done < <(get_skill_search_paths)

    return 1
}

# resolve_protocol_path - Find protocol .md file
#
# Search order per base path:
#   1. {base}/_ct-skills-protocols/{protocol_name}.md  (Strategy B shared dir)
#   2. {PROJECT_ROOT}/protocols/{protocol_name}.md     (legacy embedded fallback)
#
# Arguments:
#   $1 - protocol_name (e.g. "research", without .md extension)
#
# Output: Absolute path to protocol file
# Returns: 0 on success, 1 if not found
resolve_protocol_path() {
    local protocol_name="${1:?resolve_protocol_path requires protocol_name}"
    local search_path

    # Search Strategy B shared directories in each base path
    while IFS= read -r search_path; do
        local candidate="${search_path}/_ct-skills-protocols/${protocol_name}.md"
        if [[ -f "$candidate" ]]; then
            if command -v realpath &>/dev/null; then
                realpath "$candidate" 2>/dev/null || echo "$candidate"
            else
                echo "$candidate"
            fi
            return 0
        fi
    done < <(get_skill_search_paths)

    # Legacy fallback: project root protocols directory
    local legacy="${_SP_PROJECT_ROOT}/protocols/${protocol_name}.md"
    if [[ -f "$legacy" ]]; then
        if command -v realpath &>/dev/null; then
            realpath "$legacy" 2>/dev/null || echo "$legacy"
        else
            echo "$legacy"
        fi
        return 0
    fi

    return 1
}

# resolve_shared_path - Find shared resource .md file
#
# Search order per base path:
#   1. {base}/_ct-skills-shared/{resource_name}.md  (Strategy B shared dir)
#   2. {base}/_shared/{resource_name}.md            (legacy embedded layout)
#
# Arguments:
#   $1 - resource_name (e.g. "subagent-protocol-base", without .md extension)
#
# Output: Absolute path to shared resource file
# Returns: 0 on success, 1 if not found
resolve_shared_path() {
    local resource_name="${1:?resolve_shared_path requires resource_name}"
    local search_path

    while IFS= read -r search_path; do
        # Strategy B: _ct-skills-shared/ directory
        local candidate="${search_path}/_ct-skills-shared/${resource_name}.md"
        if [[ -f "$candidate" ]]; then
            if command -v realpath &>/dev/null; then
                realpath "$candidate" 2>/dev/null || echo "$candidate"
            else
                echo "$candidate"
            fi
            return 0
        fi

        # Legacy: _shared/ directory within each base path
        local legacy="${search_path}/_shared/${resource_name}.md"
        if [[ -f "$legacy" ]]; then
            if command -v realpath &>/dev/null; then
                realpath "$legacy" 2>/dev/null || echo "$legacy"
            else
                echo "$legacy"
            fi
            return 0
        fi
    done < <(get_skill_search_paths)

    return 1
}

# get_skill_source_type - Classify the source of a skill directory
#
# Determines where a skill directory lives in the search hierarchy.
#
# Arguments:
#   $1 - skill_dir (absolute path to a skill directory)
#
# Output: One of: "embedded" | "caamp" | "project-link" | "global-link"
# Returns: 0 on success, 1 if classification fails
get_skill_source_type() {
    local skill_dir="${1:?get_skill_source_type requires skill_dir}"

    # Normalize the input path for comparison
    local normalized_dir="$skill_dir"
    if command -v realpath &>/dev/null; then
        normalized_dir="$(realpath "$skill_dir" 2>/dev/null || echo "$skill_dir")"
    fi

    # Check if skill_dir is a symlink (indicates a linked skill)
    if [[ -L "$skill_dir" ]]; then
        local link_target
        link_target="$(readlink -f "$skill_dir" 2>/dev/null || readlink "$skill_dir")"

        # Symlink target under CAAMP = global-link
        if [[ "$link_target" == "${_SP_CAAMP_CANONICAL}"* ]]; then
            echo "global-link"
            return 0
        fi

        # Symlink target under project = project-link
        if [[ "$link_target" == "${_SP_PROJECT_EMBEDDED}"* || "$link_target" == "${_SP_PROJECT_ROOT}"* ]]; then
            echo "project-link"
            return 0
        fi

        # Symlink to somewhere else, classify by target location
        echo "global-link"
        return 0
    fi

    # Not a symlink - classify by containing directory
    if [[ "$normalized_dir" == "${_SP_PROJECT_EMBEDDED}"* || "$normalized_dir" == "${_SP_PROJECT_ROOT}/skills"* ]]; then
        echo "embedded"
        return 0
    fi

    local normalized_caamp="$_SP_CAAMP_CANONICAL"
    if command -v realpath &>/dev/null; then
        normalized_caamp="$(realpath "$_SP_CAAMP_CANONICAL" 2>/dev/null || echo "$_SP_CAAMP_CANONICAL")"
    fi

    if [[ "$normalized_dir" == "${normalized_caamp}"* ]]; then
        echo "caamp"
        return 0
    fi

    # Could not classify - likely from an explicit CLEO_SKILL_PATH override
    return 1
}
