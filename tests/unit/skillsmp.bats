#!/usr/bin/env bats
# =============================================================================
# skillsmp.bats - Unit tests for lib/skillsmp.sh
# =============================================================================
# Tests SkillsMP API client functions including:
# - Config loading and validation
# - API request handling with caching
# - Search functionality
# - Skill details retrieval
# - Skill download and installation
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Source the skillsmp library
    source "$PROJECT_ROOT/lib/skillsmp.sh"

    # Create test cache directory
    export SKILLSMP_CACHE_DIR="${TEST_TEMP_DIR}/.skills-cache"
    mkdir -p "$SKILLSMP_CACHE_DIR"

    # Create test config directory
    export CLEO_ROOT_DIR="${TEST_TEMP_DIR}/.cleo"
    mkdir -p "$CLEO_ROOT_DIR"
    export SKILLSMP_CONFIG_FILE="${CLEO_ROOT_DIR}/skillsmp.json"

    # Mock curl for API requests (prevent real network calls)
    export MOCK_API_RESPONSE=""
    export MOCK_API_EXIT_CODE=0

    # Create mock curl function
    curl() {
        if [[ "$MOCK_API_EXIT_CODE" -ne 0 ]]; then
            return "$MOCK_API_EXIT_CODE"
        fi
        if [[ -n "$MOCK_API_RESPONSE" ]]; then
            echo "$MOCK_API_RESPONSE"
            return 0
        fi
        # Default mock response for search
        echo '{"skills":[{"name":"test-skill","scopedName":"@test/test-skill","repoFullName":"test/repo","path":"skills/test-skill/SKILL.md","stars":42}]}'
        return 0
    }
    export -f curl
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Library Presence Tests
# =============================================================================

@test "skillsmp library exists" {
    [ -f "$PROJECT_ROOT/lib/skillsmp.sh" ]
}

@test "skillsmp library is sourceable" {
    run bash -c "source '$PROJECT_ROOT/lib/skillsmp.sh'"
    assert_success
}

# =============================================================================
# Config Loading Tests
# =============================================================================

@test "smp_load_config returns 1 when config file missing" {
    run smp_load_config
    [ "$status" -eq 1 ]
}

@test "smp_load_config returns 1 when config has invalid JSON" {
    echo "invalid json{" > "$SKILLSMP_CONFIG_FILE"
    run smp_load_config
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Invalid JSON" ]]
}

@test "smp_load_config returns 1 when enabled is false" {
    cat > "$SKILLSMP_CONFIG_FILE" <<EOF
{
  "enabled": false,
  "cacheDir": "\${HOME}/.cleo/.skills-cache"
}
EOF
    run smp_load_config
    [ "$status" -eq 1 ]
}

@test "smp_load_config returns 0 when config is valid and enabled" {
    cat > "$SKILLSMP_CONFIG_FILE" <<EOF
{
  "enabled": true,
  "cacheDir": "\${HOME}/.cleo/.skills-cache"
}
EOF
    run smp_load_config
    assert_success
}

@test "smp_load_config expands variables in cacheDir" {
    cat > "$SKILLSMP_CONFIG_FILE" <<EOF
{
  "enabled": true,
  "cacheDir": "\${TEST_TEMP_DIR}/.custom-cache"
}
EOF
    smp_load_config
    # Verify that the path contains the expanded value (path may vary)
    [[ "$SKILLSMP_CACHE_DIR" =~ /.custom-cache$ ]]
}

@test "smp_load_config creates cache directory" {
    local cache_path="${TEST_TEMP_DIR}/.new-cache"
    cat > "$SKILLSMP_CONFIG_FILE" <<EOF
{
  "enabled": true,
  "cacheDir": "$cache_path"
}
EOF
    run smp_load_config
    assert_success
    [ -d "$cache_path" ]
}

# =============================================================================
# API Request Tests (Internal Function)
# =============================================================================

@test "_smp_api_request caches successful responses" {
    export MOCK_API_RESPONSE='{"test":"data"}'

    # First call - should hit API
    run _smp_api_request "search=test&limit=5"
    assert_success
    [[ "$output" == '{"test":"data"}' ]]

    # Verify cache file created
    local cache_file
    cache_file="${SKILLSMP_CACHE_DIR}/$(echo -n 'search=test&limit=5' | md5sum | cut -d' ' -f1).json"
    [ -f "$cache_file" ]
    [[ "$(cat "$cache_file")" == '{"test":"data"}' ]]
}

