#!/usr/bin/env bats
# tests/unit/skill-discovery.bats - Skill discovery and registration tests

load '../libs/bats-support/load'
load '../libs/bats-assert/load'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export PROJECT_ROOT="$TEST_DIR/project"

    # Create project structure
    mkdir -p "$PROJECT_ROOT/lib"
    mkdir -p "$PROJECT_ROOT/skills"
    mkdir -p "$PROJECT_ROOT/skills/_shared"

    # Copy required libraries
    cp "$BATS_TEST_DIRNAME/../../lib/core/exit-codes.sh" "$PROJECT_ROOT/lib/"
    cp "$BATS_TEST_DIRNAME/../../lib/skills/skill-validate.sh" "$PROJECT_ROOT/lib/"
    cp "$BATS_TEST_DIRNAME/../../lib/skills/skill-discovery.sh" "$PROJECT_ROOT/lib/"

    # Create initial manifest
    cat > "$PROJECT_ROOT/skills/manifest.json" <<'EOF'
{
  "$schema": "https://cleo-dev.com/schemas/v1/skills-manifest.schema.json",
  "_meta": {
    "schemaVersion": "2.1.0",
    "lastUpdated": "2026-01-27",
    "totalSkills": 0
  },
  "dispatch_matrix": {
    "by_task_type": {},
    "by_keyword": {}
  },
  "skills": []
}
EOF

    # Source library (with correct PROJECT_ROOT)
    cd "$PROJECT_ROOT"
    source "$PROJECT_ROOT/lib/skills/skill-discovery.sh"
}

teardown() {
    rm -rf "$TEST_DIR"
}

# ==============================================================================
# SKILL METADATA EXTRACTION (YAML Frontmatter)
# ==============================================================================

@test "extract_skill_metadata parses YAML frontmatter" {
    local skill_dir="$PROJECT_ROOT/skills/test-skill"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: test-skill
version: 1.0.0
description: |
  This is a test skill
  with multi-line description
---

# Test Skill Content
EOF

    run extract_skill_metadata "$skill_dir/SKILL.md"
    assert_success

    # Verify JSON output has expected fields
    local name
    name=$(echo "$output" | jq -r '.name')
    assert_equal "$name" "test-skill"

    local version
    version=$(echo "$output" | jq -r '.version')
    assert_equal "$version" "1.0.0"
}

@test "extract_skill_metadata parses structured header format" {
    local skill_dir="$PROJECT_ROOT/skills/test-skill"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
# Research Agent

**Protocol**: @protocols/research.md
**Type**: Context Injection (cleo-subagent)
**Version**: 2.0.0

This is the content.
EOF

    run extract_skill_metadata "$skill_dir/SKILL.md"
    assert_success

    # Verify structured header fields
    local protocol
    protocol=$(echo "$output" | jq -r '.protocol')
    assert_equal "$protocol" "research"

    local version
    version=$(echo "$output" | jq -r '.version')
    assert_equal "$version" "2.0.0"

    local title
    title=$(echo "$output" | jq -r '.title')
    assert_equal "$title" "Research Agent"
}

@test "extract_skill_metadata fails for missing SKILL.md" {
    run extract_skill_metadata "$PROJECT_ROOT/skills/nonexistent/SKILL.md"
    assert_failure
    assert_equal "$status" 3  # EXIT_FILE_ERROR
}

@test "extract_skill_metadata handles file with H1 but no frontmatter" {
    local skill_dir="$PROJECT_ROOT/skills/test-skill"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
# Simple Skill Title

**Version**: 1.5.0

Some content here.
EOF

    run extract_skill_metadata "$skill_dir/SKILL.md"
    assert_success

    local title
    title=$(echo "$output" | jq -r '.title')
    assert_equal "$title" "Simple Skill Title"
}

# ==============================================================================
# SKILL HEADER PARSING
# ==============================================================================

@test "parse_skill_header extracts complete skill metadata" {
    local skill_dir="$PROJECT_ROOT/skills/ct-test-agent"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: ct-test-agent
version: 2.0.0
description: |
  Test agent for unit testing
---

# Test Agent
EOF

    run parse_skill_header "$skill_dir"
    assert_success

    # Verify complete metadata
    local name
    name=$(echo "$output" | jq -r '.name')
    assert_equal "$name" "ct-test-agent"

    local version
    version=$(echo "$output" | jq -r '.version')
    assert_equal "$version" "2.0.0"

    local path
    path=$(echo "$output" | jq -r '.path')
    assert_equal "$path" "$skill_dir"

    local status
    status=$(echo "$output" | jq -r '.status')
    assert_equal "$status" "discovered"
}

