#!/usr/bin/env bash
# scripts/setup-claude-aliases.sh - Install Claude Code CLI aliases
# See claudedocs/specs/SETUP-CLAUDE-ALIASES-SPEC.md for design specification

set -euo pipefail

# ==============================================================================
# SCRIPT DIRECTORY RESOLUTION
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Determine library directory (local dev vs global install)
if [[ -f "$SCRIPT_DIR/../lib/exit-codes.sh" ]]; then
    # Local development (running from scripts/ directory)
    LIB_DIR="$SCRIPT_DIR/../lib"
elif [[ -f "$CLEO_HOME/lib/exit-codes.sh" ]]; then
    # Global installation
    LIB_DIR="$CLEO_HOME/lib"
else
    echo "Error: Cannot find CLEO libraries" >&2
    exit 1
fi

# ==============================================================================
# DEPENDENCIES
# ==============================================================================

source "$LIB_DIR/exit-codes.sh"
source "$LIB_DIR/platform-compat.sh"
source "$LIB_DIR/flags.sh"
source "$LIB_DIR/claude-aliases.sh"

# ==============================================================================
# COMMAND CONFIGURATION
# ==============================================================================

COMMAND_NAME="setup-claude-aliases"

# Command-specific flags
TARGET_SHELL=""
REMOVE_MODE=false
CMD_AUTORUN=false

# ==============================================================================
# HELP TEXT
# ==============================================================================

show_help() {
    cat <<'EOF'
Usage: cleo setup-claude-aliases [OPTIONS]

Install optimized Claude Code CLI aliases.

OPTIONS:
    --dry-run              Preview changes without modifying files
    --force                Force reinstall even if current
    --shell SHELL          Target specific shell (bash|zsh|powershell|cmd)
    --remove               Remove installed aliases
    --cmd-autorun          Configure Windows CMD.exe to auto-load aliases (registry)
    --no-cmd-autorun       Skip CMD AutoRun registry setup (default)
    -f, --format FMT       Output format: text (default) or json
    --json                 Shorthand for --format json
    -q, --quiet            Suppress non-essential output
    -h, --help             Show this help message

ALIASES INSTALLED:
    cc                     Interactive with optimized environment
    ccy                    Interactive + skip permissions
    ccr                    Resume previous session
    ccry                   Resume + skip permissions
    cc-headless            Headless mode with controlled tools
    cc-headfull            Headless + skip permissions
    cc-headfull-stream     Headless + streaming JSON output

ENVIRONMENT VARIABLES SET:
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true
    ENABLE_BACKGROUND_TASKS=true
    FORCE_AUTO_BACKGROUND_TASKS=true
    CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true

EXAMPLES:
    cleo setup-claude-aliases              # Install for all detected shells
    cleo setup-claude-aliases --shell zsh  # Install for zsh only
    cleo setup-claude-aliases --remove     # Remove all aliases
    cleo setup-claude-aliases --dry-run    # Preview changes

EXIT CODES:
    0    - Success
    2    - Invalid input
    5    - Dependency error (claude CLI not found)
    23   - Collision detected (use --force to override)
    102  - No changes needed

COLLISION HANDLING:
    The command detects existing aliases that may conflict:
    - Legacy Claude aliases (function-based): Safe to override with --force
    - Non-Claude aliases (e.g., cc for C compiler): Review before using --force
EOF
}

# ==============================================================================
# ARGUMENT PARSING
# ==============================================================================

