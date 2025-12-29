#!/usr/bin/env bash
# test-rollback.sh - Manual test script for phase rollback feature
# Part of cleo-dev.comelopment tooling
#
# This script follows LLM-Agent-First principles:
# - JSON output by default for non-TTY
# - --format, --quiet, --json, --human flags
# - DEV_EXIT_* constants
#
# Usage:
#   ./dev/test-rollback.sh                    # Run all rollback tests
#   ./dev/test-rollback.sh --format json      # JSON output
#   ./dev/test-rollback.sh --quiet            # Suppress non-essential output

set -euo pipefail

# ============================================================================
# SETUP - LLM-Agent-First compliant
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_LIB_DIR="$SCRIPT_DIR/lib"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PHASE_SCRIPT="$PROJECT_ROOT/scripts/phase.sh"

# Command identification (for error reporting and JSON output)
COMMAND_NAME="test-rollback"

# Source dev library (with fallback for compatibility)
if [[ -d "$DEV_LIB_DIR" ]] && [[ -f "$DEV_LIB_DIR/dev-common.sh" ]]; then
    source "$DEV_LIB_DIR/dev-common.sh"
else
    # Fallback definitions if dev-common.sh not available
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
    CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
    log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
    log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
    dev_resolve_format() {
        local f="${1:-}"; [[ -n "$f" ]] && echo "$f" && return
        [[ -t 1 ]] && echo "text" || echo "json"
    }
fi

# Exit codes - use from dev-exit-codes.sh (via dev-common.sh) if available, else define locally
if [[ -z "${DEV_EXIT_SUCCESS:-}" ]]; then
    DEV_EXIT_SUCCESS=0
    DEV_EXIT_GENERAL_ERROR=1
    DEV_EXIT_INVALID_INPUT=2
    DEV_EXIT_NOT_FOUND=4
    DEV_EXIT_DEPENDENCY_ERROR=5
    DEV_EXIT_TEST_FAILED=22
fi

# VERSION loading from central file
TOOL_VERSION=$(cat "$PROJECT_ROOT/VERSION" 2>/dev/null || echo "0.1.0")

# ============================================================================
# DEFAULT OPTIONS
# ============================================================================

FORMAT=""
QUIET=false
VERBOSE=false

# ============================================================================
# JSON ERROR OUTPUT - LLM-Agent-First compliant error envelope
# ============================================================================

# Output error in format-aware manner (JSON envelope for --format json)
# Usage: output_error <error_code> <message> <exit_code> [recoverable] [suggestion]
output_error() {
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
                "$schema": "https://cleo-dev.com/schemas/v1/error.schema.json",
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
        [[ -n "$suggestion" ]] && echo -e "  ${DIM:-}Suggestion: $suggestion${NC:-}" >&2
    fi
}

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << EOF
test-rollback - Test phase rollback functionality

Usage: $(basename "$0") [OPTIONS]

Options:
  -f, --format <format>   Output format: text, json (default: auto-detect)
      --json              JSON output (shortcut for --format json)
      --human             Human-readable output (shortcut for --format text)
  -q, --quiet             Suppress non-essential output
  -v, --verbose           Show detailed test output
  -h, --help              Show this help message
      --version           Show version

Examples:
  $(basename "$0")                    # Run all rollback tests
  $(basename "$0") --format json      # JSON output for scripting
  $(basename "$0") --quiet            # Minimal output

EOF
}

# ============================================================================
# ARGUMENT PARSING
# ============================================================================

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
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
            -q|--quiet)
                QUIET=true
                shift
                ;;
            -v|--verbose)
                VERBOSE=true
                shift
                ;;
            -h|--help)
                usage
                exit $DEV_EXIT_SUCCESS
                ;;
            --version)
                echo "test-rollback v${TOOL_VERSION}"
                exit $DEV_EXIT_SUCCESS
                ;;
            *)
                output_error "E_INVALID_OPTION" \
                    "Unknown option: $1" \
                    "$DEV_EXIT_INVALID_INPUT" \
                    true \
                    "Run --help for valid options"
                exit $DEV_EXIT_INVALID_INPUT
                ;;
        esac
    done
}

# ============================================================================
# TEST RESULT TRACKING
# ============================================================================

