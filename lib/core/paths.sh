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
#   source "${LIB_DIR}/core/paths.sh"
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

# Check whether a path is absolute (POSIX, Windows drive, UNC)
# Args:
#   $1 - path to evaluate
# Returns: 0 if absolute, 1 otherwise
_is_absolute_path() {
    local path="$1"
    [[ "$path" == /* || "$path" =~ ^[A-Za-z]:[\\/].* || "$path" == \\\\* ]]
}

# Expand a leading tilde to $HOME
# Args:
#   $1 - path
# Returns: expanded path
_expand_tilde_path() {
    local path="$1"
    echo "${path/#\~/$HOME}"
}

# Get an absolute path to the project CLEO directory
# Args:
#   $1 - optional cleo directory override
# Returns: absolute path to CLEO project directory
get_cleo_dir_absolute() {
    local cleo_dir="${1:-$(get_cleo_dir)}"
    cleo_dir=$(_expand_tilde_path "$cleo_dir")

    if _is_absolute_path "$cleo_dir"; then
        echo "${cleo_dir%/}"
        return 0
    fi

    if [[ "$cleo_dir" == ./* ]]; then
        cleo_dir="${cleo_dir#./}"
    fi

    echo "$(pwd -P)/${cleo_dir}"
}

# Resolve project root from CLEO project directory
# Args:
#   $1 - optional cleo directory override
# Returns: absolute path to project root
get_cleo_project_root() {
    local input_cleo_dir="${1:-$(get_cleo_dir)}"
    local cleo_dir_abs
    cleo_dir_abs=$(get_cleo_dir_absolute "$input_cleo_dir")

    if [[ "$cleo_dir_abs" == */.cleo ]]; then
        dirname "$cleo_dir_abs"
        return 0
    fi

    if _is_absolute_path "$input_cleo_dir"; then
        dirname "$cleo_dir_abs"
    else
        pwd -P
    fi
}

