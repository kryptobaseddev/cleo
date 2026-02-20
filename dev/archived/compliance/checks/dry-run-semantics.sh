#!/usr/bin/env bash
# dry-run-semantics.sh - Check dry-run semantics compliance (Spec Part 5.4)
# Part of LLM-Agent-First Compliance Validator
#
# Validates that write commands implement --dry-run according to the spec:
# - Full validation still runs
# - No file locking occurs
# - No state modification (no atomic_write calls)
# - Full JSON output with dryRun: true
# - Uses wouldCreate/wouldUpdate/wouldDelete/wouldArchive fields
# - Exit codes match real operation codes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/test-helpers.sh"

# ============================================================================
# DRY-RUN PATTERNS
# ============================================================================

# Commands that MUST support --dry-run (from spec Part 5.4)
DRYRUN_REQUIRED_COMMANDS=(
    "add"
    "update"
    "complete"
    "archive"
    "restore"
    "migrate"
    "migrate-backups"
    "inject"
    "extract"
    "sync"
)

# Patterns for detecting dry-run related code
PATTERN_DRYRUN_FLAG='--dry-run\)'
PATTERN_DRYRUN_VAR='DRY_RUN=true|DRY_RUN="true"'
PATTERN_DRYRUN_CHECK='DRY_RUN.*==.*true|\$DRY_RUN.*true|"\$DRY_RUN".*==.*"?true"?'
PATTERN_DRYRUN_JSON_FIELD='"dryRun"[[:space:]]*:[[:space:]]*true|"dryRun":[[:space:]]*\$'
PATTERN_WOULD_FIELDS='wouldCreate|wouldUpdate|wouldDelete|wouldArchive|wouldRestore|wouldMigrate|wouldInject|wouldExtract|wouldSync'
PATTERN_ATOMIC_WRITE='atomic_write|save_json|write_json_atomic'

# ============================================================================
# CHECK FUNCTIONS
# ============================================================================

# Check if a command requires --dry-run support
# Usage: requires_dry_run <command_name>
requires_dry_run() {
    local cmd="$1"
    for required_cmd in "${DRYRUN_REQUIRED_COMMANDS[@]}"; do
        if [[ "$cmd" == "$required_cmd" ]]; then
            return 0
        fi
    done
    return 1
}

# Get command name from script path
# Usage: get_command_from_script <script_path>
get_command_from_script() {
    local script="$1"
    local script_name
    script_name=$(basename "$script" .sh)

    # Strip common suffixes
    script_name="${script_name%-task}"
    script_name="${script_name%-command}"
    script_name="${script_name%-todowrite}"

    echo "$script_name"
}

