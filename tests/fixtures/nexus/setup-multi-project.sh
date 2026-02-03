#!/usr/bin/env bash
# setup-multi-project.sh - Setup 3 mock projects for Nexus testing
#
# Creates a realistic multi-project scenario with cross-project dependencies:
# - Project A: Auth system (read permission)
# - Project B: API gateway (write permission)
# - Project C: Frontend (not registered - for orphan/permission tests)

setup_multi_project_fixture() {
    # Project A - Auth system
    cat > "$TEST_DIR/project-a/.cleo/todo.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "2.6.0",
    "projectHash": "a1b2c3d4e5f6"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Implement login",
      "description": "Create login endpoint with JWT",
      "labels": ["auth", "api"],
      "status": "pending",
      "created": "2026-01-15T10:00:00Z"
    },
    {
      "id": "T002",
      "title": "Add JWT support",
      "description": "Token generation and validation",
      "labels": ["auth", "security"],
      "status": "pending",
      "depends": ["T001"],
      "created": "2026-01-15T11:00:00Z"
    }
  ]
}
EOF

    # Project B - API gateway
    cat > "$TEST_DIR/project-b/.cleo/todo.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "2.6.0",
    "projectHash": "b2c3d4e5f6a1"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Setup routes",
      "description": "Configure API routing",
      "labels": ["api", "routing"],
      "status": "done",
      "created": "2026-01-14T10:00:00Z"
    },
    {
      "id": "T002",
      "title": "Add auth middleware",
      "description": "Integrate authentication",
      "labels": ["auth", "api"],
      "status": "pending",
      "depends": ["project-a:T002"],
      "created": "2026-01-15T12:00:00Z"
    }
  ]
}
EOF

    # Project C - Frontend (not registered)
    cat > "$TEST_DIR/project-c/.cleo/todo.json" << 'EOF'
{
  "_meta": {
    "schemaVersion": "2.6.0",
    "projectHash": "c3d4e5f6a1b2"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Login page",
      "description": "UI for login form",
      "labels": ["auth", "ui"],
      "status": "pending",
      "created": "2026-01-15T13:00:00Z"
    }
  ]
}
EOF

    # Initialize Nexus and register A and B only
    nexus_init

    # Register project-a with read permission
    nexus_register "$TEST_DIR/project-a" "project-a" "read"

    # Register project-b with write permission
    nexus_register "$TEST_DIR/project-b" "project-b" "write"

    # project-c remains unregistered for orphan/permission tests
}

# Helper: Create additional tasks in registered projects
add_task_to_project() {
    local project_dir="${1}"
    local task_id="${2}"
    local title="${3}"
    local depends="${4:-}"

    local todo_file="${project_dir}/.cleo/todo.json"

    local new_task
    new_task=$(jq -n \
        --arg id "$task_id" \
        --arg title "$title" \
        --arg created "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        '{
            id: $id,
            title: $title,
            description: $title,
            labels: [],
            status: "pending",
            created: $created
        }')

    if [[ -n "$depends" ]]; then
        new_task=$(echo "$new_task" | jq --argjson depends "$depends" '. + {depends: $depends}')
    fi

    jq --argjson task "$new_task" '.tasks += [$task]' "$todo_file" > "${todo_file}.tmp"
    mv "${todo_file}.tmp" "$todo_file"
}

# Helper: Update task dependencies
update_task_dependencies() {
    local project_dir="${1}"
    local task_id="${2}"
    local depends="${3}"

    local todo_file="${project_dir}/.cleo/todo.json"

    jq --arg id "$task_id" --argjson depends "$depends" \
        '(.tasks[] | select(.id == $id)) |= (. + {depends: $depends})' \
        "$todo_file" > "${todo_file}.tmp"
    mv "${todo_file}.tmp" "$todo_file"
}

# Helper: Set task status
set_task_status() {
    local project_dir="${1}"
    local task_id="${2}"
    local status="${3}"

    local todo_file="${project_dir}/.cleo/todo.json"

    jq --arg id "$task_id" --arg status "$status" \
        '(.tasks[] | select(.id == $id)).status = $status' \
        "$todo_file" > "${todo_file}.tmp"
    mv "${todo_file}.tmp" "$todo_file"
}

# Export helpers for use in tests
export -f setup_multi_project_fixture
export -f add_task_to_project
export -f update_task_dependencies
export -f set_task_status
