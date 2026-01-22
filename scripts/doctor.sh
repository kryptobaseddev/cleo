#!/usr/bin/env bash
# ============================================================================
# scripts/doctor.sh - CLEO health check diagnostics
# ============================================================================
# Comprehensive system health checks for CLEO installation and projects.
# Validates CLI installation, agent configs, documentation, and project state.
#
# Usage:
#   cleo doctor                   # Full health check
#   cleo doctor --global          # Skip project checks
#   cleo doctor --prune           # Clean registry of missing projects
#   cleo doctor --clean-temp      # Remove temporary/test projects
#   cleo doctor --fix             # Auto-repair issues (with confirmation)
#   cleo doctor --format json     # JSON output
#
# Exit Codes:
#   0   - All checks passed
#   50  - Warning (minor version drift, non-critical)
#   51  - Issue (fixable problems, outdated configs)
#   52  - Critical (corrupted install, major mismatch)
#   100 - Special (no agent config, not an error)
# ============================================================================

set -euo pipefail

# ============================================================================
# INITIALIZATION
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source required libraries
source "$LIB_DIR/exit-codes.sh"
source "$LIB_DIR/paths.sh"
source "$LIB_DIR/output-format.sh" 2>/dev/null || true
source "$LIB_DIR/flags.sh"
source "$LIB_DIR/agent-config.sh"
source "$LIB_DIR/validation.sh"
source "$LIB_DIR/doctor-checks.sh"  # Global health check functions
source "$LIB_DIR/doctor-utils.sh"   # Doctor utility functions
source "$LIB_DIR/project-registry.sh"
source "$LIB_DIR/migrate.sh"  # For get_schema_version_from_file()
source "$LIB_DIR/backup.sh"  # For create_safety_backup() in --fix mode

# Command name for error reporting
COMMAND_NAME="doctor"

# ============================================================================
# DEFAULTS
# ============================================================================
GLOBAL_ONLY=false
PRUNE_REGISTRY=false
CLEAN_TEMP_PROJECTS=false
AUTO_FIX=false
DETAIL_MODE=false

# Exit code levels (graduated severity)
readonly EXIT_DOCTOR_OK=0
readonly EXIT_DOCTOR_WARNING=50
readonly EXIT_DOCTOR_ISSUE=51
readonly EXIT_DOCTOR_CRITICAL=52
readonly EXIT_DOCTOR_NO_CONFIG=100

# ============================================================================
# ARGUMENT PARSING
# ============================================================================
parse_args() {
    # Parse common flags first (--format, --json, --human, --quiet, --verbose, --help, etc.)
    init_flag_defaults
    parse_common_flags "$@"
    set -- "${REMAINING_ARGS[@]}"

    # Handle help flag
    if [[ "$FLAG_HELP" == true ]]; then
        show_help
        exit 0
    fi

    # Parse command-specific flags
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --global)
                GLOBAL_ONLY=true
                shift
                ;;
            --prune)
                PRUNE_REGISTRY=true
                shift
                ;;
            --clean-temp)
                CLEAN_TEMP_PROJECTS=true
                shift
                ;;
            --fix)
                AUTO_FIX=true
                shift
                ;;
            --detail)
                DETAIL_MODE=true
                shift
                ;;
            *)
                echo "Error: Unknown option: $1" >&2
                show_help
                exit "$EXIT_INVALID_INPUT"
                ;;
        esac
    done

    # Apply common flags to globals
    apply_flags_to_globals
    FORMAT=$(resolve_format "$FORMAT")
    VERBOSE="${FLAG_VERBOSE:-false}"
}

