#!/usr/bin/env bash
# context-alert.sh - Context window threshold crossing alerts
#
# LAYER: 2 (Command Infrastructure)
# DEPENDENCIES: lib/output-format.sh, lib/config.sh
# PROVIDES: check_context_alert, format_alert_box, should_alert, update_alert_state

#=== SOURCE GUARD ================================================
[[ -n "${_CONTEXT_ALERT_LOADED:-}" ]] && return 0
declare -r _CONTEXT_ALERT_LOADED=1

# ============================================================================
# DEPENDENCIES
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/output-format.sh"
# Source config library for get_config_value (unified config access)
if [[ -f "${SCRIPT_DIR}/config.sh" ]]; then
    source "${SCRIPT_DIR}/config.sh"
fi

# ============================================================================
# CONFIGURATION
# ============================================================================

# Alert state file
ALERT_STATE_FILE="${CLEO_PROJECT_DIR:-.cleo}/.context-alert-state.json"

# Config file (preserve existing value if set, for test environments)
CONFIG_FILE="${CONFIG_FILE:-${CLEO_PROJECT_DIR:-.cleo}/config.json}"

# Thresholds (percentage of context window)
# Note: Using export + readonly for subshell access (BATS run, etc.)
export THRESHOLD_WARNING=70
export THRESHOLD_CAUTION=85
export THRESHOLD_CRITICAL=90
export THRESHOLD_EMERGENCY=95
readonly THRESHOLD_WARNING THRESHOLD_CAUTION THRESHOLD_CRITICAL THRESHOLD_EMERGENCY

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# Note: get_config_value is provided by config.sh (sourced above)
# It handles complex config paths, arrays, and defaults properly.

# get_current_session_id - Get the current active session ID
#
# Returns: Session ID or empty string if no active session
get_current_session_id() {
    local session_file="${CLEO_PROJECT_DIR:-.cleo}/.current-session"
    if [[ -f "$session_file" ]]; then
        cat "$session_file" 2>/dev/null | tr -d '\n'
    else
        echo ""
    fi
}

# get_context_state_path - Get the context state file path for a session
#
# Args:
#   $1 - Session ID (optional, defaults to current session)
#
# Returns: Path to the context state file (may not exist)
get_context_state_path() {
    local session_id="${1:-$(get_current_session_id)}"
    local cleo_dir="${CLEO_PROJECT_DIR:-.cleo}"
    local project_root="${cleo_dir%/.cleo}"

    # Get config values with defaults
    local context_dir filename_pattern
    context_dir=$(get_config_value "contextStates.directory" ".cleo/context-states")
    filename_pattern=$(get_config_value "contextStates.filenamePattern" "context-state-{sessionId}.json")

    local full_dir="${project_root}/${context_dir}"

    if [[ -n "$session_id" ]]; then
        # Replace {sessionId} placeholder with actual session ID
        local filename="${filename_pattern//\{sessionId\}/$session_id}"
        echo "${full_dir}/${filename}"
    else
        # Fallback to singleton in .cleo directory (legacy behavior)
        echo "${cleo_dir}/.context-state.json"
    fi
}

