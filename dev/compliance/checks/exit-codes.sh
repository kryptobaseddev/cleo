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

    # Check 1: Uses EXIT_* constants
    local exit_pattern
    exit_pattern=$(echo "$schema" | jq -r '.requirements.exit_codes.pattern')

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
    local const_pattern
    const_pattern=$(echo "$schema" | jq -r '.requirements.exit_codes.pattern // "exit \\$EXIT_|exit \\$\\{EXIT_"')
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
    local exit_lib_pattern
    exit_lib_pattern=$(echo "$schema" | jq -r '.requirements.exit_codes.exit_lib_pattern // "exit-codes\\.sh"')
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

    if [[ "$total_exits" -gt 0 ]]; then
        # Use schema pattern for counting constant exits
        local const_pattern_grep
        const_pattern_grep=$(echo "$schema" | jq -r '.requirements.exit_codes.pattern // "exit \\$EXIT_|\\$\\{EXIT_"' | sed 's/\\\\\\$/\\$/g')
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
