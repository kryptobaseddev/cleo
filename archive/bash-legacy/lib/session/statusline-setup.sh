#!/usr/bin/env bash
# CLEO Statusline Setup Helper
# Checks and installs Claude Code status line integration for context monitoring
#
# LAYER: 2 (Utilities)
# DEPENDENCIES: jq
# PROVIDES: check_statusline_integration, install_statusline_integration

#=== SOURCE GUARD ================================================
[[ -n "${_STATUSLINE_SETUP_SH_LOADED:-}" ]] && return 0
declare -r _STATUSLINE_SETUP_SH_LOADED=1

set -euo pipefail

CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
CLEO_STATUSLINE="$CLEO_HOME/lib/session/context-monitor.sh"

# Check if statusline integration is configured
# Returns:
#   0 = CLEO integration configured
#   1 = No statusline configured
#   2 = Custom statusline (no CLEO integration)
#   3 = settings.json doesn't exist
check_statusline_integration() {
    if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
        return 3
    fi

    local statusline_type
    local statusline_cmd

    statusline_type=$(jq -r '.statusLine.type // empty' "$CLAUDE_SETTINGS" 2>/dev/null)

    if [[ -z "$statusline_type" ]]; then
        return 1  # No statusline configured
    fi

    if [[ "$statusline_type" != "command" ]]; then
        return 2  # Not a command type
    fi

    statusline_cmd=$(jq -r '.statusLine.command // empty' "$CLAUDE_SETTINGS" 2>/dev/null)

    # Check if it's the CLEO statusline or includes CLEO integration
    if [[ "$statusline_cmd" == *"context-monitor.sh"* ]] || \
       [[ "$statusline_cmd" == *"cleo-statusline"* ]] || \
       [[ "$statusline_cmd" == *".context-state.json"* ]] || \
       [[ "$statusline_cmd" == *"context-states"* ]]; then
        return 0  # CLEO integration configured
    fi

    # Check if existing script writes to CLEO state file
    local script_path="${statusline_cmd/#\~/$HOME}"
    if [[ -f "$script_path" ]] && grep -q "context-state.json" "$script_path" 2>/dev/null; then
        return 0  # Custom script with CLEO integration
    fi

    return 2  # Custom statusline without CLEO integration
}

# Get human-readable status
get_statusline_status() {
    check_statusline_integration
    local status=$?

    case $status in
        0) echo "configured" ;;
        1) echo "not_configured" ;;
        2) echo "custom_no_cleo" ;;
        3) echo "no_settings" ;;
    esac
}

# Install or update statusline integration
# Args: $1 = mode (install|update|check)
#       $2 = interactive (true|false, default true)
install_statusline_integration() {
    local mode="${1:-check}"
    local interactive="${2:-true}"

    # Capture return value without triggering set -e exit
    local status
    check_statusline_integration && status=0 || status=$?

    case $status in
        0)
            echo "✓ CLEO context monitoring already configured"
            return 0
            ;;
        1)
            # No statusline - install CLEO's
            if [[ "$mode" == "check" ]]; then
                echo "⚠ No status line configured"
                echo "  Run: cleo upgrade --setup-statusline"
                return 1
            fi

            if [[ "$interactive" == "true" ]]; then
                echo "No status line configured. Install CLEO context monitoring?"
                read -p "[Y/n] " -n 1 -r
                echo
                if [[ ! $REPLY =~ ^[Yy]?$ ]]; then
                    echo "Skipped statusline setup"
                    return 0
                fi
            fi

            _install_cleo_statusline
            ;;
        2)
            # Custom statusline exists
            if [[ "$mode" == "check" ]]; then
                echo "⚠ Custom status line found without CLEO integration"
                echo "  Run: cleo upgrade --setup-statusline"
                return 1
            fi

            local current_cmd
            current_cmd=$(jq -r '.statusLine.command // empty' "$CLAUDE_SETTINGS" 2>/dev/null)
            local script_path="${current_cmd/#\~/$HOME}"

            if [[ "$interactive" == "true" ]]; then
                echo "Custom status line found: $current_cmd"
                echo ""
                echo "Options:"
                echo "  1) Add CLEO state file write to your existing script"
                echo "  2) Replace with CLEO statusline (loses custom formatting)"
                echo "  3) Skip (cleo context check won't work)"
                read -p "Choice [1/2/3]: " -n 1 -r choice
                echo

                case $choice in
                    1) _patch_existing_statusline "$script_path" ;;
                    2) _install_cleo_statusline ;;
                    *) echo "Skipped statusline setup" ;;
                esac
            else
                # Non-interactive: patch existing
                _patch_existing_statusline "$script_path"
            fi
            ;;
        3)
            # No settings.json
            if [[ "$mode" == "check" ]]; then
                echo "⚠ Claude Code settings.json not found"
                return 1
            fi

            mkdir -p "$CLAUDE_DIR"
            echo '{}' > "$CLAUDE_SETTINGS"
            _install_cleo_statusline
            ;;
    esac
}

# Internal: Install CLEO statusline as the primary statusline
_install_cleo_statusline() {
    echo "Installing CLEO context monitoring statusline..."

    mkdir -p "$CLAUDE_DIR"

    # Ensure settings.json exists
    if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
        echo '{}' > "$CLAUDE_SETTINGS"
    fi

    # Update settings.json with CLEO statusline
    local tmp_file
    tmp_file=$(mktemp)

    jq --arg cmd "$CLEO_STATUSLINE" \
       '.statusLine = {"type": "command", "command": $cmd}' \
       "$CLAUDE_SETTINGS" > "$tmp_file"

    mv "$tmp_file" "$CLAUDE_SETTINGS"

    echo "✓ Installed CLEO statusline: $CLEO_STATUSLINE"
    echo "  Restart Claude Code to activate"
}

