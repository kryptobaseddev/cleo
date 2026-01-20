#!/usr/bin/env bats
# Skills manifest validation tests

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file 2>/dev/null || true
}

setup() {
    load '../test_helper/common_setup'
    common_setup 2>/dev/null || true
    PROJECT_ROOT="${BATS_TEST_DIRNAME}/../.."
    cd "$PROJECT_ROOT"
}

MANIFEST="skills/manifest.json"
SCHEMA="schemas/skills-manifest.schema.json"

# ============================================================================
# MANIFEST STRUCTURE TESTS
# ============================================================================

@test "skills manifest: exists" {
    [[ -f "$MANIFEST" ]]
}

@test "skills manifest: valid JSON" {
    jq empty "$MANIFEST"
}

@test "skills manifest: schema exists" {
    [[ -f "$SCHEMA" ]]
}

@test "skills manifest: has _meta section" {
    jq -e '._meta' "$MANIFEST" >/dev/null
}

@test "skills manifest: has skills array" {
    jq -e '.skills | type == "array"' "$MANIFEST" >/dev/null
}

@test "skills manifest: totalSkills matches actual count" {
    declared=$(jq -r '._meta.totalSkills' "$MANIFEST")
    actual=$(jq -r '.skills | length' "$MANIFEST")
    [[ "$declared" == "$actual" ]]
}

# ============================================================================
# NAMING CONVENTION TESTS
# ============================================================================

@test "skills manifest: all skills use ct-* prefix" {
    local non_ct=$(jq -r '.skills[].name | select(startswith("ct-") | not)' "$MANIFEST")
    [[ -z "$non_ct" ]]
}

@test "skills manifest: no duplicate skill names" {
    local total=$(jq -r '.skills | length' "$MANIFEST")
    local unique=$(jq -r '[.skills[].name] | unique | length' "$MANIFEST")
    [[ "$total" == "$unique" ]]
}

# ============================================================================
# PATH VALIDATION TESTS
# ============================================================================

@test "skills manifest: all paths exist" {
    while IFS= read -r path; do
        [[ -d "$path" ]] || fail "Path does not exist: $path"
    done < <(jq -r '.skills[].path' "$MANIFEST")
}

@test "skills manifest: all skills have SKILL.md" {
    while IFS= read -r path; do
        [[ -f "$path/SKILL.md" ]] || fail "Missing SKILL.md in: $path"
    done < <(jq -r '.skills[].path' "$MANIFEST")
}

@test "skills manifest: paths match naming convention" {
    # Path should be skills/{name} where name matches the skill name
    while IFS= read -r line; do
        local name=$(echo "$line" | jq -r '.name')
        local path=$(echo "$line" | jq -r '.path')
        local expected_path="skills/$name"
        [[ "$path" == "$expected_path" ]] || fail "Path mismatch for $name: expected $expected_path, got $path"
    done < <(jq -c '.skills[]' "$MANIFEST")
}

# ============================================================================
# REQUIRED FIELDS TESTS
# ============================================================================

@test "skills manifest: all skills have name" {
    local missing=$(jq -r '.skills[] | select(.name == null or .name == "") | .path' "$MANIFEST")
    [[ -z "$missing" ]]
}

@test "skills manifest: all skills have version" {
    local missing=$(jq -r '.skills[] | select(.version == null or .version == "") | .name' "$MANIFEST")
    [[ -z "$missing" ]]
}

@test "skills manifest: all skills have description" {
    local missing=$(jq -r '.skills[] | select(.description == null or .description == "") | .name' "$MANIFEST")
    [[ -z "$missing" ]]
}

@test "skills manifest: all skills have path" {
    local missing=$(jq -r '.skills[] | select(.path == null or .path == "") | .name' "$MANIFEST")
    [[ -z "$missing" ]]
}

@test "skills manifest: all skills have status" {
    local missing=$(jq -r '.skills[] | select(.status == null or .status == "") | .name' "$MANIFEST")
    [[ -z "$missing" ]]
}

# ============================================================================
# STATUS VALIDATION TESTS
# ============================================================================

@test "skills manifest: all statuses are valid" {
    local invalid=$(jq -r '.skills[].status | select(. != "active" and . != "deprecated" and . != "experimental")' "$MANIFEST")
    [[ -z "$invalid" ]]
}

@test "skills manifest: at least one active skill" {
    local active_count=$(jq -r '[.skills[] | select(.status == "active")] | length' "$MANIFEST")
    [[ "$active_count" -gt 0 ]]
}

# ============================================================================
# VERSION FORMAT TESTS
# ============================================================================

@test "skills manifest: schemaVersion is semver format" {
    local version=$(jq -r '._meta.schemaVersion' "$MANIFEST")
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "skills manifest: skill versions are semver format" {
    while IFS= read -r version; do
        [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid version format: $version"
    done < <(jq -r '.skills[].version' "$MANIFEST")
}

# ============================================================================
# TAGS VALIDATION TESTS
# ============================================================================

@test "skills manifest: all skills have tags array" {
    local missing=$(jq -r '.skills[] | select(.tags == null or (.tags | type) != "array") | .name' "$MANIFEST")
    [[ -z "$missing" ]]
}

@test "skills manifest: tags are non-empty strings" {
    local invalid=$(jq -r '.skills[].tags[] | select(. == null or . == "" or (type != "string"))' "$MANIFEST")
    [[ -z "$invalid" ]]
}
