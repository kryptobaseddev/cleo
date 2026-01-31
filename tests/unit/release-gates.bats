#!/usr/bin/env bats
# @task T2823 - Release gates unit tests

setup() {
    load '../test_helper/common_setup'
    common_setup_per_test

    # Source the config library
    source "$BATS_TEST_DIRNAME/../../lib/config.sh"

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
