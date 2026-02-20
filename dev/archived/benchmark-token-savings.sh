#!/usr/bin/env bash
# dev/benchmark-token-savings.sh
# A/B Benchmark for Token Savings Measurement
# Compares manifest lookups (key_findings) vs full file reads

set -euo pipefail

# Source file-ops for atomic JSONL append
# shellcheck source=lib/data/file-ops.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/data/file-ops.sh"

# Constants
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_FILE="$PROJECT_ROOT/claudedocs/agent-outputs/MANIFEST.jsonl"
OUTPUT_FILE="$PROJECT_ROOT/.cleo/metrics/BENCHMARK.jsonl"
CONTEXT_STATE_FILE="$PROJECT_ROOT/.cleo/context-state.json"

# Color output
readonly COLOR_RESET='\033[0m'
readonly COLOR_GREEN='\033[0;32m'
readonly COLOR_BLUE='\033[0;34m'
readonly COLOR_YELLOW='\033[0;33m'

log_info() {
    echo -e "${COLOR_BLUE}[INFO]${COLOR_RESET} $*"
}

log_success() {
    echo -e "${COLOR_GREEN}[SUCCESS]${COLOR_RESET} $*"
}

log_warn() {
    echo -e "${COLOR_YELLOW}[WARN]${COLOR_RESET} $*"
}

# Ensure output directory exists
ensure_output_directory() {
    local output_dir
    output_dir=$(dirname "$OUTPUT_FILE")
    if [[ ! -d "$output_dir" ]]; then
        mkdir -p "$output_dir"
        log_info "Created metrics directory: $output_dir"
    fi
}

# Get current context tokens from context state file (if available)
get_context_tokens() {
    if [[ -f "$CONTEXT_STATE_FILE" ]]; then
        jq -r '.contextUsage.currentTokens // null' "$CONTEXT_STATE_FILE"
    else
        echo "null"
    fi
}

# Estimate tokens from character count (rough approximation: 4 chars = 1 token)
estimate_tokens() {
    local char_count=$1
    echo $((char_count / 4))
}

# Method A: Read manifest entry only (key_findings)
read_manifest_entry() {
    local entry_id=$1
    local content

    # Find and extract just the manifest entry
    content=$(jq -r --arg id "$entry_id" 'select(.id == $id) | .key_findings // []' "$MANIFEST_FILE" | jq -c .)

    echo "$content"
}

# Method B: Read full file
read_full_file() {
    local file_path=$1

    if [[ ! -f "$file_path" ]]; then
        echo ""
        return 1
    fi

    cat "$file_path"
}

