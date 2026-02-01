#!/usr/bin/env bash
# Smoke test - quick validation for pre-commit
# Target: < 30 seconds
# Task: T2942
# Spec: T2940
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Fast, critical tests only (8 files, ~30s per T2940 spec)
# Priority: Core CLI operations + schema validation + fast helpers
SMOKE_TESTS=(
    "unit/jq-helpers.bats"       # 0.8s  (20 tests)  - Fast utility functions
    "unit/migrate.bats"           # 2.6s  (16 tests)  - Fast migration validation
    "unit/error-codes.bats"       # 3.4s  (18 tests)  - Schema validation
    "unit/add-task.bats"          # 4.2s  (37 tests)  - Core CLI: task creation
    "unit/complete-task.bats"     # 5.1s  (28 tests)  - Core CLI: task completion
)

echo "Running smoke tests (target: <30s)..."
start_time=$(date +%s)

for test in "${SMOKE_TESTS[@]}"; do
    test_file="$SCRIPT_DIR/$test"
    if [[ ! -f "$test_file" ]]; then
        echo "ERROR: Test file not found: $test"
        exit 1
    fi

    echo "  → $(basename "$test")"
    if ! bats "$test_file" --jobs 1 >/dev/null 2>&1; then
        echo "ERROR: Test failed: $test"
        bats "$test_file" --jobs 1  # Re-run with output for debugging
        exit 1
    fi
done

end_time=$(date +%s)
duration=$((end_time - start_time))

echo ""
echo "✓ Smoke tests passed in ${duration}s"

if [[ $duration -gt 30 ]]; then
    echo "WARNING: Smoke tests took ${duration}s (target: <30s)"
fi

exit 0
