#!/usr/bin/env bats
# =============================================================================
# archive-stats.bats - Unit tests for archive-stats command (T447/T429)
# =============================================================================
# Tests the archive analytics and reporting functionality including
# summary stats, phase breakdown, label breakdown, and cycle time analysis.
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    load '../test_helper/fixtures'
    common_setup_per_test

    # Set up script path for archive-stats
    export ARCHIVE_STATS_SCRIPT="${SCRIPTS_DIR}/archive-stats.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper: Create archive with diverse tasks for stats
# =============================================================================

create_archive_for_stats() {
    local dest="${1:-$ARCHIVE_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": "test-project",
  "_meta": {"totalArchived": 6, "lastArchived": "2025-12-15T10:00:00Z"},
  "archivedTasks": [
    {
      "id": "T001",
      "title": "Setup task",
      "description": "Setup phase task",
      "status": "done",
      "priority": "critical",
      "phase": "setup",
      "labels": ["security", "urgent"],
      "createdAt": "2025-11-01T10:00:00Z",
      "completedAt": "2025-11-05T10:00:00Z",
      "_archive": {"archivedAt": "2025-12-01T10:00:00Z", "cycleTimeDays": 4, "archiveSource": "auto"}
    },
    {
      "id": "T002",
      "title": "Core task 1",
      "description": "Core phase task",
      "status": "done",
      "priority": "high",
      "phase": "core",
      "labels": ["feature"],
      "createdAt": "2025-11-05T10:00:00Z",
      "completedAt": "2025-11-15T10:00:00Z",
      "_archive": {"archivedAt": "2025-12-05T10:00:00Z", "cycleTimeDays": 10, "archiveSource": "auto"}
    },
    {
      "id": "T003",
      "title": "Core task 2",
      "description": "Another core task",
      "status": "done",
      "priority": "high",
      "phase": "core",
      "labels": ["feature", "api"],
      "createdAt": "2025-11-10T10:00:00Z",
      "completedAt": "2025-11-18T10:00:00Z",
      "_archive": {"archivedAt": "2025-12-08T10:00:00Z", "cycleTimeDays": 8, "archiveSource": "force"}
    },
    {
      "id": "T004",
      "title": "Testing task",
      "description": "Testing phase task",
      "status": "done",
      "priority": "medium",
      "phase": "testing",
      "labels": ["testing"],
      "createdAt": "2025-11-15T10:00:00Z",
      "completedAt": "2025-11-20T10:00:00Z",
      "_archive": {"archivedAt": "2025-12-10T10:00:00Z", "cycleTimeDays": 5, "archiveSource": "auto"}
    },
    {
      "id": "T005",
      "title": "Low priority task",
      "description": "Low priority",
      "status": "done",
      "priority": "low",
      "phase": "polish",
      "createdAt": "2025-11-18T10:00:00Z",
      "completedAt": "2025-12-01T10:00:00Z",
      "_archive": {"archivedAt": "2025-12-12T10:00:00Z", "cycleTimeDays": 13, "archiveSource": "manual"}
    },
    {
      "id": "T006",
      "title": "Recent task",
      "description": "Most recent",
      "status": "done",
      "priority": "medium",
      "phase": "core",
      "labels": ["feature"],
      "createdAt": "2025-12-01T10:00:00Z",
      "completedAt": "2025-12-10T10:00:00Z",
      "_archive": {"archivedAt": "2025-12-15T10:00:00Z", "cycleTimeDays": 9, "archiveSource": "auto"}
    }
  ],
  "phaseSummary": {},
  "statistics": {"byPhase": {}, "byPriority": {}, "byLabel": {}}
}
EOF
}

# =============================================================================
# Script Presence Tests
# =============================================================================

@test "archive-stats script exists" {
    [ -f "$ARCHIVE_STATS_SCRIPT" ]
}

@test "archive-stats script is executable" {
    [ -x "$ARCHIVE_STATS_SCRIPT" ]
}

# =============================================================================
# Help and Usage Tests
# =============================================================================

