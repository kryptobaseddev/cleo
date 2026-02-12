#!/usr/bin/env bats
# =============================================================================
# orchestrator-protocol.bats - Integration tests for Orchestrator Protocol
# =============================================================================
# Tests the complete orchestrator protocol including:
# - Manifest utilities (read, write, query)
# - Research linking (bidirectional task-research links)
# - Agent spawner (dependency analysis, wave computation, parallelization)
# - Compliance validator (output validation, manifest integrity)
# - Session startup (initialization, resumption, pending detection)
# =============================================================================

# Load test helpers
setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/fixtures'
    load '../test_helper/assertions'
    common_setup_per_test

    # Create empty todo for task operations
    create_empty_todo

    # Set up research directories
    export RESEARCH_OUTPUT_DIR="${TEST_TEMP_DIR}/claudedocs/agent-outputs"
    mkdir -p "$RESEARCH_OUTPUT_DIR"

    # Set up fixtures path
    export ORCH_FIXTURES="${FIXTURES_DIR}/orchestrator"

    # Source libraries within test context (they need config.sh which needs TEST_TEMP_DIR)
    source "${LIB_DIR}/skills/research-manifest.sh"
    source "${LIB_DIR}/skills/orchestrator-startup.sh"
    source "${LIB_DIR}/skills/orchestrator-validator.sh"
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

# Create test tasks structure with dependencies
create_test_epic_structure() {
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    cp "${ORCH_FIXTURES}/sample-task-data.json" "$todo_file"
}

# Create valid manifest with test entries
create_valid_manifest() {
    cp "${ORCH_FIXTURES}/sample-manifest.jsonl" "${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    # Create corresponding output files
    cp "${ORCH_FIXTURES}/sample-research-output.md" "${RESEARCH_OUTPUT_DIR}/2026-01-18_sample-research.md"
    touch "${RESEARCH_OUTPUT_DIR}/2026-01-18_followup-research.md"
    touch "${RESEARCH_OUTPUT_DIR}/2026-01-18_blocked-research.md"
}

# Create invalid manifest for testing error cases
create_invalid_manifest() {
    cp "${ORCH_FIXTURES}/invalid-manifest.jsonl" "${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
}

# Create manifest entry programmatically
create_manifest_entry() {
    local id="${1:-test-entry}"
    local status="${2:-complete}"
    local needs_followup="${3:-[]}"

    cat >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl" << EOF
{"id":"$id","file":"${id}.md","title":"Test: $id","date":"2026-01-18","status":"$status","topics":["test"],"key_findings":["F1","F2","F3"],"actionable":true,"needs_followup":$needs_followup,"linked_tasks":[]}
EOF
    # Create corresponding file
    echo "# Test Entry: $id" > "${RESEARCH_OUTPUT_DIR}/${id}.md"
}

# =============================================================================
# MANIFEST UTILITIES TESTS
# =============================================================================

@test "manifest: get_pending_followup returns entries with needs_followup" {
    create_valid_manifest
    create_test_epic_structure

    local result
    result=$(get_pending_followup)

    # Should find the entry with followups
    local count
    count=$(echo "$result" | jq -r '.result.count')
    [[ "$count" -ge 1 ]]

    # Should include the research-with-followup entry
    local has_followup_entry
    has_followup_entry=$(echo "$result" | jq '[.result.entries[] | select(.id == "research-with-followup")] | length')
    [[ "$has_followup_entry" -eq 1 ]]
}

@test "manifest: get_entry_by_id returns correct entry" {
    create_valid_manifest

    local entry
    entry=$(get_entry_by_id "research-valid-001")

    # Should return non-null entry
    [[ "$entry" != "null" ]]

    # Should have correct ID
    local entry_id
    entry_id=$(echo "$entry" | jq -r '.id')
    [[ "$entry_id" == "research-valid-001" ]]

    # Should have correct title
    local title
    title=$(echo "$entry" | jq -r '.title')
    [[ "$title" == "Sample Research Entry" ]]
}

@test "manifest: get_entry_by_id returns null for nonexistent ID" {
    create_valid_manifest

    # get_entry_by_id returns exit code 4 for not found and outputs "null"
    local entry
    set +e
    entry=$(get_entry_by_id "nonexistent-id-xyz" 2>/dev/null)
    local exit_code=$?
    set -e

    [[ "$entry" == "null" ]] || [[ "$exit_code" -eq 4 ]]
}

@test "manifest: filter_entries respects status filter" {
    create_valid_manifest

    local result
    result=$(filter_entries --status complete)

    # Should find complete entries
    local count
    count=$(echo "$result" | jq -r '.result.filtered')
    [[ "$count" -ge 1 ]]

    # All returned entries should have status complete
    local non_complete
    non_complete=$(echo "$result" | jq '[.result.entries[] | select(.status != "complete")] | length')
    [[ "$non_complete" -eq 0 ]]
}

