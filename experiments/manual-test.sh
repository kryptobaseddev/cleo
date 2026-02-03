#!/usr/bin/env bash
# experiments/manual-test.sh
# Run this in a FRESH terminal (not inside an existing Claude session)

set -euo pipefail

TASK="Add a --quiet flag to scripts/show.sh that suppresses headers and metadata, showing only raw JSON. Update the help text."

EXPERIMENT_DIR="/tmp/cleo-experiment"
RESULTS_DIR="$EXPERIMENT_DIR/results"

mkdir -p "$RESULTS_DIR"

echo "=============================================="
echo "CLEO A/B EXPERIMENT - Manual Execution"
echo "=============================================="
echo ""
echo "This script runs the same task in 3 different environments"
echo "and measures token usage from Claude API transcripts."
echo ""

run_condition() {
    local name=$1
    local dir=$2

    echo "========================================"
    echo "Running: $name"
    echo "Directory: $dir"
    echo "========================================"

    # Clear old transcripts
    local slug
    slug=$(echo "$dir" | tr '/' '-' | sed 's/^-//')
    rm -rf "$HOME/.claude/projects/$slug" 2>/dev/null || true

    cd "$dir"

    local start_time
    start_time=$(date +%s)

    # Run Claude with the task
    echo "$TASK" | claude --print 2>&1 | tee "$RESULTS_DIR/${name}_output.txt"

    local end_time
    end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Find and extract metrics from transcript
    local transcript_dir="$HOME/.claude/projects/$slug"
    if [[ -d "$transcript_dir" ]]; then
        local latest
        latest=$(ls -t "$transcript_dir"/*.jsonl 2>/dev/null | head -1)
        if [[ -n "$latest" ]]; then
            jq -s '
              [.[] | select(.type == "assistant") | .message.usage // {}] |
              {
                condition: "'"$name"'",
                input_tokens: (map(.input_tokens // 0) | add),
                output_tokens: (map(.output_tokens // 0) | add),
                cache_read_tokens: (map(.cache_read_input_tokens // 0) | add),
                api_calls: length,
                duration_seconds: '"$duration"'
              }
            ' "$latest" > "$RESULTS_DIR/${name}_metrics.json"
            echo "Metrics saved to: $RESULTS_DIR/${name}_metrics.json"
        fi
    fi

    echo ""
    echo "Completed: $name ($duration seconds)"
    echo ""
    sleep 2
}

# Run each condition
run_condition "cleo" "$EXPERIMENT_DIR/cleo/repo"
run_condition "baseline" "$EXPERIMENT_DIR/baseline/repo"
run_condition "simple_todo" "$EXPERIMENT_DIR/simple-todo/repo"

# Summary
echo "=============================================="
echo "RESULTS SUMMARY"
echo "=============================================="
echo ""

for f in "$RESULTS_DIR"/*_metrics.json; do
    [[ -f "$f" ]] || continue
    name=$(basename "$f" _metrics.json)
    echo "=== $name ==="
    cat "$f" | jq '.'
    echo ""
done

# Calculate comparison
echo "=== COMPARISON ==="
cleo_input=$(jq -r '.input_tokens' "$RESULTS_DIR/cleo_metrics.json" 2>/dev/null || echo 0)
baseline_input=$(jq -r '.input_tokens' "$RESULTS_DIR/baseline_metrics.json" 2>/dev/null || echo 0)

if [[ "$baseline_input" -gt 0 && "$cleo_input" -gt 0 ]]; then
    diff=$((cleo_input - baseline_input))
    if [[ "$diff" -gt 0 ]]; then
        echo "CLEO used $diff MORE input tokens than baseline"
        pct=$(awk "BEGIN {printf \"%.1f\", ($diff / $baseline_input) * 100}")
        echo "Overhead: ${pct}%"
    else
        echo "CLEO used $((diff * -1)) FEWER input tokens than baseline"
        pct=$(awk "BEGIN {printf \"%.1f\", (${diff#-} / $baseline_input) * 100}")
        echo "Savings: ${pct}%"
    fi
fi

echo ""
echo "Full results in: $RESULTS_DIR"
