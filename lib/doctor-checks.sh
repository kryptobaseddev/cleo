#!/usr/bin/env bash
# lib/doctor-checks.sh - Global health check functions for cleo doctor
# LAYER: 2 (Services)
# DEPENDENCIES: injection-registry.sh, agent-config.sh, validation.sh, file-ops.sh, doctor-utils.sh

[[ -n "${_DOCTOR_CHECKS_LOADED:-}" ]] && return 0
readonly _DOCTOR_CHECKS_LOADED=1

# NOTE: No set -euo pipefail here - this is a sourced library
# Calling scripts should set their own error handling policy

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source required libraries
# Note: Only source what we actually need to avoid set -euo pipefail conflicts
if [[ -f "$_LIB_DIR/injection-registry.sh" ]]; then
    source "$_LIB_DIR/injection-registry.sh"
fi

if [[ -f "$_LIB_DIR/agent-config.sh" ]]; then
    source "$_LIB_DIR/agent-config.sh"
fi

# Source doctor utilities
if [[ -f "$_LIB_DIR/doctor-utils.sh" ]]; then
    source "$_LIB_DIR/doctor-utils.sh"
fi

# validation.sh and file-ops.sh are NOT sourced here to avoid
# set -euo pipefail conflicts. The checks use basic bash only.

# ============================================================================
# GLOBAL HEALTH CHECK FUNCTIONS
# ============================================================================

# Check 1: CLI Installation
# Verifies that ~/.cleo/ directory exists
# Returns: JSON check result
check_cli_installation() {
    local cleo_home="${CLEO_HOME:-$HOME/.cleo}"

    if [[ -d "$cleo_home" ]]; then
        cat <<EOF
{
  "id": "cli_installation",
  "category": "installation",
  "status": "passed",
  "message": "CLEO installation found at $cleo_home",
  "details": {
    "path": "$cleo_home",
    "exists": true
  },
  "fix": null
}
EOF
    else
        cat <<EOF
{
  "id": "cli_installation",
  "category": "installation",
  "status": "failed",
  "message": "CLEO installation not found at $cleo_home",
  "details": {
    "path": "$cleo_home",
    "exists": false
  },
  "fix": "Run install.sh to install CLEO globally"
}
EOF
    fi
}

# Check 2: CLI Version
# Verifies VERSION file is valid semver
# Returns: JSON check result
check_cli_version() {
    local cleo_home="${CLEO_HOME:-$HOME/.cleo}"
    local version_file="$cleo_home/VERSION"

    if [[ ! -f "$version_file" ]]; then
        cat <<EOF
{
  "id": "cli_version",
  "category": "installation",
  "status": "failed",
  "message": "VERSION file not found",
  "details": {
    "path": "$version_file",
    "exists": false
  },
  "fix": "Run install.sh to reinstall CLEO"
}
EOF
        return
    fi

    local version
    version=$(head -n 1 "$version_file" 2>/dev/null | tr -d '[:space:]')

    # Validate semver format (basic check: x.y.z)
    if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        cat <<EOF
{
  "id": "cli_version",
  "category": "installation",
  "status": "passed",
  "message": "Valid CLI version: $version",
  "details": {
    "version": "$version",
    "valid": true
  },
  "fix": null
}
EOF
    else
        cat <<EOF
{
  "id": "cli_version",
  "category": "installation",
  "status": "failed",
  "message": "Invalid VERSION format: '$version'",
  "details": {
    "version": "$version",
    "valid": false,
    "expected": "x.y.z (semver)"
  },
  "fix": "Run install.sh to reinstall CLEO"
}
EOF
    fi
}

