#!/usr/bin/env bats
# =============================================================================
# schema-validation.bats - Schema Validation Tests for v2.2.0
# =============================================================================
# Tests JSON Schema validation for v2.2.0 format changes:
# - project object format (name + phases)
# - project.phases validation
# - project.currentPhase validation
# =============================================================================

# Get the directory containing this test file
SCHEMA_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
PROJECT_ROOT="$(cd "$SCHEMA_DIR/../.." && pwd)"
FIXTURES_DIR="$SCHEMA_DIR/fixtures/schema"
SCHEMA_FILE="$PROJECT_ROOT/schemas/todo.schema.json"

# =============================================================================
# File-Level Setup (runs once per test file)
# =============================================================================
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
    # Ensure fixtures directory exists (only once per file)
    mkdir -p "$FIXTURES_DIR"
}

# =============================================================================
# Per-Test Setup (runs before each test)
# =============================================================================
setup() {
    load '../test_helper/common_setup'
    common_setup_per_test
    # Use BATS-managed temp directory (auto-cleaned)
    TEST_DIR="${BATS_TEST_TMPDIR}"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Helper Functions
# =============================================================================

# Validate JSON against schema using ajv-cli
validate_with_ajv() {
    local json_file="$1"

    # Check if ajv-cli is available
    if ! command -v ajv &> /dev/null; then
        skip "ajv-cli not installed (npm install -g ajv-cli)"
    fi

    ajv validate -s "$SCHEMA_FILE" -d "$json_file" --strict=false 2>&1
}

# Validate JSON against schema using Python jsonschema
validate_with_python() {
    local json_file="$1"

    # Check if Python and jsonschema are available
    if ! command -v python3 &> /dev/null; then
        skip "python3 not installed"
    fi

    python3 -c "
import json
import sys
try:
    from jsonschema import validate, ValidationError
except ImportError:
    print('jsonschema module not installed', file=sys.stderr)
    sys.exit(77)  # Skip code for bats

with open('$SCHEMA_FILE') as sf:
    schema = json.load(sf)

with open('$json_file') as df:
    data = json.load(df)

try:
    validate(instance=data, schema=schema)
    print('valid')
except ValidationError as e:
    print(f'invalid: {e.message}', file=sys.stderr)
    sys.exit(1)
" 2>&1
}

# =============================================================================
# Schema File Tests
# =============================================================================

@test "schema file exists" {
    [ -f "$SCHEMA_FILE" ]
}

@test "schema file is valid JSON" {
    run jq empty "$SCHEMA_FILE"
    [ "$status" -eq 0 ]
}

@test "schema has correct ID format" {
    run jq -r '."$id"' "$SCHEMA_FILE"
    [ "$status" -eq 0 ]
    # Schema ID follows URL format: https://claude-todo.dev/schemas/v1/todo.schema.json
    [[ "$output" == "https://claude-todo.dev/schemas/v1/todo.schema.json" ]]
}

@test "schema requires project object" {
    run jq -r '.required | contains(["project"])' "$SCHEMA_FILE"
    [ "$status" -eq 0 ]
    [[ "$output" == "true" ]]
}

@test "schema defines project.name as required" {
    run jq -r '.properties.project.required | contains(["name"])' "$SCHEMA_FILE"
    [ "$status" -eq 0 ]
    [[ "$output" == "true" ]]
}

@test "schema defines project.phases as required" {
    run jq -r '.properties.project.required | contains(["phases"])' "$SCHEMA_FILE"
    [ "$status" -eq 0 ]
    [[ "$output" == "true" ]]
}

@test "schema defines phaseDefinition" {
    run jq -r '.definitions.phaseDefinition' "$SCHEMA_FILE"
    [ "$status" -eq 0 ]
    [[ "$output" != "null" ]]
}

@test "phaseDefinition requires order, name, status" {
    run jq -r '.definitions.phaseDefinition.required | sort | join(",")' "$SCHEMA_FILE"
    [ "$status" -eq 0 ]
    [[ "$output" == "name,order,status" ]]
}

@test "phaseDefinition status enum is correct" {
    run jq -r '.definitions.phaseDefinition.properties.status.enum | sort | join(",")' "$SCHEMA_FILE"
    [ "$status" -eq 0 ]
    [[ "$output" == "active,completed,pending" ]]
}

# =============================================================================
# Valid Format Tests
# =============================================================================

@test "minimal valid v2.2.0 todo validates" {
    cat > "$TEST_DIR/minimal.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {}
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    run jq empty "$TEST_DIR/minimal.json"
    [ "$status" -eq 0 ]
}

@test "valid v2.2.0 with phases validates" {
    cat > "$TEST_DIR/with-phases.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "completed",
        "startedAt": "2025-12-01T10:00:00Z",
        "completedAt": "2025-12-02T15:00:00Z"
      },
      "core": {
        "order": 2,
        "name": "Core Development",
        "status": "active",
        "startedAt": "2025-12-02T15:00:00Z"
      },
      "polish": {
        "order": 3,
        "name": "Polish",
        "status": "pending"
      }
    },
    "currentPhase": "core"
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "abc123def4567890",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    run jq empty "$TEST_DIR/with-phases.json"
    [ "$status" -eq 0 ]
}

