#!/usr/bin/env bash
# docs-sync.sh - Documentation drift detection library
#
# LAYER: 3 (Shared Tools)
# DEPENDENCIES: platform-compat.sh, config.sh
# PROVIDES: detect_drift, check_commands_sync, check_wrapper_sync

#=== SOURCE GUARD ================================================
[[ -n "${_DOCS_SYNC_SH_LOADED:-}" ]] && return 0
declare -r _DOCS_SYNC_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source platform compatibility layer
if [[ -f "$_LIB_DIR/core/platform-compat.sh" ]]; then
    # shellcheck source=lib/core/platform-compat.sh
    source "$_LIB_DIR/core/platform-compat.sh"
else
    echo "ERROR: Cannot find platform-compat.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source config library
if [[ -f "$_LIB_DIR/core/config.sh" ]]; then
    # shellcheck source=lib/core/config.sh
    source "$_LIB_DIR/core/config.sh"
fi

# ============================================================================
# DRIFT DETECTION CORE FUNCTIONS
# ============================================================================

# Get commands from scripts directory
# Returns: sorted list of script basenames (without .sh)
get_script_commands() {
    local scripts_dir="${1:-scripts}"
    ls "$scripts_dir"/*.sh 2>/dev/null | xargs -n1 basename | sed 's/\.sh$//' | sort || true
}

# Get commands from COMMANDS-INDEX.json
# Args: $1 = path to COMMANDS-INDEX.json
# Returns: sorted list of command names
get_index_commands() {
    local index_file="${1:-docs/commands/COMMANDS-INDEX.json}"
    [[ -f "$index_file" ]] || return 1
    jq -r '.commands[].name' "$index_file" 2>/dev/null | sort || true
}

# Get script names from COMMANDS-INDEX.json (for matching with scripts/)
# Args: $1 = path to COMMANDS-INDEX.json
# Returns: sorted list of script basenames (without .sh)
get_index_scripts() {
    local index_file="${1:-docs/commands/COMMANDS-INDEX.json}"
    [[ -f "$index_file" ]] || return 1
    jq -r '.commands[].script // empty' "$index_file" 2>/dev/null | \
        sed 's/\.sh$//' | grep -v '^$' | sort || true
}

# Check commands index vs scripts
# Args: $1 = scripts dir, $2 = commands index file
# Returns: 0 if in sync, 1 if drift detected
check_commands_sync() {
    local scripts_dir="${1:-scripts}"
    local index_file="${2:-docs/commands/COMMANDS-INDEX.json}"
    local drift_detected=0

    local scripts_cmds index_scripts
    scripts_cmds=$(get_script_commands "$scripts_dir")
    index_scripts=$(get_index_scripts "$index_file")

    # Find scripts not in index
    local missing_from_index
    missing_from_index=$(comm -23 <(echo "$scripts_cmds") <(echo "$index_scripts"))

    if [[ -n "$missing_from_index" ]]; then
        drift_detected=1
        echo "DRIFT: Scripts NOT in COMMANDS-INDEX.json:" >&2
        while IFS= read -r script; do
            echo "  - ${script}.sh" >&2
        done <<< "$missing_from_index"
    fi

    # Find index entries without scripts
    local orphaned_index
    orphaned_index=$(comm -13 <(echo "$scripts_cmds") <(echo "$index_scripts"))

    if [[ -n "$orphaned_index" ]]; then
        drift_detected=1
        echo "DRIFT: Index entries WITHOUT scripts:" >&2
        while IFS= read -r script; do
            echo "  - ${script}.sh" >&2
        done <<< "$orphaned_index"
    fi

    return $drift_detected
}

# Check wrapper template sync with COMMANDS-INDEX
# Args: $1 = wrapper template path, $2 = commands index file
# Returns: 0 if in sync, 1 if drift detected
check_wrapper_sync() {
    local wrapper_template="${1:-installer/lib/link.sh}"
    local index_file="${2:-docs/commands/COMMANDS-INDEX.json}"
    local drift_detected=0

    [[ -f "$wrapper_template" ]] || return 0
    [[ -f "$index_file" ]] || return 1

    # Extract commands from wrapper template
    local wrapper_cmds
    wrapper_cmds=$(grep "_get_all_commands()" -A1 "$wrapper_template" 2>/dev/null | \
        tail -1 | tr -d '"' | tr ' ' '\n' | grep -v '^echo$' | grep -v '^$' | sort -u || true)

    # Get commands from index (excluding aliases and dev tools)
    local index_cmds
    index_cmds=$(jq -r '.commands[] | select(.aliasFor == null) | select(.note == null or (.note | test("Usually called via|Internal development|dev tool"; "i") | not)) | .name' "$index_file" 2>/dev/null | sort -u || true)

    # Find commands in index but not in wrapper
    local missing_from_wrapper
    missing_from_wrapper=$(comm -13 <(echo "$wrapper_cmds") <(echo "$index_cmds"))

    if [[ -n "$missing_from_wrapper" ]]; then
        drift_detected=1
        echo "DRIFT: Commands in COMMANDS-INDEX but NOT in wrapper:" >&2
        while IFS= read -r cmd; do
            [[ -z "$cmd" ]] && continue
            echo "  - $cmd" >&2
        done <<< "$missing_from_wrapper"
    fi

    return $drift_detected
}

# Run full drift detection
# Args: $1 = mode (quick|full), $2 = project root
# Returns: 0 if no drift, 1 if warnings, 2 if errors
detect_drift() {
    local mode="${1:-full}"
    local project_root="${2:-.}"
    local exit_code=0

    # Check commands sync (always)
    if ! check_commands_sync "$project_root/scripts" "$project_root/docs/commands/COMMANDS-INDEX.json"; then
        exit_code=2
    fi

    # Check wrapper sync (always)
    if ! check_wrapper_sync "$project_root/installer/lib/link.sh" "$project_root/docs/commands/COMMANDS-INDEX.json"; then
        exit_code=1
    fi

    # Full mode: check additional files
    if [[ "$mode" == "full" ]]; then
        # Check critical commands in README
        local readme="$project_root/README.md"
        if [[ -f "$readme" ]]; then
            local critical_cmds=("list" "add" "complete" "find" "show" "analyze" "session" "focus" "dash")
            local readme_cmds
            readme_cmds=$(grep -oE 'cleo [a-z-]+' "$readme" 2>/dev/null | sed 's/cleo //' | sort -u || true)

            for cmd in "${critical_cmds[@]}"; do
                if ! echo "$readme_cmds" | grep -q "^${cmd}$"; then
                    echo "DRIFT: Critical command '$cmd' missing from README" >&2
                    [[ $exit_code -lt 1 ]] && exit_code=1
                fi
            done
        fi
    fi

    return $exit_code
}

# Check if drift detection should run automatically
# Reads: documentation.driftDetection config
# Returns: 0 if should run, 1 if disabled
should_run_drift_detection() {
    local command="${1:-}"

    # Check if drift detection is enabled
    local enabled
    enabled=$(get_config_value "documentation.driftDetection.enabled" "true")
    [[ "$enabled" != "true" ]] && return 1

    # Check if auto-check is enabled
    local auto_check
    auto_check=$(get_config_value "documentation.driftDetection.autoCheck" "false")
    [[ "$auto_check" != "true" ]] && return 1

    # Check if command is in critical list
    if [[ -n "$command" ]]; then
        local critical_commands
        critical_commands=$(get_config_value "documentation.driftDetection.criticalCommands" "[]")

        # If list is empty, always run
        [[ "$critical_commands" == "[]" ]] && return 0

        # Check if command is in list
        echo "$critical_commands" | jq -e --arg cmd "$command" 'index($cmd) != null' >/dev/null 2>&1
        return $?
    fi

    return 0
}
