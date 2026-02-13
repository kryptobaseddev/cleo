#!/usr/bin/env bats
# skill-paths-caamp.bats - Integration tests for multi-source skill resolution pipeline
#
# Tests the full CT-SKILLS migration pipeline:
#   1. skill-paths.sh multi-source resolution (embedded/auto/caamp modes)
#   2. manifest-resolver.sh v3.0.0 manifest generation
#   3. skill-dispatch.sh with embedded and CAAMP-installed skills
#   4. Cache invalidation and graceful degradation
#
# @task T4387

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file 2>/dev/null || true
}

setup() {
    load '../test_helper/common_setup'
    common_setup 2>/dev/null || true
    PROJECT_ROOT="${BATS_TEST_DIRNAME}/../.."
    cd "$PROJECT_ROOT"

    # Source the modules under test
    source lib/skills/skill-paths.sh
    source lib/skills/manifest-resolver.sh
}

teardown() {
    # Restore default skill source
    unset CLEO_SKILL_SOURCE
    unset CLEO_SKILL_PATH
    unset CLEO_MANIFEST_CACHE_TTL
}

# ============================================================================
# SKILL-PATHS.SH: MULTI-SOURCE RESOLUTION
# ============================================================================

# --- CLEO_SKILL_SOURCE=embedded ---

@test "skill-paths: embedded mode returns only project skills directory" {
    CLEO_SKILL_SOURCE=embedded
    local paths
    paths=$(get_skill_search_paths)

    [[ -n "$paths" ]]
    echo "$paths" | grep -q "skills$"
    # Should NOT contain .agents path
    ! echo "$paths" | grep -q "\.agents"
}

@test "skill-paths: embedded mode resolves protocol from legacy protocols/ dir" {
    CLEO_SKILL_SOURCE=embedded
    local proto
    proto=$(resolve_protocol_path "research")

    [[ -n "$proto" ]]
    [[ -f "$proto" ]]
    echo "$proto" | grep -q "protocols/research.md"
}

@test "skill-paths: embedded mode resolves shared resource from _shared/ dir" {
    CLEO_SKILL_SOURCE=embedded
    local shared
    shared=$(resolve_shared_path "subagent-protocol-base")

    [[ -n "$shared" ]]
    [[ -f "$shared" ]]
    echo "$shared" | grep -q "_shared/subagent-protocol-base.md"
}

# --- CLEO_SKILL_SOURCE=caamp ---

@test "skill-paths: caamp mode returns only CAAMP canonical directory" {
    CLEO_SKILL_SOURCE=caamp
    local paths
    paths=$(get_skill_search_paths)

    if [[ -d "${HOME}/.agents/skills" ]]; then
        echo "$paths" | grep -q "\.agents/skills"
        # Should NOT contain project skills path
        local proj_skills="${PROJECT_ROOT}/skills"
        ! echo "$paths" | grep -qF "$proj_skills"
    else
        # CAAMP not installed - paths should be empty
        [[ -z "$paths" ]]
    fi
}

@test "skill-paths: caamp mode resolves CAAMP-installed skills" {
    CLEO_SKILL_SOURCE=caamp

    # Skip if CAAMP not available
    if [[ ! -d "${HOME}/.agents/skills" ]]; then
        skip "CAAMP not installed at ~/.agents/skills"
    fi

    # ct-task-executor should be in CAAMP
    local skill_dir
    skill_dir=$(resolve_skill_path "ct-task-executor") || skip "ct-task-executor not in CAAMP"

    [[ -d "$skill_dir" ]]
    [[ -f "${skill_dir}/SKILL.md" ]]
    echo "$skill_dir" | grep -q "\.agents/skills"
}

# --- CLEO_SKILL_SOURCE=auto ---