@test "manifest: filter_entries respects topic filter" {
    create_valid_manifest

    local result
    result=$(filter_entries --topic "orchestrator")

    # Should find entries with orchestrator topic
    local count
    count=$(echo "$result" | jq -r '.result.filtered')
    [[ "$count" -ge 1 ]]
}

@test "manifest: filter_entries respects actionable filter" {
    create_valid_manifest

    local result
    result=$(filter_entries --actionable)

    # All returned entries should be actionable
    local non_actionable
    non_actionable=$(echo "$result" | jq '[.result.entries[] | select(.actionable != true)] | length')
    [[ "$non_actionable" -eq 0 ]]
}

@test "manifest: filter_entries respects limit" {
    # Create multiple entries
    create_manifest_entry "entry-1" "complete" "[]"
    create_manifest_entry "entry-2" "complete" "[]"
    create_manifest_entry "entry-3" "complete" "[]"

    local result
    result=$(filter_entries --limit 2)

    local count
    count=$(echo "$result" | jq -r '.result.filtered')
    [[ "$count" -eq 2 ]]
}

@test "manifest: filter_entries respects agent_type filter" {
    # Create entries with different agent_types
    cat >> "$RESEARCH_OUTPUT_DIR/MANIFEST.jsonl" << 'EOF'
{"id":"research-entry","file":"research-entry.md","title":"Research Entry","date":"2026-01-18","status":"complete","agent_type":"research","topics":["test"],"key_findings":["F1","F2","F3"],"actionable":true,"needs_followup":[],"linked_tasks":[]}
{"id":"impl-entry","file":"impl-entry.md","title":"Implementation Entry","date":"2026-01-18","status":"complete","agent_type":"implementation","topics":["test"],"key_findings":["F1","F2","F3"],"actionable":true,"needs_followup":[],"linked_tasks":[]}
{"id":"validation-entry","file":"validation-entry.md","title":"Validation Entry","date":"2026-01-18","status":"complete","agent_type":"validation","topics":["test"],"key_findings":["F1","F2","F3"],"actionable":true,"needs_followup":[],"linked_tasks":[]}
{"id":"no-type-entry","file":"no-type-entry.md","title":"No Type Entry (defaults to research)","date":"2026-01-18","status":"complete","topics":["test"],"key_findings":["F1","F2","F3"],"actionable":true,"needs_followup":[],"linked_tasks":[]}
EOF
    echo "# Test" > "${RESEARCH_OUTPUT_DIR}/research-entry.md"
    echo "# Test" > "${RESEARCH_OUTPUT_DIR}/impl-entry.md"
    echo "# Test" > "${RESEARCH_OUTPUT_DIR}/validation-entry.md"
    echo "# Test" > "${RESEARCH_OUTPUT_DIR}/no-type-entry.md"

    # Filter by research type (should include entries without agent_type)
    local result
    result=$(filter_entries --type research)
    local count
    count=$(echo "$result" | jq -r '.result.filtered')
    [[ "$count" -eq 2 ]]  # research-entry + no-type-entry

    # All returned entries should have agent_type research or missing (default)
    local ids
    ids=$(echo "$result" | jq -r '.result.entries[].id' | sort)
    [[ "$ids" == *"research-entry"* ]]
    [[ "$ids" == *"no-type-entry"* ]]

    # Filter by implementation type
    result=$(filter_entries --type implementation)
    count=$(echo "$result" | jq -r '.result.filtered')
    [[ "$count" -eq 1 ]]
    local impl_id
    impl_id=$(echo "$result" | jq -r '.result.entries[0].id')
    [[ "$impl_id" == "impl-entry" ]]
}

@test "manifest: read_manifest returns all entries" {
    create_valid_manifest

    local result
    result=$(read_manifest)

    local count
    count=$(echo "$result" | jq -r '.result.count')
    [[ "$count" -eq 3 ]]  # sample-manifest.jsonl has 3 entries
}

@test "manifest: append_manifest adds new entry" {
    # Start with empty manifest
    touch "${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"

    local new_entry='{"id":"new-test-entry","file":"new-test.md","title":"New Test","date":"2026-01-18","status":"complete","topics":["new"],"key_findings":["F1","F2","F3"],"actionable":true,"needs_followup":[]}'

    local result
    result=$(append_manifest "$new_entry")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Verify entry was added
    local added
    added=$(get_entry_by_id "new-test-entry")
    [[ "$added" != "null" ]]
}

@test "manifest: append_manifest rejects duplicate ID" {
    create_manifest_entry "existing-entry" "complete" "[]"

    local duplicate='{"id":"existing-entry","file":"dup.md","title":"Duplicate","date":"2026-01-18","status":"complete","topics":["dup"],"key_findings":["F1","F2","F3"],"actionable":true,"needs_followup":[]}'

    local result
    result=$(append_manifest "$duplicate" 2>/dev/null || true)
    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "false" ]]
}

# =============================================================================
# RESEARCH LINKING TESTS
# =============================================================================

