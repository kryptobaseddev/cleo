#!/usr/bin/env bash
# flags.sh - Centralized flag parsing for CLEO CLI
#
# LAYER: 1 (Core Infrastructure)
# DEPENDENCIES: none (standalone, may be sourced before other libs)
# PROVIDES: parse_common_flags, init_flag_defaults, get_flag, set_flag,
#           FLAG_FORMAT, FLAG_QUIET, FLAG_DRY_RUN, FLAG_VERBOSE, FLAG_HELP
#
# Standardizes flag parsing across all CLEO commands.
# Commands source this, parse flags, then call resolve_format() for TTY-aware defaults.
#
# Usage Pattern:
#   source lib/ui/flags.sh
#   init_flag_defaults
#   parse_common_flags "$@"
#   shift $PARSED_ARGS
#   FORMAT=$(resolve_format "$FLAG_FORMAT")
#
# Standard Flag Values:
#   --human  → FLAG_FORMAT="human" (standardized, NOT "text")
#   --json   → FLAG_FORMAT="json"
#   --format → FLAG_FORMAT="$VALUE"
#   --quiet  → FLAG_QUIET=true
#   --dry-run → FLAG_DRY_RUN=true
#   --verbose → FLAG_VERBOSE=true
#   --help   → FLAG_HELP=true

#=== SOURCE GUARD ================================================
[[ -n "${_FLAGS_SH_LOADED:-}" ]] && return 0
declare -r _FLAGS_SH_LOADED=1

# ============================================================================
# FLAG VARIABLES (global state set by parse_common_flags)
# ============================================================================

# Format flag: "json", "human", or custom format values
# NOTE: --human sets "human" (NOT "text") per CLEO standardization
declare -g FLAG_FORMAT=""

# Quiet mode: suppress non-essential output
declare -g FLAG_QUIET=false

# Dry-run mode: show what would happen without making changes
declare -g FLAG_DRY_RUN=false

# Verbose mode: show additional debug/diagnostic output
declare -g FLAG_VERBOSE=false

# Help requested: command should show usage and exit
declare -g FLAG_HELP=false

# Force mode: bypass confirmations and safety checks
declare -g FLAG_FORCE=false

# Number of arguments consumed by parse_common_flags
# Use: shift $PARSED_ARGS after calling parse_common_flags
declare -g PARSED_ARGS=0

# Remaining arguments after flag parsing (for commands that need them)
declare -ga REMAINING_ARGS=()

# ============================================================================
# INITIALIZATION
# ============================================================================

# init_flag_defaults - Reset all flags to default values
#
# Call before parse_common_flags to ensure clean state.
# Especially important when sourcing in test environments.
#
# Usage:
#   init_flag_defaults
#   parse_common_flags "$@"
init_flag_defaults() {
    FLAG_FORMAT=""
    FLAG_QUIET=false
    FLAG_DRY_RUN=false
    FLAG_VERBOSE=false
    FLAG_HELP=false
    FLAG_FORCE=false
    PARSED_ARGS=0
    REMAINING_ARGS=()
}

# ============================================================================
# FLAG PARSING
# ============================================================================

