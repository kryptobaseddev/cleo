#!/usr/bin/env bash
# Verification script for import-logging.sh library
# Tests all logging functions with realistic data

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/../lib"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

TESTS_PASSED=0
TESTS_FAILED=0

log_test() {
    echo -e "${BLUE}[TEST]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
}

# Create temporary test environment
TEST_DIR=$(mktemp -d)
export CLEO_DIR="$TEST_DIR/.cleo"
mkdir -p "$CLEO_DIR"

export LOG_FILE="$CLEO_DIR/todo-log.json"

# Initialize log file
cat > "$LOG_FILE" <<EOF
{
  "version": "0.48.0",
  "project": "test-project",
  "_meta": {
    "totalEntries": 0,
    "firstEntry": null,
    "lastEntry": null,
    "entriesPruned": 0
  },
  "entries": []
}
EOF

# Create test export package
EXPORT_FILE="$TEST_DIR/test-package.cleo-export.json"
cat > "$EXPORT_FILE" <<EOF
{
  "_meta": {
    "format": "cleo-export",
    "version": "1.0.0",
    "exportedAt": "2026-01-03T14:30:00Z",
    "source": {
      "project": "source-project",
      "cleo_version": "0.48.0",
      "nextId": 10
    },
    "checksum": "abc123def456",
    "taskCount": 3
  },
  "tasks": [
    {"id": "T001", "title": "Task 1"},
    {"id": "T002", "title": "Task 2"},
    {"id": "T003", "title": "Task 3"}
  ]
}
EOF

# Source the library
source "$LIB_DIR/data/import-logging.sh"

echo ""
echo "========================================"
echo "  Import Logging Verification Tests"
echo "========================================"
echo ""

# Test 1: log_import_start
log_test "log_import_start creates entry with package metadata"
if log_import_start "$EXPORT_FILE" "session_123"; then
    ENTRY_COUNT=$(jq '.entries | length' "$LOG_FILE")
    if [[ "$ENTRY_COUNT" -eq 1 ]]; then
        SOURCE_FILE=$(jq -r '.entries[0].details.sourceFile' "$LOG_FILE")
        if [[ "$SOURCE_FILE" == "test-package.cleo-export.json" ]]; then
            log_pass "Import start logged correctly"
        else
            log_fail "Source file incorrect: $SOURCE_FILE"
        fi
    else
        log_fail "Entry count incorrect: $ENTRY_COUNT"
    fi
else
    log_fail "log_import_start failed"
fi

# Test 2: Verify package metadata
log_test "Package metadata preserved in log entry"
SOURCE_PROJECT=$(jq -r '.entries[0].details.sourceProject' "$LOG_FILE")
CHECKSUM=$(jq -r '.entries[0].details.packageChecksum' "$LOG_FILE")
TASK_COUNT=$(jq -r '.entries[0].details.taskCount' "$LOG_FILE")
STAGE=$(jq -r '.entries[0].details.stage' "$LOG_FILE")

if [[ "$SOURCE_PROJECT" == "source-project" && "$CHECKSUM" == "abc123def456" && "$TASK_COUNT" -eq 3 && "$STAGE" == "start" ]]; then
    log_pass "Package metadata complete: project=$SOURCE_PROJECT, checksum=$CHECKSUM, tasks=$TASK_COUNT, stage=$STAGE"
else
    log_fail "Package metadata incomplete or incorrect"
fi

# Test 3: log_import_success
log_test "log_import_success creates complete provenance entry"

# Reset log for clean test
jq '.entries = []' "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"

TASKS_IMPORTED="T031,T032,T033"
ID_REMAP='{"T001":"T031","T002":"T032","T003":"T033"}'
CONFLICTS='[]'
OPTIONS='{"parent":"T015","phase":"core","resetStatus":"pending"}'

if log_import_success "$EXPORT_FILE" "$TASKS_IMPORTED" "$ID_REMAP" "$CONFLICTS" "$OPTIONS" "session_123"; then
    IMPORTED_TASKS=$(jq -r '.entries[0].details.tasksImported | join(",")' "$LOG_FILE")
    REMAP_T001=$(jq -r '.entries[0].details.idRemap.T001' "$LOG_FILE")
    PARENT_OPT=$(jq -r '.entries[0].details.options.parent' "$LOG_FILE")

    if [[ "$IMPORTED_TASKS" == "T031,T032,T033" && "$REMAP_T001" == "T031" && "$PARENT_OPT" == "T015" ]]; then
        log_pass "Import success logged with full provenance"
    else
        log_fail "Success entry incomplete: tasks=$IMPORTED_TASKS, remap=$REMAP_T001, parent=$PARENT_OPT"
    fi
else
    log_fail "log_import_success failed"
fi

# Test 4: log_import_error
log_test "log_import_error creates error entry with diagnostic details"

jq '.entries = []' "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"