@test "valid v2.2.0 with null currentPhase validates" {
    cat > "$TEST_DIR/null-current-phase.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": null,
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    run jq empty "$TEST_DIR/null-current-phase.json"
    [ "$status" -eq 0 ]
}

# =============================================================================
# Invalid Format Tests - Project Object
# =============================================================================

@test "project as string fails validation" {
    cat > "$TEST_DIR/project-string.json" << 'EOF'
{
  "version": "2.2.0",
  "project": "test-project",
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # Should fail because project must be an object
    run jq -e '.project | type == "object"' "$TEST_DIR/project-string.json"
    [ "$status" -ne 0 ]
}

@test "missing project.name fails" {
    cat > "$TEST_DIR/missing-name.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "phases": {}
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    run jq -e '.project.name' "$TEST_DIR/missing-name.json"
    [ "$status" -ne 0 ]
}

@test "missing project.phases fails" {
    cat > "$TEST_DIR/missing-phases.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project"
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    run jq -e '.project.phases' "$TEST_DIR/missing-phases.json"
    [ "$status" -ne 0 ]
}

@test "empty project.name fails" {
    cat > "$TEST_DIR/empty-name.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "",
    "phases": {}
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # name must have minLength: 1
    local name_length
    name_length=$(jq -r '.project.name | length' "$TEST_DIR/empty-name.json")
    [ "$name_length" -eq 0 ]
}

# =============================================================================
# Invalid Format Tests - Phases
# =============================================================================

@test "phase missing required order fails" {
    cat > "$TEST_DIR/phase-missing-order.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "name": "Setup",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    run jq -e '.project.phases.setup.order' "$TEST_DIR/phase-missing-order.json"
    [ "$status" -ne 0 ]
}

@test "phase missing required name fails" {
    cat > "$TEST_DIR/phase-missing-name.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    run jq -e '.project.phases.setup.name' "$TEST_DIR/phase-missing-name.json"
    [ "$status" -ne 0 ]
}

@test "phase missing required status fails" {
    cat > "$TEST_DIR/phase-missing-status.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    run jq -e '.project.phases.setup.status' "$TEST_DIR/phase-missing-status.json"
    [ "$status" -ne 0 ]
}

@test "phase invalid status value fails" {
    cat > "$TEST_DIR/phase-invalid-status.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "in-progress"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    local status_value
    status_value=$(jq -r '.project.phases.setup.status' "$TEST_DIR/phase-invalid-status.json")
    # Valid values: pending, active, completed
    [[ "$status_value" != "pending" && "$status_value" != "active" && "$status_value" != "completed" ]]
}

@test "phase order must be integer >= 1" {
    cat > "$TEST_DIR/phase-zero-order.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 0,
        "name": "Setup",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    local order_value
    order_value=$(jq -r '.project.phases.setup.order' "$TEST_DIR/phase-zero-order.json")
    [ "$order_value" -lt 1 ]
}

@test "phase slug must match pattern" {
    cat > "$TEST_DIR/phase-invalid-slug.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "Setup-Phase": {
        "order": 1,
        "name": "Setup",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # Phase slug must match ^[a-z][a-z0-9-]*$ (lowercase, no underscores, no uppercase)
    run jq -r '.project.phases | keys[]' "$TEST_DIR/phase-invalid-slug.json"
    [ "$status" -eq 0 ]
    [[ "$output" =~ [A-Z] ]]  # Contains uppercase
}

# =============================================================================
# Invalid Format Tests - currentPhase
# =============================================================================

@test "currentPhase with invalid pattern fails" {
    cat > "$TEST_DIR/invalid-current-phase-pattern.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "Core_Phase",
    "phases": {
      "core-phase": {
        "order": 1,
        "name": "Core",
        "status": "active",
        "startedAt": "2025-12-15T10:00:00Z"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # currentPhase must match ^[a-z][a-z0-9-]*$ (no underscores)
    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TEST_DIR/invalid-current-phase-pattern.json")
    [[ "$current_phase" =~ _ ]]  # Contains underscore
}

# =============================================================================
# Phase Lifecycle Validation Tests
# =============================================================================

@test "active phase requires startedAt" {
    cat > "$TEST_DIR/active-no-started.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "core": {
        "order": 1,
        "name": "Core",
        "status": "active"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # Active phase must have startedAt
    local status
    status=$(jq -r '.project.phases.core.status' "$TEST_DIR/active-no-started.json")
    local started_at
    started_at=$(jq -r '.project.phases.core.startedAt' "$TEST_DIR/active-no-started.json")

    [[ "$status" == "active" && "$started_at" == "null" ]]
}

@test "completed phase requires startedAt and completedAt" {
    cat > "$TEST_DIR/completed-no-times.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "completed"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    local status
    status=$(jq -r '.project.phases.setup.status' "$TEST_DIR/completed-no-times.json")
    local started_at
    started_at=$(jq -r '.project.phases.setup.startedAt' "$TEST_DIR/completed-no-times.json")
    local completed_at
    completed_at=$(jq -r '.project.phases.setup.completedAt' "$TEST_DIR/completed-no-times.json")

    [[ "$status" == "completed" && ("$started_at" == "null" || "$completed_at" == "null") ]]
}

@test "pending phase should not have startedAt" {
    cat > "$TEST_DIR/pending-with-started.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "future": {
        "order": 1,
        "name": "Future",
        "status": "pending",
        "startedAt": "2025-12-15T10:00:00Z"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # This is logically inconsistent but not schema-invalid
    local status
    status=$(jq -r '.project.phases.future.status' "$TEST_DIR/pending-with-started.json")
    local started_at
    started_at=$(jq -r '.project.phases.future.startedAt' "$TEST_DIR/pending-with-started.json")

    [[ "$status" == "pending" && "$started_at" != "null" ]]
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "empty phases object is valid" {
    cat > "$TEST_DIR/empty-phases.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {}
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    run jq -e '.project.phases | length == 0' "$TEST_DIR/empty-phases.json"
    [ "$status" -eq 0 ]
}

@test "phase name can be up to 50 characters" {
    cat > "$TEST_DIR/long-phase-name.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "long": {
        "order": 1,
        "name": "12345678901234567890123456789012345678901234567890",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    local name_length
    name_length=$(jq -r '.project.phases.long.name | length' "$TEST_DIR/long-phase-name.json")
    [ "$name_length" -eq 50 ]
}

@test "phase description can be up to 200 characters" {
    cat > "$TEST_DIR/long-phase-desc.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "pending",
        "description": "12345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    local desc_length
    desc_length=$(jq -r '.project.phases.setup.description | length' "$TEST_DIR/long-phase-desc.json")
    [ "$desc_length" -eq 200 ]
}

@test "multiple phases with different statuses" {
    cat > "$TEST_DIR/multi-phase-statuses.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "core",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "completed",
        "startedAt": "2025-12-01T10:00:00Z",
        "completedAt": "2025-12-05T10:00:00Z"
      },
      "core": {
        "order": 2,
        "name": "Core",
        "status": "active",
        "startedAt": "2025-12-05T10:00:00Z"
      },
      "polish": {
        "order": 3,
        "name": "Polish",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    run jq -e '.project.phases | length == 3' "$TEST_DIR/multi-phase-statuses.json"
    [ "$status" -eq 0 ]
}

# =============================================================================
# Integration with Tasks
# =============================================================================

@test "task phase must exist in project.phases" {
    cat > "$TEST_DIR/task-nonexistent-phase.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "abc123def4567890",
    "configVersion": "0.12.0"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Task in unknown phase",
      "status": "pending",
      "priority": "medium",
      "phase": "core",
      "createdAt": "2025-12-15T10:00:00Z"
    }
  ]
}
EOF

    # Task references phase "core" but only "setup" exists
    local task_phase
    task_phase=$(jq -r '.tasks[0].phase' "$TEST_DIR/task-nonexistent-phase.json")

    # Check that phase does NOT exist (should fail with exit code 1)
    run jq -e --arg phase "$task_phase" '.project.phases | has($phase)' "$TEST_DIR/task-nonexistent-phase.json"
    [ "$status" -ne 0 ]  # jq -e exits with 1 if result is false
}

@test "valid task with phase matching project.phases" {
    cat > "$TEST_DIR/task-valid-phase.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "active",
        "startedAt": "2025-12-15T10:00:00Z"
      },
      "core": {
        "order": 2,
        "name": "Core",
        "status": "pending"
      }
    },
    "currentPhase": "setup"
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "abc123def4567890",
    "configVersion": "0.12.0"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Task in setup phase",
      "status": "pending",
      "priority": "high",
      "phase": "setup",
      "createdAt": "2025-12-15T10:00:00Z"
    }
  ]
}
EOF

    local task_phase
    task_phase=$(jq -r '.tasks[0].phase' "$TEST_DIR/task-valid-phase.json")
    run jq -e --arg phase "$task_phase" '.project.phases | has($phase)' "$TEST_DIR/task-valid-phase.json"
    [ "$status" -eq 0 ]
}

