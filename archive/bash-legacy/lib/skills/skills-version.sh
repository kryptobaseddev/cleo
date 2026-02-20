#!/usr/bin/env bash
# ============================================================================
# lib/skills/skills-version.sh - Skills version tracking for CLEO
# ============================================================================
# LAYER: 2 (Data Layer)
# DEPENDENCIES: paths.sh (optional)
# PROVIDES: init_installed_skills, record_skill_version, get_installed_version,
#           check_skill_updates, apply_skill_updates
#
# Design: Tracks installed skill versions in ~/.cleo/installed-skills.json
#         and compares against skills/manifest.json during upgrades.
# ============================================================================

# Prevent multiple sourcing
[[ -n "${_SKILLS_VERSION_SH_LOADED:-}" ]] && return 0
readonly _SKILLS_VERSION_SH_LOADED=1

# ============================================================================
# PATHS AND CONSTANTS
# ============================================================================
# Determine CLEO_HOME if not set
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Installed skills tracking file (global, in CLEO_HOME)
INSTALLED_SKILLS_FILE="${CLEO_HOME}/installed-skills.json"

# Get the CLEO_ROOT (installation root where skills/manifest.json lives)
# This handles both installed and development scenarios
_get_cleo_root() {
    # If CLEO_ROOT is set, use it
    if [[ -n "${CLEO_ROOT:-}" ]]; then
        echo "$CLEO_ROOT"
        return 0
    fi

    # Try to determine from this script's location
    local script_path="${BASH_SOURCE[0]}"
    if [[ -n "$script_path" ]]; then
        local lib_dir
        lib_dir="$(cd "$(dirname "$script_path")" 2>/dev/null && pwd)"
        if [[ -d "$lib_dir/../skills" ]]; then
            echo "$(cd "$lib_dir/.." && pwd)"
            return 0
        fi
    fi

    # Fallback to CLEO_HOME
    echo "$CLEO_HOME"
}

MANIFEST_FILE="$(_get_cleo_root)/skills/manifest.json"

# ============================================================================
# INITIALIZATION
# ============================================================================

# Initialize installed skills tracking file
# Creates the file if it doesn't exist
init_installed_skills() {
    # Ensure CLEO_HOME directory exists
    if [[ ! -d "$CLEO_HOME" ]]; then
        mkdir -p "$CLEO_HOME"
    fi

    if [[ ! -f "$INSTALLED_SKILLS_FILE" ]]; then
        local timestamp
        timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        cat > "$INSTALLED_SKILLS_FILE" << EOF
{
  "installedAt": "$timestamp",
  "lastChecked": "$timestamp",
  "skills": {}
}
EOF
    fi
}

# ============================================================================
# VERSION RECORDING
# ============================================================================

# Record an installed skill version
# Args: $1 = skill name, $2 = version
record_skill_version() {
    local skill_name="$1"
    local version="$2"

    if [[ -z "$skill_name" || -z "$version" ]]; then
        return 1
    fi

    init_installed_skills

    local tmp_file timestamp
    tmp_file=$(mktemp)
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    jq --arg name "$skill_name" \
       --arg ver "$version" \
       --arg ts "$timestamp" \
       '.skills[$name] = $ver | .lastChecked = $ts' \
       "$INSTALLED_SKILLS_FILE" > "$tmp_file"

    if [[ -s "$tmp_file" ]]; then
        mv "$tmp_file" "$INSTALLED_SKILLS_FILE"
        return 0
    else
        rm -f "$tmp_file"
        return 1
    fi
}

# ============================================================================
# VERSION RETRIEVAL
# ============================================================================

# Get the installed version of a skill
# Args: $1 = skill name
# Returns: version string or "0.0.0" if not found
get_installed_version() {
    local skill_name="$1"

    if [[ ! -f "$INSTALLED_SKILLS_FILE" ]]; then
        echo "0.0.0"
        return
    fi

    local version
    version=$(jq -r --arg name "$skill_name" '.skills[$name] // "0.0.0"' "$INSTALLED_SKILLS_FILE" 2>/dev/null)

    if [[ -z "$version" || "$version" == "null" ]]; then
        echo "0.0.0"
    else
        echo "$version"
    fi
}