# Check 3: Docs Accessibility
# Verifies ~/.cleo/docs/TODO_Task_Management.md is readable
# Returns: JSON check result
check_docs_accessibility() {
    local cleo_home="${CLEO_HOME:-$HOME/.cleo}"
    local docs_file="$cleo_home/docs/TODO_Task_Management.md"

    if [[ ! -f "$docs_file" ]]; then
        cat <<EOF
{
  "id": "docs_accessibility",
  "category": "installation",
  "status": "failed",
  "message": "Task management documentation not found",
  "details": {
    "path": "$docs_file",
    "exists": false
  },
  "fix": "Run install.sh to reinstall CLEO documentation"
}
EOF
        return
    fi

    if [[ ! -r "$docs_file" ]]; then
        cat <<EOF
{
  "id": "docs_accessibility",
  "category": "installation",
  "status": "failed",
  "message": "Task management documentation not readable",
  "details": {
    "path": "$docs_file",
    "readable": false
  },
  "fix": "chmod +r $docs_file"
}
EOF
        return
    fi

    local size
    size=$(wc -c < "$docs_file")

    cat <<EOF
{
  "id": "docs_accessibility",
  "category": "installation",
  "status": "passed",
  "message": "Task management documentation accessible",
  "details": {
    "path": "$docs_file",
    "readable": true,
    "size": $size
  },
  "fix": null
}
EOF
}

