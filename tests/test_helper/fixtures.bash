#!/usr/bin/env bash
# =============================================================================
# fixtures.bash - Test data generators for claude-todo BATS tests
# =============================================================================
# DRY: Parameterized fixture generators avoid duplication in test files.
# All fixtures use consistent JSON structure matching claude-todo schema.
#
# NOTES:
# - _update_fixture_checksum() MUST use sha256sum to match production code
# - STANDARD_PHASES_TEMPLATE provides reusable 5-phase structure
# - _create_base_structure() generates consistent base structures dynamically
# =============================================================================

# =============================================================================
# Constants & Templates for Phase Deduplication
# =============================================================================

# Standard 5-phase template (setup -> core -> testing -> polish -> maintenance)
# Phases are defined without timestamps - they are added dynamically when needed
# This reduces duplication across 25+ fixture definitions
readonly STANDARD_PHASES_TEMPLATE='{
  "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "pending", "startedAt": null, "completedAt": null},
  "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
  "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
  "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
  "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
}'

# =============================================================================
# Helper Functions
# =============================================================================

# Compute and update checksum for a fixture file (matches validate.sh logic)
# MUST use sha256sum to match production code checksum computation
# Usage: _update_fixture_checksum "$TODO_FILE"
_update_fixture_checksum() {
    local file="${1:-$TODO_FILE}"
    [[ -f "$file" ]] || return 1

    local checksum
    checksum=$(jq -c '.tasks // []' "$file" | sha256sum | cut -c1-16)

    jq --arg cs "$checksum" '._meta.checksum = $cs' "$file" > "${file}.tmp" && \
        mv "${file}.tmp" "$file"
}

# Create base todo.json structure dynamically
# Usage: _create_base_structure [current_phase] [project_name]
# Returns: JSON structure to stdout (pipe to file or use with jq)
_create_base_structure() {
    local current_phase="${1:-setup}"
    local project_name="${2:-test-project}"

    jq -n \
        --arg phase "$current_phase" \
        --arg project "$project_name" \
        --argjson phases "$STANDARD_PHASES_TEMPLATE" \
        '{
            version: "2.3.0",
            project: {
                name: $project,
                currentPhase: $phase,
                phases: ($phases | .[$phase].status = "active" | if $phase != "setup" then .setup.status = "completed" else . end)
            },
            tasks: [],
            focus: {currentPhase: $phase},
            labels: {},
            _meta: {version: "2.3.0", checksum: "placeholder"},
            lastUpdated: "2025-12-01T12:00:00Z"
        }'
}

# Base meta block used in all todo.json fixtures
_todo_meta() {
    cat << 'EOF'
  "_meta": {"version": "2.3.0", "checksum": "test123"},
EOF
}

# =============================================================================
# Empty/Minimal Fixtures
# =============================================================================

# Create empty todo.json (no tasks) with v2.3.0 project structure
create_empty_todo() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "tasks": [],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create empty todo.json without phases (legacy v2.1 structure for backward compat tests)
create_empty_todo_legacy() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.1.0"},
  "tasks": [],
  "focus": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
}

# Create empty todo.json with phases in pending state (for testing phase workflows from start)
# Uses canonical 5-phase structure: setup → core → testing → polish → maintenance
create_empty_todo_no_phases() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": null,
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "pending", "startedAt": null, "completedAt": null},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "tasks": [],
  "focus": {"currentPhase": null},
  "labels": {},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# Basic Task Fixtures
# =============================================================================

# Create todo.json with independent tasks (no dependencies) - v2.3.0 schema
create_independent_tasks() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "First task", "description": "Task one", "status": "pending", "priority": "medium", "phase": "setup", "type": "task", "parentId": null, "size": null, "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Second task", "description": "Task two", "status": "pending", "priority": "high", "phase": "setup", "type": "task", "parentId": null, "size": null, "createdAt": "2025-12-01T11:00:00Z"},
    {"id": "T003", "title": "Third task", "description": "Task three", "status": "pending", "priority": "low", "phase": "core", "type": "task", "parentId": null, "size": null, "createdAt": "2025-12-01T12:00:00Z"}
  ],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create todo.json with a completed task
create_tasks_with_completed() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Completed task", "description": "Done", "status": "done", "priority": "high", "phase": "setup", "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-10T12:00:00Z"},
    {"id": "T002", "title": "Pending task", "description": "Not done", "status": "pending", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T11:00:00Z"}
  ],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "lastUpdated": "2025-12-10T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# Dependency Chain Fixtures
# =============================================================================

