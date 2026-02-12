#!/usr/bin/env bats

# Tests for lib/metrics/otel-integration.sh
# @task T2855 - Create BATS tests for otel-integration.sh

# Setup test environment
setup() {
    # Store original directory
    export ORIGINAL_DIR="$(pwd)"

    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export OTEL_METRICS_DIR="${TEST_DIR}/.cleo/metrics/otel"

    # Create metrics directory
    mkdir -p "$OTEL_METRICS_DIR"

    # Copy fixture to test location
    cp "${ORIGINAL_DIR}/tests/fixtures/otel-sample.json" "${OTEL_METRICS_DIR}/sample.json"

    # Token metrics file is inside otel directory
    export TOKEN_METRICS_FILE="${OTEL_METRICS_DIR}/token_metrics.jsonl"

    # Source the library
    source "${ORIGINAL_DIR}/lib/metrics/otel-integration.sh"
}

teardown() {
    # Clean up test directory
    rm -rf "$TEST_DIR"

    # Unset environment variables
    unset OTEL_METRICS_DIR
    unset TEST_DIR
    unset CLAUDE_CODE_ENABLE_TELEMETRY
    unset OTEL_METRICS_EXPORTER
    unset OTEL_EXPORTER_OTLP_PROTOCOL
    unset OTEL_EXPORTER_OTLP_ENDPOINT
}

# =============================================================================
# setup_otel_capture tests
# =============================================================================

@test "setup_otel_capture: file mode sets correct environment variables" {
    run setup_otel_capture file

    [ "$status" -eq 0 ]
    [[ "$output" == *"export CLAUDE_CODE_ENABLE_TELEMETRY=1"* ]]
    [[ "$output" == *"export OTEL_METRICS_EXPORTER=otlp"* ]]
    [[ "$output" == *"export OTEL_EXPORTER_OTLP_PROTOCOL=http/json"* ]]
    [[ "$output" == *"export OTEL_EXPORTER_OTLP_ENDPOINT=file://"* ]]
}

@test "setup_otel_capture: console mode sets correct environment variables" {
    run setup_otel_capture console

    [ "$status" -eq 0 ]
    [[ "$output" == *"export CLAUDE_CODE_ENABLE_TELEMETRY=1"* ]]
    [[ "$output" == *"export OTEL_METRICS_EXPORTER=console"* ]]
    [[ "$output" == *"export OTEL_METRIC_EXPORT_INTERVAL=5000"* ]]
}

@test "setup_otel_capture: prometheus mode sets correct environment variables" {
    run setup_otel_capture prometheus

    [ "$status" -eq 0 ]
    [[ "$output" == *"export CLAUDE_CODE_ENABLE_TELEMETRY=1"* ]]
    [[ "$output" == *"export OTEL_METRICS_EXPORTER=prometheus"* ]]
    [[ "$output" == *"localhost:9464/metrics"* ]]
}

@test "setup_otel_capture: defaults to file mode when no argument" {
    run setup_otel_capture

    [ "$status" -eq 0 ]
    [[ "$output" == *"export OTEL_METRICS_EXPORTER=otlp"* ]]
}

@test "setup_otel_capture: rejects invalid mode" {
    run setup_otel_capture invalid_mode

    [ "$status" -eq 1 ]
    [[ "$output" == *"Unknown mode"* ]]
}

@test "is_otel_enabled: returns 0 when telemetry is enabled" {
    export CLAUDE_CODE_ENABLE_TELEMETRY=1

    run is_otel_enabled
    [ "$status" -eq 0 ]
}

@test "is_otel_enabled: returns 1 when telemetry is not enabled" {
    unset CLAUDE_CODE_ENABLE_TELEMETRY

    run is_otel_enabled
    [ "$status" -eq 1 ]
}

# =============================================================================
# parse_token_metrics tests
# =============================================================================

@test "parse_token_metrics: extracts token counts from OTel JSON" {
    run parse_token_metrics "${OTEL_METRICS_DIR}/sample.json"

    [ "$status" -eq 0 ]

    # Should contain all token types
    [[ "$output" == *'"type":"input"'* ]]
    [[ "$output" == *'"type":"output"'* ]]
    [[ "$output" == *'"type":"cacheRead"'* ]]
    [[ "$output" == *'"type":"cacheCreation"'* ]]

    # Should contain token counts
    [[ "$output" == *'"tokens":1250'* ]]  # input
    [[ "$output" == *'"tokens":3400'* ]]  # output
}

@test "parse_token_metrics: extracts model information" {
    run parse_token_metrics "${OTEL_METRICS_DIR}/sample.json"

    [ "$status" -eq 0 ]
    [[ "$output" == *'"model":"claude-sonnet-4-5"'* ]]
}

@test "parse_token_metrics: handles missing file" {
    run parse_token_metrics "${OTEL_METRICS_DIR}/nonexistent.json"

    [ "$status" -eq 1 ]
    [[ "$output" == *'"error":"No metrics file found"'* ]]
}