@test "linking: link_research_to_task updates manifest linked_tasks" {
    create_valid_manifest
    create_test_epic_structure

    local result
    result=$(link_research_to_task "T002" "research-valid-001")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Verify linked_tasks was updated in manifest
    local entry
    entry=$(get_entry_by_id "research-valid-001")
    local has_link
    has_link=$(echo "$entry" | jq '.linked_tasks | any(. == "T002")')
    [[ "$has_link" == "true" ]]
}

@test "linking: link_research_to_task is idempotent" {
    create_valid_manifest
    create_test_epic_structure

    # Link twice
    link_research_to_task "T002" "research-valid-001" >/dev/null
    link_research_to_task "T002" "research-valid-001" >/dev/null

    # Should only have one link
    local entry
    entry=$(get_entry_by_id "research-valid-001")
    local link_count
    link_count=$(echo "$entry" | jq '[.linked_tasks[] | select(. == "T002")] | length')
    [[ "$link_count" -eq 1 ]]
}

@test "linking: get_task_research returns linked research" {
    create_valid_manifest
    create_test_epic_structure

    # research-valid-001 is already linked to T001 in fixture
    local result
    result=$(get_task_research "T001")

    local count
    count=$(echo "$result" | jq -r '.result.count')
    [[ "$count" -ge 1 ]]

    # Should include research-valid-001
    local has_entry
    has_entry=$(echo "$result" | jq '[.result.entries[] | select(.id == "research-valid-001")] | length')
    [[ "$has_entry" -eq 1 ]]
}

@test "linking: get_task_research returns empty for unlinked task" {
    create_valid_manifest
    create_test_epic_structure

    local result
    result=$(get_task_research "T999")  # Nonexistent task

    local count
    count=$(echo "$result" | jq -r '.result.count')
    [[ "$count" -eq 0 ]]
}

@test "linking: unlink_research_from_task removes link" {
    create_valid_manifest
    create_test_epic_structure

    # First verify link exists
    local entry
    entry=$(get_entry_by_id "research-valid-001")
    local initial_link
    initial_link=$(echo "$entry" | jq '.linked_tasks | any(. == "T001")')
    [[ "$initial_link" == "true" ]]

    # Remove the link
    unlink_research_from_task "T001" "research-valid-001" >/dev/null

    # Verify link is removed
    entry=$(get_entry_by_id "research-valid-001")
    local final_link
    final_link=$(echo "$entry" | jq '.linked_tasks | any(. == "T001")')
    [[ "$final_link" == "false" ]]
}

@test "linking: task_has_research correctly detects linked research" {
    create_valid_manifest
    create_test_epic_structure

    local result
    result=$(task_has_research "T001")

    local has_research
    has_research=$(echo "$result" | jq -r '.result.hasResearch')
    [[ "$has_research" == "true" ]]
}

@test "linking: task_has_research returns false for unlinked task" {
    create_valid_manifest
    create_test_epic_structure

    local result
    result=$(task_has_research "T006")  # Not linked to any research

    local has_research
    has_research=$(echo "$result" | jq -r '.result.hasResearch')
    [[ "$has_research" == "false" ]]
}

# =============================================================================
# AGENT SPAWNER / DEPENDENCY ANALYSIS TESTS
# =============================================================================

@test "spawner: orchestrator_analyze_dependencies builds correct graph" {
    create_test_epic_structure

    local result
    result=$(orchestrator_analyze_dependencies "T001")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should have waves
    local wave_count
    wave_count=$(echo "$result" | jq '.result.waves | length')
    [[ "$wave_count" -gt 0 ]]

    # Wave 0 should contain T002 (no deps) and T006 (done)
    local wave_0_tasks
    wave_0_tasks=$(echo "$result" | jq '[.result.waves[] | select(.wave == 0) | .tasks[].id]')
    [[ $(echo "$wave_0_tasks" | jq 'any(. == "T002")') == "true" ]]
}

@test "spawner: orchestrator_get_ready_tasks excludes blocked tasks" {
    create_test_epic_structure

    local result
    result=$(orchestrator_get_ready_tasks "T001")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # T002 should be ready (no dependencies)
    local ready_ids
    ready_ids=$(echo "$result" | jq '[.result.tasks[].id]')
    [[ $(echo "$ready_ids" | jq 'any(. == "T002")') == "true" ]]

    # T003 should NOT be ready (depends on T002 which is pending)
    [[ $(echo "$ready_ids" | jq 'any(. == "T003")') == "false" ]]

    # T005 should NOT be ready (depends on T003 and T004)
    [[ $(echo "$ready_ids" | jq 'any(. == "T005")') == "false" ]]
}

@test "spawner: orchestrator_get_ready_tasks respects parallel safety" {
    create_test_epic_structure

    local result
    result=$(orchestrator_get_ready_tasks "T001")

    # Result should indicate parallel safety
    local parallel_safe
    parallel_safe=$(echo "$result" | jq -r '.result.parallelSafe')
    [[ "$parallel_safe" == "true" ]]
}

