#!/usr/bin/env bash
# ab-test.sh - A/B Testing Framework for CLEO vs Baseline Comparison
#
# LAYER: 2 (Services - depends on Layer 1)
# DEPENDENCIES: exit-codes.sh, token-estimation.sh, otel-integration.sh
# PROVIDES:
#   start_ab_test          - Begin A/B test session
#   end_ab_test            - End A/B test session with summary
#   log_ab_event           - Log A/B test event
#   compare_ab_test        - Compare two test variants
#   get_ab_test_results    - Get test results for a variant
#   get_ab_test_stats      - Get statistical summary
#   list_ab_tests          - List all A/B tests
#
# This framework enables scientific comparison of:
# - CLEO (with subagents, manifests, protocols) vs Baseline (direct implementation)
# - Token consumption, validation effectiveness, completion rates
#
# @task T2858
# @epic T2163
# @why Need scientific evidence that CLEO provides value
# @what A/B testing framework to compare approaches with statistical rigor

#=== SOURCE GUARD ================================================
[[ -n "${_AB_TEST_LOADED:-}" ]] && return 0
declare -r _AB_TEST_LOADED=1

set -euo pipefail

# Determine library directory
_AB_LIB_DIR="${BASH_SOURCE[0]%/*}"
[[ "$_AB_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _AB_LIB_DIR="."

# Source dependencies
# shellcheck source=lib/exit-codes.sh
source "${_AB_LIB_DIR}/exit-codes.sh"
# shellcheck source=lib/token-estimation.sh
source "${_AB_LIB_DIR}/token-estimation.sh"
# shellcheck source=lib/otel-integration.sh
source "${_AB_LIB_DIR}/otel-integration.sh"
# shellcheck source=lib/file-ops.sh
source "${_AB_LIB_DIR}/file-ops.sh"

# Metrics directory and file
_AB_METRICS_DIR="${AB_TEST_METRICS_DIR:-.cleo/metrics/ab-tests}"
_AB_METRICS_FILE="${_AB_METRICS_DIR}/AB_TESTS.jsonl"

# Session state
declare -g _AB_CURRENT_TEST=""
declare -g _AB_CURRENT_VARIANT=""
declare -g _AB_START_TIME=""
declare -g _AB_START_TOKENS=""

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

_ab_debug() {
    [[ -n "${AB_TEST_DEBUG:-}" ]] && echo "[ab-test] DEBUG: $1" >&2
    return 0
}

_ab_error() {
    echo "[ab-test] ERROR: $1" >&2
}

_ab_ensure_dirs() {
    mkdir -p "$_AB_METRICS_DIR" 2>/dev/null || true
}

_ab_validate_variant() {
    local variant="$1"
    if [[ "$variant" != "cleo" && "$variant" != "baseline" ]]; then
        _ab_error "Invalid variant: $variant. Must be 'cleo' or 'baseline'"
        return "$EXIT_INVALID_ARGS"
    fi
}

# ============================================================================
# CORE A/B TEST FUNCTIONS
# ============================================================================

# start_ab_test - Begin an A/B test session
# Args: $1 = test_name (unique identifier for this test)
#       $2 = variant ("cleo" | "baseline")
#       $3 = optional: description
# Returns: 0 on success
# Sets environment variables: AB_TEST_NAME, AB_TEST_VARIANT
# Usage: start_ab_test "feature-x-implementation" "cleo" "Using subagent orchestrator"
start_ab_test() {
    local test_name="$1"
    local variant="$2"
    local description="${3:-}"

    # Validate inputs
    if [[ -z "$test_name" ]]; then
        _ab_error "Test name required"
        return "$EXIT_INVALID_ARGS"
    fi

    _ab_validate_variant "$variant" || return $?

    _ab_ensure_dirs

    # Set global state
    _AB_CURRENT_TEST="$test_name"
    _AB_CURRENT_VARIANT="$variant"
    _AB_START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Export for child processes
    export AB_TEST_NAME="$test_name"
    export AB_TEST_VARIANT="$variant"

    # Capture starting token counts
    if is_otel_enabled; then
        _AB_START_TOKENS=$(get_session_tokens "$test_name-$variant" 2>/dev/null | jq -r '.tokens.total // 0')
    else
        _AB_START_TOKENS=0
    fi

    # Log start event
    log_ab_event "start" "$test_name" "$variant" \
        "{\"description\":\"$description\",\"otel_enabled\":$(is_otel_enabled && echo true || echo false)}"

    _ab_debug "Started A/B test: $test_name (variant: $variant)"
}

# end_ab_test - End an A/B test session with summary
# Args: $1 = optional: tasks_completed count
#       $2 = optional: validation_passes count
#       $3 = optional: validation_failures count
#       $4 = optional: notes
# Returns: JSON summary of the test run
end_ab_test() {
    local tasks_completed="${1:-0}"
    local validation_passes="${2:-0}"
    local validation_failures="${3:-0}"
    local notes="${4:-}"

    if [[ -z "$_AB_CURRENT_TEST" ]]; then
        _ab_error "No active A/B test. Call start_ab_test first."
        echo '{"error":"No active test"}'
        return "$EXIT_GENERAL_ERROR"
    fi

    local end_time
    end_time=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Calculate duration
    local duration_seconds=0
    if [[ -n "$_AB_START_TIME" ]]; then
        local start_epoch end_epoch
        start_epoch=$(date -d "$_AB_START_TIME" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$_AB_START_TIME" +%s 2>/dev/null || echo 0)
        end_epoch=$(date -d "$end_time" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$end_time" +%s 2>/dev/null || echo 0)
        duration_seconds=$((end_epoch - start_epoch))
    fi

    # Capture ending token counts
    local total_tokens=0
    local token_source="none"

    if is_otel_enabled; then
        local end_tokens
        end_tokens=$(get_session_tokens "$_AB_CURRENT_TEST-$_AB_CURRENT_VARIANT" 2>/dev/null | jq -r '.tokens.total // 0')
        total_tokens=$((end_tokens - _AB_START_TOKENS))
        token_source="otel"
    else
        # Fallback: check TOKEN_USAGE.jsonl for estimated tokens
        if [[ -f ".cleo/metrics/TOKEN_USAGE.jsonl" ]]; then
            total_tokens=$(grep "\"session_id\":\"$_AB_CURRENT_TEST\"" .cleo/metrics/TOKEN_USAGE.jsonl 2>/dev/null | \
                          jq -s 'map(.estimated_tokens // 0) | add' || echo 0)
            token_source="estimated"
        fi
    fi

    # Calculate validation rate
    local total_validations=$((validation_passes + validation_failures))
    local validation_pass_rate=0
    if [[ $total_validations -gt 0 ]]; then
        validation_pass_rate=$(( (validation_passes * 100) / total_validations ))
    fi

    # Build summary
    local summary
    summary=$(jq -nc \
        --arg test "$_AB_CURRENT_TEST" \
        --arg variant "$_AB_CURRENT_VARIANT" \
        --arg start "$_AB_START_TIME" \
        --arg end "$end_time" \
        --argjson duration "$duration_seconds" \
        --argjson tokens "$total_tokens" \
        --arg token_source "$token_source" \
        --argjson tasks "$tasks_completed" \
        --argjson val_pass "$validation_passes" \
        --argjson val_fail "$validation_failures" \
        --argjson val_rate "$validation_pass_rate" \
        --arg notes "$notes" \
        '{
            test_name: $test,
            variant: $variant,
            start_time: $start,
            end_time: $end,
            duration_seconds: $duration,
            tokens_consumed: $tokens,
            token_source: $token_source,
            tasks_completed: $tasks,
            validations: {
                passed: $val_pass,
                failed: $val_fail,
                total: ($val_pass + $val_fail),
                pass_rate_percent: $val_rate
            },
            notes: $notes
        }')

    # Log end event
    log_ab_event "end" "$_AB_CURRENT_TEST" "$_AB_CURRENT_VARIANT" "$summary"

    # Clear state
    _AB_CURRENT_TEST=""
    _AB_CURRENT_VARIANT=""
    _AB_START_TIME=""
    _AB_START_TOKENS=""
    unset AB_TEST_NAME AB_TEST_VARIANT

    _ab_debug "Ended A/B test"
    echo "$summary"
}

# log_ab_event - Log an A/B test event
# Args: $1 = event_type (start|end|milestone|note)
#       $2 = test_name
#       $3 = variant
#       $4 = optional: context JSON or string
# Returns: 0 on success
# @task T3152 - Applied atomic_jsonl_append for flock protection
# @epic T3147 - Manifest Bash Foundation and Protocol Updates
log_ab_event() {
    local event_type="$1"
    local test_name="$2"
    local variant="$3"
    local context="${4:-{}}"

    _ab_ensure_dirs

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build entry - use context as-is if valid JSON, otherwise wrap as note
    local entry
    if echo "$context" | jq -e . >/dev/null 2>&1; then
        # Context is valid JSON - use jq to merge it properly
        entry=$(echo "$context" | jq -c \
            --arg ts "$timestamp" \
            --arg event "$event_type" \
            --arg test "$test_name" \
            --arg variant "$variant" \
            '{
                timestamp: $ts,
                event_type: $event,
                test_name: $test,
                variant: $variant,
                context: .
            }')
    else
        # Context is plain string - wrap as note
        entry=$(jq -nc \
            --arg ts "$timestamp" \
            --arg event "$event_type" \
            --arg test "$test_name" \
            --arg variant "$variant" \
            --arg note "$context" \
            '{
                timestamp: $ts,
                event_type: $event,
                test_name: $test,
                variant: $variant,
                context: {note: $note}
            }')
    fi

    atomic_jsonl_append "$_AB_METRICS_FILE" "$entry" 2>/dev/null || true
    _ab_debug "Logged event: $event_type for $test_name ($variant)"
}

# ============================================================================
# RETRIEVAL FUNCTIONS
# ============================================================================

# get_ab_test_results - Get results for a specific test variant
# Args: $1 = test_name
#       $2 = variant
# Returns: JSON with test results
get_ab_test_results() {
    local test_name="$1"
    local variant="$2"

    if [[ ! -f "$_AB_METRICS_FILE" ]]; then
        echo '{"error":"No A/B test data found"}'
        return 0
    fi

    # Get the most recent end event for this test+variant
    local result
    result=$(grep "\"test_name\":\"$test_name\"" "$_AB_METRICS_FILE" 2>/dev/null | \
             grep "\"variant\":\"$variant\"" | \
             grep "\"event_type\":\"end\"" | \
             tail -1)

    if [[ -z "$result" ]]; then
        echo "{\"error\":\"No results found for test '$test_name' variant '$variant'\"}"
        return 0
    fi

    # Extract context (which contains the summary)
    echo "$result" | jq -c '.context'
}

# list_ab_tests - List all A/B tests
# Args: $1 = optional: filter by test_name
# Returns: JSON array of unique test names with variant counts
list_ab_tests() {
    local filter="${1:-}"

    if [[ ! -f "$_AB_METRICS_FILE" ]]; then
        echo '[]'
        return 0
    fi

    # Get unique test names and count variants
    if [[ -n "$filter" ]]; then
        grep "\"test_name\":\"$filter\"" "$_AB_METRICS_FILE" 2>/dev/null | \
            jq -s 'group_by(.test_name) | map({
                test_name: .[0].test_name,
                variants: map(.variant) | unique,
                total_runs: length,
                last_run: map(.timestamp) | max
            })'
    else
        jq -s 'group_by(.test_name) | map({
            test_name: .[0].test_name,
            variants: map(.variant) | unique,
            total_runs: length,
            last_run: map(.timestamp) | max
        })' "$_AB_METRICS_FILE" 2>/dev/null
    fi
}

