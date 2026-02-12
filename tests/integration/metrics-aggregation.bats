#!/usr/bin/env bats
# =============================================================================
# metrics-aggregation.bats - Integration tests for metrics aggregation library
# =============================================================================
# Tests:
# - sync_metrics_to_global function
# - get_project_compliance_summary function
# - get_global_compliance_summary function
# - get_compliance_trend function
# - get_skill_reliability function
# - Project to global sync mechanics
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

    # Create global metrics directory for tests
    export _MA_GLOBAL_METRICS_DIR="${TEST_TEMP_DIR}/global-metrics"
    mkdir -p "$_MA_GLOBAL_METRICS_DIR"

    # Source the library
    source "${LIB_DIR}/metrics/metrics-aggregation.sh"

    # Override global metrics directory for test isolation
    _MA_GLOBAL_METRICS_DIR="${TEST_TEMP_DIR}/global-metrics"

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

# Create mock project compliance data
create_project_compliance_data() {
    local compliance_file="${TEST_TEMP_DIR}/.cleo/metrics/COMPLIANCE.jsonl"
    mkdir -p "$(dirname "$compliance_file")"

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

# Create mock global metrics data
create_global_metrics_data() {
    local global_file="${_MA_GLOBAL_METRICS_DIR}/GLOBAL.jsonl"
    mkdir -p "$(dirname "$global_file")"

    # Entries from project-a
    cat >> "$global_file" << 'EOF'
{"timestamp":"2026-01-19T10:00:00Z","source_id":"opus-1","project":"project-a","compliance":{"compliance_pass_rate":0.9,"rule_adherence_score":0.95,"violation_count":1,"violation_severity":"low","manifest_integrity":"valid"}}
EOF

    # Entries from project-b
    cat >> "$global_file" << 'EOF'
{"timestamp":"2026-01-19T12:00:00Z","source_id":"sonnet-1","project":"project-b","compliance":{"compliance_pass_rate":0.7,"rule_adherence_score":0.75,"violation_count":3,"violation_severity":"medium","manifest_integrity":"valid"}}
EOF

    cat >> "$global_file" << 'EOF'
{"timestamp":"2026-01-20T08:00:00Z","source_id":"haiku-1","project":"project-b","compliance":{"compliance_pass_rate":0.85,"rule_adherence_score":0.8,"violation_count":2,"violation_severity":"low","manifest_integrity":"valid"}}
EOF
}

# =============================================================================
# get_project_compliance_summary TESTS
# =============================================================================

@test "get_project_compliance_summary: returns valid JSON when no data" {
    run get_project_compliance_summary

    assert_success
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.totalEntries == 0' >/dev/null
}

@test "get_project_compliance_summary: calculates totals correctly" {
    create_project_compliance_data

    run get_project_compliance_summary

    assert_success

    # Check total entries
    echo "$output" | jq -e '.result.totalEntries == 4' >/dev/null

    # Check total violations (0+2+5+8 = 15)
    echo "$output" | jq -e '.result.totalViolations == 15' >/dev/null
}

@test "get_project_compliance_summary: calculates averages correctly" {
    create_project_compliance_data

    run get_project_compliance_summary

    assert_success

    # Average pass rate: (1.0 + 0.8 + 0.5 + 0.3) / 4 = 0.65
    local avg_pass
    avg_pass=$(echo "$output" | jq -r '.result.averagePassRate')
    [[ $(echo "$avg_pass > 0.6 && $avg_pass < 0.7" | bc -l) -eq 1 ]]

    # Average adherence: (1.0 + 0.85 + 0.6 + 0.4) / 4 = 0.7125
    local avg_adhere
    avg_adhere=$(echo "$output" | jq -r '.result.averageAdherence')
    [[ $(echo "$avg_adhere > 0.7 && $avg_adhere < 0.75" | bc -l) -eq 1 ]]
}

@test "get_project_compliance_summary: groups by severity" {
    create_project_compliance_data

    run get_project_compliance_summary

    assert_success

    # Check severity breakdown
    echo "$output" | jq -e '.result.bySeverity.none == 1' >/dev/null
    echo "$output" | jq -e '.result.bySeverity.medium == 1' >/dev/null
    echo "$output" | jq -e '.result.bySeverity.high == 1' >/dev/null
    echo "$output" | jq -e '.result.bySeverity.critical == 1' >/dev/null
}

@test "get_project_compliance_summary: groups by agent" {
    create_project_compliance_data

    run get_project_compliance_summary

    assert_success

    # opus-1 has 2 entries
    echo "$output" | jq -e '.result.byAgent["opus-1"].count == 2' >/dev/null
    # sonnet-1 has 1 entry
    echo "$output" | jq -e '.result.byAgent["sonnet-1"].count == 1' >/dev/null
    # haiku-1 has 1 entry
    echo "$output" | jq -e '.result.byAgent["haiku-1"].count == 1' >/dev/null
}

@test "get_project_compliance_summary: filters by --since" {
    create_project_compliance_data

    run get_project_compliance_summary --since "2026-01-22"

    assert_success

    # Should only have 2 entries from 2026-01-22
    echo "$output" | jq -e '.result.totalEntries == 2' >/dev/null
}

@test "get_project_compliance_summary: filters by --agent" {
    create_project_compliance_data

    run get_project_compliance_summary --agent "opus-1"

    assert_success

    # Should only have 2 entries from opus-1
    echo "$output" | jq -e '.result.totalEntries == 2' >/dev/null
}

# =============================================================================
# get_global_compliance_summary TESTS
# =============================================================================

@test "get_global_compliance_summary: returns valid JSON when no data" {
    run get_global_compliance_summary

    assert_success
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.totalEntries == 0' >/dev/null
    echo "$output" | jq -e '.result.totalProjects == 0' >/dev/null
}

@test "get_global_compliance_summary: calculates across projects" {
    create_global_metrics_data

    run get_global_compliance_summary

    assert_success

    # Check totals
    echo "$output" | jq -e '.result.totalEntries == 3' >/dev/null
    echo "$output" | jq -e '.result.totalProjects == 2' >/dev/null
}

@test "get_global_compliance_summary: groups by project" {
    create_global_metrics_data

    run get_global_compliance_summary

    assert_success

    # project-a has 1 entry
    echo "$output" | jq -e '.result.byProject["project-a"].entries == 1' >/dev/null
    # project-b has 2 entries
    echo "$output" | jq -e '.result.byProject["project-b"].entries == 2' >/dev/null
}

@test "get_global_compliance_summary: filters by --project" {
    create_global_metrics_data

    run get_global_compliance_summary --project "project-b"

    assert_success

    # Should only have 2 entries from project-b
    echo "$output" | jq -e '.result.totalEntries == 2' >/dev/null
}

# =============================================================================
# get_compliance_trend TESTS
# =============================================================================

@test "get_compliance_trend: returns valid JSON when no data" {
    run get_compliance_trend 7

    assert_success
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.days == 7' >/dev/null
    echo "$output" | jq -e '.result.trend == "no_data"' >/dev/null
}

@test "get_compliance_trend: returns data points grouped by day" {
    create_project_compliance_data

    run get_compliance_trend 30

    assert_success

    # Should have data points
    echo "$output" | jq -e '.result.dataPoints | type == "array"' >/dev/null
    echo "$output" | jq -e '.result.dataPoints | length > 0' >/dev/null
}

@test "get_compliance_trend: calculates trend direction" {
    create_project_compliance_data

    run get_compliance_trend 30

    assert_success

    # Trend should be one of: improving, declining, stable, no_data
    local trend
    trend=$(echo "$output" | jq -r '.result.trend')
    [[ "$trend" == "improving" || "$trend" == "declining" || "$trend" == "stable" || "$trend" == "no_data" ]]
}

@test "get_compliance_trend: uses global data with --global" {
    create_global_metrics_data

    run get_compliance_trend 30 --global

    assert_success

    echo "$output" | jq -e '.result.dataPoints | type == "array"' >/dev/null
}

# =============================================================================
# get_skill_reliability TESTS
# =============================================================================

@test "get_skill_reliability: returns valid JSON when no data" {
    run get_skill_reliability

    assert_success
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.skills == []' >/dev/null
    echo "$output" | jq -e '.result.summary.totalSkills == 0' >/dev/null
}

@test "get_skill_reliability: calculates per-skill stats" {
    create_project_compliance_data

    run get_skill_reliability

    assert_success

    # Should have 3 skills
    echo "$output" | jq -e '.result.summary.totalSkills == 3' >/dev/null

    # Each skill should have reliability score
    echo "$output" | jq -e '.result.skills | all(.reliability != null)' >/dev/null
}

@test "get_skill_reliability: sorts by reliability descending" {
    create_project_compliance_data

    run get_skill_reliability

    assert_success

    # First skill should have higher reliability than last
    local first_rel last_rel
    first_rel=$(echo "$output" | jq -r '.result.skills[0].reliability')
    last_rel=$(echo "$output" | jq -r '.result.skills[-1].reliability')

    [[ $(echo "$first_rel >= $last_rel" | bc -l) -eq 1 ]]
}

@test "get_skill_reliability: includes invocation counts" {
    create_project_compliance_data

    run get_skill_reliability

    assert_success

    # opus-1 should have 2 invocations
    echo "$output" | jq -e '.result.skills[] | select(.skill == "opus-1") | .invocations == 2' >/dev/null
}

# =============================================================================
# sync_metrics_to_global TESTS
# =============================================================================

@test "sync_metrics_to_global: handles missing project file" {
    run sync_metrics_to_global

    assert_success
    echo "$output" | jq -e '.success == true' >/dev/null
    echo "$output" | jq -e '.result.synced == 0' >/dev/null
}

@test "sync_metrics_to_global: syncs new entries" {
    create_project_compliance_data

    # Redirect stderr to /dev/null to avoid flock warnings
    local json_output
    json_output=$(sync_metrics_to_global 2>/dev/null)
    local status=$?

    [[ "$status" -eq 0 ]]
    echo "$json_output" | jq -e '.success == true' >/dev/null
    echo "$json_output" | jq -e '.result.synced == 4' >/dev/null

    # Verify entries exist in global file
    local global_file="${_MA_GLOBAL_METRICS_DIR}/GLOBAL.jsonl"
    [[ -f "$global_file" ]]

    local line_count
    line_count=$(wc -l < "$global_file")
    [[ "$line_count" -eq 4 ]]
}

@test "sync_metrics_to_global: adds project field" {
    create_project_compliance_data

    sync_metrics_to_global 2>/dev/null

    local global_file="${_MA_GLOBAL_METRICS_DIR}/GLOBAL.jsonl"

    # All entries should have project field
    local entries_with_project
    entries_with_project=$(jq -r 'select(.project != null) | .project' "$global_file" | wc -l)
    [[ "$entries_with_project" -eq 4 ]]
}

@test "sync_metrics_to_global: deduplicates entries" {
    create_project_compliance_data

    # Sync once
    sync_metrics_to_global 2>/dev/null

    # Sync again - should skip all
    local json_output
    json_output=$(sync_metrics_to_global 2>/dev/null)

    echo "$json_output" | jq -e '.result.skipped == 4' >/dev/null
    echo "$json_output" | jq -e '.result.synced == 0' >/dev/null

    # Global file should still have only 4 entries
    local global_file="${_MA_GLOBAL_METRICS_DIR}/GLOBAL.jsonl"
    local line_count
    line_count=$(wc -l < "$global_file")
    [[ "$line_count" -eq 4 ]]
}

@test "sync_metrics_to_global: force sync re-adds all entries" {
    create_project_compliance_data

    # Sync once
    sync_metrics_to_global 2>/dev/null

    # Force sync - should add all again
    local json_output
    json_output=$(sync_metrics_to_global --force 2>/dev/null)

    echo "$json_output" | jq -e '.result.synced == 4' >/dev/null

    # Global file should now have 8 entries (duplicates allowed with --force)
    local global_file="${_MA_GLOBAL_METRICS_DIR}/GLOBAL.jsonl"
    local line_count
    line_count=$(wc -l < "$global_file")
    [[ "$line_count" -eq 8 ]]
}

# =============================================================================
# format_compliance_report TESTS
# =============================================================================

@test "format_compliance_report: json format passes through" {
    create_project_compliance_data

    local json_input
    json_input=$(get_project_compliance_summary)

    run format_compliance_report "$json_input" --format json

    assert_success
    # Output should be valid JSON
    echo "$output" | jq empty
}

@test "format_compliance_report: human format has headers" {
    create_project_compliance_data

    local json_input
    json_input=$(get_project_compliance_summary)

    run format_compliance_report "$json_input" --format human

    assert_success
    assert_output --partial "Compliance Report"
    assert_output --partial "Entries:"
    assert_output --partial "Pass Rate:"
    assert_output --partial "Violations:"
}

@test "format_compliance_report: shows severity breakdown" {
    create_project_compliance_data

    local json_input
    json_input=$(get_project_compliance_summary)

    run format_compliance_report "$json_input" --format human

    assert_success
    assert_output --partial "By Severity:"
}

@test "format_compliance_report: shows agent breakdown" {
    create_project_compliance_data

    local json_input
    json_input=$(get_project_compliance_summary)

    run format_compliance_report "$json_input" --format human

    assert_success
    assert_output --partial "By Agent:"
}

# =============================================================================
# EDGE CASES AND ERROR HANDLING
# =============================================================================

@test "metrics-aggregation: handles empty COMPLIANCE.jsonl" {
    local compliance_file="${TEST_TEMP_DIR}/.cleo/metrics/COMPLIANCE.jsonl"
    touch "$compliance_file"

    run get_project_compliance_summary

    assert_success
    echo "$output" | jq -e '.result.totalEntries == 0' >/dev/null
}

@test "metrics-aggregation: handles malformed JSON lines" {
    local compliance_file="${TEST_TEMP_DIR}/.cleo/metrics/COMPLIANCE.jsonl"
    mkdir -p "$(dirname "$compliance_file")"

    # Add valid entry
    echo '{"timestamp":"2026-01-20T10:00:00Z","source_id":"opus-1","compliance":{"compliance_pass_rate":1.0,"violation_count":0}}' > "$compliance_file"

    # Add invalid line (should be ignored)
    echo 'not valid json' >> "$compliance_file"

    # Add another valid entry
    echo '{"timestamp":"2026-01-21T10:00:00Z","source_id":"sonnet-1","compliance":{"compliance_pass_rate":0.8,"violation_count":2}}' >> "$compliance_file"

    run get_project_compliance_summary

    # Should not fail catastrophically
    [[ "$status" -eq 0 ]]
}

@test "metrics-aggregation: handles missing compliance fields" {
    local compliance_file="${TEST_TEMP_DIR}/.cleo/metrics/COMPLIANCE.jsonl"
    mkdir -p "$(dirname "$compliance_file")"

    # Entry with minimal fields
    echo '{"timestamp":"2026-01-20T10:00:00Z","source_id":"opus-1"}' > "$compliance_file"

    run get_project_compliance_summary

    assert_success
    # Should handle missing compliance gracefully
    echo "$output" | jq -e '.result.totalEntries == 1' >/dev/null
}

# =============================================================================
# CONCURRENT ACCESS TESTS
# =============================================================================

@test "sync_metrics_to_global: handles concurrent sync attempts" {
    create_project_compliance_data

    # Run two syncs in background
    sync_metrics_to_global 2>/dev/null &
    local pid1=$!

    sync_metrics_to_global 2>/dev/null &
    local pid2=$!

    # Wait for both
    wait $pid1
    wait $pid2

    # Global file should have correct number of entries (4 from first sync + some skips)
    local global_file="${_MA_GLOBAL_METRICS_DIR}/GLOBAL.jsonl"
    [[ -f "$global_file" ]]

    # Should have at least 4 entries (from first sync)
    local line_count
    line_count=$(wc -l < "$global_file")
    [[ "$line_count" -ge 4 ]]
}