@test "spawner: orchestrator_can_parallelize detects independence" {
    create_test_epic_structure

    # T003 and T004 both depend on T002 but not on each other
    local result
    result=$(orchestrator_can_parallelize "T003" "T004")

    local can_parallel
    can_parallel=$(echo "$result" | jq -r '.result.canParallelize')
    [[ "$can_parallel" == "true" ]]
}

@test "spawner: orchestrator_can_parallelize detects dependencies" {
    create_test_epic_structure

    # T003 depends on T002
    local result
    result=$(orchestrator_can_parallelize "T002" "T003")

    local can_parallel
    can_parallel=$(echo "$result" | jq -r '.result.canParallelize')
    [[ "$can_parallel" == "false" ]]

    # Should show T003 depends on T002
    local conflict_count
    conflict_count=$(echo "$result" | jq '.result.conflicts | length')
    [[ "$conflict_count" -gt 0 ]]
}

@test "spawner: orchestrator_get_next_task returns highest priority ready task" {
    create_test_epic_structure

    local result
    result=$(orchestrator_get_next_task "T001")

    local has_ready
    has_ready=$(echo "$result" | jq -r '.result.hasReadyTask')
    [[ "$has_ready" == "true" ]]

    # Should return T002 (only pending task with no unmet deps)
    local next_id
    next_id=$(echo "$result" | jq -r '.result.nextTask.id')
    [[ "$next_id" == "T002" ]]
}

@test "spawner: orchestrator_get_parallel_waves returns wave structure" {
    create_test_epic_structure

    local result
    result=$(orchestrator_get_parallel_waves "T001")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should have wave structure
    local total_waves
    total_waves=$(echo "$result" | jq -r '.result.totalWaves')
    [[ "$total_waves" -gt 0 ]]

    # Should have summary stats
    local total_tasks
    total_tasks=$(echo "$result" | jq -r '.result.summary.total')
    [[ "$total_tasks" -gt 0 ]]
}

# =============================================================================
# COMPLIANCE VALIDATOR TESTS
# =============================================================================

@test "validator: validate_subagent_output fails on missing file" {
    create_valid_manifest

    # Remove the output file
    rm -f "${RESEARCH_OUTPUT_DIR}/2026-01-18_sample-research.md"

    # Function returns exit code 6 when validation fails, which is expected
    local result
    set +e
    result=$(validate_subagent_output "research-valid-001")
    set -e

    local passed
    passed=$(echo "$result" | jq -r '.result.passed')
    [[ "$passed" == "false" ]]

    # Should report file not found
    local has_file_issue
    has_file_issue=$(echo "$result" | jq '[.result.issues[] | select(contains("FILE"))] | length')
    [[ "$has_file_issue" -gt 0 ]]
}

@test "validator: validate_subagent_output fails on missing manifest entry" {
    # Create empty manifest
    touch "${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"

    # Function returns exit code 6 when validation fails, which is expected
    local result
    set +e
    result=$(validate_subagent_output "nonexistent-research-id")
    set -e

    local passed
    passed=$(echo "$result" | jq -r '.result.passed')
    [[ "$passed" == "false" ]]

    # Should report manifest entry missing
    local has_manifest_issue
    has_manifest_issue=$(echo "$result" | jq '[.result.issues[] | select(contains("MANIFEST_ENTRY"))] | length')
    [[ "$has_manifest_issue" -gt 0 ]]
}

@test "validator: validate_subagent_output passes for valid entry" {
    create_valid_manifest
    create_test_epic_structure

    local result
    result=$(validate_subagent_output "research-valid-001")

    local passed
    passed=$(echo "$result" | jq -r '.result.passed')
    [[ "$passed" == "true" ]]

    local issue_count
    issue_count=$(echo "$result" | jq -r '.result.issueCount')
    [[ "$issue_count" -eq 0 ]]
}

@test "validator: validate_manifest_integrity detects duplicate IDs" {
    create_invalid_manifest

    # Function returns exit code 6 when validation fails, which is expected
    local result
    set +e
    result=$(validate_manifest_integrity)
    set -e

    local passed
    passed=$(echo "$result" | jq -r '.result.passed')
    [[ "$passed" == "false" ]]

    # Should report duplicate ID
    local has_dup_issue
    has_dup_issue=$(echo "$result" | jq '[.result.issues[] | select(contains("DUPLICATE_ID"))] | length')
    [[ "$has_dup_issue" -gt 0 ]]
}

@test "validator: validate_manifest_integrity detects invalid JSON" {
    create_invalid_manifest

    # Function returns exit code 6 when validation fails, which is expected
    local result
    set +e
    result=$(validate_manifest_integrity)
    set -e

    local passed
    passed=$(echo "$result" | jq -r '.result.passed')
    [[ "$passed" == "false" ]]

    # Should report invalid JSON
    local has_json_issue
    has_json_issue=$(echo "$result" | jq '[.result.issues[] | select(contains("INVALID_JSON"))] | length')
    [[ "$has_json_issue" -gt 0 ]]
}