parse_args() {
    init_flag_defaults
    parse_common_flags "$@"
    set -- "${REMAINING_ARGS[@]}"

    # Handle help flag
    if [[ "$FLAG_HELP" == true ]]; then
        show_help
        exit 0
    fi

    # Parse command-specific flags
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --shell)
                if [[ -z "${2:-}" ]]; then
                    echo "Error: --shell requires a value (bash|zsh|powershell|cmd)" >&2
                    exit "$EXIT_INVALID_INPUT"
                fi
                # Validate shell type
                case "$2" in
                    bash|zsh|powershell|cmd)
                        TARGET_SHELL="$2"
                        ;;
                    *)
                        echo "Error: Invalid shell type: $2" >&2
                        echo "Valid shells: bash, zsh, powershell, cmd" >&2
                        exit "$EXIT_INVALID_INPUT"
                        ;;
                esac
                shift 2
                ;;
            --remove)
                REMOVE_MODE=true
                shift
                ;;
            --cmd-autorun)
                CMD_AUTORUN=true
                shift
                ;;
            --no-cmd-autorun)
                CMD_AUTORUN=false
                shift
                ;;
            *)
                echo "Error: Unknown option: $1" >&2
                echo "Use --help for usage information" >&2
                exit "$EXIT_INVALID_INPUT"
                ;;
        esac
    done

    # Apply common flags to legacy globals (FORMAT, QUIET, DRY_RUN)
    apply_flags_to_globals

    # Default FORMAT to "text" if not specified
    if [[ -z "${FORMAT:-}" ]]; then
        FORMAT="text"
    fi
}

# ==============================================================================
# OUTPUT HELPERS
# ==============================================================================

# Output message respecting quiet mode and format
output_msg() {
    if [[ "$FLAG_QUIET" != true ]] && [[ "${FORMAT:-text}" != "json" ]]; then
        echo "$@"
    fi
    return 0
}

# Output to stderr (always, even in quiet mode)
output_error() {
    echo "$@" >&2
}

# ==============================================================================
# MAIN EXECUTION
# ==============================================================================