# ============================================================================
# UPDATE CHECKING
# ============================================================================

# Check for skill updates by comparing manifest vs installed versions
# Returns: JSON array of updates needed
#   [{name: "skill-name", from: "old-version", to: "new-version"}, ...]
check_skill_updates() {
    local updates_json="[]"

    # If manifest doesn't exist, return empty array
    if [[ ! -f "$MANIFEST_FILE" ]]; then
        echo "[]"
        return 0
    fi

    # Initialize installed skills file if needed
    init_installed_skills

    # Read all skills from manifest and compare versions
    local skill_data
    skill_data=$(jq -c '.skills[]' "$MANIFEST_FILE" 2>/dev/null) || {
        echo "[]"
        return 0
    }

    local updates=()
    while IFS= read -r skill; do
        [[ -z "$skill" ]] && continue

        local name version installed
        name=$(echo "$skill" | jq -r '.name')
        version=$(echo "$skill" | jq -r '.version')

        # Skip skills without version
        [[ -z "$name" || -z "$version" || "$version" == "null" ]] && continue

        installed=$(get_installed_version "$name")

        if [[ "$installed" != "$version" ]]; then
            updates+=("{\"name\":\"$name\",\"from\":\"$installed\",\"to\":\"$version\"}")
        fi
    done <<< "$skill_data"

    # Build JSON array from updates
    if [[ ${#updates[@]} -eq 0 ]]; then
        echo "[]"
    else
        # Join array elements with commas and wrap in brackets
        local IFS=','
        echo "[${updates[*]}]"
    fi
}

# ============================================================================
# UPDATE APPLICATION
# ============================================================================

# Apply skill updates by recording new versions
# Args: $1 = JSON array of updates from check_skill_updates
# Returns: count of updates applied
apply_skill_updates() {
    local updates_json="${1:-[]}"
    local count=0

    # Parse and iterate through updates
    local update
    while IFS= read -r update; do
        [[ -z "$update" ]] && continue

        local name to_version
        name=$(echo "$update" | jq -r '.name')
        to_version=$(echo "$update" | jq -r '.to')

        # Skip invalid entries
        [[ -z "$name" || -z "$to_version" || "$name" == "null" ]] && continue

        # Record the new version
        if record_skill_version "$name" "$to_version"; then
            ((count++))
        fi
    done < <(echo "$updates_json" | jq -c '.[]' 2>/dev/null)

    echo "$count"
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# Get count of skills with updates available
# Returns: integer count
get_skill_update_count() {
    local updates
    updates=$(check_skill_updates)
    echo "$updates" | jq 'length'
}

# Format skill updates for display (human-readable)
# Args: $1 = JSON array of updates
# Outputs formatted lines to stdout
format_skill_updates() {
    local updates_json="${1:-[]}"
    local tmp_file
    tmp_file=$(mktemp)

    # Write JSON to temp file and process
    printf '%s' "$updates_json" > "$tmp_file"
    jq -r '.[] | "  " + .name + ": " + .from + " -> " + .to' "$tmp_file" 2>/dev/null
    rm -f "$tmp_file"
}

# Record all current manifest skills as installed
# Useful for initial installation or reset
record_all_manifest_skills() {
    if [[ ! -f "$MANIFEST_FILE" ]]; then
        return 1
    fi

    init_installed_skills

    local count=0
    local skill_data
    skill_data=$(jq -c '.skills[]' "$MANIFEST_FILE" 2>/dev/null) || return 1

    while IFS= read -r skill; do
        [[ -z "$skill" ]] && continue

        local name version
        name=$(echo "$skill" | jq -r '.name')
        version=$(echo "$skill" | jq -r '.version')

        if [[ -n "$name" && -n "$version" && "$version" != "null" ]]; then
            record_skill_version "$name" "$version" && ((count++))
        fi
    done <<< "$skill_data"

    echo "$count"
}