# Create simple linear dependency chain: T001 <- T002 <- T003
create_linear_chain() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Foundation task", "description": "Base", "status": "pending", "priority": "high", "phase": "setup", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Depends on T001", "description": "Middle", "status": "pending", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T11:00:00Z", "depends": ["T001"]},
    {"id": "T003", "title": "Depends on T002", "description": "End", "status": "pending", "priority": "low", "phase": "core", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T002"]}
  ],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create complex dependency graph with multiple roots
create_complex_deps() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "completed", "startedAt": "2025-12-01T09:00:00Z", "completedAt": "2025-12-01T10:00:00Z"},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Core module", "description": "Core", "status": "pending", "priority": "critical", "phase": "core", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Auth module", "description": "Auth", "status": "pending", "priority": "high", "phase": "core", "createdAt": "2025-12-01T11:00:00Z"},
    {"id": "T003", "title": "Depends on T001 and T002", "description": "Combined", "status": "pending", "priority": "medium", "phase": "core", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T001", "T002"]},
    {"id": "T004", "title": "Depends on T003", "description": "Final", "status": "pending", "priority": "medium", "phase": "testing", "createdAt": "2025-12-01T13:00:00Z", "depends": ["T003"]},
    {"id": "T005", "title": "Independent task", "description": "Alone", "status": "pending", "priority": "low", "phase": "core", "createdAt": "2025-12-01T14:00:00Z"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-12-01T14:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# Blocked Task Fixtures
# =============================================================================

# Create todo.json with blocked tasks
create_blocked_tasks() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Foundation task", "description": "Base", "status": "pending", "priority": "high", "phase": "setup", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Blocked by T001", "description": "Waiting", "status": "blocked", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T11:00:00Z", "depends": ["T001"], "blockedBy": "Waiting for T001"},
    {"id": "T003", "title": "Blocked by T002", "description": "Waiting more", "status": "blocked", "priority": "low", "phase": "setup", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T002"], "blockedBy": "Waiting for T002"}
  ],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create todo.json with task blocked by multiple dependencies
create_multi_blocker_tasks() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "First dependency", "description": "Dep 1", "status": "pending", "priority": "high", "phase": "setup", "createdAt": "2025-12-01T10:00:00Z"},
    {"id": "T002", "title": "Second dependency", "description": "Dep 2", "status": "pending", "priority": "high", "phase": "setup", "createdAt": "2025-12-01T11:00:00Z"},
    {"id": "T003", "title": "Blocked by T001 and T002", "description": "Multi-blocked", "status": "blocked", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T12:00:00Z", "depends": ["T001", "T002"], "blockedBy": "Waiting for T001 and T002"}
  ],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "lastUpdated": "2025-12-01T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create todo.json with completed blocker (task should be unblocked)
create_completed_blocker() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Completed blocker", "description": "Done", "status": "done", "priority": "high", "phase": "setup", "createdAt": "2025-12-01T10:00:00Z", "completedAt": "2025-12-10T12:00:00Z"},
    {"id": "T002", "title": "Was blocked by T001", "description": "Now unblocked", "status": "pending", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T11:00:00Z", "depends": ["T001"]}
  ],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "lastUpdated": "2025-12-10T12:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# Circular Dependency Fixtures (for validation testing)
# =============================================================================

# Create todo.json with direct circular dependency (invalid state)
create_circular_deps() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "active", "startedAt": "2025-12-01T10:00:00Z", "completedAt": null},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "pending", "startedAt": null, "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "A depends on B", "description": "Circular A", "status": "pending", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T10:00:00Z", "depends": ["T002"]},
    {"id": "T002", "title": "B depends on A", "description": "Circular B", "status": "pending", "priority": "medium", "phase": "setup", "createdAt": "2025-12-01T11:00:00Z", "depends": ["T001"]}
  ],
  "focus": {"currentPhase": "setup"},
  "labels": {},
  "lastUpdated": "2025-12-01T11:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# Parameterized Fixture Generators
# =============================================================================

# Create a task with specific properties
create_task_with_props() {
    local id="$1"
    local title="$2"
    local status="${3:-pending}"
    local priority="${4:-medium}"
    local depends="${5:-}"

    local deps_json="null"
    if [[ -n "$depends" ]]; then
        deps_json=$(echo "$depends" | jq -R 'split(",")')
    fi

    jq --arg id "$id" \
       --arg title "$title" \
       --arg status "$status" \
       --arg priority "$priority" \
       --argjson depends "$deps_json" \
       '.tasks += [{
         "id": $id,
         "title": $title,
         "description": ($title + " description"),
         "status": $status,
         "priority": $priority,
         "phase": "setup",
         "createdAt": "2025-12-01T10:00:00Z"
       } + (if $depends then {"depends": $depends} else {} end)]' \
       "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"
}

