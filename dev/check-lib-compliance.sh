#!/usr/bin/env bash
# check-lib-compliance.sh - Validate lib/*.sh against LIBRARY-ARCHITECTURE-SPEC.md
#
# This script validates library architecture compliance including:
#   - Source guards present (required pattern)
#   - Layer headers present (LAYER/DEPENDENCIES/PROVIDES)
#   - No circular dependencies
#   - Dependency count <=3 per file
#
# Usage:
#   ./dev/check-lib-compliance.sh                    # Full compliance check
#   ./dev/check-lib-compliance.sh --check guard      # Check source guards only
#   ./dev/check-lib-compliance.sh --check header     # Check layer headers only
#   ./dev/check-lib-compliance.sh --check circular   # Check circular deps only
#   ./dev/check-lib-compliance.sh --check count      # Check dependency count only
#   ./dev/check-lib-compliance.sh --format json      # JSON output
#   ./dev/check-lib-compliance.sh --fix              # Attempt to fix issues (future)
#
# Follows LLM-Agent-First principles:
#   - JSON output by default for non-TTY
#   - --format, --quiet, --json, --human flags
#   - Structured _meta envelope
#   - DEV_EXIT_* constants

set -euo pipefail

# ============================================================================
# SETUP - LLM-Agent-First compliant
# ============================================================================

# Script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_LIB_DIR="$SCRIPT_DIR/lib"

# Source dev library
source "$DEV_LIB_DIR/dev-common.sh"

# Command identification
COMMAND_NAME="check-lib-compliance"

# Project paths
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$PROJECT_ROOT/lib"
SPEC_PATH="$PROJECT_ROOT/docs/specs/LIBRARY-ARCHITECTURE-SPEC.md"

# Version
TOOL_VERSION="1.0.0"

# ============================================================================
# DEFAULT OPTIONS
# ============================================================================

FORMAT=""
VERBOSE=false
QUIET=false
SPECIFIC_CHECK=""
FIX_MODE=false

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << EOF
Library Architecture Compliance Validator v${TOOL_VERSION}

Usage: $(basename "$0") [OPTIONS]

Options:
  -c, --check <type>      Which check to run
                          (guard, header, circular, count, all)
                          Default: all
  -f, --format <format>   Output format: text, json
                          (default: json for non-TTY, text for TTY)
      --json              JSON output shortcut
      --human             Human/text output shortcut
      --fix               Attempt to fix issues (placeholder)
  -v, --verbose           Show detailed check output
  -q, --quiet             Only show failures and summary
  -h, --help              Show this help message
      --version           Show version

Check Types:
  guard     - Source guard pattern present (prevents double-loading)
  header    - Layer header comments (LAYER/DEPENDENCIES/PROVIDES)
  circular  - No circular dependency chains
  count     - Dependency count <=3 per library
  all       - Run all checks (default)

Examples:
  $(basename "$0")                          # Full compliance check
  $(basename "$0") --check guard            # Only check source guards
  $(basename "$0") --check circular --json  # Check circular deps, JSON output
  $(basename "$0") --verbose                # Detailed output

Validates against: docs/specs/LIBRARY-ARCHITECTURE-SPEC.md
EOF
}

# ============================================================================
# ARGUMENT PARSING
# ============================================================================

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -c|--check)
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
            --fix)
                FIX_MODE=true
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
                echo "check-lib-compliance v${TOOL_VERSION}"
                exit $DEV_EXIT_SUCCESS
                ;;
            *)
                log_error "Unknown option: $1"
                usage >&2
                exit $DEV_EXIT_INVALID_INPUT
                ;;
        esac
    done

    # Validate check type if specified
    if [[ -n "$SPECIFIC_CHECK" ]]; then
        case "$SPECIFIC_CHECK" in
            guard|header|circular|count|all)
                # Valid check type
                ;;
            *)
                log_error "Invalid check type: $SPECIFIC_CHECK"
                log_error "Valid types: guard, header, circular, count, all"
                exit $DEV_EXIT_INVALID_INPUT
                ;;
        esac
    fi
}

# ============================================================================
# PLACEHOLDER CHECK FUNCTIONS
# These will be implemented in separate tasks
# ============================================================================

