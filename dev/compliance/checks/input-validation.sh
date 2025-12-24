#!/usr/bin/env bash
# input-validation.sh - Check input validation compliance (Part 5.3)
# Part of LLM-Agent-First Compliance Validator
#
# Validates:
#   - Field length limit constants/functions present
#   - Length limits match spec values
#   - Validation order enforced (required -> format -> length -> semantic)
#   - E_INPUT_* error codes used appropriately
#   - Error messages include field name and limits

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/test-helpers.sh"

# ============================================================================
# SPEC-DEFINED FIELD LENGTH LIMITS (Part 5.3)
# ============================================================================
# These values MUST match LLM-AGENT-FIRST-SPEC.md Part 5.3

readonly SPEC_TITLE_MAX=120
readonly SPEC_DESCRIPTION_MAX=2000
readonly SPEC_NOTES_MAX=5000
readonly SPEC_BLOCKED_BY_MAX=300
readonly SPEC_SESSION_NOTE_MAX=1000
readonly SPEC_LABEL_MAX=50
readonly SPEC_PHASE_SLUG_MAX=30

# Validation function names expected in validation.sh
readonly VALIDATION_FUNCTIONS=(
    "validate_title"
    "validate_description"
    "validate_note"
    "validate_blocked_by"
    "validate_session_note"
)

# Field-to-limit mapping
declare -A FIELD_LIMITS=(
    ["title"]="$SPEC_TITLE_MAX"
    ["description"]="$SPEC_DESCRIPTION_MAX"
    ["note"]="$SPEC_NOTES_MAX"
    ["notes"]="$SPEC_NOTES_MAX"
    ["blockedBy"]="$SPEC_BLOCKED_BY_MAX"
    ["blocked_by"]="$SPEC_BLOCKED_BY_MAX"
    ["sessionNote"]="$SPEC_SESSION_NOTE_MAX"
    ["session_note"]="$SPEC_SESSION_NOTE_MAX"
    ["label"]="$SPEC_LABEL_MAX"
    ["phase"]="$SPEC_PHASE_SLUG_MAX"
)

# ============================================================================
# CHECK FUNCTIONS
# ============================================================================