main() {
    parse_args "$@"

    # Check claude CLI is installed
    if ! is_claude_cli_installed; then
        if [[ "$FORMAT" == "json" ]]; then
            cat <<EOF
{
  "success": false,
  "error": {
    "code": "E_DEPENDENCY_ERROR",
    "message": "Claude CLI not installed",
    "fix": "Install Claude Code CLI first: https://claude.ai/code"
  }
}
EOF
        else
            output_error "Error: Claude CLI not installed"
            output_error "Install Claude Code CLI first: https://claude.ai/code"
        fi
        exit "$EXIT_DEPENDENCY_ERROR"
    fi

    # Initialize counters
    local installed=0
    local skipped=0
    local removed=0
    local failed=0
    local results=()

    # Get shells to process
    local shells_to_process=()
    if [[ -n "$TARGET_SHELL" ]]; then
        shells_to_process=("$TARGET_SHELL")
    else
        # Detect available shells
        for shell in "${SUPPORTED_SHELLS[@]}"; do
            # Only include shells that have a valid RC file path
            if get_rc_file_path "$shell" &>/dev/null; then
                shells_to_process+=("$shell")
            fi
        done
    fi

    # Check if no shells to process
    if [[ ${#shells_to_process[@]} -eq 0 ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            cat <<EOF
{
  "success": false,
  "error": {
    "code": "E_NO_DATA",
    "message": "No shells available to configure"
  }
}
EOF
        else
            output_error "Error: No shells available to configure"
        fi
        exit "$EXIT_NO_DATA"
    fi

    # Process each shell
    for shell_type in "${shells_to_process[@]}"; do
        local rc_file
        rc_file=$(get_rc_file_path "$shell_type")

        # Dry-run mode: preview changes
        if [[ "$FLAG_DRY_RUN" == true ]]; then
            if [[ "$REMOVE_MODE" == true ]]; then
                if aliases_has_block "$rc_file" 2>/dev/null; then
                    output_msg "[DRY-RUN] Would remove from: $rc_file"
                else
                    output_msg "[DRY-RUN] Not installed in: $rc_file"
                fi
            else
                if aliases_has_block "$rc_file" 2>/dev/null; then
                    local version
                    version=$(get_installed_aliases_version "$rc_file")
                    if [[ "$version" == "$CLAUDE_ALIASES_VERSION" ]]; then
                        output_msg "[DRY-RUN] Already current: $rc_file (v$version)"
                    else
                        output_msg "[DRY-RUN] Would update: $rc_file (v${version:-unknown} -> v$CLAUDE_ALIASES_VERSION)"
                    fi
                elif [[ -f "$rc_file" ]]; then
                    # Check for collisions in dry-run
                    local legacy_check
                    legacy_check=$(detect_legacy_claude_aliases "$rc_file")
                    local is_legacy
                    is_legacy=$(echo "$legacy_check" | jq -r '.detected' 2>/dev/null || echo "false")

                    if [[ "$is_legacy" == "true" ]]; then
                        output_msg "[DRY-RUN] ⚠ Legacy Claude aliases in: $rc_file (use --force)"
                    else
                        local collision_check
                        collision_check=$(check_alias_collisions "$rc_file")
                        local has_collision
                        has_collision=$(echo "$collision_check" | jq -r '.hasCollisions' 2>/dev/null || echo "false")

                        if [[ "$has_collision" == "true" ]]; then
                            local collision_names
                            collision_names=$(echo "$collision_check" | jq -r '[.collisions[].name] | join(", ")' 2>/dev/null || echo "unknown")
                            output_msg "[DRY-RUN] ⚠ Collision in: $rc_file ($collision_names) - use --force"
                        else
                            output_msg "[DRY-RUN] Would install to: $rc_file"
                        fi
                    fi
                else
                    output_msg "[DRY-RUN] Would install to: $rc_file"
                fi
            fi
            continue
        fi

        # Execute actual operation
        local result
        if [[ "$REMOVE_MODE" == true ]]; then
            result=$(remove_aliases "$rc_file")
            local action
            action=$(echo "$result" | jq -r '.action' 2>/dev/null || echo "failed")

            case "$action" in
                removed)
                    ((++removed))
                    output_msg "Removed aliases from: $rc_file"
                    ;;
                skipped)
                    ((++skipped))
                    local reason
                    reason=$(echo "$result" | jq -r '.reason' 2>/dev/null || echo "unknown")
                    [[ "$FLAG_QUIET" != true ]] && [[ "$reason" != "not_installed" ]] && \
                        output_msg "Skipped: $rc_file ($reason)"
                    ;;
                failed)
                    ((++failed))
                    output_error "Failed to remove from: $rc_file"
                    ;;
            esac
        else
            local force_flag=""
            [[ "$FLAG_FORCE" == true ]] && force_flag="--force"

            result=$(inject_aliases "$rc_file" "$shell_type" "$force_flag")
            local inject_exit=$?
            local action
            action=$(echo "$result" | jq -r '.action' 2>/dev/null || echo "failed")

            case "$action" in
                created|added|updated)
                    ((++installed))
                    output_msg "Installed aliases to: $rc_file ($action)"
                    ;;
                skipped)
                    ((++skipped))
                    local reason
                    reason=$(echo "$result" | jq -r '.reason' 2>/dev/null || echo "unknown")
                    output_msg "Skipped: $rc_file ($reason)"
                    ;;
                blocked)
                    ((++skipped))
                    local reason message
                    reason=$(echo "$result" | jq -r '.reason' 2>/dev/null || echo "unknown")
                    message=$(echo "$result" | jq -r '.message' 2>/dev/null || echo "Collision detected")

                    if [[ "$reason" == "legacy_claude_aliases" ]]; then
                        output_error "⚠ Legacy Claude aliases found in: $rc_file"
                        output_error "  These appear to be manually installed Claude aliases."
                        output_error "  Use --force to replace them with CLEO-managed aliases."
                    elif [[ "$reason" == "collision" ]]; then
                        local collision_names
                        collision_names=$(echo "$result" | jq -r '[.collisions[].name] | join(", ")' 2>/dev/null || echo "unknown")
                        output_error "⚠ Existing aliases found in: $rc_file"
                        output_error "  Conflicting aliases: $collision_names"
                        output_error "  These may be for other purposes (not Claude-related)."
                        output_error "  Use --force to override (will create duplicates)."
                    fi
                    ;;
                failed)
                    ((++failed))
                    local reason
                    reason=$(echo "$result" | jq -r '.reason' 2>/dev/null || echo "unknown")
                    output_error "Failed to install to: $rc_file ($reason)"
                    ;;
            esac
        fi

        results+=("$result")
    done

    # Handle CMD AutoRun registry setup (Windows only)
    local cmd_autorun_result=""
    if [[ "$CMD_AUTORUN" == true ]] && [[ "$PLATFORM" == "windows" ]]; then
        local cmd_batch_file
        cmd_batch_file=$(get_rc_file_path "cmd")

        if [[ "$FLAG_DRY_RUN" == true ]]; then
            output_msg "[DRY-RUN] Would configure CMD AutoRun registry for: $cmd_batch_file"
        elif [[ "$REMOVE_MODE" == true ]]; then
            cmd_autorun_result=$(setup_cmd_autorun "$cmd_batch_file" --remove)
            local ar_success
            ar_success=$(echo "$cmd_autorun_result" | jq -r '.success' 2>/dev/null || echo "false")
            if [[ "$ar_success" == "true" ]]; then
                output_msg "Removed CMD AutoRun registry entry"
            else
                output_error "Failed to remove CMD AutoRun registry entry"
            fi
        else
            # Only set up AutoRun if CMD aliases were installed successfully
            if [[ -f "$cmd_batch_file" ]]; then
                cmd_autorun_result=$(setup_cmd_autorun "$cmd_batch_file")
                local ar_success
                ar_success=$(echo "$cmd_autorun_result" | jq -r '.success' 2>/dev/null || echo "false")
                if [[ "$ar_success" == "true" ]]; then
                    output_msg "Configured CMD AutoRun registry for automatic alias loading"
                else
                    output_error "Failed to configure CMD AutoRun (aliases still installed)"
                fi
            else
                output_error "Cannot configure CMD AutoRun: batch file not found"
            fi
        fi
    fi

    # Handle dry-run output
    if [[ "$FLAG_DRY_RUN" == true ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            cat <<EOF
{
  "success": true,
  "dryRun": true,
  "version": "$CLAUDE_ALIASES_VERSION",
  "shellsChecked": ${#shells_to_process[@]}
}
EOF
        fi
        exit 0
    fi

    # Build summary output
    if [[ "$FORMAT" == "json" ]]; then
        local results_json="[]"
        if [[ ${#results[@]} -gt 0 ]]; then
            results_json=$(printf '%s,' "${results[@]}")
            results_json="[${results_json%,}]"
        fi

        # Build cmdAutorun JSON if present
        local cmd_autorun_json="null"
        if [[ -n "$cmd_autorun_result" ]]; then
            cmd_autorun_json="$cmd_autorun_result"
        fi

        jq -n \
            --argjson installed "$installed" \
            --argjson skipped "$skipped" \
            --argjson removed "$removed" \
            --argjson failed "$failed" \
            --argjson results "$results_json" \
            --arg version "$CLAUDE_ALIASES_VERSION" \
            --argjson removeMode "$REMOVE_MODE" \
            --argjson cmdAutorun "$cmd_autorun_json" \
            '{
                success: ($failed == 0),
                version: $version,
                removeMode: $removeMode,
                installed: $installed,
                skipped: $skipped,
                removed: $removed,
                failed: $failed,
                cmdAutorun: $cmdAutorun,
                results: $results
            }'
    else
        if [[ "$FLAG_QUIET" != true ]]; then
            echo ""
            if [[ "$REMOVE_MODE" == true ]]; then
                echo "Claude aliases removal complete!"
                echo "  Removed: $removed"
                [[ $skipped -gt 0 ]] && echo "  Skipped: $skipped"
                [[ $failed -gt 0 ]] && echo "  Failed: $failed"
            else
                echo "Claude aliases installation complete!"
                echo "  Installed: $installed"
                [[ $skipped -gt 0 ]] && echo "  Skipped: $skipped (already current)"
                [[ $failed -gt 0 ]] && echo "  Failed: $failed"
                if [[ $installed -gt 0 ]]; then
                    echo ""
                    echo "Restart your shell or run 'source ~/.bashrc' (or ~/.zshrc) to use aliases."
                fi
            fi
        fi
    fi

    # Determine exit code
    if [[ $failed -gt 0 ]]; then
        exit "$EXIT_FILE_ERROR"
    fi

    local total_changes=$((installed + removed))
    if [[ $total_changes -eq 0 ]] && [[ $skipped -gt 0 ]]; then
        exit "$EXIT_NO_CHANGE"
    fi

    exit 0
}

main "$@"
