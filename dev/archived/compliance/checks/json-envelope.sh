#!/usr/bin/env bash
# json-envelope.sh - Runtime JSON envelope structure validation
# Part of LLM-Agent-First Compliance Validator

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/test-helpers.sh"

# Test fixture directory (for commands that need state)
FIXTURE_DIR="${FIXTURE_DIR:-/tmp/claude-todo-compliance-test}"

# Commands that can run without any setup
STATELESS_COMMANDS=("help" "validate" "stats")

# Commands that need initialized project
NEEDS_INIT_COMMANDS=("list" "analyze" "blockers" "dash" "deps" "exists" "history" "labels" "log" "next" "phases" "show" "focus" "phase")

# Commands that modify state (need careful handling)
WRITE_COMMANDS=("add" "complete" "update" "archive" "session" "sync" "extract" "inject")

# Commands that need special handling
SPECIAL_COMMANDS=("backup" "restore" "init" "migrate" "migrate-backups" "export")

# Setup test fixture
# Usage: setup_fixture
setup_fixture() {
    rm -rf "$FIXTURE_DIR"
    mkdir -p "$FIXTURE_DIR/.claude"

    # Create minimal todo.json
    cat > "$FIXTURE_DIR/.claude/todo.json" << 'EOF'
{
  "$schema": "https://claude-todo.dev/schemas/v1/todo.schema.json",
  "_meta": {
    "version": "2.2.0",
    "created": "2025-12-18T00:00:00Z",
    "lastModified": "2025-12-18T00:00:00Z",
    "checksum": "test"
  },
  "project": {
    "name": "compliance-test",
    "description": "Test fixture for compliance checking",
    "currentPhase": "core"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Test task",
      "description": "A test task for compliance checking",
      "status": "pending",
      "priority": "medium",
      "created": "2025-12-18T00:00:00Z",
      "modified": "2025-12-18T00:00:00Z"
    }
  ]
}
EOF

    # Create minimal todo-log.jsonl
    cat > "$FIXTURE_DIR/.claude/todo-log.jsonl" << 'EOF'
{
  "$schema": "https://claude-todo.dev/schemas/v1/todo-log.schema.json",
  "_meta": {
    "version": "2.2.0",
    "created": "2025-12-18T00:00:00Z"
  },
  "entries": []
}
EOF

    # Create minimal config.json
    cat > "$FIXTURE_DIR/.claude/config.json" << 'EOF'
{
  "$schema": "https://claude-todo.dev/schemas/v1/config.schema.json",
  "_meta": {
    "version": "1.0.0",
    "created": "2025-12-18T00:00:00Z"
  }
}
EOF

    echo "$FIXTURE_DIR"
}

# Cleanup test fixture
cleanup_fixture() {
    rm -rf "$FIXTURE_DIR"
}

# Run a command and capture JSON output
# Usage: run_command <command> [args...]
run_command() {
    local cmd="$1"
    shift
    local args=("$@")

    local output
    local exit_code=0

    # Run in fixture directory for commands that need project context
    if [[ " ${NEEDS_INIT_COMMANDS[*]} " =~ " $cmd " ]]; then
        output=$(cd "$FIXTURE_DIR" && claude-todo "$cmd" "${args[@]}" --format json 2>&1) || exit_code=$?
    else
        output=$(claude-todo "$cmd" "${args[@]}" --format json 2>&1) || exit_code=$?
    fi

    # Return structured result
    jq -n \
        --arg cmd "$cmd" \
        --arg output "$output" \
        --argjson exit_code "$exit_code" \
        '{command: $cmd, output: $output, exit_code: $exit_code}'
}