@test "skill-paths: auto mode returns CAAMP before embedded" {
    CLEO_SKILL_SOURCE=auto
    local paths
    paths=$(get_skill_search_paths)

    [[ -n "$paths" ]]

    if [[ -d "${HOME}/.agents/skills" ]]; then
        # CAAMP should appear first in the output
        local first_line
        first_line=$(echo "$paths" | head -1)
        echo "$first_line" | grep -q "\.agents/skills"
    fi
}

@test "skill-paths: auto mode resolves skills from CAAMP with embedded fallback" {
    CLEO_SKILL_SOURCE=auto

    if [[ -d "${HOME}/.agents/skills" ]]; then
        # Should resolve ct-task-executor (installed in CAAMP)
        local skill_dir
        skill_dir=$(resolve_skill_path "ct-task-executor") || fail "ct-task-executor not found in auto mode"
        [[ -d "$skill_dir" ]]
    fi

    # Should still resolve protocols from embedded
    local proto
    proto=$(resolve_protocol_path "research") || fail "research protocol not found in auto mode"
    [[ -f "$proto" ]]
}

# --- CLEO_SKILL_PATH override ---

@test "skill-paths: CLEO_SKILL_PATH override takes highest priority" {
    local tmpdir="${BATS_TEST_TMPDIR}/custom-skills"
    mkdir -p "${tmpdir}/test-skill"
    echo "# Test" > "${tmpdir}/test-skill/SKILL.md"

    CLEO_SKILL_PATH="$tmpdir"
    local paths
    paths=$(get_skill_search_paths)

    # Custom path should appear
    echo "$paths" | grep -qF "$tmpdir"

    # Should resolve the custom skill
    local skill_dir
    skill_dir=$(resolve_skill_path "test-skill")
    [[ "$skill_dir" == *"custom-skills/test-skill"* ]]
}

@test "skill-paths: CLEO_SKILL_PATH with colon-separated paths" {
    local tmpdir1="${BATS_TEST_TMPDIR}/skills-a"
    local tmpdir2="${BATS_TEST_TMPDIR}/skills-b"
    mkdir -p "$tmpdir1" "$tmpdir2"

    CLEO_SKILL_PATH="${tmpdir1}:${tmpdir2}"
    local paths
    paths=$(get_skill_search_paths)

    echo "$paths" | grep -qF "$tmpdir1"
    echo "$paths" | grep -qF "$tmpdir2"
}

@test "skill-paths: CLEO_SKILL_PATH ignores non-existent directories" {
    CLEO_SKILL_PATH="/nonexistent/path/skills"
    local paths
    paths=$(get_skill_search_paths)

    # Non-existent path should NOT appear
    ! echo "$paths" | grep -qF "/nonexistent/path/skills"
}

# --- Source type classification ---

@test "skill-paths: get_skill_source_type classifies embedded skills" {
    CLEO_SKILL_SOURCE=embedded
    local proj_skills="${PROJECT_ROOT}/skills"

    if [[ -d "${proj_skills}/_shared" ]]; then
        local source_type
        source_type=$(get_skill_source_type "${proj_skills}/_shared")
        [[ "$source_type" == "embedded" ]]
    else
        skip "No embedded skills directory"
    fi
}

@test "skill-paths: get_skill_source_type classifies CAAMP skills" {
    if [[ ! -d "${HOME}/.agents/skills" ]]; then
        skip "CAAMP not installed"
    fi

    # Find first skill dir in CAAMP
    local first_skill
    first_skill=$(find "${HOME}/.agents/skills" -maxdepth 1 -mindepth 1 -type d | head -1)
    [[ -n "$first_skill" ]] || skip "No skills in CAAMP"

    local source_type
    source_type=$(get_skill_source_type "$first_skill")
    [[ "$source_type" == "caamp" ]]
}

# --- Missing skill handling ---

@test "skill-paths: resolve_skill_path returns 1 for missing skill" {
    run resolve_skill_path "nonexistent-skill-xyz"
    [[ "$status" -eq 1 ]]
}

