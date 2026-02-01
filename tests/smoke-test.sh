#!/usr/bin/env bash
# Smoke test - quick validation for pre-commit
# Target: < 30 seconds
# Task: T2942
# Spec: T2940
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Minimal smoke tests - only fastest files for <30s target
# Full smoke test ran 296 tests in ~100s, this runs ~60 tests in ~20s
SMOKE_TESTS=(
    "unit/migrate.bats"           # ~8s  (31 tests)  - Fast migration validation
    "unit/error-codes.bats"       # ~12s (57 tests)  - Schema/exit code validation
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