# read_context_state - Read the current context state file
#
# Args:
#   $1 - Session ID (optional, defaults to current session)
#
# Returns: 0 if state file exists and is valid, 1 otherwise
# Outputs: JSON content to stdout
read_context_state() {
    local session_id="${1:-$(get_current_session_id)}"
    local cleo_dir="${CLEO_PROJECT_DIR:-.cleo}"

    # Get the state file path from config-based location
    local state_file
    state_file=$(get_context_state_path "$session_id")

    # Fallback: check legacy locations if new location doesn't exist
    if [[ ! -f "$state_file" ]]; then
        # Try legacy flat file pattern (.cleo/.context-state-{sessionId}.json)
        if [[ -n "$session_id" ]]; then
            local legacy_file="${cleo_dir}/.context-state-${session_id}.json"
            if [[ -f "$legacy_file" ]]; then
                state_file="$legacy_file"
            fi
        fi
    fi

    # Try singleton fallback
    if [[ ! -f "$state_file" ]]; then
        state_file="${cleo_dir}/.context-state.json"
    fi

    if [[ ! -f "$state_file" ]]; then
        return 1
    fi

    # Check if file is stale (default 5 seconds)
    local timestamp stale_after_ms
    timestamp=$(jq -r '.timestamp // ""' "$state_file" 2>/dev/null)
    stale_after_ms=$(jq -r '.staleAfterMs // 5000' "$state_file" 2>/dev/null)

    if [[ -n "$timestamp" ]]; then
        local now_epoch file_epoch age_ms
        now_epoch=$(date +%s)
        file_epoch=$(date -d "$timestamp" +%s 2>/dev/null || echo "0")
        age_ms=$(( (now_epoch - file_epoch) * 1000 ))

        if [[ "$age_ms" -gt "$stale_after_ms" ]]; then
            return 1
        fi
    fi

    cat "$state_file" 2>/dev/null
}

# read_alert_state - Read the last alerted state
#
# Returns: 0 if state file exists, 1 otherwise
# Outputs: JSON content to stdout
read_alert_state() {
    if [[ ! -f "$ALERT_STATE_FILE" ]]; then
        echo '{}'
        return 1
    fi

    cat "$ALERT_STATE_FILE" 2>/dev/null || echo '{}'
}

# ============================================================================
# THRESHOLD DETECTION
# ============================================================================

# should_alert - Determine if we should alert based on threshold crossing
#
# Args:
#   $1 - Current percentage (integer)
#   $2 - Last alerted percentage (integer, default: 0)
#
# Returns: 0 if should alert, 1 if not
# Outputs: Threshold level (warning|caution|critical|emergency) to stdout
should_alert() {
    local current_pct="${1:-0}"
    local last_alerted_pct="${2:-0}"

    # Get minimum threshold from config
    local min_threshold
    min_threshold=$(get_config_value "contextAlerts.minThreshold" "warning")

    # Determine current threshold level
    local current_level=""
    if [[ "$current_pct" -ge "$THRESHOLD_EMERGENCY" ]]; then
        current_level="emergency"
    elif [[ "$current_pct" -ge "$THRESHOLD_CRITICAL" ]]; then
        current_level="critical"
    elif [[ "$current_pct" -ge "$THRESHOLD_CAUTION" ]]; then
        current_level="caution"
    elif [[ "$current_pct" -ge "$THRESHOLD_WARNING" ]]; then
        current_level="warning"
    else
        echo ""
        return 1
    fi

    # Check if current level meets minimum threshold
    local level_order=("warning" "caution" "critical" "emergency")
    local min_level_idx=0
    local current_level_idx=0

    for i in "${!level_order[@]}"; do
        [[ "${level_order[$i]}" == "$min_threshold" ]] && min_level_idx=$i
        [[ "${level_order[$i]}" == "$current_level" ]] && current_level_idx=$i
    done

    if [[ "$current_level_idx" -lt "$min_level_idx" ]]; then
        echo ""
        return 1
    fi

    # Determine last alerted threshold level
    local last_level=""
    if [[ "$last_alerted_pct" -ge "$THRESHOLD_EMERGENCY" ]]; then
        last_level="emergency"
    elif [[ "$last_alerted_pct" -ge "$THRESHOLD_CRITICAL" ]]; then
        last_level="critical"
    elif [[ "$last_alerted_pct" -ge "$THRESHOLD_CAUTION" ]]; then
        last_level="caution"
    elif [[ "$last_alerted_pct" -ge "$THRESHOLD_WARNING" ]]; then
        last_level="warning"
    else
        last_level="ok"
    fi

    # Alert if we've crossed to a new threshold level
    if [[ "$current_level" != "$last_level" ]]; then
        echo "$current_level"
        return 0
    fi

    echo ""
    return 1
}

