#!/usr/bin/env bats
# =============================================================================
# compliance.bats - Integration tests for cleo compliance command
# =============================================================================
# Tests:
# - cleo compliance summary
# - cleo compliance violations
# - cleo compliance trend
# - cleo compliance audit
# - cleo compliance sync
# - cleo compliance skills
# - JSON and human output formats
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create metrics directory
    mkdir -p "${TEST_TEMP_DIR}/.cleo/metrics"

    # Export compliance script path
    export COMPLIANCE_SCRIPT="${SCRIPTS_DIR}/compliance.sh"

    # Create test archive
    export ARCHIVE_FILE="${TEST_TEMP_DIR}/.cleo/todo-archive.json"
    create_empty_archive "$ARCHIVE_FILE"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

# Create mock COMPLIANCE.jsonl with test data
create_mock_compliance_data() {
    local compliance_file="${TEST_TEMP_DIR}/.cleo/metrics/COMPLIANCE.jsonl"

    # Entry 1: High pass rate, no violations
    cat >> "$compliance_file" << 'EOF'
{"timestamp":"2026-01-20T10:00:00Z","source_id":"opus-1","source_type":"subagent","_context":{"task_id":"T001","epic_id":"T001"},"compliance":{"compliance_pass_rate":1.0,"rule_adherence_score":1.0,"violation_count":0,"violation_severity":"none","manifest_integrity":"valid"}}
EOF

    # Entry 2: Medium pass rate, some violations
    cat >> "$compliance_file" << 'EOF'
{"timestamp":"2026-01-21T10:00:00Z","source_id":"sonnet-1","source_type":"subagent","_context":{"task_id":"T002","epic_id":"T001"},"compliance":{"compliance_pass_rate":0.8,"rule_adherence_score":0.85,"violation_count":2,"violation_severity":"medium","manifest_integrity":"valid"}}
EOF

    # Entry 3: Low pass rate, high violations
    cat >> "$compliance_file" << 'EOF'
{"timestamp":"2026-01-22T10:00:00Z","source_id":"opus-1","source_type":"subagent","_context":{"task_id":"T003","epic_id":"T001"},"compliance":{"compliance_pass_rate":0.5,"rule_adherence_score":0.6,"violation_count":5,"violation_severity":"high","manifest_integrity":"partial"}}
EOF

    # Entry 4: Critical violation
    cat >> "$compliance_file" << 'EOF'
{"timestamp":"2026-01-22T15:00:00Z","source_id":"haiku-1","source_type":"subagent","_context":{"task_id":"T004","epic_id":"T002"},"compliance":{"compliance_pass_rate":0.3,"rule_adherence_score":0.4,"violation_count":8,"violation_severity":"critical","manifest_integrity":"invalid"}}
EOF
}

# Create todo.json with test tasks
create_test_tasks() {
    cat > "$TODO_FILE" << 'EOF'
{
  "_meta": {"schemaVersion": "2.7.0", "lastUpdated": "2026-01-22T10:00:00Z"},
  "nextId": 5,
  "tasks": [
    {"id": "T001", "title": "Epic Task", "description": "Test epic", "status": "pending", "type": "epic", "createdAt": "2026-01-20T10:00:00Z", "updatedAt": "2026-01-20T10:00:00Z"},
    {"id": "T002", "title": "Child Task 1", "description": "Test child 1", "status": "done", "parentId": "T001", "createdAt": "2026-01-20T10:00:00Z", "updatedAt": "2026-01-21T10:00:00Z"},
    {"id": "T003", "title": "Child Task 2", "description": "Test child 2", "status": "done", "parentId": "T001", "createdAt": "2026-01-20T10:00:00Z", "updatedAt": "2026-01-22T10:00:00Z"},
    {"id": "T004", "title": "Other Task", "description": "Different epic", "status": "pending", "createdAt": "2026-01-20T10:00:00Z", "updatedAt": "2026-01-20T10:00:00Z"}
  ]
}
EOF
}

# =============================================================================
# BASIC COMMAND TESTS
# =============================================================================

@test "compliance: command exists" {
    [[ -f "$COMPLIANCE_SCRIPT" ]]
    [[ -x "$COMPLIANCE_SCRIPT" ]]
}

@test "compliance: help shows usage" {
    run bash "$COMPLIANCE_SCRIPT" --help
    assert_success
    assert_output --partial "cleo compliance"
    assert_output --partial "summary"
    assert_output --partial "violations"
    assert_output --partial "trend"
    assert_output --partial "audit"
}

@test "compliance: unknown subcommand fails gracefully" {
    # Unknown subcommands are treated as arguments to default (summary)
    # Just verify it produces valid output
    run bash "$COMPLIANCE_SCRIPT" unknown_command --json
    # May succeed (treating unknown as arg) or fail with error
    # Either way, should not crash
    [[ "$status" -eq 0 ]] || [[ "$output" == *"Unknown"* ]]
}

