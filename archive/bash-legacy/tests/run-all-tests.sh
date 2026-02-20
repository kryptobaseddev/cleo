#!/usr/bin/env bash
# =============================================================================
# run-all-tests.sh - CLEO Test Suite Runner
# =============================================================================
# Runs all BATS tests in the test suite.
#
# Usage:
#   ./run-all-tests.sh [OPTIONS]
#
# Options:
#   --verbose, -v      Show detailed output for each test
#   --unit             Run only unit tests
#   --integration      Run only integration tests
#   --smoke            Run quick smoke tests only (tests/smoke-test.sh)
#   --filter PATTERN   Run tests matching pattern
#   --parallel, -p     Enable parallel execution (default: auto-detect)
#   --no-parallel      Disable parallel execution
#   --jobs N, -j N     Number of parallel jobs (default: min(cores, 16))
#   --fast             Use all available CPU cores for maximum speed
#   --timeout N        Per-test-file timeout in seconds (default: 120)
#   --suite-timeout N  Overall suite timeout in seconds (default: 900)
#   --help, -h         Show this help message
# =============================================================================

set -euo pipefail

# =============================================================================
# Timeout and Cleanup Configuration
# =============================================================================
PER_FILE_TIMEOUT="${CLEO_TEST_TIMEOUT:-120}"      # 2 minutes per test file
SUITE_TIMEOUT="${CLEO_SUITE_TIMEOUT:-900}"        # 15 minutes total
TIMED_OUT_TESTS=""
SUITE_START_TIME=""

# =============================================================================
# Cleanup Functions
# =============================================================================

# Cleanup test environment: kill orphan processes, remove stale locks, clear FDs
cleanup_test_env() {
    local exit_code=$?

    # Kill any orphan background processes from this script
    pkill -P $$ 2>/dev/null || true

    # Remove stale lock files in test directories
    find "${SCRIPT_DIR:-/tmp}" -name "*.lock" -type f -delete 2>/dev/null || true
    find "${PROJECT_ROOT:-.}/.cleo" -name "*.lock" -type f -delete 2>/dev/null || true

    # Close file descriptors 200-210 (used by flock in tests)
    for fd in {200..210}; do
        exec {fd}>&- 2>/dev/null || true
    done

    return $exit_code
}

# Pre-test cleanup: ensure clean state before running tests
pre_test_cleanup() {
    # Remove any existing lock files
    find "${PROJECT_ROOT:-.}/.cleo" -name "*.lock" -type f -delete 2>/dev/null || true

    # Kill any lingering test processes from previous runs
    pkill -f "bats.*cleo" 2>/dev/null || true

    # Small delay to ensure processes are terminated
    sleep 0.1
}

# Handle timeout signal
handle_timeout() {
    echo -e "${RED}TIMEOUT: Test suite exceeded ${SUITE_TIMEOUT}s limit${NC}" >&2
    cleanup_test_env
    exit 124
}

# Register cleanup handlers
trap cleanup_test_env EXIT
trap handle_timeout SIGALRM