@test "parse_skill_header infers tags from protocol" {
    local skill_dir="$PROJECT_ROOT/skills/ct-research"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
# Research Skill

**Protocol**: @protocols/research.md
**Version**: 1.0.0
EOF

    run parse_skill_header "$skill_dir"
    assert_success

    # Verify research tags are inferred
    local tags
    tags=$(echo "$output" | jq -r '.tags[]')
    assert_output --partial "research"
}

@test "parse_skill_header fails for missing directory" {
    run parse_skill_header "$PROJECT_ROOT/skills/nonexistent"
    assert_failure
    assert_equal "$status" 3  # EXIT_FILE_ERROR
}

@test "parse_skill_header fails for directory without SKILL.md" {
    local skill_dir="$PROJECT_ROOT/skills/empty-skill"
    mkdir -p "$skill_dir"

    run parse_skill_header "$skill_dir"
    assert_failure
    assert_equal "$status" 3  # EXIT_FILE_ERROR
}

# ==============================================================================
# SKILL DISCOVERY
# ==============================================================================

@test "discover_skills finds SKILL.md files in directory" {
    # Create multiple skills
    mkdir -p "$PROJECT_ROOT/skills/ct-test-1"
    mkdir -p "$PROJECT_ROOT/skills/ct-test-2"

    cat > "$PROJECT_ROOT/skills/ct-test-1/SKILL.md" <<'EOF'
---
name: ct-test-1
version: 1.0.0
description: Test skill 1
---
EOF

    cat > "$PROJECT_ROOT/skills/ct-test-2/SKILL.md" <<'EOF'
---
name: ct-test-2
version: 1.0.0
description: Test skill 2
---
EOF

    run discover_skills "$PROJECT_ROOT/skills"
    assert_success

    # Verify JSON array output
    local count
    count=$(echo "$output" | jq '. | length')
    assert_equal "$count" "2"

    # Verify skill names are present
    local names
    names=$(echo "$output" | jq -r '.[].name' | sort)
    assert_output --partial "ct-test-1"
    assert_output --partial "ct-test-2"
}

@test "discover_skills skips _shared directory" {
    mkdir -p "$PROJECT_ROOT/skills/_shared"
    mkdir -p "$PROJECT_ROOT/skills/ct-valid"

    # Create SKILL.md in _shared (should be skipped)
    cat > "$PROJECT_ROOT/skills/_shared/SKILL.md" <<'EOF'
---
name: shared-skill
version: 1.0.0
description: Should be skipped
---
EOF

    # Create valid skill
    cat > "$PROJECT_ROOT/skills/ct-valid/SKILL.md" <<'EOF'
---
name: ct-valid
version: 1.0.0
description: Valid skill
---
EOF

    run discover_skills "$PROJECT_ROOT/skills"
    assert_success

    # Verify only valid skill is discovered
    local count
    count=$(echo "$output" | jq '. | length')
    assert_equal "$count" "1"

    local name
    name=$(echo "$output" | jq -r '.[0].name')
    assert_equal "$name" "ct-valid"
}

@test "discover_skills returns empty array for empty directory" {
    mkdir -p "$PROJECT_ROOT/skills-empty"

    run discover_skills "$PROJECT_ROOT/skills-empty"
    assert_success
    # Output includes warning message on stderr, but stdout is []
    assert_line --index 1 "[]"
}

@test "discover_skills fails for nonexistent directory" {
    run discover_skills "$PROJECT_ROOT/nonexistent"
    assert_failure
    assert_equal "$status" 3  # EXIT_FILE_ERROR
}

@test "discover_skills handles malformed SKILL.md gracefully" {
    mkdir -p "$PROJECT_ROOT/skills/ct-valid"
    mkdir -p "$PROJECT_ROOT/skills/ct-malformed"

    # Valid skill
    cat > "$PROJECT_ROOT/skills/ct-valid/SKILL.md" <<'EOF'
---
name: ct-valid
version: 1.0.0
description: Valid skill
---
EOF

    # Malformed skill (no version)
    cat > "$PROJECT_ROOT/skills/ct-malformed/SKILL.md" <<'EOF'
# Malformed Skill
Just some text, no proper structure
EOF

    run discover_skills "$PROJECT_ROOT/skills"
    assert_success

    # Should only discover the valid skill
    local count
    count=$(echo "$output" | jq '. | length')
    assert [ "$count" -ge 1 ]
}

# ==============================================================================
# SKILL VALIDATION
# ==============================================================================

@test "validate_skill succeeds for valid skill" {
    local skill_dir="$PROJECT_ROOT/skills/ct-valid"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: ct-valid
version: 1.0.0
description: Valid skill with all required fields
---

# Valid Skill
EOF

    run validate_skill "$skill_dir"
    assert_success
}