@test "archive-stats --help shows usage" {
    run bash "$ARCHIVE_STATS_SCRIPT" --help
    assert_success
    assert_output --partial "Usage:"
    assert_output_contains_any "archive-stats" "analytics" "report"
}

@test "archive-stats -h shows usage" {
    run bash "$ARCHIVE_STATS_SCRIPT" -h
    assert_success
    assert_output --partial "Usage:"
}

# =============================================================================
# Summary Report Tests
# =============================================================================

@test "archive-stats --summary shows total count" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --summary --json
    assert_success

    local total
    total=$(echo "$output" | jq '.data.totalArchived')
    [ "$total" -eq 6 ]
}

@test "archive-stats defaults to summary report" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --json
    assert_success

    local report_type
    report_type=$(echo "$output" | jq -r '.report')
    [ "$report_type" = "summary" ]
}

@test "archive-stats --summary includes average cycle time" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --summary --json
    assert_success

    local avg_cycle
    avg_cycle=$(echo "$output" | jq '.data.averageCycleTime')
    [ "$avg_cycle" != "null" ]
    # (4+10+8+5+13+9)/6 = 49/6 = 8.16
}

@test "archive-stats --summary includes priority breakdown" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --summary --json
    assert_success

    local by_priority
    by_priority=$(echo "$output" | jq '.data.byPriority')
    [ "$by_priority" != "null" ]

    # Check specific priority counts
    local critical_count
    critical_count=$(echo "$output" | jq '.data.byPriority.critical // 0')
    [ "$critical_count" -eq 1 ]

    local high_count
    high_count=$(echo "$output" | jq '.data.byPriority.high // 0')
    [ "$high_count" -eq 2 ]
}

@test "archive-stats --summary includes date ranges" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --summary --json
    assert_success

    local oldest
    oldest=$(echo "$output" | jq -r '.data.oldestArchived')
    [ "$oldest" != "null" ]
    [ -n "$oldest" ]

    local newest
    newest=$(echo "$output" | jq -r '.data.newestArchived')
    [ "$newest" != "null" ]
    [ -n "$newest" ]
}

@test "archive-stats --summary includes archive source breakdown" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --summary --json
    assert_success

    local source_breakdown
    source_breakdown=$(echo "$output" | jq '.data.archiveSourceBreakdown')
    [ "$source_breakdown" != "null" ]

    # Should have auto, force, manual sources
    local auto_count
    auto_count=$(echo "$output" | jq '.data.archiveSourceBreakdown.auto // 0')
    [ "$auto_count" -ge 1 ]
}

# =============================================================================
# Phase Breakdown Tests
# =============================================================================

@test "archive-stats --by-phase shows phase breakdown" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-phase --json
    assert_success

    local report_type
    report_type=$(echo "$output" | jq -r '.report')
    [ "$report_type" = "by-phase" ]
}

@test "archive-stats --by-phase counts tasks per phase" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-phase --json
    assert_success

    # Core phase should have 3 tasks
    local core_count
    core_count=$(echo "$output" | jq '.data[] | select(.phase == "core") | .count')
    [ "$core_count" -eq 3 ]

    # Setup phase should have 1 task
    local setup_count
    setup_count=$(echo "$output" | jq '.data[] | select(.phase == "setup") | .count')
    [ "$setup_count" -eq 1 ]
}

@test "archive-stats --by-phase includes avgCycleTime per phase" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-phase --json
    assert_success

    local core_avg
    core_avg=$(echo "$output" | jq '.data[] | select(.phase == "core") | .avgCycleTime')
    [ "$core_avg" != "null" ]
}

@test "archive-stats --by-phase sorted by count descending" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-phase --json
    assert_success

    # First phase should have highest count
    local first_phase
    first_phase=$(echo "$output" | jq -r '.data[0].phase')
    [ "$first_phase" = "core" ]  # 3 tasks
}

# =============================================================================
# Label Breakdown Tests
# =============================================================================

@test "archive-stats --by-label shows label breakdown" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-label --json
    assert_success

    local report_type
    report_type=$(echo "$output" | jq -r '.report')
    [ "$report_type" = "by-label" ]
}

