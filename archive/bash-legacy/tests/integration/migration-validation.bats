#!/usr/bin/env bats
# =============================================================================
# migration-validation.bats - Migration Completeness Validation Tests
# =============================================================================
# Tests for validating the CLEO Universal Subagent Architecture migration:
# - Skills converted to context injections
# - Injection files updated (AGENT-INJECTION.md, CLEO-INJECTION.md)
# - Orchestrator spawns cleo-subagent (not skill-specific agents)
# - Protocol stack (7 protocols) created and loadable
# - Init/upgrade scripts handle new injection format
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file

    # Set up paths for migration validation
    export SKILLS_DIR="${PROJECT_ROOT}/skills"
    export PROTOCOLS_DIR="${PROJECT_ROOT}/protocols"
    export TEMPLATES_DIR="${PROJECT_ROOT}/templates"
    export AGENTS_DIR="${PROJECT_ROOT}/agents"
    export DOCS_DIR="${PROJECT_ROOT}/docs"
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create empty todo for task operations
    create_empty_todo
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# SKILL CONVERSION VALIDATION TESTS
# =============================================================================

@test "skill conversion: task-oriented SKILL.md files have context injection header" {
    # Task-oriented skills should indicate they are context injections for cleo-subagent
    # Excludes: ct-orchestrator (special case), ct-docs-* (documentation lookup skills),
    #           ct-skill-* (skill management), contribution-protocol (standalone)
    for skill_dir in "${SKILLS_DIR}"/ct-*/; do
        local skill_file="${skill_dir}SKILL.md"
        [[ -f "$skill_file" ]] || continue

        local skill_name
        skill_name=$(basename "$skill_dir")

        # Skip special cases that don't use cleo-subagent architecture
        case "$skill_name" in
            ct-orchestrator) continue ;;    # Tier 0 coordinator
            ct-docs-*) continue ;;          # Documentation lookup (Context7)
            ct-skill-*) continue ;;         # Skill management utilities
        esac

        # Check for context injection indicators
        if ! grep -qi "Context Injection\|cleo-subagent\|Protocol.*:.*@protocols" "$skill_file"; then
            fail "Skill $skill_name missing context injection header or cleo-subagent reference"
        fi
    done
}

@test "skill conversion: no skills have agent frontmatter (except ct-orchestrator)" {
    # Skills should NOT have agent YAML frontmatter with model/allowed_tools
    # Only ct-orchestrator may have special frontmatter
    for skill_dir in "${SKILLS_DIR}"/ct-*/; do
        local skill_file="${skill_dir}SKILL.md"
        [[ -f "$skill_file" ]] || continue

        local skill_name
        skill_name=$(basename "$skill_dir")

        # ct-orchestrator is allowed to have frontmatter
        [[ "$skill_name" == "ct-orchestrator" ]] && continue

        # Check for agent-style frontmatter patterns
        if grep -q "^model: " "$skill_file"; then
            fail "Skill $skill_name has agent-style 'model:' frontmatter (should be context injection)"
        fi

        if grep -q "^allowed_tools:" "$skill_file"; then
            fail "Skill $skill_name has agent-style 'allowed_tools:' frontmatter (should be context injection)"
        fi
    done
}

@test "skill conversion: ct-orchestrator preserved as special case" {
    local orchestrator_skill="${SKILLS_DIR}/ct-orchestrator/SKILL.md"
    [[ -f "$orchestrator_skill" ]]

    # Orchestrator should have frontmatter with name and tier
    grep -q "^name: ct-orchestrator" "$orchestrator_skill"
    grep -q "^tier: 0" "$orchestrator_skill"
}

@test "skill conversion: skills reference protocols directory" {
    local skills_with_protocol_refs=0

    for skill_dir in "${SKILLS_DIR}"/ct-*/; do
        local skill_file="${skill_dir}SKILL.md"
        [[ -f "$skill_file" ]] || continue

        local skill_name
        skill_name=$(basename "$skill_dir")
        [[ "$skill_name" == "ct-orchestrator" ]] && continue

        # Check for protocol reference
        if grep -qi "@protocols/\|Protocol.*:.*protocols/" "$skill_file"; then
            skills_with_protocol_refs=$((skills_with_protocol_refs + 1))
        fi
    done

    # At least some skills should reference protocols
    [[ "$skills_with_protocol_refs" -gt 0 ]]
}

