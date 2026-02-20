#!/usr/bin/env bash
# check-compliance.sh - LLM-Agent-First Compliance Validator
# Automated checking of claude-todo commands against LLM-AGENT-FIRST-SPEC.md
#
# This script itself follows LLM-Agent-First principles:
# - JSON output by default for non-TTY
# - --format, --quiet, --json, --human flags
# - Structured _meta envelope
# - DEV_EXIT_* constants
#
# Usage:
#   ./dev/check-compliance.sh                           # Full compliance check
#   ./dev/check-compliance.sh --command list            # Check specific command
#   ./dev/check-compliance.sh --check foundation        # Run specific check category
#   ./dev/check-compliance.sh --ci --threshold 95       # CI mode with threshold
#   ./dev/check-compliance.sh --format json             # JSON output
#   ./dev/check-compliance.sh --incremental             # Only check changed files

set -euo pipefail

# ============================================================================
# SETUP - LLM-Agent-First compliant
# ============================================================================

# Script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_LIB_DIR="$SCRIPT_DIR/lib"
COMPLIANCE_DIR="$SCRIPT_DIR/compliance"
SCHEMA_PATH="$COMPLIANCE_DIR/schema.json"
CHECKS_DIR="$COMPLIANCE_DIR/checks"
CACHE_DIR="$SCRIPT_DIR/.compliance-cache"
CACHE_FILE="$CACHE_DIR/cache.json"

# Project paths
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPTS_DIR="$PROJECT_ROOT/scripts"

# Command identification (for error reporting and JSON output)
COMMAND_NAME="check-compliance"

# Source dev library (with fallback for compatibility)
if [[ -d "$DEV_LIB_DIR" ]] && [[ -f "$DEV_LIB_DIR/dev-common.sh" ]]; then
    source "$DEV_LIB_DIR/dev-common.sh"
else
    # Fallback definitions if dev-common.sh not available
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
    CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
    log_error() { echo -e "${RED}✗${NC} $*" >&2; }
    log_info() { echo -e "${GREEN}✓${NC} $*"; }
    dev_resolve_format() {
        local f="${1:-}"; [[ -n "$f" ]] && echo "$f" && return
        [[ -t 1 ]] && echo "text" || echo "json"
    }
fi

# Source compliance test helpers (provides pattern_* functions, colors, etc.)
source "$COMPLIANCE_DIR/lib/test-helpers.sh"

# Exit codes - use from dev-exit-codes.sh (via dev-common.sh) if available, else define locally
if [[ -z "${DEV_EXIT_SUCCESS:-}" ]]; then
    DEV_EXIT_SUCCESS=0
    DEV_EXIT_GENERAL_ERROR=1
    DEV_EXIT_INVALID_INPUT=2
    DEV_EXIT_NOT_FOUND=4
    DEV_EXIT_DEPENDENCY_ERROR=5
    DEV_EXIT_COMPLIANCE_FAILED=12
fi

# Verify critical dependency: jq
if ! command -v jq &>/dev/null; then
    echo "ERROR: Required dependency 'jq' not found." >&2
    echo "Install via: apt install jq (Debian/Ubuntu) or brew install jq (macOS)" >&2
    exit "${DEV_EXIT_DEPENDENCY_ERROR:-5}"
fi

# ============================================================================
# JSON ERROR OUTPUT - LLM-Agent-First compliant error envelope
# ============================================================================

# Output error in format-aware manner (JSON envelope for --format json)
# Usage: output_compliance_error <error_code> <message> <exit_code> [recoverable] [suggestion]
output_compliance_error() {
    local error_code="$1"
    local message="$2"
    local exit_code="$3"
    local recoverable="${4:-false}"
    local suggestion="${5:-}"

    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --arg code "$error_code" \
            --arg msg "$message" \
            --argjson exit "$exit_code" \
            --argjson recoverable "$recoverable" \
            --arg suggestion "$suggestion" \
            --arg cmd "$COMMAND_NAME" \
            --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --arg ver "$TOOL_VERSION" \
            '{
                "$schema": "https://claude-todo.dev/schemas/v1/error.schema.json",
                "_meta": {
                    "format": "json",
                    "command": $cmd,
                    "version": $ver,
                    "timestamp": $ts
                },
                "success": false,
                "error": {
                    "code": $code,
                    "message": $msg,
                    "exitCode": $exit,
                    "recoverable": $recoverable,
                    "suggestion": (if $suggestion == "" then null else $suggestion end)
                }
            }'
    else
        log_error "$message"
        [[ -n "$suggestion" ]] && echo -e "  ${DIM}Suggestion: $suggestion${NC}" >&2
    fi
}

# Default options
FORMAT=""
VERBOSE=false
QUIET=false
CI_MODE=false
THRESHOLD=95
INCREMENTAL=false
FORCE=false
STATIC_ONLY=false
SPECIFIC_COMMAND=""
SPECIFIC_CHECK=""
DISCOVER_MODE=false
SUGGEST_FIXES=false
DEV_SCRIPTS_MODE=false

# Paths for dev scripts mode
DEV_SCRIPTS_SCHEMA="$COMPLIANCE_DIR/dev-schema.json"

# Version
TOOL_VERSION="1.4.0"

# Print usage
usage() {
    cat << EOF
LLM-Agent-First Compliance Validator v${TOOL_VERSION}

Usage: $(basename "$0") [OPTIONS]

Options:
  -c, --command <name>      Check specific command(s) (comma-separated)
  -k, --check <category>    Run specific check category
                            (foundation, flags, json-envelope, exit-codes, errors)
  -f, --format <format>     Output format: text, json, jsonl, markdown, table
                            (default: json for non-TTY, text for TTY)
  -t, --threshold <n>       Pass threshold percentage (default: 95)
      --ci                  CI mode (exit non-zero if below threshold)
      --incremental         Only check files changed since last run
      --force               Force full check (ignore cache)
      --static-only         Skip runtime JSON tests
      --discover            Find scripts not in schema (untracked)
      --suggest             Add LLM-actionable fix suggestions to output
      --dev-scripts         Check dev/ scripts instead of main scripts/
  -v, --verbose             Show detailed check output
  -q, --quiet               Only show failures and summary
  -h, --help                Show this help message
      --version             Show version

Examples:
  $(basename "$0")                              # Full compliance check
  $(basename "$0") --command list,show          # Check list and show commands
  $(basename "$0") --check foundation           # Only run foundation checks
  $(basename "$0") --ci --threshold 100         # Strict CI mode
  $(basename "$0") --format json                # JSON output for scripting
  $(basename "$0") --incremental --verbose      # Check only changed, with details

Check Categories:
  foundation    - Library sourcing, COMMAND_NAME, VERSION
  flags         - --format, --quiet, --json, --human, resolve_format()
  exit-codes    - EXIT_* constants, no magic numbers
  errors        - output_error(), defensive checks, E_* codes
  json-envelope - Runtime JSON structure (\$schema, _meta, success)
EOF
}

