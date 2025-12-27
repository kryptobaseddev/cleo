#!/usr/bin/env bash
# paths.sh - CLEO path resolution (TRUE CLEAN BREAK)
#
# This library provides centralized path resolution for CLEO.
# NO LEGACY FALLBACK: Only CLEO_* environment variables are used.
# Legacy detection is provided ONLY for migration warnings.
#
# Environment Variables:
#   CLEO_HOME   - Global installation directory (default: ~/.cleo)
#   CLEO_DIR    - Project data directory (default: .cleo)
#   CLEO_FORMAT - Default output format (text|json|jsonl|markdown|table)
#   CLEO_DEBUG  - Enable debug mode (true|false|1|0)
#
# Usage:
#   source "${LIB_DIR}/paths.sh"
#   global_home=$(get_cleo_home)
#   project_dir=$(get_cleo_dir)
#
# Version: 1.0.0 (CLEO v1.0.0)
# =============================================================================

# Prevent multiple sourcing
[[ -n "${_PATHS_SH_LOADED:-}" ]] && return 0
readonly _PATHS_SH_LOADED=1

# =============================================================================
# GLOBAL PATH RESOLUTION
# =============================================================================

# Get the global CLEO home directory
# Returns: Path to global installation (default: ~/.cleo)
get_cleo_home() {
    echo "${CLEO_HOME:-$HOME/.cleo}"
}

# Get the global CLEO templates directory
# Returns: Path to templates directory
get_cleo_templates_dir() {
    echo "$(get_cleo_home)/templates"
}

# Get the global CLEO schemas directory
# Returns: Path to schemas directory
get_cleo_schemas_dir() {
    echo "$(get_cleo_home)/schemas"
}

# Get the global CLEO docs directory
# Returns: Path to docs directory
get_cleo_docs_dir() {
    echo "$(get_cleo_home)/docs"
}

# Get the global CLEO migrations directory
# Returns: Path to migrations directory
get_cleo_migrations_dir() {
    echo "$(get_cleo_home)/migrations"
}

# =============================================================================
# PROJECT PATH RESOLUTION
# =============================================================================

# Get the project CLEO data directory
# Returns: Path to project data directory (default: .cleo)
get_cleo_dir() {
    echo "${CLEO_DIR:-.cleo}"
}

# Get the project todo.json file path
# Returns: Path to todo.json
get_todo_file() {
    echo "$(get_cleo_dir)/todo.json"
}

# Get the project todo-config.json file path
# Returns: Path to cleo-config.json
get_config_file() {
    echo "$(get_cleo_dir)/cleo-config.json"
}

# Get the project todo-log.json file path
# Returns: Path to cleo-log.json
get_log_file() {
    echo "$(get_cleo_dir)/cleo-log.json"
}

# Get the project todo-archive.json file path
# Returns: Path to todo-archive.json
get_archive_file() {
    echo "$(get_cleo_dir)/todo-archive.json"
}

# Get the project backups directory
# Returns: Path to backups directory
get_backups_dir() {
    echo "$(get_cleo_dir)/backups"
}

# Get the project cache directory
# Returns: Path to cache directory
get_cache_dir() {
    echo "$(get_cleo_dir)/.cache"
}

# =============================================================================
# ENVIRONMENT VARIABLE RESOLUTION
# =============================================================================

# Get the configured output format
# Returns: Format string or empty if not set
get_cleo_format() {
    echo "${CLEO_FORMAT:-}"
}

# Check if debug mode is enabled
# Returns: 0 if debug enabled, 1 otherwise
is_cleo_debug() {
    local debug="${CLEO_DEBUG:-}"
    case "$debug" in
        true|1|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}

# Get debug mode as string
# Returns: "true" or "false"
get_cleo_debug() {
    if is_cleo_debug; then
        echo "true"
    else
        echo "false"
    fi
}

# =============================================================================
# VERSION RESOLUTION
# =============================================================================

# Get the CLEO version from VERSION file
# Returns: Version string or "0.0.0" if not found
get_cleo_version() {
    local version_file="$(get_cleo_home)/VERSION"
    if [[ -f "$version_file" ]]; then
        tr -d '[:space:]' < "$version_file"
    else
        echo "0.0.0"
    fi
}

# =============================================================================
# LEGACY DETECTION (FOR MIGRATION ONLY)
# =============================================================================

# Check if legacy claude-todo installation exists
# Returns: 0 if legacy found, 1 otherwise
# Note: This is ONLY for migration warnings, NOT for fallback
has_legacy_global_installation() {
    [[ -d "$HOME/.claude-todo" ]]
}

# Check if legacy project directory exists
# Returns: 0 if legacy found, 1 otherwise
# Note: This is ONLY for migration warnings, NOT for fallback
has_legacy_project_dir() {
    [[ -d ".claude" ]]
}

# Check if any legacy installation exists
# Returns: 0 if any legacy found, 1 otherwise
has_legacy_installation() {
    has_legacy_global_installation || has_legacy_project_dir
}

# Get legacy global home path (for migration)
# Returns: Path to legacy global installation
get_legacy_global_home() {
    echo "$HOME/.claude-todo"
}

# Get legacy project dir (for migration)
# Returns: Path to legacy project directory
get_legacy_project_dir() {
    echo ".claude"
}

# =============================================================================
# PATH VALIDATION
# =============================================================================

# Ensure the global CLEO home directory exists
# Returns: 0 on success, 1 on failure
ensure_cleo_home() {
    local home
    home=$(get_cleo_home)
    if [[ ! -d "$home" ]]; then
        mkdir -p "$home" || return 1
    fi
    return 0
}

# Ensure the project CLEO directory exists
# Returns: 0 on success, 1 on failure
ensure_cleo_dir() {
    local dir
    dir=$(get_cleo_dir)
    if [[ ! -d "$dir" ]]; then
        mkdir -p "$dir" || return 1
    fi
    return 0
}

# Check if project is initialized
# Returns: 0 if initialized, 1 otherwise
is_project_initialized() {
    local todo_file
    todo_file=$(get_todo_file)
    [[ -f "$todo_file" ]]
}

# =============================================================================
# MIGRATION WARNING HELPER
# =============================================================================

# Print migration warning if legacy installation detected
# Outputs warning to stderr
warn_if_legacy() {
    if has_legacy_installation; then
        echo "[WARNING] Legacy claude-todo installation detected." >&2
        echo "          Run 'cleo claude-migrate' to migrate to CLEO." >&2
        echo "" >&2
    fi
}