if log_import_error "$EXPORT_FILE" "Schema validation failed" "E_VALIDATION_ERROR" "validation" "session_123"; then
    ERROR_MSG=$(jq -r '.entries[0].details.error.message' "$LOG_FILE")
    ERROR_CODE=$(jq -r '.entries[0].details.error.code' "$LOG_FILE")
    STAGE=$(jq -r '.entries[0].details.stage' "$LOG_FILE")
    ACTION=$(jq -r '.entries[0].action' "$LOG_FILE")

    if [[ "$ERROR_MSG" == "Schema validation failed" && "$ERROR_CODE" == "E_VALIDATION_ERROR" && "$STAGE" == "validation" && "$ACTION" == "error_occurred" ]]; then
        log_pass "Import error logged with diagnostic details"
    else
        log_fail "Error entry incomplete: msg=$ERROR_MSG, code=$ERROR_CODE, stage=$STAGE, action=$ACTION"
    fi
else
    log_fail "log_import_error failed"
fi

# Test 5: log_import_conflict
log_test "log_import_conflict creates conflict entry with resolution"

jq '.entries = []' "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"

CONFLICT_DETAILS='{"title":"Setup OAuth2","existingTaskId":"T020","renamedTo":"Setup OAuth2 (imported)"}'

if log_import_conflict "duplicate_title" "T001" "$CONFLICT_DETAILS" "rename" "session_123"; then
    CONFLICT_TYPE=$(jq -r '.entries[0].details.conflictType' "$LOG_FILE")
    RESOLUTION=$(jq -r '.entries[0].details.resolution' "$LOG_FILE")
    TITLE=$(jq -r '.entries[0].details.details.title' "$LOG_FILE")
    TASK_ID=$(jq -r '.entries[0].taskId' "$LOG_FILE")

    if [[ "$CONFLICT_TYPE" == "duplicate_title" && "$RESOLUTION" == "rename" && "$TITLE" == "Setup OAuth2" && "$TASK_ID" == "T001" ]]; then
        log_pass "Import conflict logged with resolution details"
    else
        log_fail "Conflict entry incomplete: type=$CONFLICT_TYPE, resolution=$RESOLUTION, title=$TITLE, taskId=$TASK_ID"
    fi
else
    log_fail "log_import_conflict failed"
fi

# Test 6: Timestamp validation
log_test "All log entries include ISO 8601 timestamps"

jq '.entries = []' "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"

log_import_start "$EXPORT_FILE" "null"
log_import_success "$EXPORT_FILE" "T031" '{"T001":"T031"}' '[]' '{}' "null"
log_import_error "$EXPORT_FILE" "Test error" "E_TEST" "testing" "null"

ENTRIES_WITH_TS=$(jq '[.entries[] | select(.timestamp != null)] | length' "$LOG_FILE")
if [[ "$ENTRIES_WITH_TS" -eq 3 ]]; then
    TIMESTAMP=$(jq -r '.entries[0].timestamp' "$LOG_FILE")
    if [[ "$TIMESTAMP" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
        log_pass "All entries have ISO 8601 timestamps: $TIMESTAMP"
    else
        log_fail "Invalid timestamp format: $TIMESTAMP"
    fi
else
    log_fail "Not all entries have timestamps: $ENTRIES_WITH_TS/3"
fi

# Test 7: Invalid JSON handling
log_test "Graceful handling of invalid JSON inputs"

jq '.entries = []' "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"

# Test with invalid id_remap (should fallback to {})
if log_import_success "$EXPORT_FILE" "T031" "invalid-json-here" "[]" "{}" "null"; then
    REMAP=$(jq '.entries[0].details.idRemap' "$LOG_FILE")
    if [[ "$REMAP" == "{}" ]]; then
        log_pass "Invalid JSON handled gracefully (fallback to empty object)"
    else
        log_fail "Fallback failed: $REMAP"
    fi
else
    log_fail "Function failed on invalid JSON (should succeed with fallback)"
fi

# Test 8: Session ID handling
log_test "Session ID preserved in log entries"

jq '.entries = []' "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"

log_import_start "$EXPORT_FILE" "session_abc123"

SESSION_ID=$(jq -r '.entries[0].sessionId' "$LOG_FILE")
if [[ "$SESSION_ID" == "session_abc123" ]]; then
    log_pass "Session ID preserved: $SESSION_ID"
else
    log_fail "Session ID incorrect: $SESSION_ID"
fi

# Test 9: Missing file handling
log_test "Missing source file handled gracefully"

if log_import_start "/nonexistent/file.json" "null" 2>/dev/null; then
    log_fail "Should have failed on missing file"
else
    log_pass "Missing file error handled correctly"
fi

# Cleanup
rm -rf "$TEST_DIR"

# Summary
echo ""
echo "========================================"
echo "  Test Summary"
echo "========================================"
echo -e "${GREEN}Passed:${NC} $TESTS_PASSED"
echo -e "${RED}Failed:${NC} $TESTS_FAILED"
echo ""

if [[ "$TESTS_FAILED" -eq 0 ]]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
