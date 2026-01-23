#!/usr/bin/env bash
# =============================================================================
# generate-large-dataset.sh - Generate large todo.json files for performance testing
# =============================================================================
# Creates realistic todo.json files with configurable task counts and dependency
# patterns for benchmarking the dependency graph caching system.
#
# Usage:
#   generate-large-dataset.sh <task_count> [dependency_density] [output_file]
#
# Arguments:
#   task_count         Number of tasks to generate (required)
#   dependency_density Fraction of tasks with dependencies, 0.0-1.0 (default: 0.3)
#   output_file        Output file path (default: stdout)
#
# Examples:
#   ./generate-large-dataset.sh 100                    # 100 tasks, 30% with deps
#   ./generate-large-dataset.sh 500 0.5                # 500 tasks, 50% with deps
#   ./generate-large-dataset.sh 1000 0.3 todo.json     # 1000 tasks to file
#
# Dependency Patterns:
#   - Linear chains: sequential dependencies (A → B → C)
#   - Fan-in: multiple tasks depend on one (A,B,C → D)
#   - Fan-out: one task depends on multiple (A → B,C,D)
#   - Diamond: common patterns (A → B,C → D)
#   - Random: realistic random dependencies
# =============================================================================

set -euo pipefail

#####################################################################
# Configuration
#####################################################################

TASK_COUNT="${1:-100}"
DEPENDENCY_DENSITY="${2:-0.3}"
OUTPUT_FILE="${3:-}"

# Validate inputs
if ! [[ "$TASK_COUNT" =~ ^[0-9]+$ ]] || (( TASK_COUNT < 1 )); then
    echo "Error: task_count must be a positive integer" >&2
    exit 1
fi

# Seed random for reproducibility in tests (optional)
if [[ -n "${RANDOM_SEED:-}" ]]; then
    RANDOM=$RANDOM_SEED
fi

#####################################################################
# Task Generation
#####################################################################

# Convert density to integer percentage
DENSITY_PCT=$(echo "$DEPENDENCY_DENSITY * 100" | bc 2>/dev/null || echo "30")
DENSITY_PCT=${DENSITY_PCT%.*}  # Remove decimal

# Priority distribution
declare -a PRIORITIES=("critical" "high" "medium" "medium" "medium" "low")
declare -a PHASES=("setup" "core" "core" "core" "testing" "testing" "polish" "maintenance")
declare -a TYPES=("epic" "task" "task" "task" "task" "subtask")

# Generate task ID
task_id() {
    printf "T%03d" "$1"
}

# Select random element from array
random_element() {
    local arr=("$@")
    echo "${arr[$((RANDOM % ${#arr[@]}))]}"
}

# Generate dependencies for a task
# Strategy: only depend on earlier tasks to prevent cycles
generate_deps() {
    local task_num=$1
    local max_deps=3
    
    # No deps for first few tasks or if random check fails
    if (( task_num <= 3 )) || (( RANDOM % 100 >= DENSITY_PCT )); then
        echo "null"
        return
    fi
    
    # Determine number of dependencies (1-3)
    local dep_count=$((RANDOM % max_deps + 1))
    local deps=()
    local available=$((task_num - 1))
    
    # Ensure we don't try to pick more deps than available tasks
    if (( dep_count > available )); then
        dep_count=$available
    fi
    
    # Pick random earlier tasks as dependencies
    local attempts=0
    while (( ${#deps[@]} < dep_count && attempts < 10 )); do
        local dep_idx=$((RANDOM % available + 1))
        local dep_id=$(task_id "$dep_idx")
        
        # Avoid duplicates
        local is_dup=false
        for d in "${deps[@]:-}"; do
            if [[ "$d" == "$dep_id" ]]; then
                is_dup=true
                break
            fi
        done
        
        if [[ "$is_dup" == "false" ]]; then
            deps+=("$dep_id")
        fi
        
        ((attempts++))
    done
    
    # Format as JSON array or null
    if (( ${#deps[@]} == 0 )); then
        echo "null"
    else
        printf '['
        local first=true
        for d in "${deps[@]}"; do
            if [[ "$first" == "true" ]]; then
                first=false
            else
                printf ','
            fi
            printf '"%s"' "$d"
        done
        printf ']'
    fi
}

# Generate labels (occasional)
generate_labels() {
    if (( RANDOM % 100 < 20 )); then
        local label_opts=("bug" "feature" "refactor" "docs" "test" "security" "performance")
        local label=$(random_element "${label_opts[@]}")
        printf '["%s"]' "$label"
    else
        echo "null"
    fi
}

#####################################################################
# JSON Generation
#####################################################################

generate_todo_json() {
    # Start JSON structure
    cat << 'HEADER'
{
  "version": "2.3.0",
  "project": {
    "name": "perf-test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "completed", "startedAt": "2025-01-01T10:00:00Z", "completedAt": "2025-01-01T12:00:00Z"},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "active", "startedAt": "2025-01-01T12:00:00Z", "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "tasks": [
HEADER

    # Generate tasks
    local i
    for ((i = 1; i <= TASK_COUNT; i++)); do
        local id=$(task_id "$i")
        local priority=$(random_element "${PRIORITIES[@]}")
        local phase=$(random_element "${PHASES[@]}")
        local type=$(random_element "${TYPES[@]}")
        local deps=$(generate_deps "$i")
        local labels=$(generate_labels)
        local status="pending"
        
        # First ~10% of tasks might be done
        if (( RANDOM % 100 < 10 && i <= TASK_COUNT / 2 )); then
            status="done"
        fi
        
        # Print comma before all but first task
        if (( i > 1 )); then
            printf ',\n'
        fi
        
        # Generate task JSON (compact for speed)
        cat << TASK
    {"id": "$id", "title": "Task $i: Performance test task", "description": "Description for task $i with realistic content for testing", "status": "$status", "priority": "$priority", "phase": "$phase", "type": "$type", "parentId": null, "size": null, "createdAt": "2025-01-01T10:00:00Z", "depends": $deps, "labels": $labels}
TASK
    done

    # Close JSON structure
    cat << 'FOOTER'

  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "lastUpdated": "2025-01-01T12:00:00Z"
}
FOOTER
}

#####################################################################
# Main
#####################################################################

main() {
    if [[ -n "$OUTPUT_FILE" ]]; then
        generate_todo_json > "$OUTPUT_FILE"
        
        # Update checksum if jq is available
        if command -v jq &>/dev/null; then
            local checksum
            checksum=$(jq -c '.tasks // []' "$OUTPUT_FILE" | sha256sum | cut -c1-16)
            local tmp="${OUTPUT_FILE}.tmp"
            jq --arg cs "$checksum" '._meta.checksum = $cs' "$OUTPUT_FILE" > "$tmp" && \
                mv "$tmp" "$OUTPUT_FILE"
        fi
        
        echo "Generated $TASK_COUNT tasks with ${DENSITY_PCT}% dependency density to $OUTPUT_FILE" >&2
    else
        generate_todo_json
    fi
}

main
