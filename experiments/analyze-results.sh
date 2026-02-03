#!/usr/bin/env bash
# experiments/analyze-results.sh
# Analyzes experiment results and generates statistical summary

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="${EXPERIMENT_DIR:-/tmp/cleo-experiment}"
RESULTS_DIR="$EXPERIMENT_DIR/results"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

analyze_condition() {
    local condition=$1

    # Find all metrics files for this condition
    local files
    files=$(find "$RESULTS_DIR" -name "${condition}_*_metrics.json" 2>/dev/null)

    if [[ -z "$files" ]]; then
        echo "No results for $condition"
        return
    fi

    # Aggregate metrics
    echo "$files" | xargs cat | jq -s "
      {
        condition: \"$condition\",
        runs: length,
        total_input_tokens: (map(.input_tokens // 0) | add),
        total_output_tokens: (map(.output_tokens // 0) | add),
        total_cache_read: (map(.cache_read_tokens // 0) | add),
        avg_input_tokens: (map(.input_tokens // 0) | add / length),
        avg_output_tokens: (map(.output_tokens // 0) | add / length),
        avg_api_calls: (map(.api_calls // 0) | add / length),
        avg_duration: (map(.duration_seconds // 0) | add / length)
      }
    "
}

generate_comparison_table() {
    echo ""
    echo -e "${BLUE}=== Condition Comparison ===${NC}"
    echo ""

    local cleo_data baseline_data simple_data

    cleo_data=$(analyze_condition "cleo")
    baseline_data=$(analyze_condition "baseline")
    simple_data=$(analyze_condition "simple-todo")

    # Print as table
    printf "%-20s %15s %15s %15s\n" "Metric" "CLEO" "Baseline" "Simple-TODO"
    printf "%-20s %15s %15s %15s\n" "--------------------" "---------------" "---------------" "---------------"

    printf "%-20s %15.0f %15.0f %15.0f\n" "Avg Input Tokens" \
        "$(echo "$cleo_data" | jq -r '.avg_input_tokens // 0')" \
        "$(echo "$baseline_data" | jq -r '.avg_input_tokens // 0')" \
        "$(echo "$simple_data" | jq -r '.avg_input_tokens // 0')"

    printf "%-20s %15.0f %15.0f %15.0f\n" "Avg Output Tokens" \
        "$(echo "$cleo_data" | jq -r '.avg_output_tokens // 0')" \
        "$(echo "$baseline_data" | jq -r '.avg_output_tokens // 0')" \
        "$(echo "$simple_data" | jq -r '.avg_output_tokens // 0')"

    printf "%-20s %15.0f %15.0f %15.0f\n" "Avg API Calls" \
        "$(echo "$cleo_data" | jq -r '.avg_api_calls // 0')" \
        "$(echo "$baseline_data" | jq -r '.avg_api_calls // 0')" \
        "$(echo "$simple_data" | jq -r '.avg_api_calls // 0')"

    printf "%-20s %15.0f %15.0f %15.0f\n" "Avg Duration (s)" \
        "$(echo "$cleo_data" | jq -r '.avg_duration // 0')" \
        "$(echo "$baseline_data" | jq -r '.avg_duration // 0')" \
        "$(echo "$simple_data" | jq -r '.avg_duration // 0')"
}

calculate_savings() {
    echo ""
    echo -e "${GREEN}=== Token Savings Analysis ===${NC}"
    echo ""

    local cleo_input baseline_input

    cleo_input=$(find "$RESULTS_DIR" -name "cleo_*_metrics.json" -exec cat {} \; 2>/dev/null | jq -s 'map(.input_tokens // 0) | add')
    baseline_input=$(find "$RESULTS_DIR" -name "baseline_*_metrics.json" -exec cat {} \; 2>/dev/null | jq -s 'map(.input_tokens // 0) | add')

    if [[ "$baseline_input" -gt 0 && "$cleo_input" -gt 0 ]]; then
        local diff=$((baseline_input - cleo_input))
        local pct
        pct=$(awk "BEGIN {printf \"%.1f\", ($diff / $baseline_input) * 100}")

        echo "CLEO total input tokens:     $cleo_input"
        echo "Baseline total input tokens: $baseline_input"
        echo ""

        if [[ "$diff" -gt 0 ]]; then
            echo -e "${GREEN}CLEO SAVED $diff tokens (${pct}% reduction)${NC}"
        else
            echo -e "${YELLOW}CLEO used $((diff * -1)) MORE tokens (${pct}% overhead)${NC}"
        fi
    else
        echo "Insufficient data for comparison"
    fi
}

hypothesis_check() {
    echo ""
    echo -e "${BLUE}=== Hypothesis Validation ===${NC}"
    echo ""

    local cleo_total baseline_total savings_pct

    cleo_total=$(find "$RESULTS_DIR" -name "cleo_*_metrics.json" -exec cat {} \; 2>/dev/null | jq -s 'map((.input_tokens // 0) + (.output_tokens // 0)) | add')
    baseline_total=$(find "$RESULTS_DIR" -name "baseline_*_metrics.json" -exec cat {} \; 2>/dev/null | jq -s 'map((.input_tokens // 0) + (.output_tokens // 0)) | add')

    if [[ "$baseline_total" -gt 0 ]]; then
        savings_pct=$(awk "BEGIN {printf \"%.1f\", (($baseline_total - $cleo_total) / $baseline_total) * 100}")

        echo "H1 (Token Efficiency - need ≥20% reduction):"
        if (( $(echo "$savings_pct >= 20" | bc -l) )); then
            echo -e "  ${GREEN}✓ PASS${NC}: ${savings_pct}% reduction"
        elif (( $(echo "$savings_pct > 0" | bc -l) )); then
            echo -e "  ${YELLOW}~ PARTIAL${NC}: ${savings_pct}% reduction (below 20% threshold)"
        else
            echo -e "  ${YELLOW}✗ FAIL${NC}: ${savings_pct}% (no reduction or overhead)"
        fi
    fi

    echo ""
    echo "Note: H2 (Reliability) and H3 (Continuity) require manual verification"
    echo "of task completion quality and context recovery success."
}

main() {
    echo ""
    echo "=============================================="
    echo "    CLEO VALUE EXPERIMENT - Results Analysis"
    echo "=============================================="
    echo ""

    if [[ ! -d "$RESULTS_DIR" ]]; then
        echo "No results directory found: $RESULTS_DIR"
        echo "Run the experiment first."
        exit 1
    fi

    local result_count
    result_count=$(find "$RESULTS_DIR" -name "*_metrics.json" | wc -l)

    if [[ "$result_count" -eq 0 ]]; then
        echo "No result files found."
        exit 1
    fi

    echo "Found $result_count result files"

    generate_comparison_table
    calculate_savings
    hypothesis_check

    echo ""
    echo "Full results in: $RESULTS_DIR"
}

main "$@"