# update_alert_state - Update the last alerted state
#
# Args:
#   $1 - Current percentage (integer)
#   $2 - Threshold level (warning|caution|critical|emergency)
#
# Returns: 0 on success, 1 on failure
update_alert_state() {
    local percentage="$1"
    local level="$2"

    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    jq -n \
        --argjson pct "$percentage" \
        --arg level "$level" \
        --arg ts "$timestamp" \
        '{
            "lastAlertedLevel": $pct,
            "thresholdLevel": $level,
            "lastAlertedAt": $ts
        }' > "$ALERT_STATE_FILE" 2>/dev/null
}

# ============================================================================
# VISUAL FORMATTING
# ============================================================================

# format_alert_box - Create visual FACE UP alert box
#
# Args:
#   $1 - Percentage (integer)
#   $2 - Threshold level (warning|caution|critical|emergency)
#   $3 - Current tokens (integer)
#   $4 - Max tokens (integer)
#
# Returns: Formatted alert box to stderr
format_alert_box() {
    local percentage="$1"
    local level="$2"
    local current_tokens="$3"
    local max_tokens="$4"

    # Determine emoji and message based on level
    local emoji message color_code
    case "$level" in
        emergency)
            emoji="🚨"
            message="EMERGENCY: Context window almost full!"
            color_code="91"  # Bright red
            ;;
        critical)
            emoji="🔴"
            message="CRITICAL: Context window at ${percentage}%"
            color_code="31"  # Red
            ;;
        caution)
            emoji="🟠"
            message="CAUTION: Context window at ${percentage}%"
            color_code="33"  # Yellow
            ;;
        warning)
            emoji="🟡"
            message="WARNING: Context window at ${percentage}%"
            color_code="93"  # Bright yellow
            ;;
        *)
            emoji="ℹ️"
            message="Context window: ${percentage}%"
            color_code="36"  # Cyan
            ;;
    esac

    # Get recommended action
    local action=""
    if [[ "$percentage" -ge "$THRESHOLD_EMERGENCY" ]]; then
        action="IMMEDIATE: ct session end --note \"...\""
    elif [[ "$percentage" -ge "$THRESHOLD_CRITICAL" ]]; then
        action="Recommended: ct session end --note \"...\""
    elif [[ "$percentage" -ge "$THRESHOLD_CAUTION" ]]; then
        action="Consider: ct archive; ct session suspend"
    elif [[ "$percentage" -ge "$THRESHOLD_WARNING" ]]; then
        action="Monitor: Consider session cleanup soon"
    fi

    # Detect terminal capabilities
    local use_unicode use_color is_tty
    detect_unicode_support && use_unicode="true" || use_unicode="false"
    detect_color_support && use_color="true" || use_color="false"
    [[ -t 2 ]] && is_tty="true" || is_tty="false"

    # Get box characters
    local TL TR BL BR H V
    if [[ "$use_unicode" == "true" ]]; then
        TL="╔"
        TR="╗"
        BL="╚"
        BR="╝"
        H="═"
        V="║"
    else
        TL="+"
        TR="+"
        BL="+"
        BR="+"
        H="="
        V="|"
    fi

    # Calculate box width (message is longest line)
    local max_line_len=50
    local message_len=${#message}
    [[ "$message_len" -gt "$max_line_len" ]] && max_line_len=$message_len

    local box_width=$((max_line_len + 6))  # Padding
    local hline=""
    for ((i=0; i<box_width-2; i++)); do
        hline="${hline}${H}"
    done

    # Build alert box
    local output=""

    # Top border
    output+="${TL}${hline}${TR}\n"

    # Message line
    local msg_padding=$((box_width - 4 - message_len - 2))  # -2 for emoji
    output+="${V} ${emoji}  ${message}$(printf '%*s' "$msg_padding" '')${V}\n"

    # Usage line
    local usage_text="Usage: ${current_tokens}/${max_tokens} tokens"
    local usage_len=${#usage_text}
    local usage_padding=$((box_width - 4 - usage_len))
    output+="${V}   ${usage_text}$(printf '%*s' "$usage_padding" '')${V}\n"

    # Action line (if present)
    if [[ -n "$action" ]]; then
        local action_len=${#action}
        local action_padding=$((box_width - 4 - action_len))
        output+="${V}   ${action}$(printf '%*s' "$action_padding" '')${V}\n"
    fi

    # Bottom border
    output+="${BL}${hline}${BR}\n"

    # Output to stderr with color if supported
    if [[ "$use_color" == "true" && "$is_tty" == "true" ]]; then
        echo -e "\033[${color_code}m${output}\033[0m" >&2
    else
        echo -e "${output}" >&2
    fi
}

# ============================================================================
# MAIN ALERT CHECK
# ============================================================================

# check_context_alert - Main function to check and emit alerts
#
# Args:
#   $1 - Current command name (optional, for trigger filtering)
#
# Call this from commands that want context monitoring.
# Only alerts on threshold crossings, not every call.
#
# Returns: 0 always (non-blocking)
check_context_alert() {
    local current_command="${1:-}"

    # Check if context alerts are enabled
    local alerts_enabled
    alerts_enabled=$(get_config_value "contextAlerts.enabled" "true")
    if [[ "$alerts_enabled" != "true" ]]; then
        return 0
    fi

    # Check if current command is in trigger list (if command provided)
    if [[ -n "$current_command" ]]; then
        local trigger_commands
        trigger_commands=$(get_config_value "contextAlerts.triggerCommands" "[]")

        # Empty array means all commands trigger
        if [[ "$trigger_commands" != "[]" ]]; then
            # Check if current command is in the array
            local is_trigger
            is_trigger=$(echo "$trigger_commands" | jq -r --arg cmd "$current_command" 'any(. == $cmd)')
            if [[ "$is_trigger" != "true" ]]; then
                return 0
            fi
        fi
    fi

    # Check if session is active
    local session_id
    session_id=$(get_current_session_id)
    if [[ -z "$session_id" ]]; then
        # No active session, skip alert
        return 0
    fi

    # Read current context state
    local context_state
    context_state=$(read_context_state "$session_id")
    if [[ $? -ne 0 || -z "$context_state" ]]; then
        # No valid context state, skip alert
        return 0
    fi

    # Extract values
    local current_pct current_tokens max_tokens
    current_pct=$(echo "$context_state" | jq -r '.contextWindow.percentage // 0')
    current_tokens=$(echo "$context_state" | jq -r '.contextWindow.currentTokens // 0')
    max_tokens=$(echo "$context_state" | jq -r '.contextWindow.maxTokens // 200000')

    # Read last alerted state
    local alert_state last_alerted_pct
    alert_state=$(read_alert_state)
    last_alerted_pct=$(echo "$alert_state" | jq -r '.lastAlertedLevel // 0')

    # Check suppressDuration
    local suppress_duration
    suppress_duration=$(get_config_value "contextAlerts.suppressDuration" "0")
    if [[ "$suppress_duration" -gt 0 ]]; then
        local last_alerted_at
        last_alerted_at=$(echo "$alert_state" | jq -r '.lastAlertedAt // ""')
        if [[ -n "$last_alerted_at" ]]; then
            local now_epoch last_epoch age_seconds
            now_epoch=$(date +%s)
            last_epoch=$(date -d "$last_alerted_at" +%s 2>/dev/null || echo "0")
            age_seconds=$((now_epoch - last_epoch))

            if [[ "$age_seconds" -lt "$suppress_duration" ]]; then
                # Still within suppress window, skip alert
                return 0
            fi
        fi
    fi

    # Check if we should alert
    local threshold_level
    threshold_level=$(should_alert "$current_pct" "$last_alerted_pct")
    if [[ $? -eq 0 && -n "$threshold_level" ]]; then
        # Alert!
        format_alert_box "$current_pct" "$threshold_level" "$current_tokens" "$max_tokens"

        # Update alert state
        update_alert_state "$current_pct" "$threshold_level"
    fi

    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f get_config_value
export -f get_current_session_id
export -f get_context_state_path
export -f read_context_state
export -f read_alert_state
export -f should_alert
export -f update_alert_state
export -f format_alert_box
export -f check_context_alert