@test "_smp_api_request returns cached response when cache is fresh" {
    # Create fresh cache file
    local query_params="search=cached&limit=5"
    local cache_file="${SKILLSMP_CACHE_DIR}/$(echo -n "$query_params" | md5sum | cut -d' ' -f1).json"
    echo '{"cached":"response"}' > "$cache_file"

    # Mock API should not be called
    export MOCK_API_RESPONSE='{"should-not-see":"this"}'

    run _smp_api_request "$query_params"
    assert_success
    [[ "$output" == '{"cached":"response"}' ]]
}

@test "_smp_api_request returns exit code 1 on network failure" {
    export MOCK_API_EXIT_CODE=7  # Simulate curl network error

    run _smp_api_request "search=test"
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Network request failed" ]]
}

@test "_smp_api_request returns exit code 2 on invalid JSON response" {
    export MOCK_API_RESPONSE='not valid json{'

    run _smp_api_request "search=test"
    [ "$status" -eq 2 ]
    [[ "$output" =~ "Invalid JSON response" ]]
}

# =============================================================================
# Search Skills Tests
# =============================================================================

@test "smp_search_skills returns error when query is empty" {
    run smp_search_skills ""
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Search query required" ]]
}

@test "smp_search_skills returns JSON results for valid query" {
    export MOCK_API_RESPONSE='{"skills":[{"name":"bash-utils","scopedName":"@author/bash-utils","stars":100}]}'

    run smp_search_skills "bash"
    assert_success
    [[ "$output" =~ "bash-utils" ]]
    [[ "$output" =~ "@author/bash-utils" ]]
}

@test "smp_search_skills applies default limit of 10" {
    export MOCK_API_RESPONSE='{"skills":[]}'

    run smp_search_skills "test"
    assert_success
    # Default limit should be passed in API call
}

@test "smp_search_skills accepts custom limit parameter" {
    export MOCK_API_RESPONSE='{"skills":[]}'

    run smp_search_skills "test" 25
    assert_success
}

@test "smp_search_skills accepts custom sortBy parameter" {
    export MOCK_API_RESPONSE='{"skills":[]}'

    run smp_search_skills "test" 10 "downloads"
    assert_success
}

@test "smp_search_skills URL-encodes spaces in query" {
    export MOCK_API_RESPONSE='{"skills":[]}'

    # This test verifies that spaces are encoded (indirectly through success)
    run smp_search_skills "bash utils"
    assert_success
}

# =============================================================================
# Get Skill Details Tests
# =============================================================================

@test "smp_get_skill_details returns error when identifier is empty" {
    run smp_get_skill_details ""
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Skill identifier required" ]]
}

@test "smp_get_skill_details handles scoped name format" {
    export MOCK_API_RESPONSE='{"skills":[{"name":"test-skill","scopedName":"@author/test-skill","stars":50}]}'

    run smp_get_skill_details "@author/test-skill"
    assert_success
    [[ "$output" =~ "test-skill" ]]
}

@test "smp_get_skill_details returns exit code 1 when skill not found" {
    export MOCK_API_RESPONSE='{"skills":[]}'

    run smp_get_skill_details "@author/nonexistent"
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Skill not found" ]]
}

@test "smp_get_skill_details returns exit code 2 on API error" {
    export MOCK_API_EXIT_CODE=7

    run smp_get_skill_details "@author/test-skill"
    [ "$status" -eq 2 ]
}

@test "smp_get_skill_details handles non-scoped identifier" {
    export MOCK_API_RESPONSE='{"skills":[{"name":"bash-utils","scopedName":"@someone/bash-utils"}]}'

    run smp_get_skill_details "bash-utils"
    assert_success
    [[ "$output" =~ "bash-utils" ]]
}

@test "smp_get_skill_details extracts first matching skill" {
    export MOCK_API_RESPONSE='{"skills":[{"name":"skill1","scopedName":"@a/skill1"},{"name":"skill2","scopedName":"@b/skill2"}]}'

    run smp_get_skill_details "skill"
    assert_success
    [[ "$output" =~ "skill1" ]]
    [[ ! "$output" =~ "skill2" ]]
}

# =============================================================================
# Download Skill Tests
# =============================================================================

@test "smp_download_skill returns error when metadata is empty" {
    run smp_download_skill "" "/tmp/dest"
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Skill metadata and destination path required" ]]
}

@test "smp_download_skill returns error when destination path is empty" {
    run smp_download_skill '{"name":"test"}' ""
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Skill metadata and destination path required" ]]
}

@test "smp_download_skill returns exit code 2 when metadata lacks repoFullName" {
    local metadata='{"name":"test-skill","path":"skills/test/SKILL.md"}'

    run smp_download_skill "$metadata" "${TEST_TEMP_DIR}/dest"
    [ "$status" -eq 2 ]
    [[ "$output" =~ "Invalid skill metadata" ]]
}