@test "skill conversion: ct-research-agent uses context injection format" {
    local research_skill="${SKILLS_DIR}/ct-research-agent/SKILL.md"
    [[ -f "$research_skill" ]]

    # Should have Context Injection header
    grep -qi "Context Injection" "$research_skill"

    # Should reference research protocol
    grep -qi "@protocols/research.md\|Protocol.*research" "$research_skill"

    # Should reference cleo-subagent
    grep -qi "cleo-subagent" "$research_skill"

    # Should NOT have model: or allowed_tools:
    ! grep -q "^model: " "$research_skill"
    ! grep -q "^allowed_tools:" "$research_skill"
}

@test "skill conversion: ct-task-executor uses context injection format" {
    local executor_skill="${SKILLS_DIR}/ct-task-executor/SKILL.md"
    [[ -f "$executor_skill" ]]

    # Should reference cleo-subagent
    grep -qi "cleo-subagent" "$executor_skill"

    # Should NOT have model: or allowed_tools:
    ! grep -q "^model: " "$executor_skill"
    ! grep -q "^allowed_tools:" "$executor_skill"
}

# =============================================================================
# INJECTION FILE VALIDATION TESTS
# =============================================================================

@test "injection files: AGENT-INJECTION.md references cleo-subagent" {
    local agent_injection="${TEMPLATES_DIR}/AGENT-INJECTION.md"
    [[ -f "$agent_injection" ]]

    # Should reference cleo-subagent architecture
    grep -qi "cleo-subagent" "$agent_injection"
}

@test "injection files: AGENT-INJECTION.md has 2-tier architecture section" {
    local agent_injection="${TEMPLATES_DIR}/AGENT-INJECTION.md"
    [[ -f "$agent_injection" ]]

    # Should document the 2-tier architecture
    grep -qi "2-tier\|Tier 0\|Tier 1" "$agent_injection"
}

@test "injection files: AGENT-INJECTION.md references protocol types" {
    local agent_injection="${TEMPLATES_DIR}/AGENT-INJECTION.md"
    [[ -f "$agent_injection" ]]

    # Should mention the 7 protocol types
    grep -qi "Protocol Types\|Research.*Decomposition\|Implementation.*Specification" "$agent_injection"
}

@test "injection files: CLEO-INJECTION.md exists and has architecture overview" {
    local cleo_injection="${TEMPLATES_DIR}/CLEO-INJECTION.md"
    [[ -f "$cleo_injection" ]]

    # Should have architecture overview
    grep -qi "Architecture Overview\|Universal Subagent" "$cleo_injection"
}

@test "injection files: CLEO-INJECTION.md defines ORC constraints" {
    local cleo_injection="${TEMPLATES_DIR}/CLEO-INJECTION.md"
    [[ -f "$cleo_injection" ]]

    # Should define orchestrator constraints
    grep -qi "ORC-001\|ORC-002\|ORC-003" "$cleo_injection"
}

@test "injection files: CLEO-INJECTION.md defines BASE constraints" {
    local cleo_injection="${TEMPLATES_DIR}/CLEO-INJECTION.md"
    [[ -f "$cleo_injection" ]]

    # Should define base protocol constraints
    grep -qi "BASE-001\|BASE-002\|MUST append ONE line to MANIFEST" "$cleo_injection"
}

@test "injection files: injection markers present in CLAUDE.md" {
    local claude_md="${PROJECT_ROOT}/CLAUDE.md"
    [[ -f "$claude_md" ]]

    # Should have CLEO injection markers
    grep -q "<!-- CLEO:START -->" "$claude_md"
    grep -q "<!-- CLEO:END -->" "$claude_md"
}

# =============================================================================
# ORCHESTRATOR VALIDATION TESTS
# =============================================================================