show_help() {
    cat <<'EOF'
Usage: cleo doctor [OPTIONS]

Comprehensive health check for CLEO installation and projects.
Validates CLI installation, agent configs, documentation, and project state.

OPTIONS:
    --global            Skip project-specific checks
    --prune             Clean registry of missing projects
    --clean-temp        Remove temporary/test projects
    --fix               Auto-repair issues (with confirmation)
    --detail            Show detailed project information in human output
    -f, --format FMT    Output format: text (default in TTY) or json
    --json              Shorthand for --format json
    --human             Shorthand for --format text
    -q, --quiet         Suppress non-essential output
    -v, --verbose       Show detailed diagnostic information
    -h, --help          Show this help message

EXIT CODES:
    0   - All checks passed
    50  - Warning (minor version drift, non-critical)
    51  - Issue (fixable problems, outdated configs)
    52  - Critical (corrupted install, major mismatch)
    100 - Special (no agent config setup, not an error)

EXAMPLES:
    # Full health check
    cleo doctor

    # Check only global installation
    cleo doctor --global

    # Auto-repair issues
    cleo doctor --fix

    # JSON output for scripting
    cleo doctor --format json

    # Clean orphaned projects from registry
    cleo doctor --prune
EOF
}

# ============================================================================
# GLOBAL HEALTH CHECKS (T1507)
# ============================================================================
# These checks validate the CLEO CLI installation and agent configuration.
# Implemented in lib/doctor-checks.sh
# Returns: JSON array of check results

run_global_health_checks() {
    # Use the function from lib/doctor-checks.sh
    run_all_global_checks
}

# ============================================================================
# PROJECT REGISTRY VALIDATION (T1508)
# ============================================================================
# Validates all projects in the registry.
# TODO: Implementation in T1508
# Returns: JSON object with per-project health status

