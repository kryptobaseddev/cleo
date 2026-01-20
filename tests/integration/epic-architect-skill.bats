#!/usr/bin/env bats
# Epic Architect Skill Validation Tests
# Compares old subagent template vs new skill format

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file 2>/dev/null || true
}

setup() {
    load '../test_helper/common_setup'
    common_setup 2>/dev/null || true

    # Set project root
    PROJECT_ROOT="${BATS_TEST_DIRNAME}/../.."
    cd "$PROJECT_ROOT"
}

# Paths (relative to project root)
# OLD_TEMPLATE removed - subagent-prompts directory deprecated and deleted
NEW_SKILL="skills/epic-architect/SKILL.md"
NEW_REFERENCES="skills/epic-architect/references"
SHARED_DIR="skills/_shared"

# ============================================================================
# STRUCTURE TESTS
# ============================================================================

@test "epic-architect skill: SKILL.md exists" {
    [[ -f "$NEW_SKILL" ]]
}

@test "epic-architect skill: references directory exists" {
    [[ -d "$NEW_REFERENCES" ]]
}

@test "epic-architect skill: has commands.md reference" {
    [[ -f "$NEW_REFERENCES/commands.md" ]]
}

@test "epic-architect skill: has patterns.md reference" {
    [[ -f "$NEW_REFERENCES/patterns.md" ]]
}

@test "epic-architect skill: has output-format.md reference" {
    [[ -f "$NEW_REFERENCES/output-format.md" ]]
}

@test "epic-architect skill: old template removed (migration complete)" {
    # OLD_TEMPLATE was: templates/orchestrator-protocol/subagent-prompts/EPIC-ARCHITECT.md
    # Verify it no longer exists (migration complete)
    [[ ! -f "templates/orchestrator-protocol/subagent-prompts/EPIC-ARCHITECT.md" ]]
}

# ============================================================================
# FRONTMATTER TESTS
# ============================================================================

@test "epic-architect skill: has valid YAML frontmatter" {
    # Check starts with ---
    head -1 "$NEW_SKILL" | grep -q "^---$"
}

@test "epic-architect skill: frontmatter has name field" {
    grep -q "^name: epic-architect$" "$NEW_SKILL"
}

@test "epic-architect skill: frontmatter has description field" {
    grep -q "^description:" "$NEW_SKILL"
}

@test "epic-architect skill: frontmatter has version 2.1.0" {
    grep -q "^version: 2.1.0$" "$NEW_SKILL"
}

@test "epic-architect skill: frontmatter has model: sonnet" {
    grep -q "^model: sonnet$" "$NEW_SKILL"
}

@test "epic-architect skill: description includes 5+ trigger phrases" {
    # Count quoted phrases in description
    trigger_count=$(head -10 "$NEW_SKILL" | grep -oP '"[^"]+"' | wc -l)
    [[ $trigger_count -ge 5 ]]
}

# ============================================================================
# LINE COUNT / SIZE TESTS
# ============================================================================

@test "epic-architect skill: SKILL.md under 500 lines" {
    lines=$(wc -l < "$NEW_SKILL")
    [[ $lines -lt 500 ]]
}