@test "orchestrator: skill dispatch uses cleo-subagent" {
    local orchestrator_skill="${SKILLS_DIR}/ct-orchestrator/SKILL.md"
    [[ -f "$orchestrator_skill" ]]

    # Should reference cleo-subagent for spawning
    grep -qi "cleo-subagent" "$orchestrator_skill"

    # Should NOT reference old skill-specific agent spawning
    if grep -qi "spawn.*ct-research-agent\|spawn.*ct-task-executor" "$orchestrator_skill"; then
        # The reference should be in a "do not" or anti-pattern context
        if ! grep -qi "MUST NOT.*spawn.*skill-specific\|do not spawn.*ct-" "$orchestrator_skill"; then
            fail "Orchestrator references old skill-specific agent spawning without prohibition"
        fi
    fi
}

@test "orchestrator: Protocol Dispatch Matrix uses cleo-subagent" {
    local orchestrator_skill="${SKILLS_DIR}/ct-orchestrator/SKILL.md"
    [[ -f "$orchestrator_skill" ]]

    # Check Protocol Dispatch Matrix section
    local matrix_section
    matrix_section=$(grep -A 20 "Protocol Dispatch Matrix" "$orchestrator_skill" || true)

    if [[ -n "$matrix_section" ]]; then
        # All entries should show cleo-subagent as the agent
        echo "$matrix_section" | grep -qi "cleo-subagent"
    fi
}

@test "orchestrator: anti-patterns prohibit skill-specific agents" {
    local orchestrator_skill="${SKILLS_DIR}/ct-orchestrator/SKILL.md"
    [[ -f "$orchestrator_skill" ]]

    # Should have anti-pattern prohibiting skill-specific agent spawning
    grep -qi "MUST NOT.*spawn.*skill-specific\|do not.*spawn.*ct-research-agent" "$orchestrator_skill"
}

@test "orchestrator: documents universal subagent architecture" {
    local orchestrator_skill="${SKILLS_DIR}/ct-orchestrator/SKILL.md"
    [[ -f "$orchestrator_skill" ]]

    # Should document the universal subagent approach
    grep -qi "Universal Subagent Architecture\|All spawns use.*cleo-subagent" "$orchestrator_skill"
}

@test "orchestrator: skill_prepare_spawn referenced" {
    local orchestrator_skill="${SKILLS_DIR}/ct-orchestrator/SKILL.md"
    [[ -f "$orchestrator_skill" ]]

    # Should reference skill_prepare_spawn function
    grep -qi "skill_prepare_spawn\|prepare.*spawn" "$orchestrator_skill"
}

# =============================================================================
# PROTOCOL VALIDATION TESTS
# =============================================================================

@test "protocol validation: all 7 protocol files exist" {
    local expected_protocols=(
        "research.md"
        "consensus.md"
        "contribution.md"
        "specification.md"
        "decomposition.md"
        "implementation.md"
        "release.md"
    )

    for protocol in "${expected_protocols[@]}"; do
        [[ -f "${PROTOCOLS_DIR}/${protocol}" ]] || \
            fail "Protocol file missing: ${PROTOCOLS_DIR}/${protocol}"
    done
}