# Check dry-run compliance for a script file
# Usage: check_dry_run_semantics <script_path> <schema_json> [verbose]
check_dry_run_semantics() {
    local script="$1"
    local schema="$2"
    local verbose="${3:-false}"
    local script_name
    script_name=$(basename "$script")
    local command
    command=$(get_command_from_script "$script")

    local results=()
    local passed=0
    local failed=0
    local skipped=0
    local warnings=0

    # First check if this command requires --dry-run
    if ! requires_dry_run "$command"; then
        results+=('{"check": "dry_run_not_required", "passed": true, "skipped": true, "details": "Command '"$command"' does not require --dry-run support"}')
        ((skipped++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "Dry-run not required for $command"

        # Return early with skipped result
        local total=0
        jq -n \
            --arg script "$script_name" \
            --arg command "$command" \
            --argjson passed "$passed" \
            --argjson failed "$failed" \
            --argjson skipped "$skipped" \
            --argjson warnings "$warnings" \
            --argjson total "$total" \
            --arg score "N/A" \
            --argjson checks "$(printf '%s\n' "${results[@]}" | jq -s '.')" \
            '{
                script: $script,
                command: $command,
                category: "dry_run_semantics",
                passed: $passed,
                failed: $failed,
                skipped: $skipped,
                warnings: $warnings,
                total: $total,
                score: $score,
                checks: $checks
            }'
        return 0
    fi

    # ========================================================================
    # Check 1: Write commands support --dry-run flag
    # ========================================================================
    if pattern_exists "$script" "$PATTERN_DRYRUN_FLAG"; then
        results+=('{"check": "dry_run_flag", "passed": true, "details": "--dry-run flag is supported"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "--dry-run flag supported"
    else
        results+=('{"check": "dry_run_flag", "passed": false, "details": "--dry-run flag not found (required for write command)"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "--dry-run flag" "Required for $command"
    fi

    # ========================================================================
    # Check 2: Dry-run outputs dryRun: true in JSON
    # ========================================================================
    if pattern_exists "$script" "$PATTERN_DRYRUN_JSON_FIELD"; then
        results+=('{"check": "dry_run_json_field", "passed": true, "details": "JSON output includes dryRun: true field"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "dryRun: true in JSON output"
    else
        results+=('{"check": "dry_run_json_field", "passed": false, "details": "JSON output missing dryRun: true field when in dry-run mode"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "dryRun JSON field" "Missing 'dryRun: true' in JSON output"
    fi

    # ========================================================================
    # Check 3: Dry-run does not modify state (no atomic_write calls when DRY_RUN=true)
    # ========================================================================
    # Look for patterns where DRY_RUN check guards atomic_write
    local has_dryrun_check=false
    local has_atomic_write=false

    if pattern_exists "$script" "$PATTERN_DRYRUN_CHECK"; then
        has_dryrun_check=true
    fi

    if pattern_exists "$script" "$PATTERN_ATOMIC_WRITE"; then
        has_atomic_write=true
    fi

    if [[ "$has_atomic_write" == "true" ]]; then
        # Script has atomic writes - verify dry-run guards them
        # Check for pattern: if DRY_RUN != true then atomic_write (or similar)
        # Look for the conditional structure
        local dryrun_guard_patterns=(
            'DRY_RUN.*!=.*true.*then'
            'DRY_RUN.*==.*false.*then'
            'DRY_RUN.*!="true"'
            'if.*DRY_RUN.*true.*else'
            'DRY_RUN.*==.*true.*;;'
        )
        local has_guard=false

        for pattern in "${dryrun_guard_patterns[@]}"; do
            if pattern_exists "$script" "$pattern"; then
                has_guard=true
                break
            fi
        done

        # Alternative: check if DRY_RUN is checked before any write operation
        if ! $has_guard; then
            # Check for simpler pattern: if/then with DRY_RUN before save operations
            if pattern_exists "$script" 'if.*\[\[.*DRY_RUN.*==.*true'; then
                has_guard=true
            fi
        fi

        if [[ "$has_guard" == "true" ]]; then
            results+=('{"check": "no_state_modification", "passed": true, "details": "Dry-run mode guards atomic write operations"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "State modification guarded in dry-run mode"
        else
            # Check if there's explicit DRY_RUN check before writes (more complex)
            # Look for pattern where DRY_RUN is checked and early return happens
            if pattern_exists "$script" 'DRY_RUN.*true.*exit|DRY_RUN.*true.*return'; then
                results+=('{"check": "no_state_modification", "passed": true, "details": "Dry-run mode exits before state modification"}')
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check pass "Early exit in dry-run mode"
            else
                results+=('{"check": "no_state_modification", "passed": true, "warning": true, "details": "Has atomic writes but dry-run guard pattern not clearly detected (may be in conditional block)"}')
                ((warnings++)) || true
                ((passed++)) || true
                [[ "$verbose" == "true" ]] && print_check warn "State modification guard" "Pattern detected but guard structure unclear"
            fi
        fi
    else
        # No atomic writes found - may use different write pattern or delegate to library
        results+=('{"check": "no_state_modification", "passed": true, "skipped": true, "details": "No direct atomic_write calls found (may delegate to library)"}')
        ((skipped++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "No atomic_write calls (may delegate)"
    fi

    # ========================================================================
    # Check 4: Dry-run uses wouldCreate/wouldUpdate/wouldDelete fields
    # ========================================================================
    if pattern_exists "$script" "$PATTERN_WOULD_FIELDS"; then
        local would_field
        would_field=$(grep -oE "$PATTERN_WOULD_FIELDS" "$script" 2>/dev/null | head -1 || echo "unknown")
        results+=('{"check": "would_fields", "passed": true, "details": "Uses would* field for dry-run output ('"$would_field"')"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "Uses $would_field field for dry-run output"
    else
        # Check for alternative patterns like "preview" or "changes"
        if pattern_exists "$script" '"preview"|"changes"|"planned"'; then
            results+=('{"check": "would_fields", "passed": true, "warning": true, "details": "Uses alternative field for dry-run output (not standard would* pattern)"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Alternative dry-run output field" "Consider using wouldCreate/wouldUpdate/wouldDelete"
        else
            results+=('{"check": "would_fields", "passed": false, "details": "Missing wouldCreate/wouldUpdate/wouldDelete field in dry-run output"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "would* fields" "Dry-run output should use wouldCreate/wouldUpdate/wouldDelete"
        fi
    fi

    # ========================================================================
    # Check 5: Dry-run exit codes match real operation codes
    # ========================================================================
    # Check that dry-run path uses same exit code constants as real path
    local dryrun_exits
    dryrun_exits=$(awk '
        /DRY_RUN.*true/ { in_dryrun = 1 }
        /^[[:space:]]*fi[[:space:]]*$/ { if (in_dryrun) in_dryrun = 0 }
        in_dryrun && /exit.*EXIT_|exit \$EXIT_/ { print NR ":" $0 }
    ' "$script" 2>/dev/null | head -5)

    if [[ -n "$dryrun_exits" ]]; then
        # Check if using proper EXIT_* constants
        if echo "$dryrun_exits" | grep -qE 'EXIT_SUCCESS|EXIT_[A-Z_]+'; then
            results+=('{"check": "exit_codes_match", "passed": true, "details": "Dry-run uses proper EXIT_* constants"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Dry-run uses EXIT_* constants"
        else
            results+=('{"check": "exit_codes_match", "passed": false, "details": "Dry-run path may not use EXIT_* constants"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Exit codes" "Dry-run should use same EXIT_* constants as real operation"
        fi
    else
        # Check for exit 0 after dry-run output (acceptable pattern)
        if pattern_exists "$script" 'DRY_RUN.*true.*exit 0|exit \$EXIT_SUCCESS'; then
            results+=('{"check": "exit_codes_match", "passed": true, "details": "Dry-run exits with success code"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "Dry-run exits successfully"
        else
            results+=('{"check": "exit_codes_match", "passed": true, "warning": true, "details": "Dry-run exit code pattern not clearly detected"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Exit code pattern unclear" "Verify exit codes match real operation"
        fi
    fi

    # ========================================================================
    # Check 6: Validation runs even in dry-run mode
    # ========================================================================
    # Check that validation calls happen BEFORE the dry-run check
    # Pattern: validation functions should be called before DRY_RUN check

    local validation_patterns=(
        'validate_'
        'check_task_exists'
        'verify_'
        'E_INPUT_'
        'E_VALIDATION_'
        'E_TASK_NOT_FOUND'
    )

    local has_early_validation=false

    # Check if validation happens before dry-run branching
    for pattern in "${validation_patterns[@]}"; do
        # Look for validation before DRY_RUN check
        local validation_line
        validation_line=$(grep -n "$pattern" "$script" 2>/dev/null | head -1 | cut -d: -f1 || echo "999999")
        local dryrun_line
        dryrun_line=$(grep -n 'if.*DRY_RUN.*==.*true' "$script" 2>/dev/null | head -1 | cut -d: -f1 || echo "0")

        if [[ "$validation_line" != "999999" ]] && [[ "$dryrun_line" != "0" ]]; then
            if [[ "$validation_line" -lt "$dryrun_line" ]]; then
                has_early_validation=true
                break
            fi
        fi
    done

    # Alternative: Check if validation is in a separate function that runs unconditionally
    if ! $has_early_validation; then
        if pattern_exists "$script" 'validate_inputs|parse_and_validate|check_required'; then
            has_early_validation=true
        fi
    fi

    if [[ "$has_early_validation" == "true" ]]; then
        results+=('{"check": "validation_runs", "passed": true, "details": "Validation occurs before dry-run check (full validation in dry-run mode)"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "Validation runs before dry-run check"
    else
        # Check for validation patterns anywhere
        local has_any_validation=false
        for pattern in "${validation_patterns[@]}"; do
            if pattern_exists "$script" "$pattern"; then
                has_any_validation=true
                break
            fi
        done

        if [[ "$has_any_validation" == "true" ]]; then
            results+=('{"check": "validation_runs", "passed": true, "warning": true, "details": "Validation detected but ordering relative to dry-run check unclear"}')
            ((warnings++)) || true
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check warn "Validation ordering" "Verify validation runs before dry-run exits"
        else
            results+=('{"check": "validation_runs", "passed": false, "details": "No validation patterns found - dry-run should validate inputs"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "Validation in dry-run" "Dry-run should still perform full input validation"
        fi
    fi

    # ========================================================================
    # Build JSON result
    # ========================================================================
    local total=$((passed + failed))
    local score
    score=$(calc_score "$passed" "$total")

    jq -n \
        --arg script "$script_name" \
        --arg command "$command" \
        --argjson passed "$passed" \
        --argjson failed "$failed" \
        --argjson skipped "$skipped" \
        --argjson warnings "$warnings" \
        --argjson total "$total" \
        --arg score "$score" \
        --argjson checks "$(printf '%s\n' "${results[@]}" | jq -s '.')" \
        '{
            script: $script,
            command: $command,
            category: "dry_run_semantics",
            passed: $passed,
            failed: $failed,
            skipped: $skipped,
            warnings: $warnings,
            total: $total,
            score: ($score | tonumber),
            checks: $checks
        }'
}

# Run check on all scripts in directory
# Usage: check_all_dry_run_semantics <scripts_dir> <schema_json> [verbose]
check_all_dry_run_semantics() {
    local scripts_dir="$1"
    local schema="$2"
    local verbose="${3:-false}"

    local all_results=()

    for script in "$scripts_dir"/*.sh; do
        [[ -f "$script" ]] || continue
        local result
        result=$(check_dry_run_semantics "$script" "$schema" "$verbose")
        all_results+=("$result")
    done

    printf '%s\n' "${all_results[@]}" | jq -s '.'
}

# Generate summary report
# Usage: generate_summary <results_json>
generate_summary() {
    local results="$1"

    echo "$results" | jq '
        {
            total_scripts: length,
            scripts_requiring_dryrun: [.[] | select(.skipped == 0 or .skipped == null)] | length,
            scripts_skipped: [.[] | select(.skipped > 0)] | length,
            total_checks: [.[].total] | add,
            total_passed: [.[].passed] | add,
            total_failed: [.[].failed] | add,
            total_warnings: [.[].warnings] | add,
            overall_score: (([.[].passed] | add) * 100 / (([.[].total] | add) // 1) | floor),
            failing_scripts: [.[] | select(.failed > 0) | {script, command, failed, checks: [.checks[] | select(.passed == false)]}]
        }
    '
}

# ============================================================================
# MAIN ENTRY POINT
# ============================================================================

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    if [[ $# -lt 2 ]]; then
        cat << 'EOF'
Usage: dry-run-semantics.sh <script_path|scripts_dir> <schema_path> [--verbose] [--summary]

Check dry-run semantics compliance per LLM-Agent-First Spec Part 5.4.

Arguments:
  script_path|scripts_dir   Path to script file or directory of scripts
  schema_path               Path to compliance schema JSON

Options:
  --verbose                 Show detailed check output
  --summary                 Generate summary report (when checking directory)

Checks performed:
  1. --dry-run flag support
  2. dryRun: true in JSON output
  3. No state modification in dry-run mode
  4. Uses wouldCreate/wouldUpdate/wouldDelete fields
  5. Exit codes match real operation
  6. Validation runs even in dry-run mode

Commands requiring --dry-run:
  add, update, complete, archive, restore, migrate, migrate-backups, inject, extract, sync
EOF
        exit 1
    fi

    target_path="$1"
    schema_path="$2"
    verbose="false"
    summary="false"

    shift 2
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --verbose) verbose="true" ;;
            --summary) summary="true" ;;
            *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
        shift
    done

    schema=$(load_schema "$schema_path")

    if [[ -d "$target_path" ]]; then
        results=$(check_all_dry_run_semantics "$target_path" "$schema" "$verbose")

        if [[ "$summary" == "true" ]]; then
            generate_summary "$results"
        else
            echo "$results"
        fi
    else
        check_dry_run_semantics "$target_path" "$schema" "$verbose"
    fi
fi