# ============================================================================
# COMPARISON FUNCTIONS
# ============================================================================

# compare_ab_test - Compare two variants of the same test
# Args: $1 = test_name
# Returns: JSON comparison with statistical analysis
# Note: Compares most recent "cleo" vs most recent "baseline" run
compare_ab_test() {
    local test_name="$1"

    if [[ -z "$test_name" ]]; then
        _ab_error "Test name required"
        echo '{"error":"Test name required"}'
        return "$EXIT_INVALID_ARGS"
    fi

    # Get results for both variants
    local cleo_result baseline_result
    cleo_result=$(get_ab_test_results "$test_name" "cleo")
    baseline_result=$(get_ab_test_results "$test_name" "baseline")

    # Check if both variants exist
    if echo "$cleo_result" | jq -e '.error' >/dev/null 2>&1; then
        echo "{\"error\":\"No CLEO variant found for test '$test_name'\"}"
        return 0
    fi
    if echo "$baseline_result" | jq -e '.error' >/dev/null 2>&1; then
        echo "{\"error\":\"No baseline variant found for test '$test_name'\"}"
        return 0
    fi

    # Extract metrics
    local cleo_tokens baseline_tokens
    local cleo_tasks baseline_tasks
    local cleo_val_rate baseline_val_rate
    local cleo_duration baseline_duration

    cleo_tokens=$(echo "$cleo_result" | jq -r '.tokens_consumed // 0')
    baseline_tokens=$(echo "$baseline_result" | jq -r '.tokens_consumed // 0')

    cleo_tasks=$(echo "$cleo_result" | jq -r '.tasks_completed // 0')
    baseline_tasks=$(echo "$baseline_result" | jq -r '.tasks_completed // 0')

    cleo_val_rate=$(echo "$cleo_result" | jq -r '.validations.pass_rate_percent // 0')
    baseline_val_rate=$(echo "$baseline_result" | jq -r '.validations.pass_rate_percent // 0')

    cleo_duration=$(echo "$cleo_result" | jq -r '.duration_seconds // 0')
    baseline_duration=$(echo "$baseline_result" | jq -r '.duration_seconds // 0')

    # Calculate deltas
    local token_diff token_savings_pct
    token_diff=$((baseline_tokens - cleo_tokens))
    token_savings_pct=0
    if [[ $baseline_tokens -gt 0 ]]; then
        token_savings_pct=$(( (token_diff * 100) / baseline_tokens ))
    fi

    local task_diff duration_diff val_rate_diff
    task_diff=$((cleo_tasks - baseline_tasks))
    duration_diff=$((baseline_duration - cleo_duration))
    val_rate_diff=$((cleo_val_rate - baseline_val_rate))

    # Tokens per task
    local cleo_tokens_per_task=0 baseline_tokens_per_task=0
    [[ $cleo_tasks -gt 0 ]] && cleo_tokens_per_task=$((cleo_tokens / cleo_tasks))
    [[ $baseline_tasks -gt 0 ]] && baseline_tokens_per_task=$((baseline_tokens / baseline_tasks))

    # Statistical significance (simple chi-square approximation)
    # If token difference > 20% AND sample sizes reasonable, likely significant
    local is_significant="false"
    if [[ ${token_savings_pct#-} -ge 20 ]]; then
        is_significant="true"
    fi

    # Determine verdict
    local verdict
    if [[ $token_savings_pct -ge 70 ]]; then
        verdict="Excellent: CLEO saves >70% tokens"
    elif [[ $token_savings_pct -ge 50 ]]; then
        verdict="Good: CLEO saves 50-70% tokens"
    elif [[ $token_savings_pct -ge 20 ]]; then
        verdict="Moderate: CLEO saves 20-50% tokens"
    elif [[ $token_savings_pct -ge 0 ]]; then
        verdict="Minimal: CLEO saves <20% tokens"
    else
        verdict="Warning: CLEO used MORE tokens"
    fi

    # Build comparison
    jq -nc \
        --arg test "$test_name" \
        --argjson cleo_tokens "$cleo_tokens" \
        --argjson baseline_tokens "$baseline_tokens" \
        --argjson token_diff "$token_diff" \
        --argjson token_savings "$token_savings_pct" \
        --argjson cleo_tasks "$cleo_tasks" \
        --argjson baseline_tasks "$baseline_tasks" \
        --argjson task_diff "$task_diff" \
        --argjson cleo_tpt "$cleo_tokens_per_task" \
        --argjson baseline_tpt "$baseline_tokens_per_task" \
        --argjson cleo_val "$cleo_val_rate" \
        --argjson baseline_val "$baseline_val_rate" \
        --argjson val_diff "$val_rate_diff" \
        --argjson cleo_dur "$cleo_duration" \
        --argjson baseline_dur "$baseline_duration" \
        --argjson dur_diff "$duration_diff" \
        --arg significant "$is_significant" \
        --arg verdict "$verdict" \
        --argjson cleo_full "$cleo_result" \
        --argjson baseline_full "$baseline_result" \
        '{
            test_name: $test,
            comparison: {
                tokens: {
                    cleo: $cleo_tokens,
                    baseline: $baseline_tokens,
                    difference: $token_diff,
                    savings_percent: $token_savings,
                    winner: (if $token_diff > 0 then "cleo" else "baseline" end)
                },
                tasks_completed: {
                    cleo: $cleo_tasks,
                    baseline: $baseline_tasks,
                    difference: $task_diff
                },
                tokens_per_task: {
                    cleo: $cleo_tpt,
                    baseline: $baseline_tpt,
                    efficiency_gain_percent: (
                        if $baseline_tpt > 0
                        then ((($baseline_tpt - $cleo_tpt) * 100) / $baseline_tpt)
                        else 0
                        end
                    )
                },
                validation_pass_rate: {
                    cleo: $cleo_val,
                    baseline: $baseline_val,
                    difference: $val_diff
                },
                duration_seconds: {
                    cleo: $cleo_dur,
                    baseline: $baseline_dur,
                    difference: $dur_diff
                }
            },
            statistical: {
                significant: ($significant == "true"),
                confidence_note: "Simple threshold test: >20% difference considered significant"
            },
            verdict: $verdict,
            details: {
                cleo: $cleo_full,
                baseline: $baseline_full
            }
        }'
}

# get_ab_test_stats - Get statistical summary of all A/B tests
# Returns: JSON with aggregate statistics
get_ab_test_stats() {
    if [[ ! -f "$_AB_METRICS_FILE" ]]; then
        echo '{"total_tests":0,"total_runs":0,"avg_token_savings":0}'
        return 0
    fi

    # Count unique tests and total runs
    local unique_tests total_runs
    unique_tests=$(jq -s 'map(.test_name) | unique | length' "$_AB_METRICS_FILE" 2>/dev/null)
    total_runs=$(wc -l < "$_AB_METRICS_FILE" 2>/dev/null || echo 0)

    # Calculate average token savings across all comparisons
    local total_savings=0
    local comparison_count=0

    # Get unique test names
    local test_names
    test_names=$(jq -sr 'map(.test_name) | unique[]' "$_AB_METRICS_FILE" 2>/dev/null)

    while IFS= read -r test_name; do
        [[ -z "$test_name" ]] && continue

        local comparison
        comparison=$(compare_ab_test "$test_name" 2>/dev/null)

        if ! echo "$comparison" | jq -e '.error' >/dev/null 2>&1; then
            local savings
            savings=$(echo "$comparison" | jq -r '.comparison.tokens.savings_percent // 0')
            total_savings=$((total_savings + savings))
            comparison_count=$((comparison_count + 1))
        fi
    done <<< "$test_names"

    local avg_savings=0
    [[ $comparison_count -gt 0 ]] && avg_savings=$((total_savings / comparison_count))

    jq -nc \
        --argjson tests "$unique_tests" \
        --argjson runs "$total_runs" \
        --argjson avg_savings "$avg_savings" \
        --argjson comparisons "$comparison_count" \
        '{
            total_tests: $tests,
            total_runs: $runs,
            completed_comparisons: $comparisons,
            avg_token_savings_percent: $avg_savings,
            summary: (
                "Tracked " + ($tests | tostring) + " tests with " +
                ($comparisons | tostring) + " A/B comparisons. " +
                "Average token savings: " + ($avg_savings | tostring) + "%"
            )
        }'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f start_ab_test
export -f end_ab_test
export -f log_ab_event
export -f get_ab_test_results
export -f compare_ab_test
export -f get_ab_test_stats
export -f list_ab_tests