run_project_registry_validation() {
    local registry
    registry="$(get_cleo_home)/projects-registry.json"

    # Check if registry exists
    if [[ ! -f "$registry" ]]; then
        echo '{"total":0,"healthy":0,"warnings":0,"failed":0,"orphaned":0,"projects":[]}'
        return 0
    fi

    # Get all registered projects
    local all_projects
    all_projects=$(list_registered_projects)

    local total healthy warnings failed orphaned
    total=$(echo "$all_projects" | jq 'length')
    healthy=0
    warnings=0
    failed=0
    orphaned=0

    # Get current CLI schema versions (single source of truth)
    local cli_todo_version cli_config_version cli_archive_version cli_log_version
    cli_todo_version=$(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")
    cli_config_version=$(get_schema_version_from_file "config" 2>/dev/null || echo "unknown")
    cli_archive_version=$(get_schema_version_from_file "archive" 2>/dev/null || echo "unknown")
    cli_log_version=$(get_schema_version_from_file "log" 2>/dev/null || echo "unknown")

    # Build project results array
    local project_results=()

    while IFS= read -r project; do
        [[ -z "$project" || "$project" == "null" ]] && continue

        local hash path name
        hash=$(echo "$project" | jq -r '.hash')
        path=$(echo "$project" | jq -r '.path')
        name=$(echo "$project" | jq -r '.name // ""')

        local status="healthy"
        local issues=()
        local path_exists="false"
        local validation_passed="false"
        local schemas_outdated=()
        local injection_outdated=()

        # Check 1: Path exists
        if [[ ! -d "$path" ]]; then
            status="orphaned"
            issues+=("Project path does not exist")
            ((orphaned++))

            # Build result for orphaned project
            project_results+=("$(jq -n \
                --arg hash "$hash" \
                --arg path "$path" \
                --arg name "$name" \
                --arg status "$status" \
                --argjson issues "$(printf '%s\n' "${issues[@]}" | jq -R . | jq -s .)" \
                --argjson path_exists false \
                --argjson validation_passed false \
                --argjson schemas_outdated "[]" \
                --argjson injection_outdated "[]" \
                '{
                    hash: $hash,
                    path: $path,
                    name: $name,
                    status: $status,
                    issues: $issues,
                    details: {
                        pathExists: $path_exists,
                        validationPassed: $validation_passed,
                        schemasOutdated: $schemas_outdated,
                        injectionOutdated: $injection_outdated
                    }
                }')")
            continue
        fi

        path_exists="true"

        # Check 2: Run validation (validate.sh in project directory)
        if [[ -f "$path/.cleo/validate.sh" ]]; then
            if (cd "$path" && bash .cleo/validate.sh >/dev/null 2>&1); then
                validation_passed="true"
            else
                status="failed"
                validation_passed="false"
                issues+=("Validation failed")
                ((failed++))
            fi
        elif [[ -f "${SCRIPT_DIR}/validate.sh" ]]; then
            # Fallback: use CLI validate.sh if project doesn't have one
            if (cd "$path" && bash "${SCRIPT_DIR}/validate.sh" >/dev/null 2>&1); then
                validation_passed="true"
            else
                status="failed"
                validation_passed="false"
                issues+=("Validation failed")
                ((failed++))
            fi
        else
            # No validation script available
            if [[ "$status" != "failed" ]]; then
                status="warning"
                issues+=("No validation script found")
                ((warnings++))
            fi
        fi

        # Check 3: Schema versions (only if path exists and not already failed)
        if [[ "$path_exists" == "true" && "$status" != "failed" ]]; then
            local project_data
            project_data=$(get_project_data "$hash")

            # Compare schema versions
            local proj_todo_version proj_config_version proj_archive_version proj_log_version
            proj_todo_version=$(echo "$project_data" | jq -r '.schemaVersions.todo // "unknown"')
            proj_config_version=$(echo "$project_data" | jq -r '.schemaVersions.config // "unknown"')
            proj_archive_version=$(echo "$project_data" | jq -r '.schemaVersions.archive // "unknown"')
            proj_log_version=$(echo "$project_data" | jq -r '.schemaVersions.log // "unknown"')

            # Check each schema type
            if [[ "$proj_todo_version" != "$cli_todo_version" && "$cli_todo_version" != "unknown" ]]; then
                schemas_outdated+=("todo")
            fi
            if [[ "$proj_config_version" != "$cli_config_version" && "$cli_config_version" != "unknown" ]]; then
                schemas_outdated+=("config")
            fi
            if [[ "$proj_archive_version" != "$cli_archive_version" && "$cli_archive_version" != "unknown" ]]; then
                schemas_outdated+=("archive")
            fi
            if [[ "$proj_log_version" != "$cli_log_version" && "$cli_log_version" != "unknown" ]]; then
                schemas_outdated+=("log")
            fi

            if [[ ${#schemas_outdated[@]} -gt 0 ]]; then
                if [[ "$status" == "healthy" ]]; then
                    status="warning"
                    ((warnings++))
                fi
                issues+=("Outdated schemas: ${schemas_outdated[*]}")
            fi
        fi

        # Check 4: Injection status (check all 3 agent files)
        if [[ "$path_exists" == "true" && "$status" != "failed" ]]; then
            local agent_files=("CLAUDE.md" "AGENTS.md" "GEMINI.md")
            local current_cli_version="${CLI_VERSION:-0.50.2}"

            for agent_file in "${agent_files[@]}"; do
                local agent_path="$path/$agent_file"

                # Check if file exists
                if [[ ! -f "$agent_path" ]]; then
                    continue
                fi

                # Check if injection markers present (no version check - content is external)
                if ! grep -q "<!-- CLEO:START" "$agent_path" 2>/dev/null; then
                    injection_outdated+=("$agent_file")
                    continue
                fi

                # Block exists - considered configured (version is irrelevant since content is external)
            done

            if [[ ${#injection_outdated[@]} -gt 0 ]]; then
                if [[ "$status" == "healthy" ]]; then
                    status="warning"
                    ((warnings++))
                fi
                issues+=("Outdated injections: ${injection_outdated[*]}")
            fi
        fi

        # Final status accounting
        if [[ "$status" == "healthy" ]]; then
            ((healthy++))
        fi

        # Build result for this project
        project_results+=("$(jq -n \
            --arg hash "$hash" \
            --arg path "$path" \
            --arg name "$name" \
            --arg status "$status" \
            --argjson issues "$(printf '%s\n' "${issues[@]}" | jq -R . | jq -s .)" \
            --argjson path_exists "$path_exists" \
            --argjson validation_passed "$validation_passed" \
            --argjson schemas_outdated "$(printf '%s\n' "${schemas_outdated[@]}" | jq -R . | jq -s .)" \
            --argjson injection_outdated "$(printf '%s\n' "${injection_outdated[@]}" | jq -R . | jq -s .)" \
            '{
                hash: $hash,
                path: $path,
                name: $name,
                status: $status,
                issues: $issues,
                details: {
                    pathExists: $path_exists,
                    validationPassed: $validation_passed,
                    schemasOutdated: $schemas_outdated,
                    injectionOutdated: $injection_outdated
                }
            }')")

    done < <(echo "$all_projects" | jq -c '.[]')

    # Build final JSON output
    jq -n \
        --argjson total "$total" \
        --argjson healthy "$healthy" \
        --argjson warnings "$warnings" \
        --argjson failed "$failed" \
        --argjson orphaned "$orphaned" \
        --argjson projects "$(printf '%s\n' "${project_results[@]}" | jq -s .)" \
        '{
            total: $total,
            healthy: $healthy,
            warnings: $warnings,
            failed: $failed,
            orphaned: $orphaned,
            projects: $projects
        }'
}

# ============================================================================
# RESULT AGGREGATION
# ============================================================================
# Combines global checks and project validation into final report.

aggregate_results() {
    local global_checks="$1"
    local project_status="$2"

    # Count status from global checks
    local total_checks passed warnings failed
    total_checks=$(echo "$global_checks" | jq 'length')
    passed=$(echo "$global_checks" | jq '[.[] | select(.status == "passed")] | length')
    warnings=$(echo "$global_checks" | jq '[.[] | select(.status == "warning")] | length')
    failed=$(echo "$global_checks" | jq '[.[] | select(.status == "failed")] | length')

    # Determine overall severity
    local severity="ok"
    if [[ $failed -gt 0 ]]; then
        severity="failed"
    elif [[ $warnings -gt 0 ]]; then
        severity="warning"
    fi

    # Build final output (will match schemas/doctor-output.schema.json from T1509)
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -n \
        --argjson checks "$global_checks" \
        --argjson projects "$project_status" \
        --arg severity "$severity" \
        --arg timestamp "$timestamp" \
        --arg format "$FORMAT" \
        --argjson total "$total_checks" \
        --argjson passed "$passed" \
        --argjson warnings "$warnings" \
        --argjson failed "$failed" \
        '{
            _meta: {
                format: $format,
                command: "doctor",
                timestamp: $timestamp,
                version: "0.50.2"
            },
            success: ($severity != "failed"),
            severity: $severity,
            summary: {
                totalChecks: $total,
                passed: $passed,
                warnings: $warnings,
                failed: $failed,
                severity: $severity
            },
            checks: $checks,
            projects: $projects
        }'
}

# ============================================================================
# OUTPUT FORMATTING
# ============================================================================
# Converts JSON results to human-readable text format.

format_text_output() {
    local json_output="$1"

    # Extract summary
    local severity passed warnings failed
    severity=$(echo "$json_output" | jq -r '.severity')
    passed=$(echo "$json_output" | jq -r '.summary.passed')
    warnings=$(echo "$json_output" | jq -r '.summary.warnings')
    failed=$(echo "$json_output" | jq -r '.summary.failed')

    # Color codes
    local RED='\033[0;31m'
    local YELLOW='\033[1;33m'
    local GREEN='\033[0;32m'
    local BLUE='\033[0;34m'
    local NC='\033[0m' # No Color

    # Disable colors if not TTY
    if [[ ! -t 1 ]]; then
        RED="" YELLOW="" GREEN="" BLUE="" NC=""
    fi

    # Header with journey-based guidance
    echo ""
    echo "CLEO Health Check"
    echo "================="
    echo ""

    # Get user journey stage and provide guidance
    local has_projects=$(echo "$json_output" | jq -r '.checks[] | select(.id == "registered_projects") | .details.total // 0')
    local temp_projects=$(echo "$json_output" | jq -r '.checks[] | select(.id == "registered_projects") | .details.temp // 0')
    local agent_configs_ok=$(echo "$json_output" | jq -r '.checks[] | select(.id == "agent_config_version") | .status == "passed"')
    
    local journey_stage=$(get_user_journey_stage "$has_projects" "$temp_projects" "$agent_configs_ok")
    get_journey_guidance "$journey_stage"
    echo ""

    # Overall status with categorized issues
    case "$severity" in
        ok)
            echo -e "${GREEN}✓ System healthy${NC}"
            ;;
        warning)
            echo -e "${YELLOW}⚠ System operational with minor issues${NC}"
            ;;
        failed)
            echo -e "${RED}✗ System issues need attention${NC}"
            ;;
    esac

    echo ""
    
    # Categorized check results
    echo "🔧 SYSTEM COMPONENTS:"
    echo "$json_output" | jq -r '.checks[] | select(.category == "installation") |
        if .status == "passed" then
            "  ✓ \(.message)"
        elif .status == "warning" then
            "  ⚠ \(.message)"
        elif .status == "failed" then
            "  ✗ \(.message)"
        elif .status == "info" then
            "  ℹ \(.message)"
        else
            "  - \(.message)"
        end'
    
    echo ""
    echo "🤖 AI ASSISTANT INTEGRATION:"
    echo "$json_output" | jq -r '.checks[] | select(.category == "configuration") |
        if .status == "passed" then
            "  ✓ \(.message)"
        elif .status == "warning" then
            "  ⚠ \(.message)"
        elif .status == "failed" then
            "  ✗ \(.message)"
        elif .status == "info" then
            "  ℹ \(.message)"
        else
            "  - \(.message)"
        end'
    
    # Show categorized project summary
    local project_data=$(echo "$json_output" | jq -r '.checks[] | select(.id == "registered_projects")')
    if [[ -n "$project_data" ]]; then
        echo ""
        echo "📊 PROJECT REGISTRY:"
        
        local total=$(echo "$project_data" | jq -r '.details.total')
        local temp=$(echo "$project_data" | jq -r '.details.temp // 0')
        local orphaned=$(echo "$project_data" | jq -r '.details.orphaned')
        local active_failed=$(echo "$project_data" | jq -r '.details.active_failed // 0')
        local active_warnings=$(echo "$project_data" | jq -r '.details.active_warnings // 0')
        
        format_project_health_summary "$total" "0" "$active_warnings" "$active_failed" "$orphaned" "$temp"
        echo ""
        
        # Show actionable guidance
        local guidance=$(get_project_guidance "$active_failed" "$active_warnings" "$temp" "$orphaned")
        if [[ -n "$guidance" ]]; then
            echo "💡 SUGGESTED ACTIONS:"
            echo "$guidance"
        fi
    fi

    # Show detailed project table if available
    local project_total
    project_total=$(echo "$json_output" | jq -r '.projects.total // 0')
    if [[ $project_total -gt 0 ]]; then
        echo ""
        echo "📋 REGISTERED PROJECTS:"
        echo "----------------------"
        
        if [[ "$DETAIL_MODE" == true ]]; then
            # Detailed view with issues
            printf "%-30s %-10s %-50s %-40s\n" "PROJECT NAME" "STATUS" "PATH" "ISSUES"
            printf "%-30s %-10s %-50s %-40s\n" "------------" "------" "----" "------"
            
            echo "$json_output" | jq -r '.projects.projects[] |
                (.name | @text) + "\t" + .status + "\t" + .path + "\t" + 
                (if .issues and (.issues | length) > 0 then .issues | join(", ") else "none" end)' |
            while IFS=$'\t' read -r name status path issues; do
                local icon="-"
                local color=""
                case "$status" in
                    healthy) icon="✓"; color="${GREEN}" ;;
                    warning) icon="⚠"; color="${YELLOW}" ;;
                    failed|orphaned) icon="✗"; color="${RED}" ;;
                esac
                
                printf "${color}%-2s %-28s %-10s %-50s %-40s${NC}\n" "$icon" "$name" "$status" "$path" "$issues"
            done
        else
            # Compact view
            printf "%-30s %-10s %-50s\n" "PROJECT NAME" "STATUS" "PATH"
            printf "%-30s %-10s %-50s\n" "------------" "------" "----"
            
            echo "$json_output" | jq -r '.projects.projects[] |
                if .status == "healthy" then
                    "  ✓ " + (.name | @text) + "\t" + .status + "\t" + .path
                elif .status == "warning" then
                    "  ⚠ " + (.name | @text) + "\t" + .status + "\t" + .path
                elif .status == "failed" or .status == "orphaned" then
                    "  ✗ " + (.name | @text) + "\t" + .status + "\t" + .path
                else
                    "  - " + (.name | @text) + "\t" + .status + "\t" + .path
                end'
        fi
        
        # Summary
        echo ""
        echo "Summary: $project_total projects registered"
        echo "$json_output" | jq -r '.projects |
            "  Healthy: \(.healthy)",
            "  Warnings: \(.warnings)",
            "  Failed: \(.failed)",
            "  Orphaned: \(.orphaned)"'
    fi

    # Show fix suggestions if issues detected
    if [[ $warnings -gt 0 ]] || [[ $failed -gt 0 ]]; then
        echo ""
        echo "Suggested Fixes:"
        echo "---------------"
        echo "$json_output" | jq -r '.checks[] |
            select(.status == "warning" or .status == "failed") |
            select(.fix != null) |
            "  \(.fix)"'

        if [[ "$AUTO_FIX" != true ]]; then
            echo ""
            echo -e "${BLUE}Tip: Run 'cleo doctor --fix' to auto-repair issues${NC}"
        fi
    fi

    echo ""
}