@test "archive-stats --by-label counts label occurrences" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-label --json
    assert_success

    # "feature" label appears on 3 tasks
    local feature_count
    feature_count=$(echo "$output" | jq '.data[] | select(.label == "feature") | .count')
    [ "$feature_count" -eq 3 ]
}

@test "archive-stats --by-label sorted by count descending" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-label --json
    assert_success

    # First label should have highest count
    local first_label
    first_label=$(echo "$output" | jq -r '.data[0].label')
    [ "$first_label" = "feature" ]
}

# =============================================================================
# Priority Breakdown Tests
# =============================================================================

@test "archive-stats --by-priority shows priority breakdown" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-priority --json
    assert_success

    local report_type
    report_type=$(echo "$output" | jq -r '.report')
    [ "$report_type" = "by-priority" ]
}

@test "archive-stats --by-priority sorted by priority level" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-priority --json
    assert_success

    # Should be sorted: critical, high, medium, low
    local first_priority
    first_priority=$(echo "$output" | jq -r '.data[0].priority')
    [ "$first_priority" = "critical" ]
}

@test "archive-stats --by-priority includes avgCycleTime" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-priority --json
    assert_success

    local high_avg
    high_avg=$(echo "$output" | jq '.data[] | select(.priority == "high") | .avgCycleTime')
    [ "$high_avg" != "null" ]
}

# =============================================================================
# Cycle Time Analysis Tests
# =============================================================================

@test "archive-stats --cycle-times shows analysis" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --cycle-times --json
    assert_success

    local report_type
    report_type=$(echo "$output" | jq -r '.report')
    [ "$report_type" = "cycle-times" ]
}

@test "archive-stats --cycle-times includes min/max/avg/median" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --cycle-times --json
    assert_success

    local min_time
    min_time=$(echo "$output" | jq '.data.min')
    [ "$min_time" -eq 4 ]

    local max_time
    max_time=$(echo "$output" | jq '.data.max')
    [ "$max_time" -eq 13 ]

    local avg_time
    avg_time=$(echo "$output" | jq '.data.avg')
    [ "$avg_time" != "null" ]

    local median_time
    median_time=$(echo "$output" | jq '.data.median')
    [ "$median_time" != "null" ]
}

@test "archive-stats --cycle-times includes distribution" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --cycle-times --json
    assert_success

    # Check distribution buckets exist
    echo "$output" | jq -e '.data.distribution' >/dev/null
    echo "$output" | jq -e '.data.distribution["0-1 days"]' >/dev/null
    echo "$output" | jq -e '.data.distribution["2-7 days"]' >/dev/null
    echo "$output" | jq -e '.data.distribution["8-30 days"]' >/dev/null
    echo "$output" | jq -e '.data.distribution["30+ days"]' >/dev/null
}

@test "archive-stats --cycle-times includes percentiles" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --cycle-times --json
    assert_success

    echo "$output" | jq -e '.data.percentiles' >/dev/null
    echo "$output" | jq -e '.data.percentiles.p50' >/dev/null
    echo "$output" | jq -e '.data.percentiles.p90' >/dev/null
}

# =============================================================================
# Trends Report Tests
# =============================================================================

@test "archive-stats --trends shows archiving trends" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --trends --json
    assert_success

    local report_type
    report_type=$(echo "$output" | jq -r '.report')
    [ "$report_type" = "trends" ]
}

@test "archive-stats --trends includes byDay data" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --trends --json
    assert_success

    local by_day_length
    by_day_length=$(echo "$output" | jq '.data.byDay | length')
    [ "$by_day_length" -ge 1 ]
}

@test "archive-stats --trends includes byMonth data" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --trends --json
    assert_success

    local by_month_length
    by_month_length=$(echo "$output" | jq '.data.byMonth | length')
    [ "$by_month_length" -ge 1 ]
}

@test "archive-stats --trends includes totalPeriod" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --trends --json
    assert_success

    local total
    total=$(echo "$output" | jq '.data.totalPeriod')
    [ "$total" -eq 6 ]
}

# =============================================================================
# Date Filtering Tests
# =============================================================================