@test "skill-paths: resolve_protocol_path returns 1 for missing protocol" {
    run resolve_protocol_path "nonexistent-protocol-xyz"
    [[ "$status" -eq 1 ]]
}

@test "skill-paths: resolve_shared_path returns 1 for missing resource" {
    run resolve_shared_path "nonexistent-shared-xyz"
    [[ "$status" -eq 1 ]]
}

# ============================================================================
# MANIFEST-RESOLVER.SH: CACHED MANIFEST GENERATION
# ============================================================================

@test "manifest-resolver: mr_resolve_manifest returns valid path" {
    mr_invalidate_cache
    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null)

    [[ -n "$manifest_path" ]]
    [[ -f "$manifest_path" ]]
}

@test "manifest-resolver: generated manifest is valid JSON" {
    mr_invalidate_cache
    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null)

    jq empty "$manifest_path"
}

@test "manifest-resolver: schema version is 3.0.0" {
    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null)

    local version
    version=$(jq -r '._meta.schemaVersion' "$manifest_path")
    [[ "$version" == "3.0.0" ]]
}

@test "manifest-resolver: totalSkills matches actual skills array length" {
    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null)

    local declared actual
    declared=$(jq -r '._meta.totalSkills' "$manifest_path")
    actual=$(jq -r '.skills | length' "$manifest_path")
    [[ "$declared" == "$actual" ]]
}

@test "manifest-resolver: skills have resolvedPath field (v3.0.0)" {
    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null)

    local count_with_path count_total
    count_total=$(jq -r '.skills | length' "$manifest_path")
    count_with_path=$(jq -r '[.skills[] | select(.resolvedPath != null)] | length' "$manifest_path")

    [[ "$count_total" -gt 0 ]]
    [[ "$count_with_path" -eq "$count_total" ]]
}

@test "manifest-resolver: skills have source field (v3.0.0)" {
    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null)

    local count_with_source count_total
    count_total=$(jq -r '.skills | length' "$manifest_path")
    count_with_source=$(jq -r '[.skills[] | select(.source != null)] | length' "$manifest_path")

    [[ "$count_total" -gt 0 ]]
    [[ "$count_with_source" -eq "$count_total" ]]
}

@test "manifest-resolver: source field values are valid" {
    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null)

    # All source values should be one of: embedded, caamp, project-link, global-link
    local invalid
    invalid=$(jq -r '.skills[].source | select(. != "embedded" and . != "caamp" and . != "project-link" and . != "global-link")' "$manifest_path")
    [[ -z "$invalid" ]]
}

@test "manifest-resolver: _meta includes sources array with path info" {
    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null)

    jq -e '._meta.sources | type == "array"' "$manifest_path" >/dev/null
    jq -e '._meta.sources | length > 0' "$manifest_path" >/dev/null
    jq -e '._meta.sources[0] | has("path", "type", "skillCount")' "$manifest_path" >/dev/null
}

@test "manifest-resolver: dispatch_matrix is preserved from embedded manifest" {
    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null)

    if [[ -f "${PROJECT_ROOT}/skills/manifest.json" ]]; then
        jq -e '.dispatch_matrix' "$manifest_path" >/dev/null
        jq -e '.dispatch_matrix | has("by_keyword", "by_task_type")' "$manifest_path" >/dev/null
    else
        skip "No embedded manifest.json for dispatch_matrix"
    fi
}

# --- Cache behavior ---

@test "manifest-resolver: cache is fresh after generation" {
    mr_invalidate_cache
    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null)

    mr_is_cache_fresh "$manifest_path"
}

@test "manifest-resolver: mr_invalidate_cache removes cache file" {
    # Ensure cache exists
    mr_resolve_manifest 2>/dev/null >/dev/null

    local cache_file="${HOME}/.cleo/cache/skills-manifest.json"
    [[ -f "$cache_file" ]]

    mr_invalidate_cache

    [[ ! -f "$cache_file" ]]
}