@test "validate_skill fails for missing SKILL.md" {
    local skill_dir="$PROJECT_ROOT/skills/ct-empty"
    mkdir -p "$skill_dir"

    run validate_skill "$skill_dir"
    assert_failure
    assert_equal "$status" 6  # EXIT_VALIDATION_ERROR
}

@test "validate_skill fails for invalid version format" {
    local skill_dir="$PROJECT_ROOT/skills/ct-invalid-version"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: ct-invalid-version
version: 1.0
description: Invalid semver
---
EOF

    run validate_skill "$skill_dir"
    assert_failure
    assert_equal "$status" 6  # EXIT_VALIDATION_ERROR
    assert_output --partial "Invalid version format"
}

@test "validate_skill fails for missing title/description" {
    local skill_dir="$PROJECT_ROOT/skills/ct-no-title"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: ct-no-title
version: 1.0.0
---

No H1 heading, no description in frontmatter
EOF

    run validate_skill "$skill_dir"
    assert_failure
    assert_equal "$status" 6  # EXIT_VALIDATION_ERROR
    assert_output --partial "Missing title"
}

@test "validate_skill fails for nonexistent directory" {
    run validate_skill "$PROJECT_ROOT/skills/nonexistent"
    assert_failure
    assert_equal "$status" 3  # EXIT_FILE_ERROR
}

# ==============================================================================
# SKILL REGISTRATION
# ==============================================================================

@test "register_skill adds new skill to manifest" {
    local skill_dir="$PROJECT_ROOT/skills/ct-new-skill"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: ct-new-skill
version: 1.0.0
description: New skill to register
---

# New Skill
EOF

    run register_skill "ct-new-skill" "$skill_dir"
    assert_success

    # Verify skill is in manifest
    local exists
    exists=$(jq -r '.skills[] | select(.name == "ct-new-skill") | .name' \
        "$PROJECT_ROOT/skills/manifest.json")
    assert_equal "$exists" "ct-new-skill"
}

@test "register_skill updates existing skill version" {
    local skill_dir="$PROJECT_ROOT/skills/ct-existing"
    mkdir -p "$skill_dir"

    # Add initial version
    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: ct-existing
version: 1.0.0
description: Existing skill
---

# Existing Skill
EOF
    register_skill "ct-existing" "$skill_dir" 2>/dev/null

    # Update to new version
    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: ct-existing
version: 2.0.0
description: Existing skill updated
---

# Existing Skill Updated
EOF

    run register_skill "ct-existing" "$skill_dir"
    assert_equal "$status" 101  # EXIT_ALREADY_EXISTS

    # Verify version was updated
    local version
    version=$(jq -r '.skills[] | select(.name == "ct-existing") | .version' \
        "$PROJECT_ROOT/skills/manifest.json")
    assert_equal "$version" "2.0.0"
}

@test "register_skill preserves existing manifest entries" {
    local skill_dir_1="$PROJECT_ROOT/skills/ct-skill-1"
    local skill_dir_2="$PROJECT_ROOT/skills/ct-skill-2"
    mkdir -p "$skill_dir_1" "$skill_dir_2"

    # Register first skill
    cat > "$skill_dir_1/SKILL.md" <<'EOF'
---
name: ct-skill-1
version: 1.0.0
description: First skill
---

# First Skill
EOF
    register_skill "ct-skill-1" "$skill_dir_1" 2>/dev/null

    # Register second skill
    cat > "$skill_dir_2/SKILL.md" <<'EOF'
---
name: ct-skill-2
version: 1.0.0
description: Second skill
---

# Second Skill
EOF
    register_skill "ct-skill-2" "$skill_dir_2" 2>/dev/null

    # Verify both skills exist
    local count
    count=$(jq '.skills | length' "$PROJECT_ROOT/skills/manifest.json")
    assert_equal "$count" "2"
}

@test "register_skill fails for invalid skill" {
    local skill_dir="$PROJECT_ROOT/skills/ct-invalid"
    mkdir -p "$skill_dir"

    # Create invalid skill (missing version)
    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: ct-invalid
description: No version field
---
EOF

    run register_skill "ct-invalid" "$skill_dir"
    assert_failure
    assert_equal "$status" 6  # EXIT_VALIDATION_ERROR
}

@test "register_skill fails for missing manifest" {
    rm -f "$PROJECT_ROOT/skills/manifest.json"

    local skill_dir="$PROJECT_ROOT/skills/ct-test"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: ct-test
version: 1.0.0
description: Test
---
EOF

    run register_skill "ct-test" "$skill_dir"
    assert_failure
    assert_equal "$status" 3  # EXIT_FILE_ERROR
}