# Check source guards are present in all library files
# Pattern: [[ -n "${_<LIBNAME>_LOADED:-}" ]] && return 0
# Args: none (operates on LIB_DIR)
# Returns: JSON with passed/issues
check_source_guards() {
    local files_checked=0
    local issues_found=0
    local issues_json="[]"

    # Placeholder: Will scan lib/*.sh for source guard pattern
    for lib_file in "$LIB_DIR"/*.sh; do
        [[ -f "$lib_file" ]] || continue
        files_checked=$((files_checked + 1))
        # TODO: Implement actual check
        # Pattern to look for: [[ -n "${_.*_LOADED:-}" ]] && return 0
    done

    local passed=true
    [[ "$issues_found" -gt 0 ]] && passed=false

    jq -n \
        --arg check "source_guards" \
        --argjson passed "$passed" \
        --argjson files_checked "$files_checked" \
        --argjson issues_found "$issues_found" \
        --argjson issues "$issues_json" \
        '{
            check: $check,
            passed: $passed,
            files_checked: $files_checked,
            issues_found: $issues_found,
            issues: $issues
        }'
}

# Check layer headers are present (LAYER/DEPENDENCIES/PROVIDES)
# Args: none (operates on LIB_DIR)
# Returns: JSON with passed/issues
check_layer_headers() {
    local files_checked=0
    local issues_found=0
    local issues_json="[]"

    # Placeholder: Will scan lib/*.sh for layer header comments
    for lib_file in "$LIB_DIR"/*.sh; do
        [[ -f "$lib_file" ]] || continue
        files_checked=$((files_checked + 1))
        # TODO: Implement actual check
        # Look for: # LAYER: <0|1|2|3>
        #           # DEPENDENCIES: <list or "none">
        #           # PROVIDES: <list of functions>
    done

    local passed=true
    [[ "$issues_found" -gt 0 ]] && passed=false

    jq -n \
        --arg check "layer_headers" \
        --argjson passed "$passed" \
        --argjson files_checked "$files_checked" \
        --argjson issues_found "$issues_found" \
        --argjson issues "$issues_json" \
        '{
            check: $check,
            passed: $passed,
            files_checked: $files_checked,
            issues_found: $issues_found,
            issues: $issues
        }'
}

# Check for circular dependencies between libraries
# Args: none (operates on LIB_DIR)
# Returns: JSON with passed/issues
check_circular_deps() {
    local files_checked=0
    local issues_found=0
    local issues_json="[]"

    # Placeholder: Will build dependency graph and detect cycles
    for lib_file in "$LIB_DIR"/*.sh; do
        [[ -f "$lib_file" ]] || continue
        files_checked=$((files_checked + 1))
        # TODO: Implement actual check
        # 1. Parse source statements to build dep graph
        # 2. Use DFS to detect cycles
    done

    local passed=true
    [[ "$issues_found" -gt 0 ]] && passed=false

    jq -n \
        --arg check "circular_deps" \
        --argjson passed "$passed" \
        --argjson files_checked "$files_checked" \
        --argjson issues_found "$issues_found" \
        --argjson issues "$issues_json" \
        '{
            check: $check,
            passed: $passed,
            files_checked: $files_checked,
            issues_found: $issues_found,
            issues: $issues
        }'
}

# Check dependency count is <=3 per library file
# Args: none (operates on LIB_DIR)
# Returns: JSON with passed/issues
check_dependency_count() {
    local files_checked=0
    local issues_found=0
    local issues_json="[]"

    # Placeholder: Will count source statements per file
    for lib_file in "$LIB_DIR"/*.sh; do
        [[ -f "$lib_file" ]] || continue
        files_checked=$((files_checked + 1))
        # TODO: Implement actual check
        # Count: grep -c "^source " or similar
        # Flag if count > 3
    done

    local passed=true
    [[ "$issues_found" -gt 0 ]] && passed=false

    jq -n \
        --arg check "dependency_count" \
        --argjson passed "$passed" \
        --argjson files_checked "$files_checked" \
        --argjson issues_found "$issues_found" \
        --argjson issues "$issues_json" \
        '{
            check: $check,
            passed: $passed,
            files_checked: $files_checked,
            issues_found: $issues_found,
            issues: $issues
        }'
}

# ============================================================================
# RESULT AGGREGATION
# ============================================================================

# Aggregate all check results into summary
# Args: $1 = JSON array of check results
# Returns: JSON summary object
aggregate_results() {
    local checks_json="$1"

    local files_checked
    local issues_found
    local checks_passed
    local checks_failed

    files_checked=$(echo "$checks_json" | jq '[.[].files_checked] | add // 0')
    issues_found=$(echo "$checks_json" | jq '[.[].issues_found] | add // 0')
    checks_passed=$(echo "$checks_json" | jq '[.[] | select(.passed == true)] | length')
    checks_failed=$(echo "$checks_json" | jq '[.[] | select(.passed == false)] | length')

    jq -n \
        --argjson files_checked "$files_checked" \
        --argjson issues_found "$issues_found" \
        --argjson checks_passed "$checks_passed" \
        --argjson checks_failed "$checks_failed" \
        '{
            files_checked: $files_checked,
            issues_found: $issues_found,
            checks_passed: $checks_passed,
            checks_failed: $checks_failed
        }'
}

# ============================================================================
# OUTPUT FORMATTING
# ============================================================================

# Format output as JSON envelope
# Args: $1 = success (true/false), $2 = summary JSON, $3 = checks JSON
format_json_output() {
    local success="$1"
    local summary="$2"
    local checks="$3"

    local timestamp
    timestamp=$(dev_timestamp)

    jq -n \
        --arg cmd "$COMMAND_NAME" \
        --arg ts "$timestamp" \
        --arg ver "$TOOL_VERSION" \
        --argjson success "$success" \
        --argjson summary "$summary" \
        --argjson checks "$checks" \
        '{
            "_meta": {
                "command": $cmd,
                "timestamp": $ts,
                "version": $ver
            },
            "success": $success,
            "summary": $summary,
            "checks": {
                "source_guards": ($checks | map(select(.check == "source_guards")) | .[0] // null),
                "layer_headers": ($checks | map(select(.check == "layer_headers")) | .[0] // null),
                "circular_deps": ($checks | map(select(.check == "circular_deps")) | .[0] // null),
                "dependency_count": ($checks | map(select(.check == "dependency_count")) | .[0] // null)
            }
        }'
}

# Format output as human-readable text
# Args: $1 = success (true/false), $2 = summary JSON, $3 = checks JSON
format_text_output() {
    local success="$1"
    local summary="$2"
    local checks="$3"

    echo ""
    echo -e "${BOLD:-}Library Architecture Compliance Check${NC:-}"
    echo "======================================"
    echo -e "Spec: ${CYAN:-}LIBRARY-ARCHITECTURE-SPEC.md${NC:-}"
    echo ""

    # Per-check results
    echo "$checks" | jq -r '.[] | "\(.check)|\(.passed)|\(.files_checked)|\(.issues_found)"' | while IFS='|' read -r check passed files issues; do
        local status_icon
        if [[ "$passed" == "true" ]]; then
            status_icon="${GREEN:-}[PASS]${NC:-}"
        else
            status_icon="${RED:-}[FAIL]${NC:-}"
        fi
        printf "%s %-20s (files: %s, issues: %s)\n" "$status_icon" "$check" "$files" "$issues"
    done

    echo ""
    echo -e "${BOLD:-}Summary${NC:-}"
    echo "-------"
    echo "$summary" | jq -r '"Files checked: \(.files_checked)\nIssues found: \(.issues_found)\nChecks passed: \(.checks_passed)\nChecks failed: \(.checks_failed)"'

    echo ""
    if [[ "$success" == "true" ]]; then
        echo -e "${GREEN:-}All checks passed.${NC:-}"
    else
        echo -e "${RED:-}Some checks failed.${NC:-}"
    fi
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
    parse_args "$@"

    # Resolve format (TTY-aware for LLM-Agent-First)
    FORMAT=$(dev_resolve_format "$FORMAT")

    # Verify lib directory exists
    if [[ ! -d "$LIB_DIR" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -n \
                --arg cmd "$COMMAND_NAME" \
                --arg ts "$(dev_timestamp)" \
                --arg ver "$TOOL_VERSION" \
                --arg msg "Library directory not found: $LIB_DIR" \
                '{
                    "_meta": {"command": $cmd, "timestamp": $ts, "version": $ver},
                    "success": false,
                    "error": {"code": "E_NOT_FOUND", "message": $msg}
                }'
        else
            log_error "Library directory not found: $LIB_DIR"
        fi
        exit $DEV_EXIT_NOT_FOUND
    fi

    # Fix mode placeholder
    if [[ "$FIX_MODE" == "true" ]]; then
        if [[ "$FORMAT" == "text" ]]; then
            log_info "Fix mode is not yet implemented. Running check-only mode."
        fi
    fi

    # Run selected checks
    local all_checks=()

    case "${SPECIFIC_CHECK:-all}" in
        guard)
            all_checks+=("$(check_source_guards)")
            ;;
        header)
            all_checks+=("$(check_layer_headers)")
            ;;
        circular)
            all_checks+=("$(check_circular_deps)")
            ;;
        count)
            all_checks+=("$(check_dependency_count)")
            ;;
        all|"")
            all_checks+=("$(check_source_guards)")
            all_checks+=("$(check_layer_headers)")
            all_checks+=("$(check_circular_deps)")
            all_checks+=("$(check_dependency_count)")
            ;;
    esac

    # Combine check results into JSON array
    local checks_json
    checks_json=$(printf '%s\n' "${all_checks[@]}" | jq -s '.')

    # Aggregate summary
    local summary
    summary=$(aggregate_results "$checks_json")

    # Determine overall success
    local success=true
    local checks_failed
    checks_failed=$(echo "$summary" | jq '.checks_failed')
    [[ "$checks_failed" -gt 0 ]] && success=false

    # Output results
    if [[ "$FORMAT" == "json" ]]; then
        format_json_output "$success" "$summary" "$checks_json"
    else
        format_text_output "$success" "$summary" "$checks_json"
    fi

    # Exit code
    if [[ "$success" == "true" ]]; then
        exit $DEV_EXIT_SUCCESS
    else
        exit $DEV_EXIT_COMPLIANCE_FAILED
    fi
}

main "$@"