@test "parse_token_metrics: uses latest file when no argument" {
    # Create a newer file
    cp "${OTEL_METRICS_DIR}/sample.json" "${OTEL_METRICS_DIR}/newer.json"
    touch -t 202601312359 "${OTEL_METRICS_DIR}/newer.json"

    run parse_token_metrics

    [ "$status" -eq 0 ]
    # Should parse successfully (from latest file)
    [[ "$output" == *'"tokens":'* ]]
}

# =============================================================================
# get_session_tokens tests
# =============================================================================

@test "get_session_tokens: aggregates input/output/cache tokens" {
    run get_session_tokens "test_session"

    [ "$status" -eq 0 ]

    # Parse JSON output
    input=$(echo "$output" | jq -r '.tokens.input')
    output_tokens=$(echo "$output" | jq -r '.tokens.output')
    cache_read=$(echo "$output" | jq -r '.tokens.cache_read')
    cache_create=$(echo "$output" | jq -r '.tokens.cache_creation')

    # Verify aggregation (fixture has: input=1250, output=3400, cacheRead=500, cacheCreation=800)
    [ "$input" -eq 1250 ]
    [ "$output_tokens" -eq 3400 ]
    [ "$cache_read" -eq 500 ]
    [ "$cache_create" -eq 800 ]
}

@test "get_session_tokens: calculates total tokens correctly" {
    run get_session_tokens "test_session"

    [ "$status" -eq 0 ]

    total=$(echo "$output" | jq -r '.tokens.total')
    # total = input + output = 1250 + 3400 = 4650
    [ "$total" -eq 4650 ]
}

@test "get_session_tokens: calculates effective tokens (excluding cache reads)" {
    run get_session_tokens "test_session"

    [ "$status" -eq 0 ]

    effective=$(echo "$output" | jq -r '.tokens.effective')
    # effective = input + output - cache_read = 1250 + 3400 - 500 = 4150
    [ "$effective" -eq 4150 ]
}

@test "get_session_tokens: includes session ID when provided" {
    run get_session_tokens "my_session"

    [ "$status" -eq 0 ]

    session_id=$(echo "$output" | jq -r '.session_id')
    [ "$session_id" = "my_session" ]
}

@test "get_session_tokens: session ID is null when not provided" {
    run get_session_tokens

    [ "$status" -eq 0 ]

    session_id=$(echo "$output" | jq -r '.session_id')
    [ "$session_id" = "null" ]
}

@test "get_session_tokens: includes source field" {
    run get_session_tokens

    [ "$status" -eq 0 ]

    source=$(echo "$output" | jq -r '.source')
    [ "$source" = "otel" ]
}

# =============================================================================
# compare_sessions tests
# =============================================================================

@test "compare_sessions: calculates delta between sessions" {
    # Create mock session data
    cat > "$TOKEN_METRICS_FILE" << 'EOF'
{"session_id":"session_a","timestamp":"2026-01-31T10:00:00Z","event":"session_end","session_tokens":{"input":1000,"output":2000,"total":3000},"cumulative":{"input":1000,"output":2000,"total":3000}}
{"session_id":"session_b","timestamp":"2026-01-31T10:30:00Z","event":"session_end","session_tokens":{"input":2000,"output":4000,"total":6000},"cumulative":{"input":2000,"output":4000,"total":6000}}
EOF

    run compare_sessions "session_a" "session_b"

    [ "$status" -eq 0 ]

    # Parse comparison
    a_total=$(echo "$output" | jq -r '.comparison.session_a.total_tokens')
    b_total=$(echo "$output" | jq -r '.comparison.session_b.total_tokens')
    difference=$(echo "$output" | jq -r '.difference')

    [ "$a_total" -eq 3000 ]
    [ "$b_total" -eq 6000 ]
    [ "$difference" -eq 3000 ]  # b - a = 6000 - 3000
}

@test "compare_sessions: calculates savings percentage" {
    cat > "$TOKEN_METRICS_FILE" << 'EOF'
{"session_id":"with_cleo","timestamp":"2026-01-31T10:00:00Z","event":"session_end","session_tokens":{"input":500,"output":1000,"total":1500}}
{"session_id":"without_cleo","timestamp":"2026-01-31T10:30:00Z","event":"session_end","session_tokens":{"input":1000,"output":2000,"total":3000}}
EOF

    run compare_sessions "with_cleo" "without_cleo"

    [ "$status" -eq 0 ]

    savings=$(echo "$output" | jq -r '.savings_percent')
    # (3000 - 1500) / 3000 * 100 = 50%
    [ "$savings" -eq 50 ]
}

@test "compare_sessions: identifies winner (session with fewer tokens)" {
    cat > "$TOKEN_METRICS_FILE" << 'EOF'
{"session_id":"efficient","timestamp":"2026-01-31T10:00:00Z","event":"session_end","session_tokens":{"total":1000}}
{"session_id":"wasteful","timestamp":"2026-01-31T10:30:00Z","event":"session_end","session_tokens":{"total":5000}}
EOF

    run compare_sessions "efficient" "wasteful"

    [ "$status" -eq 0 ]

    winner=$(echo "$output" | jq -r '.winner')
    [ "$winner" = "efficient" ]
}

