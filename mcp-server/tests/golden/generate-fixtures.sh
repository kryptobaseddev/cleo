#!/usr/bin/env bash
# @task T4370
# Golden test fixture generator
#
# Runs CLI commands against a temporary CLEO project and captures
# stdout JSON output. Stores results in fixtures/ for parity comparison
# with native engine output.
#
# Usage: ./generate-fixtures.sh [--output-dir DIR]
#
# Requires: cleo CLI installed and available in PATH

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-${SCRIPT_DIR}/fixtures}"
TMPDIR_BASE="${TMPDIR:-/tmp}"
WORK_DIR=""

cleanup() {
    if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
        rm -rf "${WORK_DIR}"
    fi
}
trap cleanup EXIT

# Verify cleo CLI is available
if ! command -v cleo &>/dev/null; then
    echo "ERROR: cleo CLI not found in PATH" >&2
    exit 1
fi

echo "=== Golden Fixture Generator ==="
echo "Output directory: ${OUTPUT_DIR}"

# Create temp project
WORK_DIR=$(mktemp -d "${TMPDIR_BASE}/cleo-golden-XXXXXX")
echo "Working directory: ${WORK_DIR}"

cd "${WORK_DIR}"

# Initialize project
echo "[1/8] Initializing CLEO project..."
cleo init "golden-test" --json > /dev/null 2>&1

# Disable session enforcement for clean fixture generation
cleo config set session.enforcement none --json > /dev/null 2>&1
cleo config set session.requireSession false --json > /dev/null 2>&1
cleo config set session.requireSessionNote false --json > /dev/null 2>&1

# Capture: system version
echo "[2/8] Capturing system version..."
cleo version --json > "${OUTPUT_DIR}/system-version.json" 2>/dev/null || true

# Capture: validate schema
echo "[3/8] Capturing schema validation..."
cleo validate --json > "${OUTPUT_DIR}/validate-schema.json" 2>/dev/null || true

# Create test data: epic + children + dependencies
echo "[4/8] Creating test data..."
EPIC_RESULT=$(cleo add "Golden epic" --description "Epic for golden parity testing" --json 2>/dev/null)
EPIC_ID=$(echo "${EPIC_RESULT}" | jq -r '.task.id')

CHILD1_RESULT=$(cleo add "Golden child task 1" \
    --description "First child task for golden testing" \
    --parent "${EPIC_ID}" --json 2>/dev/null)
CHILD1_ID=$(echo "${CHILD1_RESULT}" | jq -r '.task.id')

CHILD2_RESULT=$(cleo add "Golden child task 2" \
    --description "Second child task for golden testing" \
    --parent "${EPIC_ID}" \
    --depends "${CHILD1_ID}" --json 2>/dev/null)

# Capture: task add (create a fresh task for clean fixture)
echo "[5/8] Capturing task add..."
cleo add "Golden test task" \
    --description "Task created for golden parity testing" \
    --json > "${OUTPUT_DIR}/task-add.json" 2>/dev/null || true

# Capture: task list
echo "[6/8] Capturing task list..."
cleo list --limit 5 --json > "${OUTPUT_DIR}/task-list.json" 2>/dev/null || true

# Capture: task show
echo "[7/8] Capturing task show..."
cleo show "${EPIC_ID}" --json > "${OUTPUT_DIR}/task-show.json" 2>/dev/null || true

# Capture: task find
echo "[8/8] Capturing task find..."
cleo find "Golden epic" --json > "${OUTPUT_DIR}/task-find.json" 2>/dev/null || true

echo ""
echo "=== Fixtures Generated ==="
echo "Files:"
ls -la "${OUTPUT_DIR}"/*.json 2>/dev/null | awk '{print "  " $NF}'
echo ""
echo "NOTE: Dynamic fields (__DYNAMIC__) in reference fixtures"
echo "      are replaced with actual values during generation."
echo "      Use compare.ts to diff native vs CLI output."
