#!/usr/bin/env bats
# @task T2823 T2844 - Release gates unit tests

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Source the config library
    source "$BATS_TEST_DIRNAME/../../lib/core/config.sh"

    # Create temp config
    TEST_CONFIG=$(mktemp)
    export CONFIG_FILE="$TEST_CONFIG"
}

teardown() {
    # Clean up temp config if it exists
    if [[ -n "${TEST_CONFIG:-}" ]] && [[ -f "$TEST_CONFIG" ]]; then
        rm -f "$TEST_CONFIG"
    fi
}

@test "get_release_gates returns empty array when no config" {
    echo '{}' > "$TEST_CONFIG"
    result=$(get_release_gates)
    [[ "$result" == "[]" ]]
}

@test "get_release_gates returns gates array from config" {
    cat > "$TEST_CONFIG" << 'EOF'
{
  "validation": {
    "releaseGates": [
      {"name": "lint", "command": "echo ok", "required": true}
    ]
  }
}
EOF
    result=$(get_release_gates)
    echo "$result" | jq -e '.[0].name == "lint"'
}

@test "get_release_gates handles missing validation section" {
    echo '{"other": "value"}' > "$TEST_CONFIG"
    result=$(get_release_gates)
    [[ "$result" == "[]" ]]
}

@test "get_release_gates returns multiple gates in order" {
    cat > "$TEST_CONFIG" << 'EOF'
{
  "validation": {
    "releaseGates": [
      {"name": "lint", "command": "shellcheck *.sh", "required": true},
      {"name": "test", "command": "bats tests/", "required": true},
      {"name": "build", "command": "make build", "required": false}
    ]
  }
}
EOF
    result=$(get_release_gates)
    run jq -e 'length == 3' <<< "$result"
    assert_success
    run jq -e '.[0].name == "lint"' <<< "$result"
    assert_success
    run jq -e '.[1].name == "test"' <<< "$result"
    assert_success
    run jq -e '.[2].name == "build"' <<< "$result"
    assert_success
}

@test "get_release_gates preserves gate properties" {
    cat > "$TEST_CONFIG" << 'EOF'
{
  "validation": {
    "releaseGates": [
      {
        "name": "comprehensive-test",
        "command": "./run-tests.sh --full",
        "required": true,
        "timeout": 300,
        "description": "Run full test suite"
      }
    ]
  }
}
EOF
    result=$(get_release_gates)
    run jq -e '.[0].name == "comprehensive-test"' <<< "$result"
    assert_success
    run jq -e '.[0].command == "./run-tests.sh --full"' <<< "$result"
    assert_success
    run jq -e '.[0].required == true' <<< "$result"
    assert_success
    run jq -e '.[0].timeout == 300' <<< "$result"
    assert_success
    run jq -e '.[0].description == "Run full test suite"' <<< "$result"
    assert_success
}

@test "get_release_gates handles malformed JSON gracefully" {
    echo 'not json' > "$TEST_CONFIG"
    result=$(get_release_gates)
    [[ "$result" == "[]" ]]
}

@test "get_release_gates returns empty array when validation.releaseGates is null" {
    cat > "$TEST_CONFIG" << 'EOF'
{
  "validation": {
    "releaseGates": null
  }
}
EOF
    result=$(get_release_gates)
    [[ "$result" == "[]" ]]
}

@test "get_release_gates works when config file doesn't exist" {
    rm -f "$TEST_CONFIG"
    result=$(get_release_gates)
    [[ "$result" == "[]" ]]
}

# @task T2844 - New location tests
@test "get_release_gates_new returns gates from new release.gates location" {
    cat > "$TEST_CONFIG" << 'EOF'
{
  "release": {
    "gates": [
      {"name": "lint", "command": "echo ok", "required": true}
    ]
  }
}
EOF
    result=$(get_release_gates_new)
    echo "$result" | jq -e '.[0].name == "lint"'
}

@test "get_release_gates_new falls back to validation.releaseGates with warning" {
    cat > "$TEST_CONFIG" << 'EOF'
{
  "validation": {
    "releaseGates": [
      {"name": "old-gate", "command": "echo old", "required": true}
    ]
  }
}
EOF
    # Capture stderr and stdout separately
    stderr_file=$(mktemp)
    result=$(get_release_gates_new 2>"$stderr_file")
    stderr_content=$(cat "$stderr_file")
    rm -f "$stderr_file"

    # Should contain deprecation warning in stderr
    [[ "$stderr_content" =~ "DEPRECATION" ]]
    # Should still return the gates in stdout
    echo "$result" | jq -e '.[0].name == "old-gate"'
}

@test "get_release_gates_new falls back to orchestrator.validation.customGates with warning" {
    cat > "$TEST_CONFIG" << 'EOF'
{
  "orchestrator": {
    "validation": {
      "customGates": [
        {"name": "custom-gate", "command": "echo custom", "required": false}
      ]
    }
  }
}
EOF
    # Capture stderr and stdout separately
    stderr_file=$(mktemp)
    result=$(get_release_gates_new 2>"$stderr_file")
    stderr_content=$(cat "$stderr_file")
    rm -f "$stderr_file"

    # Should contain deprecation warning in stderr
    [[ "$stderr_content" =~ "DEPRECATION" ]]
    # Should still return the gates in stdout
    echo "$result" | jq -e '.[0].name == "custom-gate"'
}

@test "get_release_gates_new prefers new location over old" {
    cat > "$TEST_CONFIG" << 'EOF'
{
  "release": {
    "gates": [
      {"name": "new-gate", "command": "echo new", "required": true}
    ]
  },
  "validation": {
    "releaseGates": [
      {"name": "old-gate", "command": "echo old", "required": true}
    ]
  }
}
EOF
    result=$(get_release_gates_new)
    # Should use new location without warning
    [[ ! "$result" =~ "DEPRECATION" ]]
    echo "$result" | jq -e '.[0].name == "new-gate"'
}

@test "get_release_gates wraps get_release_gates_new for backward compatibility" {
    cat > "$TEST_CONFIG" << 'EOF'
{
  "release": {
    "gates": [
      {"name": "test", "command": "echo test", "required": true}
    ]
  }
}
EOF
    result=$(get_release_gates)
    echo "$result" | jq -e '.[0].name == "test"'
}