# Add a single task to existing todo.json
add_task_to_fixture() {
    local id="$1"
    local title="$2"
    local status="${3:-pending}"

    jq --arg id "$id" \
       --arg title "$title" \
       --arg status "$status" \
       '.tasks += [{
         "id": $id,
         "title": $title,
         "description": ($title + " description"),
         "status": $status,
         "priority": "medium",
         "phase": "setup",
         "createdAt": "2025-12-01T10:00:00Z"
       }]' "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"
}

# Add dependency to existing task
add_dependency_to_fixture() {
    local task_id="$1"
    local dep_id="$2"

    jq --arg id "$task_id" \
       --arg dep "$dep_id" \
       '(.tasks[] | select(.id == $id) | .depends) += [$dep]' \
       "$TODO_FILE" > "${TODO_FILE}.tmp" && mv "${TODO_FILE}.tmp" "$TODO_FILE"
    _update_fixture_checksum "$TODO_FILE"
}

# =============================================================================
# Archive Fixtures
# =============================================================================

# Create empty archive file
create_empty_archive() {
    local dest="${1:-${ARCHIVE_FILE:-${TEST_TEMP_DIR}/.cleo/todo-archive.json}}"
    cat > "$dest" << 'EOF'
{
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "archivedTasks": [],
  "lastArchived": null
}
EOF
    # Archive checksum uses archivedTasks instead of tasks
    local checksum
    checksum=$(jq -c '.archivedTasks // []' "$dest" | sha256sum | cut -c1-16)
    jq --arg cs "$checksum" '._meta.checksum = $cs' "$dest" > "${dest}.tmp" && \
        mv "${dest}.tmp" "$dest"
}

# =============================================================================
# Hierarchy/Cascade Archive Fixtures
# =============================================================================

# Create parent-child hierarchy with all completed (for cascade archive testing)
# Structure: T001 (parent, done) -> T002, T003 (children, done)
create_complete_family_hierarchy() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "completed", "startedAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-15T10:00:00Z"},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "active", "startedAt": "2025-11-15T10:00:00Z", "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Parent task", "description": "Parent epic", "status": "done", "priority": "high", "phase": "setup", "type": "epic", "parentId": null, "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-10T10:00:00Z"},
    {"id": "T002", "title": "Child task 1", "description": "First child", "status": "done", "priority": "medium", "phase": "setup", "type": "task", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-08T10:00:00Z"},
    {"id": "T003", "title": "Child task 2", "description": "Second child", "status": "done", "priority": "medium", "phase": "setup", "type": "task", "parentId": "T001", "createdAt": "2025-11-03T10:00:00Z", "completedAt": "2025-11-09T10:00:00Z"},
    {"id": "T004", "title": "Independent task", "description": "Not in family", "status": "pending", "priority": "low", "phase": "core", "type": "task", "parentId": null, "createdAt": "2025-11-15T10:00:00Z"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-11-15T10:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create parent-child hierarchy with incomplete children (cascade should skip)
# Structure: T001 (parent, done) -> T002 (done), T003 (pending)
create_incomplete_family_hierarchy() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "completed", "startedAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-15T10:00:00Z"},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "active", "startedAt": "2025-11-15T10:00:00Z", "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Parent task", "description": "Parent epic", "status": "done", "priority": "high", "phase": "setup", "type": "epic", "parentId": null, "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-10T10:00:00Z"},
    {"id": "T002", "title": "Child task 1", "description": "First child done", "status": "done", "priority": "medium", "phase": "setup", "type": "task", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-08T10:00:00Z"},
    {"id": "T003", "title": "Child task 2", "description": "Second child NOT done", "status": "pending", "priority": "medium", "phase": "setup", "type": "task", "parentId": "T001", "createdAt": "2025-11-03T10:00:00Z"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-11-15T10:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# Create completed parent with active children (safe mode should block archive)
create_completed_parent_active_children() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "description": "Initial setup", "status": "completed", "startedAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-15T10:00:00Z"},
      "core": {"order": 2, "name": "Core", "description": "Core features", "status": "active", "startedAt": "2025-11-15T10:00:00Z", "completedAt": null},
      "testing": {"order": 3, "name": "Testing", "description": "Testing and validation", "status": "pending", "startedAt": null, "completedAt": null},
      "polish": {"order": 4, "name": "Polish", "description": "Polish and optimization", "status": "pending", "startedAt": null, "completedAt": null},
      "maintenance": {"order": 5, "name": "Maintenance", "description": "Bug fixes and support", "status": "pending", "startedAt": null, "completedAt": null}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Parent task", "description": "Parent is done but has active children", "status": "done", "priority": "high", "phase": "setup", "type": "epic", "parentId": null, "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-10T10:00:00Z"},
    {"id": "T002", "title": "Active child", "description": "Child is active", "status": "active", "priority": "medium", "phase": "setup", "type": "task", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z"}
  ],
  "focus": {"currentPhase": "core"},
  "labels": {},
  "lastUpdated": "2025-11-15T10:00:00Z"
}
EOF
    _update_fixture_checksum "$dest"
}