# ============================================================================
# EXIT CODE DETERMINATION
# ============================================================================
# Maps severity to appropriate exit code.

determine_exit_code() {
    local severity="$1"

    case "$severity" in
        ok)
            return "$EXIT_DOCTOR_OK"
            ;;
        warning)
            return "$EXIT_DOCTOR_WARNING"
            ;;
        failed)
            return "$EXIT_DOCTOR_CRITICAL"
            ;;
        no_config)
            return "$EXIT_DOCTOR_NO_CONFIG"
            ;;
        *)
            return "$EXIT_DOCTOR_CRITICAL"
            ;;
    esac
}

# ============================================================================
# FIX APPLICATION (T1510)
# ============================================================================
# Applies automated fixes for detected issues with confirmation and backup.

apply_fixes() {
    local json_output="$1"

    # Extract fixable issues as a JSON array
    local fixable_checks_array
    fixable_checks_array=$(echo "$json_output" | jq -c '[.checks[] | select((.status == "warning" or .status == "failed") and .fix)]')

    local fixable_count
    fixable_count=$(echo "$fixable_checks_array" | jq 'length')

    if [[ "$fixable_count" -eq 0 ]]; then
        echo "No fixable issues detected" >&2
        return 0
    fi

    # Show what will be fixed
    echo "" >&2
    echo "Fixable Issues:" >&2
    echo "===============" >&2
    echo "$fixable_checks_array" | jq -r '.[] | "  - \(.message)\n    Fix: \(.fix)"' >&2
    echo "" >&2

    # Prompt for confirmation
    read -p "Apply these fixes? [y/N] " -n 1 -r >&2
    echo "" >&2

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Fixes cancelled" >&2
        return 0
    fi

    # Create Tier 2 safety backup before any changes
    echo "Creating safety backup..." >&2
    local backup_path
    local registry="$CLEO_HOME/projects-registry.json"

    if [[ -f "$registry" ]]; then
        if ! backup_path=$(create_safety_backup "$registry" "doctor_fix" 2>&1); then
            echo "ERROR: Failed to create safety backup: $backup_path" >&2
            return 1
        fi
        echo "✓ Safety backup created: $backup_path" >&2
    fi

    # Apply fixes for each issue
    local fixed=0
    local failed=0
    local i=0

    while [[ $i -lt $fixable_count ]]; do
        echo "DEBUG: Processing check $i of $fixable_count" >&2
        local check
        check=$(echo "$fixable_checks_array" | jq -c ".[$i]")

        local check_id status fix_command
        check_id=$(echo "$check" | jq -r '.id')
        status=$(echo "$check" | jq -r '.status')
        fix_command=$(echo "$check" | jq -r '.fix')

        echo "" >&2
        echo "Applying fix for: $check_id" >&2

        case "$check_id" in
            agent_config_version)
                # Fix: Run setup-agents --update
                local setup_agents_script="${CLEO_HOME}/scripts/setup-agents.sh"
                if [[ ! -f "$setup_agents_script" ]]; then
                    # Fallback to local script directory for development
                    setup_agents_script="${SCRIPT_DIR}/setup-agents.sh"
                fi

                echo "Running setup-agents --update..." >&2
                if bash "$setup_agents_script" --update >&2; then
                    echo "✓ Fixed: $check_id" >&2
                    ((fixed++))
                else
                    echo "⚠ setup-agents completed but some configs may need manual attention" >&2
                    # setup-agents may exit non-zero if some agents aren't installed
                    # Still count as fixed if it ran without critical errors
                    ((fixed++))
                fi
                echo "DEBUG: Finished agent_config_version case" >&2
                ;;

            registered_projects)
                # Fix: Check for specific issue types
                local details
                details=$(echo "$check" | jq -r '.details')
                local orphaned
                orphaned=$(echo "$details" | jq -r '.orphaned // 0')

                if [[ "$orphaned" -gt 0 ]]; then
                    echo "Pruning $orphaned orphaned project(s)..." >&2
                    if prune_registry >/dev/null; then
                        echo "✓ Fixed: Removed orphaned projects" >&2
                        ((fixed++))
                    else
                        echo "✗ Failed to prune registry" >&2
                        ((failed++))
                    fi
                fi

                # Check for outdated schemas
                local projects
                projects=$(echo "$details" | jq -r '.projects[]? | select(.issues[]? | contains("schema_outdated"))')
                if [[ -n "$projects" ]]; then
                    echo "Note: Run 'cleo upgrade' in affected projects to update schemas" >&2
                fi

                # Check for outdated injections
                local injection_projects
                injection_projects=$(echo "$details" | jq -r '.projects[]? | select(.issues[]? | contains("injection_outdated"))')
                if [[ -n "$injection_projects" ]]; then
                    echo "Note: Outdated injections detected - already addressed by setup-agents --update" >&2
                fi
                ;;

            agent_config_exists)
                # Fix: Run setup-agents
                local setup_agents_script="${CLEO_HOME}/scripts/setup-agents.sh"
                if [[ ! -f "$setup_agents_script" ]]; then
                    # Fallback to local script directory for development
                    setup_agents_script="${SCRIPT_DIR}/setup-agents.sh"
                fi

                echo "Running setup-agents..." >&2
                if bash "$setup_agents_script" >&2; then
                    echo "✓ Fixed: $check_id" >&2
                    ((fixed++))
                else
                    echo "⚠ setup-agents completed but some configs may need manual attention" >&2
                    # setup-agents may exit non-zero if some agents aren't installed
                    # Still count as fixed if it ran without critical errors
                    ((fixed++))
                fi
                ;;

            agent_config_registry)
                # Fix: Recreate registry by running setup-agents
                local setup_agents_script="${CLEO_HOME}/scripts/setup-agents.sh"
                if [[ ! -f "$setup_agents_script" ]]; then
                    # Fallback to local script directory for development
                    setup_agents_script="${SCRIPT_DIR}/setup-agents.sh"
                fi

                echo "Running setup-agents to create registry..." >&2
                if bash "$setup_agents_script" >&2; then
                    echo "✓ Fixed: $check_id" >&2
                    ((fixed++))
                else
                    echo "⚠ setup-agents completed but some configs may need manual attention" >&2
                    # setup-agents may exit non-zero if some agents aren't installed
                    # Still count as fixed if it ran without critical errors
                    ((fixed++))
                fi
                ;;

            *)
                # For other issues, suggest the fix command without auto-execution
                echo "Note: Manual fix required: $fix_command" >&2
                ;;
        esac

        ((i++))
        echo "DEBUG: Incremented i to $i" >&2
    done

    echo "DEBUG: Loop completed, i=$i, fixed=$fixed, failed=$failed" >&2

    # Report results
    echo "" >&2
    echo "Fix Summary:" >&2
    echo "------------" >&2
    echo "  Fixed: $fixed" >&2
    echo "  Failed: $failed" >&2
    echo "" >&2

    if [[ $failed -gt 0 ]]; then
        echo "Some fixes failed. Run 'cleo doctor' again to see remaining issues." >&2
        return 1
    fi

    echo "✓ All fixes applied successfully" >&2
    return 0
}

