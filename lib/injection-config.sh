#!/usr/bin/env bash
# lib/injection-config.sh - Injection configuration utilities (Layer 1)

[[ -n "${_INJECTION_CONFIG_LOADED:-}" ]] && return 0
readonly _INJECTION_CONFIG_LOADED=1

# Dependencies (Layer 0 only)
source "${CLEO_LIB_DIR:-$CLEO_HOME/lib}/injection-registry.sh"

# ==============================================================================
# REGISTRY QUERY FUNCTIONS
# ==============================================================================

# Check if a file is a valid injection target
# Returns: 0 if valid, 1 if not
injection_is_valid_target() {
    local file="$1"
    [[ " $INJECTION_TARGETS " == *" $file "* ]]
}

# Get list of injection targets as array
# Usage: injection_get_targets; for t in "${REPLY[@]}"; do ...; done
injection_get_targets() {
    # Use local IFS to ensure proper space-splitting
    # (backup.sh sets global IFS=$'\n\t' which breaks array splitting)
    local IFS=' '
    REPLY=($INJECTION_TARGETS)
}

# Get header template path for a target file (if any)
# Returns: path or empty string
injection_get_header_path() {
    local target="$1"
    local header="${INJECTION_HEADERS[$target]:-}"
    if [[ -n "$header" ]]; then
        echo "${CLEO_HOME}/${INJECTION_TEMPLATE_DIR}/${header}"
    fi
}

# Get main template path
injection_get_template_path() {
    echo "${CLEO_HOME}/${INJECTION_TEMPLATE_MAIN}"
}

# Get validation key for JSON output
injection_get_validation_key() {
    local target="$1"
    echo "${INJECTION_VALIDATION_KEYS[$target]:-}"
}

# Check if file has injection block (any version)
injection_has_block() {
    local file="$1"
    grep -q "${INJECTION_MARKER_START}" "$file" 2>/dev/null
}
