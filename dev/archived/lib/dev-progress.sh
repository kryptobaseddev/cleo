#!/usr/bin/env bash
# dev-progress.sh - Progress bars, spinners, and timing utilities
# Part of claude-todo development tooling
#
# Provides visual progress indicators for long-running operations like
# benchmarks, batch processing, and compliance checks.
#
# Dependencies:
#   - dev-colors.sh (required)
#   - dev-output.sh (required)
#
# Usage:
#   source "${DEV_LIB_DIR}/dev-progress.sh"
#   dev_progress_bar 50 100 30 "Processing..."
#   elapsed=$(dev_measure_ms "some_command")
#
# Version: 1.0.0

# ============================================================================
# GUARD AGAINST MULTIPLE SOURCING
# ============================================================================
[[ -n "${_DEV_PROGRESS_SH_LOADED:-}" ]] && return 0
_DEV_PROGRESS_SH_LOADED=1

# ============================================================================
# DEPENDENCIES
# ============================================================================

_DEV_PROGRESS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source required dependencies
if [[ -f "$_DEV_PROGRESS_LIB_DIR/dev-colors.sh" ]]; then
    source "$_DEV_PROGRESS_LIB_DIR/dev-colors.sh"
else
    echo "ERROR: dev-progress.sh requires dev-colors.sh" >&2
    exit 1
fi

if [[ -f "$_DEV_PROGRESS_LIB_DIR/dev-output.sh" ]]; then
    source "$_DEV_PROGRESS_LIB_DIR/dev-output.sh"
else
    echo "ERROR: dev-progress.sh requires dev-output.sh" >&2
    exit 1
fi

# ============================================================================
# PROGRESS BAR
# ============================================================================

# Draw a progress bar
# Args: $1 = current value
#       $2 = total value
#       $3 = width in characters (default: 30)
#       $4 = label (optional)
# Note: Uses \r for in-place updates; call dev_progress_done() when complete
dev_progress_bar() {
    local current="$1"
    local total="$2"
    local width="${3:-30}"
    local label="${4:-}"

    # Calculate percentage and bar lengths
    local percent=0
    local filled=0
    local empty=$width

    if [[ "$total" -gt 0 ]]; then
        percent=$((current * 100 / total))
        filled=$((current * width / total))
        empty=$((width - filled))
    fi

    # Clamp values
    [[ "$filled" -lt 0 ]] && filled=0
    [[ "$filled" -gt "$width" ]] && filled=$width
    [[ "$empty" -lt 0 ]] && empty=0

    # Build bar string
    local bar=""
    if [[ "$filled" -gt 0 ]]; then
        bar+=$(printf "${DEV_SYM_BAR_FULL}%.0s" $(seq 1 $filled))
    fi
    if [[ "$empty" -gt 0 ]]; then
        bar+=$(printf "${DEV_SYM_BAR_EMPTY}%.0s" $(seq 1 $empty))
    fi

    # Print with carriage return for in-place update
    printf "\r[%s] %3d%% %s" "$bar" "$percent" "$label"
}

# Complete progress bar (add newline)
dev_progress_done() {
    echo ""
}

# Print a static progress bar (with newline, not in-place)
# Args: $1 = current value
#       $2 = total value
#       $3 = width (default: 30)
#       $4 = label (optional)
dev_progress_bar_static() {
    dev_progress_bar "$@"
    dev_progress_done
}

# ============================================================================
# SPINNER
# ============================================================================

# Spinner state
_DEV_SPINNER_PID=""
_DEV_SPINNER_IDX=0

# Spinner frames (Unicode or ASCII based on capability)
if dev_should_use_unicode; then
    _DEV_SPINNER_FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