@test "validator: validate_manifest_integrity detects missing files" {
    create_invalid_manifest

    # Function returns exit code 6 when validation fails, which is expected
    local result
    set +e
    result=$(validate_manifest_integrity)
    set -e

    local passed
    passed=$(echo "$result" | jq -r '.result.passed')
    [[ "$passed" == "false" ]]

    # Should report file missing
    local has_file_issue
    has_file_issue=$(echo "$result" | jq '[.result.issues[] | select(contains("FILE_MISSING"))] | length')
    [[ "$has_file_issue" -gt 0 ]]
}

@test "validator: validate_manifest_integrity passes for valid manifest" {
    create_valid_manifest

    # Also need to create task structure since manifest has needs_followup with task IDs
    create_test_epic_structure

    local result
    result=$(validate_manifest_integrity)

    local passed
    passed=$(echo "$result" | jq -r '.result.passed')
    [[ "$passed" == "true" ]]
}

@test "validator: validate_protocol runs all validators" {
    create_valid_manifest
    create_test_epic_structure

    # Function may return exit code 6 if some validations fail, which is expected
    local result
    set +e
    result=$(validate_protocol "T001")
    set -e

    # Should have summary with manifest integrity check
    local manifest_ok
    manifest_ok=$(echo "$result" | jq -r '.result.summary.manifestIntegrity')
    [[ "$manifest_ok" == "true" ]]

    # Should have result.summary structure
    local has_summary
    has_summary=$(echo "$result" | jq -r 'if .result.summary then "true" else "false" end')
    [[ "$has_summary" == "true" ]]
}

# =============================================================================
# SESSION STARTUP TESTS
# =============================================================================

@test "startup: orchestrator_session_init returns state without active session" {
    create_test_epic_structure

    local result
    result=$(orchestrator_session_init "T001")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    local action
    action=$(echo "$result" | jq -r '.result.recommendedAction')
    # Without pending work, should request direction
    [[ "$action" == "request_direction" ]] || [[ "$action" == "create_and_spawn" ]]
}

@test "startup: orchestrator_check_pending finds manifest followup" {
    create_valid_manifest
    create_test_epic_structure

    local result
    result=$(orchestrator_check_pending)

    local has_pending
    has_pending=$(echo "$result" | jq -r '.result.hasPending')
    [[ "$has_pending" == "true" ]]

    # Should find the entry with followups
    local manifest_count
    manifest_count=$(echo "$result" | jq -r '.result.manifestCount')
    [[ "$manifest_count" -ge 1 ]]
}

@test "startup: orchestrator_check_pending returns false when no followups" {
    # Create manifest with no followups
    create_manifest_entry "no-followup-entry" "complete" "[]"

    local result
    result=$(orchestrator_check_pending)

    local has_pending
    has_pending=$(echo "$result" | jq -r '.result.hasPending')
    [[ "$has_pending" == "false" ]]
}

@test "startup: orchestrator_get_startup_state returns comprehensive state" {
    create_valid_manifest
    create_test_epic_structure

    local result
    result=$(orchestrator_get_startup_state "T001")

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should have session info
    local has_session
    has_session=$(echo "$result" | jq '.result | has("session")')
    [[ "$has_session" == "true" ]]

    # Should have context info
    local has_context
    has_context=$(echo "$result" | jq '.result | has("context")')
    [[ "$has_context" == "true" ]]

    # Should have ready tasks
    local has_ready
    has_ready=$(echo "$result" | jq '.result | has("readyTasks")')
    [[ "$has_ready" == "true" ]]
}

@test "startup: orchestrator_context_check returns status" {
    local result
    result=$(orchestrator_context_check 5000)

    local status_field
    status_field=$(echo "$result" | jq -r '.result.status')
    [[ "$status_field" == "ok" ]]

    local usage
    usage=$(echo "$result" | jq -r '.result.usagePercent')
    [[ "$usage" -eq 50 ]]  # 5000/10000 = 50%
}

@test "startup: orchestrator_context_check warns at threshold" {
    local result
    result=$(orchestrator_context_check 7500)

    local status_field
    status_field=$(echo "$result" | jq -r '.result.status')
    [[ "$status_field" == "warning" ]]
}

@test "startup: orchestrator_context_check returns critical at 90%" {
    local result
    # Use set +e to capture exit code
    set +e
    result=$(orchestrator_context_check 9500)
    local exit_code=$?
    set -e

    # Should return exit code 52 for critical
    [[ "$exit_code" -eq 52 ]]

    local status_field
    status_field=$(echo "$result" | jq -r '.result.status')
    [[ "$status_field" == "critical" ]]
}

# =============================================================================
# END-TO-END WORKFLOW TEST
# =============================================================================