@test "manifest-resolver: fresh cache is reused without regeneration" {
    mr_invalidate_cache
    local manifest1 manifest2

    manifest1=$(mr_resolve_manifest 2>/dev/null)
    local mtime1
    mtime1=$(stat -c '%Y' "$manifest1" 2>/dev/null || stat -f '%m' "$manifest1" 2>/dev/null)

    # Second resolve should use cache (same mtime)
    manifest2=$(mr_resolve_manifest 2>/dev/null)
    local mtime2
    mtime2=$(stat -c '%Y' "$manifest2" 2>/dev/null || stat -f '%m' "$manifest2" 2>/dev/null)

    [[ "$manifest1" == "$manifest2" ]]
    [[ "$mtime1" == "$mtime2" ]]
}

@test "manifest-resolver: stale cache TTL can be overridden via env" {
    mr_invalidate_cache
    mr_resolve_manifest 2>/dev/null >/dev/null

    # Set TTL to 0 seconds to make cache immediately stale
    CLEO_MANIFEST_CACHE_TTL=0
    sleep 1

    local cache_file="${HOME}/.cleo/cache/skills-manifest.json"
    ! mr_is_cache_fresh "$cache_file"
}

# --- Graceful degradation ---

@test "manifest-resolver: falls back to embedded manifest when cache dir is unwritable" {
    local embedded="${PROJECT_ROOT}/skills/manifest.json"
    [[ -f "$embedded" ]] || skip "No embedded manifest.json"

    # Use non-existent cache dir that can't be created
    CLEO_MANIFEST_CACHE_DIR="/proc/nonexistent-cache-dir-$$"
    mr_invalidate_cache 2>/dev/null || true

    local manifest_path
    manifest_path=$(mr_resolve_manifest 2>/dev/null) || true

    # Should fall back to embedded
    [[ -n "$manifest_path" ]]
    [[ -f "$manifest_path" ]]
}

# --- Frontmatter parsing ---