else
    _DEV_SPINNER_FRAMES=('|' '/' '-' '\')
fi

# Start a spinner with message
# Args: $1 = message (optional, default: "Working...")
# Note: Runs in background; call dev_spinner_stop() to stop
dev_spinner_start() {
    local message="${1:-Working...}"

    # Kill any existing spinner
    dev_spinner_stop 2>/dev/null

    # Start spinner in background
    (
        local idx=0
        local frame_count=${#_DEV_SPINNER_FRAMES[@]}

        while true; do
            printf "\r${_DEV_SPINNER_FRAMES[$idx]} %s " "$message"
            idx=$(( (idx + 1) % frame_count ))
            sleep 0.1
        done
    ) &
    _DEV_SPINNER_PID=$!
}

# Stop the spinner
# Args: $1 = final message (optional)
dev_spinner_stop() {
    local final_message="${1:-}"

    if [[ -n "$_DEV_SPINNER_PID" ]]; then
        kill "$_DEV_SPINNER_PID" 2>/dev/null || true
        wait "$_DEV_SPINNER_PID" 2>/dev/null || true
        _DEV_SPINNER_PID=""
    fi

    # Clear spinner line
    printf "\r%-60s\r" " "

    # Print final message if provided
    [[ -n "$final_message" ]] && echo "$final_message"
}

# ============================================================================
# TIMING UTILITIES
# ============================================================================

# Measure execution time in milliseconds
# Args: $1 = command to execute (as string)
# Returns: elapsed milliseconds (echoed)
# Note: Command output is suppressed
dev_measure_ms() {
    local cmd="$1"
    local start_ns end_ns elapsed_ms

    # Try nanosecond precision first
    if date +%s%N &>/dev/null 2>&1; then
        start_ns=$(date +%s%N)
        eval "$cmd" >/dev/null 2>&1 || true
        end_ns=$(date +%s%N)
        elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
    else
        # Fallback to second precision (multiply by 1000)
        local start_s end_s
        start_s=$(date +%s)
        eval "$cmd" >/dev/null 2>&1 || true
        end_s=$(date +%s)
        elapsed_ms=$(( (end_s - start_s) * 1000 ))
    fi

    echo "$elapsed_ms"
}

# Measure execution time with output captured
# Args: $1 = command to execute (as string)
# Sets: DEV_MEASURE_OUTPUT = command output
#       DEV_MEASURE_TIME = elapsed milliseconds
#       DEV_MEASURE_EXIT = exit code
dev_measure_with_output() {
    local cmd="$1"
    local start_ns end_ns

    # Try nanosecond precision
    if date +%s%N &>/dev/null 2>&1; then
        start_ns=$(date +%s%N)
        DEV_MEASURE_OUTPUT=$(eval "$cmd" 2>&1) || DEV_MEASURE_EXIT=$?
        end_ns=$(date +%s%N)
        DEV_MEASURE_TIME=$(( (end_ns - start_ns) / 1000000 ))
    else
        local start_s end_s
        start_s=$(date +%s)
        DEV_MEASURE_OUTPUT=$(eval "$cmd" 2>&1) || DEV_MEASURE_EXIT=$?
        end_s=$(date +%s)
        DEV_MEASURE_TIME=$(( (end_s - start_s) * 1000 ))
    fi

    DEV_MEASURE_EXIT=${DEV_MEASURE_EXIT:-0}
    export DEV_MEASURE_OUTPUT DEV_MEASURE_TIME DEV_MEASURE_EXIT
}

# Format milliseconds for human display
# Args: $1 = milliseconds
# Returns: formatted string (echoed)
dev_format_duration() {
    local ms="$1"

    if [[ "$ms" -lt 1000 ]]; then
        echo "${ms}ms"
    elif [[ "$ms" -lt 60000 ]]; then
        # Less than a minute: show seconds
        if command -v bc &>/dev/null; then
            printf "%.2fs" "$(echo "scale=2; $ms/1000" | bc)"
        else
            echo "$((ms / 1000))s"
        fi
    elif [[ "$ms" -lt 3600000 ]]; then
        # Less than an hour: show minutes and seconds
        local mins=$((ms / 60000))
        local secs=$(( (ms % 60000) / 1000 ))
        echo "${mins}m${secs}s"
    else
        # Hours, minutes, seconds
        local hours=$((ms / 3600000))
        local mins=$(( (ms % 3600000) / 60000 ))
        local secs=$(( (ms % 60000) / 1000 ))
        echo "${hours}h${mins}m${secs}s"
    fi
}

# ============================================================================
# BENCHMARK UTILITIES
# ============================================================================

# Run a command multiple times and calculate statistics
# Args: $1 = command to benchmark
#       $2 = number of runs (default: 3)
# Sets: DEV_BENCH_MEAN, DEV_BENCH_MIN, DEV_BENCH_MAX (milliseconds)
dev_benchmark() {
    local cmd="$1"
    local runs="${2:-3}"

    local times=()
    local sum=0
    local min=999999999
    local max=0

    for ((i=1; i<=runs; i++)); do
        local elapsed
        elapsed=$(dev_measure_ms "$cmd")
        times+=("$elapsed")
        sum=$((sum + elapsed))
        [[ "$elapsed" -lt "$min" ]] && min="$elapsed"
        [[ "$elapsed" -gt "$max" ]] && max="$elapsed"
    done

    DEV_BENCH_MEAN=$((sum / runs))
    DEV_BENCH_MIN=$min
    DEV_BENCH_MAX=$max

    export DEV_BENCH_MEAN DEV_BENCH_MIN DEV_BENCH_MAX
}

# Print benchmark results
# Args: $1 = label
#       $2 = mean (ms)
#       $3 = min (ms)
#       $4 = max (ms)
#       $5 = target (ms, optional)
dev_print_benchmark() {
    local label="$1"
    local mean="$2"
    local min="$3"
    local max="$4"
    local target="${5:-}"

    local status=""
    if [[ -n "$target" ]]; then
        if [[ "$mean" -le "$target" ]]; then
            status="${DEV_GREEN}PASS${DEV_NC}"
        else
            status="${DEV_RED}FAIL${DEV_NC}"
        fi
    fi

    printf "  %-20s mean=%s min=%s max=%s %s\n" \
        "$label" \
        "$(dev_format_duration "$mean")" \
        "$(dev_format_duration "$min")" \
        "$(dev_format_duration "$max")" \
        "$status"
}

# ============================================================================
# COUNTDOWN / DELAY
# ============================================================================

# Display countdown with message
# Args: $1 = seconds
#       $2 = message (optional)
dev_countdown() {
    local seconds="$1"
    local message="${2:-Waiting}"

    for ((i=seconds; i>0; i--)); do
        printf "\r%s %d... " "$message" "$i"
        sleep 1
    done
    printf "\r%-40s\r" " "
}

# ============================================================================
# EXPORTS
# ============================================================================

# Progress bar
export -f dev_progress_bar
export -f dev_progress_done
export -f dev_progress_bar_static

# Spinner
export -f dev_spinner_start
export -f dev_spinner_stop

# Timing
export -f dev_measure_ms
export -f dev_measure_with_output
export -f dev_format_duration

# Benchmark
export -f dev_benchmark
export -f dev_print_benchmark

# Countdown
export -f dev_countdown