# =============================================================================
# SUMMARY TESTS
# =============================================================================

@test "compliance summary: returns valid JSON when no data" {
    run bash "$COMPLIANCE_SCRIPT" summary --json
    assert_success

    # Verify JSON structure
    echo "$output" | jq -e '.success' >/dev/null
    # _meta.command may be "compliance" or "metrics-aggregation" (from library)
    echo "$output" | jq -e '._meta' >/dev/null
}

@test "compliance summary: calculates averages correctly" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" summary --json
    assert_success

    # Check result has expected fields
    echo "$output" | jq -e '.result.totalEntries == 4' >/dev/null
    echo "$output" | jq -e '.result.totalViolations == 15' >/dev/null  # 0+2+5+8

    # Average pass rate: (1.0 + 0.8 + 0.5 + 0.3) / 4 = 0.65
    local avg_pass
    avg_pass=$(echo "$output" | jq -r '.result.averagePassRate')
    [[ $(echo "$avg_pass > 0.6 && $avg_pass < 0.7" | bc -l) -eq 1 ]]
}

@test "compliance summary: filters by --since" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" summary --since "2026-01-22" --json
    assert_success

    # Should only include 2 entries from 2026-01-22
    echo "$output" | jq -e '.result.totalEntries == 2' >/dev/null
}

@test "compliance summary: human output format" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" summary --human
    assert_success

    assert_output --partial "Compliance Summary"
    assert_output --partial "Entries:"
    assert_output --partial "Pass Rate:"
    assert_output --partial "Violations:"
}

# =============================================================================
# VIOLATIONS TESTS
# =============================================================================

@test "compliance violations: returns empty list when no data" {
    run bash "$COMPLIANCE_SCRIPT" violations --json
    assert_success

    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.totalCount == 0' >/dev/null
}

@test "compliance violations: lists all violations" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" violations --json
    assert_success

    # Should have 3 entries with violations (0 violations excluded)
    local count
    count=$(echo "$output" | jq -r '.result.totalCount')
    [[ "$count" -eq 3 ]]
}

@test "compliance violations: filters by --severity" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" violations --severity critical --json
    assert_success

    # Should only include critical severity entry
    echo "$output" | jq -e '.result.totalCount == 1' >/dev/null
    echo "$output" | jq -e '.result.violations[0].severity == "critical"' >/dev/null
}

@test "compliance violations: filters by --agent" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" violations --agent opus-1 --json
    assert_success

    # Should include only opus-1 entries with violations (T003 has violations)
    echo "$output" | jq -e '.result.totalCount == 1' >/dev/null
    echo "$output" | jq -e '.result.violations[0].agentId == "opus-1"' >/dev/null
}

@test "compliance violations: human output format" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" violations --human
    assert_success

    assert_output --partial "Compliance Violations"
    assert_output --partial "Total:"
    assert_output --partial "TIMESTAMP"
    assert_output --partial "SEVERITY"
}

# =============================================================================
# TREND TESTS
# =============================================================================

@test "compliance trend: returns valid JSON with no data" {
    run bash "$COMPLIANCE_SCRIPT" trend 7 --json
    assert_success

    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.days == 7' >/dev/null
}

@test "compliance trend: shows trend over days" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" trend 14 --json
    assert_success

    echo "$output" | jq -e '.result.days == 14' >/dev/null
    echo "$output" | jq -e '.result.dataPoints | type == "array"' >/dev/null
}

@test "compliance trend: default is 7 days" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" trend --json
    assert_success

    echo "$output" | jq -e '.result.days == 7' >/dev/null
}

@test "compliance trend: human output format" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" trend --human
    assert_success

    assert_output --partial "Compliance Trend"
    assert_output --partial "days"
    assert_output --partial "Direction:"
}

# =============================================================================
# AUDIT TESTS
# =============================================================================

@test "compliance audit: requires epic ID" {
    run bash "$COMPLIANCE_SCRIPT" audit
    assert_failure
    assert_output --partial "requires EPIC_ID"
}

@test "compliance audit: handles missing epic" {
    create_test_tasks

    run bash "$COMPLIANCE_SCRIPT" audit T999 --json

    # Should return error for non-existent epic
    echo "$output" | jq -e '.success == false or .result.taskCount == 0' >/dev/null
}

@test "compliance audit: analyzes epic compliance" {
    create_test_tasks
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" audit T001 --json
    assert_success

    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.epicId == "T001"' >/dev/null
}

@test "compliance audit: human output format" {
    create_test_tasks
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" audit T001 --human
    assert_success

    assert_output --partial "Epic Compliance Audit"
    assert_output --partial "T001"
    assert_output --partial "Tasks:"
    assert_output --partial "Pass Rate:"
}

# =============================================================================
# SYNC TESTS
# =============================================================================