@test "protocol validation: each protocol has valid Trigger Conditions section" {
    for protocol_file in "${PROTOCOLS_DIR}"/*.md; do
        [[ -f "$protocol_file" ]] || continue

        local protocol_name
        protocol_name=$(basename "$protocol_file")

        grep -qi "## Trigger Conditions\|Trigger.*Keywords" "$protocol_file" || \
            fail "Protocol $protocol_name missing Trigger Conditions section"
    done
}

@test "protocol validation: each protocol specifies Max Active: 3" {
    for protocol_file in "${PROTOCOLS_DIR}"/*.md; do
        [[ -f "$protocol_file" ]] || continue

        local protocol_name
        protocol_name=$(basename "$protocol_file")

        grep -qi "Max Active.*3" "$protocol_file" || \
            fail "Protocol $protocol_name missing 'Max Active: 3' specification"
    done
}

@test "protocol validation: each protocol has RFC 2119 requirements" {
    for protocol_file in "${PROTOCOLS_DIR}"/*.md; do
        [[ -f "$protocol_file" ]] || continue

        local protocol_name
        protocol_name=$(basename "$protocol_file")

        grep -q "MUST\|SHOULD\|MAY" "$protocol_file" || \
            fail "Protocol $protocol_name missing RFC 2119 keywords"
    done
}

@test "protocol validation: each protocol has Manifest Entry format" {
    for protocol_file in "${PROTOCOLS_DIR}"/*.md; do
        [[ -f "$protocol_file" ]] || continue

        local protocol_name
        protocol_name=$(basename "$protocol_file")

        grep -qi "Manifest Entry\|manifest.*format" "$protocol_file" || \
            fail "Protocol $protocol_name missing Manifest Entry format"
    done
}

@test "protocol validation: protocols define agent_type" {
    for protocol_file in "${PROTOCOLS_DIR}"/*.md; do
        [[ -f "$protocol_file" ]] || continue

        local protocol_name
        protocol_name=$(basename "$protocol_file")

        grep -qi "agent_type" "$protocol_file" || \
            fail "Protocol $protocol_name missing agent_type specification"
    done
}

# =============================================================================
# CLEO-SUBAGENT AGENT DEFINITION TESTS
# =============================================================================

@test "cleo-subagent: AGENT.md exists" {
    local agent_file="${AGENTS_DIR}/cleo-subagent/AGENT.md"
    [[ -f "$agent_file" ]]
}

@test "cleo-subagent: has frontmatter with required fields" {
    local agent_file="${AGENTS_DIR}/cleo-subagent/AGENT.md"
    [[ -f "$agent_file" ]]

    # Should have name field
    grep -q "^name: cleo-subagent" "$agent_file"

    # Should have model field
    grep -q "^model: " "$agent_file"

    # Should have allowed_tools field
    grep -q "^allowed_tools:" "$agent_file"
}

@test "cleo-subagent: defines BASE constraints" {
    local agent_file="${AGENTS_DIR}/cleo-subagent/AGENT.md"
    [[ -f "$agent_file" ]]

    # Should define BASE-001 through BASE-007
    grep -q "BASE-001" "$agent_file"
    grep -q "BASE-002" "$agent_file"
    grep -q "BASE-003" "$agent_file"
}

@test "cleo-subagent: defines lifecycle protocol" {
    local agent_file="${AGENTS_DIR}/cleo-subagent/AGENT.md"
    [[ -f "$agent_file" ]]

    # Should have lifecycle phases documented
    grep -qi "Lifecycle Protocol\|Phase 1.*Spawn\|Phase 2.*Execute" "$agent_file"
}

@test "cleo-subagent: defines output requirements" {
    local agent_file="${AGENTS_DIR}/cleo-subagent/AGENT.md"
    [[ -f "$agent_file" ]]

    # Should define output requirements
    grep -qi "Output Requirements\|File Naming Convention" "$agent_file"
}

@test "cleo-subagent: defines token reference" {
    local agent_file="${AGENTS_DIR}/cleo-subagent/AGENT.md"
    [[ -f "$agent_file" ]]

    # Should define standard tokens
    grep -qi "Token Reference\|{{TASK_ID}}\|{{EPIC_ID}}" "$agent_file"
}

# =============================================================================
# INIT/UPGRADE VALIDATION TESTS
# =============================================================================

@test "init/upgrade: init.sh exists and is executable" {
    local init_script="${PROJECT_ROOT}/scripts/init.sh"
    [[ -f "$init_script" ]]
    [[ -x "$init_script" ]]
}

@test "init/upgrade: upgrade.sh exists" {
    local upgrade_script="${PROJECT_ROOT}/scripts/upgrade.sh"
    [[ -f "$upgrade_script" ]]
}

@test "init/upgrade: injection library exists" {
    # Check for injection-related library
    [[ -f "${PROJECT_ROOT}/lib/ui/injection-registry.sh" ]] || \
    [[ -f "${PROJECT_ROOT}/lib/ui/injection.sh" ]]
}

@test "init/upgrade: AGENT-INJECTION.md template accessible" {
    # The template should be available for init to copy
    local template="${TEMPLATES_DIR}/AGENT-INJECTION.md"
    [[ -f "$template" ]]

    # Should have substantial content
    local lines
    lines=$(wc -l < "$template")
    [[ "$lines" -gt 50 ]]
}

@test "init/upgrade: .cleo/templates/AGENT-INJECTION.md exists" {
    # The deployed version should exist
    local deployed="${PROJECT_ROOT}/.cleo/templates/AGENT-INJECTION.md"
    [[ -f "$deployed" ]]
}

# =============================================================================
# DOCUMENTATION CONSISTENCY TESTS
# =============================================================================

@test "documentation: orchestrator command docs reference cleo-subagent" {
    local orchestrator_docs="${DOCS_DIR}/commands/orchestrator.md"
    if [[ -f "$orchestrator_docs" ]]; then
        grep -qi "cleo-subagent" "$orchestrator_docs"
    else
        skip "Orchestrator command docs not found"
    fi
}

@test "documentation: ORCHESTRATOR-PROTOCOL guide exists" {
    local guide="${DOCS_DIR}/guides/ORCHESTRATOR-PROTOCOL.md"
    [[ -f "$guide" ]]
}

@test "documentation: ORCHESTRATOR-PROTOCOL references universal subagent" {
    local guide="${DOCS_DIR}/guides/ORCHESTRATOR-PROTOCOL.md"
    [[ -f "$guide" ]]

    grep -qi "cleo-subagent\|universal.*subagent" "$guide"
}

# =============================================================================
# SHARED RESOURCES VALIDATION TESTS
# =============================================================================

@test "shared resources: subagent-protocol-base.md exists" {
    local shared_file="${SKILLS_DIR}/_shared/subagent-protocol-base.md"
    [[ -f "$shared_file" ]]
}

@test "shared resources: task-system-integration.md exists" {
    local shared_file="${SKILLS_DIR}/_shared/task-system-integration.md"
    [[ -f "$shared_file" ]]
}

@test "shared resources: skills reference shared protocols" {
    local shared_ref_count=0

    for skill_dir in "${SKILLS_DIR}"/ct-*/; do
        local skill_file="${skill_dir}SKILL.md"
        [[ -f "$skill_file" ]] || continue

        if grep -qi "@skills/_shared/" "$skill_file"; then
            shared_ref_count=$((shared_ref_count + 1))
        fi
    done

    # Multiple skills should reference shared resources
    [[ "$shared_ref_count" -gt 2 ]]
}