# Parse arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -c|--command)
                SPECIFIC_COMMAND="$2"
                shift 2
                ;;
            -k|--check)
                SPECIFIC_CHECK="$2"
                shift 2
                ;;
            -f|--format)
                FORMAT="$2"
                shift 2
                ;;
            --json)
                FORMAT="json"
                shift
                ;;
            --human)
                FORMAT="text"
                shift
                ;;
            -t|--threshold)
                THRESHOLD="$2"
                shift 2
                ;;
            --ci)
                CI_MODE=true
                shift
                ;;
            --incremental)
                INCREMENTAL=true
                shift
                ;;
            --force)
                FORCE=true
                shift
                ;;
            --static-only)
                STATIC_ONLY=true
                shift
                ;;
            --discover)
                DISCOVER_MODE=true
                shift
                ;;
            --suggest)
                SUGGEST_FIXES=true
                shift
                ;;
            --dev-scripts)
                DEV_SCRIPTS_MODE=true
                shift
                ;;
            -v|--verbose)
                VERBOSE=true
                shift
                ;;
            -q|--quiet)
                QUIET=true
                shift
                ;;
            -h|--help)
                usage
                exit $DEV_EXIT_SUCCESS
                ;;
            --version)
                echo "check-compliance v${TOOL_VERSION}"
                exit $DEV_EXIT_SUCCESS
                ;;
            *)
                output_compliance_error "E_INVALID_OPTION" \
                    "Unknown option: $1" \
                    "$DEV_EXIT_INVALID_INPUT" \
                    true \
                    "Run --help for valid options"
                usage >&2
                exit $DEV_EXIT_INVALID_INPUT
                ;;
        esac
    done
}

# Load and validate schema
load_schema_file() {
    if [[ ! -f "$SCHEMA_PATH" ]]; then
        output_compliance_error "E_SCHEMA_NOT_FOUND" \
            "Schema not found: $SCHEMA_PATH" \
            "$DEV_EXIT_NOT_FOUND" \
            true \
            "Ensure compliance infrastructure is installed at dev/compliance/"
        exit $DEV_EXIT_NOT_FOUND
    fi

    if ! jq . "$SCHEMA_PATH" &>/dev/null; then
        output_compliance_error "E_SCHEMA_INVALID" \
            "Invalid JSON in schema: $SCHEMA_PATH" \
            "$DEV_EXIT_GENERAL_ERROR" \
            true \
            "Run 'jq . $SCHEMA_PATH' to see parse errors"
        exit $DEV_EXIT_GENERAL_ERROR
    fi

    cat "$SCHEMA_PATH"
}

# ============================================================================
# SCHEMA PATTERN PRE-EXTRACTION (Performance Optimization)
# ============================================================================
# Extract all patterns from schema once at startup to avoid repeated jq calls
# This reduces ~480 jq invocations down to ~20

# Global pattern variables (populated by preextract_schema_patterns)
declare -g PATTERN_DEV_LIB_SOURCE=""
declare -g PATTERN_DUAL_PATH=""
declare -g PATTERN_COMMAND_NAME=""
declare -g PATTERN_VERSION_CENTRAL=""
declare -g PATTERN_FORMAT_FLAG=""
declare -g PATTERN_QUIET_FLAG=""
declare -g PATTERN_JSON_SHORTCUT=""
declare -g PATTERN_HUMAN_SHORTCUT=""
declare -g PATTERN_RESOLVE_FORMAT=""
declare -g PATTERN_DRY_RUN=""
declare -g PATTERN_EXIT_CONSTANTS=""
declare -g PATTERN_EXIT_LIB=""
declare -g PATTERN_ERROR_FUNCTION=""
declare -g PATTERN_DEFENSIVE_CHECK=""
declare -g PATTERN_ERROR_LIB=""
declare -g SCHEMA_PATTERNS_LOADED=false

