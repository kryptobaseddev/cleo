#!/usr/bin/env bash
#####################################################################
# benchmark-performance.sh - Performance Testing for Claude Todo
#
# Tests command performance with varying dataset sizes:
# - 100, 500, 1000, 2000 tasks
# - Measures execution time for critical commands
# - Reports on performance targets
#
# This script follows LLM-Agent-First principles:
# - JSON output by default for non-TTY
# - --format, --quiet, --json, --human flags
# - Structured _meta envelope
# - DEV_EXIT_* constants
#
# Usage:
#   benchmark-performance.sh [OPTIONS]
#
# Options:
#   --sizes "100 500 1000"  Custom dataset sizes (default: 100 500 1000 2000)
#   --runs N                Number of runs per test (default: 3)
#   --output FILE           Save results to file (default: stdout)
#   -f, --format <format>   Output format: text, json (default: auto-detect)
#   --json                  Force JSON output
#   --human                 Force human-readable text output
#   -q, --quiet             Suppress progress output
#   --help                  Show this help
#
# Performance Targets:
#   list command:  < 100ms for 1000+ tasks
#   stats command: < 1s for 1000+ tasks
#####################################################################

set -euo pipefail

# ============================================================================
# SETUP - LLM-Agent-First compliant
# ============================================================================

# Script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_LIB_DIR="$SCRIPT_DIR/lib"

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
    DEV_EXIT_DEPENDENCY_ERROR=5
    DEV_EXIT_BENCHMARK_FAILED=21
fi

# Project paths
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.cleo}"

# Command identification (for error reporting and JSON output)
COMMAND_NAME="benchmark-performance"

# Tool version (from central VERSION file)
TOOL_VERSION=$(cat "$PROJECT_ROOT/VERSION" 2>/dev/null || echo "0.1.0")

# Defaults
DATASET_SIZES="100 500 1000 2000"
NUM_RUNS=3
OUTPUT_FILE=""
TEMP_DIR=""
FORMAT=""
QUIET=false

# Performance targets (in milliseconds)
TARGET_LIST_MS=100
TARGET_STATS_MS=1000

# ============================================================================
# JSON ERROR OUTPUT - LLM-Agent-First compliant error envelope
# ============================================================================

# Output error in format-aware manner (JSON envelope for --format json)
# Usage: output_benchmark_error <error_code> <message> <exit_code> [recoverable] [suggestion]
output_benchmark_error() {
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
                "$schema": "https://cleo.dev/schemas/v1/error.schema.json",
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
        echo "[ERROR] $message" >&2
        [[ -n "$suggestion" ]] && echo "  Suggestion: $suggestion" >&2
    fi
}

usage() {
    cat << EOF
Performance Benchmark for Claude Todo v${TOOL_VERSION}

Usage: $(basename "$0") [OPTIONS]

Test cleo performance with varying dataset sizes.

Options:
  --sizes "100 500 1000"  Custom dataset sizes (default: 100 500 1000 2000)
  --runs N                Number of runs per test (default: 3)
  --output FILE           Save results to file (default: stdout)
  -f, --format <format>   Output format: text, json (default: auto-detect)
  --json                  Force JSON output
  --human                 Force human-readable text output
  -q, --quiet             Suppress progress output
  -h, --help              Show this help
  --version               Show version

Performance Targets:
  list command:  < 100ms for 1000+ tasks
  stats command: < 1000ms for 1000+ tasks

Examples:
  $(basename "$0")
  $(basename "$0") --sizes "1000 2000 5000"
  $(basename "$0") --runs 5 --output benchmark.txt
  $(basename "$0") --format json
EOF
    exit $DEV_EXIT_SUCCESS
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --sizes)
            DATASET_SIZES="$2"
            shift 2
            ;;
        --runs)
            NUM_RUNS="$2"
            shift 2
            ;;
        --output)
            OUTPUT_FILE="$2"
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
        -q|--quiet)
            QUIET=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        --version)
            echo "benchmark-performance v${TOOL_VERSION}"
            exit $DEV_EXIT_SUCCESS
            ;;
        *)
            # Resolve format first for proper error output
            FORMAT=$(dev_resolve_format "$FORMAT")
            output_benchmark_error "E_INVALID_OPTION" \
                "Unknown option: $1" \
                "$DEV_EXIT_INVALID_INPUT" \
                true \
                "Run --help for valid options"
            exit $DEV_EXIT_INVALID_INPUT
            ;;
    esac
