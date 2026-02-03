#!/usr/bin/env bash
# experiments/run-quick-validation.sh
# Quick A/B validation: runs ONE task across all conditions
# Provides initial data in ~15 minutes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXPERIMENT_DIR="${EXPERIMENT_DIR:-/tmp/cleo-experiment}"
RESULTS_DIR="$EXPERIMENT_DIR/results"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# The task we'll use for quick validation
# Chosen because it requires: reading files, making changes, understanding context
VALIDATION_TASK="Add a --quiet flag to the 'cleo show' command in scripts/show.sh that suppresses the header and metadata, showing only the task JSON. Update the help text to document this flag."

extract_metrics() {
    local condition=$1
    local transcript_dir="$HOME/.claude/projects/-tmp-cleo-experiment-${condition}-repo"

    if [[ ! -d "$transcript_dir" ]]; then
        log_warn "No transcript found for $condition"
        echo '{"error": "no transcript"}'
        return
    fi

    local latest
    latest=$(ls -t "$transcript_dir"/*.jsonl 2>/dev/null | head -1)

    if [[ -z "$latest" ]]; then
        log_warn "No JSONL files in $transcript_dir"
        echo '{"error": "no jsonl files"}'
        return
    fi

    # Extract metrics from transcript
    jq -s '
      [.[] | select(.type == "assistant") | .message.usage // {}] |
      {
        input_tokens: (map(.input_tokens // 0) | add),
        output_tokens: (map(.output_tokens // 0) | add),
        cache_read_tokens: (map(.cache_read_input_tokens // 0) | add),
        cache_creation_tokens: (map(.cache_creation_input_tokens // 0) | add),
        api_calls: length,
        total_tokens: ((map(.input_tokens // 0) | add) + (map(.output_tokens // 0) | add))
      }
    ' "$latest"
}

run_condition() {
    local condition=$1
    local repo_dir="$EXPERIMENT_DIR/$condition/repo"

    if [[ ! -d "$repo_dir" ]]; then
        log_error "Environment not set up: $repo_dir"
        log_error "Run: ./experiments/setup-experiment.sh first"
        return 1
    fi

    log_info "Running $condition condition..."

    # Clear any previous transcripts for this condition
    local transcript_pattern="$HOME/.claude/projects/-tmp-cleo-experiment-${condition}-repo"
    rm -rf "$transcript_pattern" 2>/dev/null || true

    # Record start time
    local start_time
    start_time=$(date +%s)

    # Run Claude with the task
    cd "$repo_dir"

    # Use --print for non-interactive mode
    echo "$VALIDATION_TASK" | timeout 300 claude --print > "$RESULTS_DIR/${condition}_validation_output.txt" 2>&1 || {
        log_warn "$condition run timed out or failed"
    }

    local end_time
    end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Extract metrics
    local metrics
    metrics=$(extract_metrics "$condition")

    # Add timing and save
    echo "$metrics" | jq --arg dur "$duration" --arg cond "$condition" \
        '. + {duration_seconds: ($dur | tonumber), condition: $cond}' \
        > "$RESULTS_DIR/${condition}_validation_metrics.json"

    log_success "$condition complete (${duration}s)"
}

generate_comparison() {
    log_info "Generating comparison report..."

    local cleo_metrics baseline_metrics simple_metrics

    cleo_metrics=$(cat "$RESULTS_DIR/cleo_validation_metrics.json" 2>/dev/null || echo '{}')
    baseline_metrics=$(cat "$RESULTS_DIR/baseline_validation_metrics.json" 2>/dev/null || echo '{}')
    simple_metrics=$(cat "$RESULTS_DIR/simple-todo_validation_metrics.json" 2>/dev/null || echo '{}')

    # Generate comparison
    cat > "$RESULTS_DIR/quick_validation_summary.md" << EOF
# Quick Validation Results

**Task**: $VALIDATION_TASK

**Date**: $(date -Iseconds)

## Token Usage Comparison

| Metric | CLEO | Baseline | Simple-TODO |
|--------|------|----------|-------------|
| Input Tokens | $(echo "$cleo_metrics" | jq -r '.input_tokens // "N/A"') | $(echo "$baseline_metrics" | jq -r '.input_tokens // "N/A"') | $(echo "$simple_metrics" | jq -r '.input_tokens // "N/A"') |
| Output Tokens | $(echo "$cleo_metrics" | jq -r '.output_tokens // "N/A"') | $(echo "$baseline_metrics" | jq -r '.output_tokens // "N/A"') | $(echo "$simple_metrics" | jq -r '.output_tokens // "N/A"') |
| Cache Read | $(echo "$cleo_metrics" | jq -r '.cache_read_tokens // "N/A"') | $(echo "$baseline_metrics" | jq -r '.cache_read_tokens // "N/A"') | $(echo "$simple_metrics" | jq -r '.cache_read_tokens // "N/A"') |
| **Total** | $(echo "$cleo_metrics" | jq -r '.total_tokens // "N/A"') | $(echo "$baseline_metrics" | jq -r '.total_tokens // "N/A"') | $(echo "$simple_metrics" | jq -r '.total_tokens // "N/A"') |
| API Calls | $(echo "$cleo_metrics" | jq -r '.api_calls // "N/A"') | $(echo "$baseline_metrics" | jq -r '.api_calls // "N/A"') | $(echo "$simple_metrics" | jq -r '.api_calls // "N/A"') |
| Duration (s) | $(echo "$cleo_metrics" | jq -r '.duration_seconds // "N/A"') | $(echo "$baseline_metrics" | jq -r '.duration_seconds // "N/A"') | $(echo "$simple_metrics" | jq -r '.duration_seconds // "N/A"') |

## Analysis

EOF

    # Calculate savings/overhead
    local cleo_total baseline_total
    cleo_total=$(echo "$cleo_metrics" | jq -r '.total_tokens // 0')
    baseline_total=$(echo "$baseline_metrics" | jq -r '.total_tokens // 0')

    if [[ "$baseline_total" -gt 0 && "$cleo_total" -gt 0 ]]; then
        local diff=$((baseline_total - cleo_total))
        local pct
        pct=$(awk "BEGIN {printf \"%.1f\", ($diff / $baseline_total) * 100}")

        if [[ "$diff" -gt 0 ]]; then
            echo "**CLEO saved $diff tokens (${pct}% reduction vs baseline)**" >> "$RESULTS_DIR/quick_validation_summary.md"
        else
            echo "**CLEO used $((diff * -1)) MORE tokens (${pct}% overhead vs baseline)**" >> "$RESULTS_DIR/quick_validation_summary.md"
        fi
    fi

    cat >> "$RESULTS_DIR/quick_validation_summary.md" << 'EOF'

## Raw Data

See individual JSON files in this directory for complete metrics.

## Next Steps

If results are promising, run the full experiment:
```bash
./experiments/run-full-experiment.sh
```
EOF

    log_success "Summary written to: $RESULTS_DIR/quick_validation_summary.md"
}

main() {
    echo ""
    echo "=============================================="
    echo "    CLEO VALUE EXPERIMENT - Quick Validation"
    echo "=============================================="
    echo ""

    # Check setup
    if [[ ! -d "$EXPERIMENT_DIR" ]]; then
        log_error "Experiment not set up. Run first:"
        echo "  ./experiments/setup-experiment.sh"
        exit 1
    fi

    mkdir -p "$RESULTS_DIR"

    echo "Task: $VALIDATION_TASK"
    echo ""
    echo "This will run the same task in 3 conditions:"
    echo "  1. CLEO (full task management)"
    echo "  2. Baseline (no task system)"
    echo "  3. Simple-TODO (markdown only)"
    echo ""
    read -p "Press Enter to start (Ctrl+C to cancel)..."
    echo ""

    # Run each condition
    run_condition "cleo"
    echo ""
    run_condition "baseline"
    echo ""
    run_condition "simple-todo"
    echo ""

    # Generate comparison
    generate_comparison

    echo ""
    echo "=============================================="
    echo "    RESULTS"
    echo "=============================================="
    echo ""
    cat "$RESULTS_DIR/quick_validation_summary.md"
}

main "$@"