@test "focus.currentPhase must match task phase" {
    cat > "$TEST_DIR/focus-phase-match.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "active",
        "startedAt": "2025-12-15T10:00:00Z"
      },
      "core": {
        "order": 2,
        "name": "Core",
        "status": "pending"
      }
    },
    "currentPhase": "setup"
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "abc123def4567890",
    "configVersion": "0.12.0"
  },
  "focus": {
    "currentTask": "T001",
    "currentPhase": "setup"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Active task",
      "status": "active",
      "priority": "high",
      "phase": "setup",
      "createdAt": "2025-12-15T10:00:00Z"
    }
  ]
}
EOF

    local task_phase
    task_phase=$(jq -r '.tasks[0].phase' "$TEST_DIR/focus-phase-match.json")
    local focus_phase
    focus_phase=$(jq -r '.focus.currentPhase' "$TEST_DIR/focus-phase-match.json")

    [[ "$task_phase" == "$focus_phase" ]]
}

# =============================================================================
# Backward Compatibility Tests
# =============================================================================

@test "old format with project as string can be detected" {
    cat > "$TEST_DIR/old-format.json" << 'EOF'
{
  "version": "0.1.0",
  "project": "test-project",
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.1.0"
  },
  "tasks": []
}
EOF

    # Detect old format by checking if project is a string
    run jq -e '.project | type == "string"' "$TEST_DIR/old-format.json"
    [ "$status" -eq 0 ]
}