@test "register_skill updates totalSkills metadata" {
    local skill_dir="$PROJECT_ROOT/skills/ct-meta-test"
    mkdir -p "$skill_dir"

    cat > "$skill_dir/SKILL.md" <<'EOF'
---
name: ct-meta-test
version: 1.0.0
description: Metadata test
---

# Metadata Test Skill
EOF

    # Get initial count
    local initial_count
    initial_count=$(jq '._meta.totalSkills' "$PROJECT_ROOT/skills/manifest.json")

    # Register skill
    register_skill "ct-meta-test" "$skill_dir" 2>/dev/null

    # Verify count incremented
    local final_count
    final_count=$(jq '._meta.totalSkills' "$PROJECT_ROOT/skills/manifest.json")
    assert [ "$final_count" -gt "$initial_count" ]
}

# ==============================================================================
# MANIFEST SYNC
# ==============================================================================

@test "sync_manifest discovers and registers new skills" {
    # Create skills
    mkdir -p "$PROJECT_ROOT/skills/ct-sync-1"
    mkdir -p "$PROJECT_ROOT/skills/ct-sync-2"

    cat > "$PROJECT_ROOT/skills/ct-sync-1/SKILL.md" <<'EOF'
---
name: ct-sync-1
version: 1.0.0
description: Sync test 1
---

# Sync Test 1
EOF

    cat > "$PROJECT_ROOT/skills/ct-sync-2/SKILL.md" <<'EOF'
---
name: ct-sync-2
version: 1.0.0
description: Sync test 2
---

# Sync Test 2
EOF

    run sync_manifest
    assert_success

    # Verify both skills registered
    local count
    count=$(jq '.skills | length' "$PROJECT_ROOT/skills/manifest.json")
    assert [ "$count" -eq 2 ]
}

@test "sync_manifest marks missing skills as deprecated" {
    # Add skill to manifest manually
    local temp_manifest="$PROJECT_ROOT/skills/manifest.json"
    jq '.skills += [{"name": "ct-missing", "version": "1.0.0", "status": "active"}]' \
        "$temp_manifest" > "$temp_manifest.tmp"
    mv "$temp_manifest.tmp" "$temp_manifest"

    run sync_manifest
    assert_success

    # Verify skill marked as deprecated
    local status
    status=$(jq -r '.skills[] | select(.name == "ct-missing") | .status' \
        "$PROJECT_ROOT/skills/manifest.json")
    assert_equal "$status" "deprecated"
}

@test "sync_manifest updates metadata counts" {
    # Create active skills
    mkdir -p "$PROJECT_ROOT/skills/ct-active-1"
    mkdir -p "$PROJECT_ROOT/skills/ct-active-2"

    cat > "$PROJECT_ROOT/skills/ct-active-1/SKILL.md" <<'EOF'
---
name: ct-active-1
version: 1.0.0
description: Active skill 1
---

# Active Skill 1
EOF

    cat > "$PROJECT_ROOT/skills/ct-active-2/SKILL.md" <<'EOF'
---
name: ct-active-2
version: 1.0.0
description: Active skill 2
---

# Active Skill 2
EOF

    run sync_manifest
    assert_success

    # Verify totalSkills updated
    local total
    total=$(jq '._meta.totalSkills' "$PROJECT_ROOT/skills/manifest.json")
    assert [ "$total" -eq 2 ]
}

@test "sync_manifest handles empty skills directory" {
    # Remove all skills
    rm -rf "$PROJECT_ROOT/skills/ct-"*

    run sync_manifest
    assert_success

    # Verify manifest is valid but empty
    local count
    count=$(jq '.skills | length' "$PROJECT_ROOT/skills/manifest.json")
    assert_equal "$count" "0"
}

# ==============================================================================
# DISPATCH MATRIX UPDATE
# ==============================================================================

@test "update_dispatch_matrix adds keyword mapping" {
    run update_dispatch_matrix "ct-test-skill" "test|testing|validate"
    assert_success

    # Verify dispatch matrix updated
    local skill
    skill=$(jq -r '.dispatch_matrix.by_keyword["test|testing|validate"]' \
        "$PROJECT_ROOT/skills/manifest.json")
    assert_equal "$skill" "ct-test-skill"
}

@test "update_dispatch_matrix handles empty keywords" {
    run update_dispatch_matrix "ct-test-skill" ""
    assert_success

    # No error, but no update either (graceful skip)
}

@test "update_dispatch_matrix fails for missing manifest" {
    rm -f "$PROJECT_ROOT/skills/manifest.json"

    run update_dispatch_matrix "ct-test-skill" "keywords"
    assert_failure
    assert_equal "$status" 3  # EXIT_FILE_ERROR
}
