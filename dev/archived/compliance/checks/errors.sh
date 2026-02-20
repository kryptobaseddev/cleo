#!/usr/bin/env bash
# errors.sh - Check error handling compliance
# Part of LLM-Agent-First Compliance Validator

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/test-helpers.sh"

# Check error handling compliance for a script file
# Usage: check_errors <script_path> <schema_json> [verbose]
check_errors() {
    local script="$1"
    local schema="$2"
    local verbose="${3:-false}"
    local script_name
    script_name=$(basename "$script")

    local results=()
    local passed=0
    local failed=0
    local warnings=0

    # Check 1: Uses output_error() function
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local output_error_pattern
    output_error_pattern="${PATTERN_ERROR_FUNCTION:-$(echo "$schema" | jq -r '.requirements.error_handling.required_function')}"

    local error_func_count
    error_func_count=$(pattern_count "$script" "$output_error_pattern")

    if [[ "$error_func_count" -gt 0 ]]; then
        results+=('{"check": "output_error_usage", "passed": true, "details": "Uses output_error() function ('"$error_func_count"' calls)"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "output_error() used ($error_func_count calls)"
    else
        # Check if there's any error output at all
        local has_errors
        has_errors=$(pattern_count "$script" ">&2|stderr|error" || echo "0")

        if [[ "$has_errors" -gt 0 ]]; then
            results+=('{"check": "output_error_usage", "passed": false, "details": "Has error handling but doesn'\''t use output_error()"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "output_error()" "Has error handling but not using standard function"
        else
            results+=('{"check": "output_error_usage", "passed": true, "skipped": true, "details": "No apparent error output (may not need it)"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check skip "output_error() (no error handling found)"
        fi
    fi

    # Check 2: Defensive function check (declare -f OR fallback function definition)
    # Defensive patterns include:
    # - declare -f function_name >/dev/null
    # - Fallback function definition in else block (function_name() { ... })
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local defensive_pattern
    defensive_pattern="${PATTERN_DEFENSIVE_CHECK:-$(echo "$schema" | jq -r '.requirements.error_handling.defensive_check')}"

    # Also check for fallback patterns where function is defined in else block
    local fallback_pattern="log_error\\(\\)|output_error\\(\\)|dev_die\\(\\)"
    local has_fallback_def=false

    # Check for fallback function definition pattern (else branch with function def)
    if grep -qE "^[[:space:]]*(log_error|output_error|dev_die)\\(\\)[[:space:]]*\\{" "$script" 2>/dev/null; then
        has_fallback_def=true
    fi

    if pattern_exists "$script" "$defensive_pattern" || [[ "$has_fallback_def" == "true" ]]; then
        local detail_msg="Defensive function check present"
        [[ "$has_fallback_def" == "true" ]] && detail_msg="Fallback function definition provides defense"
        results+=('{"check": "defensive_check", "passed": true, "details": "'"$detail_msg"'"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "Defensive function check"
    else
        # Only fail if output_error is used
        if [[ "$error_func_count" -gt 0 ]]; then
            results+=('{"check": "defensive_check", "passed": false, "details": "Uses output_error() but no defensive check (declare -f)"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Defensive check" "Add: declare -f output_error >/dev/null"
        else
            results+=('{"check": "defensive_check", "passed": true, "skipped": true, "details": "Not needed (output_error not used)"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check skip "Defensive check (output_error not used)"
        fi
    fi

    # Check 3: Error codes use E_* pattern
    local error_code_pattern
    error_code_pattern=$(echo "$schema" | jq -r '.requirements.error_handling.error_codes_pattern')

    local error_code_count
    error_code_count=$(pattern_count "$script" "$error_code_pattern")

    if [[ "$error_code_count" -gt 0 ]]; then
        # Extract unique error codes used
        local error_codes
        error_codes=$(grep -oE 'E_[A-Z_]+' "$script" 2>/dev/null | sort -u | head -5 | tr '\n' ',' | sed 's/,$//' || echo "")
        results+=('{"check": "error_codes", "passed": true, "details": "Uses E_* error codes: '"$error_codes"'"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "E_* error codes ($error_codes)"
    else
        # Check if there are any error situations
        if [[ "$error_func_count" -gt 0 ]]; then
            results+=('{"check": "error_codes", "passed": false, "details": "Uses output_error() but no E_* error codes"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "E_* error codes" "Should use standard error codes with output_error()"
        else
            results+=('{"check": "error_codes", "passed": true, "skipped": true, "details": "No error handling requiring codes"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check skip "E_* error codes (no error handling)"
        fi
    fi

    # Check 4: Error library sourced (uses schema pattern if available)
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local error_lib_pattern
    error_lib_pattern="${PATTERN_ERROR_LIB:-$(echo "$schema" | jq -r '.requirements.error_handling.error_lib_pattern // "error-json\\.sh"')}"
    local error_lib_name
    error_lib_name=$(echo "$schema" | jq -r '.requirements.error_handling.error_lib_name // "error-json.sh"')

    if pattern_exists "$script" "source.*$error_lib_pattern"; then
        results+=('{"check": "error_lib_sourced", "passed": true, "details": "'"$error_lib_name"' library sourced"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "$error_lib_name sourced"
    else
        results+=('{"check": "error_lib_sourced", "passed": false, "details": "'"$error_lib_name"' library not sourced"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "$error_lib_name" "Library not sourced"
    fi

    # Check 5: Proper error JSON structure (if using jq for errors)
    local json_error_count
    json_error_count=$(pattern_count "$script" '"error".*:.*"' || echo "0")

    if [[ "$json_error_count" -gt 0 ]]; then
        # Check for proper structure
        if pattern_exists "$script" '"success".*:.*false'; then
            results+=('{"check": "error_json_structure", "passed": true, "details": "Error JSON includes success: false"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Error JSON structure"
        else
            results+=('{"check": "error_json_structure", "passed": false, "warning": true, "details": "Error JSON should include success: false"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Error JSON structure" "Consider adding success: false to error responses"
        fi
    else
        results+=('{"check": "error_json_structure", "passed": true, "skipped": true, "details": "No inline JSON errors found"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Error JSON structure (no inline JSON)"
    fi

    # Check 6: Heredoc safety (unquoted heredocs with $schema must escape it)
    # This catches set -u errors when heredoc contains literal $schema
    # Only check INSIDE heredoc blocks, not regular variable usage
    local heredoc_unsafe=false

    # Use awk to extract content between unquoted heredocs and check for unescaped $schema
    # Pattern: $schema NOT followed by alphanumeric/underscore (not part of $schema_version)
    local unsafe_in_heredoc
    unsafe_in_heredoc=$(awk '
        # Match unquoted heredoc start (not << '\''EOF'\'' or << "EOF")
        /<<[[:space:]]*EOF$/ || /<<[[:space:]]*EOF[^'\''"[:alnum:]]/ {
            in_heredoc = 1
            next
        }
        # Match heredoc end
        /^EOF$/ || /^[[:space:]]*EOF$/ {
            in_heredoc = 0
            next
        }
        # Inside heredoc, look for $schema that is:
        # - Not escaped (\$schema)
        # - Not part of a longer variable name ($schema_version, $schemaPath)
        # Pattern: $schema followed by non-word char or end of line
        in_heredoc && /\$schema([^_a-zA-Z0-9]|$)/ && !/\\\$schema/ {
            print NR ": " $0
        }
    ' "$script" 2>/dev/null)

    if [[ -n "$unsafe_in_heredoc" ]]; then
        heredoc_unsafe=true
    fi

    if [[ "$heredoc_unsafe" == "true" ]]; then
        results+=('{"check": "heredoc_safety", "passed": false, "details": "Unquoted heredoc has unescaped $schema - use \\$schema or quote EOF"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "Heredoc safety" "Escape \$schema in unquoted heredocs or use << 'EOF'"
    else
        results+=('{"check": "heredoc_safety", "passed": true, "details": "No unsafe heredoc patterns detected"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "Heredoc safety"
    fi

    # Check 7: E_INPUT_* error codes usage (Part 5.3 Input Validation)
    # These codes are required for proper input validation per LLM-Agent-First Spec v3.0
    # E_INPUT_MISSING (exit code 2) - required argument missing
    # E_INPUT_INVALID (exit code 2) - argument value invalid
    # E_INPUT_FORMAT (exit code 2) - argument format incorrect
    local input_error_codes=("E_INPUT_MISSING" "E_INPUT_INVALID" "E_INPUT_FORMAT")
    local input_codes_used=()
    local input_codes_missing=()

    for code in "${input_error_codes[@]}"; do
        if pattern_exists "$script" "$code"; then
            input_codes_used+=("$code")
        else
            input_codes_missing+=("$code")
        fi
    done

    local input_codes_used_str="${input_codes_used[*]:-}"
    local input_codes_missing_str="${input_codes_missing[*]:-}"

    # Determine if this is a write command that needs input validation
    local is_write_cmd=false
    local write_commands=("add" "update" "complete" "archive" "focus" "phase" "session" "sync" "extract" "inject")
    for cmd in "${write_commands[@]}"; do
        if [[ "$script_name" == *"$cmd"* ]]; then
            is_write_cmd=true
            break
        fi
    done

    if [[ ${#input_codes_used[@]} -gt 0 ]]; then
        results+=('{"check": "input_error_codes", "passed": true, "details": "Uses E_INPUT_* error codes: '"${input_codes_used_str// /, }"'"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "E_INPUT_* codes (${input_codes_used_str// /, })"
    elif [[ "$is_write_cmd" == "true" ]]; then
        # Write commands should use input validation codes
        results+=('{"check": "input_error_codes", "passed": false, "details": "Write command should use E_INPUT_* error codes for input validation"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "E_INPUT_* codes" "Write commands need: E_INPUT_MISSING, E_INPUT_INVALID, E_INPUT_FORMAT"
    else
        # Read commands may not need input validation
        results+=('{"check": "input_error_codes", "passed": true, "skipped": true, "details": "Read command - E_INPUT_* codes optional"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "E_INPUT_* codes (read command)"
    fi

    # Check 8: Input validation order (Part 5.3)
    # Validation should follow: required → format → length → semantic
    # This check verifies that input validation patterns exist for write commands
    if [[ "$is_write_cmd" == "true" ]]; then
        local has_required_check=false
        local has_format_check=false
        local has_length_check=false

        # Check for required argument validation (typically -z checks or E_INPUT_MISSING)
        if pattern_exists "$script" '-z "\$' || pattern_exists "$script" 'E_INPUT_MISSING' || pattern_exists "$script" 'is required'; then
            has_required_check=true
        fi

        # Check for format validation (regex patterns, case statements, E_INPUT_FORMAT)
        if pattern_exists "$script" '=~' || pattern_exists "$script" 'E_INPUT_FORMAT' || pattern_exists "$script" 'Invalid.*format'; then
            has_format_check=true
        fi

        # Check for length validation (validate_title, validate_description, validate_note)
        if pattern_exists "$script" 'validate_title\|validate_description\|validate_note' || pattern_exists "$script" 'length'; then
            has_length_check=true
        fi

        local validation_details=""
        local validation_passed=true

        if [[ "$has_required_check" == "true" ]]; then
            validation_details="required"
        else
            validation_passed=false
        fi

        if [[ "$has_format_check" == "true" ]]; then
            [[ -n "$validation_details" ]] && validation_details="${validation_details}, "
            validation_details="${validation_details}format"
        fi

        if [[ "$has_length_check" == "true" ]]; then
            [[ -n "$validation_details" ]] && validation_details="${validation_details}, "
            validation_details="${validation_details}length"
        fi

        if [[ -n "$validation_details" ]]; then
            if [[ "$validation_passed" == "true" ]]; then
                results+=('{"check": "input_validation_order", "passed": true, "details": "Has validation: '"$validation_details"'"}')
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check pass "Input validation ($validation_details)"
            else
                results+=('{"check": "input_validation_order", "passed": false, "warning": true, "details": "Missing required arg check (has: '"$validation_details"')"}')
                ((warnings++)) || true
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check warn "Input validation" "Missing required arg check"
            fi
        else
            results+=('{"check": "input_validation_order", "passed": false, "details": "Write command lacks input validation"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Input validation" "Add required/format/length validation per spec 5.3"
        fi
    else
        results+=('{"check": "input_validation_order", "passed": true, "skipped": true, "details": "Read command - validation order check skipped"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Input validation order (read command)"
    fi

    # Check 9: EXIT_INVALID_INPUT usage with E_INPUT_* codes
    # E_INPUT_* codes should use exit code 2 (EXIT_INVALID_INPUT)
    local exit_input_pattern='E_INPUT_[A-Z]+.*EXIT_INVALID_INPUT\|EXIT_INVALID_INPUT.*2\|exit.*2'
    if [[ ${#input_codes_used[@]} -gt 0 ]]; then
        if pattern_exists "$script" 'EXIT_INVALID_INPUT' || pattern_exists "$script" 'exit.*\$.*2\|exit 2'; then
            results+=('{"check": "input_exit_code", "passed": true, "details": "E_INPUT_* codes use correct exit code (2)"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Input exit code (EXIT_INVALID_INPUT=2)"
        else
            results+=('{"check": "input_exit_code", "passed": false, "warning": true, "details": "E_INPUT_* codes should use EXIT_INVALID_INPUT (exit 2)"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Input exit code" "E_INPUT_* should exit with code 2"
        fi
    else
        results+=('{"check": "input_exit_code", "passed": true, "skipped": true, "details": "No E_INPUT_* codes used"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Input exit code (no E_INPUT_* codes)"
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
            category: "errors",
            passed: $passed,
            failed: $failed,
            warnings: $warnings,
            total: $total,
            score: ($score | tonumber),
            checks: $checks
        }'
}

# Run check on all scripts in directory
# Usage: check_all_errors <scripts_dir> <schema_json> [verbose]
check_all_errors() {
    local scripts_dir="$1"
    local schema="$2"
    local verbose="${3:-false}"

    local all_results=()

    for script in "$scripts_dir"/*.sh; do
        [[ -f "$script" ]] || continue
        local result
        result=$(check_errors "$script" "$schema" "$verbose")
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
    check_errors "$script_path" "$schema" "$verbose"
fi