declare -a TEST_RESULTS=()
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Record test result
# Args: $1 = test name, $2 = passed (true/false), $3 = details (optional)
record_test() {
    local name="$1"
    local passed="$2"
    local details="${3:-}"

    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if [[ "$passed" == "true" ]]; then
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        FAILED_TESTS=$((FAILED_TESTS + 1))
    fi

    TEST_RESULTS+=("{\"name\":\"$name\",\"passed\":$passed,\"details\":\"$details\"}")
}

# ============================================================================
# TEST EXECUTION
# ============================================================================

run_tests() {
    local initial_phase
    local output

    # Verify phase script exists
    if [[ ! -f "$PHASE_SCRIPT" ]]; then
        output_error "E_SCRIPT_NOT_FOUND" \
            "Phase script not found: $PHASE_SCRIPT" \
            "$DEV_EXIT_NOT_FOUND" \
            true \
            "Ensure phase.sh exists in scripts directory"
        exit $DEV_EXIT_NOT_FOUND
    fi

    # Save initial state
    initial_phase=$(cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" show 2>/dev/null | grep "Current Phase:" | awk '{print $3}' || echo "setup")

    if [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]]; then
        echo "===== Phase Rollback Detection Tests ====="
        echo ""
        echo "Initial phase: $initial_phase"
        echo ""
    fi

    # Test 1: Forward movement (should work without --rollback)
    if [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]]; then
        echo "Test 1: Forward movement (setup -> core)"
    fi
    cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" set setup --rollback --force >/dev/null 2>&1 || true
    if cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" set core 2>&1 | grep -q "Phase set to: core"; then
        record_test "forward_movement" "true" "Forward movement works without --rollback"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  PASS: Forward movement works without --rollback"
    else
        record_test "forward_movement" "false" "Forward movement should not require --rollback"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  FAIL: Forward movement should not require --rollback"
    fi
    [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo ""

    # Test 2: Rollback without --rollback flag (should error)
    if [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]]; then
        echo "Test 2: Rollback without --rollback flag (core -> setup)"
    fi
    output=$(cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" set setup 2>&1 || true)
    if echo "$output" | grep -q "requires --rollback flag"; then
        record_test "rollback_blocked" "true" "Rollback blocked without --rollback flag"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  PASS: Rollback blocked without --rollback flag"
    else
        record_test "rollback_blocked" "false" "Rollback should be blocked without --rollback flag"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  FAIL: Rollback should be blocked without --rollback flag"
        [[ "$VERBOSE" == "true" ]] && echo "  Output: $output"
    fi
    [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo ""

    # Test 3: Rollback with --rollback but cancel prompt
    if [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]]; then
        echo "Test 3: Rollback with --rollback, cancel at prompt"
    fi
    output=$(cd "$PROJECT_ROOT" && echo "n" | "$PHASE_SCRIPT" set setup --rollback 2>&1 || true)
    if echo "$output" | grep -q "Rollback cancelled"; then
        record_test "rollback_cancel_prompt" "true" "Rollback cancelled at prompt"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  PASS: Rollback cancelled at prompt"
    else
        record_test "rollback_cancel_prompt" "false" "Should show Rollback cancelled"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  FAIL: Should show 'Rollback cancelled'"
        [[ "$VERBOSE" == "true" ]] && echo "  Output: $output"
    fi
    [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo ""

    # Test 4: Rollback with --rollback and accept prompt
    if [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]]; then
        echo "Test 4: Rollback with --rollback, accept at prompt"
    fi
    output=$(cd "$PROJECT_ROOT" && echo "y" | "$PHASE_SCRIPT" set setup --rollback 2>&1 || true)
    if echo "$output" | grep -q "Phase set to: setup"; then
        record_test "rollback_accept_prompt" "true" "Rollback succeeded with prompt confirmation"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  PASS: Rollback succeeded with prompt confirmation"
    else
        record_test "rollback_accept_prompt" "false" "Rollback should succeed when confirmed"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  FAIL: Rollback should succeed when confirmed"
        [[ "$VERBOSE" == "true" ]] && echo "  Output: $output"
    fi
    [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo ""

    # Test 5: Rollback with --rollback --force (no prompt)
    if [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]]; then
        echo "Test 5: Rollback with --rollback --force (no prompt)"
    fi
    cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" set core --rollback --force >/dev/null 2>&1 || true
    if cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" set setup --rollback --force 2>&1 | grep -q "Phase set to: setup"; then
        record_test "rollback_force" "true" "Rollback succeeded with --force (no prompt)"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  PASS: Rollback succeeded with --force (no prompt)"
    else
        record_test "rollback_force" "false" "Rollback --force should skip prompt"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  FAIL: Rollback --force should skip prompt"
    fi
    [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo ""

    # Test 6: JSON mode rollback without --force (should error)
    if [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]]; then
        echo "Test 6: JSON mode rollback without --force"
    fi
    cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" set core --rollback --force >/dev/null 2>&1 || true
    output=$(cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" --json set setup --rollback 2>&1 || true)
    if echo "$output" | jq -e '.error.code == "E_PHASE_ROLLBACK_REQUIRES_FORCE"' >/dev/null 2>&1; then
        record_test "json_rollback_requires_force" "true" "JSON mode requires --force for rollback"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  PASS: JSON mode requires --force for rollback"
    else
        record_test "json_rollback_requires_force" "false" "JSON mode should require --force"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  FAIL: JSON mode should require --force"
        [[ "$VERBOSE" == "true" ]] && echo "  Output: $output"
    fi
    [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo ""

    # Test 7: JSON mode rollback with --force
    if [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]]; then
        echo "Test 7: JSON mode rollback with --force"
    fi
    output=$(cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" --json set setup --rollback --force 2>&1 || true)
    if echo "$output" | jq -e '.success == true' >/dev/null 2>&1; then
        record_test "json_rollback_force" "true" "JSON mode rollback succeeds with --force"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  PASS: JSON mode rollback succeeds with --force"
    else
        record_test "json_rollback_force" "false" "JSON mode rollback --force should succeed"
        [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo "  FAIL: JSON mode rollback --force should succeed"
        [[ "$VERBOSE" == "true" ]] && echo "  Output: $output"
    fi
    [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]] && echo ""

    # Restore initial state
    if [[ "$FORMAT" == "text" ]] && [[ "$QUIET" != "true" ]]; then
        echo "Restoring initial phase: $initial_phase"
    fi
    if [[ "$initial_phase" != "setup" ]]; then
        cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" set "$initial_phase" --rollback --force >/dev/null 2>&1 || \
        cd "$PROJECT_ROOT" && "$PHASE_SCRIPT" set "$initial_phase" >/dev/null 2>&1 || true
    fi
}

# ============================================================================
# OUTPUT FORMATTING
# ============================================================================

output_results() {
    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    if [[ "$FORMAT" == "json" ]]; then
        # Build JSON array of test results
        local tests_json="["
        local first=true
        for result in "${TEST_RESULTS[@]}"; do
            if [[ "$first" == "true" ]]; then
                first=false
            else
                tests_json+=","
            fi
            tests_json+="$result"
        done
        tests_json+="]"

        local success="true"
        [[ "$FAILED_TESTS" -gt 0 ]] && success="false"

        jq -n \
            --arg cmd "$COMMAND_NAME" \
            --arg ver "$TOOL_VERSION" \
            --arg ts "$timestamp" \
            --argjson tests "$tests_json" \
            --argjson total "$TOTAL_TESTS" \
            --argjson passed "$PASSED_TESTS" \
            --argjson failed "$FAILED_TESTS" \
            --argjson success "$success" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/test-results.schema.json",
                "_meta": {
                    "format": "json",
                    "command": $cmd,
                    "version": $ver,
                    "timestamp": $ts
                },
                "success": $success,
                "summary": {
                    "total": $total,
                    "passed": $passed,
                    "failed": $failed
                },
                "tests": $tests
            }'
    else
        if [[ "$QUIET" != "true" ]]; then
            echo ""
            echo "===== All Tests Complete ====="
            echo "Passed: $PASSED_TESTS / $TOTAL_TESTS"
            if [[ "$FAILED_TESTS" -gt 0 ]]; then
                echo "Failed: $FAILED_TESTS"
            fi
        fi
    fi
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
    parse_args "$@"

    # Resolve format (TTY-aware for LLM-Agent-First)
    FORMAT=$(dev_resolve_format "$FORMAT")

    # Run tests
    run_tests

    # Output results
    output_results

    # Exit with appropriate code
    if [[ "$FAILED_TESTS" -gt 0 ]]; then
        exit $DEV_EXIT_TEST_FAILED
    fi

    exit $DEV_EXIT_SUCCESS
}

main "$@"