# parse_common_flags - Parse universal CLI flags
#
# Parses common flags used across all CLEO commands:
#   --format VALUE, -f VALUE: Set output format
#   --json: Shortcut for --format json
#   --human: Shortcut for --format human (standardized)
#   --quiet, -q: Suppress non-essential output
#   --dry-run: Preview mode without changes
#   --verbose, -v: Enable verbose output
#   --force, -F: Bypass confirmations and safety checks
#   --help, -h: Request help display
#
# Args:
#   "$@" - All command-line arguments
#
# Sets:
#   FLAG_FORMAT - Format string ("json", "human", or custom)
#   FLAG_QUIET - true/false
#   FLAG_DRY_RUN - true/false
#   FLAG_VERBOSE - true/false
#   FLAG_FORCE - true/false
#   FLAG_HELP - true/false
#   PARSED_ARGS - Number of arguments consumed
#   REMAINING_ARGS - Array of non-flag arguments
#
# Returns:
#   0 - Success
#   1 - Invalid flag usage (e.g., --format without value)
#
# Usage:
#   parse_common_flags "$@"
#   shift $PARSED_ARGS
#   # Now $@ contains only command-specific arguments
#
# Example:
#   # Command: cleo list --json --quiet T001
#   parse_common_flags "$@"
#   # FLAG_FORMAT="json", FLAG_QUIET=true
#   # REMAINING_ARGS=("T001")
#   shift $PARSED_ARGS
#   # Now process remaining args
parse_common_flags() {
    local args_consumed=0
    REMAINING_ARGS=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            # Format flags
            -f|--format)
                if [[ -z "${2:-}" || "$2" =~ ^- ]]; then
                    echo "ERROR: --format requires a value" >&2
                    return 1
                fi
                FLAG_FORMAT="$2"
                shift 2
                ((args_consumed += 2))
                ;;
            --format=*)
                FLAG_FORMAT="${1#--format=}"
                if [[ -z "$FLAG_FORMAT" ]]; then
                    echo "ERROR: --format requires a value" >&2
                    return 1
                fi
                shift
                ((++args_consumed))
                ;;
            --json)
                FLAG_FORMAT="json"
                shift
                ((++args_consumed))
                ;;
            --human)
                # STANDARDIZED: --human maps to "human" (not "text")
                FLAG_FORMAT="human"
                shift
                ((++args_consumed))
                ;;

            # Quiet mode
            -q|--quiet)
                FLAG_QUIET=true
                shift
                ((++args_consumed))
                ;;

            # Dry-run mode
            --dry-run)
                FLAG_DRY_RUN=true
                shift
                ((++args_consumed))
                ;;

            # Verbose mode
            -v|--verbose)
                FLAG_VERBOSE=true
                shift
                ((++args_consumed))
                ;;

            # Force mode
            -F|--force)
                FLAG_FORCE=true
                shift
                ((++args_consumed))
                ;;

            # Help
            -h|--help)
                FLAG_HELP=true
                shift
                ((++args_consumed))
                ;;

            # End of flags marker
            --)
                shift
                ((++args_consumed))
                # Everything after -- goes to REMAINING_ARGS
                while [[ $# -gt 0 ]]; do
                    REMAINING_ARGS+=("$1")
                    shift
                    ((++args_consumed))
                done
                break
                ;;

            # Unknown flag - stop parsing (let command handle it)
            -*)
                # Don't consume - let command-specific parser handle
                REMAINING_ARGS+=("$1")
                shift
                ((++args_consumed))
                ;;

            # Positional argument - stop parsing common flags
            *)
                REMAINING_ARGS+=("$1")
                shift
                ((++args_consumed))
                ;;
        esac
    done

    PARSED_ARGS=$args_consumed
    return 0
}

# parse_flags_strict - Parse common flags, stop at first unknown
#
# Like parse_common_flags but stops parsing at first unrecognized flag.
# Unknown flags remain in REMAINING_ARGS for command-specific handling.
#
# Args:
#   "$@" - All command-line arguments
#
# Sets: Same as parse_common_flags
#
# Returns:
#   0 - Success
#   1 - Invalid flag usage
#
# Usage:
#   parse_flags_strict "$@"
#   # Process FLAG_* variables
#   # Then parse REMAINING_ARGS for command-specific flags
parse_flags_strict() {
    local args_consumed=0
    REMAINING_ARGS=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            # Format flags
            -f|--format)
                if [[ -z "${2:-}" || "$2" =~ ^- ]]; then
                    echo "ERROR: --format requires a value" >&2
                    return 1
                fi
                FLAG_FORMAT="$2"
                shift 2
                ((args_consumed += 2))
                ;;
            --format=*)
                FLAG_FORMAT="${1#--format=}"
                shift
                ((++args_consumed))
                ;;
            --json)
                FLAG_FORMAT="json"
                shift
                ((++args_consumed))
                ;;
            --human)
                FLAG_FORMAT="human"
                shift
                ((++args_consumed))
                ;;
            -q|--quiet)
                FLAG_QUIET=true
                shift
                ((++args_consumed))
                ;;
            --dry-run)
                FLAG_DRY_RUN=true
                shift
                ((++args_consumed))
                ;;
            -v|--verbose)
                FLAG_VERBOSE=true
                shift
                ((++args_consumed))
                ;;
            -F|--force)
                FLAG_FORCE=true
                shift
                ((++args_consumed))
                ;;
            -h|--help)
                FLAG_HELP=true
                shift
                ((++args_consumed))
                ;;
            --)
                shift
                ((++args_consumed))
                break
                ;;
            # Unknown flag - stop and pass rest to REMAINING_ARGS
            -*)
                break
                ;;
            # Positional argument - stop
            *)
                break
                ;;
        esac
    done

    # Collect remaining arguments
    while [[ $# -gt 0 ]]; do
        REMAINING_ARGS+=("$1")
        shift
        ((++args_consumed))
    done

    PARSED_ARGS=$args_consumed
    return 0
}

# ============================================================================
# FLAG ACCESSORS
# ============================================================================

# get_flag - Get current value of a flag
#
# Args:
#   $1 - Flag name (format, quiet, dry_run, verbose, force, help)
#
# Returns:
#   Flag value via stdout
#
# Usage:
#   if [[ "$(get_flag quiet)" == "true" ]]; then ...
get_flag() {
    local flag_name="$1"

    case "$flag_name" in
        format)    echo "$FLAG_FORMAT" ;;
        quiet)     echo "$FLAG_QUIET" ;;
        dry_run|dry-run|dryrun)   echo "$FLAG_DRY_RUN" ;;
        verbose)   echo "$FLAG_VERBOSE" ;;
        force)     echo "$FLAG_FORCE" ;;
        help)      echo "$FLAG_HELP" ;;
        *)
            echo "ERROR: Unknown flag: $flag_name" >&2
            return 1
            ;;
    esac
}

