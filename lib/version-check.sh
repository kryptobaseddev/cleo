#!/usr/bin/env bash
# ============================================================================
# lib/version-check.sh - Project version checking and warning system
# ============================================================================
# LAYER: 2 (Data Layer)
# DEPENDENCIES: config.sh, migrate.sh
# PROVIDES: check_project_version, show_version_warnings
#
# Design: Fast checks that run on every command to warn about outdated projects
# ============================================================================

# Suppress warnings for these commands (they handle their own checks)
VERSION_CHECK_SKIP_COMMANDS="upgrade|migrate|init|validate|help|version|--help|-h|--version|-v"

# Cache for version check results (avoid re-checking in same process)
_VERSION_CHECK_DONE=""
_VERSION_WARNINGS=()

# ============================================================================
# QUICK VERSION DETECTION
# ============================================================================

# Fast check if project needs updates (cached per process)
# Returns: 0 = up to date, 1 = needs update, 2 = not a project
check_project_needs_update() {
    local project_dir="${1:-.}"
    local todo_file="$project_dir/.cleo/todo.json"
    local claude_md="$project_dir/CLAUDE.md"

    # Not a cleo project
    [[ ! -f "$todo_file" ]] && return 2

    local needs_update=0

    # Check schema version (fast jq check)
    if command -v jq &>/dev/null; then
        local current_version
        current_version=$(jq -r '._meta.schemaVersion' "$todo_file" 2>/dev/null)

        # Explicit error if missing ._meta.schemaVersion
        if [[ -z "$current_version" || "$current_version" == "null" ]]; then
            _VERSION_WARNINGS+=("Missing ._meta.schemaVersion. Run: cleo upgrade")
            needs_update=1
            return 1
        fi

        # Check for legacy structure indicators
        local has_top_level_phases
        has_top_level_phases=$(jq -r 'has("phases")' "$todo_file" 2>/dev/null)

        local project_type
        project_type=$(jq -r '.project | type' "$todo_file" 2>/dev/null)

        # Legacy indicators
        if [[ "$has_top_level_phases" == "true" ]] || [[ "$project_type" == "string" ]]; then
            _VERSION_WARNINGS+=("Schema has legacy structure. Run: cleo upgrade")
            needs_update=1
        else
            # Get expected version from schema file (no fallback)
            local expected_version
            if expected_version=$(jq -r '.schemaVersion // empty' "${SCHEMA_DIR:-${CLEO_HOME:-$HOME/.cleo}/schemas}/todo.schema.json" 2>/dev/null) && [[ -n "$expected_version" ]]; then
                if [[ "$current_version" != "$expected_version" ]]; then
                    _VERSION_WARNINGS+=("Schema outdated ($current_version → $expected_version). Run: cleo upgrade")
                    needs_update=1
                fi
            fi
        fi
    fi

    # Check CLAUDE.md injection version
    if [[ -f "$claude_md" ]]; then
        local injection_version
        injection_version=$(grep -oP 'CLEO:START v\K[0-9.]+' "$claude_md" 2>/dev/null || echo "")

        local installed_version
        installed_version=$(head -n 1 "${CLEO_HOME:-$HOME/.cleo}/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "unknown")

        if [[ -n "$injection_version" ]] && [[ "$injection_version" != "$installed_version" ]]; then
            _VERSION_WARNINGS+=("CLAUDE.md outdated ($injection_version → $installed_version). Run: cleo upgrade")
            needs_update=1
        fi
    fi

    return $needs_update
}

# ============================================================================
# WARNING DISPLAY
# ============================================================================

# Show version warnings if any (call before command execution)
# Args: $1 = command being run
show_version_warnings() {
    local cmd="${1:-}"

    # Skip for commands that handle their own checks
    if [[ "$cmd" =~ ^($VERSION_CHECK_SKIP_COMMANDS)$ ]]; then
        return 0
    fi

    # Skip if already checked this process
    [[ -n "$_VERSION_CHECK_DONE" ]] && return 0
    _VERSION_CHECK_DONE=1

    # Skip if CLEO_SKIP_VERSION_CHECK is set
    [[ -n "${CLEO_SKIP_VERSION_CHECK:-}" ]] && return 0

    # Run check
    check_project_needs_update "." || true

    # Display warnings to stderr (so they don't interfere with JSON output)
    if [[ ${#_VERSION_WARNINGS[@]} -gt 0 ]]; then
        for warning in "${_VERSION_WARNINGS[@]}"; do
            echo "[WARN] $warning" >&2
        done
    fi
}

# ============================================================================
# EXPORTS
# ============================================================================
export -f check_project_needs_update
export -f show_version_warnings