@test "epic-architect skill: combined content exceeds original (progressive disclosure)" {
    old_lines=$(wc -l < "$OLD_TEMPLATE")
    new_skill_lines=$(wc -l < "$NEW_SKILL")
    new_refs_lines=$(cat "$NEW_REFERENCES"/*.md | wc -l)
    new_total=$((new_skill_lines + new_refs_lines))

    # New format should have similar or more content when references are included
    [[ $new_total -ge $((old_lines - 100)) ]]
}

# ============================================================================
# CLEO COMMAND COVERAGE TESTS
# ============================================================================

@test "epic-architect skill: has cleo add command (or token)" {
    grep -q -E "(cleo add|TASK_ADD_CMD)" "$NEW_SKILL" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has cleo complete command (or token)" {
    grep -q -E "(cleo complete|TASK_COMPLETE_CMD)" "$NEW_SKILL" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has session start command (or token)" {
    grep -q -E "(cleo session start|TASK_SESSION_START_CMD)" "$NEW_SKILL" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has focus set command (or token)" {
    grep -q -E "(cleo focus set|TASK_FOCUS_CMD)" "$NEW_SKILL" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has phase show command (or token)" {
    grep -q -E "(cleo phase show|TASK_PHASE_CMD)" "$NEW_SKILL" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has exists command (or token)" {
    grep -q -E "(cleo exists|TASK_EXISTS_CMD)" "$NEW_SKILL" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has tree command (or token)" {
    grep -q -E "(cleo tree|TASK_TREE_CMD)" "$NEW_SKILL" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has verify command (or token)" {
    grep -q -E "(cleo verify|TASK_VERIFY_CMD)" "$NEW_SKILL" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has analyze command (or token)" {
    grep -q -E "(cleo analyze|TASK_ANALYZE_CMD)" "$NEW_SKILL" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has archive command (or token)" {
    grep -q -E "(cleo archive|TASK_ARCHIVE_CMD)" "$NEW_SKILL" "$NEW_REFERENCES"/*.md
}

# ============================================================================
# CONTENT COVERAGE TESTS
# ============================================================================

@test "epic-architect skill: has Epic Structure section" {
    grep -qi "Epic Structure" "$NEW_SKILL"
}

@test "epic-architect skill: has Task Decomposition section" {
    grep -qi "Task Decomposition" "$NEW_SKILL"
}

@test "epic-architect skill: has Dependency Analysis section" {
    grep -qi "Dependency" "$NEW_SKILL"
}

@test "epic-architect skill: has Wave Planning section" {
    grep -qi "Wave" "$NEW_SKILL"
}

@test "epic-architect skill: has Phase Discipline section" {
    grep -qi "Phase" "$NEW_SKILL"
}

@test "epic-architect skill: has HITL Clarification guidance" {
    grep -qi "Clarif" "$NEW_SKILL"
}

@test "epic-architect skill: has Hierarchy Constraints" {
    grep -qi "Hierarchy" "$NEW_SKILL"
}

@test "epic-architect skill: has Anti-Patterns section" {
    grep -qi "Anti-Pattern" "$NEW_SKILL"
}

@test "epic-architect skill: has Completion Checklist" {
    grep -qi "Checklist" "$NEW_SKILL"
}

@test "epic-architect skill: has Error Handling section" {
    grep -qi "Error" "$NEW_SKILL"
}

# ============================================================================
# PATTERN COVERAGE (references)
# ============================================================================

@test "epic-architect skill: has Research Epic Pattern" {
    grep -qi "Research Epic" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has Bug Epic Pattern" {
    grep -qi "Bug Epic" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has Task Naming Conventions" {
    grep -qi "Naming Convention" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has Output File Format template" {
    grep -qi "Output File" "$NEW_REFERENCES"/*.md
}

@test "epic-architect skill: has Manifest Entry Format" {
    grep -qi "Manifest" "$NEW_REFERENCES"/*.md
}

# ============================================================================
# SHARED REFERENCES TESTS
# ============================================================================

@test "epic-architect skill: references task-system-integration.md" {
    grep -q "task-system-integration.md" "$NEW_SKILL"
}

@test "epic-architect skill: references subagent-protocol-base.md" {
    grep -q "subagent-protocol-base.md" "$NEW_SKILL"
}

@test "epic-architect skill: _shared/task-system-integration.md exists" {
    [[ -f "$SHARED_DIR/task-system-integration.md" ]]
}

@test "epic-architect skill: _shared/subagent-protocol-base.md exists" {
    [[ -f "$SHARED_DIR/subagent-protocol-base.md" ]]
}

# ============================================================================
# TOKEN REFERENCE TESTS
# ============================================================================

@test "epic-architect skill: has token reference table" {
    grep -q "Token.*Default" "$NEW_REFERENCES/commands.md"
}

@test "epic-architect skill: defines TASK_ADD_CMD token" {
    grep -q "TASK_ADD_CMD" "$NEW_REFERENCES/commands.md"
}

@test "epic-architect skill: defines OUTPUT_DIR token" {
    grep -q "OUTPUT_DIR" "$NEW_REFERENCES/commands.md"
}

@test "epic-architect skill: defines MANIFEST_PATH token" {
    grep -q "MANIFEST_PATH" "$NEW_REFERENCES/commands.md"
}

# ============================================================================
# SKILL QUALITY TESTS (migration validation removed - old template deleted)
# ============================================================================

@test "epic-architect: skill uses token abstraction" {
    # New format should have token placeholders
    token_count=$(grep -oP '\{\{[A-Z_]+\}\}' "$NEW_SKILL" | wc -l || true)
    [[ $token_count -gt 10 ]]
}

@test "epic-architect: skill has minimal hardcoded cleo commands" {
    # Skills should use tokens instead of hardcoded commands
    # Some hardcoded references are OK in documentation sections
    cleo_count=$(grep -c "cleo " "$NEW_SKILL" || true)
    [[ $cleo_count -lt 30 ]]
}

# ============================================================================
# VERSION TESTS
# ============================================================================

@test "epic-architect: version is set" {
    new_version=$(grep "^version:" "$NEW_SKILL" | head -1 | awk '{print $2}')
    # Version should be set (2.1.0 or later)
    [[ -n "$new_version" ]]
}

# ============================================================================
# EXAMPLES TESTS
# ============================================================================

@test "epic-architect skill: examples directory exists" {
    [[ -d "skills/epic-architect/examples" ]]
}

@test "epic-architect skill: has feature-epic-example.md" {
    [[ -f "skills/epic-architect/examples/feature-epic-example.md" ]]
}

@test "epic-architect skill: has bug-epic-example.md" {
    [[ -f "skills/epic-architect/examples/bug-epic-example.md" ]]
}

@test "epic-architect skill: has research-epic-example.md" {
    [[ -f "skills/epic-architect/examples/research-epic-example.md" ]]
}

@test "epic-architect skill: has migration-epic-example.md" {
    [[ -f "skills/epic-architect/examples/migration-epic-example.md" ]]
}

@test "epic-architect skill: feature example has dependency graph" {
    grep -q "Dependency Graph" "skills/epic-architect/examples/feature-epic-example.md"
}

@test "epic-architect skill: feature example has wave analysis" {
    grep -q "Wave Analysis" "skills/epic-architect/examples/feature-epic-example.md"
}

@test "epic-architect skill: bug example has severity mapping" {
    grep -q "Severity" "skills/epic-architect/examples/bug-epic-example.md"
}

@test "epic-architect skill: research example has 3 patterns" {
    # Should have exploratory, decision, and codebase analysis
    grep -qi "exploratory" "skills/epic-architect/examples/research-epic-example.md"
    grep -qi "decision" "skills/epic-architect/examples/research-epic-example.md"
    grep -qi "codebase" "skills/epic-architect/examples/research-epic-example.md"
}

@test "epic-architect skill: migration example has rollback" {
    grep -qi "rollback" "skills/epic-architect/examples/migration-epic-example.md"
}

# ============================================================================
# SKILL-AWARE EXECUTION TESTS
# ============================================================================

@test "epic-architect skill: has skill-aware-execution.md reference" {
    [[ -f "$NEW_REFERENCES/skill-aware-execution.md" ]]
}

@test "epic-architect skill: SKILL.md references skill-aware-execution" {
    grep -q "skill-aware-execution.md" "$NEW_SKILL"
}

@test "epic-architect skill: skill-aware-execution has orchestrator workflow" {
    grep -qi "orchestrator" "$NEW_REFERENCES/skill-aware-execution.md"
}

@test "epic-architect skill: skill-aware-execution has subagent patterns" {
    grep -qi "subagent" "$NEW_REFERENCES/skill-aware-execution.md"
}

@test "epic-architect skill: skill-aware-execution has research integration" {
    grep -qi "research" "$NEW_REFERENCES/skill-aware-execution.md"
}

# ============================================================================
# INSTALLATION TESTS
# ============================================================================

@test "epic-architect skill: installation script exists" {
    [[ -f "scripts/epic-architect-install.sh" ]]
}

@test "epic-architect skill: installation script is executable" {
    [[ -x "scripts/epic-architect-install.sh" ]]
}

@test "epic-architect skill: installation script has help" {
    scripts/epic-architect-install.sh --help | grep -q "USAGE"
}