@test "e2e: full orchestrator workflow - analyze, spawn ready, validate" {
    create_valid_manifest
    create_test_epic_structure

    # Step 1: Analyze dependencies
    local analysis
    analysis=$(orchestrator_analyze_dependencies "T001")
    local waves
    waves=$(echo "$analysis" | jq '.result.waves | length')
    [[ "$waves" -gt 0 ]]

    # Step 2: Get ready tasks
    local ready_result
    ready_result=$(orchestrator_get_ready_tasks "T001")
    local ready_count
    ready_count=$(echo "$ready_result" | jq -r '.result.readyCount')
    [[ "$ready_count" -ge 1 ]]

    # Step 3: Validate manifest
    local manifest_result
    manifest_result=$(validate_manifest_integrity)
    local manifest_ok
    manifest_ok=$(echo "$manifest_result" | jq -r '.result.passed')
    [[ "$manifest_ok" == "true" ]]

    # Step 4: Check pending
    local pending_result
    pending_result=$(orchestrator_check_pending)
    local has_pending
    has_pending=$(echo "$pending_result" | jq -r '.result.hasPending')
    # Has pending because research-with-followup has needs_followup
    [[ "$has_pending" == "true" ]]
}

@test "e2e: dependency chain completion enables next wave" {
    create_test_epic_structure
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"

    # Initially T003 and T004 are blocked by T002
    local initial_result
    initial_result=$(orchestrator_get_ready_tasks "T001")
    local initial_ready
    initial_ready=$(echo "$initial_result" | jq '[.result.tasks[].id]')
    [[ $(echo "$initial_ready" | jq 'any(. == "T002")') == "true" ]]
    [[ $(echo "$initial_ready" | jq 'any(. == "T003")') == "false" ]]

    # Complete T002
    jq '.tasks = [.tasks[] | if .id == "T002" then .status = "done" else . end]' "$todo_file" > "${todo_file}.tmp"
    mv "${todo_file}.tmp" "$todo_file"

    # Now T003 and T004 should be ready
    local after_result
    after_result=$(orchestrator_get_ready_tasks "T001")
    local after_ready
    after_ready=$(echo "$after_result" | jq '[.result.tasks[].id]')
    [[ $(echo "$after_ready" | jq 'any(. == "T003")') == "true" ]]
    [[ $(echo "$after_ready" | jq 'any(. == "T004")') == "true" ]]

    # T005 should still not be ready (needs T003 AND T004)
    [[ $(echo "$after_ready" | jq 'any(. == "T005")') == "false" ]]
}

@test "e2e: parallel tasks can all be spawned" {
    create_test_epic_structure
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"

    # Complete T002 to unblock T003 and T004
    jq '.tasks = [.tasks[] | if .id == "T002" then .status = "done" else . end]' "$todo_file" > "${todo_file}.tmp"
    mv "${todo_file}.tmp" "$todo_file"

    # Check parallelization
    local result
    result=$(orchestrator_can_parallelize "T003" "T004")

    local can_parallel
    can_parallel=$(echo "$result" | jq -r '.result.canParallelize')
    [[ "$can_parallel" == "true" ]]

    # Both should be in safe to spawn
    local safe_to_spawn
    safe_to_spawn=$(echo "$result" | jq '.result.safeToSpawn')
    [[ $(echo "$safe_to_spawn" | jq 'length') -eq 2 ]]
}

# =============================================================================
# PROTOCOL INJECTION VALIDATION TESTS
# =============================================================================

@test "protocol validation: passes for prompt with SUBAGENT PROTOCOL marker" {
    source "${LIB_DIR}/skills/orchestrator-spawn.sh"

    local prompt='You are a research subagent.

## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

OUTPUT REQUIREMENTS:
1. MUST write findings to: claudedocs/agent-outputs/2026-01-26_test.md
2. MUST append ONE line to: claudedocs/agent-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."

Your task: Research authentication patterns.'

    # Should pass validation (exit 0)
    run orchestrator_verify_protocol_injection "$prompt"
    [[ "$status" -eq 0 ]]
}

@test "protocol validation: passes for prompt with lowercase marker" {
    source "${LIB_DIR}/skills/orchestrator-spawn.sh"

    local prompt='You are a task executor.

## subagent protocol (rfc 2119)

Some protocol content here.

Your task: Implement feature X.'

    # Should pass validation (case-insensitive)
    run orchestrator_verify_protocol_injection "$prompt"
    [[ "$status" -eq 0 ]]
}

@test "protocol validation: fails for prompt without marker" {
    source "${LIB_DIR}/skills/orchestrator-spawn.sh"

    local prompt='You are a research subagent.

Your task: Research authentication patterns.

Please write your findings to a file.'

    # Should fail validation (exit 60 = EXIT_PROTOCOL_MISSING)
    run orchestrator_verify_protocol_injection "$prompt"
    [[ "$status" -eq 60 ]]
}

@test "protocol validation: fails for empty prompt" {
    source "${LIB_DIR}/skills/orchestrator-spawn.sh"

    # Should fail validation (exit 2 = EXIT_INVALID_INPUT)
    run orchestrator_verify_protocol_injection ""
    [[ "$status" -eq 2 ]]
}