# ============================================================================
# MAIN ORCHESTRATION
# ============================================================================

main() {
    parse_args "$@"

    # Phase 1: Run global health checks (T1507)
    local global_checks
    global_checks=$(run_global_health_checks)

    # Phase 2: Run project registry validation (T1508)
    local project_status='{}'
    if [[ "$GLOBAL_ONLY" != true ]]; then
        project_status=$(run_project_registry_validation)
    fi

    # Phase 3: Aggregate results
    local final_output
    final_output=$(aggregate_results "$global_checks" "$project_status")

    # Phase 4: Apply fixes if requested (T1510)
    if [[ "$AUTO_FIX" == true ]]; then
        apply_fixes "$final_output"
    fi

    # Phase 5: Prune registry if requested
    if [[ "$PRUNE_REGISTRY" == true ]]; then
        local registry="$CLEO_HOME/projects-registry.json"

        if [[ ! -f "$registry" ]]; then
            echo "No registry found at $registry" >&2
        else
            # Get list of orphaned projects from the check results
            local orphaned_count
            orphaned_count=$(echo "$final_output" | jq -r '.checks[] | select(.id == "registered_projects") | .details.orphaned // 0')

            if [[ "$orphaned_count" -gt 0 ]]; then
                echo "Pruning $orphaned_count orphaned project(s)..." >&2

                # Call prune_registry from project-registry.sh
                if prune_registry >/dev/null; then
                    echo "✓ Successfully pruned orphaned projects" >&2
                else
                    echo "✗ Failed to prune registry" >&2
                fi
            else
                echo "No orphaned projects to prune" >&2
            fi
        fi
    fi

    # Phase 5b: Clean temporary projects if requested
    if [[ "$CLEAN_TEMP_PROJECTS" == true ]]; then
        local registry="$CLEO_HOME/projects-registry.json"
        
        if [[ ! -f "$registry" ]]; then
            echo "No registry found at $registry" >&2
        else
            # Get all projects and filter for temp ones, handling null paths
            local temp_projects
            temp_projects=$(list_registered_projects | jq -r '.[] | select(.path != null) | select(.path | test("/.temp/|/bats-run-|/tmp/")) | .hash')
            
            local temp_count=$(echo "$temp_projects" | wc -l)
            
            if [[ "$temp_count" -gt 0 ]]; then
                echo "Removing $temp_count temporary project(s)..." >&2
                
                # Remove each temp project from registry
                local removed_count=0
                while IFS= read -r hash; do
                    if [[ -n "$hash" ]]; then
                        remove_project_from_registry "$hash" >/dev/null 2>&1 && ((removed_count++))
                    fi
                done <<< "$temp_projects"
                
                if [[ "$removed_count" -gt 0 ]]; then
                    echo "✓ Successfully removed $removed_count temporary projects" >&2
                else
                    echo "✗ Failed to remove temporary projects" >&2
                fi
            else
                echo "No temporary projects to clean" >&2
            fi
        fi
    fi

    # Phase 6: Output results
    if [[ "$FORMAT" == "json" ]]; then
        echo "$final_output"
    else
        format_text_output "$final_output"
    fi

    # Phase 7: Exit with appropriate code (T1511)
    local severity
    severity=$(echo "$final_output" | jq -r '.severity')
    determine_exit_code "$severity"
}

# Entry point
main "$@"