# Run a single benchmark test
# @task T3152 - Applied atomic_jsonl_append for flock protection
# @epic T3147 - Manifest Bash Foundation and Protocol Updates
run_benchmark_test() {
    local test_case=$1
    local method=$2
    local entry_id=$3
    local file_path=$4

    local content
    local chars_read
    local estimated_tokens
    local context_before
    local context_after
    local real_tokens

    # Get context before (if available)
    context_before=$(get_context_tokens)

    # Perform the read operation
    if [[ "$method" == "manifest" ]]; then
        content=$(read_manifest_entry "$entry_id")
    else
        content=$(read_full_file "$file_path")
    fi

    # Calculate character count and estimate tokens
    chars_read=${#content}
    estimated_tokens=$(estimate_tokens "$chars_read")

    # Get context after (if available)
    context_after=$(get_context_tokens)

    # Calculate real tokens if context state is available
    if [[ "$context_before" != "null" && "$context_after" != "null" ]]; then
        real_tokens=$((context_after - context_before))
    else
        real_tokens="null"
    fi

    # Log the result
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local result
    result=$(jq -n \
        --arg ts "$timestamp" \
        --arg test "$test_case" \
        --arg method "$method" \
        --argjson chars "$chars_read" \
        --argjson est_tokens "$estimated_tokens" \
        --arg real "$real_tokens" \
        '{
            timestamp: $ts,
            test_case: $test,
            method: $method,
            chars_read: $chars,
            estimated_tokens: $est_tokens,
            real_tokens: (if $real == "null" then null else ($real | tonumber) end)
        }')

    atomic_jsonl_append "$OUTPUT_FILE" "$result" 2>/dev/null || true

    # Return metrics for display
    echo "$chars_read|$estimated_tokens|$real_tokens"
}

# Test Case 1: Small task lookup (single manifest entry)
test_case_1_small_task() {
    log_info "Running Test Case 1: Small task lookup (single entry)"

    local entry_id="T2405-token-pre-resolution"
    local file_path="$PROJECT_ROOT/lib/skills/token-inject.sh"

    # Method A: Manifest
    local metrics_a
    metrics_a=$(run_benchmark_test "small_task_single_entry" "manifest" "$entry_id" "$file_path")
    IFS='|' read -r chars_a tokens_a real_a <<< "$metrics_a"

    # Method B: Full file
    local metrics_b
    metrics_b=$(run_benchmark_test "small_task_single_entry" "full_file" "$entry_id" "$file_path")
    IFS='|' read -r chars_b tokens_b real_b <<< "$metrics_b"

    log_success "Test 1 complete: Manifest=$tokens_a tokens, Full=$tokens_b tokens (savings: $((tokens_b - tokens_a)) tokens)"
}

# Test Case 2: Medium task (3-5 related entries)
test_case_2_medium_task() {
    log_info "Running Test Case 2: Medium task (3-5 related entries)"

    # Get 3-5 entries from manifest
    local entries
    entries=$(head -5 "$MANIFEST_FILE" | jq -r '.id' | head -3)

    local total_chars_a=0
    local total_chars_b=0

    for entry_id in $entries; do
        local file_path
        file_path=$(jq -r --arg id "$entry_id" 'select(.id == $id) | .file' "$MANIFEST_FILE")

        if [[ -n "$file_path" ]]; then
            file_path="$PROJECT_ROOT/claudedocs/agent-outputs/$file_path"

            # Method A: Manifest
            local metrics_a
            metrics_a=$(run_benchmark_test "medium_task_multiple_entries" "manifest" "$entry_id" "$file_path")
            IFS='|' read -r chars_a _ _ <<< "$metrics_a"
            total_chars_a=$((total_chars_a + chars_a))

            # Method B: Full file
            local metrics_b
            metrics_b=$(run_benchmark_test "medium_task_multiple_entries" "full_file" "$entry_id" "$file_path")
            IFS='|' read -r chars_b _ _ <<< "$metrics_b"
            total_chars_b=$((total_chars_b + chars_b))
        fi
    done

    local total_tokens_a=$(estimate_tokens "$total_chars_a")
    local total_tokens_b=$(estimate_tokens "$total_chars_b")

    log_success "Test 2 complete: Manifest=$total_tokens_a tokens, Full=$total_tokens_b tokens (savings: $((total_tokens_b - total_tokens_a)) tokens)"
}

# Test Case 3: Large task (10+ entries)
test_case_3_large_task() {
    log_info "Running Test Case 3: Large task (10+ entries)"

    # Get 10 entries from manifest
    local entries
    entries=$(head -15 "$MANIFEST_FILE" | jq -r '.id' | head -10)

    local total_chars_a=0
    local total_chars_b=0

    for entry_id in $entries; do
        local file_path
        file_path=$(jq -r --arg id "$entry_id" 'select(.id == $id) | .file' "$MANIFEST_FILE")

        if [[ -n "$file_path" ]]; then
            file_path="$PROJECT_ROOT/claudedocs/agent-outputs/$file_path"

            # Method A: Manifest
            local metrics_a
            metrics_a=$(run_benchmark_test "large_task_many_entries" "manifest" "$entry_id" "$file_path")
            IFS='|' read -r chars_a _ _ <<< "$metrics_a"
            total_chars_a=$((total_chars_a + chars_a))

            # Method B: Full file (but skip to save time, just measure one representative)
            if [[ -f "$file_path" ]]; then
                local full_size
                full_size=$(wc -c < "$file_path")
                total_chars_b=$((total_chars_b + full_size))
            fi
        fi
    done

    local total_tokens_a=$(estimate_tokens "$total_chars_a")
    local total_tokens_b=$(estimate_tokens "$total_chars_b")

    log_success "Test 3 complete: Manifest=$total_tokens_a tokens, Full=$total_tokens_b tokens (savings: $((total_tokens_b - total_tokens_a)) tokens)"
}

# Test Case 4: Cross-referencing (following linked_tasks)
test_case_4_cross_reference() {
    log_info "Running Test Case 4: Cross-referencing (following linked_tasks)"

    # Get an entry with linked_tasks
    local entry
    entry=$(jq -r 'select(.linked_tasks != null and (.linked_tasks | length) > 0) | .id' "$MANIFEST_FILE" | head -1)

    if [[ -z "$entry" ]]; then
        log_warn "No entries with linked_tasks found, skipping test 4"
        return
    fi

    local linked_tasks
    linked_tasks=$(jq -r --arg id "$entry" 'select(.id == $id) | .linked_tasks[]' "$MANIFEST_FILE")

    local total_chars_a=0
    local total_chars_b=0

    for linked_id in $linked_tasks; do
        local file_path
        file_path=$(jq -r --arg id "$linked_id" 'select(.id == $id) | .file' "$MANIFEST_FILE")

        if [[ -n "$file_path" && "$file_path" != "null" ]]; then
            file_path="$PROJECT_ROOT/claudedocs/agent-outputs/$file_path"

            # Method A: Manifest
            local metrics_a
            metrics_a=$(run_benchmark_test "cross_reference_linked_tasks" "manifest" "$linked_id" "$file_path")
            IFS='|' read -r chars_a _ _ <<< "$metrics_a"
            total_chars_a=$((total_chars_a + chars_a))

            # Method B: Full file size
            if [[ -f "$file_path" ]]; then
                local full_size
                full_size=$(wc -c < "$file_path")
                total_chars_b=$((total_chars_b + full_size))
            fi
        fi
    done

    local total_tokens_a=$(estimate_tokens "$total_chars_a")
    local total_tokens_b=$(estimate_tokens "$total_chars_b")

    log_success "Test 4 complete: Manifest=$total_tokens_a tokens, Full=$total_tokens_b tokens (savings: $((total_tokens_b - total_tokens_a)) tokens)"
}

# Test Case 5: Historical query (last 7 days of entries)
test_case_5_historical() {
    log_info "Running Test Case 5: Historical query (last 7 days)"

    # Get entries from last 7 days
    local cutoff_date
    cutoff_date=$(date -u -d '7 days ago' +"%Y-%m-%d")

    local entries
    entries=$(jq -r --arg cutoff "$cutoff_date" 'select(.date >= $cutoff) | .id' "$MANIFEST_FILE")

    if [[ -z "$entries" ]]; then
        log_warn "No entries found in last 7 days, using all entries"
        entries=$(jq -r '.id' "$MANIFEST_FILE" | head -10)
    fi

    local total_chars_a=0
    local total_chars_b=0
    local count=0

    for entry_id in $entries; do
        local file_path
        file_path=$(jq -r --arg id "$entry_id" 'select(.id == $id) | .file' "$MANIFEST_FILE")

        if [[ -n "$file_path" && "$file_path" != "null" ]]; then
            file_path="$PROJECT_ROOT/claudedocs/agent-outputs/$file_path"

            # Method A: Manifest
            local metrics_a
            metrics_a=$(run_benchmark_test "historical_7day_query" "manifest" "$entry_id" "$file_path")
            IFS='|' read -r chars_a _ _ <<< "$metrics_a"
            total_chars_a=$((total_chars_a + chars_a))

            # Method B: Full file size
            if [[ -f "$file_path" ]]; then
                local full_size
                full_size=$(wc -c < "$file_path")
                total_chars_b=$((total_chars_b + full_size))
            fi

            count=$((count + 1))
            if [[ $count -ge 10 ]]; then
                break
            fi
        fi
    done

    local total_tokens_a=$(estimate_tokens "$total_chars_a")
    local total_tokens_b=$(estimate_tokens "$total_chars_b")

    log_success "Test 5 complete: Manifest=$total_tokens_a tokens, Full=$total_tokens_b tokens (savings: $((total_tokens_b - total_tokens_a)) tokens)"
}

# Generate summary report
generate_summary() {
    log_info "Generating benchmark summary..."

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Calculate aggregate statistics
    local total_manifest_tokens
    local total_full_tokens
    local total_savings

    total_manifest_tokens=$(jq -s '[.[] | select(.method == "manifest") | .estimated_tokens] | add' "$OUTPUT_FILE")
    total_full_tokens=$(jq -s '[.[] | select(.method == "full_file") | .estimated_tokens] | add' "$OUTPUT_FILE")
    total_savings=$((total_full_tokens - total_manifest_tokens))

    local savings_percentage
    if [[ $total_full_tokens -gt 0 ]]; then
        savings_percentage=$(awk "BEGIN {printf \"%.2f\", ($total_savings / $total_full_tokens) * 100}")
    else
        savings_percentage="0.00"
    fi

    echo ""
    echo "========================================="
    echo "         BENCHMARK SUMMARY"
    echo "========================================="
    echo "Timestamp: $timestamp"
    echo "Total Manifest Tokens: $total_manifest_tokens"
    echo "Total Full File Tokens: $total_full_tokens"
    echo "Total Savings: $total_savings tokens"
    echo "Savings Percentage: ${savings_percentage}%"
    echo "========================================="
    echo ""
    echo "Detailed results written to: $OUTPUT_FILE"
}

# Main execution
main() {
    log_info "Starting CLEO Token Savings Benchmark"
    log_info "Manifest file: $MANIFEST_FILE"
    log_info "Output file: $OUTPUT_FILE"
    echo ""

    # Ensure output directory exists
    ensure_output_directory

    # Run all test cases
    test_case_1_small_task
    echo ""
    test_case_2_medium_task
    echo ""
    test_case_3_large_task
    echo ""
    test_case_4_cross_reference
    echo ""
    test_case_5_historical
    echo ""

    # Generate summary
    generate_summary

    log_success "Benchmark complete!"
}

# Run main if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
