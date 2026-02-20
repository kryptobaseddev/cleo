#!/usr/bin/env bash
# exit-codes.sh - Check exit code usage compliance
# Part of LLM-Agent-First Compliance Validator

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/test-helpers.sh"

# Check exit code compliance for a script file
# Usage: check_exit_codes <script_path> <schema_json> [verbose]
check_exit_codes() {
    local script="$1"
    local schema="$2"
    local verbose="${3:-false}"
    local script_name
    script_name=$(basename "$script")

    local results=()
    local passed=0
    local failed=0
    local warnings=0

    # Special case: exit-codes.sh is the library that DEFINES constants, not uses them
    # It should pass if it defines EXIT_* constants properly
    if [[ "$script_name" == "exit-codes.sh" ]]; then
        # Check that EXIT_* constants are defined with readonly
        local defined_constants
        defined_constants=$(grep -cE '^readonly EXIT_[A-Z_]+=' "$script" 2>/dev/null || echo "0")

        if [[ "$defined_constants" -gt 0 ]]; then
            results+=('{"check": "exit_constants_defined", "passed": true, "details": "Defines '"$defined_constants"' EXIT_* constants with readonly"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "EXIT_* constants defined ($defined_constants)"
        else
            results+=('{"check": "exit_constants_defined", "passed": false, "details": "Library should define EXIT_* constants"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "EXIT_* constants" "Library should define constants"
        fi

        # Check EXIT_NO_CHANGE specifically (required for idempotency)
        if grep -qE '^readonly EXIT_NO_CHANGE=' "$script" 2>/dev/null; then
            results+=('{"check": "exit_no_change_defined", "passed": true, "details": "EXIT_NO_CHANGE constant defined for idempotency"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "EXIT_NO_CHANGE defined"
        else
            results+=('{"check": "exit_no_change_defined", "passed": false, "details": "EXIT_NO_CHANGE (102) not defined"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "EXIT_NO_CHANGE" "Required for idempotency support"
        fi

        # Check that constants are exported
        local exported_count
        exported_count=$(grep -cE '^export EXIT_[A-Z_]+' "$script" 2>/dev/null || echo "0")

        if [[ "$exported_count" -gt 0 ]]; then
            results+=('{"check": "exit_constants_exported", "passed": true, "details": "'"$exported_count"' EXIT_* constants exported"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "EXIT_* constants exported ($exported_count)"
        else
            results+=('{"check": "exit_constants_exported", "passed": true, "warning": true, "details": "No EXIT_* constants exported (may use sourcing only)"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "EXIT_* exports" "Consider exporting for subprocess use"
        fi

        # Check helper functions exist
        if grep -qE 'get_exit_code_name|is_success_code|is_no_change_code' "$script" 2>/dev/null; then
            results+=('{"check": "exit_helper_functions", "passed": true, "details": "Exit code helper functions defined"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Exit code helper functions"
        else
            results+=('{"check": "exit_helper_functions", "passed": true, "warning": true, "details": "No exit code helper functions found"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Helper functions" "Consider adding get_exit_code_name()"
        fi

        # Build JSON result for library file
        local total=$((passed + failed))
        local score
        score=$(calc_score "$passed" "$total")

        jq -n \
            --arg script "$script_name" \
            --argjson passed "$passed" \
            --argjson failed "$failed" \
            --argjson warnings "$warnings" \
            --argjson total "$total" \
            --arg score "$score" \
            --argjson checks "$(printf '%s\n' "${results[@]}" | jq -s '.')" \
            '{
                script: $script,
                category: "exit_codes",
                passed: $passed,
                failed: $failed,
                warnings: $warnings,
                total: $total,
                score: ($score | tonumber),
                checks: $checks,
                isLibrary: true
            }'
        return 0
    fi

    # Check 1: Uses EXIT_* constants
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local exit_pattern
    exit_pattern="${PATTERN_EXIT_CONSTANTS:-$(echo "$schema" | jq -r '.requirements.exit_codes.pattern')}"

    local exit_constant_count
    exit_constant_count=$(pattern_count "$script" "$exit_pattern")

    if [[ "$exit_constant_count" -gt 0 ]]; then
        results+=('{"check": "exit_constants", "passed": true, "details": "Uses EXIT_* constants ('"$exit_constant_count"' occurrences)"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "Exit code constants ($exit_constant_count uses)"
    else
        # Check if there are any exit statements at all
        local any_exits
        any_exits=$(pattern_count "$script" "exit " || echo "0")

        if [[ "$any_exits" -eq 0 ]]; then
            results+=('{"check": "exit_constants", "passed": true, "skipped": true, "details": "No exit statements found (may use implicit exit)"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check info "No explicit exit statements"
        else
            results+=('{"check": "exit_constants", "passed": false, "details": "Has '"$any_exits"' exit statements but no EXIT_* constants"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Exit constants" "Found $any_exits exits without EXIT_* constants"
        fi
    fi

    # Check 2: No magic numbers (exit 0, exit 1, etc.)
    # Pattern: exit followed by a digit, but not inside ${...}
    local forbidden_pattern='exit [0-9]+[^}]|exit [0-9]+$'

    # Get exit constant pattern from schema to exclude valid constant usage
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local const_pattern
    const_pattern="${PATTERN_EXIT_CONSTANTS:-$(echo "$schema" | jq -r '.requirements.exit_codes.pattern // "exit \\$EXIT_|exit \\$\\{EXIT_"')}"
    # Convert pattern for grep (remove backslash escaping for jq)
    local grep_exclude_pattern
    grep_exclude_pattern=$(echo "$const_pattern" | sed 's/\\\\\\$/\\$/g' | sed 's/|/\\|/g')

    # Filter out heredoc content (lines between <<EOF and EOF markers contain example code)
    # Also exclude comment lines and valid constant usage
    local magic_exits
    magic_exits=$(awk '
        /<<.*EOF/ || /<<.*END/ { in_heredoc = 1; next }
        /^EOF$/ || /^END$/ || /^[[:space:]]*EOF$/ || /^[[:space:]]*END$/ { in_heredoc = 0; next }
        in_heredoc { next }
        /exit [0-9]/ { print NR ":" $0 }
    ' "$script" 2>/dev/null | grep -vE "$grep_exclude_pattern|#.*exit [0-9]" || true)

    if [[ -z "$magic_exits" ]]; then
        results+=('{"check": "no_magic_numbers", "passed": true, "details": "No magic exit numbers found"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "No magic exit numbers"
    else
        local magic_count
        magic_count=$(echo "$magic_exits" | wc -l | tr -d ' ')

        # Check if they're all exit 0 (which is sometimes acceptable)
        local non_zero_magic
        non_zero_magic=$(echo "$magic_exits" | grep -vE 'exit 0' || true)

        if [[ -z "$non_zero_magic" ]]; then
            results+=('{"check": "no_magic_numbers", "passed": true, "warning": true, "details": "Uses exit 0 directly ('"$magic_count"' occurrences) - acceptable but consider EXIT_SUCCESS"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Exit 0 used directly ($magic_count times)" "Consider using EXIT_SUCCESS"
        else
            local lines
            lines=$(echo "$magic_exits" | cut -d: -f1 | head -5 | tr '\n' ',' | sed 's/,$//')
            results+=('{"check": "no_magic_numbers", "passed": false, "details": "Magic exit numbers found on lines: '"$lines"'"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Magic exit numbers" "Found on lines: $lines"
        fi
    fi

    # Check 3: Exit code library sourced (uses schema pattern if available)
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local exit_lib_pattern
    exit_lib_pattern="${PATTERN_EXIT_LIB:-$(echo "$schema" | jq -r '.requirements.exit_codes.exit_lib_pattern // "exit-codes\\.sh"')}"
    local exit_lib_name
    exit_lib_name=$(echo "$schema" | jq -r '.requirements.exit_codes.exit_lib_name // "exit-codes.sh"')

    if pattern_exists "$script" "source.*$exit_lib_pattern"; then
        results+=('{"check": "exit_lib_sourced", "passed": true, "details": "'"$exit_lib_name"' library sourced"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "$exit_lib_name sourced"
    else
        results+=('{"check": "exit_lib_sourced", "passed": false, "details": "'"$exit_lib_name"' library not sourced"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "$exit_lib_name" "Library not sourced"
    fi

    # Check 4: Consistent exit code usage (all exits use constants or none do)
    local total_exits
    total_exits=$(pattern_count "$script" "exit " || echo "0")

    # Determine if this is an idempotent command that should use EXIT_NO_CHANGE
    local idempotent_commands=("update.sh" "complete.sh" "archive.sh" "restore.sh" "phase.sh")
    local is_idempotent=false
    for idem_cmd in "${idempotent_commands[@]}"; do
        if [[ "$script_name" == "$idem_cmd" ]]; then
            is_idempotent=true
            break
        fi
    done

    if [[ "$total_exits" -gt 0 ]]; then
        # Use schema pattern for counting constant exits
        # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
        local const_pattern_grep
        const_pattern_grep="${PATTERN_EXIT_CONSTANTS:-$(echo "$schema" | jq -r '.requirements.exit_codes.pattern // "exit \\$EXIT_|\\$\\{EXIT_"')}"
        const_pattern_grep=$(echo "$const_pattern_grep" | sed 's/\\\\\\$/\\$/g')
        local const_exits
        const_exits=$(pattern_count "$script" "$const_pattern_grep" || echo "0")

        local ratio
        if [[ "$total_exits" -gt 0 ]]; then
            ratio=$(awk "BEGIN {printf \"%.0f\", $const_exits * 100 / $total_exits}")
        else
            ratio=100
        fi

        if [[ "$ratio" -ge 90 ]]; then
            results+=('{"check": "consistent_usage", "passed": true, "details": "'"$ratio"'% of exits use constants ('"$const_exits"'/'"$total_exits"')"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Consistent exit code usage ($ratio%)"
        elif [[ "$ratio" -ge 50 ]]; then
            results+=('{"check": "consistent_usage", "passed": true, "warning": true, "details": "'"$ratio"'% use constants - consider improving ('"$const_exits"'/'"$total_exits"')"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Partial constant usage ($ratio%)" "Consider improving consistency"
        else
            results+=('{"check": "consistent_usage", "passed": false, "details": "Only '"$ratio"'% use constants ('"$const_exits"'/'"$total_exits"')"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Inconsistent exit usage" "Only $ratio% use constants"
        fi
    else
        results+=('{"check": "consistent_usage", "passed": true, "skipped": true, "details": "No exit statements to check"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Consistency check (no exits)"
    fi

    # Check 5: Idempotent commands should reference EXIT_NO_CHANGE
    # Only applicable to commands that can have no-op results
    if [[ "$is_idempotent" == "true" ]]; then
        local no_change_count
        no_change_count=$(pattern_count "$script" "EXIT_NO_CHANGE" || echo "0")

        if [[ "$no_change_count" -gt 0 ]]; then
            results+=('{"check": "idempotent_no_change", "passed": true, "details": "Uses EXIT_NO_CHANGE for idempotent operations ('"$no_change_count"' references)"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "EXIT_NO_CHANGE usage ($no_change_count references)"
        else
            results+=('{"check": "idempotent_no_change", "passed": false, "details": "Idempotent command should use EXIT_NO_CHANGE (exit code 102) for no-op results"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Missing EXIT_NO_CHANGE" "Idempotent commands should return 102 when no changes made"
        fi

        # Check 6: EXIT_NO_CHANGE should be paired with noChange JSON field
        # Look for patterns that indicate proper JSON output when returning 102
        local no_change_json_patterns=("noChange.*true" "\"noChange\"" "no_change.*true")
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
        elif [[ "$no_change_count" -gt 0 ]]; then
            # Only warn if EXIT_NO_CHANGE is used but no JSON field found
            results+=('{"check": "no_change_json_field", "passed": true, "warning": true, "details": "Uses EXIT_NO_CHANGE but noChange JSON field not detected (may be in output library)"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "noChange JSON field" "Consider adding \"noChange\": true to JSON output when 102 is returned"
        else
            results+=('{"check": "no_change_json_field", "passed": true, "skipped": true, "details": "No EXIT_NO_CHANGE usage found to pair with JSON field"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check skip "noChange JSON field check (no EXIT_NO_CHANGE usage)"
        fi
    fi

    # Check 7: Special exit codes (100+) should not be used as errors
    # These are informational states, not failures
    local special_code_misuse=false
    local special_exit_pattern="EXIT_NO_DATA|EXIT_ALREADY_EXISTS|EXIT_NO_CHANGE"

    # Look for patterns where special codes might be used incorrectly with error output
    # Pattern: exit $EXIT_NO_DATA after output_error (within 5 lines)
    local special_after_error
    special_after_error=$(awk '
        /output_error/ { error_line = NR }
        /EXIT_NO_DATA|EXIT_ALREADY_EXISTS|EXIT_NO_CHANGE/ {
            if (error_line > 0 && NR - error_line <= 5) {
                print NR ":" $0
                error_line = 0
            }
        }
    ' "$script" 2>/dev/null || true)

    if [[ -z "$special_after_error" ]]; then
        results+=('{"check": "special_codes_not_errors", "passed": true, "details": "Special exit codes (100+) are not used as error indicators"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "Special codes used correctly (not as errors)"
    else
        local misuse_lines
        misuse_lines=$(echo "$special_after_error" | cut -d: -f1 | head -3 | tr '\n' ',' | sed 's/,$//')
        results+=('{"check": "special_codes_not_errors", "passed": false, "details": "Special exit codes (100+) may be used as errors on lines: '"$misuse_lines"'"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "Special code misuse" "Found near error output on lines: $misuse_lines"
    fi

    # Build JSON result
    local total=$((passed + failed))
    local score
    score=$(calc_score "$passed" "$total")

    jq -n \
        --arg script "$script_name" \
        --argjson passed "$passed" \
        --argjson failed "$failed" \
        --argjson warnings "$warnings" \
        --argjson total "$total" \
        --arg score "$score" \
        --argjson checks "$(printf '%s\n' "${results[@]}" | jq -s '.')" \
        '{
            script: $script,
            category: "exit_codes",
            passed: $passed,
            failed: $failed,
            warnings: $warnings,
            total: $total,
            score: ($score | tonumber),
            checks: $checks
        }'
}

# Run check on all scripts in directory
# Usage: check_all_exit_codes <scripts_dir> <schema_json> [verbose]
check_all_exit_codes() {
    local scripts_dir="$1"
    local schema="$2"
    local verbose="${3:-false}"

    local all_results=()

    for script in "$scripts_dir"/*.sh; do
        [[ -f "$script" ]] || continue
        local result
        result=$(check_exit_codes "$script" "$schema" "$verbose")
        all_results+=("$result")
    done

    printf '%s\n' "${all_results[@]}" | jq -s '.'
}

# Main entry point when run directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    if [[ $# -lt 2 ]]; then
        echo "Usage: $0 <script_path> <schema_path> [--verbose]"
        exit 1
    fi

    script_path="$1"
    schema_path="$2"
    verbose="false"
    [[ "${3:-}" == "--verbose" ]] && verbose="true"

    schema=$(load_schema "$schema_path")
    check_exit_codes "$script_path" "$schema" "$verbose"
fi