# Resolve a project-relative path against CLEO project root
# Args:
#   $1 - path (absolute or project-relative)
#   $2 - optional cleo directory override
# Returns: absolute path
resolve_cleo_project_path() {
    local target_path="$1"
    local cleo_dir="${2:-$(get_cleo_dir)}"

    target_path=$(_expand_tilde_path "$target_path")
    if _is_absolute_path "$target_path"; then
        echo "$target_path"
        return 0
    fi

    if [[ "$target_path" == ./* ]]; then
        target_path="${target_path#./}"
    fi

    local project_root
    project_root=$(get_cleo_project_root "$cleo_dir")
    echo "${project_root}/${target_path}"
}

# Resolve context states directory from config/defaults
# Args:
#   $1 - optional cleo directory override
#   $2 - optional contextStates.directory override
# Returns: absolute context states directory path
get_context_states_directory() {
    local cleo_dir="${1:-$(get_cleo_dir)}"
    local context_dir="${2:-}"

    if [[ -z "$context_dir" ]]; then
        if declare -f get_config_value >/dev/null 2>&1; then
            context_dir=$(get_config_value "contextStates.directory" ".cleo/context-states")
        else
            context_dir=".cleo/context-states"
        fi
    fi

    resolve_cleo_project_path "$context_dir" "$cleo_dir"
}

# Build full context state file path for a session
# Args:
#   $1 - session ID (optional; empty -> singleton path)
#   $2 - optional cleo directory override
#   $3 - optional filename pattern override
#   $4 - optional contextStates.directory override
# Returns: absolute context state file path
get_context_state_file_path() {
    local session_id="${1:-}"
    local cleo_dir="${2:-$(get_cleo_dir)}"
    local filename_pattern="${3:-}"
    local context_dir_override="${4:-}"

    if [[ -z "$filename_pattern" ]]; then
        if declare -f get_config_value >/dev/null 2>&1; then
            filename_pattern=$(get_config_value "contextStates.filenamePattern" "context-state-{sessionId}.json")
        else
            filename_pattern="context-state-{sessionId}.json"
        fi
    fi

    if [[ -n "$session_id" ]]; then
        local context_states_dir filename
        context_states_dir=$(get_context_states_directory "$cleo_dir" "$context_dir_override")
        filename="${filename_pattern//\{sessionId\}/$session_id}"
        echo "${context_states_dir}/${filename}"
    else
        echo "$(get_cleo_dir_absolute "$cleo_dir")/.context-state.json"
    fi
}

# Repair legacy nested context state directory (.cleo/.cleo/context-states)
# Args:
#   $1 - optional cleo directory override
# Returns: 0 always (best-effort, silent)
repair_errant_context_state_paths() {
    local cleo_dir="${1:-$(get_cleo_dir)}"
    local cleo_dir_abs
    cleo_dir_abs=$(get_cleo_dir_absolute "$cleo_dir")

    local nested_dir="${cleo_dir_abs}/.cleo/context-states"
    local canonical_dir
    canonical_dir=$(get_context_states_directory "$cleo_dir")

    if [[ "$nested_dir" == "$canonical_dir" ]]; then
        return 0
    fi

    if [[ -d "$nested_dir" ]]; then
        mkdir -p "$canonical_dir" 2>/dev/null || true

        local state_file
        shopt -s nullglob
        for state_file in "$nested_dir"/context-state-*.json; do
            [[ -f "$state_file" ]] || continue
            local target_file="${canonical_dir}/$(basename "$state_file")"

            if [[ ! -f "$target_file" ]] || [[ "$state_file" -nt "$target_file" ]]; then
                mv -f "$state_file" "$target_file" 2>/dev/null || {
                    cp "$state_file" "$target_file" 2>/dev/null && rm -f "$state_file" 2>/dev/null || true
                }
            fi
        done
        shopt -u nullglob

        rmdir "$nested_dir" 2>/dev/null || true
        rmdir "${cleo_dir_abs}/.cleo" 2>/dev/null || true
    fi

    # Migrate legacy flat per-session files in .cleo root
    local legacy_file
    shopt -s nullglob
    for legacy_file in "$cleo_dir_abs"/.context-state-*.json; do
        [[ -f "$legacy_file" ]] || continue

        local legacy_name session_id target_file
        legacy_name=$(basename "$legacy_file")
        session_id=$(echo "$legacy_name" | sed -n 's/^\.context-state-\(.*\)\.json$/\1/p')
        [[ -n "$session_id" ]] || continue

        target_file=$(get_context_state_file_path "$session_id" "$cleo_dir")
        mkdir -p "$(dirname "$target_file")" 2>/dev/null || true

        if [[ ! -f "$target_file" ]] || [[ "$legacy_file" -nt "$target_file" ]]; then
            mv -f "$legacy_file" "$target_file" 2>/dev/null || {
                cp "$legacy_file" "$target_file" 2>/dev/null && rm -f "$legacy_file" 2>/dev/null || true
            }
        fi
    done
    shopt -u nullglob

    return 0
}

# Get the project todo.json file path
# Returns: Path to todo.json
get_todo_file() {
    echo "$(get_cleo_dir)/todo.json"
}

# Get the project config.json file path
# Returns: Path to config.json
get_config_file() {
    echo "$(get_cleo_dir)/config.json"
}

# Get the project todo-log.json file path
# Returns: Path to todo-log.json
get_log_file() {
    echo "$(get_cleo_dir)/todo-log.json"
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

# Check if legacy cleo installation exists
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
# MIGRATION WARNING SYSTEM
# =============================================================================

# Environment variable to track if warning was already shown this session
# This prevents spamming warnings on every command
_CLEO_MIGRATION_WARNING_SHOWN="${_CLEO_MIGRATION_WARNING_SHOWN:-}"

# Emit migration warning (once per session)
# Args:
#   $1 - warning type: "global" | "project" | "env"
#   $2 - optional: specific item (e.g., variable name)
# Outputs: Warning to stderr (only first call per session)
emit_migration_warning() {
    local warning_type="${1:-general}"
    local specific_item="${2:-}"

    # Skip if warning already shown this session
    if [[ -n "$_CLEO_MIGRATION_WARNING_SHOWN" ]]; then
        return 0
    fi

    # Mark warning as shown for this session
    export _CLEO_MIGRATION_WARNING_SHOWN=1

    # Build warning message based on type
    case "$warning_type" in
        global)
            echo "[MIGRATION] Legacy global installation detected: ~/.claude-todo" >&2
            echo "            This will not be used. CLEO uses: ~/.cleo" >&2
            ;;
        project)
            echo "[MIGRATION] Legacy project directory detected: .claude/" >&2
            echo "            This will not be used. CLEO uses: .cleo/" >&2
            ;;
        env)
            echo "[MIGRATION] Legacy environment variable detected: ${specific_item}" >&2
            echo "            This will be ignored. CLEO uses: CLEO_* variables" >&2
            ;;
        *)
            echo "[MIGRATION] Legacy cleo installation detected." >&2
            ;;
    esac

    # Always show migration command
    echo "" >&2
    echo "            Run 'cleo claude-migrate' to migrate your data." >&2
    echo "            See 'cleo claude-migrate --help' for options." >&2
    echo "" >&2
}

# Check for legacy env vars and warn (call at script startup)
# This warns about CLAUDE_TODO_* variables that are set but ignored
check_legacy_env_vars() {
    if [[ -n "${CLAUDE_TODO_HOME:-}" ]]; then
        emit_migration_warning "env" "CLAUDE_TODO_HOME"
    elif [[ -n "${CLAUDE_TODO_DIR:-}" ]]; then
        emit_migration_warning "env" "CLAUDE_TODO_DIR"
    elif [[ -n "${CLAUDE_TODO_FORMAT:-}" ]]; then
        emit_migration_warning "env" "CLAUDE_TODO_FORMAT"
    elif [[ -n "${CLAUDE_TODO_DEBUG:-}" ]]; then
        emit_migration_warning "env" "CLAUDE_TODO_DEBUG"
    fi
}

# Print migration warning if legacy installation detected
# Outputs warning to stderr (once per session)
warn_if_legacy() {
    # Check for legacy environment variables first
    check_legacy_env_vars

    # Check for legacy installations if no env var warning shown
    if [[ -z "$_CLEO_MIGRATION_WARNING_SHOWN" ]]; then
        if has_legacy_global_installation; then
            emit_migration_warning "global"
        elif has_legacy_project_dir; then
            emit_migration_warning "project"
        fi
    fi
}

# Suppress migration warnings (for testing or automated scripts)
# Call this before operations that should be silent
suppress_migration_warnings() {
    export _CLEO_MIGRATION_WARNING_SHOWN=1
}

# Reset migration warning state (primarily for testing)
reset_migration_warnings() {
    unset _CLEO_MIGRATION_WARNING_SHOWN
}