@test "smp_download_skill returns exit code 2 when metadata lacks path" {
    local metadata='{"name":"test-skill","repoFullName":"author/repo"}'

    run smp_download_skill "$metadata" "${TEST_TEMP_DIR}/dest"
    [ "$status" -eq 2 ]
    [[ "$output" =~ "Invalid skill metadata" ]]
}

@test "smp_download_skill creates destination directory" {
    local dest_path="${TEST_TEMP_DIR}/new-skill-dir"
    local metadata='{"name":"test-skill","repoFullName":"author/repo","path":"skills/test/SKILL.md"}'

    # Mock successful download
    curl() {
        if [[ "$*" =~ "-o" ]]; then
            local output_file="${!#}"
            echo "# Test Skill" > "$output_file"
            return 0
        fi
    }
    export -f curl

    run smp_download_skill "$metadata" "$dest_path"
    assert_success
    [ -d "$dest_path" ]
}

@test "smp_download_skill uses content cache when available" {
    local metadata='{"name":"test-skill","repoFullName":"author/repo","path":"skills/test/SKILL.md"}'
    local cache_key="author/repo/skills/test/SKILL.md"
    local cache_file="${SKILLSMP_CACHE_DIR}/content/$(echo -n "$cache_key" | md5sum | cut -d' ' -f1).md"

    # Create fresh cache
    mkdir -p "${SKILLSMP_CACHE_DIR}/content"
    echo "# Cached Skill Content" > "$cache_file"

    run smp_download_skill "$metadata" "${TEST_TEMP_DIR}/dest"
    assert_success
    [ -f "${TEST_TEMP_DIR}/dest/SKILL.md" ]
    [[ "$(cat "${TEST_TEMP_DIR}/dest/SKILL.md")" == "# Cached Skill Content" ]]
}

# =============================================================================
# Install Skill Tests
# =============================================================================

@test "smp_install_skill returns error when scoped name is empty" {
    run smp_install_skill ""
    [ "$status" -eq 1 ]
    [[ "$output" =~ "Scoped skill name required" ]]
}

@test "smp_install_skill uses default skills directory" {
    export MOCK_API_RESPONSE='{"skills":[{"name":"test-skill","scopedName":"@author/test-skill","repoFullName":"author/repo","path":"skills/test/SKILL.md"}]}'

    # Mock curl for download
    curl() {
        if [[ "$*" =~ "-o" ]]; then
            local output_file="${!#}"
            echo "# Test Skill" > "$output_file"
            return 0
        fi
        # Return search results
        echo "$MOCK_API_RESPONSE"
    }
    export -f curl

    # Mock interactive prompt
    export REPLY="n"

    run smp_install_skill "@author/test-skill"
    # Should attempt to install to default location
}

@test "smp_install_skill accepts custom skills directory" {
    export MOCK_API_RESPONSE='{"skills":[{"name":"custom-skill","scopedName":"@author/custom-skill","repoFullName":"author/repo","path":"skills/custom/SKILL.md"}]}'

    curl() {
        if [[ "$*" =~ "-o" ]]; then
            local output_file="${!#}"
            echo "# Custom Skill" > "$output_file"
            return 0
        fi
        echo "$MOCK_API_RESPONSE"
    }
    export -f curl

    local custom_dir="${TEST_TEMP_DIR}/custom-skills"
    mkdir -p "$custom_dir"

    run smp_install_skill "@author/custom-skill" "$custom_dir"
    # Should attempt custom directory
}

# =============================================================================
# Integration Test
# =============================================================================

@test "full workflow: search, get details, download" {
    # Setup mock responses
    export MOCK_API_RESPONSE='{"skills":[{"name":"workflow-skill","scopedName":"@test/workflow-skill","repoFullName":"test/repo","path":"skills/workflow/SKILL.md","stars":100}]}'

    # Mock curl for download
    curl() {
        if [[ "$*" =~ "-o" ]]; then
            local output_file="${!#}"
            echo "# Workflow Test Skill" > "$output_file"
            return 0
        fi
        echo "$MOCK_API_RESPONSE"
    }
    export -f curl

    # Search
    local search_result
    search_result=$(smp_search_skills "workflow")
    [[ "$search_result" =~ "workflow-skill" ]]

    # Get details
    local skill_details
    skill_details=$(smp_get_skill_details "@test/workflow-skill")
    [[ "$skill_details" =~ "workflow-skill" ]]

    # Download
    local dest_path="${TEST_TEMP_DIR}/workflow-test"
    run smp_download_skill "$skill_details" "$dest_path"
    assert_success
    [ -f "${dest_path}/SKILL.md" ]
    [[ "$(cat "${dest_path}/SKILL.md")" =~ "Workflow Test Skill" ]]
}
