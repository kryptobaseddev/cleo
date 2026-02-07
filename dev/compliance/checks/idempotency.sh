#!/usr/bin/env bash
# idempotency.sh - Check idempotency compliance
# Part of LLM-Agent-First Compliance Validator
#
# Validates Part 5.6 (Idempotency Requirements) from LLM-Agent-First Spec v3.0
#
# Command Idempotency Matrix:
#   MUST-idempotent: update, complete, archive, restore, phase
#   SHOULD-idempotent: add (duplicate detection within 60s window)
#
# EXIT_NO_CHANGE (102) Semantics:
#   - Exit code 102 indicates no changes needed
#   - JSON output includes "noChange": true
#   - Agents should treat as success, not retry

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/test-helpers.sh"

# Define idempotent command categories
# MUST = Required by spec, SHOULD = Recommended
declare -a MUST_IDEMPOTENT=("update.sh" "complete.sh" "archive.sh" "restore.sh" "phase.sh")
declare -a SHOULD_IDEMPOTENT=("add.sh")

# Check idempotency compliance for a script file
# Usage: check_idempotency <script_path> <schema_json> [verbose]
check_idempotency() {
    local script="$1"
    local schema="$2"
    local verbose="${3:-false}"
    local script_name
    script_name=$(basename "$script")

    local results=()
    local passed=0
    local failed=0
    local warnings=0
    local skipped=0

    # Determine idempotency requirement level for this script
    local idempotency_level="none"
    for must_cmd in "${MUST_IDEMPOTENT[@]}"; do
        if [[ "$script_name" == "$must_cmd" ]]; then
            idempotency_level="must"
            break
        fi
    done
    if [[ "$idempotency_level" == "none" ]]; then
        for should_cmd in "${SHOULD_IDEMPOTENT[@]}"; do
            if [[ "$script_name" == "$should_cmd" ]]; then
                idempotency_level="should"
                break
            fi
        done
    fi

    # Check 1: EXIT_NO_CHANGE constant reference (MUST-idempotent only)
    if [[ "$idempotency_level" == "must" ]]; then
        local no_change_count
        no_change_count=$(pattern_count "$script" "EXIT_NO_CHANGE" || echo "0")

        if [[ "$no_change_count" -gt 0 ]]; then
            results+=('{"check": "exit_no_change_usage", "passed": true, "details": "Uses EXIT_NO_CHANGE constant ('"$no_change_count"' references)"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "EXIT_NO_CHANGE usage ($no_change_count refs)"
        else
            results+=('{"check": "exit_no_change_usage", "passed": false, "details": "MUST-idempotent command missing EXIT_NO_CHANGE (exit code 102)"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "EXIT_NO_CHANGE missing" "MUST-idempotent commands require exit code 102 for no-op results"
        fi
    elif [[ "$idempotency_level" == "should" ]]; then
        # SHOULD-idempotent: warn if missing
        local no_change_count
        no_change_count=$(pattern_count "$script" "EXIT_NO_CHANGE" || echo "0")

        if [[ "$no_change_count" -gt 0 ]]; then
            results+=('{"check": "exit_no_change_usage", "passed": true, "details": "Uses EXIT_NO_CHANGE constant ('"$no_change_count"' references)"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "EXIT_NO_CHANGE usage ($no_change_count refs)"
        else
            results+=('{"check": "exit_no_change_usage", "passed": true, "warning": true, "details": "SHOULD-idempotent command without EXIT_NO_CHANGE (recommended)"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "EXIT_NO_CHANGE" "SHOULD-idempotent commands should return 102 for duplicates"
        fi
    else
        results+=('{"check": "exit_no_change_usage", "passed": true, "skipped": true, "details": "Not an idempotent command"}')
        ((skipped++)) || true
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "EXIT_NO_CHANGE (not idempotent command)"
    fi

    # Check 2: noChange JSON field output (MUST-idempotent only)
    if [[ "$idempotency_level" == "must" ]]; then
        local no_change_json_patterns=("noChange.*true" '"noChange"' "no_change.*true")
        local has_no_change_json=false

        for pattern in "${no_change_json_patterns[@]}"; do
            if pattern_exists "$script" "$pattern"; then
                has_no_change_json=true
                break
            fi
        done

        if [[ "$has_no_change_json" == "true" ]]; then
            results+=('{"check": "no_change_json_field", "passed": true, "details": "Provides noChange JSON field when returning EXIT_NO_CHANGE"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "noChange JSON field present"
        else
            # Check if EXIT_NO_CHANGE is used but no JSON field
            local no_change_count
            no_change_count=$(pattern_count "$script" "EXIT_NO_CHANGE" || echo "0")

            if [[ "$no_change_count" -gt 0 ]]; then
                results+=('{"check": "no_change_json_field", "passed": false, "details": "Uses EXIT_NO_CHANGE but missing noChange JSON field"}')
                ((failed++)) || true
                [[ "$verbose" == "true" ]] && print_check fail "noChange JSON field" "Add \"noChange\": true to JSON output when returning 102"
            else
                results+=('{"check": "no_change_json_field", "passed": true, "skipped": true, "details": "No EXIT_NO_CHANGE usage found"}')
                ((skipped++)) || true
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check skip "noChange JSON field (no EXIT_NO_CHANGE)"
            fi
        fi
    else
        results+=('{"check": "no_change_json_field", "passed": true, "skipped": true, "details": "Not a MUST-idempotent command"}')
        ((skipped++)) || true
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "noChange JSON field (not MUST-idempotent)"
    fi

    # Check 3: Update command - detect no-change scenarios
    if [[ "$script_name" == "update.sh" ]]; then
        local has_no_change_detection=false

        # Patterns indicating no-change detection:
        # - Comparison of old vs new values
        # - "no.*changes" pattern
        # - identical value detection
        local update_patterns=("no.*changes" "identical" "same.*value" "already.*set" "unchanged")

        for pattern in "${update_patterns[@]}"; do
            if pattern_exists "$script" "$pattern"; then
                has_no_change_detection=true
                break
            fi
        done

        # Also check for value comparison patterns
        if pattern_exists "$script" 'old_.*new_\|current_.*new_\|existing_.*!='; then
            has_no_change_detection=true
        fi

        # Check for dry-run no-op path
        if pattern_exists "$script" 'dry.*run.*no.*change\|DRY_RUN.*102\|dry.*run.*EXIT_NO_CHANGE'; then
            has_no_change_detection=true
        fi

        if [[ "$has_no_change_detection" == "true" ]]; then
            results+=('{"check": "update_no_change_detection", "passed": true, "details": "Update command detects when no changes are needed"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Update no-change detection"
        else
            results+=('{"check": "update_no_change_detection", "passed": false, "details": "Update command should detect when update would make no changes"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Update no-change detection" "Should return EXIT_NO_CHANGE when updating with identical values"
        fi
    elif [[ "$idempotency_level" == "must" || "$idempotency_level" == "should" ]]; then
        results+=('{"check": "update_no_change_detection", "passed": true, "skipped": true, "details": "Not update command"}')
        ((skipped++)) || true
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Update no-change detection (not update command)"
    fi

    # Check 4: Complete command - handles already-done status
    if [[ "$script_name" == "complete.sh" ]]; then
        local has_already_done_check=false

        # Patterns indicating already-done handling
        local done_patterns=("already.*complet" "already.*done" "status.*done" "alreadyCompleted")

        for pattern in "${done_patterns[@]}"; do
            if pattern_exists "$script" "$pattern"; then
                has_already_done_check=true
                break
            fi
        done

        if [[ "$has_already_done_check" == "true" ]]; then
            results+=('{"check": "complete_already_done", "passed": true, "details": "Complete command handles already-done tasks"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Complete already-done handling"
        else
            results+=('{"check": "complete_already_done", "passed": false, "details": "Complete command should check if task is already done and return EXIT_NO_CHANGE"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Complete already-done handling" "Should return EXIT_NO_CHANGE when task is already completed"
        fi
    elif [[ "$idempotency_level" == "must" || "$idempotency_level" == "should" ]]; then
        results+=('{"check": "complete_already_done", "passed": true, "skipped": true, "details": "Not complete command"}')
        ((skipped++)) || true
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Complete already-done handling (not complete command)"
    fi

    # Check 5: Archive command - handles already-archived
    if [[ "$script_name" == "archive.sh" ]]; then
        local has_already_archived_check=false

        # Patterns indicating already-archived handling
        local archive_patterns=("already.*archiv" "not.*found.*todo" "no.*tasks.*archive" "archive.*empty")

        for pattern in "${archive_patterns[@]}"; do
            if pattern_exists "$script" "$pattern"; then
                has_already_archived_check=true
                break
            fi
        done

        # Also check for task existence validation in archive
        if pattern_exists "$script" 'todo.*archive.*check\|task.*exists'; then
            has_already_archived_check=true
        fi

        if [[ "$has_already_archived_check" == "true" ]]; then
            results+=('{"check": "archive_idempotent", "passed": true, "details": "Archive command handles already-archived or empty scenarios"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Archive idempotent handling"
        else
            results+=('{"check": "archive_idempotent", "passed": false, "details": "Archive command should handle re-archiving as no-op with EXIT_NO_CHANGE"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Archive idempotent" "Should return EXIT_NO_CHANGE when re-archiving already-archived task"
        fi
    elif [[ "$idempotency_level" == "must" || "$idempotency_level" == "should" ]]; then
        results+=('{"check": "archive_idempotent", "passed": true, "skipped": true, "details": "Not archive command"}')
        ((skipped++)) || true
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Archive idempotent (not archive command)"
    fi

    # Check 6: Restore command - handles already-active
    if [[ "$script_name" == "restore.sh" ]]; then
        local has_already_active_check=false

        # Patterns indicating already-active handling
        local restore_patterns=("already.*active" "already.*in.*todo" "not.*in.*archive" "task.*exists.*todo")

        for pattern in "${restore_patterns[@]}"; do
            if pattern_exists "$script" "$pattern"; then
                has_already_active_check=true
                break
            fi
        done

        if [[ "$has_already_active_check" == "true" ]]; then
            results+=('{"check": "restore_idempotent", "passed": true, "details": "Restore command handles already-active scenarios"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Restore idempotent handling"
        else
            results+=('{"check": "restore_idempotent", "passed": false, "details": "Restore command should return EXIT_NO_CHANGE when task is already in todo.json"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Restore idempotent" "Should return EXIT_NO_CHANGE when restoring already-active task"
        fi
    elif [[ "$idempotency_level" == "must" || "$idempotency_level" == "should" ]]; then
        results+=('{"check": "restore_idempotent", "passed": true, "skipped": true, "details": "Not restore command"}')
        ((skipped++)) || true
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Restore idempotent (not restore command)"
    fi

    # Check 7: Add command - duplicate detection (SHOULD)
    if [[ "$script_name" == "add.sh" ]]; then
        local has_duplicate_detection=false

        # Patterns indicating duplicate detection
        local add_patterns=("duplicate" "same.*title" "title.*exists" "already.*exists")

        for pattern in "${add_patterns[@]}"; do
            if pattern_exists "$script" "$pattern"; then
                has_duplicate_detection=true
                break
            fi
        done

        if [[ "$has_duplicate_detection" == "true" ]]; then
            # Check for time-window duplicate detection (60s)
            local has_time_window=false
            if pattern_exists "$script" "60\|window\|recent"; then
                has_time_window=true
            fi

            if [[ "$has_time_window" == "true" ]]; then
                results+=('{"check": "add_duplicate_detection", "passed": true, "details": "Add command has time-windowed duplicate detection"}')
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check pass "Add duplicate detection (with time window)"
            else
                results+=('{"check": "add_duplicate_detection", "passed": true, "warning": true, "details": "Add command has basic duplicate detection (60s window recommended)"}')
                ((warnings++)) || true
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check warn "Add duplicate detection" "Consider adding 60s time window for duplicates"
            fi
        else
            results+=('{"check": "add_duplicate_detection", "passed": false, "warning": true, "details": "Add command SHOULD detect duplicate title+phase within 60s window"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Add duplicate detection" "SHOULD detect duplicate title+phase within 60s"
        fi
    elif [[ "$idempotency_level" == "must" || "$idempotency_level" == "should" ]]; then
        results+=('{"check": "add_duplicate_detection", "passed": true, "skipped": true, "details": "Not add command"}')
        ((skipped++)) || true
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Add duplicate detection (not add command)"
    fi

    # Check 8: Phase command idempotency (MUST)
    if [[ "$script_name" == "phase.sh" ]]; then
        local has_phase_idempotency=false

        # Patterns indicating phase idempotency
        local phase_patterns=("already.*phase" "same.*phase" "current.*phase" "EXIT_NO_CHANGE")

        for pattern in "${phase_patterns[@]}"; do
            if pattern_exists "$script" "$pattern"; then
                has_phase_idempotency=true
                break
            fi
        done

        if [[ "$has_phase_idempotency" == "true" ]]; then
            results+=('{"check": "phase_idempotent", "passed": true, "details": "Phase command handles same-phase setting as no-op"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Phase idempotent handling"
        else
            results+=('{"check": "phase_idempotent", "passed": false, "details": "Phase command should return EXIT_NO_CHANGE when setting to current phase"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Phase idempotent" "Should return EXIT_NO_CHANGE when phase is already set"
        fi
    elif [[ "$idempotency_level" == "must" || "$idempotency_level" == "should" ]]; then
        results+=('{"check": "phase_idempotent", "passed": true, "skipped": true, "details": "Not phase command"}')
        ((skipped++)) || true
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Phase idempotent (not phase command)"
    fi

    # Check 9: Verify EXIT_NO_CHANGE is used with success semantics
    if [[ "$idempotency_level" != "none" ]]; then
        local no_change_count
        no_change_count=$(pattern_count "$script" "EXIT_NO_CHANGE" || echo "0")

        if [[ "$no_change_count" -gt 0 ]]; then
            # Check that EXIT_NO_CHANGE is not used after output_error
            local misuse_pattern
            misuse_pattern=$(awk '
                /output_error/ { error_line = NR }
                /EXIT_NO_CHANGE/ {
                    if (error_line > 0 && NR - error_line <= 5) {
                        print NR ":" $0
                        error_line = 0
                    }
                }
            ' "$script" 2>/dev/null || true)

            if [[ -z "$misuse_pattern" ]]; then
                results+=('{"check": "exit_no_change_semantics", "passed": true, "details": "EXIT_NO_CHANGE used correctly (not as error indicator)"}')
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check pass "EXIT_NO_CHANGE semantics (success, not error)"
            else
                local misuse_lines
                misuse_lines=$(echo "$misuse_pattern" | cut -d: -f1 | head -3 | tr '\n' ',' | sed 's/,$//')
                results+=('{"check": "exit_no_change_semantics", "passed": false, "details": "EXIT_NO_CHANGE used after error output on lines: '"$misuse_lines"'"}')
                ((failed++)) || true
                [[ "$verbose" == "true" ]] && print_check fail "EXIT_NO_CHANGE semantics" "Should not be used after output_error (it indicates success)"
            fi
        else
            results+=('{"check": "exit_no_change_semantics", "passed": true, "skipped": true, "details": "No EXIT_NO_CHANGE usage to verify"}')
            ((skipped++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check skip "EXIT_NO_CHANGE semantics (not used)"
        fi
    else
        results+=('{"check": "exit_no_change_semantics", "passed": true, "skipped": true, "details": "Not an idempotent command"}')
        ((skipped++)) || true
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "EXIT_NO_CHANGE semantics (not idempotent)"
    fi

    # Check 10: Verify reason field in noChange JSON output
    if [[ "$idempotency_level" == "must" ]]; then
        local no_change_count
        no_change_count=$(pattern_count "$script" "EXIT_NO_CHANGE" || echo "0")

        if [[ "$no_change_count" -gt 0 ]]; then
            if pattern_exists "$script" '"reason"'; then
                results+=('{"check": "no_change_reason_field", "passed": true, "details": "Provides reason field in noChange JSON output"}')
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check pass "noChange reason field present"
            else
                results+=('{"check": "no_change_reason_field", "passed": true, "warning": true, "details": "Consider adding \"reason\" field to explain why no change occurred"}')
                ((warnings++)) || true
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check warn "noChange reason field" "Consider adding reason for agent debugging"
            fi
        else
            results+=('{"check": "no_change_reason_field", "passed": true, "skipped": true, "details": "No EXIT_NO_CHANGE usage found"}')
            ((skipped++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check skip "noChange reason field (no EXIT_NO_CHANGE)"
        fi
    else
        results+=('{"check": "no_change_reason_field", "passed": true, "skipped": true, "details": "Not a MUST-idempotent command"}')
        ((skipped++)) || true
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "noChange reason field (not MUST-idempotent)"
    fi

    # Build JSON result
    local total=$((passed + failed))
    local score
    score=$(calc_score "$passed" "$total")

    jq -n \
        --arg script "$script_name" \
        --arg idempotency_level "$idempotency_level" \
        --argjson passed "$passed" \
        --argjson failed "$failed" \
        --argjson warnings "$warnings" \
        --argjson skipped "$skipped" \
        --argjson total "$total" \
        --arg score "$score" \
        --argjson checks "$(printf '%s\n' "${results[@]}" | jq -s '.')" \
        '{
            script: $script,
            category: "idempotency",
            idempotency_level: $idempotency_level,
            passed: $passed,
            failed: $failed,
            warnings: $warnings,
            skipped: $skipped,
            total: $total,
            score: ($score | tonumber),
            checks: $checks
        }'
}

# Run check on all scripts in directory
# Usage: check_all_idempotency <scripts_dir> <schema_json> [verbose]
check_all_idempotency() {
    local scripts_dir="$1"
    local schema="$2"
    local verbose="${3:-false}"

    local all_results=()

    for script in "$scripts_dir"/*.sh; do
        [[ -f "$script" ]] || continue
        local result
        result=$(check_idempotency "$script" "$schema" "$verbose")
        all_results+=("$result")
    done

    printf '%s\n' "${all_results[@]}" | jq -s '.'
}

# Get summary of idempotent commands
# Usage: get_idempotency_summary
get_idempotency_summary() {
    cat <<EOF
{
    "must_idempotent": $(printf '%s\n' "${MUST_IDEMPOTENT[@]}" | jq -R . | jq -s .),
    "should_idempotent": $(printf '%s\n' "${SHOULD_IDEMPOTENT[@]}" | jq -R . | jq -s .),
    "exit_no_change": {
        "code": 102,
        "semantics": "success, no state change",
        "agent_behavior": "treat as success, do not retry"
    },
    "json_output": {
        "required_fields": ["success", "noChange"],
        "recommended_fields": ["reason", "message"]
    }
}
EOF
}

# Main entry point when run directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    if [[ $# -lt 1 ]]; then
        echo "Usage: $0 <script_path> [schema_path] [--verbose] [--summary]"
        echo ""
        echo "Options:"
        echo "  --summary    Show idempotency command summary instead of checking"
        echo "  --verbose    Show detailed check output"
        exit 1
    fi

    # Check for summary flag
    if [[ "$1" == "--summary" ]]; then
        get_idempotency_summary
        exit 0
    fi

    script_path="$1"
    schema_path="${2:-}"
    verbose="false"

    # Parse optional args
    for arg in "${@:2}"; do
        case "$arg" in
            --verbose) verbose="true" ;;
            --summary) get_idempotency_summary; exit 0 ;;
        esac
    done

    # Load schema if provided, otherwise use minimal defaults
    if [[ -n "$schema_path" ]] && [[ -f "$schema_path" ]]; then
        schema=$(load_schema "$schema_path")
    else
        schema='{}'
    fi

    check_idempotency "$script_path" "$schema" "$verbose"
fi