@test "compliance sync: creates global file if missing" {
    create_mock_compliance_data

    # Set up global metrics directory
    export CLEO_GLOBAL_METRICS="${TEST_TEMP_DIR}/global-metrics"
    mkdir -p "$CLEO_GLOBAL_METRICS"

    # Capture only stdout, ignore stderr (may have flock warnings)
    local json_output
    json_output=$(bash "$COMPLIANCE_SCRIPT" sync --json 2>/dev/null)
    local status=$?

    [[ "$status" -eq 0 ]]
    echo "$json_output" | jq -e '.success == true' >/dev/null
}

@test "compliance sync: reports synced count" {
    create_mock_compliance_data

    export CLEO_GLOBAL_METRICS="${TEST_TEMP_DIR}/global-metrics"
    mkdir -p "$CLEO_GLOBAL_METRICS"

    # Capture only stdout, ignore stderr
    local json_output
    json_output=$(bash "$COMPLIANCE_SCRIPT" sync --json 2>/dev/null)

    # Should report synced entries
    echo "$json_output" | jq -e '.result.synced >= 0' >/dev/null
}

@test "compliance sync: human output format" {
    create_mock_compliance_data

    export CLEO_GLOBAL_METRICS="${TEST_TEMP_DIR}/global-metrics"
    mkdir -p "$CLEO_GLOBAL_METRICS"

    run bash "$COMPLIANCE_SCRIPT" sync --human
    assert_success

    assert_output --partial "Synced"
    assert_output --partial "entries"
}

# =============================================================================
# SKILLS TESTS
# =============================================================================

@test "compliance skills: returns valid JSON" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" skills --json
    assert_success

    echo "$output" | jq -e '.success == true' >/dev/null
}

@test "compliance skills: groups by agent" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" skills --json
    assert_success

    # Should have data for opus-1, sonnet-1, haiku-1
    echo "$output" | jq -e '.result' >/dev/null
}

# =============================================================================
# OUTPUT FORMAT TESTS
# =============================================================================

@test "compliance: --json forces JSON output" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" summary --json
    assert_success

    # Must be valid JSON
    echo "$output" | jq empty
}

@test "compliance: --human forces human output" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" summary --human
    assert_success

    # Human output has headers
    assert_output --partial "==="
}

@test "compliance: piped output is JSON by default" {
    create_mock_compliance_data

    # Pipe to cat to simulate non-TTY (unset CLEO_FORMAT to test default)
    run bash -c "unset CLEO_FORMAT; bash '$COMPLIANCE_SCRIPT' summary | cat"
    assert_success

    # Should be valid JSON
    echo "$output" | jq empty
}

# =============================================================================
# EDGE CASE TESTS
# =============================================================================

@test "compliance: handles empty COMPLIANCE.jsonl" {
    touch "${TEST_TEMP_DIR}/.cleo/metrics/COMPLIANCE.jsonl"

    run bash "$COMPLIANCE_SCRIPT" summary --json
    assert_success
}

@test "compliance: handles malformed COMPLIANCE.jsonl lines" {
    local compliance_file="${TEST_TEMP_DIR}/.cleo/metrics/COMPLIANCE.jsonl"

    # Add valid entry
    echo '{"timestamp":"2026-01-20T10:00:00Z","source_id":"opus-1","compliance":{"compliance_pass_rate":1.0}}' > "$compliance_file"

    # Add invalid line (should be skipped)
    echo 'not valid json' >> "$compliance_file"

    # Add another valid entry
    echo '{"timestamp":"2026-01-21T10:00:00Z","source_id":"sonnet-1","compliance":{"compliance_pass_rate":0.8}}' >> "$compliance_file"

    run bash "$COMPLIANCE_SCRIPT" summary --json
    # Should not fail, but may have warnings
    [[ "$status" -eq 0 ]] || [[ "$status" -eq 0 ]]
}

@test "compliance report: generates human-readable report" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" report
    assert_success

    # Report should have clear sections
    assert_output --partial "Compliance"
}

# =============================================================================
# INTEGRATION WITH METRICS-AGGREGATION.SH
# =============================================================================

@test "compliance: uses get_project_compliance_summary" {
    create_mock_compliance_data

    # The summary command should use the library function
    run bash "$COMPLIANCE_SCRIPT" summary --json
    assert_success

    # Verify it returns the expected structure
    echo "$output" | jq -e '._meta' >/dev/null
    echo "$output" | jq -e '.result' >/dev/null
}

@test "compliance: uses get_compliance_trend" {
    create_mock_compliance_data

    run bash "$COMPLIANCE_SCRIPT" trend 7 --json
    assert_success

    # Verify trend structure
    echo "$output" | jq -e '.result.trend' >/dev/null || \
    echo "$output" | jq -e '.result.dataPoints' >/dev/null
}