# Pre-extract all patterns from schema into global variables
# Args: $1 = schema JSON
# Sets: All PATTERN_* global variables
preextract_schema_patterns() {
    local schema="$1"

    # Extract all patterns in a single jq call for efficiency
    local patterns
    patterns=$(echo "$schema" | jq -r '
        [
            .requirements.foundation.libraries.patterns.dev_lib_source // .requirements.foundation.libraries.patterns.lib_source // "",
            .requirements.foundation.libraries.patterns.dual_path // "",
            .requirements.foundation.variables.patterns.command_name // "",
            .requirements.foundation.variables.patterns.version_central // "",
            .requirements.flags.universal.patterns.format_flag // "",
            .requirements.flags.universal.patterns.quiet_flag // "",
            .requirements.flags.universal.patterns.json_shortcut // "",
            .requirements.flags.universal.patterns.human_shortcut // "",
            .requirements.flags.format_resolution.pattern // "",
            .requirements.flags.universal.patterns.dry_run_flag // "",
            .requirements.exit_codes.pattern // "",
            .requirements.exit_codes.exit_lib_pattern // "",
            .requirements.error_handling.required_function // "",
            .requirements.error_handling.defensive_check // "",
            .requirements.error_handling.error_lib_pattern // ""
        ] | @tsv
    ')

    # Parse TSV into variables (|| true to handle trailing empty fields)
    IFS=$'\t' read -r \
        PATTERN_DEV_LIB_SOURCE \
        PATTERN_DUAL_PATH \
        PATTERN_COMMAND_NAME \
        PATTERN_VERSION_CENTRAL \
        PATTERN_FORMAT_FLAG \
        PATTERN_QUIET_FLAG \
        PATTERN_JSON_SHORTCUT \
        PATTERN_HUMAN_SHORTCUT \
        PATTERN_RESOLVE_FORMAT \
        PATTERN_DRY_RUN \
        PATTERN_EXIT_CONSTANTS \
        PATTERN_EXIT_LIB \
        PATTERN_ERROR_FUNCTION \
        PATTERN_DEFENSIVE_CHECK \
        PATTERN_ERROR_LIB \
        <<< "$patterns" || true

    # Unescape TSV-escaped backslashes (jq @tsv escapes \ as \\)
    PATTERN_DEV_LIB_SOURCE="${PATTERN_DEV_LIB_SOURCE//\\\\/\\}"
    PATTERN_DUAL_PATH="${PATTERN_DUAL_PATH//\\\\/\\}"
    PATTERN_EXIT_CONSTANTS="${PATTERN_EXIT_CONSTANTS//\\\\/\\}"
    PATTERN_EXIT_LIB="${PATTERN_EXIT_LIB//\\\\/\\}"
    PATTERN_ERROR_LIB="${PATTERN_ERROR_LIB//\\\\/\\}"
    PATTERN_DRY_RUN="${PATTERN_DRY_RUN//\\\\/\\}"

    # Export for use in sourced check scripts
    export PATTERN_DEV_LIB_SOURCE PATTERN_DUAL_PATH PATTERN_COMMAND_NAME PATTERN_VERSION_CENTRAL
    export PATTERN_FORMAT_FLAG PATTERN_QUIET_FLAG PATTERN_JSON_SHORTCUT PATTERN_HUMAN_SHORTCUT
    export PATTERN_RESOLVE_FORMAT PATTERN_DRY_RUN PATTERN_EXIT_CONSTANTS PATTERN_EXIT_LIB
    export PATTERN_ERROR_FUNCTION PATTERN_DEFENSIVE_CHECK PATTERN_ERROR_LIB

    SCHEMA_PATTERNS_LOADED=true

    if [[ "$VERBOSE" == "true" ]] && [[ "$FORMAT" == "text" ]]; then
        echo -e "${DIM}Pre-extracted ${#patterns} schema patterns${NC}" >&2
    fi
}

# Get a pre-extracted pattern (with fallback to jq for unlisted patterns)
# Args: $1 = schema, $2 = jq path
# Returns: pattern value
get_pattern() {
    local schema="$1"
    local path="$2"

    # Check if we have a pre-extracted pattern for common paths
    case "$path" in
        *.dev_lib_source|*.lib_source) echo "$PATTERN_DEV_LIB_SOURCE" ;;
        *.dual_path) echo "$PATTERN_DUAL_PATH" ;;
        *.command_name) echo "$PATTERN_COMMAND_NAME" ;;
        *.version_central) echo "$PATTERN_VERSION_CENTRAL" ;;
        *.format_flag) echo "$PATTERN_FORMAT_FLAG" ;;
        *.quiet_flag) echo "$PATTERN_QUIET_FLAG" ;;
        *.json_shortcut) echo "$PATTERN_JSON_SHORTCUT" ;;
        *.human_shortcut) echo "$PATTERN_HUMAN_SHORTCUT" ;;
        *.format_resolution.pattern) echo "$PATTERN_RESOLVE_FORMAT" ;;
        *.dry_run_flag|*.dry_run) echo "$PATTERN_DRY_RUN" ;;
        *.exit_codes.pattern) echo "$PATTERN_EXIT_CONSTANTS" ;;
        *.exit_lib_pattern) echo "$PATTERN_EXIT_LIB" ;;
        *.required_function) echo "$PATTERN_ERROR_FUNCTION" ;;
        *.defensive_check) echo "$PATTERN_DEFENSIVE_CHECK" ;;
        *.error_lib_pattern) echo "$PATTERN_ERROR_LIB" ;;
        # Fallback to jq for unlisted patterns
        *) echo "$schema" | jq -r "$path // \"\"" ;;
    esac
}