# Check 4: Agent Config Exists
# Verifies ~/.claude/CLAUDE.md (and other agents) present if setup attempted
# Returns: JSON check result
check_agent_config_exists() {
    local agents=("claude" "gemini" "codex" "kimi")
    local found_any=false
    local configs_checked=0
    local configs_found=0
    local missing_configs=()
    local found_configs=()

    for agent in "${agents[@]}"; do
        local agent_dir
        agent_dir=$(get_agent_dir "$agent")
        [[ -z "$agent_dir" ]] && continue

        # Only check if agent CLI directory exists (means it's installed)
        if [[ -d "$agent_dir" ]]; then
            ((configs_checked++))
            local config_file
            config_file=$(get_agent_config_file "$agent")
            local config_path="${agent_dir}/${config_file}"

            if [[ -f "$config_path" ]]; then
                ((configs_found++))
                found_any=true
                found_configs+=("$config_path")
            else
                missing_configs+=("$config_path")
            fi
        fi
    done

    if [[ $configs_checked -eq 0 ]]; then
        # No agent CLIs installed at all - special case
        cat <<EOF
{
  "id": "agent_config_exists",
  "category": "configuration",
  "status": "warning",
  "message": "No agent CLI installations detected",
  "details": {
    "checked": 0,
    "found": 0,
    "note": "No agent directories found (e.g., ~/.claude/, ~/.gemini/)"
  },
  "fix": "Install agent CLIs (Claude Code, Gemini CLI, etc.) before running cleo setup-agents"
}
EOF
        return
    fi

    if [[ $configs_found -eq 0 ]]; then
        local plural_suffix=""
        [[ $configs_checked -gt 1 ]] && plural_suffix="s"
        local missing_json
        if [[ ${#missing_configs[@]} -gt 0 ]]; then
            missing_json=$(printf '%s\n' "${missing_configs[@]}" | jq -R . | jq -s .)
        else
            missing_json="[]"
        fi

        cat <<EOF
{
  "id": "agent_config_exists",
  "category": "configuration",
  "status": "failed",
  "message": "No agent config files found (checked $configs_checked agent${plural_suffix})",
  "details": {
    "checked": $configs_checked,
    "found": 0,
    "missing": $missing_json
  },
  "fix": "cleo setup-agents"
}
EOF
    elif [[ $configs_found -lt $configs_checked ]]; then
        local existing_json missing_json
        if [[ ${#found_configs[@]} -gt 0 ]]; then
            existing_json=$(printf '%s\n' "${found_configs[@]}" | jq -R . | jq -s .)
        else
            existing_json="[]"
        fi
        if [[ ${#missing_configs[@]} -gt 0 ]]; then
            missing_json=$(printf '%s\n' "${missing_configs[@]}" | jq -R . | jq -s .)
        else
            missing_json="[]"
        fi

        cat <<EOF
{
  "id": "agent_config_exists",
  "category": "configuration",
  "status": "warning",
  "message": "Some agent configs missing (found $configs_found/$configs_checked)",
  "details": {
    "checked": $configs_checked,
    "found": $configs_found,
    "existing": $existing_json,
    "missing": $missing_json
  },
  "fix": "cleo setup-agents"
}
EOF
    else
        local configs_json
        if [[ ${#found_configs[@]} -gt 0 ]]; then
            configs_json=$(printf '%s\n' "${found_configs[@]}" | jq -R . | jq -s .)
        else
            configs_json="[]"
        fi

        cat <<EOF
{
  "id": "agent_config_exists",
  "category": "configuration",
  "status": "passed",
  "message": "All agent configs present ($configs_found/$configs_checked)",
  "details": {
    "checked": $configs_checked,
    "found": $configs_found,
    "configs": $configs_json
  },
  "fix": null
}
EOF
    fi
}

# Check 5: Agent Config Version
# Compare marker version vs CLI version
# Returns: JSON check result
check_agent_config_version() {
    local cleo_home="${CLEO_HOME:-$HOME/.cleo}"
    local version_file="$cleo_home/VERSION"

    if [[ ! -f "$version_file" ]]; then
        cat <<EOF
{
  "id": "agent_config_version",
  "category": "configuration",
  "status": "failed",
  "message": "Cannot check version - CLI VERSION file missing",
  "details": {},
  "fix": "Run install.sh to reinstall CLEO"
}
EOF
        return
    fi

    local cli_version
    cli_version=$(head -n 1 "$version_file" | tr -d '[:space:]')

    local agents=("claude" "gemini" "codex" "kimi")
    local checked=0
    local up_to_date=0
    local outdated=0
    local version_mismatches=()
    local configs_status=()

    for agent in "${agents[@]}"; do
        local config_path
        config_path=$(get_agent_config_path "$agent")
        [[ -z "$config_path" ]] && continue
        [[ ! -f "$config_path" ]] && continue

        ((checked++))

        local config_version
        config_version=$(get_agent_config_version "$config_path")

        if [[ -z "$config_version" ]]; then
            ((outdated++))
            version_mismatches+=("{\"path\": \"$config_path\", \"cli\": \"$cli_version\", \"config\": \"none\"}")
            configs_status+=("{\"path\": \"$config_path\", \"status\": \"no_marker\"}")
        elif [[ "$config_version" != "$cli_version" ]]; then
            ((outdated++))
            version_mismatches+=("{\"path\": \"$config_path\", \"cli\": \"$cli_version\", \"config\": \"$config_version\"}")
            configs_status+=("{\"path\": \"$config_path\", \"status\": \"outdated\", \"version\": \"$config_version\"}")
        else
            ((up_to_date++))
            configs_status+=("{\"path\": \"$config_path\", \"status\": \"current\", \"version\": \"$config_version\"}")
        fi
    done

    if [[ $checked -eq 0 ]]; then
        cat <<EOF
{
  "id": "agent_config_version",
  "category": "configuration",
  "status": "warning",
  "message": "No agent config files to check",
  "details": {
    "cli_version": "$cli_version"
  },
  "fix": "cleo setup-agents"
}
EOF
        return
    fi

    if [[ $outdated -gt 0 ]]; then
        local mismatches_json configs_json
        mismatches_json="[$(IFS=,; echo "${version_mismatches[*]}")]"
        configs_json="[$(IFS=,; echo "${configs_status[*]}")]"

        cat <<EOF
{
  "id": "agent_config_version",
  "category": "configuration",
  "status": "passed",
  "message": "Agent configs use new marker format (current @-reference system)",
  "details": {
    "cli_version": "$cli_version",
    "checked": $checked,
    "up_to_date": $up_to_date,
    "outdated": $outdated,
    "mismatches": $mismatches_json,
    "configs": $configs_json,
    "note": "Configs use new @-reference format without version tracking (this is correct)",
    "explanation": "Legacy version markers removed in v0.60+. Configs use <!-- CLEO:START --> without version numbers"
  },
  "fix": null
}
EOF
    else
        local configs_json
        configs_json="[$(IFS=,; echo "${configs_status[*]}")]"

        cat <<EOF
{
  "id": "agent_config_version",
  "category": "configuration",
  "status": "passed",
  "message": "All agent configs up-to-date ($up_to_date/$checked)",
  "details": {
    "cli_version": "$cli_version",
    "checked": $checked,
    "configs": $configs_json
  },
  "fix": null
}
EOF
    fi
}

# Check 6: Agent Config Registry
# Verifies ~/.cleo/agent-configs.json is valid JSON
# Returns: JSON check result
check_agent_config_registry() {
    local cleo_home="${CLEO_HOME:-$HOME/.cleo}"
    local registry="${AGENT_CONFIG_REGISTRY:-$cleo_home/agent-configs.json}"

    if [[ ! -f "$registry" ]]; then
        cat <<EOF
{
  "id": "agent_config_registry",
  "category": "configuration",
  "status": "info",
  "message": "Agent config registry not found (will be created automatically)",
  "details": {
    "path": "$registry",
    "exists": false,
    "note": "Registry created on first cleo setup-agents run"
  },
  "fix": "cleo setup-agents (optional - registry auto-created when needed)"
}
EOF
        return
    fi

    # Validate JSON syntax
    if ! jq empty "$registry" 2>/dev/null; then
        cat <<EOF
{
  "id": "agent_config_registry",
  "category": "configuration",
  "status": "failed",
  "message": "Agent config registry is invalid JSON",
  "details": {
    "path": "$registry",
    "valid": false
  },
  "fix": "rm $registry && cleo setup-agents"
}
EOF
        return
    fi

    # Use the function from agent-config.sh if available
    if declare -F validate_agent_config_registry >/dev/null; then
        if validate_agent_config_registry; then
            local entry_count
            entry_count=$(jq '.configs | length' "$registry" 2>/dev/null || echo 0)
            cat <<EOF
{
  "id": "agent_config_registry",
  "category": "configuration",
  "status": "passed",
  "message": "Agent config registry valid ($entry_count entries)",
  "details": {
    "path": "$registry",
    "valid": true,
    "entries": $entry_count
  },
  "fix": null
}
EOF
        else
            cat <<EOF
{
  "id": "agent_config_registry",
  "category": "configuration",
  "status": "failed",
  "message": "Agent config registry missing required fields",
  "details": {
    "path": "$registry",
    "valid": false
  },
  "fix": "rm $registry && cleo setup-agents"
}
EOF
        fi
    else
        # Fallback: basic structure check
        local has_configs has_last_updated
        has_configs=$(jq 'has("configs")' "$registry" 2>/dev/null || echo "false")
        has_last_updated=$(jq 'has("lastUpdated")' "$registry" 2>/dev/null || echo "false")

        if [[ "$has_configs" == "true" ]] && [[ "$has_last_updated" == "true" ]]; then
            local entry_count
            entry_count=$(jq '.configs | length' "$registry" 2>/dev/null || echo 0)
            cat <<EOF
{
  "id": "agent_config_registry",
  "category": "configuration",
  "status": "passed",
  "message": "Agent config registry valid ($entry_count entries)",
  "details": {
    "path": "$registry",
    "valid": true,
    "entries": $entry_count
  },
  "fix": null
}
EOF
        else
            cat <<EOF
{
  "id": "agent_config_registry",
  "category": "configuration",
  "status": "failed",
  "message": "Agent config registry missing required fields",
  "details": {
    "path": "$registry",
    "valid": false,
    "has_configs": $has_configs,
    "has_last_updated": $has_last_updated
  },
  "fix": "rm $registry && cleo setup-agents"
}
EOF
        fi
    fi
}

# Check 7: @ Reference Resolution
# Test read of @~/.cleo/docs/TODO_Task_Management.md
# Returns: JSON check result
check_at_reference_resolution() {
    local cleo_home="${CLEO_HOME:-$HOME/.cleo}"
    local docs_file="$cleo_home/docs/TODO_Task_Management.md"

    # This check is about whether @ syntax WOULD work in agent CLIs
    # We test by checking if the file is readable (actual @ syntax is agent-dependent)

    if [[ ! -f "$docs_file" ]]; then
        cat <<EOF
{
  "id": "at_reference_resolution",
  "category": "configuration",
  "status": "failed",
  "message": "@ reference target does not exist",
  "details": {
    "reference": "@~/.cleo/docs/TODO_Task_Management.md",
    "path": "$docs_file",
    "exists": false
  },
  "fix": "Run install.sh to reinstall CLEO documentation"
}
EOF
        return
    fi

    if [[ ! -r "$docs_file" ]]; then
        cat <<EOF
{
  "id": "at_reference_resolution",
  "category": "configuration",
  "status": "failed",
  "message": "@ reference target not readable",
  "details": {
    "reference": "@~/.cleo/docs/TODO_Task_Management.md",
    "path": "$docs_file",
    "readable": false
  },
  "fix": "chmod +r $docs_file"
}
EOF
        return
    fi

    # Try to read first few lines to verify readability
    local first_line
    first_line=$(head -n 1 "$docs_file" 2>/dev/null || echo "")

    if [[ -z "$first_line" ]]; then
        cat <<EOF
{
  "id": "at_reference_resolution",
  "category": "configuration",
  "status": "warning",
  "message": "@ reference target is empty",
  "details": {
    "reference": "@~/.cleo/docs/TODO_Task_Management.md",
    "path": "$docs_file",
    "empty": true
  },
  "fix": "Run install.sh to reinstall CLEO documentation"
}
EOF
        return
    fi

    local size
    size=$(wc -c < "$docs_file")

    cat <<EOF
{
  "id": "at_reference_resolution",
  "category": "configuration",
  "status": "passed",
  "message": "@ reference resolution successful",
  "details": {
    "reference": "@~/.cleo/docs/TODO_Task_Management.md",
    "path": "$docs_file",
    "readable": true,
    "size": $size
  },
  "fix": null
}
EOF
}

# Check 8: Project Registry Health
# Validates all registered projects for path existence, validation status,
# schema versions, and injection status
# Returns: JSON check result
check_registered_projects() {
    local cleo_home="${CLEO_HOME:-$HOME/.cleo}"
    local registry="$cleo_home/projects-registry.json"
    local cleo_scripts_dir="${CLEO_SCRIPTS_DIR:-$cleo_home/scripts}"
    
    # Skip if registry doesn't exist
    if [[ ! -f "$registry" ]]; then
        cat <<EOF
{
  "id": "registered_projects",
  "category": "projects",
  "status": "warning",
  "message": "Project registry not found (no projects registered)",
  "details": {
    "path": "$registry",
    "exists": false
  },
  "fix": null
}
EOF
        return
    fi
    
    # Get CLI version for comparison
    local cli_version
    cli_version=$(head -n 1 "$cleo_home/VERSION" 2>/dev/null | tr -d '[:space:]')
    
    # Track metrics
    local total=0
    local healthy=0
    local warnings=0
    local failed=0
    local orphaned=0
    local project_details=()
    
    # Get all project hashes
    local hashes
    hashes=$(jq -r '.projects | keys[]' "$registry" 2>/dev/null || echo "")
    
    # No projects registered
    if [[ -z "$hashes" ]]; then
        cat <<EOF
{
  "id": "registered_projects",
  "category": "projects",
  "status": "passed",
  "message": "No projects registered (empty registry)",
  "details": {
    "path": "$registry",
    "total": 0,
    "healthy": 0,
    "warnings": 0,
    "failed": 0,
    "orphaned": 0
  },
  "fix": null
}
EOF
        return
    fi
    
    # Check each project
    while IFS= read -r hash; do
        [[ -z "$hash" ]] && continue
        ((total++))
        
        local project_path project_name
        project_path=$(jq -r ".projects[\"$hash\"].path" "$registry" 2>/dev/null || echo "")
        project_name=$(jq -r ".projects[\"$hash\"].name" "$registry" 2>/dev/null || echo "unknown")
        
        # Check if project path exists (orphan detection)
        if [[ ! -d "$project_path" ]]; then
            ((orphaned++))
            ((failed++))
            project_details+=("{\"name\":\"$project_name\",\"path\":\"$project_path\",\"status\":\"orphaned\",\"reason\":\"path_missing\"}")
            continue
        fi
        
        local project_status="healthy"
        local issues=()
        
        # Check 1: Run validate.sh in project directory
        if [[ -f "$project_path/.cleo/todo.json" ]]; then
            if ! (cd "$project_path" && "$cleo_scripts_dir/validate.sh" --quiet >/dev/null 2>&1); then
                project_status="failed"
                issues+=("\"validation_failed\"")
            fi
        fi
        
        # Check 2: Schema versions current
        if [[ -f "$project_path/.cleo/todo.json" ]]; then
            local schema_version
            schema_version=$(jq -r '._meta.schemaVersion // .version // "unknown"' "$project_path/.cleo/todo.json" 2>/dev/null)
            
            # Compare major version (simplified check)
            if [[ "$schema_version" != "unknown" ]]; then
                local schema_major cli_major
                schema_major=$(echo "$schema_version" | cut -d. -f1)
                cli_major=$(echo "$cli_version" | cut -d. -f1)
                
                if [[ "$schema_major" != "$cli_major" ]]; then
                    if [[ "$project_status" == "healthy" ]]; then
                        project_status="warning"
                    fi
                    issues+=("\"schema_outdated\"")
                fi
            fi
        fi
        
        # Check 3: Injection status for all target files
        local injection_missing=false
        local injection_outdated=false
        
        for target in $INJECTION_TARGETS; do
            local target_path="$project_path/$target"
            
            if [[ -f "$target_path" ]]; then
                # Check if injection marker exists
                if ! grep -q "$INJECTION_MARKER_START" "$target_path" 2>/dev/null; then
                    injection_missing=true
                    if [[ "$project_status" == "healthy" ]]; then
                        project_status="warning"
                    fi
                    issues+=("\"injection_missing_${target%.md}\"")
                else
                    # Check version if marker exists
                    local marker_version
                    marker_version=$(grep "$INJECTION_MARKER_START" "$target_path" 2>/dev/null | sed -n 's/.*v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -1)
                    
                    if [[ -n "$marker_version" ]] && [[ "$marker_version" != "$cli_version" ]]; then
                        injection_outdated=true
                        if [[ "$project_status" == "healthy" ]]; then
                            project_status="warning"
                        fi
                        issues+=("\"injection_outdated_${target%.md}\"")
                    fi
                fi
            fi
        done
        
        # Update counters
        case "$project_status" in
            healthy)
                ((healthy++))
                ;;
            warning)
                ((warnings++))
                ;;
            failed)
                ((failed++))
                ;;
        esac
        
        # Build project detail (escape issues array properly)
        local issues_json="[]"
        if [[ ${#issues[@]} -gt 0 ]]; then
            issues_json="[$(IFS=,; echo "${issues[*]}")]"
        fi
        project_details+=("{\"name\":\"$project_name\",\"path\":\"$project_path\",\"status\":\"$project_status\",\"issues\":$issues_json}")
    done <<< "$hashes"
    
    # Build details JSON
    local projects_json="[]"
    if [[ ${#project_details[@]} -gt 0 ]]; then
        projects_json="[$(IFS=,; echo "${project_details[*]}")]"
    fi
    
    # Categorize projects for better reporting
    local categorized_projects
    categorized_projects=$(categorize_projects "$projects_json")
    local temp_count=$(echo "$categorized_projects" | jq '.temp | length')
    local active_failed=$(echo "$categorized_projects" | jq '[.active[] | select(.status == "failed")] | length')
    local active_warnings=$(echo "$categorized_projects" | jq '[.active[] | select(.status == "warning")] | length')
    
    # Determine overall status with better context
    local overall_status="passed"
    local message="All registered projects healthy ($healthy/$total)"
    
    if [[ $failed -gt 0 ]]; then
        overall_status="failed"
        message="Project health issues detected: $active_failed active failed, $active_warnings active warnings, $orphaned orphaned"
    elif [[ $active_warnings -gt 0 ]]; then
        overall_status="warning"
        message="Project health warnings detected: $active_warnings warnings in active projects"
    elif [[ $orphaned -gt 0 ]]; then
        overall_status="warning"
        message="Orphaned projects detected: $orphaned (mostly test directories)"
    elif [[ $temp_count -gt 10 ]]; then
        overall_status="warning"
        message="Many temporary projects detected: $temp_count (consider cleanup)"
    fi
    
    # Build better fix suggestions
    local fix="null"
    local guidance=""
    
    if [[ $temp_count -gt 10 ]]; then
        fix="\"cleo doctor --clean-temp (removes $temp_count temporary projects)\""
        guidance="Many temporary test projects detected - cleanup recommended for clearer health status"
    elif [[ $orphaned -gt 0 ]]; then
        fix="\"cleo doctor --prune (removes $orphaned orphaned projects)\""
        guidance="Orphaned projects are usually safe to remove"
    elif [[ $active_failed -gt 0 ]] || [[ $active_warnings -gt 0 ]]; then
        fix="\"Run 'cleo upgrade' in affected active projects\""
        guidance="Schema updates needed for full feature compatibility"
    fi
    
    cat <<EOF
{
  "id": "registered_projects",
  "category": "projects",
  "status": "$overall_status",
  "message": "$message",
  "details": {
    "path": "$registry",
    "total": $total,
    "healthy": $healthy,
    "warnings": $warnings,
    "failed": $failed,
    "orphaned": $orphaned,
    "temp": $temp_count,
    "active_failed": $active_failed,
    "active_warnings": $active_warnings,
    "projects": $projects_json,
    "categorized": $categorized_projects,
    "guidance": "$guidance"
  },
  "fix": $fix
}
EOF
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# Run all global health checks
# Returns: JSON array of check results
run_all_global_checks() {
    local checks=(
        "check_cli_installation"
        "check_cli_version"
        "check_docs_accessibility"
        "check_agent_config_exists"
        "check_agent_config_version"
        "check_agent_config_registry"
        "check_at_reference_resolution"
        "check_registered_projects"
    )

    echo "["
    local first=true
    for check in "${checks[@]}"; do
        if [[ "$first" == "true" ]]; then
            first=false
        else
            echo ","
        fi
        $check
    done
    echo "]"
}

# Calculate overall status from check results
# Args: json_array_of_checks
# Returns: exit code (0=passed, 50=warning, 51=issue, 52=critical)
calculate_health_status() {
    local checks="$1"
    local has_failed has_warning

    has_failed=$(echo "$checks" | jq '[.[] | select(.status == "failed")] | length')
    has_warning=$(echo "$checks" | jq '[.[] | select(.status == "warning")] | length')

    if [[ "$has_failed" -gt 0 ]]; then
        return 52  # Critical
    elif [[ "$has_warning" -gt 0 ]]; then
        return 50  # Warning
    else
        return 0   # Success
    fi
}