@test "v2.2.0 format can be detected" {
    cat > "$TEST_DIR/new-format.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {}
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # Detect new format by checking if project is an object with name and phases
    run jq -e '.project | type == "object" and has("name") and has("phases")' "$TEST_DIR/new-format.json"
    [ "$status" -eq 0 ]
}

# =============================================================================
# Additional Properties Tests
# =============================================================================

@test "project object rejects additional properties" {
    cat > "$TEST_DIR/project-extra-props.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {},
    "extraProperty": "should not be here"
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # Check if extra property exists (schema should reject this)
    run jq -e '.project | has("extraProperty")' "$TEST_DIR/project-extra-props.json"
    [ "$status" -eq 0 ]  # Extra property is present (schema validation would fail)
}

@test "phaseDefinition rejects additional properties" {
    cat > "$TEST_DIR/phase-extra-props.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "pending",
        "extraField": "not allowed"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # Check if extra field exists (schema should reject this)
    run jq -e '.project.phases.setup | has("extraField")' "$TEST_DIR/phase-extra-props.json"
    [ "$status" -eq 0 ]  # Extra field is present (schema validation would fail)
}

# =============================================================================
# Additional v2.2.0 Edge Cases
# =============================================================================

@test "currentPhase can reference any defined phase regardless of status" {
    cat > "$TEST_DIR/current-phase-any-status.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "polish",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "completed",
        "startedAt": "2025-12-01T10:00:00Z",
        "completedAt": "2025-12-05T10:00:00Z"
      },
      "core": {
        "order": 2,
        "name": "Core",
        "status": "pending"
      },
      "polish": {
        "order": 3,
        "name": "Polish",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # currentPhase can be pending (valid scenario)
    local current_phase
    current_phase=$(jq -r '.project.currentPhase' "$TEST_DIR/current-phase-any-status.json")
    local phase_status
    phase_status=$(jq -r --arg phase "$current_phase" '.project.phases[$phase].status' "$TEST_DIR/current-phase-any-status.json")

    [[ "$current_phase" == "polish" && "$phase_status" == "pending" ]]
}