# Check input validation compliance for a script file
# Usage: check_input_validation <script_path> <schema_json> [verbose]
check_input_validation() {
    local script="$1"
    local schema="$2"
    local verbose="${3:-false}"
    local script_name
    script_name=$(basename "$script")

    local results=()
    local passed=0
    local failed=0
    local warnings=0

    # Determine if this is a write command that needs input validation
    local is_write_cmd=false
    local write_commands
    write_commands=$(echo "$schema" | jq -r '.requirements.input_validation.write_commands[]? // empty' 2>/dev/null)
    if [[ -z "$write_commands" ]]; then
        write_commands="add update complete archive focus phase session sync extract inject"
    fi

    for cmd in $write_commands; do
        if [[ "$script_name" == *"$cmd"* ]]; then
            is_write_cmd=true
            break
        fi
    done

    # Check 1: Validation functions present (for validation library)
    if [[ "$script_name" == "validation.sh" ]]; then
        local validation_func_count=0
        local missing_funcs=()

        for func in "${VALIDATION_FUNCTIONS[@]}"; do
            if pattern_exists "$script" "^${func}\\(\\)|^function ${func}"; then
                ((validation_func_count++)) || true
            else
                missing_funcs+=("$func")
            fi
        done

        if [[ "$validation_func_count" -eq ${#VALIDATION_FUNCTIONS[@]} ]]; then
            results+=('{"check": "validation_functions", "passed": true, "details": "All '"${#VALIDATION_FUNCTIONS[@]}"' validation functions present"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Validation functions (${validation_func_count}/${#VALIDATION_FUNCTIONS[@]})"
        elif [[ "$validation_func_count" -gt 0 ]]; then
            local missing_str="${missing_funcs[*]:-none}"
            results+=('{"check": "validation_functions", "passed": false, "details": "Missing validation functions: '"${missing_str}"'"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Validation functions" "Missing: ${missing_str}"
        else
            results+=('{"check": "validation_functions", "passed": false, "details": "No validation functions found"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Validation functions" "None of the required functions found"
        fi
    else
        results+=('{"check": "validation_functions", "passed": true, "skipped": true, "details": "Not validation library"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Validation functions (not validation.sh)"
    fi

    # Check 2: Length limit constants match spec values
    if [[ "$script_name" == "validation.sh" ]]; then
        local limit_errors=0
        local limit_details=()

        # Check each expected constant
        local expected_constants=(
            "MAX_DESCRIPTION_LENGTH:$SPEC_DESCRIPTION_MAX"
            "MAX_NOTE_LENGTH:$SPEC_NOTES_MAX"
            "MAX_BLOCKED_BY_LENGTH:$SPEC_BLOCKED_BY_MAX"
            "MAX_SESSION_NOTE_LENGTH:$SPEC_SESSION_NOTE_MAX"
        )

        for const_spec in "${expected_constants[@]}"; do
            local const_name="${const_spec%%:*}"
            local expected_value="${const_spec##*:}"

            # Extract actual value from script
            local actual_value
            actual_value=$(grep -oP "readonly\s+${const_name}=\K[0-9]+" "$script" 2>/dev/null || \
                           grep -oP "${const_name}=\K[0-9]+" "$script" 2>/dev/null || echo "")

            if [[ -z "$actual_value" ]]; then
                limit_details+=("$const_name: NOT FOUND (expected $expected_value)")
                ((limit_errors++)) || true
            elif [[ "$actual_value" -ne "$expected_value" ]]; then
                limit_details+=("$const_name: $actual_value (expected $expected_value)")
                ((limit_errors++)) || true
            else
                limit_details+=("$const_name: $actual_value OK")
            fi
        done

        # Also check title max (may be inline in validate_title)
        local title_limit
        title_limit=$(grep -oP 'gt\s+\K120|title.*max\s+\K120|-gt\s+120' "$script" 2>/dev/null | head -1 || echo "")
        if [[ -z "$title_limit" ]]; then
            # Check if 120 appears in validate_title context
            if grep -qE 'validate_title.*120|120.*title' "$script" 2>/dev/null || \
               grep -A5 'validate_title' "$script" 2>/dev/null | grep -qE '\-gt 120'; then
                limit_details+=("title: 120 OK (inline)")
            else
                limit_details+=("title: NOT FOUND (expected 120)")
                ((limit_errors++)) || true
            fi
        else
            limit_details+=("title: $title_limit OK")
        fi

        if [[ "$limit_errors" -eq 0 ]]; then
            results+=('{"check": "length_limits_match_spec", "passed": true, "details": "All length limits match spec values"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Length limits match spec"
        else
            local details_str
            details_str=$(printf '%s, ' "${limit_details[@]}" | sed 's/, $//')
            results+=('{"check": "length_limits_match_spec", "passed": false, "details": "Limit mismatches: '"$details_str"'"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Length limits" "$details_str"
        fi
    else
        results+=('{"check": "length_limits_match_spec", "passed": true, "skipped": true, "details": "Not validation library"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Length limits (not validation.sh)"
    fi

    # Check 3: Validation order enforced (fail-fast pattern)
    # Commands should validate: required -> format -> length -> semantic
    if [[ "$is_write_cmd" == "true" ]]; then
        local has_required_check=false
        local has_format_check=false
        local has_length_check=false
        local has_semantic_check=false

        # Check for required argument validation
        if pattern_exists "$script" 'E_INPUT_MISSING' || \
           pattern_exists "$script" '-z "\$' || \
           pattern_exists "$script" 'is required|required.*missing|missing.*required'; then
            has_required_check=true
        fi

        # Check for format validation (regex, case statements)
        if pattern_exists "$script" 'E_INPUT_FORMAT' || \
           pattern_exists "$script" '=~' || \
           pattern_exists "$script" 'Invalid.*format|format.*invalid'; then
            has_format_check=true
        fi

        # Check for length validation (validate_* functions or explicit length checks)
        if pattern_exists "$script" 'validate_title|validate_description|validate_note|validate_blocked_by|validate_session_note' || \
           pattern_exists "$script" '\${#.*-gt' || \
           pattern_exists "$script" 'length.*exceed|exceed.*length|too long'; then
            has_length_check=true
        fi

        # Check for semantic validation (E_VALIDATION_* codes)
        if pattern_exists "$script" 'E_VALIDATION_' || \
           pattern_exists "$script" 'check_circular|validate_status|validate_deps'; then
            has_semantic_check=true
        fi

        local validation_stages=0
        local stages_present=""
        [[ "$has_required_check" == "true" ]] && { ((validation_stages++)) || true; stages_present+="required,"; }
        [[ "$has_format_check" == "true" ]] && { ((validation_stages++)) || true; stages_present+="format,"; }
        [[ "$has_length_check" == "true" ]] && { ((validation_stages++)) || true; stages_present+="length,"; }
        [[ "$has_semantic_check" == "true" ]] && { ((validation_stages++)) || true; stages_present+="semantic,"; }
        stages_present="${stages_present%,}"

        if [[ "$validation_stages" -ge 3 ]]; then
            results+=('{"check": "validation_order", "passed": true, "details": "Validation stages: '"$stages_present"'"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Validation order ($stages_present)"
        elif [[ "$validation_stages" -ge 1 ]]; then
            results+=('{"check": "validation_order", "passed": true, "warning": true, "details": "Partial validation: '"$stages_present"' (spec requires: required,format,length,semantic)"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Validation order" "Has: $stages_present (missing some stages)"
        else
            results+=('{"check": "validation_order", "passed": false, "details": "Write command lacks validation stages (spec: required,format,length,semantic)"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Validation order" "No validation stages detected"
        fi
    else
        results+=('{"check": "validation_order", "passed": true, "skipped": true, "details": "Read command - validation order check skipped"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Validation order (read command)"
    fi

    # Check 4: E_INPUT_* error codes used appropriately
    local input_codes=("E_INPUT_MISSING" "E_INPUT_INVALID" "E_INPUT_FORMAT")
    local codes_used=()
    local codes_missing=()

    for code in "${input_codes[@]}"; do
        if pattern_exists "$script" "$code"; then
            codes_used+=("$code")
        else
            codes_missing+=("$code")
        fi
    done

    local codes_used_str="${codes_used[*]:-none}"
    local codes_missing_str="${codes_missing[*]:-none}"

    if [[ ${#codes_used[@]} -eq ${#input_codes[@]} ]]; then
        results+=('{"check": "input_error_codes", "passed": true, "details": "All E_INPUT_* codes used: '"${codes_used_str// /, }"'"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "E_INPUT_* codes (all present)"
    elif [[ ${#codes_used[@]} -gt 0 ]]; then
        if [[ "$is_write_cmd" == "true" ]]; then
            results+=('{"check": "input_error_codes", "passed": true, "warning": true, "details": "Uses '"${codes_used_str// /, }"', missing: '"${codes_missing_str// /, }"'"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "E_INPUT_* codes" "Has: ${codes_used_str// /, }; Missing: ${codes_missing_str// /, }"
        else
            results+=('{"check": "input_error_codes", "passed": true, "details": "Uses '"${codes_used_str// /, }"' (read command)"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "E_INPUT_* codes (${codes_used_str// /, })"
        fi
    elif [[ "$is_write_cmd" == "true" ]]; then
        results+=('{"check": "input_error_codes", "passed": false, "details": "Write command should use E_INPUT_* error codes"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "E_INPUT_* codes" "Write commands need: E_INPUT_MISSING, E_INPUT_INVALID, E_INPUT_FORMAT"
    else
        results+=('{"check": "input_error_codes", "passed": true, "skipped": true, "details": "Read command - E_INPUT_* codes optional"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "E_INPUT_* codes (read command)"
    fi

    # Check 5: Error messages include field name and limits
    if [[ "$is_write_cmd" == "true" || "$script_name" == "validation.sh" ]]; then
        local has_field_in_error=false
        local has_limit_in_error=false

        # Check for field name in error messages
        if pattern_exists "$script" 'title.*error|error.*title|Title' || \
           pattern_exists "$script" 'description.*error|error.*description|Description' || \
           pattern_exists "$script" 'note.*error|error.*note|Note' || \
           pattern_exists "$script" 'field.*error|error.*field'; then
            has_field_in_error=true
        fi

        # Check for limit values in error messages
        if pattern_exists "$script" '120.*char|120.*max|max.*120' || \
           pattern_exists "$script" '2000.*char|2000.*max|max.*2000' || \
           pattern_exists "$script" '5000.*char|5000.*max|max.*5000' || \
           pattern_exists "$script" 'exceeds.*character|character.*limit|max.*chars'; then
            has_limit_in_error=true
        fi

        if [[ "$has_field_in_error" == "true" && "$has_limit_in_error" == "true" ]]; then
            results+=('{"check": "error_message_quality", "passed": true, "details": "Error messages include field names and limits"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Error message quality"
        elif [[ "$has_field_in_error" == "true" || "$has_limit_in_error" == "true" ]]; then
            local has_what=""
            [[ "$has_field_in_error" == "true" ]] && has_what+="field names"
            [[ "$has_limit_in_error" == "true" ]] && { [[ -n "$has_what" ]] && has_what+=", "; has_what+="limits"; }
            results+=('{"check": "error_message_quality", "passed": true, "warning": true, "details": "Error messages have '"$has_what"' but could be more complete"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Error message quality" "Has $has_what"
        else
            if [[ ${#codes_used[@]} -gt 0 ]]; then
                results+=('{"check": "error_message_quality", "passed": false, "details": "Error messages should include field name and limits per spec 5.3"}')
                ((failed++)) || true
                [[ "$verbose" == "true" ]] && print_check fail "Error message quality" "Add field names and limits to error messages"
            else
                results+=('{"check": "error_message_quality", "passed": true, "skipped": true, "details": "No input validation error handling detected"}')
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check skip "Error message quality (no input validation)"
            fi
        fi
    else
        results+=('{"check": "error_message_quality", "passed": true, "skipped": true, "details": "Read command - error message quality check skipped"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Error message quality (read command)"
    fi

    # Check 6: Uses validation library (for write commands)
    if [[ "$is_write_cmd" == "true" ]]; then
        if pattern_exists "$script" 'source.*validation\.sh' || \
           pattern_exists "$script" '\$LIB_DIR/validation\.sh' || \
           pattern_exists "$script" 'validation\.sh'; then
            results+=('{"check": "validation_lib_sourced", "passed": true, "details": "Validation library sourced"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "validation.sh sourced"
        else
            results+=('{"check": "validation_lib_sourced", "passed": false, "details": "Write command should source validation.sh for input validation"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "validation.sh" "Write commands should source validation library"
        fi
    else
        results+=('{"check": "validation_lib_sourced", "passed": true, "skipped": true, "details": "Read command - validation lib check skipped"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "validation.sh (read command)"
    fi

    # Check 7: Label/phase length validation (if applicable)
    if [[ "$script_name" == *"label"* || "$script_name" == *"phase"* || "$script_name" == "add"* || "$script_name" == "update"* ]]; then
        local has_label_check=false
        local has_phase_check=false

        # Check for label length validation
        if pattern_exists "$script" 'label.*50|50.*label|\${#.*label.*-gt' || \
           pattern_exists "$script" 'label.*length|validate.*label'; then
            has_label_check=true
        fi

        # Check for phase slug length validation
        if pattern_exists "$script" 'phase.*30|30.*phase|\${#.*phase.*-gt' || \
           pattern_exists "$script" 'phase.*length|validate.*phase.*slug'; then
            has_phase_check=true
        fi

        if [[ "$has_label_check" == "true" || "$has_phase_check" == "true" ]]; then
            local validated_fields=""
            [[ "$has_label_check" == "true" ]] && validated_fields+="label"
            [[ "$has_phase_check" == "true" ]] && { [[ -n "$validated_fields" ]] && validated_fields+=","; validated_fields+="phase"; }
            results+=('{"check": "label_phase_validation", "passed": true, "details": "Validates: '"$validated_fields"'"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Label/phase validation ($validated_fields)"
        else
            results+=('{"check": "label_phase_validation", "passed": true, "warning": true, "details": "Consider adding label (max 50) and phase (max 30) length validation"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Label/phase validation" "Add length checks: label (50), phase (30)"
        fi
    else
        results+=('{"check": "label_phase_validation", "passed": true, "skipped": true, "details": "Not a label/phase handling command"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Label/phase validation (not applicable)"
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
            category: "input_validation",
            passed: $passed,
            failed: $failed,
            warnings: $warnings,
            total: $total,
            score: ($score | tonumber),
            checks: $checks
        }'
}

# Run check on all scripts in directory
# Usage: check_all_input_validation <scripts_dir> <schema_json> [verbose]
check_all_input_validation() {
    local scripts_dir="$1"
    local schema="$2"
    local verbose="${3:-false}"

    local all_results=()

    for script in "$scripts_dir"/*.sh; do
        [[ -f "$script" ]] || continue
        local result
        result=$(check_input_validation "$script" "$schema" "$verbose")
        all_results+=("$result")
    done

    printf '%s\n' "${all_results[@]}" | jq -s '.'
}

# Validate that validation.sh library has correct spec limits
# Usage: check_validation_library <validation_sh_path> [verbose]
check_validation_library() {
    local validation_file="$1"
    local verbose="${2:-false}"

    if [[ ! -f "$validation_file" ]]; then
        echo '{"error": "validation.sh not found", "path": "'"$validation_file"'"}'
        return 1
    fi

    local results=()
    local passed=0
    local failed=0

    # Check each spec-defined limit
    local spec_checks=(
        "DESCRIPTION:MAX_DESCRIPTION_LENGTH:$SPEC_DESCRIPTION_MAX"
        "NOTE:MAX_NOTE_LENGTH:$SPEC_NOTES_MAX"
        "BLOCKED_BY:MAX_BLOCKED_BY_LENGTH:$SPEC_BLOCKED_BY_MAX"
        "SESSION_NOTE:MAX_SESSION_NOTE_LENGTH:$SPEC_SESSION_NOTE_MAX"
        "TITLE:120:$SPEC_TITLE_MAX"
    )

    for spec in "${spec_checks[@]}"; do
        local field="${spec%%:*}"
        local remainder="${spec#*:}"
        local const_or_value="${remainder%%:*}"
        local expected="${remainder##*:}"

        local actual=""
        if [[ "$const_or_value" == "120" ]]; then
            # Title is inline check, not a constant
            if grep -qE '\-gt 120' "$validation_file" 2>/dev/null; then
                actual="120"
            fi
        else
            actual=$(grep -oP "readonly\s+${const_or_value}=\K[0-9]+" "$validation_file" 2>/dev/null || echo "")
        fi

        if [[ "$actual" == "$expected" ]]; then
            results+=('{"field": "'"$field"'", "expected": '"$expected"', "actual": '"$actual"', "match": true}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "$field limit: $actual (expected $expected)"
        elif [[ -z "$actual" ]]; then
            results+=('{"field": "'"$field"'", "expected": '"$expected"', "actual": null, "match": false}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "$field limit" "Not found (expected $expected)"
        else
            results+=('{"field": "'"$field"'", "expected": '"$expected"', "actual": '"$actual"', "match": false}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "$field limit" "Got $actual, expected $expected"
        fi
    done

    local total=$((passed + failed))
    jq -n \
        --argjson passed "$passed" \
        --argjson failed "$failed" \
        --argjson total "$total" \
        --argjson limits "$(printf '%s\n' "${results[@]}" | jq -s '.')" \
        '{
            category: "validation_library_limits",
            passed: $passed,
            failed: $failed,
            total: $total,
            spec_compliance: (if $failed == 0 then true else false end),
            limits: $limits
        }'
}

# Main entry point when run directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    if [[ $# -lt 1 ]]; then
        echo "Usage: $0 <script_path> [schema_path] [--verbose]"
        echo "       $0 --check-validation-lib <validation.sh_path> [--verbose]"
        exit 1
    fi

    # Special mode: check validation library limits
    if [[ "$1" == "--check-validation-lib" ]]; then
        validation_path="${2:-}"
        verbose="false"
        [[ "${3:-}" == "--verbose" ]] && verbose="true"

        if [[ -z "$validation_path" ]]; then
            echo "ERROR: Validation library path required" >&2
            exit 1
        fi

        check_validation_library "$validation_path" "$verbose"
        exit $?
    fi

    script_path="$1"
    schema_path="${2:-$SCRIPT_DIR/../schema.json}"
    verbose="false"
    [[ "${3:-}" == "--verbose" || "${2:-}" == "--verbose" ]] && verbose="true"

    if [[ ! -f "$schema_path" ]] && [[ "$2" != "--verbose" ]]; then
        echo "WARNING: Schema not found at $schema_path, using empty schema" >&2
        schema='{}'
    elif [[ "$2" == "--verbose" ]]; then
        schema='{}'
        verbose="true"
    else
        schema=$(load_schema "$schema_path")
    fi

    check_input_validation "$script_path" "$schema" "$verbose"
fi