# Colors (respect NO_COLOR)
if [[ -z "${NO_COLOR:-}" ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    NC=''
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Options
VERBOSE=false
RUN_UNIT=true
RUN_INTEGRATION=true
RUN_SMOKE=false
FILTER=""

# Parallel execution settings
# Detect CPU cores (portable: Linux nproc, macOS sysctl, fallback to 4)
detect_cpu_cores() {
    local cores
    cores=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
    echo "$cores"
}

CPU_CORES=$(detect_cpu_cores)
# Default to min(cores, 16) for parallel jobs
DEFAULT_JOBS=$((CPU_CORES > 16 ? 16 : CPU_CORES))
PARALLEL_JOBS="${JOBS:-$DEFAULT_JOBS}"
PARALLEL_ENABLED="auto"  # auto, true, false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --unit)
            RUN_UNIT=true
            RUN_INTEGRATION=false
            RUN_SMOKE=false
            shift
            ;;
        --integration)
            RUN_UNIT=false
            RUN_INTEGRATION=true
            RUN_SMOKE=false
            shift
            ;;
        --smoke)
            RUN_UNIT=false
            RUN_INTEGRATION=false
            RUN_SMOKE=true
            shift
            ;;
        --filter)
            FILTER="$2"
            shift 2
            ;;
        --parallel|-p)
            PARALLEL_ENABLED="true"
            shift
            ;;
        --no-parallel)
            PARALLEL_ENABLED="false"
            shift
            ;;
        --jobs|-j)
            PARALLEL_JOBS="$2"
            PARALLEL_ENABLED="true"
            shift 2
            ;;
        --fast)
            PARALLEL_JOBS="$CPU_CORES"
            PARALLEL_ENABLED="true"
            shift
            ;;
        --timeout)
            PER_FILE_TIMEOUT="$2"
            shift 2
            ;;
        --suite-timeout)
            SUITE_TIMEOUT="$2"
            shift 2
            ;;
        --help|-h)
            echo "CLEO Test Suite Runner"
            echo ""
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --verbose, -v      Show detailed output for each test"
            echo "  --unit             Run only unit tests"
            echo "  --integration      Run only integration tests"
            echo "  --smoke            Run quick smoke tests only (tests/smoke-test.sh)"
            echo "  --filter PATTERN   Run tests matching pattern"
            echo "  --parallel, -p     Enable parallel execution (default: auto-detect)"
            echo "  --no-parallel      Disable parallel execution"
            echo "  --jobs N, -j N     Number of parallel jobs (default: min(cores, 16) = $DEFAULT_JOBS)"
            echo "  --fast             Use all available CPU cores ($CPU_CORES) for maximum speed"
            echo "  --timeout N        Per-test-file timeout in seconds (default: $PER_FILE_TIMEOUT)"
            echo "  --suite-timeout N  Overall suite timeout in seconds (default: $SUITE_TIMEOUT)"
            echo "  --help, -h         Show this help message"
            echo ""
            echo "Environment Variables:"
            echo "  JOBS=N             Set number of parallel jobs"
            echo "  CLEO_TEST_TIMEOUT  Per-test-file timeout in seconds"
            echo "  CLEO_SUITE_TIMEOUT Overall suite timeout in seconds"
            echo "  NO_COLOR=1         Disable colored output"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Check for bats
if ! command -v bats &> /dev/null; then
    echo -e "${RED}Error: bats is not installed${NC}"
    echo "Install with:"
    echo "  macOS:  brew install bats-core"
    echo "  Ubuntu: sudo apt-get install bats"
    exit 1
fi

# Check for git submodules
if [[ ! -d "$SCRIPT_DIR/libs/bats-support" ]]; then
    echo -e "${YELLOW}Initializing git submodules...${NC}"
    cd "$PROJECT_ROOT"
    git submodule update --init --recursive
fi

# Check for jq
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}Warning: jq is not installed. Some tests may fail.${NC}"
fi

# Check for GNU parallel (required for BATS --jobs)
HAS_PARALLEL=false
if command -v parallel &> /dev/null; then
    HAS_PARALLEL=true
fi

# Run pre-test cleanup
pre_test_cleanup

# Record suite start time for timeout tracking
SUITE_START_TIME=$(date +%s)