# =============================================================================
# MIGRATION COMPLETENESS SUMMARY TEST
# =============================================================================

@test "migration summary: all critical migration components present" {
    local missing_components=()

    # Check protocols
    [[ -d "${PROTOCOLS_DIR}" ]] || missing_components+=("protocols directory")
    [[ $(find "${PROTOCOLS_DIR}" -name "*.md" 2>/dev/null | wc -l) -ge 7 ]] || \
        missing_components+=("7 protocol files")

    # Check cleo-subagent
    [[ -f "${AGENTS_DIR}/cleo-subagent/AGENT.md" ]] || \
        missing_components+=("cleo-subagent AGENT.md")

    # Check injection templates
    [[ -f "${TEMPLATES_DIR}/AGENT-INJECTION.md" ]] || \
        missing_components+=("AGENT-INJECTION.md template")
    [[ -f "${TEMPLATES_DIR}/CLEO-INJECTION.md" ]] || \
        missing_components+=("CLEO-INJECTION.md template")

    # Check orchestrator
    [[ -f "${SKILLS_DIR}/ct-orchestrator/SKILL.md" ]] || \
        missing_components+=("ct-orchestrator skill")

    # Check shared resources
    [[ -f "${SKILLS_DIR}/_shared/subagent-protocol-base.md" ]] || \
        missing_components+=("subagent-protocol-base.md")

    # Report results
    if [[ ${#missing_components[@]} -gt 0 ]]; then
        fail "Missing migration components: ${missing_components[*]}"
    fi
}