@test "archive-stats --since filters by date" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --summary --since "2025-12-10" --json
    assert_success

    # Only T004 (12-10), T005 (12-12), T006 (12-15) should be included
    local total
    total=$(echo "$output" | jq '.data.totalArchived')
    [ "$total" -eq 3 ]
}

@test "archive-stats --until filters by date" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --summary --until "2025-12-05" --json
    assert_success

    # Only T001 (12-01), T002 (12-05) should be included
    local total
    total=$(echo "$output" | jq '.data.totalArchived')
    [ "$total" -eq 2 ]
}

@test "archive-stats --since and --until can be combined" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --summary --since "2025-12-05" --until "2025-12-10" --json
    assert_success

    # T002 (12-05), T003 (12-08), T004 (12-10) should be included
    local total
    total=$(echo "$output" | jq '.data.totalArchived')
    [ "$total" -eq 3 ]
}

@test "archive-stats filter info included in JSON output" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --summary --since "2025-12-01" --json
    assert_success

    local since_filter
    since_filter=$(echo "$output" | jq -r '.filters.since')
    [ "$since_filter" = "2025-12-01" ]
}

# =============================================================================
# Output Format Tests
# =============================================================================

@test "archive-stats --json outputs valid JSON" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --json
    assert_success

    # Should be valid JSON
    echo "$output" | jq . >/dev/null 2>&1
}

@test "archive-stats JSON includes schema and meta" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --json
    assert_success

    echo "$output" | jq -e '."$schema"' >/dev/null
    echo "$output" | jq -e '._meta' >/dev/null
    echo "$output" | jq -e '.success' >/dev/null
    echo "$output" | jq -e '.generatedAt' >/dev/null
}

@test "archive-stats --human forces text output" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --human
    assert_success

    # Should contain text headers
    assert_output_contains_any "ARCHIVE ANALYTICS" "Total" "Archived"
}

@test "archive-stats text output is formatted" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --summary --human
    assert_success

    assert_output_contains_any "Total Archived" "Average Cycle"
}

# =============================================================================
# CSV Output Tests
# =============================================================================

@test "archive-stats --by-phase outputs CSV with --format csv" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-phase --format csv
    assert_success

    # Should have CSV header
    assert_output --partial "phase,count"
}

@test "archive-stats --by-label outputs CSV" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --by-label --format csv
    assert_success

    assert_output --partial "label,count"
}

# =============================================================================
# Empty/Missing Archive Tests
# =============================================================================

@test "archive-stats handles missing archive file" {
    rm -f "$ARCHIVE_FILE"

    run bash "$ARCHIVE_STATS_SCRIPT" --json
    assert_success

    local total
    total=$(echo "$output" | jq '.data.totalArchived')
    [ "$total" -eq 0 ]
}

@test "archive-stats handles empty archive" {
    cat > "$ARCHIVE_FILE" << 'EOF'
{
  "version": "2.3.0",
  "_meta": {"totalArchived": 0},
  "archivedTasks": []
}
EOF

    run bash "$ARCHIVE_STATS_SCRIPT" --json
    assert_success

    local total
    total=$(echo "$output" | jq '.data.totalArchived')
    [ "$total" -eq 0 ]
}

@test "archive-stats --cycle-times handles no cycle time data" {
    cat > "$ARCHIVE_FILE" << 'EOF'
{
  "version": "2.3.0",
  "_meta": {"totalArchived": 1},
  "archivedTasks": [
    {"id": "T001", "title": "No cycle time", "status": "done", "_archive": {"archivedAt": "2025-12-01T10:00:00Z"}}
  ]
}
EOF

    run bash "$ARCHIVE_STATS_SCRIPT" --cycle-times --json
    assert_success

    local count
    count=$(echo "$output" | jq '.data.count')
    [ "$count" -eq 0 ]
}

# =============================================================================
# Quiet Mode Tests
# =============================================================================

@test "archive-stats --quiet suppresses decorative output" {
    create_archive_for_stats

    run bash "$ARCHIVE_STATS_SCRIPT" --human --quiet
    assert_success

    # Should NOT contain decorative lines
    [[ "$output" != *"==========="* ]]
}