@test "manifest-resolver: mr_parse_skill_frontmatter parses YAML frontmatter" {
    # Find a skill with YAML frontmatter
    local skill_dir=""
    local search_path
    while IFS= read -r search_path; do
        local candidate
        for candidate in "${search_path}"/*/SKILL.md; do
            [[ -f "$candidate" ]] || continue
            local first_line
            first_line=$(head -1 "$candidate" | tr -d '\r')
            if [[ "$first_line" == "---" ]]; then
                skill_dir=$(dirname "$candidate")
                break 2
            fi
        done
    done < <(get_skill_search_paths)

    [[ -n "$skill_dir" ]] || skip "No skill with YAML frontmatter found"

    local json
    json=$(mr_parse_skill_frontmatter "$skill_dir")

    # Should be valid JSON with required fields
    echo "$json" | jq -e '.name' >/dev/null
    echo "$json" | jq -e '.version' >/dev/null
}

@test "manifest-resolver: mr_parse_skill_frontmatter returns 1 for missing SKILL.md" {
    run mr_parse_skill_frontmatter "/nonexistent/skill/dir"
    [[ "$status" -ne 0 ]]
}

# ============================================================================
# SKILL-DISPATCH.SH: DISPATCH WITH MULTI-SOURCE RESOLUTION
# ============================================================================

@test "skill-dispatch: sources skill-paths.sh and manifest-resolver.sh" {
    # Verify the modules are loaded by checking their guard variables
    source lib/skills/skill-dispatch.sh
    [[ -n "${_SKILL_PATHS_LOADED:-}" ]]
    [[ -n "${_MANIFEST_RESOLVER_LOADED:-}" ]]
}

@test "skill-dispatch: uses resolved manifest from manifest-resolver" {
    source lib/skills/skill-dispatch.sh

    # _SD_MANIFEST_JSON should point to a valid manifest
    [[ -n "${_SD_MANIFEST_JSON:-}" ]]
    [[ -f "$_SD_MANIFEST_JSON" ]]
    jq -e '.skills | type == "array"' "$_SD_MANIFEST_JSON" >/dev/null
}

@test "skill-dispatch: resolves protocol base from shared path resolver" {
    source lib/skills/skill-dispatch.sh

    # _SD_PROTOCOL_BASE should point to the subagent protocol base file
    [[ -n "${_SD_PROTOCOL_BASE:-}" ]]
    [[ -f "$_SD_PROTOCOL_BASE" ]]
}

@test "skill-dispatch: skill_dispatch_by_keywords returns skill name" {
    source lib/skills/skill-dispatch.sh

    local skill
    skill=$(skill_dispatch_by_keywords "implement authentication" 2>/dev/null) || true

    # Should return a skill name (may be default fallback)
    [[ -n "$skill" ]]
}

@test "skill-dispatch: skill_dispatch_by_type returns skill for known type" {
    source lib/skills/skill-dispatch.sh

    local skill
    skill=$(skill_dispatch_by_type "implementation" 2>/dev/null) || true

    [[ -n "$skill" ]]
}

@test "skill-dispatch: default fallback skill is ct-task-executor" {
    source lib/skills/skill-dispatch.sh

    # The default fallback is set as a constant
    [[ "$_SD_DEFAULT_SKILL" == "ct-task-executor" ]]
}

# ============================================================================
# CT-SKILLS REGISTRY INTEGRATION (via node/npm)
# ============================================================================

@test "ct-skills: registry package is importable" {
    if ! command -v node &>/dev/null; then
        skip "node not available"
    fi

    run node -e "require('@cleocode/ct-skills'); console.log('ok')" 2>/dev/null
    # Allow exit code 0 (success) - if package not installed, skip
    if [[ "$status" -ne 0 ]]; then
        skip "@cleocode/ct-skills not installed"
    fi
    [[ "$output" == "ok" ]]
}

@test "ct-skills: listSkills returns non-empty array" {
    if ! command -v node &>/dev/null; then
        skip "node not available"
    fi

    local count
    count=$(node -e "
        try {
            const ct = require('@cleocode/ct-skills');
            console.log(ct.listSkills().length);
        } catch(e) { process.exit(1); }
    " 2>/dev/null) || skip "@cleocode/ct-skills not available"

    [[ "$count" -gt 0 ]]
}

@test "ct-skills: getSkill returns valid skill entry" {
    if ! command -v node &>/dev/null; then
        skip "node not available"
    fi

    local json
    json=$(node -e "
        try {
            const ct = require('@cleocode/ct-skills');
            const s = ct.getSkill('ct-task-executor');
            console.log(JSON.stringify({name: s.name, version: s.version, category: s.category}));
        } catch(e) { process.exit(1); }
    " 2>/dev/null) || skip "@cleocode/ct-skills not available"

    echo "$json" | jq -e '.name == "ct-task-executor"' >/dev/null
    echo "$json" | jq -e '.version' >/dev/null
}

@test "ct-skills: getCoreSkills returns at least 1 skill" {
    if ! command -v node &>/dev/null; then
        skip "node not available"
    fi

    local count
    count=$(node -e "
        try {
            const ct = require('@cleocode/ct-skills');
            console.log(ct.getCoreSkills().length);
        } catch(e) { process.exit(1); }
    " 2>/dev/null) || skip "@cleocode/ct-skills not available"

    [[ "$count" -ge 1 ]]
}

@test "ct-skills: getSkillDependencies returns array" {
    if ! command -v node &>/dev/null; then
        skip "node not available"
    fi

    local result
    result=$(node -e "
        try {
            const ct = require('@cleocode/ct-skills');
            const deps = ct.getSkillDependencies('ct-task-executor');
            console.log(Array.isArray(deps) ? 'array' : 'not_array');
        } catch(e) { process.exit(1); }
    " 2>/dev/null) || skip "@cleocode/ct-skills not available"

    [[ "$result" == "array" ]]
}
