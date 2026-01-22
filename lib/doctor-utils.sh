#!/usr/bin/env bash
# Doctor utility functions for better health checking

# Check if a project path is a temporary/test directory
# Returns 0 if temp directory, 1 otherwise
is_temp_project() {
    local path="$1"
    
    # Common temp directory patterns
    [[ "$path" == *"/.temp/"* ]] || \
    [[ "$path" == *"/tmp/"* ]] || \
    [[ "$path" == *"/bats-run-"* ]] || \
    [[ "$path" == *"/test/"* && "$path" == *"bats-run-"* ]] || \
    [[ "$path" == *"/test/"* && "$path" == *"test-"* ]] || \
    [[ "$path" == *"/.tmp/"* ]] || \
    [[ "$path" == *"/tmp."* ]] || \
    [[ "$path" == *"/bats."* ]]
}

# Filter projects into categories: active, temp, orphaned
# Args: JSON array of project objects
# Returns: JSON with filtered categories
categorize_projects() {
    local projects_json="$1"
    
    echo "$projects_json" | jq -c '
    {
        active: map(select(.status != "orphaned" and 
                          (.path | test("/.temp/|/bats-run-|/tmp/")) | not)),
        temp: map(select(.path | test("/.temp/|/bats-run-|/tmp/")) and .status != "orphaned"),
        orphaned: map(select(.status == "orphaned"))
    }'
}

# Get human-readable project category name
get_project_category_name() {
    local category="$1"
    case "$category" in
        "active") echo "Active Projects" ;;
        "temp") echo "Temporary/Test Projects" ;;
        "orphaned") echo "Orphaned Projects" ;;
        *) echo "Projects" ;;
    esac
}

# Format project health summary with better context
format_project_health_summary() {
    local total="$1"
    local healthy="$2" 
    local warnings="$3"
    local failed="$4"
    local orphaned="$5"
    local temp="$6"
    
    echo "Project Health Summary:"
    echo "  Total Projects: $total"
    if [[ "$temp" -gt 0 ]]; then
        local active=$((total - temp - orphaned))
        if [[ $active -lt 0 ]]; then active=0; fi
        echo "  Active Projects: $active"
        echo "  Temporary Projects: $temp (test artifacts)"
    fi
    if [[ "$orphaned" -gt 0 ]]; then
        echo "  Orphaned Projects: $orphaned (directories missing)"
    fi
    if [[ "$healthy" -gt 0 ]]; then
        echo "  Healthy Projects: $healthy"
    fi
    if [[ "$warnings" -gt 0 ]]; then
        echo "  Projects with Warnings: $warnings"
    fi
    if [[ "$failed" -gt 0 ]]; then
        echo "  Projects Failed Validation: $failed"
    fi
}

# Get actionable guidance for project issues
get_project_guidance() {
    local active_failed="$1"
    local active_warnings="$2"
    local temp_count="$3"
    local orphaned_count="$4"
    
    local guidance=()
    
    if [[ "$active_failed" -gt 0 ]]; then
        guidance+=("🔴 $active_failed active project(s) failed validation - run 'cleo upgrade' in affected projects")
    fi
    
    if [[ "$active_warnings" -gt 0 ]]; then
        guidance+=("🟡 $active_warnings active project(s) have warnings - consider updating schemas")
    fi
    
    if [[ "$temp_count" -gt 10 ]]; then
        guidance+=("🧹 Many temporary projects detected - run 'cleo doctor --clean-temp' to clean up")
    fi
    
    if [[ "$orphaned_count" -gt 5 ]]; then
        guidance+=("🗑️ $orphaned_count orphaned projects - run 'cleo doctor --prune' to remove")
    fi
    
    printf '%s\n' "${guidance[@]}"
}

# Check user journey stage based on system state
get_user_journey_stage() {
    local has_projects="$1"
    local temp_projects="$2"
    local agent_configs_ok="$3"
    
    if [[ "$has_projects" -eq 0 ]]; then
        echo "new-user"
    elif [[ "$temp_projects" -gt 10 ]]; then
        echo "cleanup-needed"
    elif [[ "$agent_configs_ok" != "true" ]]; then
        echo "setup-agents-needed"
    else
        echo "maintenance-mode"
    fi
}

# Get journey-specific guidance
get_journey_guidance() {
    local stage="$1"
    
    case "$stage" in
        "new-user")
            echo "🚀 NEW USER SETUP:"
            echo "  1. Create your first project: cleo init my-project"
            echo "  2. Add tasks: cleo add 'Setup development environment'"
            echo "  3. Configure AI assistants: cleo setup-agents"
            ;;
        "cleanup-needed")
            echo "🧹 CLEANUP NEEDED:"
            echo "  You have many temporary projects from testing"
            echo "  Run 'cleo doctor --clean-temp' to clean up"
            ;;
        "setup-agents-needed")
            echo "🤖 AI ASSISTANT SETUP:"
            echo "  Your AI assistants need CLEO configuration"
            echo "  Run 'cleo setup-agents' to inject task management docs"
            ;;
        "maintenance-mode")
            echo "🔧 MAINTENANCE MODE:"
            echo "  System is healthy - check individual project issues above"
            ;;
    esac
}