echo ""
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}      CLEO Test Suite${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# Show timeout settings
echo -e "Timeouts: ${YELLOW}${PER_FILE_TIMEOUT}s/file${NC}, ${YELLOW}${SUITE_TIMEOUT}s/suite${NC}"

# Show parallel execution status
if [[ "$PARALLEL_ENABLED" == "false" ]]; then
    echo -e "Mode: ${YELLOW}Sequential${NC}"
elif ! bats --help 2>&1 | grep -q -- '--jobs'; then
    echo -e "Mode: ${YELLOW}Sequential${NC} (BATS version does not support --jobs)"
elif [[ "$HAS_PARALLEL" == "false" ]]; then
    echo -e "Mode: ${YELLOW}Sequential${NC} (GNU parallel not installed)"
    echo -e "  Install with: ${BLUE}sudo dnf install parallel${NC} (Fedora)"
    echo -e "              ${BLUE}sudo apt install parallel${NC} (Debian/Ubuntu)"
    echo -e "              ${BLUE}brew install parallel${NC} (macOS)"
else
    echo -e "Mode: ${GREEN}Parallel${NC} (${PARALLEL_JOBS} jobs, ${CPU_CORES} cores detected)"
fi
echo ""

TOTAL_PASSED=0
TOTAL_FAILED=0
TOTAL_SKIPPED=0
FAILED_TESTS=""

# Check if suite timeout has been exceeded
check_suite_timeout() {
    local current_time elapsed
    current_time=$(date +%s)
    elapsed=$((current_time - SUITE_START_TIME))
    if [[ $elapsed -ge $SUITE_TIMEOUT ]]; then
        echo -e "${RED}TIMEOUT: Test suite exceeded ${SUITE_TIMEOUT}s limit (${elapsed}s elapsed)${NC}" >&2
        return 1
    fi
    return 0
}

# Run a single test file with timeout
run_single_test_file() {
    local test_file="$1"
    local suite_name="$2"
    local bats_args=("${@:3}")
    local file_basename
    file_basename=$(basename "$test_file")

    # Check suite timeout before starting
    if ! check_suite_timeout; then
        TIMED_OUT_TESTS="${TIMED_OUT_TESTS}  [$suite_name] $file_basename (suite timeout)"$'\n'
        return 124
    fi

    echo -e "  Running: ${BLUE}$file_basename${NC}"

    local output status=0
    local start_time end_time elapsed

    start_time=$(date +%s)

    # Run with timeout command
    if output=$(timeout --signal=TERM --kill-after=10 "$PER_FILE_TIMEOUT" bats "${bats_args[@]}" "$test_file" 2>&1); then
        status=0
    else
        status=$?
    fi

    end_time=$(date +%s)
    elapsed=$((end_time - start_time))

    # Handle timeout (exit code 124 from timeout command)
    if [[ $status -eq 124 ]]; then
        echo -e "    ${RED}TIMEOUT${NC}: $file_basename exceeded ${PER_FILE_TIMEOUT}s limit"
        TIMED_OUT_TESTS="${TIMED_OUT_TESTS}  [$suite_name] $file_basename (${PER_FILE_TIMEOUT}s timeout)"$'\n'

        # Cleanup after timeout: kill any orphan processes from this test
        pkill -f "bats.*$file_basename" 2>/dev/null || true

        # Count as 1 failure for the timed out file
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
        FAILED_TESTS="${FAILED_TESTS}  [$suite_name] $file_basename (TIMEOUT)"$'\n'
        return $status
    fi

    # Parse results from bats output
    local passed failed skipped
    passed=$(echo "$output" | grep -c "^ok " 2>/dev/null) || passed=0
    failed=$(echo "$output" | grep -c "^not ok " 2>/dev/null) || failed=0
    skipped=$(echo "$output" | grep -c "# skip" 2>/dev/null) || skipped=0

    # Print summary for this file
    if [[ $status -eq 0 ]]; then
        echo -e "    ${GREEN}✓${NC} $passed passed ($elapsed s)"
    else
        echo -e "    ${RED}✗${NC} $failed failed, $passed passed ($elapsed s)"
    fi

    # Capture failing test names for summary
    local failed_lines
    failed_lines=$(echo "$output" | grep "^not ok " 2>/dev/null) || true
    if [[ -n "$failed_lines" ]]; then
        while IFS= read -r line; do
            local test_name="${line#not ok [0-9]* }"
            FAILED_TESTS="${FAILED_TESTS}  [$suite_name] $test_name"$'\n'
        done <<< "$failed_lines"
    fi

    TOTAL_PASSED=$((TOTAL_PASSED + passed))
    TOTAL_FAILED=$((TOTAL_FAILED + failed))
    TOTAL_SKIPPED=$((TOTAL_SKIPPED + skipped))

    # Print verbose output if enabled
    if [[ "$VERBOSE" == true ]]; then
        echo "$output"
    fi

    return $status
}

run_test_suite() {
    local suite_name="$1"
    local suite_dir="$2"
    local suite_failed=0

    if [[ ! -d "$suite_dir" ]]; then
        echo -e "${YELLOW}Directory not found: $suite_dir${NC}"
        return
    fi

    local test_files=("$suite_dir"/*.bats)
    if [[ ! -f "${test_files[0]}" ]]; then
        echo -e "${YELLOW}No test files found in $suite_dir${NC}"
        return
    fi

    local file_count=${#test_files[@]}
    echo -e "${BLUE}Running $suite_name tests ($file_count files)...${NC}"
    echo ""

    local bats_args=()

    if [[ "$VERBOSE" == true ]]; then
        bats_args+=(--verbose-run)
    fi

    if [[ -n "$FILTER" ]]; then
        bats_args+=(--filter "$FILTER")
    fi

    # Note: We don't use --jobs here since we're running files individually with timeout
    # This ensures proper timeout handling per file

    # Run each test file individually with timeout
    for test_file in "${test_files[@]}"; do
        if ! run_single_test_file "$test_file" "$suite_name" "${bats_args[@]}"; then
            suite_failed=1
        fi

        # Check suite timeout after each file
        if ! check_suite_timeout; then
            echo -e "${RED}Suite timeout reached. Skipping remaining tests.${NC}"
            break
        fi
    done

    echo ""
    if [[ $suite_failed -eq 0 ]]; then
        echo -e "${GREEN}✓ $suite_name tests passed${NC}"
    else
        echo -e "${RED}✗ $suite_name tests had failures${NC}"
    fi
    echo ""
}

# Run test suites
if [[ "$RUN_SMOKE" == true ]]; then
    # Run smoke tests instead of full suite
    if [[ -f "$SCRIPT_DIR/smoke-test.sh" ]]; then
        echo -e "${BLUE}Running smoke tests...${NC}"
        echo ""
        if bash "$SCRIPT_DIR/smoke-test.sh"; then
            echo -e "${GREEN}✓ Smoke tests passed${NC}"
            TOTAL_PASSED=1
        else
            echo -e "${RED}✗ Smoke tests failed${NC}"
            TOTAL_FAILED=1
        fi
    else
        echo -e "${RED}Error: smoke-test.sh not found${NC}"
        exit 1
    fi
elif [[ "$RUN_UNIT" == true ]]; then
    run_test_suite "Unit" "$SCRIPT_DIR/unit"
fi

if [[ "$RUN_INTEGRATION" == true ]] && [[ "$RUN_SMOKE" == false ]]; then
    run_test_suite "Integration" "$SCRIPT_DIR/integration"
fi

# Calculate total elapsed time
SUITE_END_TIME=$(date +%s)
TOTAL_ELAPSED=$((SUITE_END_TIME - SUITE_START_TIME))

# Summary
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}                 Summary${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""
echo -e "Passed:  ${GREEN}$TOTAL_PASSED${NC}"
echo -e "Failed:  ${RED}$TOTAL_FAILED${NC}"
echo -e "Skipped: ${YELLOW}$TOTAL_SKIPPED${NC}"
echo -e "Time:    ${BLUE}${TOTAL_ELAPSED}s${NC}"
echo ""

# Show timed-out tests if any
if [[ -n "$TIMED_OUT_TESTS" ]]; then
    echo -e "${YELLOW}============================================${NC}"
    echo -e "${YELLOW}            TIMED OUT TESTS${NC}"
    echo -e "${YELLOW}============================================${NC}"
    echo ""
    echo -e "${YELLOW}$TIMED_OUT_TESTS${NC}"
fi

if [[ $TOTAL_FAILED -eq 0 ]]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}============================================${NC}"
    echo -e "${RED}            FAILED TESTS${NC}"
    echo -e "${RED}============================================${NC}"
    echo ""
    echo -e "${RED}$FAILED_TESTS${NC}"
    echo -e "${RED}Total: $TOTAL_FAILED failed${NC}"
    exit 1
fi