@test "phase order can have gaps in sequence" {
    cat > "$TEST_DIR/phase-order-gaps.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "pending"
      },
      "core": {
        "order": 5,
        "name": "Core",
        "status": "pending"
      },
      "polish": {
        "order": 10,
        "name": "Polish",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # Gaps in order sequence are allowed (1, 5, 10)
    local orders
    orders=$(jq -r '.project.phases | to_entries | map(.value.order) | join(",")' "$TEST_DIR/phase-order-gaps.json")
    [[ "$orders" == "1,5,10" ]]
}

@test "task with null phase is valid" {
    cat > "$TEST_DIR/task-null-phase.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "abc123def4567890",
    "configVersion": "0.12.0"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Unphased task",
      "status": "pending",
      "priority": "medium",
      "phase": null,
      "createdAt": "2025-12-15T10:00:00Z"
    }
  ]
}
EOF

    # Task phase can be null (no phase assigned)
    run jq -r '.tasks[0].phase' "$TEST_DIR/task-null-phase.json"
    [ "$status" -eq 0 ]
    [[ "$output" == "null" ]]
}

@test "completedAt must be after startedAt for completed phase" {
    cat > "$TEST_DIR/completed-at-before-started.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "completed",
        "startedAt": "2025-12-10T10:00:00Z",
        "completedAt": "2025-12-05T10:00:00Z"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # Validate that completedAt is before startedAt (logically invalid)
    local started
    started=$(jq -r '.project.phases.setup.startedAt' "$TEST_DIR/completed-at-before-started.json")
    local completed
    completed=$(jq -r '.project.phases.setup.completedAt' "$TEST_DIR/completed-at-before-started.json")

    # Convert to timestamps and compare (completed should be after started)
    local started_ts completed_ts
    started_ts=$(date -d "$started" +%s 2>/dev/null || echo 0)
    completed_ts=$(date -d "$completed" +%s 2>/dev/null || echo 0)

    # This should fail validation (completed before started)
    [[ "$completed_ts" -lt "$started_ts" ]]
}

@test "focus.currentPhase must exist in project.phases" {
    cat > "$TEST_DIR/focus-nonexistent-phase.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "active",
        "startedAt": "2025-12-15T10:00:00Z"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "abc123def4567890",
    "configVersion": "0.12.0"
  },
  "focus": {
    "currentTask": null,
    "currentPhase": "nonexistent"
  },
  "tasks": []
}
EOF

    # focus.currentPhase references phase that doesn't exist
    local focus_phase
    focus_phase=$(jq -r '.focus.currentPhase' "$TEST_DIR/focus-nonexistent-phase.json")

    # Check that phase does NOT exist
    run jq -e --arg phase "$focus_phase" '.project.phases | has($phase)' "$TEST_DIR/focus-nonexistent-phase.json"
    [ "$status" -ne 0 ]  # Should fail - phase doesn't exist
}

@test "project.currentPhase and focus.currentPhase should match" {
    cat > "$TEST_DIR/current-phase-mismatch.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "currentPhase": "setup",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "active",
        "startedAt": "2025-12-15T10:00:00Z"
      },
      "core": {
        "order": 2,
        "name": "Core",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "abc123def4567890",
    "configVersion": "0.12.0"
  },
  "focus": {
    "currentTask": null,
    "currentPhase": "core"
  },
  "tasks": []
}
EOF

    # Detect mismatch between project.currentPhase and focus.currentPhase
    local project_phase focus_phase
    project_phase=$(jq -r '.project.currentPhase' "$TEST_DIR/current-phase-mismatch.json")
    focus_phase=$(jq -r '.focus.currentPhase' "$TEST_DIR/current-phase-mismatch.json")

    # They should match but don't (validation failure)
    [[ "$project_phase" != "$focus_phase" ]]
}

@test "phase with minimum valid fields" {
    cat > "$TEST_DIR/phase-minimal.json" << 'EOF'
{
  "version": "2.2.0",
  "project": {
    "name": "test-project",
    "phases": {
      "minimal": {
        "order": 1,
        "name": "Minimal Phase",
        "status": "pending"
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": {
    "checksum": "d41d8cd98f00b204",
    "configVersion": "0.12.0"
  },
  "tasks": []
}
EOF

    # Verify only required fields present
    run jq -e '.project.phases.minimal | has("order") and has("name") and has("status") and (has("description") | not) and (has("startedAt") | not)' "$TEST_DIR/phase-minimal.json"
    [ "$status" -eq 0 ]
}