# set_flag - Set a flag value programmatically
#
# Args:
#   $1 - Flag name
#   $2 - Flag value
#
# Usage:
#   set_flag format "json"
#   set_flag quiet true
set_flag() {
    local flag_name="$1"
    local flag_value="$2"

    case "$flag_name" in
        format)    FLAG_FORMAT="$flag_value" ;;
        quiet)     FLAG_QUIET="$flag_value" ;;
        dry_run|dry-run|dryrun)   FLAG_DRY_RUN="$flag_value" ;;
        verbose)   FLAG_VERBOSE="$flag_value" ;;
        force)     FLAG_FORCE="$flag_value" ;;
        help)      FLAG_HELP="$flag_value" ;;
        *)
            echo "ERROR: Unknown flag: $flag_name" >&2
            return 1
            ;;
    esac
}

# is_flag_set - Check if a boolean flag is true
#
# Args:
#   $1 - Flag name
#
# Returns:
#   0 if flag is true, 1 otherwise
#
# Usage:
#   if is_flag_set quiet; then
#       # quiet mode handling
#   fi
is_flag_set() {
    local flag_name="$1"
    local value
    value=$(get_flag "$flag_name" 2>/dev/null)
    [[ "$value" == "true" ]]
}

# ============================================================================
# VALIDATION HELPERS
# ============================================================================

# validate_format_value - Check if format value is valid
#
# Args:
#   $1 - Format value to validate
#   $2 - Comma-separated list of valid formats (default: "json,human,text,csv")
#
# Returns:
#   0 if valid, 1 if invalid
#
# Usage:
#   if ! validate_format_value "$FLAG_FORMAT"; then
#       echo "Invalid format" >&2
#       exit 1
#   fi
validate_format_value() {
    local format="$1"
    local valid_formats="${2:-json,human,text,csv}"

    # Empty format is valid (will use TTY-aware default)
    [[ -z "$format" ]] && return 0

    # Check against valid list
    if [[ ",$valid_formats," == *",$format,"* ]]; then
        return 0
    fi

    echo "ERROR: Invalid format '$format'. Valid formats: $valid_formats" >&2
    return 1
}

# require_format - Ensure format is specified, error if empty
#
# Args:
#   $1 - Error message (optional)
#
# Returns:
#   0 if format is set, 1 if empty
require_format() {
    local error_msg="${1:-Format is required}"

    if [[ -z "$FLAG_FORMAT" ]]; then
        echo "ERROR: $error_msg" >&2
        return 1
    fi
    return 0
}

# ============================================================================
# INTEGRATION HELPERS
# ============================================================================

# apply_flags_to_globals - Copy flag values to legacy global variables
#
# For backward compatibility with scripts using FORMAT, QUIET, DRY_RUN directly.
#
# Sets:
#   FORMAT - from FLAG_FORMAT (empty if not set)
#   QUIET - from FLAG_QUIET
#   DRY_RUN - from FLAG_DRY_RUN
#   VERBOSE - from FLAG_VERBOSE
#
# Usage:
#   parse_common_flags "$@"
#   apply_flags_to_globals
#   # Now FORMAT, QUIET, DRY_RUN are set for legacy code
apply_flags_to_globals() {
    # Only set FORMAT if FLAG_FORMAT is non-empty
    # This allows resolve_format() to apply TTY-aware defaults
    if [[ -n "$FLAG_FORMAT" ]]; then
        FORMAT="$FLAG_FORMAT"
    else
        # Preserve existing FORMAT if FLAG_FORMAT not set
        FORMAT="${FORMAT:-}"
    fi

    QUIET="$FLAG_QUIET"
    DRY_RUN="$FLAG_DRY_RUN"
    VERBOSE="${FLAG_VERBOSE:-false}"
}