# Internal: Patch existing statusline script to add CLEO state file write
_patch_existing_statusline() {
    local script_path="$1"

    if [[ ! -f "$script_path" ]]; then
        echo "Script not found: $script_path"
        echo "Installing CLEO statusline instead..."
        _install_cleo_statusline
        return
    fi

    # Check if already patched
    if grep -q "context-state.json" "$script_path" 2>/dev/null; then
        echo "✓ Script already has CLEO integration"
        return 0
    fi

    echo "Patching: $script_path"

    # Create backup
    cp "$script_path" "${script_path}.bak"

    # Add CLEO state file write snippet (with session binding support)
    local snippet='
# === CLEO Context State Integration ===
# Write context state for cleo context command
# Uses $cwd from Claude Code JSON, NOT $PWD
_write_cleo_state() {
    # Use workspace dir from Claude Code, not shell PWD
    local workspace="${cwd:-$PWD}"
    local cleo_dir=""
    local search_dir="$workspace"

    # Find .cleo directory from workspace path
    while [[ "$search_dir" != "/" ]]; do
        if [[ -d "$search_dir/.cleo" ]]; then
            cleo_dir="$search_dir/.cleo"
            break
        fi
        search_dir="$(dirname "$search_dir")"
    done

    if [[ -n "$cleo_dir" ]] && [[ -n "${input:-}" ]]; then
        local pct=${pct:-0}
        local current=${current:-0}
        local size=${size:-200000}
        local status="ok"
        [[ $pct -ge 95 ]] && status="emergency"
        [[ $pct -ge 90 ]] && [[ $pct -lt 95 ]] && status="critical"
        [[ $pct -ge 85 ]] && [[ $pct -lt 90 ]] && status="caution"
        [[ $pct -ge 70 ]] && [[ $pct -lt 85 ]] && status="warning"

        # Determine canonical state location from config
        local project_root="${cleo_dir%/.cleo}"
        local context_dir_rel=".cleo/context-states"
        local filename_pattern="context-state-{sessionId}.json"
        if [[ -f "$cleo_dir/config.json" ]]; then
            context_dir_rel=$(jq -r '.contextStates.directory // ".cleo/context-states"' "$cleo_dir/config.json" 2>/dev/null || echo ".cleo/context-states")
            filename_pattern=$(jq -r '.contextStates.filenamePattern // "context-state-{sessionId}.json"' "$cleo_dir/config.json" 2>/dev/null || echo "context-state-{sessionId}.json")
        fi

        local context_dir=""
        if [[ "$context_dir_rel" == /* ]]; then
            context_dir="$context_dir_rel"
        else
            context_dir="$project_root/${context_dir_rel#./}"
        fi

        # Migrate errant nested path created by older patch logic
        local nested_dir="$cleo_dir/.cleo/context-states"
        if [[ -d "$nested_dir" ]]; then
            mkdir -p "$context_dir" 2>/dev/null || true
            local stale_file
            for stale_file in "$nested_dir"/context-state-*.json; do
                [[ -f "$stale_file" ]] || continue
                mv -f "$stale_file" "$context_dir/$(basename "$stale_file")" 2>/dev/null || true
            done
            rmdir "$nested_dir" 2>/dev/null || true
            rmdir "$cleo_dir/.cleo" 2>/dev/null || true
        fi

        local state_file="$cleo_dir/.context-state.json"
        local session_id=""
        if [[ -f "$cleo_dir/.current-session" ]]; then
            session_id=$(cat "$cleo_dir/.current-session" 2>/dev/null | tr -d '"'"'"'\n')
            if [[ -n "$session_id" ]]; then
                local filename="${filename_pattern//\{sessionId\}/$session_id}"
                mkdir -p "$context_dir" 2>/dev/null || true
                state_file="$context_dir/$filename"
            fi
        fi

        jq -n \
            --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --argjson max "$size" \
            --argjson cur "$current" \
            --argjson pct "$pct" \
            --arg status "$status" \
            --arg sid "${session_id:-}" \
            --arg ws "$workspace" \
            '"'"'{version:"1.0.0",timestamp:$ts,staleAfterMs:5000,contextWindow:{maxTokens:$max,currentTokens:$cur,percentage:$pct},status:$status,sessionId:$sid,workspace:$ws}'"'"' \
            > "$state_file" 2>/dev/null || true
    fi
}
_write_cleo_state
# === End CLEO Integration ==='

    # Append to script before final output
    # Find a good insertion point (before echo/printf that outputs the status line)
    if grep -q "^echo " "$script_path"; then
        # Insert before first echo that looks like output
        sed -i "/^echo.*\$/i\\$snippet" "$script_path" 2>/dev/null || \
            echo "$snippet" >> "$script_path"
    else
        # Just append
        echo "$snippet" >> "$script_path"
    fi

    echo "✓ Patched script with CLEO integration"
    echo "  Backup saved: ${script_path}.bak"
    echo "  Restart Claude Code to activate"
}

# Export functions
export -f check_statusline_integration
export -f get_statusline_status
export -f install_statusline_integration