@test "protocol validation: JSON output contains fix instructions on failure" {
    source "${LIB_DIR}/skills/orchestrator-spawn.sh"

    local prompt='No protocol block here.'

    local result
    result=$(orchestrator_verify_protocol_injection "$prompt" "true" 2>/dev/null || true)

    # Should have error code
    local error_code
    error_code=$(echo "$result" | jq -r '.error.code')
    [[ "$error_code" == "E_PROTOCOL_MISSING" ]]

    # Should have fix command
    local fix
    fix=$(echo "$result" | jq -r '.error.fix')
    [[ "$fix" == "cleo research inject" ]]

    # Should have alternatives
    local alt_count
    alt_count=$(echo "$result" | jq '.error.alternatives | length')
    [[ "$alt_count" -ge 1 ]]
}

@test "protocol validation: JSON output indicates success on valid prompt" {
    source "${LIB_DIR}/skills/orchestrator-spawn.sh"

    local prompt='## SUBAGENT PROTOCOL
Some content.'

    local result
    result=$(orchestrator_verify_protocol_injection "$prompt" "true")

    # Should have success true
    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "true" ]]

    # Should have valid true
    local valid
    valid=$(echo "$result" | jq -r '.valid')
    [[ "$valid" == "true" ]]
}

# =============================================================================
# COMPLIANCE VERIFICATION TESTS (Pre-Spawn)
# =============================================================================

@test "compliance: orchestrator_verify_compliance returns error for missing task_id" {
    local result
    result=$(orchestrator_verify_compliance "" 2>/dev/null || true)

    local success
    success=$(echo "$result" | jq -r '.success')
    [[ "$success" == "false" ]]

    local error_code
    error_code=$(echo "$result" | jq -r '.error.code')
    [[ "$error_code" == "E_INVALID_INPUT" ]]
}

@test "compliance: orchestrator_verify_compliance detects missing manifest entry" {
    # Create test structure but no manifest entries linked to task
    create_test_epic_structure

    local result
    set +e
    result=$(orchestrator_verify_compliance "T002")
    local exit_code=$?
    set -e

    # Should return EXIT_MANIFEST_ENTRY_MISSING (62)
    [[ "$exit_code" -eq 62 ]]

    local can_spawn
    can_spawn=$(echo "$result" | jq -r '.result.canSpawnNext')
    [[ "$can_spawn" == "false" ]]

    local manifest_exists
    manifest_exists=$(echo "$result" | jq -r '.result.checks.manifestEntryExists')
    [[ "$manifest_exists" == "false" ]]
}

@test "compliance: orchestrator_verify_compliance passes with valid manifest entry" {
    create_test_epic_structure
    create_valid_manifest

    # Create a manifest entry linked to T002
    local manifest_file="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    cat >> "$manifest_file" << EOF
{"id":"t002-research","file":"t002-research.md","title":"Research for T002","date":"2026-01-26","status":"complete","topics":["test"],"key_findings":["F1"],"actionable":true,"needs_followup":[],"linked_tasks":["T002"]}
EOF
    touch "${RESEARCH_OUTPUT_DIR}/t002-research.md"

    local result
    result=$(orchestrator_verify_compliance "T002" "t002-research")

    local can_spawn
    can_spawn=$(echo "$result" | jq -r '.result.canSpawnNext')
    [[ "$can_spawn" == "true" ]]

    local manifest_exists
    manifest_exists=$(echo "$result" | jq -r '.result.checks.manifestEntryExists')
    [[ "$manifest_exists" == "true" ]]

    local research_linked
    research_linked=$(echo "$result" | jq -r '.result.checks.researchLinkedToTask')
    [[ "$research_linked" == "true" ]]
}

@test "compliance: orchestrator_verify_compliance auto-discovers research by task link" {
    create_test_epic_structure
    create_valid_manifest

    # Create a manifest entry linked to T003 (will be auto-discovered)
    local manifest_file="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    cat >> "$manifest_file" << EOF
{"id":"auto-discovered","file":"auto-discovered.md","title":"Auto Research","date":"2026-01-26","status":"complete","topics":["test"],"key_findings":["F1"],"actionable":true,"needs_followup":[],"linked_tasks":["T003"]}
EOF
    touch "${RESEARCH_OUTPUT_DIR}/auto-discovered.md"

    # Call without explicit research ID - should auto-discover
    local result
    result=$(orchestrator_verify_compliance "T003")

    local can_spawn
    can_spawn=$(echo "$result" | jq -r '.result.canSpawnNext')
    [[ "$can_spawn" == "true" ]]

    local discovered_id
    discovered_id=$(echo "$result" | jq -r '.result.researchId')
    [[ "$discovered_id" == "auto-discovered" ]]
}

