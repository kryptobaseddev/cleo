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
#   --filter PATTERN   Run tests matching pattern
#   --parallel, -p     Enable parallel execution (default: auto-detect)
#   --no-parallel      Disable parallel execution
#   --jobs N, -j N     Number of parallel jobs (default: min(cores, 16))
#   --fast             Use all available CPU cores for maximum speed
#   --help, -h         Show this help message
# =============================================================================

set -euo pipefail

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
            shift
            ;;
        --integration)
            RUN_UNIT=false
            RUN_INTEGRATION=true
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
        --help|-h)
            echo "CLEO Test Suite Runner"
            echo ""
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --verbose, -v      Show detailed output for each test"
            echo "  --unit             Run only unit tests"
            echo "  --integration      Run only integration tests"
            echo "  --filter PATTERN   Run tests matching pattern"
            echo "  --parallel, -p     Enable parallel execution (default: auto-detect)"
            echo "  --no-parallel      Disable parallel execution"
            echo "  --jobs N, -j N     Number of parallel jobs (default: min(cores, 16) = $DEFAULT_JOBS)"
            echo "  --fast             Use all available CPU cores ($CPU_CORES) for maximum speed"
            echo "  --help, -h         Show this help message"
            echo ""
            echo "Environment Variables:"
            echo "  JOBS=N             Set number of parallel jobs"
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

echo ""
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}      CLEO Test Suite${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

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

run_test_suite() {
    local suite_name="$1"
    local suite_dir="$2"

    if [[ ! -d "$suite_dir" ]]; then
        echo -e "${YELLOW}Directory not found: $suite_dir${NC}"
        return
    fi

    local test_files=("$suite_dir"/*.bats)
    if [[ ! -f "${test_files[0]}" ]]; then
        echo -e "${YELLOW}No test files found in $suite_dir${NC}"
        return
    fi

    echo -e "${BLUE}Running $suite_name tests...${NC}"
    echo ""

    local bats_args=()

    if [[ "$VERBOSE" == true ]]; then
        bats_args+=(--verbose-run)
    fi

    if [[ -n "$FILTER" ]]; then
        bats_args+=(--filter "$FILTER")
    fi

    # Add parallel execution flags
    # Auto mode: enable if more than 1 core available, BATS supports it, and GNU parallel installed
    if [[ "$PARALLEL_ENABLED" == "true" ]] || { [[ "$PARALLEL_ENABLED" == "auto" ]] && [[ "$CPU_CORES" -gt 1 ]]; }; then
        # Check if BATS supports --jobs (BATS 1.5.0+) AND GNU parallel is installed
        if bats --help 2>&1 | grep -q -- '--jobs' && [[ "$HAS_PARALLEL" == "true" ]]; then
            bats_args+=(--jobs "$PARALLEL_JOBS")
        fi
    fi

    # Run bats and capture output
    local output
    local status=0

    if output=$(bats "${bats_args[@]}" "${test_files[@]}" 2>&1); then
        status=0
    else
        status=$?
    fi

    echo "$output"
    echo ""

    # Parse results from bats output
    # bats outputs lines like: "1..N" at start, "ok N" or "not ok N" for each test
    # Note: grep -c returns exit 1 if no matches, so we capture and default to 0
    local passed failed skipped
    passed=$(echo "$output" | grep -c "^ok " 2>/dev/null) || passed=0
    failed=$(echo "$output" | grep -c "^not ok " 2>/dev/null) || failed=0
    skipped=$(echo "$output" | grep -c "# skip" 2>/dev/null) || skipped=0

    # Capture failing test names for summary
    local failed_lines
    failed_lines=$(echo "$output" | grep "^not ok " 2>/dev/null) || true
    if [[ -n "$failed_lines" ]]; then
        while IFS= read -r line; do
            # Extract test name: "not ok 123 test name here" -> "test name here"
            local test_name="${line#not ok [0-9]* }"
            FAILED_TESTS="${FAILED_TESTS}  [$suite_name] $test_name"$'\n'
        done <<< "$failed_lines"
    fi

    TOTAL_PASSED=$((TOTAL_PASSED + passed))
    TOTAL_FAILED=$((TOTAL_FAILED + failed))
    TOTAL_SKIPPED=$((TOTAL_SKIPPED + skipped))

    if [[ $status -eq 0 ]]; then
        echo -e "${GREEN}✓ $suite_name tests passed${NC}"
    else
        echo -e "${RED}✗ $suite_name tests had failures${NC}"
    fi
    echo ""
}

# Run test suites
if [[ "$RUN_UNIT" == true ]]; then
    run_test_suite "Unit" "$SCRIPT_DIR/unit"
fi

if [[ "$RUN_INTEGRATION" == true ]]; then
    run_test_suite "Integration" "$SCRIPT_DIR/integration"
fi

# Summary
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}                 Summary${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""
echo -e "Passed:  ${GREEN}$TOTAL_PASSED${NC}"
echo -e "Failed:  ${RED}$TOTAL_FAILED${NC}"
echo -e "Skipped: ${YELLOW}$TOTAL_SKIPPED${NC}"
echo ""

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