# flags_to_json - Export current flags as JSON object
#
# Returns:
#   JSON object with all flag values
#
# Usage:
#   flags_json=$(flags_to_json)
#   echo "$flags_json" | jq '.format'
flags_to_json() {
    if command -v jq &>/dev/null; then
        jq -nc \
            --arg format "$FLAG_FORMAT" \
            --argjson quiet "$FLAG_QUIET" \
            --argjson dryRun "$FLAG_DRY_RUN" \
            --argjson verbose "$FLAG_VERBOSE" \
            --argjson help "$FLAG_HELP" \
            '{
                format: $format,
                quiet: $quiet,
                dryRun: $dryRun,
                verbose: $verbose,
                help: $help
            }'
    else
        # Fallback without jq
        cat <<EOF
{"format":"$FLAG_FORMAT","quiet":$FLAG_QUIET,"dryRun":$FLAG_DRY_RUN,"verbose":$FLAG_VERBOSE,"help":$FLAG_HELP}
EOF
    fi
}

# ============================================================================
# SUBCOMMAND HELPERS
# ============================================================================

# get_passthrough_flags - Get flag args to pass to subcommands
#
# Reconstructs command-line arguments from current flag state.
# Use when calling nested CLEO commands that should inherit flags.
#
# Args:
#   $@ - Additional flags to include (e.g., "--quiet")
#
# Returns:
#   Space-separated flag arguments via stdout
#
# Usage:
#   # Pass current format to nested command
#   "$SCRIPT_DIR/validate.sh" $(get_passthrough_flags --quiet)
#
#   # Or capture as array
#   read -ra flags <<< "$(get_passthrough_flags)"
#   "$SCRIPT_DIR/other.sh" "${flags[@]}"
get_passthrough_flags() {
    local args=()

    # Format flag (most important for consistent output)
    if [[ -n "$FLAG_FORMAT" ]]; then
        args+=("--format" "$FLAG_FORMAT")
    fi

    # Boolean flags
    [[ "$FLAG_QUIET" == true ]] && args+=("--quiet")
    [[ "$FLAG_DRY_RUN" == true ]] && args+=("--dry-run")
    [[ "$FLAG_VERBOSE" == true ]] && args+=("--verbose")
    [[ "$FLAG_FORCE" == true ]] && args+=("--force")

    # Add any additional flags passed as arguments
    args+=("$@")

    # Output space-separated (safe for simple cases)
    echo "${args[*]}"
}

# get_passthrough_flags_array - Get flag args as proper array
#
# Like get_passthrough_flags but outputs one arg per line for array capture.
#
# Usage:
#   mapfile -t flags < <(get_passthrough_flags_array --quiet)
#   "$SCRIPT_DIR/validate.sh" "${flags[@]}"
get_passthrough_flags_array() {
    [[ -n "$FLAG_FORMAT" ]] && printf '%s\n' "--format" "$FLAG_FORMAT"
    [[ "$FLAG_QUIET" == true ]] && printf '%s\n' "--quiet"
    [[ "$FLAG_DRY_RUN" == true ]] && printf '%s\n' "--dry-run"
    [[ "$FLAG_VERBOSE" == true ]] && printf '%s\n' "--verbose"
    [[ "$FLAG_FORCE" == true ]] && printf '%s\n' "--force"

    # Additional flags
    for arg in "$@"; do
        printf '%s\n' "$arg"
    done
}

# ============================================================================
# EXPORTS
# ============================================================================

# Export flag variables
export FLAG_FORMAT
export FLAG_QUIET
export FLAG_DRY_RUN
export FLAG_VERBOSE
export FLAG_HELP
export PARSED_ARGS

# Export functions
export -f init_flag_defaults
export -f parse_common_flags
export -f parse_flags_strict
export -f get_flag
export -f set_flag
export -f is_flag_set
export -f validate_format_value
export -f require_format
export -f apply_flags_to_globals
export -f flags_to_json
export -f get_passthrough_flags
export -f get_passthrough_flags_array