# Compute hash of schema and check scripts for cache invalidation
# Returns: 16-char hash of schema.json + all check scripts
compute_schema_hash() {
    local hash_input=""

    # Include schema.json content
    if [[ -f "$SCHEMA_PATH" ]]; then
        hash_input+=$(cat "$SCHEMA_PATH")
    fi

    # Include all check script contents
    if [[ -d "$CHECKS_DIR" ]]; then
        for check_script in "$CHECKS_DIR"/*.sh; do
            [[ -f "$check_script" ]] && hash_input+=$(cat "$check_script")
        done
    fi

    # Compute hash (first 16 chars)
    echo -n "$hash_input" | sha256sum | cut -c1-16
}

# Initialize cache (with schema hash validation)
init_cache() {
    mkdir -p "$CACHE_DIR"

    # Compute current schema hash
    local current_hash
    current_hash=$(compute_schema_hash)

    # Check if cache exists and is valid
    if [[ -f "$CACHE_FILE" ]] && [[ "$FORCE" != "true" ]]; then
        local cached_hash
        cached_hash=$(jq -r '.schemaHash // ""' "$CACHE_FILE" 2>/dev/null)

        if [[ "$cached_hash" != "$current_hash" ]]; then
            # Schema or check scripts changed - invalidate cache
            [[ "$QUIET" != "true" ]] && echo -e "${YELLOW}⚠${NC} Schema or checks changed, invalidating cache" >&2
            echo '{"files": {}, "lastRun": null, "schemaHash": "'"$current_hash"'"}' > "$CACHE_FILE"
        fi
    else
        # Create new cache with schema hash
        echo '{"files": {}, "lastRun": null, "schemaHash": "'"$current_hash"'"}' > "$CACHE_FILE"
    fi
}

# Load cache
load_cache_file() {
    if [[ -f "$CACHE_FILE" ]]; then
        cat "$CACHE_FILE"
    else
        echo '{"files": {}, "lastRun": null}'
    fi
}

# Discover untracked scripts (not in schema)
discover_untracked_scripts() {
    local schema="$1"

    local tracked_scripts
    tracked_scripts=$(echo "$schema" | jq -r '.commandScripts | values | .[]' | sort)

    local all_scripts
    all_scripts=$(ls "$SCRIPTS_DIR"/*.sh 2>/dev/null | xargs -n1 basename | grep -v '\.backup$' | sort)

    local dir_name
    dir_name=$(basename "$SCRIPTS_DIR")

    local untracked=()
    for script in $all_scripts; do
        if ! echo "$tracked_scripts" | grep -qx "$script"; then
            untracked+=("$script")
        fi
    done

    if [[ ${#untracked[@]} -eq 0 ]]; then
        echo -e "${GREEN}✓${NC} All scripts in ${dir_name}/ are tracked in schema"
        return 0
    fi

    echo -e "${YELLOW}⚠${NC} Found ${#untracked[@]} untracked script(s) in ${dir_name}/:"
    for script in "${untracked[@]}"; do
        local cmd_name="${script%.sh}"
        cmd_name="${cmd_name%-task}"
        cmd_name="${cmd_name%-command}"
        cmd_name="${cmd_name%-todowrite}"
        echo -e "  ${RED}•${NC} $script"
        echo -e "    ${DIM}Add to schema: \"$cmd_name\": \"$script\"${NC}"
    done

    echo ""
    echo -e "${CYAN}To add to schema, edit:${NC} $SCHEMA_PATH"
    echo -e "${DIM}Add entries to 'commandScripts' and appropriate 'commands' category${NC}"

    return 1
}

# Generate LLM-actionable fix suggestions for failed checks
generate_fix_suggestions() {
    local check_name="$1"
    local script_name="$2"
    local details="$3"

    case "$check_name" in
        "foundation_libs")
            cat << EOF
Add missing library sources at script top:
  source "\$LIB_DIR/core/exit-codes.sh" || source "\$CLAUDE_TODO_HOME/lib/core/exit-codes.sh"
  source "\$LIB_DIR/core/error-json.sh" || source "\$CLAUDE_TODO_HOME/lib/core/error-json.sh"
  source "\$LIB_DIR/core/output-format.sh" || source "\$CLAUDE_TODO_HOME/lib/core/output-format.sh"
EOF
            ;;
        "command_name")
            local suggested_name="${script_name%.sh}"
            suggested_name="${suggested_name%-task}"
            cat << EOF
Add COMMAND_NAME at script top after shebang:
  COMMAND_NAME="$suggested_name"
EOF
            ;;
        "version_central")
            cat << EOF
Add VERSION loading from central file:
  if [[ -f "\$CLAUDE_TODO_HOME/VERSION" ]]; then
      VERSION="\$(cat "\$CLAUDE_TODO_HOME/VERSION" | tr -d '[:space:]')"
  elif [[ -f "\$SCRIPT_DIR/../VERSION" ]]; then
      VERSION="\$(cat "\$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
  else
      VERSION="0.1.0"
  fi
EOF
            ;;
        "format_flag")
            cat << EOF
Add --format flag to argument parsing:
  -f|--format) FORMAT="\$2"; shift 2 ;;
EOF
            ;;
        "quiet_flag")
            cat << EOF
Add --quiet flag to argument parsing:
  -q|--quiet) QUIET=true; shift ;;
EOF
            ;;
        "json_shortcut")
            cat << EOF
Add --json shortcut to argument parsing:
  --json) FORMAT="json"; shift ;;
EOF
            ;;
        "human_shortcut")
            cat << EOF
Add --human shortcut to argument parsing:
  --human) FORMAT="text"; shift ;;
EOF
            ;;
        "resolve_format")
            cat << EOF
Call resolve_format() after argument parsing:
  FORMAT=\$(resolve_format "\$FORMAT")
EOF
            ;;
        "exit_constants"|"no_magic_numbers")
            cat << EOF
Replace magic exit numbers with constants from lib/core/exit-codes.sh:
  exit 0  → exit \$EXIT_SUCCESS
  exit 1  → exit \$EXIT_GENERAL_ERROR
  exit 2  → exit \$EXIT_USAGE_ERROR
EOF
            ;;
        "defensive_check")
            cat << EOF
Add defensive function check before using output_error():
  if declare -f output_error >/dev/null 2>&1; then
      output_error "E_CODE" "message" "\$FORMAT"
  else
      echo "ERROR: message" >&2
  fi
EOF
            ;;
        "consistent_usage")
            cat << EOF
Replace all exit statements with EXIT_* constants:
  exit 0  → exit \$EXIT_SUCCESS
  exit 1  → exit \$EXIT_GENERAL_ERROR

Use grep to find all exit statements:
  grep -n "exit [0-9]" scripts/<script>.sh
EOF
            ;;
        "output_error_usage")
            cat << EOF
Use output_error() for error messages:
  output_error "E_INVALID_INPUT" "Description of error" "\$FORMAT"
EOF
            ;;
        "schema_field"|"meta_block"|"success_field")
            cat << EOF
Ensure JSON output includes full envelope structure:
  {
    "\$schema": "https://claude-todo.dev/schemas/v1/output.schema.json",
    "_meta": {
      "command": "\$COMMAND_NAME",
      "timestamp": \$(date +%s),
      "version": "\$VERSION",
      "format": "json"
    },
    "success": true,
    ...
  }
EOF
            ;;
        "dry_run")
            cat << EOF
Add --dry-run flag for write commands:
  --dry-run) DRY_RUN=true; shift ;;

Then check before writes:
  if [[ "\$DRY_RUN" == "true" ]]; then
    echo "Would write: ..."
    exit 0
  fi
EOF
            ;;
        *)
            echo "See LLM-AGENT-FIRST-SPEC.md for compliance requirements"
            ;;
    esac
}

# Save cache (with schema hash for invalidation)
save_cache() {
    local results="$1"
    local timestamp
    timestamp=$(format_timestamp)

    # Compute current schema hash
    local schema_hash
    schema_hash=$(compute_schema_hash)

    # Build file hashes from results
    local file_hashes
    file_hashes=$(echo "$results" | jq -r '
        [.commands[] | {
            key: .script,
            value: {hash: .hash, score: .score, lastChecked: "'"$timestamp"'"}
        }] | from_entries
    ' 2>/dev/null || echo "{}")

    jq -n \
        --argjson files "$file_hashes" \
        --arg lastRun "$timestamp" \
        --arg schemaHash "$schema_hash" \
        '{files: $files, lastRun: $lastRun, schemaHash: $schemaHash}' > "$CACHE_FILE"
}

# Get list of scripts to check
get_scripts_to_check() {
    local schema="$1"
    local cache="$2"

    local scripts=()

    # Get all command scripts from schema
    local all_commands
    all_commands=$(echo "$schema" | jq -r '.commandScripts | to_entries[] | "\(.key):\(.value)"')

    for entry in $all_commands; do
        local cmd="${entry%%:*}"
        local script="${entry#*:}"
        local script_path="$SCRIPTS_DIR/$script"

        # Filter by specific command if provided
        if [[ -n "$SPECIFIC_COMMAND" ]]; then
            if ! echo "$SPECIFIC_COMMAND" | tr ',' '\n' | grep -qx "$cmd"; then
                continue
            fi
        fi

        # Check if file exists
        if [[ ! -f "$script_path" ]]; then
            continue
        fi

        # Check if changed (incremental mode)
        if [[ "$INCREMENTAL" == "true" ]] && [[ "$FORCE" != "true" ]]; then
            local current_hash
            current_hash=$(get_file_hash "$script_path")
            local cached_hash
            cached_hash=$(echo "$cache" | jq -r ".files[\"$script\"].hash // empty")

            if [[ "$current_hash" == "$cached_hash" ]]; then
                continue
            fi
        fi

        scripts+=("$cmd:$script")
    done

    printf '%s\n' "${scripts[@]}"
}

# Run static checks on a script
run_static_checks() {
    local script_path="$1"
    local command_name="$2"
    local schema="$3"

    local results=()

    # Run each static check
    for check_script in "$CHECKS_DIR"/*.sh; do
        local check_name
        check_name=$(basename "$check_script" .sh)

        # Skip json-envelope (runtime check)
        [[ "$check_name" == "json-envelope" ]] && continue

        # Filter by specific check if provided
        if [[ -n "$SPECIFIC_CHECK" ]] && [[ "$check_name" != "$SPECIFIC_CHECK" ]]; then
            continue
        fi

        local result
        case "$check_name" in
            flags)
                result=$(source "$check_script" && check_flags "$script_path" "$schema" "$command_name" "$VERBOSE")
                ;;
            *)
                result=$(source "$check_script" && "check_${check_name//-/_}" "$script_path" "$schema" "$VERBOSE")
                ;;
        esac

        results+=("$result")
    done

    printf '%s\n' "${results[@]}" | jq -s '.'
}

# Run runtime JSON envelope check
run_runtime_check() {
    local command_name="$1"
    local schema="$2"

    if [[ "$STATIC_ONLY" == "true" ]]; then
        echo '{"skipped": true, "reason": "static-only mode"}'
        return
    fi

    # Dev scripts don't have JSON output requirements - skip runtime check
    if [[ "$DEV_SCRIPTS_MODE" == "true" ]]; then
        echo '{"skipped": true, "reason": "dev-scripts mode (no JSON output requirement)"}'
        return
    fi

    if [[ -n "$SPECIFIC_CHECK" ]] && [[ "$SPECIFIC_CHECK" != "json-envelope" ]]; then
        echo '{"skipped": true, "reason": "check filter"}'
        return
    fi

    source "$CHECKS_DIR/json-envelope.sh"
    check_json_envelope "$command_name" "$schema" "$VERBOSE"
}

# Aggregate results for a command
aggregate_command_results() {
    local static_results="$1"
    local runtime_result="$2"

    local total_passed=0
    local total_failed=0
    local total_skipped=0

    # Sum static results (with error handling)
    local static_passed static_failed static_skipped
    static_passed=$(echo "$static_results" | jq '[.[].passed] | add // 0' 2>/dev/null) || static_passed=0
    static_failed=$(echo "$static_results" | jq '[.[].failed] | add // 0' 2>/dev/null) || static_failed=0
    static_skipped=$(echo "$static_results" | jq '[.[].skipped // 0] | add // 0' 2>/dev/null) || static_skipped=0

    # Ensure numeric values
    [[ -z "$static_passed" || "$static_passed" == "null" ]] && static_passed=0
    [[ -z "$static_failed" || "$static_failed" == "null" ]] && static_failed=0
    [[ -z "$static_skipped" || "$static_skipped" == "null" ]] && static_skipped=0

    total_passed=$((total_passed + static_passed))
    total_failed=$((total_failed + static_failed))
    total_skipped=$((total_skipped + static_skipped))

    # Add runtime results if not skipped
    if ! echo "$runtime_result" | jq -e '.skipped' &>/dev/null; then
        local runtime_passed runtime_failed runtime_skipped
        runtime_passed=$(echo "$runtime_result" | jq '.passed // 0')
        runtime_failed=$(echo "$runtime_result" | jq '.failed // 0')
        runtime_skipped=$(echo "$runtime_result" | jq '.skipped // 0')

        total_passed=$((total_passed + runtime_passed))
        total_failed=$((total_failed + runtime_failed))
        total_skipped=$((total_skipped + runtime_skipped))
    fi

    local total=$((total_passed + total_failed))
    local score
    if [[ "$total" -gt 0 ]]; then
        score=$(calc_score "$total_passed" "$total")
    else
        score="100"
    fi

    jq -n \
        --argjson passed "$total_passed" \
        --argjson failed "$total_failed" \
        --argjson skipped "$total_skipped" \
        --argjson total "$total" \
        --arg score "$score" \
        '{passed: $passed, failed: $failed, skipped: $skipped, total: $total, score: ($score | tonumber)}'
}

# Format output as text
format_text_output() {
    local results="$1"
    local schema="$2"

    local schema_version spec_version
    schema_version=$(echo "$schema" | jq -r '.version')
    spec_version=$(echo "$schema" | jq -r '.specVersion')

    echo ""
    echo -e "${BOLD}LLM-Agent-First Compliance Check${NC}"
    echo "================================"
    echo -e "Schema Version: ${CYAN}$schema_version${NC} | Spec Version: ${CYAN}$spec_version${NC}"

    local cmd_count
    cmd_count=$(echo "$results" | jq '.commands | length')
    echo -e "Commands: ${BOLD}$cmd_count${NC}"
    echo ""

    # Per-command results
    echo "$results" | jq -r '.commands[] | "\(.command)|\(.script)|\(.score)|\(.passed)|\(.total)"' 2>/dev/null | while IFS='|' read -r cmd script score passed total; do
        # Skip invalid entries
        [[ -z "$cmd" || -z "$total" || "$total" == "null" || "$total" == "0" ]] && continue

        local score_int="${score%.*}"
        [[ -z "$score_int" ]] && score_int=0
        local color="$GREEN"
        [[ "$score_int" -lt 95 ]] && color="$YELLOW"
        [[ "$score_int" -lt 80 ]] && color="$RED"

        printf "[%-20s] " "$cmd"

        # Progress dots (with safe arithmetic)
        local dots=0
        local spaces=50
        if [[ "$total" -gt 0 ]]; then
            dots=$((passed * 50 / total))
            spaces=$((50 - dots))
        fi
        [[ "$dots" -lt 1 ]] && dots=1
        [[ "$spaces" -lt 0 ]] && spaces=0

        printf "%s" "$(printf '.%.0s' $(seq 1 $dots))"
        [[ "$spaces" -gt 0 ]] && printf "%s" "$(printf ' %.0s' $(seq 1 $spaces))"

        echo -e " ${color}${score}%${NC} (${passed}/${total})"
    done

    # Summary
    local summary
    summary=$(echo "$results" | jq '.summary')

    local total_cmds passed_cmds partial_cmds failed_cmds overall_score
    total_cmds=$(echo "$summary" | jq '.totalCommands')
    passed_cmds=$(echo "$summary" | jq '.passed')
    partial_cmds=$(echo "$summary" | jq '.partial')
    failed_cmds=$(echo "$summary" | jq '.failed')
    overall_score=$(echo "$summary" | jq '.overallScore')

    echo ""
    echo -e "${BOLD}Summary${NC}"
    echo "-------"
    echo -e "Total: ${BOLD}$total_cmds${NC} commands"
    echo -e "Passed (100%): ${GREEN}$passed_cmds${NC}"
    echo -e "Partial (<100%): ${YELLOW}$partial_cmds${NC}"
    echo -e "Failed (<80%): ${RED}$failed_cmds${NC}"
    echo ""
    echo -e "Overall Compliance: ${BOLD}${overall_score}%${NC}"

    # CI threshold check
    if [[ "$CI_MODE" == "true" ]]; then
        local score_int="${overall_score%.*}"
        if [[ "$score_int" -ge "$THRESHOLD" ]]; then
            echo -e "\n${GREEN}✓ CI Check PASSED (≥${THRESHOLD}%)${NC}"
        else
            echo -e "\n${RED}✗ CI Check FAILED (<${THRESHOLD}%)${NC}"
        fi
    fi

    # LLM-actionable fix suggestions
    if [[ "$SUGGEST_FIXES" == "true" ]]; then
        local failures
        failures=$(echo "$results" | jq -c '[.commands[] | select(.score < 100) | {command: .command, script: .script, checks: [.checks[]?.checks[]? | select(.passed == false)]}]' 2>/dev/null)

        local failure_count
        failure_count=$(echo "$failures" | jq 'length')

        if [[ "$failure_count" -gt 0 ]]; then
            echo ""
            echo -e "${BOLD}${CYAN}Fix Suggestions (LLM-Actionable)${NC}"
            echo "================================="

            echo "$failures" | jq -c '.[]' | while read -r failure; do
                local cmd script
                cmd=$(echo "$failure" | jq -r '.command')
                script=$(echo "$failure" | jq -r '.script')

                echo ""
                echo -e "${BOLD}$cmd${NC} ($script)"
                echo -e "${DIM}$(printf '%.0s─' {1..50})${NC}"

                echo "$failure" | jq -r '.checks[] | .check' | while read -r check; do
                    echo -e "\n${YELLOW}Fix: $check${NC}"
                    generate_fix_suggestions "$check" "$script" ""
                done
            done
        fi
    fi
}

# Format output as JSON
format_json_output() {
    local results="$1"
    local schema="$2"

    local schema_version spec_version timestamp
    schema_version=$(echo "$schema" | jq -r '.version')
    spec_version=$(echo "$schema" | jq -r '.specVersion')
    timestamp=$(format_timestamp)

    local base_output
    base_output=$(echo "$results" | jq \
        --arg schemaVersion "$schema_version" \
        --arg specVersion "$spec_version" \
        --arg timestamp "$timestamp" \
        --arg toolVersion "$TOOL_VERSION" \
        --argjson threshold "$THRESHOLD" \
        --argjson ciMode "$CI_MODE" \
        --argjson suggestFixes "$SUGGEST_FIXES" \
        '{
            "$schema": "https://claude-todo.dev/schemas/v1/compliance-report.schema.json",
            "_meta": {
                "format": "json",
                "command": "check-compliance",
                "version": $toolVersion,
                "timestamp": $timestamp,
                "schemaVersion": $schemaVersion,
                "specVersion": $specVersion,
                "ciMode": $ciMode,
                "threshold": $threshold,
                "suggestFixes": $suggestFixes
            },
            "success": true,
            "summary": .summary,
            "commands": .commands,
            "failures": [.commands[] | select(.score < 100) | {command: .command, script: .script, score: .score, failed_checks: [.checks[]?.checks[]? | select(.passed == false) | .check]}]
        }')

    # Add fix suggestions to failures if enabled
    if [[ "$SUGGEST_FIXES" == "true" ]]; then
        # Use secure temp file (mktemp) instead of predictable /tmp path
        local tmp_suggestions
        tmp_suggestions=$(mktemp "${TMPDIR:-/tmp}/fix_suggestions.XXXXXX")
        trap "rm -f '$tmp_suggestions'" EXIT

        echo "$base_output" | jq -r '.failures[] | "\(.command)|\(.script)|\(.failed_checks | join(","))"' 2>/dev/null | while read -r line; do
            [[ -z "$line" ]] && continue
            local cmd script checks
            cmd=$(echo "$line" | cut -d'|' -f1)
            script=$(echo "$line" | cut -d'|' -f2)
            checks=$(echo "$line" | cut -d'|' -f3)

            echo "$checks" | tr ',' '\n' | while read -r check; do
                [[ -z "$check" ]] && continue
                local fix
                fix=$(generate_fix_suggestions "$check" "$script" "" | jq -Rs '.')
                echo "{\"$check\": $fix}"
            done
        done | jq -s 'add // {}' > "$tmp_suggestions"

        # Merge suggestions into output
        echo "$base_output" | jq --slurpfile fixes "$tmp_suggestions" '. + {fix_suggestions: $fixes[0]}'
        rm -f "$tmp_suggestions"
    else
        echo "$base_output"
    fi
}

# Format output as markdown
format_markdown_output() {
    local results="$1"
    local schema="$2"

    local schema_version spec_version
    schema_version=$(echo "$schema" | jq -r '.version')
    spec_version=$(echo "$schema" | jq -r '.specVersion')

    cat << EOF
# LLM-Agent-First Compliance Report

**Schema Version:** $schema_version | **Spec Version:** $spec_version
**Generated:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Summary

| Metric | Value |
|--------|-------|
EOF

    echo "$results" | jq -r '.summary | "| Total Commands | \(.totalCommands) |"'
    echo "$results" | jq -r '.summary | "| Passed (100%) | \(.passed) |"'
    echo "$results" | jq -r '.summary | "| Partial (<100%) | \(.partial) |"'
    echo "$results" | jq -r '.summary | "| Failed (<80%) | \(.failed) |"'
    echo "$results" | jq -r '.summary | "| **Overall Score** | **\(.overallScore)%** |"'

    echo ""
    echo "## Command Results"
    echo ""
    echo "| Command | Script | Score | Status |"
    echo "|---------|--------|-------|--------|"

    echo "$results" | jq -r '.commands[] |
        "| \(.command) | \(.script) | \(.score)% | " +
        (if .score >= 100 then "✅" elif .score >= 80 then "⚠️" else "❌" end) + " |"'

    # Failures section
    local failures
    failures=$(echo "$results" | jq '[.commands[] | select(.score < 100)]')
    local failure_count
    failure_count=$(echo "$failures" | jq 'length')

    if [[ "$failure_count" -gt 0 ]]; then
        echo ""
        echo "## Issues Found"
        echo ""

        echo "$failures" | jq -r '.[] | "### \(.command) (\(.score)%)\n" + ([.checks[]? | select(.passed == false) | "- ❌ \(.check): \(.details)"] | join("\n")) + "\n"'
    fi
}

# Format output as ASCII table
format_table_output() {
    local results="$1"
    local schema="$2"

    # Table header
    printf "%-22s %-28s %8s %8s %8s\n" "COMMAND" "SCRIPT" "SCORE" "PASSED" "FAILED"
    printf "%-22s %-28s %8s %8s %8s\n" "$(printf '%.0s-' {1..22})" "$(printf '%.0s-' {1..28})" "--------" "--------" "--------"

    # Table rows
    echo "$results" | jq -r '.commands[] | "\(.command)|\(.script)|\(.score)|\(.passed)|\(.failed)"' 2>/dev/null | while IFS='|' read -r cmd script score passed failed; do
        [[ -z "$cmd" ]] && continue
        printf "%-22s %-28s %7.1f%% %8s %8s\n" "$cmd" "$script" "$score" "$passed" "$failed"
    done

    # Summary footer
    echo ""
    local summary
    summary=$(echo "$results" | jq '.summary')
    local total passed partial failed overall
    total=$(echo "$summary" | jq '.totalCommands')
    passed=$(echo "$summary" | jq '.passed')
    partial=$(echo "$summary" | jq '.partial')
    failed=$(echo "$summary" | jq '.failed')
    overall=$(echo "$summary" | jq '.overallScore')

    printf "%-22s %-28s %8s\n" "" "TOTAL: $total commands" "${overall}%"
    printf "%-22s %-28s\n" "" "Passed: $passed | Partial: $partial | Failed: $failed"
}

# Main execution
main() {
    parse_args "$@"

    # CI mode forces full check - incremental is non-deterministic in CI
    if [[ "$CI_MODE" == "true" ]] && [[ "$INCREMENTAL" == "true" ]]; then
        if [[ "$QUIET" != "true" ]]; then
            echo -e "${YELLOW}⚠${NC} CI mode forces full check, ignoring --incremental" >&2
        fi
        INCREMENTAL=false
    fi

    # Resolve format (TTY-aware for LLM-Agent-First)
    FORMAT=$(dev_resolve_format "$FORMAT")

    # Dev scripts mode - use different schema and paths
    if [[ "$DEV_SCRIPTS_MODE" == "true" ]]; then
        SCHEMA_PATH="$DEV_SCRIPTS_SCHEMA"
        SCRIPTS_DIR="$PROJECT_ROOT/dev"
        CACHE_FILE="$CACHE_DIR/dev-cache.json"

        if [[ ! -f "$SCHEMA_PATH" ]]; then
            output_compliance_error "E_DEV_SCHEMA_NOT_FOUND" \
                "Dev scripts schema not found: $SCHEMA_PATH" \
                "$DEV_EXIT_NOT_FOUND" \
                true \
                "Create it with: ./dev/check-compliance.sh --init-dev-schema"
            exit $DEV_EXIT_NOT_FOUND
        fi
    fi

    # Load schema
    local schema
    schema=$(load_schema_file)

    # Pre-extract patterns for performance (reduces ~480 jq calls to ~20)
    preextract_schema_patterns "$schema"

    # Discovery mode - find untracked scripts and exit
    if [[ "$DISCOVER_MODE" == "true" ]]; then
        local target_name="Script"
        [[ "$DEV_SCRIPTS_MODE" == "true" ]] && target_name="Dev Script"
        echo -e "\n${BOLD}${target_name} Discovery${NC}"
        echo "================"
        discover_untracked_scripts "$schema"
        exit $?
    fi

    # Initialize cache
    init_cache
    local cache
    cache=$(load_cache_file)

    # Get scripts to check
    local scripts_list
    scripts_list=$(get_scripts_to_check "$schema" "$cache")

    if [[ -z "$scripts_list" ]]; then
        if [[ "$INCREMENTAL" == "true" ]]; then
            [[ "$QUIET" != "true" ]] && log_info "No changed files to check."
            exit $DEV_EXIT_SUCCESS
        else
            output_compliance_error "E_NO_SCRIPTS" \
                "No scripts found to check" \
                "$DEV_EXIT_NOT_FOUND" \
                true \
                "Verify schema.json has commandScripts entries, or check --command filter matches script names"
            exit $DEV_EXIT_NOT_FOUND
        fi
    fi

    # Setup runtime test fixture if needed
    if [[ "$STATIC_ONLY" != "true" ]] && { [[ -z "$SPECIFIC_CHECK" ]] || [[ "$SPECIFIC_CHECK" == "json-envelope" ]]; }; then
        source "$CHECKS_DIR/json-envelope.sh"
        setup_fixture >/dev/null
    fi

    # Run checks
    local all_results=()
    local total_passed=0
    local total_failed=0
    local total_checks=0

    [[ "$VERBOSE" == "true" ]] && [[ "$FORMAT" == "text" ]] && echo -e "\n${BOLD}Running compliance checks...${NC}\n"

    while IFS= read -r entry; do
        [[ -z "$entry" ]] && continue

        local cmd="${entry%%:*}"
        local script="${entry#*:}"
        local script_path="$SCRIPTS_DIR/$script"

        [[ "$VERBOSE" == "true" ]] && [[ "$FORMAT" == "text" ]] && print_header "$cmd ($script)"

        # Run static checks
        local static_results
        static_results=$(run_static_checks "$script_path" "$cmd" "$schema")

        # Run runtime check
        local runtime_result
        runtime_result=$(run_runtime_check "$cmd" "$schema")

        # Aggregate
        local cmd_results
        cmd_results=$(aggregate_command_results "$static_results" "$runtime_result")

        local passed failed cmd_total score
        passed=$(echo "$cmd_results" | jq '.passed')
        failed=$(echo "$cmd_results" | jq '.failed')
        cmd_total=$(echo "$cmd_results" | jq '.total')
        score=$(echo "$cmd_results" | jq '.score')

        total_passed=$((total_passed + passed))
        total_failed=$((total_failed + failed))
        total_checks=$((total_checks + passed + failed))

        # Get file hash for caching
        local file_hash
        file_hash=$(get_file_hash "$script_path")

        # Build command result
        local cmd_json
        cmd_json=$(jq -n \
            --arg command "$cmd" \
            --arg script "$script" \
            --arg hash "$file_hash" \
            --argjson passed "$passed" \
            --argjson failed "$failed" \
            --argjson total "$cmd_total" \
            --arg score "$score" \
            --argjson static "$static_results" \
            --argjson runtime "$runtime_result" \
            '{
                command: $command,
                script: $script,
                hash: $hash,
                passed: $passed,
                failed: $failed,
                total: $total,
                score: ($score | tonumber),
                checks: ($static + [$runtime] | map(select(.skipped != true)))
            }')

        all_results+=("$cmd_json")
    done <<< "$scripts_list"

    # Cleanup runtime fixture
    if [[ "$STATIC_ONLY" != "true" ]]; then
        cleanup_fixture 2>/dev/null || true
    fi

    # Calculate summary
    local overall_score
    if [[ "$total_checks" -gt 0 ]]; then
        overall_score=$(calc_score "$total_passed" "$total_checks")
    else
        overall_score="100"
    fi

    local cmd_count passed_cmds partial_cmds failed_cmds
    cmd_count=$(printf '%s\n' "${all_results[@]}" | jq -s 'length')
    passed_cmds=$(printf '%s\n' "${all_results[@]}" | jq -s '[.[] | select(.score >= 100)] | length')
    partial_cmds=$(printf '%s\n' "${all_results[@]}" | jq -s '[.[] | select(.score < 100 and .score >= 80)] | length')
    failed_cmds=$(printf '%s\n' "${all_results[@]}" | jq -s '[.[] | select(.score < 80)] | length')

    # Build final results
    # NOTE: Use stdin piping for commands array to avoid "Argument list too long" error
    # when all_results contains many command check results (jq --argjson has ARG_MAX limit)
    local final_results
    final_results=$(printf '%s\n' "${all_results[@]}" | jq -s \
        --argjson totalCommands "$cmd_count" \
        --argjson passed "$passed_cmds" \
        --argjson partial "$partial_cmds" \
        --argjson failed "$failed_cmds" \
        --arg overallScore "$overall_score" \
        '{
            summary: {
                totalCommands: $totalCommands,
                passed: $passed,
                partial: $partial,
                failed: $failed,
                overallScore: ($overallScore | tonumber)
            },
            commands: .
        }')

    # Save cache
    save_cache "$final_results"

    # Output results
    case "$FORMAT" in
        json)
            format_json_output "$final_results" "$schema"
            ;;
        jsonl)
            # JSON Lines: one object per command for streaming
            echo "$final_results" | jq -c '.commands[]'
            ;;
        markdown)
            format_markdown_output "$final_results" "$schema"
            ;;
        table)
            # ASCII table format for terminal display
            format_table_output "$final_results" "$schema"
            ;;
        *)
            format_text_output "$final_results" "$schema"
            ;;
    esac

    # CI exit code
    if [[ "$CI_MODE" == "true" ]]; then
        local score_int="${overall_score%.*}"
        if [[ "$score_int" -lt "$THRESHOLD" ]]; then
            exit $DEV_EXIT_COMPLIANCE_FAILED
        fi
    fi

    exit $DEV_EXIT_SUCCESS
}

main "$@"