# =============================================================================
# Archive-Related Fixtures (T447)
# =============================================================================

# Create empty archive file with proper structure
create_archive_empty() {
    local dest="${1:-${ARCHIVE_FILE:-${TEST_TEMP_DIR}/.cleo/todo-archive.json}}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": "test-project",
  "_meta": {"version": "2.3.0", "totalArchived": 0, "lastArchived": null},
  "archivedTasks": [],
  "phaseSummary": {},
  "statistics": {"byPhase": {}, "byPriority": {}, "byLabel": {}}
}
EOF
}

# Create archive with sample tasks for testing stats and unarchive
create_archive_with_sample_tasks() {
    local dest="${1:-${ARCHIVE_FILE:-${TEST_TEMP_DIR}/.cleo/todo-archive.json}}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": "test-project",
  "_meta": {"version": "2.3.0", "totalArchived": 3, "lastArchived": "2025-12-15T10:00:00Z"},
  "archivedTasks": [
    {
      "id": "T100",
      "title": "Archived setup task",
      "description": "Setup phase archived",
      "status": "done",
      "priority": "high",
      "phase": "setup",
      "labels": ["security"],
      "createdAt": "2025-11-01T10:00:00Z",
      "completedAt": "2025-11-10T10:00:00Z",
      "_archive": {
        "archivedAt": "2025-12-01T10:00:00Z",
        "reason": "auto",
        "archiveSource": "auto",
        "sessionId": "session-test-1",
        "cycleTimeDays": 9,
        "relationshipState": {"hadChildren": false, "childIds": [], "hadDependents": false, "dependentIds": [], "parentId": null},
        "restoreInfo": {"originalStatus": "done", "canRestore": true, "restoreBlockers": []}
      }
    },
    {
      "id": "T101",
      "title": "Archived core task",
      "description": "Core phase archived",
      "status": "done",
      "priority": "medium",
      "phase": "core",
      "labels": ["feature"],
      "createdAt": "2025-11-05T10:00:00Z",
      "completedAt": "2025-11-15T10:00:00Z",
      "_archive": {
        "archivedAt": "2025-12-05T10:00:00Z",
        "reason": "force",
        "archiveSource": "force",
        "sessionId": "session-test-2",
        "cycleTimeDays": 10,
        "relationshipState": {"hadChildren": false, "childIds": [], "hadDependents": false, "dependentIds": [], "parentId": null},
        "restoreInfo": {"originalStatus": "done", "canRestore": true, "restoreBlockers": []}
      }
    },
    {
      "id": "T102",
      "title": "Archived testing task",
      "description": "Testing phase archived",
      "status": "done",
      "priority": "low",
      "phase": "testing",
      "createdAt": "2025-11-10T10:00:00Z",
      "completedAt": "2025-11-20T10:00:00Z",
      "_archive": {
        "archivedAt": "2025-12-10T10:00:00Z",
        "reason": "manual",
        "archiveSource": "manual",
        "sessionId": "session-test-3",
        "cycleTimeDays": 10
      }
    }
  ],
  "phaseSummary": {},
  "statistics": {"byPhase": {}, "byPriority": {}, "byLabel": {}}
}
EOF
}

# Create tasks with various labels for archive label filtering tests
create_tasks_with_diverse_labels() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "test-project", "currentPhase": "core"},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Security bug fix", "description": "Critical security", "status": "done", "priority": "critical", "labels": ["security", "bug", "urgent"], "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Feature development", "description": "New feature", "status": "done", "priority": "high", "labels": ["feature", "api"], "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-08T10:00:00Z"},
    {"id": "T003", "title": "Documentation update", "description": "Docs work", "status": "done", "priority": "medium", "labels": ["docs", "cleanup"], "createdAt": "2025-11-03T10:00:00Z", "completedAt": "2025-11-10T10:00:00Z"},
    {"id": "T004", "title": "Temp work", "description": "Temporary", "status": "done", "priority": "low", "labels": ["temp"], "createdAt": "2025-11-04T10:00:00Z", "completedAt": "2025-11-12T10:00:00Z"},
    {"id": "T005", "title": "No labels task", "description": "Plain task", "status": "done", "priority": "medium", "createdAt": "2025-11-05T10:00:00Z", "completedAt": "2025-11-15T10:00:00Z"},
    {"id": "T006", "title": "Pending task", "description": "Still working", "status": "pending", "priority": "medium", "labels": ["feature"], "createdAt": "2025-11-06T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$dest"
}

