#!/usr/bin/env bash
# flags.sh - Check flag support compliance
# Part of LLM-Agent-First Compliance Validator

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/test-helpers.sh"

# Check if script uses centralized flags.sh library
# Usage: uses_centralized_flags <script_path>
# Returns: 0 if using centralized pattern, 1 otherwise
uses_centralized_flags() {
    local script="$1"

    # Check for: source flags.sh AND parse_common_flags call
    if pattern_exists "$script" 'source.*flags\.sh' && \
       pattern_exists "$script" 'parse_common_flags'; then
        return 0
    fi
    return 1
}

# Check flag compliance for a script file
# Usage: check_flags <script_path> <schema_json> <command_name> [verbose]
check_flags() {
    local script="$1"
    local schema="$2"
    local command="${3:-}"
    local verbose="${4:-false}"
    local script_name
    script_name=$(basename "$script")

    # If command not provided, derive from script name
    if [[ -z "$command" ]]; then
        command="${script_name%.sh}"
        command="${command%-task}"
        command="${command%-command}"
        command="${command%-todowrite}"
    fi

    local results=()
    local passed=0
    local failed=0
    local skipped=0

    # Check if script uses centralized flags.sh library
    local uses_central_flags=false
    if uses_centralized_flags "$script"; then
        uses_central_flags=true
        [[ "$verbose" == "true" ]] && print_check info "Using centralized flags.sh library"
    fi

    # Check 1: --format flag
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local format_pattern
    format_pattern="${PATTERN_FORMAT_FLAG:-$(echo "$schema" | jq -r '.requirements.flags.universal.patterns.format_flag')}"

    if [[ "$uses_central_flags" == "true" ]] || pattern_exists "$script" "$format_pattern"; then
        local details="--format flag supported"
        [[ "$uses_central_flags" == "true" ]] && details="--format flag (via flags.sh)"
        results+=("{\"check\": \"format_flag\", \"passed\": true, \"details\": \"$details\"}")
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "--format flag"
    else
        results+=('{"check": "format_flag", "passed": false, "details": "--format flag not found"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "--format flag" "Pattern: $format_pattern"
    fi

    # Check 2: --quiet flag
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local quiet_pattern
    quiet_pattern="${PATTERN_QUIET_FLAG:-$(echo "$schema" | jq -r '.requirements.flags.universal.patterns.quiet_flag')}"

    if [[ "$uses_central_flags" == "true" ]] || pattern_exists "$script" "$quiet_pattern"; then
        local details="--quiet flag supported"
        [[ "$uses_central_flags" == "true" ]] && details="--quiet flag (via flags.sh)"
        results+=("{\"check\": \"quiet_flag\", \"passed\": true, \"details\": \"$details\"}")
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "--quiet flag"
    else
        results+=('{"check": "quiet_flag", "passed": false, "details": "--quiet flag not found"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "--quiet flag" "Pattern: $quiet_pattern"
    fi

    # Check 3: --json shortcut
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local json_pattern
    json_pattern="${PATTERN_JSON_SHORTCUT:-$(echo "$schema" | jq -r '.requirements.flags.universal.patterns.json_shortcut')}"

    if [[ "$uses_central_flags" == "true" ]] || pattern_exists "$script" "$json_pattern"; then
        local details="--json shortcut supported"
        [[ "$uses_central_flags" == "true" ]] && details="--json shortcut (via flags.sh)"
        results+=("{\"check\": \"json_shortcut\", \"passed\": true, \"details\": \"$details\"}")
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "--json shortcut"
    else
        results+=('{"check": "json_shortcut", "passed": false, "details": "--json shortcut not found"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "--json shortcut" "Pattern: $json_pattern"
    fi

    # Check 4: --human shortcut
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local human_pattern
    human_pattern="${PATTERN_HUMAN_SHORTCUT:-$(echo "$schema" | jq -r '.requirements.flags.universal.patterns.human_shortcut')}"

    if [[ "$uses_central_flags" == "true" ]] || pattern_exists "$script" "$human_pattern"; then
        local details="--human shortcut supported"
        [[ "$uses_central_flags" == "true" ]] && details="--human shortcut (via flags.sh)"
        results+=("{\"check\": \"human_shortcut\", \"passed\": true, \"details\": \"$details\"}")
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "--human shortcut"
    else
        results+=('{"check": "human_shortcut", "passed": false, "details": "--human shortcut not found"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "--human shortcut" "Pattern: $human_pattern"
    fi

    # Check 5: resolve_format() called
    # Use pre-extracted pattern from check-compliance.sh if available, fallback to jq
    local resolve_pattern
    resolve_pattern="${PATTERN_RESOLVE_FORMAT:-$(echo "$schema" | jq -r '.requirements.flags.format_resolution.pattern')}"

    if pattern_exists "$script" "$resolve_pattern"; then
        results+=('{"check": "resolve_format", "passed": true, "details": "resolve_format() called for TTY-aware resolution"}')
        ((passed++)) || true
        [[ "$verbose" == "true" ]] && print_check pass "resolve_format() called"
    else
        results+=('{"check": "resolve_format", "passed": false, "details": "resolve_format() not called - TTY detection missing"}')
        ((failed++)) || true
        [[ "$verbose" == "true" ]] && print_check fail "resolve_format()" "TTY-aware format resolution missing"
    fi

    # Check 6-9: --dry-run compliance (only for write commands)
    if needs_dry_run "$command" "$schema"; then
        # Get patterns from schema (with fallbacks)
        local dry_run_flag_pattern
        dry_run_flag_pattern="${PATTERN_DRY_RUN_FLAG:-$(echo "$schema" | jq -r '.requirements.flags.write_commands.patterns.dry_run_flag // "--dry-run\\)"')}"
        local dry_run_var_pattern
        dry_run_var_pattern="${PATTERN_DRY_RUN_VAR:-$(echo "$schema" | jq -r '.requirements.flags.write_commands.patterns.dry_run_variable // "^DRY_RUN=false"')}"
        local dry_run_json_pattern
        dry_run_json_pattern="${PATTERN_DRY_RUN_JSON:-$(echo "$schema" | jq -r '.requirements.flags.write_commands.patterns.dry_run_json_field // "\"dryRun\"[[:space:]]*:[[:space:]]*true"')}"
        local dry_run_would_pattern
        dry_run_would_pattern="${PATTERN_DRY_RUN_WOULD:-$(echo "$schema" | jq -r '.requirements.flags.write_commands.patterns.dry_run_would_naming // "would(Create|Update|Delete|Archive|Restore|Complete|Migrate|Inject|Extract|Set|Start|End)"')}"

        # Check 6: --dry-run flag present
        if pattern_exists "$script" "$dry_run_flag_pattern"; then
            results+=('{"check": "dry_run_flag", "passed": true, "details": "--dry-run flag supported (required for write command)"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "--dry-run flag (required for write command)"
        else
            results+=('{"check": "dry_run_flag", "passed": false, "details": "--dry-run flag missing (required for write command)"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "--dry-run flag" "Required for write commands"
        fi

        # Check 7: DRY_RUN variable properly initialized
        if pattern_exists "$script" "$dry_run_var_pattern"; then
            results+=('{"check": "dry_run_variable", "passed": true, "details": "DRY_RUN variable properly initialized to false"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "DRY_RUN variable initialization"
        else
            results+=('{"check": "dry_run_variable", "passed": false, "details": "DRY_RUN variable not initialized (should be DRY_RUN=false)"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "DRY_RUN variable" "Must be initialized to false"
        fi

        # Check 8: Dry-run output includes dryRun: true field
        if pattern_exists "$script" "$dry_run_json_pattern"; then
            results+=('{"check": "dry_run_json_field", "passed": true, "details": "Dry-run JSON output includes dryRun: true field"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "dryRun JSON field in output"
        else
            results+=('{"check": "dry_run_json_field", "passed": false, "details": "Dry-run JSON output missing dryRun: true field"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "dryRun JSON field" "Output must include \"dryRun\": true"
        fi

        # Check 9: Dry-run uses would* naming convention
        if pattern_exists "$script" "$dry_run_would_pattern"; then
            results+=('{"check": "dry_run_would_naming", "passed": true, "details": "Dry-run output uses would* naming convention"}')
            ((passed++)) || true
            [[ "$verbose" == "true" ]] && print_check pass "would* naming convention"
        else
            results+=('{"check": "dry_run_would_naming", "passed": false, "details": "Dry-run output missing would* naming (wouldCreate, wouldUpdate, etc.)"}')
            ((failed++)) || true
            [[ "$verbose" == "true" ]] && print_check fail "would* naming" "Use wouldCreate/wouldUpdate/wouldDelete/wouldArchive"
        fi
    else
        results+=('{"check": "dry_run_flag", "passed": true, "skipped": true, "details": "--dry-run not required (read-only command)"}')
        ((skipped++)) || true
        [[ "$verbose" == "true" ]] && print_check skip "--dry-run (not required for read command)"
        # Skip additional dry-run checks for read commands
        results+=('{"check": "dry_run_variable", "passed": true, "skipped": true, "details": "DRY_RUN variable not required (read-only command)"}')
        ((skipped++)) || true
        results+=('{"check": "dry_run_json_field", "passed": true, "skipped": true, "details": "dryRun JSON field not required (read-only command)"}')
        ((skipped++)) || true
        results+=('{"check": "dry_run_would_naming", "passed": true, "skipped": true, "details": "would* naming not required (read-only command)"}')
        ((skipped++)) || true
    fi

    # Build JSON result
    local total=$((passed + failed))
    local score
    score=$(calc_score "$passed" "$total")

    jq -n \
        --arg script "$script_name" \
        --arg command "$command" \
        --argjson passed "$passed" \
        --argjson failed "$failed" \
        --argjson skipped "$skipped" \
        --argjson total "$total" \
        --arg score "$score" \
        --argjson checks "$(printf '%s\n' "${results[@]}" | jq -s '.')" \
        '{
            script: $script,
            command: $command,
            category: "flags",
            passed: $passed,
            failed: $failed,
            skipped: $skipped,
            total: $total,
            score: ($score | tonumber),
            checks: $checks
        }'
}

# Run check on all scripts in directory
# Usage: check_all_flags <scripts_dir> <schema_json> [verbose]
check_all_flags() {
    local scripts_dir="$1"
    local schema="$2"
    local verbose="${3:-false}"

    local all_results=()

    for script in "$scripts_dir"/*.sh; do
        [[ -f "$script" ]] || continue
        local result
        result=$(check_flags "$script" "$schema" "" "$verbose")
        all_results+=("$result")
    done

    printf '%s\n' "${all_results[@]}" | jq -s '.'
}

# Main entry point when run directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    if [[ $# -lt 2 ]]; then
        echo "Usage: $0 <script_path> <schema_path> [command_name] [--verbose]"
        exit 1
    fi

    script_path="$1"
    schema_path="$2"
    command_name="${3:-}"
    verbose="false"

    # Check if command_name is actually --verbose
    if [[ "$command_name" == "--verbose" ]]; then
        command_name=""
        verbose="true"
    elif [[ "${4:-}" == "--verbose" ]]; then
        verbose="true"
    fi

    schema=$(load_schema "$schema_path")
    check_flags "$script_path" "$schema" "$command_name" "$verbose"
fi