done

# Resolve format (TTY-aware for LLM-Agent-First)
FORMAT=$(dev_resolve_format "$FORMAT")

# Check dependencies
if ! command -v jq &>/dev/null; then
    output_benchmark_error "E_DEPENDENCY_MISSING" \
        "jq is required but not installed" \
        "$DEV_EXIT_DEPENDENCY_ERROR" \
        true \
        "Install via: apt install jq (Debian/Ubuntu) or brew install jq (macOS)"
    exit $DEV_EXIT_DEPENDENCY_ERROR
fi

if ! command -v bc &>/dev/null; then
    output_benchmark_error "E_DEPENDENCY_MISSING" \
        "bc is required but not installed" \
        "$DEV_EXIT_DEPENDENCY_ERROR" \
        true \
        "Install via: apt install bc (Debian/Ubuntu) or brew install bc (macOS)"
    exit $DEV_EXIT_DEPENDENCY_ERROR
fi

# Generate random task data
generate_task() {
  local id="$1"
  local statuses=("pending" "active" "blocked" "done")
  local priorities=("critical" "high" "medium" "low")
  local phases=("setup" "core" "polish" "maintenance")
  local labels=("bug" "feature" "docs" "test" "refactor")

  local status="${statuses[$((RANDOM % 4))]}"
  local priority="${priorities[$((RANDOM % 4))]}"
  local phase="${phases[$((RANDOM % 4))]}"
  local label_count=$((RANDOM % 3))

  # Generate labels array
  local labels_json="[]"
  if [[ "$label_count" -gt 0 ]]; then
    local selected_labels=()
    for ((i=0; i<label_count; i++)); do
      selected_labels+=("\"${labels[$((RANDOM % 5))]}\"")
    done
    labels_json="[$(IFS=,; echo "${selected_labels[*]}")]"
  fi

  cat << EOF
{
  "id": "T$(printf "%03d" "$id")",
  "title": "Task $id: Performance test task",
  "description": "Generated task for performance testing with some description text to simulate real usage",
  "status": "$status",
  "priority": "$priority",
  "phase": "$phase",
  "labels": $labels_json,
  "createdAt": "$(date -u -d "-$((RANDOM % 365)) days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v-"$((RANDOM % 365))d" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
}

# Generate test dataset
generate_dataset() {
    local size="$1"
    local tasks_json="[]"

    [[ "$QUIET" != "true" ]] && echo "[INFO] Generating $size tasks..." >&2

    for ((i=1; i<=size; i++)); do
        if [[ "$i" -eq 1 ]]; then
            tasks_json="[$(generate_task "$i")]"
        else
            tasks_json="$(echo "$tasks_json" | jq ". += [$(generate_task "$i")]")"
        fi

        # Progress indicator every 100 tasks
        if [[ $((i % 100)) -eq 0 ]] && [[ "$QUIET" != "true" ]]; then
            echo "  Generated $i/$size tasks..." >&2
        fi
    done

    # Create full todo.json structure
    cat << EOF
{
  "version": "1.0.0",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "tasks": $tasks_json
}
EOF
}

# Measure command execution time
measure_time() {
  local cmd="$1"
  local start_ns end_ns elapsed_ms

  start_ns=$(date +%s%N 2>/dev/null || echo "0")
  eval "$cmd" >/dev/null 2>&1
  end_ns=$(date +%s%N 2>/dev/null || echo "$start_ns")

  if [[ "$start_ns" != "0" ]] && [[ "$end_ns" != "0" ]]; then
    elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
  else
    # Fallback: use milliseconds if nanoseconds not available
    start_ms=$(date +%s%3N 2>/dev/null || echo "0")
    eval "$cmd" >/dev/null 2>&1
    end_ms=$(date +%s%3N 2>/dev/null || echo "$start_ms")
    elapsed_ms=$((end_ms - start_ms))
  fi

  echo "$elapsed_ms"
}

# Calculate statistics (mean, min, max)
calculate_stats() {
  local values=("$@")
  local sum=0
  local min=${values[0]}
  local max=${values[0]}

  for val in "${values[@]}"; do
    sum=$((sum + val))
    [[ "$val" -lt "$min" ]] && min="$val"
    [[ "$val" -gt "$max" ]] && max="$val"
  done

  local mean=$((sum / ${#values[@]}))
  echo "$mean $min $max"
}

# Global results array for JSON output
declare -a BENCHMARK_RESULTS=()
declare HAS_FAILURES=false

# Run benchmark for a specific dataset size
# Returns: JSON object with results (for JSON format) or prints text
benchmark_dataset() {
    local size="$1"

    if [[ "$FORMAT" == "text" ]]; then
        echo ""
        echo "========================================="
        echo "BENCHMARK: $size tasks"
        echo "========================================="
    fi

    # Generate dataset
    local dataset
    dataset=$(generate_dataset "$size")

    # Write to temp todo.json
    echo "$dataset" > "$TEMP_DIR/todo.json"

    # Create minimal log file for stats command
    cat > "$TEMP_DIR/todo-log.jsonl" << 'LOGEOF'
{
  "version": "1.0.0",
  "entries": []
}
LOGEOF

    # Test list command
    [[ "$FORMAT" == "text" ]] && echo "" && echo "Testing: list command ($NUM_RUNS runs)"
    local list_times=()
    for ((run=1; run<=NUM_RUNS; run++)); do
        local elapsed
        elapsed=$(measure_time "TODO_FILE=$TEMP_DIR/todo.json $SCRIPT_DIR/list.sh -q -f json")
        list_times+=("$elapsed")
        [[ "$FORMAT" == "text" ]] && echo "  Run $run: ${elapsed}ms"
    done

    read -r list_mean list_min list_max <<< "$(calculate_stats "${list_times[@]}")"
    local list_status="PASS"
    [[ "$size" -ge 1000 ]] && [[ "$list_mean" -gt "$TARGET_LIST_MS" ]] && list_status="FAIL" && HAS_FAILURES=true

    [[ "$FORMAT" == "text" ]] && echo "  Result: mean=${list_mean}ms min=${list_min}ms max=${list_max}ms [$list_status]"

    # Test stats command
    [[ "$FORMAT" == "text" ]] && echo "" && echo "Testing: stats command ($NUM_RUNS runs)"
    local stats_times=()
    for ((run=1; run<=NUM_RUNS; run++)); do
        local elapsed
        elapsed=$(measure_time "TODO_FILE=$TEMP_DIR/todo.json STATS_LOG_FILE=$TEMP_DIR/todo-log.jsonl $SCRIPT_DIR/../scripts/stats.sh -f json")
        stats_times+=("$elapsed")
        [[ "$FORMAT" == "text" ]] && echo "  Run $run: ${elapsed}ms"
    done

    read -r stats_mean stats_min stats_max <<< "$(calculate_stats "${stats_times[@]}")"
    local stats_status="PASS"
    [[ "$size" -ge 1000 ]] && [[ "$stats_mean" -gt "$TARGET_STATS_MS" ]] && stats_status="FAIL" && HAS_FAILURES=true

    [[ "$FORMAT" == "text" ]] && echo "  Result: mean=${stats_mean}ms min=${stats_min}ms max=${stats_max}ms [$stats_status]"

    # Summary (text mode)
    if [[ "$FORMAT" == "text" ]]; then
        echo ""
        echo "Summary for $size tasks:"
        echo "  list:  ${list_mean}ms (target: <${TARGET_LIST_MS}ms for 1000+) [$list_status]"
        echo "  stats: ${stats_mean}ms (target: <${TARGET_STATS_MS}ms for 1000+) [$stats_status]"
    fi

    # Build JSON result for this dataset
    local result_json
    result_json=$(jq -n \
        --argjson size "$size" \
        --argjson runs "$NUM_RUNS" \
        --argjson list_mean "$list_mean" \
        --argjson list_min "$list_min" \
        --argjson list_max "$list_max" \
        --arg list_status "$list_status" \
        --argjson list_target "$TARGET_LIST_MS" \
        --argjson stats_mean "$stats_mean" \
        --argjson stats_min "$stats_min" \
        --argjson stats_max "$stats_max" \
        --arg stats_status "$stats_status" \
        --argjson stats_target "$TARGET_STATS_MS" \
        '{
            taskCount: $size,
            runs: $runs,
            list: {
                meanMs: $list_mean,
                minMs: $list_min,
                maxMs: $list_max,
                targetMs: $list_target,
                status: $list_status
            },
            stats: {
                meanMs: $stats_mean,
                minMs: $stats_min,
                maxMs: $stats_max,
                targetMs: $stats_target,
                status: $stats_status
            }
        }')

    BENCHMARK_RESULTS+=("$result_json")
}

# Format output as JSON
format_json_output() {
    local all_passed="${1:-true}"

    # Build benchmarks array from results
    local benchmarks_json
    benchmarks_json=$(printf '%s\n' "${BENCHMARK_RESULTS[@]}" | jq -s '.')

    # Calculate summary
    local total_tests passed_tests failed_tests
    total_tests=$(echo "$benchmarks_json" | jq 'length * 2')  # 2 tests per dataset (list, stats)
    passed_tests=$(echo "$benchmarks_json" | jq '[.[] | (.list.status, .stats.status) | select(. == "PASS")] | length')
    failed_tests=$((total_tests - passed_tests))

    jq -n \
        --arg schema "https://cleo.dev/schemas/v1/benchmark-report.schema.json" \
        --arg cmd "$COMMAND_NAME" \
        --arg ver "$TOOL_VERSION" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg sizes "$DATASET_SIZES" \
        --argjson runs "$NUM_RUNS" \
        --argjson listTarget "$TARGET_LIST_MS" \
        --argjson statsTarget "$TARGET_STATS_MS" \
        --argjson benchmarks "$benchmarks_json" \
        --argjson totalTests "$total_tests" \
        --argjson passedTests "$passed_tests" \
        --argjson failedTests "$failed_tests" \
        --argjson allPassed "$all_passed" \
        '{
            "$schema": $schema,
            "_meta": {
                "format": "json",
                "command": $cmd,
                "version": $ver,
                "timestamp": $ts
            },
            "success": $allPassed,
            "config": {
                "datasetSizes": ($sizes | split(" ") | map(tonumber)),
                "runsPerTest": $runs,
                "targets": {
                    "listMs": $listTarget,
                    "statsMs": $statsTarget
                }
            },
            "benchmarks": $benchmarks,
            "summary": {
                "totalTests": $totalTests,
                "passed": $passedTests,
                "failed": $failedTests,
                "allPassed": $allPassed
            }
        }'
}

# Main execution
main() {
    # Create temporary directory
    TEMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TEMP_DIR"' EXIT

    # Redirect output if file specified (text mode only)
    if [[ -n "$OUTPUT_FILE" ]] && [[ "$FORMAT" == "text" ]]; then
        exec > >(tee "$OUTPUT_FILE")
    fi

    # Header (text mode only)
    if [[ "$FORMAT" == "text" ]]; then
        echo "========================================="
        echo "CLAUDE-TODO PERFORMANCE BENCHMARK v${TOOL_VERSION}"
        echo "========================================="
        echo "Timestamp: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
        echo "Datasets: $DATASET_SIZES"
        echo "Runs per test: $NUM_RUNS"
        echo "Targets:"
        echo "  list:  < ${TARGET_LIST_MS}ms for 1000+ tasks"
        echo "  stats: < ${TARGET_STATS_MS}ms for 1000+ tasks"
    fi

    # Run benchmarks for each dataset size
    for size in $DATASET_SIZES; do
        benchmark_dataset "$size"
    done

    # Determine overall pass/fail
    local all_passed=true
    [[ "$HAS_FAILURES" == "true" ]] && all_passed=false

    # Output based on format
    if [[ "$FORMAT" == "json" ]]; then
        local json_output
        json_output=$(format_json_output "$all_passed")

        if [[ -n "$OUTPUT_FILE" ]]; then
            echo "$json_output" > "$OUTPUT_FILE"
            # Still output to stdout as well
            echo "$json_output"
        else
            echo "$json_output"
        fi
    else
        echo ""
        echo "========================================="
        echo "BENCHMARK COMPLETE"
        echo "========================================="

        if [[ -n "$OUTPUT_FILE" ]]; then
            echo "Results saved to: $OUTPUT_FILE"
        fi

        if [[ "$HAS_FAILURES" == "true" ]]; then
            echo ""
            echo "[WARNING] Some benchmarks exceeded performance targets"
        fi
    fi

    # Exit with appropriate code
    if [[ "$HAS_FAILURES" == "true" ]]; then
        exit $DEV_EXIT_BENCHMARK_FAILED
    fi

    exit $DEV_EXIT_SUCCESS
}

main "$@"