# Create tasks across multiple phases for phase-triggered archive tests
create_tasks_multi_phase() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {"order": 1, "name": "Setup", "status": "completed"},
      "core": {"order": 2, "name": "Core", "status": "active"},
      "testing": {"order": 3, "name": "Testing", "status": "pending"},
      "polish": {"order": 4, "name": "Polish", "status": "pending"}
    }
  },
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Setup complete", "description": "Setup done", "status": "done", "priority": "high", "phase": "setup", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Setup also complete", "description": "Another setup", "status": "done", "priority": "medium", "phase": "setup", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-06T10:00:00Z"},
    {"id": "T003", "title": "Core done", "description": "Core complete", "status": "done", "priority": "high", "phase": "core", "createdAt": "2025-11-10T10:00:00Z", "completedAt": "2025-11-15T10:00:00Z"},
    {"id": "T004", "title": "Core in progress", "description": "Core active", "status": "active", "priority": "medium", "phase": "core", "createdAt": "2025-11-11T10:00:00Z"},
    {"id": "T005", "title": "Testing pending", "description": "Testing queued", "status": "pending", "priority": "low", "phase": "testing", "createdAt": "2025-11-20T10:00:00Z"}
  ],
  "focus": {"currentPhase": "core"}
}
EOF
    _update_fixture_checksum "$dest"
}

# Create deep hierarchy for cascade-from tests (3 levels)
create_deep_hierarchy() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "test-project", "currentPhase": "core"},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Epic (root)", "description": "Root epic", "status": "done", "priority": "high", "type": "epic", "parentId": null, "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-20T10:00:00Z"},
    {"id": "T002", "title": "Task (L1 child)", "description": "Level 1 child", "status": "done", "priority": "medium", "type": "task", "parentId": "T001", "createdAt": "2025-11-02T10:00:00Z", "completedAt": "2025-11-15T10:00:00Z"},
    {"id": "T003", "title": "Subtask (L2 child)", "description": "Level 2 grandchild", "status": "done", "priority": "low", "type": "subtask", "parentId": "T002", "createdAt": "2025-11-03T10:00:00Z", "completedAt": "2025-11-10T10:00:00Z"},
    {"id": "T004", "title": "Another L1 child", "description": "Sibling", "status": "done", "priority": "medium", "type": "task", "parentId": "T001", "createdAt": "2025-11-04T10:00:00Z", "completedAt": "2025-11-18T10:00:00Z"},
    {"id": "T005", "title": "Independent task", "description": "Not in hierarchy", "status": "pending", "priority": "low", "type": "task", "parentId": null, "createdAt": "2025-11-10T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$dest"
}

# Create tasks with dependency relationships for safe mode tests
create_tasks_with_dependents() {
    local dest="${1:-$TODO_FILE}"
    cat > "$dest" << 'EOF'
{
  "version": "2.3.0",
  "project": {"name": "test-project", "currentPhase": "setup"},
  "_meta": {"version": "2.3.0", "checksum": "placeholder"},
  "tasks": [
    {"id": "T001", "title": "Foundation task", "description": "Base task", "status": "done", "priority": "high", "createdAt": "2025-11-01T10:00:00Z", "completedAt": "2025-11-05T10:00:00Z"},
    {"id": "T002", "title": "Dependent task", "description": "Depends on T001", "status": "pending", "priority": "medium", "depends": ["T001"], "createdAt": "2025-11-02T10:00:00Z"},
    {"id": "T003", "title": "Done dependent", "description": "Also depends on T001 but done", "status": "done", "priority": "low", "depends": ["T001"], "createdAt": "2025-11-03T10:00:00Z", "completedAt": "2025-11-10T10:00:00Z"},
    {"id": "T004", "title": "Independent done", "description": "No deps, done", "status": "done", "priority": "medium", "createdAt": "2025-11-04T10:00:00Z", "completedAt": "2025-11-08T10:00:00Z"}
  ],
  "focus": {}
}
EOF
    _update_fixture_checksum "$dest"
}