# Check JSON envelope for a single command
# Usage: check_json_envelope <command_name> <schema_json> [verbose]
check_json_envelope() {
    local cmd="$1"
    local schema="$2"
    local verbose="${3:-false}"

    local results=()
    local passed=0
    local failed=0
    local skipped=0

    # Determine if we can run this command
    local can_run=true
    local skip_reason=""

    if [[ " ${WRITE_COMMANDS[*]} " =~ " $cmd " ]]; then
        can_run=false
        skip_reason="Write command (would modify state)"
    elif [[ " ${SPECIAL_COMMANDS[*]} " =~ " $cmd " ]]; then
        can_run=false
        skip_reason="Special handling required"
    fi

    if [[ "$can_run" == "false" ]]; then
        results+=('{"check": "runtime_test", "passed": true, "skipped": true, "details": "'"$skip_reason"'"}')
        ((skipped++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Runtime test: $skip_reason"

        # Return early with skipped result
        jq -n \
            --arg command "$cmd" \
            --argjson passed "$passed" \
            --argjson failed "$failed" \
            --argjson skipped "$skipped" \
            --argjson checks "$(printf '%s\n' "${results[@]}" | jq -s '.')" \
            '{
                command: $command,
                category: "json_envelope",
                passed: $passed,
                failed: $failed,
                skipped: $skipped,
                total: ($passed + $failed),
                score: 100,
                checks: $checks,
                runtime_tested: false
            }'
        return
    fi

    # Run the command
    local run_result
    local cmd_args=()

    # Add command-specific args
    case "$cmd" in
        exists)
            cmd_args=("T001")
            ;;
        show)
            cmd_args=("T001")
            ;;
        deps)
            cmd_args=("T001")
            ;;
        focus)
            cmd_args=("show")
            ;;
        phase)
            cmd_args=("show")
            ;;
    esac

    [[ "$verbose" == "true" ]] && echo -e "  ${DIM}Running: claude-todo $cmd ${cmd_args[*]} --format json${NC}" >&2

    run_result=$(run_command "$cmd" "${cmd_args[@]}" 2>/dev/null || echo '{"error": "command failed"}')

    local output
    output=$(echo "$run_result" | jq -r '.output' 2>/dev/null || echo "")
    local exit_code
    exit_code=$(echo "$run_result" | jq -r '.exit_code' 2>/dev/null || echo "1")

    # Try to parse as JSON
    if ! echo "$output" | jq . &>/dev/null; then
        results+=('{"check": "valid_json", "passed": false, "details": "Output is not valid JSON"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "Valid JSON output" "Output is not valid JSON"

        # Can't continue with other checks
        jq -n \
            --arg command "$cmd" \
            --argjson passed "$passed" \
            --argjson failed "$failed" \
            --argjson skipped "$skipped" \
            --argjson checks "$(printf '%s\n' "${results[@]}" | jq -s '.')" \
            '{
                command: $command,
                category: "json_envelope",
                passed: $passed,
                failed: $failed,
                skipped: $skipped,
                total: ($passed + $failed),
                score: (if ($passed + $failed) > 0 then ($passed * 100 / ($passed + $failed)) else 0 end),
                checks: $checks,
                runtime_tested: true,
                exit_code: '"$exit_code"'
            }'
        return
    fi

    results+=('{"check": "valid_json", "passed": true, "details": "Output is valid JSON"}')
    ((passed++)) || true
    [[ "$verbose" == "true" ]] && print_check pass "Valid JSON output"

    # Check 1: $schema field present
    local has_schema
    has_schema=$(echo "$output" | jq 'has("$schema")' 2>/dev/null || echo "false")

    if [[ "$has_schema" == "true" ]]; then
        local schema_value
        schema_value=$(echo "$output" | jq -r '.["$schema"]' 2>/dev/null || echo "")
        results+=('{"check": "schema_field", "passed": true, "details": "'"$schema_value"'"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "\$schema field present"
    else
        results+=('{"check": "schema_field", "passed": false, "details": "$schema field missing"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "\$schema field" "Missing from JSON output"
    fi

    # Check 2: _meta object present
    local has_meta
    has_meta=$(echo "$output" | jq 'has("_meta")' 2>/dev/null || echo "false")

    if [[ "$has_meta" == "true" ]]; then
        results+=('{"check": "meta_block", "passed": true, "details": "_meta object present"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "_meta block present"

        # Check _meta fields
        local meta_fields
        meta_fields=$(echo "$output" | jq '._meta | keys' 2>/dev/null || echo "[]")

        # Required: command, timestamp
        local has_command has_timestamp has_version has_format
        has_command=$(echo "$output" | jq '._meta | has("command")' 2>/dev/null || echo "false")
        has_timestamp=$(echo "$output" | jq '._meta | has("timestamp")' 2>/dev/null || echo "false")
        has_version=$(echo "$output" | jq '._meta | has("version")' 2>/dev/null || echo "false")
        has_format=$(echo "$output" | jq '._meta | has("format")' 2>/dev/null || echo "false")

        if [[ "$has_command" == "true" ]]; then
            results+=('{"check": "meta_command", "passed": true, "details": "_meta.command present"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "_meta.command"
        else
            results+=('{"check": "meta_command", "passed": false, "details": "_meta.command missing"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "_meta.command" "Missing"
        fi

        if [[ "$has_timestamp" == "true" ]]; then
            results+=('{"check": "meta_timestamp", "passed": true, "details": "_meta.timestamp present"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "_meta.timestamp"
        else
            results+=('{"check": "meta_timestamp", "passed": false, "details": "_meta.timestamp missing"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "_meta.timestamp" "Missing"
        fi

        if [[ "$has_version" == "true" ]]; then
            results+=('{"check": "meta_version", "passed": true, "details": "_meta.version present"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "_meta.version"
        else
            results+=('{"check": "meta_version", "passed": false, "details": "_meta.version missing"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "_meta.version" "Missing"
        fi

        if [[ "$has_format" == "true" ]]; then
            results+=('{"check": "meta_format", "passed": true, "details": "_meta.format present"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "_meta.format"
        else
            results+=('{"check": "meta_format", "passed": false, "details": "_meta.format missing"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "_meta.format" "Missing"
        fi
    else
        results+=('{"check": "meta_block", "passed": false, "details": "_meta object missing"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "_meta block" "Missing from JSON output"

        # Mark all _meta field checks as failed
        for field in command timestamp version format; do
            results+=('{"check": "meta_'"$field"'", "passed": false, "details": "_meta.'"$field"' missing (no _meta block)"}')
            ((failed++)) || true
        done
    fi

    # Check 3: success field present
    local has_success
    has_success=$(echo "$output" | jq 'has("success")' 2>/dev/null || echo "false")

    if [[ "$has_success" == "true" ]]; then
        local success_value
        success_value=$(echo "$output" | jq -r '.success' 2>/dev/null || echo "")
        results+=('{"check": "success_field", "passed": true, "details": "success: '"$success_value"'"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "success field (=$success_value)"
    else
        results+=('{"check": "success_field", "passed": false, "details": "success field missing"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "success field" "Missing from JSON output"
    fi

    # Build JSON result
    local total=$((passed + failed))
    local score
    score=$(calc_score "$passed" "$total")

    jq -n \
        --arg command "$cmd" \
        --argjson passed "$passed" \
        --argjson failed "$failed" \
        --argjson skipped "$skipped" \
        --argjson total "$total" \
        --arg score "$score" \
        --argjson exit_code "$exit_code" \
        --argjson checks "$(printf '%s\n' "${results[@]}" | jq -s '.')" \
        '{
            command: $command,
            category: "json_envelope",
            passed: $passed,
            failed: $failed,
            skipped: $skipped,
            total: $total,
            score: ($score | tonumber),
            checks: $checks,
            runtime_tested: true,
            exit_code: $exit_code
        }'
}

# Check all commands for JSON envelope compliance
# Usage: check_all_json_envelope <schema_json> [verbose]
check_all_json_envelope() {
    local schema="$1"
    local verbose="${2:-false}"

    # Setup fixture
    [[ "$verbose" == "true" ]] && echo -e "\n${DIM}Setting up test fixture...${NC}" >&2
    setup_fixture >/dev/null

    local all_results=()
    local commands
    commands=$(list_all_commands "$schema")

    for cmd in $commands; do
        [[ "$verbose" == "true" ]] && echo -e "\n${BOLD}[$cmd]${NC}" >&2
        local result
        result=$(check_json_envelope "$cmd" "$schema" "$verbose")
        all_results+=("$result")
    done

    # Cleanup
    cleanup_fixture

    printf '%s\n' "${all_results[@]}" | jq -s '.'
}

# Main entry point when run directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    if [[ $# -lt 1 ]]; then
        echo "Usage: $0 <schema_path> [command_name] [--verbose]"
        echo ""
        echo "Examples:"
        echo "  $0 ../schema.json                    # Test all commands"
        echo "  $0 ../schema.json list --verbose     # Test specific command"
        exit 1
    fi

    schema_path="$1"
    command_name="${2:-}"
    verbose="false"

    # Check for --verbose in args
    for arg in "$@"; do
        [[ "$arg" == "--verbose" ]] && verbose="true"
    done

    # Remove --verbose from command_name if it was captured there
    [[ "$command_name" == "--verbose" ]] && command_name=""

    schema=$(load_schema "$schema_path")

    if [[ -n "$command_name" ]]; then
        # Setup fixture for single command test
        setup_fixture >/dev/null
        check_json_envelope "$command_name" "$schema" "$verbose"
        cleanup_fixture
    else
        check_all_json_envelope "$schema" "$verbose"
    fi
fi