@test "compare_sessions: provides verdict for significant savings" {
    cat > "$TOKEN_METRICS_FILE" << 'EOF'
{"session_id":"a","timestamp":"2026-01-31T10:00:00Z","event":"session_end","session_tokens":{"total":1000}}
{"session_id":"b","timestamp":"2026-01-31T10:30:00Z","event":"session_end","session_tokens":{"total":3000}}
EOF

    run compare_sessions "a" "b"

    [ "$status" -eq 0 ]

    verdict=$(echo "$output" | jq -r '.verdict')
    [[ "$verdict" == *"savings"* ]]
}

@test "compare_sessions: handles missing session" {
    cat > "$TOKEN_METRICS_FILE" << 'EOF'
{"session_id":"existing","timestamp":"2026-01-31T10:00:00Z","event":"session_end","session_tokens":{"total":1000}}
EOF

    run compare_sessions "existing" "nonexistent"

    [ "$status" -eq 1 ]
    [[ "$output" == *'"error":"One or both sessions not found"'* ]]
}

# =============================================================================
# parse_api_requests tests
# =============================================================================

@test "parse_api_requests: extracts per-request token data" {
    run parse_api_requests "${OTEL_METRICS_DIR}/sample.json"

    [ "$status" -eq 0 ]

    # Should have 2 API requests from fixture
    request_count=$(echo "$output" | wc -l)
    [ "$request_count" -eq 2 ]

    # Check first request
    first_request=$(echo "$output" | head -1)
    [[ "$first_request" == *'"input_tokens":1250'* ]]
    [[ "$first_request" == *'"output_tokens":3400'* ]]
}

@test "parse_api_requests: includes cache token data" {
    run parse_api_requests "${OTEL_METRICS_DIR}/sample.json"

    [ "$status" -eq 0 ]

    first_request=$(echo "$output" | head -1)
    [[ "$first_request" == *'"cache_read_tokens":500'* ]]
    [[ "$first_request" == *'"cache_creation_tokens":800'* ]]
}

# =============================================================================
# get_token_stats tests
# =============================================================================

@test "get_token_stats: calculates statistics from session data" {
    cat > "$TOKEN_METRICS_FILE" << 'EOF'
{"session_id":"s1","event":"session_end","session_tokens":{"total":1000}}
{"session_id":"s2","event":"session_end","session_tokens":{"total":2000}}
{"session_id":"s3","event":"session_end","session_tokens":{"total":3000}}
EOF

    run get_token_stats

    [ "$status" -eq 0 ]

    sessions=$(echo "$output" | jq -r '.sessions_tracked')
    avg=$(echo "$output" | jq -r '.avg_tokens_per_session')
    min=$(echo "$output" | jq -r '.min_tokens_session')
    max=$(echo "$output" | jq -r '.max_tokens_session')

    [ "$sessions" -eq 3 ]
    [ "$avg" -eq 2000 ]  # (1000 + 2000 + 3000) / 3
    [ "$min" -eq 1000 ]
    [ "$max" -eq 3000 ]
}

@test "get_token_stats: handles no metrics file" {
    # Remove token_metrics.jsonl
    rm -f "$TOKEN_METRICS_FILE"

    run get_token_stats

    [ "$status" -eq 0 ]
    [[ "$output" == *'"error":"No token metrics recorded"'* ]]
}

@test "get_token_stats: handles empty metrics file" {
    # Create empty file
    touch "$TOKEN_METRICS_FILE"

    run get_token_stats

    [ "$status" -eq 0 ]

    # Empty file returns default zero stats
    [[ "$output" == *'"sessions":0'* ]]
    [[ "$output" == *'"avg_tokens":0'* ]]
}

# =============================================================================
# Session tracking workflow tests
# =============================================================================

@test "record_session_start: creates session start entry" {
    run record_session_start "workflow_test"

    [ "$status" -eq 0 ]

    # Verify event field
    event=$(echo "$output" | jq -r '.event')
    [ "$event" = "session_start" ]

    # Verify it was written to file
    [ -f "$TOKEN_METRICS_FILE" ]
    grep -q "session_start" "$TOKEN_METRICS_FILE"
}

@test "record_session_end: creates session end entry with delta" {
    # Create start entry first
    record_session_start "delta_test" > /dev/null

    # Simulate some work by adding token data
    # (In real scenario, OTel would capture this)

    run record_session_end "delta_test"

    [ "$status" -eq 0 ]

    event=$(echo "$output" | jq -r '.event')
    [ "$event" = "session_end" ]
}

@test "integration: full session tracking workflow" {
    # Start session
    start_output=$(record_session_start "integration_test")
    [ "$(echo "$start_output" | jq -r '.event')" = "session_start" ]

    # End session
    end_output=$(record_session_end "integration_test")
    [ "$(echo "$end_output" | jq -r '.event')" = "session_end" ]

    # Verify both entries in file
    [ -f "$TOKEN_METRICS_FILE" ]

    start_count=$(grep -c "session_start" "$TOKEN_METRICS_FILE")
    end_count=$(grep -c "session_end" "$TOKEN_METRICS_FILE")

    [ "$start_count" -eq 1 ]
    [ "$end_count" -eq 1 ]
}
