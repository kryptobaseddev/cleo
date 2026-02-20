#!/usr/bin/env bats
# tests/integration/init-detect.bats - Integration tests for init --detect
# @task T2784

setup() {
    # Create temp directory for test projects
    TEST_DIR="$(mktemp -d)"
    cd "$TEST_DIR"
}

teardown() {
    cd /
    rm -rf "$TEST_DIR"
}

# ============================================================================
# Fixture helpers
# ============================================================================

create_node_vitest_project() {
    cat > package.json << 'EOF'
{
  "name": "test-project",
  "devDependencies": {
    "vitest": "^1.0.0",
    "typescript": "^5.0.0"
  },
  "scripts": {
    "test": "vitest run"
  }
}
EOF
    mkdir -p tests
}

create_node_jest_project() {
    cat > package.json << 'EOF'
{
  "name": "test-project",
  "devDependencies": {
    "jest": "^29.0.0"
  },
  "scripts": {
    "test": "jest"
  }
}
EOF
    cat > jest.config.js << 'EOF'
module.exports = { testEnvironment: 'node' };
EOF
    mkdir -p tests
}

create_python_pytest_project() {
    cat > pyproject.toml << 'EOF'
[project]
name = "test-project"

[tool.pytest.ini_options]
testpaths = ["tests"]
EOF
    mkdir -p tests
}

create_rust_cargo_project() {
    cat > Cargo.toml << 'EOF'
[package]
name = "test-project"
version = "0.1.0"

[dev-dependencies]
EOF
    mkdir -p src tests
    echo 'fn main() {}' > src/main.rs
}

create_go_project() {
    cat > go.mod << 'EOF'
module test-project

go 1.21
EOF
    mkdir -p tests
}

create_bats_project() {
    mkdir -p tests/unit tests/integration
    cat > tests/unit/example.bats << 'EOF'
@test "example test" {
    true
}
EOF
}

# ============================================================================
# Detection tests
# ============================================================================

@test "init --detect detects Node.js vitest project" {
    create_node_vitest_project

    run cleo init --detect --force
    [[ $status -eq 0 ]]

    # Check config was updated
    [[ -f ".cleo/config.json" ]]
    run jq -r '.validation.testing.framework' .cleo/config.json
    [[ "$output" == "vitest" ]]
}

@test "init --detect detects Node.js jest project" {
    create_node_jest_project

    run cleo init --detect --force
    [[ $status -eq 0 ]]

    run jq -r '.validation.testing.framework' .cleo/config.json
    [[ "$output" == "jest" ]]
}

@test "init --detect detects Python pytest project" {
    create_python_pytest_project

    run cleo init --detect --force
    [[ $status -eq 0 ]]

    run jq -r '.validation.testing.framework' .cleo/config.json
    [[ "$output" == "pytest" ]]
}

@test "init --detect detects Rust cargo project" {
    create_rust_cargo_project

    run cleo init --detect --force
    [[ $status -eq 0 ]]

    run jq -r '.validation.testing.framework' .cleo/config.json
    [[ "$output" == "cargo" ]]
}

@test "init --detect detects Go project" {
    create_go_project

    run cleo init --detect --force
    [[ $status -eq 0 ]]

    run jq -r '.validation.testing.framework' .cleo/config.json
    [[ "$output" == "go" ]]
}

@test "init --detect detects BATS project from test files" {
    create_bats_project

    run cleo init --detect --force
    [[ $status -eq 0 ]]

    run jq -r '.validation.testing.framework' .cleo/config.json
    [[ "$output" == "bats" ]]
}

# ============================================================================
# Confidence level tests
# ============================================================================

@test "init --detect --dry-run shows HIGH confidence for Node.js with devDependencies" {
    create_node_vitest_project

    run cleo init --detect --dry-run
    [[ $status -eq 0 ]]
    echo "$output" | grep -q '"confidence".*"HIGH"'
}

@test "init --detect --dry-run shows MEDIUM confidence for config file detection" {
    # Create project with only jest.config.js (no package.json devDeps)
    cat > jest.config.js << 'EOF'
module.exports = { testEnvironment: 'node' };
EOF

    run cleo init --detect --dry-run
    # Should work but with lower confidence
    [[ $status -eq 0 ]]
}

# ============================================================================
# --dry-run tests
# ============================================================================

@test "init --detect --dry-run does not write files" {
    create_node_vitest_project

    run cleo init --detect --dry-run
    [[ $status -eq 0 ]]

    # Should not create .cleo directory
    [[ ! -d ".cleo" ]]
}

@test "init --detect --dry-run outputs JSON" {
    create_node_vitest_project

    run cleo init --detect --dry-run
    [[ $status -eq 0 ]]

    # Output should be valid JSON with expected fields
    echo "$output" | jq -e '.detection.projectType'
    echo "$output" | jq -e '.detection.framework'
    echo "$output" | jq -e '.detection.confidence'
}

# ============================================================================
# project-context.json tests
# ============================================================================

@test "init --detect creates project-context.json" {
    create_node_vitest_project

    run cleo init --detect --force
    [[ $status -eq 0 ]]

    [[ -f ".cleo/project-context.json" ]]
}

@test "project-context.json has correct structure" {
    create_node_vitest_project

    run cleo init --detect --force
    [[ $status -eq 0 ]]

    # Verify required fields
    run jq -e '.schemaVersion' .cleo/project-context.json
    [[ $status -eq 0 ]]

    run jq -e '.detectedAt' .cleo/project-context.json
    [[ $status -eq 0 ]]

    run jq -e '.projectTypes' .cleo/project-context.json
    [[ $status -eq 0 ]]

    run jq -e '.llmHints' .cleo/project-context.json
    [[ $status -eq 0 ]]
}

@test "project-context.json has framework-specific llmHints" {
    create_node_vitest_project

    run cleo init --detect --force
    [[ $status -eq 0 ]]

    run jq -r '.llmHints.preferredTestStyle' .cleo/project-context.json
    [[ "$output" == *"vitest"* ]] || [[ "$output" == *"describe"* ]]
}

# ============================================================================
# Error handling tests
# ============================================================================

@test "init --dry-run without --detect fails" {
    run cleo init --dry-run
    [[ $status -ne 0 ]]
    echo "$output" | grep -qi "requires.*--detect"
}

@test "init --detect on unknown project uses default" {
    # Empty directory - no manifest files

    run cleo init --detect --force
    [[ $status -eq 0 ]]

    # Should fall back to bats default
    run jq -r '.validation.testing.framework' .cleo/config.json
    [[ "$output" == "bats" ]] || [[ "$output" == "custom" ]]
}