@test "compliance: orchestrator_verify_compliance detects invalid manifest status" {
    create_test_epic_structure
    create_valid_manifest

    # Create a manifest entry with invalid status
    local manifest_file="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    cat >> "$manifest_file" << EOF
{"id":"invalid-status","file":"invalid-status.md","title":"Invalid Status","date":"2026-01-26","status":"invalid_status","topics":["test"],"key_findings":["F1"],"actionable":true,"needs_followup":[],"linked_tasks":["T004"]}
EOF
    touch "${RESEARCH_OUTPUT_DIR}/invalid-status.md"

    local result
    set +e
    result=$(orchestrator_verify_compliance "T004" "invalid-status")
    local exit_code=$?
    set -e

    # Should fail validation (exit 6)
    [[ "$exit_code" -eq 6 ]]

    local can_spawn
    can_spawn=$(echo "$result" | jq -r '.result.canSpawnNext')
    [[ "$can_spawn" == "false" ]]

    local return_valid
    return_valid=$(echo "$result" | jq -r '.result.checks.returnStatusValid')
    [[ "$return_valid" == "false" ]]
}

@test "compliance: orchestrator_verify_compliance warns when research not linked to task" {
    create_test_epic_structure
    create_valid_manifest

    # Create a manifest entry NOT linked to T005
    local manifest_file="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    cat >> "$manifest_file" << EOF
{"id":"unlinked-research","file":"unlinked-research.md","title":"Unlinked Research","date":"2026-01-26","status":"complete","topics":["test"],"key_findings":["F1"],"actionable":true,"needs_followup":[],"linked_tasks":[]}
EOF
    touch "${RESEARCH_OUTPUT_DIR}/unlinked-research.md"

    local result
    result=$(orchestrator_verify_compliance "T005" "unlinked-research")

    # Should still pass (linking is a warning, not blocking)
    local can_spawn
    can_spawn=$(echo "$result" | jq -r '.result.canSpawnNext')
    [[ "$can_spawn" == "true" ]]

    # But should have warning
    local warning_count
    warning_count=$(echo "$result" | jq -r '.result.warningCount')
    [[ "$warning_count" -gt 0 ]]

    local research_linked
    research_linked=$(echo "$result" | jq -r '.result.checks.researchLinkedToTask')
    [[ "$research_linked" == "false" ]]
}

@test "compliance: orchestrator_pre_spawn_check integrates compliance verification" {
    create_test_epic_structure
    create_valid_manifest

    # Create a compliant manifest entry for T002
    local manifest_file="${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"
    cat >> "$manifest_file" << EOF
{"id":"t002-compliant","file":"t002-compliant.md","title":"T002 Compliant","date":"2026-01-26","status":"complete","topics":["test"],"key_findings":["F1"],"actionable":true,"needs_followup":[],"linked_tasks":["T002"]}
EOF
    touch "${RESEARCH_OUTPUT_DIR}/t002-compliant.md"

    # Call pre_spawn_check with previous_task_id
    local result
    result=$(orchestrator_pre_spawn_check "T003" "T001" "T002" "t002-compliant")

    # Should have compliance validation in result
    local compliance_validation
    compliance_validation=$(echo "$result" | jq -r '.result.complianceValidation')
    [[ "$compliance_validation" != "null" ]]

    # Should show previous agent passed compliance
    local prev_can_spawn
    prev_can_spawn=$(echo "$result" | jq -r '.result.complianceValidation.canSpawnNext')
    [[ "$prev_can_spawn" == "true" ]]
}

@test "compliance: orchestrator_pre_spawn_check blocks spawn on compliance failure" {
    create_test_epic_structure

    # Ensure manifest directory exists but no entries linked to T002
    mkdir -p "$RESEARCH_OUTPUT_DIR"
    touch "${RESEARCH_OUTPUT_DIR}/MANIFEST.jsonl"

    # Mark T002 as done so it looks like previous agent completed
    local todo_file="${TEST_TEMP_DIR}/.cleo/todo.json"
    jq '.tasks = [.tasks[] | if .id == "T002" then .status = "done" else . end]' "$todo_file" > "${todo_file}.tmp"
    mv "${todo_file}.tmp" "$todo_file"

    # Call pre_spawn_check with T003 (valid pending task) and previous_task_id T002 (no manifest)
    # The function returns non-zero when canSpawn=false, so we need set +e
    local result
    set +e
    result=$(orchestrator_pre_spawn_check "T003" "T001" "T002")
    set -e

    local can_spawn
    can_spawn=$(echo "$result" | jq -r '.result.canSpawn')
    [[ "$can_spawn" == "false" ]]

    local recommendation
    recommendation=$(echo "$result" | jq -r '.result.recommendation')
    [[ "$recommendation" == "verify_compliance" ]]

    # Should have reason about previous agent violation
    local has_violation_reason
    has_violation_reason=$(echo "$result" | jq '[.result.reasons[] | select(.code == "PREVIOUS_AGENT_VIOLATION")] | length')
    [[ "$has_violation_reason" -gt 0 ]]
}
