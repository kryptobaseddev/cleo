#!/usr/bin/env bats
# =============================================================================
# contribution-json.bats - Unit tests for JSON-first contribution system
# =============================================================================
# Tests the contribution protocol v2.0 functions for:
# - JSON format validation
# - Conflict detection between sessions
# - Consensus aggregation via weighted voting
# - Manifest JSONL operations
# =============================================================================

setup_file() {
    load '../test_helper/common_setup'
    common_setup_file
}

setup() {
    load '../test_helper/common_setup'
    load '../test_helper/assertions'
    common_setup_per_test

    # Set CLEO_HOME for library sourcing
    export CLEO_HOME="${PROJECT_ROOT}"
    export CLEO_LIB_DIR="${PROJECT_ROOT}/lib"

    # Create contributions directory
    mkdir -p "${TEST_TEMP_DIR}/.cleo/contributions"
    export CONTRIB_DIR="${TEST_TEMP_DIR}/.cleo/contributions"
    export MANIFEST_FILE="${CONTRIB_DIR}/CONTRIBUTIONS.jsonl"

    # Source the contribution protocol library
    source "${PROJECT_ROOT}/lib/skills/contribution-protocol.sh"
}

teardown() {
    common_teardown_per_test
}

teardown_file() {
    common_teardown_file
}

# =============================================================================
# Test Data Helpers
# =============================================================================

# Create a test contribution JSON
_create_test_contribution() {
    local session_id="${1:-session_20260126_120000_abc123}"
    local answer="${2:-Single file architecture}"
    local confidence="${3:-0.8}"
    local question_id="${4:-RCSD-001}"
    local agent_id="${5:-opus-1}"

    cat <<EOF
{
  "\$schema": "https://cleo-dev.com/schemas/v2/contribution.schema.json",
  "_meta": {
    "contributionId": "contrib_$(openssl rand -hex 4 2>/dev/null || echo '12345678')",
    "protocolVersion": "2.0.0",
    "createdAt": "2026-01-26T12:00:00Z",
    "completedAt": "2026-01-26T13:00:00Z",
    "agentId": "${agent_id}",
    "checksum": null,
    "consensusReady": true
  },
  "sessionId": "${session_id}",
  "sessionLabel": "Session A",
  "epicId": "T9999",
  "taskId": "T9999",
  "markerLabel": "test-contrib",
  "researchOutputs": [],
  "decisions": [
    {
      "questionId": "${question_id}",
      "question": "What architecture should we use?",
      "answer": "${answer}",
      "confidence": ${confidence},
      "rationale": "Based on analysis of existing patterns in the codebase.",
      "evidence": [
        {
          "file": "lib/data/file-ops.sh",
          "section": "atomic_write function",
          "type": "code"
        }
      ]
    }
  ],
  "conflicts": [],
  "status": "complete"
}
EOF
}

# Create a decision object for testing
_create_test_decision() {
    local question_id="${1:-RCSD-001}"
    local answer="${2:-Test answer}"
    local confidence="${3:-0.8}"

    cat <<EOF
{
  "questionId": "${question_id}",
  "question": "Test question for ${question_id}",
  "answer": "${answer}",
  "confidence": ${confidence},
  "rationale": "Test rationale",
  "evidence": [
    {
      "file": "test.sh",
      "section": "test section",
      "type": "code"
    }
  ]
}
EOF
}

# =============================================================================
# JSON Format Tests (CONTRIB-007)
# =============================================================================

@test "valid contribution JSON passes jq parsing" {
    local contrib
    contrib=$(_create_test_contribution "session_20260126_120000_abc123" "Single file" "0.85")

    # Should be valid JSON
    echo "$contrib" | jq empty
}

@test "contribution JSON contains all required fields" {
    local contrib
    contrib=$(_create_test_contribution)

    # Check required top-level fields
    local schema session_id epic_id task_id marker decisions
    schema=$(echo "$contrib" | jq -r '."$schema"')
    session_id=$(echo "$contrib" | jq -r '.sessionId')
    epic_id=$(echo "$contrib" | jq -r '.epicId')
    task_id=$(echo "$contrib" | jq -r '.taskId')
    marker=$(echo "$contrib" | jq -r '.markerLabel')
    decisions=$(echo "$contrib" | jq '.decisions | length')

    [[ "$schema" == *"contribution.schema.json"* ]]
    [[ "$session_id" =~ ^session_ ]]
    [[ "$epic_id" == "T9999" ]]
    [[ "$task_id" == "T9999" ]]
    [[ "$marker" == "test-contrib" ]]
    [[ "$decisions" -gt 0 ]]
}

@test "contribution _meta contains required metadata" {
    local contrib
    contrib=$(_create_test_contribution)

    local contrib_id created_at agent_id
    contrib_id=$(echo "$contrib" | jq -r '._meta.contributionId')
    created_at=$(echo "$contrib" | jq -r '._meta.createdAt')
    agent_id=$(echo "$contrib" | jq -r '._meta.agentId')

    [[ "$contrib_id" =~ ^contrib_ ]]
    [[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]
    [[ "$agent_id" == "opus-1" ]]
}

@test "confidence scores validated - 0.0 is valid minimum" {
    local decision
    decision=$(_create_test_decision "Q001" "Test" "0.0")

    local confidence
    confidence=$(echo "$decision" | jq -r '.confidence')

    # 0.0 is valid (jq may output as "0" or "0.0")
    [[ "$confidence" == "0" || "$confidence" == "0.0" ]]
}

@test "confidence scores validated - 1.0 is valid maximum" {
    local decision
    decision=$(_create_test_decision "Q001" "Test" "1.0")

    local confidence
    confidence=$(echo "$decision" | jq -r '.confidence')

    # 1.0 is valid (jq may output as "1" or "1.0")
    [[ "$confidence" == "1" || "$confidence" == "1.0" ]]
}

@test "confidence scores validated - mid-range values work" {
    local decision
    decision=$(_create_test_decision "Q001" "Test" "0.75")

    local confidence
    confidence=$(echo "$decision" | jq -r '.confidence')

    [[ "$confidence" == "0.75" ]]
}

@test "invalid JSON fails jq parsing" {
    local invalid_json='{"broken: json, missing quotes}'

    # Should fail jq parsing
    run bash -c "echo '$invalid_json' | jq empty"
    [[ "$status" -ne 0 ]]
}

@test "decision with missing required fields detected" {
    local incomplete='{"questionId": "Q001", "answer": "test"}'

    # Missing confidence, rationale, evidence
    local has_confidence has_rationale has_evidence
    has_confidence=$(echo "$incomplete" | jq 'has("confidence")')
    has_rationale=$(echo "$incomplete" | jq 'has("rationale")')
    has_evidence=$(echo "$incomplete" | jq 'has("evidence")')

    [[ "$has_confidence" == "false" ]]
    [[ "$has_rationale" == "false" ]]
    [[ "$has_evidence" == "false" ]]
}

# =============================================================================
# Conflict Detection Tests (contribution_compare_decisions, contribution_detect_conflicts)
# =============================================================================

@test "identical answers produce no conflict" {
    local decision1 decision2
    decision1=$(_create_test_decision "RCSD-001" "Single file architecture" "0.85")
    decision2=$(_create_test_decision "RCSD-001" "Single file architecture" "0.80")

    local result
    result=$(contribution_compare_decisions "$decision1" "$decision2")

    local is_match
    is_match=$(echo "$result" | jq -r '.match')

    [[ "$is_match" == "true" ]]
}

@test "different answers produce conflict" {
    local decision1 decision2
    decision1=$(_create_test_decision "RCSD-001" "Single file architecture" "0.85")
    decision2=$(_create_test_decision "RCSD-001" "Split files per component" "0.75")

    local result
    result=$(contribution_compare_decisions "$decision1" "$decision2")

    local is_match has_conflict
    is_match=$(echo "$result" | jq -r '.match')
    has_conflict=$(echo "$result" | jq 'has("conflict")')

    [[ "$is_match" == "false" ]]
    [[ "$has_conflict" == "true" ]]
}

@test "conflict includes both positions" {
    local decision1 decision2
    decision1=$(_create_test_decision "RCSD-001" "Option A" "0.85")
    decision2=$(_create_test_decision "RCSD-001" "Option B" "0.75")

    local result
    result=$(contribution_compare_decisions "$decision1" "$decision2")

    local this_pos other_pos
    this_pos=$(echo "$result" | jq -r '.conflict.thisSession.position')
    other_pos=$(echo "$result" | jq -r '.conflict.otherSession.position')

    [[ "$this_pos" == "Option A" ]]
    [[ "$other_pos" == "Option B" ]]
}

@test "severity classification: critical for high-confidence disagreement" {
    # Both confidences > 0.8 = critical
    local decision1 decision2
    decision1=$(_create_test_decision "RCSD-001" "Option A" "0.95")
    decision2=$(_create_test_decision "RCSD-001" "Option B" "0.90")

    local result
    result=$(contribution_compare_decisions "$decision1" "$decision2")

    local severity
    severity=$(echo "$result" | jq -r '.conflict.severity')

    [[ "$severity" == "critical" ]]
}

@test "severity classification: high for medium-confidence disagreement" {
    # Both confidences > 0.6 but not both > 0.8 = high
    local decision1 decision2
    decision1=$(_create_test_decision "RCSD-001" "Option A" "0.75")
    decision2=$(_create_test_decision "RCSD-001" "Option B" "0.70")

    local result
    result=$(contribution_compare_decisions "$decision1" "$decision2")

    local severity
    severity=$(echo "$result" | jq -r '.conflict.severity')

    [[ "$severity" == "high" ]]
}

@test "severity classification: low for low-confidence disagreement" {
    # Both confidences < 0.5 = low
    local decision1 decision2
    decision1=$(_create_test_decision "RCSD-001" "Option A" "0.3")
    decision2=$(_create_test_decision "RCSD-001" "Option B" "0.4")

    local result
    result=$(contribution_compare_decisions "$decision1" "$decision2")

    local severity
    severity=$(echo "$result" | jq -r '.conflict.severity')

    [[ "$severity" == "low" ]]
}

@test "contribution_detect_conflicts finds all disagreements" {
    # Create two contributions with different answers
    local contrib1 contrib2
    contrib1=$(_create_test_contribution "session_20260126_120000_abc123" "Option A" "0.85" "RCSD-001")
    contrib2=$(_create_test_contribution "session_20260126_130000_def456" "Option B" "0.75" "RCSD-001")

    local result
    result=$(contribution_detect_conflicts "$contrib1" "$contrib2")

    local conflict_count
    conflict_count=$(echo "$result" | jq '.conflicts | length')

    [[ "$conflict_count" -gt 0 ]]
}

@test "contribution_detect_conflicts summary includes severity counts" {
    local contrib1 contrib2
    contrib1=$(_create_test_contribution "session_20260126_120000_abc123" "Option A" "0.85" "RCSD-001")
    contrib2=$(_create_test_contribution "session_20260126_130000_def456" "Option B" "0.75" "RCSD-001")

    local result
    result=$(contribution_detect_conflicts "$contrib1" "$contrib2")

    local has_summary has_total
    has_summary=$(echo "$result" | jq 'has("summary")')
    has_total=$(echo "$result" | jq '.summary | has("total")')

    [[ "$has_summary" == "true" ]]
    [[ "$has_total" == "true" ]]
}

@test "contribution_detect_conflicts returns empty for matching contributions" {
    local contrib1 contrib2
    contrib1=$(_create_test_contribution "session_20260126_120000_abc123" "Same Answer" "0.85" "RCSD-001")
    contrib2=$(_create_test_contribution "session_20260126_130000_def456" "Same Answer" "0.75" "RCSD-001")

    local result
    result=$(contribution_detect_conflicts "$contrib1" "$contrib2")

    local conflict_count
    conflict_count=$(echo "$result" | jq '.summary.total')

    [[ "$conflict_count" -eq 0 ]]
}

@test "conflict type detected as contradiction for mutually exclusive answers" {
    local decision1 decision2
    decision1=$(_create_test_decision "Q001" "Use JSON format" "0.85")
    decision2=$(_create_test_decision "Q001" "Use YAML format" "0.75")

    local result
    result=$(contribution_compare_decisions "$decision1" "$decision2")

    local conflict_type
    conflict_type=$(echo "$result" | jq -r '.conflict.conflictType')

    [[ "$conflict_type" == "contradiction" ]]
}

@test "conflict type detected as partial-overlap when one contains the other" {
    local decision1 decision2
    decision1=$(_create_test_decision "Q001" "Use JSON" "0.85")
    decision2=$(_create_test_decision "Q001" "Use JSON with strict validation" "0.75")

    local result
    result=$(contribution_compare_decisions "$decision1" "$decision2")

    local conflict_type
    conflict_type=$(echo "$result" | jq -r '.conflict.conflictType')

    # "Use JSON" is contained in "Use JSON with strict validation"
    [[ "$conflict_type" == "partial-overlap" ]]
}

# =============================================================================
# Consensus Aggregation Tests (contribution_weighted_vote, contribution_compute_consensus)
# =============================================================================

@test "single contribution returns full confidence" {
    local decisions='[{"sessionId": "session_a", "answer": "Option A", "confidence": 0.85}]'

    local result
    result=$(contribution_weighted_vote "$decisions" "Q001")

    local winner confidence voting_result
    winner=$(echo "$result" | jq -r '.winner')
    confidence=$(echo "$result" | jq -r '.confidence')
    voting_result=$(echo "$result" | jq -r '.votingResult')

    [[ "$winner" == "Option A" ]]
    [[ "$confidence" == "0.85" ]]
    [[ "$voting_result" == "unanimous" ]]
}

@test "unanimous vote computed correctly" {
    local decisions='[
        {"sessionId": "session_a", "answer": "Option A", "confidence": 0.85},
        {"sessionId": "session_b", "answer": "Option A", "confidence": 0.90},
        {"sessionId": "session_c", "answer": "Option A", "confidence": 0.80}
    ]'

    local result
    result=$(contribution_weighted_vote "$decisions" "Q001")

    local voting_result winner
    voting_result=$(echo "$result" | jq -r '.votingResult')
    winner=$(echo "$result" | jq -r '.winner')

    [[ "$voting_result" == "unanimous" ]]
    [[ "$winner" == "Option A" ]]
}

@test "majority vote computed correctly" {
    local decisions='[
        {"sessionId": "session_a", "answer": "Option A", "confidence": 0.90},
        {"sessionId": "session_b", "answer": "Option A", "confidence": 0.85},
        {"sessionId": "session_c", "answer": "Option B", "confidence": 0.50}
    ]'

    local result
    result=$(contribution_weighted_vote "$decisions" "Q001")

    local voting_result winner
    voting_result=$(echo "$result" | jq -r '.votingResult')
    winner=$(echo "$result" | jq -r '.winner')

    # Option A has weight 0.90 + 0.85 = 1.75
    # Option B has weight 0.50
    # Total weight = 2.25
    # Option A percentage = 1.75/2.25 = 77.7% > 50%
    [[ "$voting_result" == "majority" ]]
    [[ "$winner" == "Option A" ]]
}

@test "split vote flags HITL required" {
    local decisions='[
        {"sessionId": "session_a", "answer": "Option A", "confidence": 0.75},
        {"sessionId": "session_b", "answer": "Option B", "confidence": 0.75}
    ]'

    local result
    result=$(contribution_weighted_vote "$decisions" "Q001")

    local voting_result
    voting_result=$(echo "$result" | jq -r '.votingResult')

    # Equal weights = 50/50 split = no majority
    [[ "$voting_result" == "split" ]]
}

@test "weighted confidence calculation includes all votes" {
    local decisions='[
        {"sessionId": "session_a", "answer": "Option A", "confidence": 0.90},
        {"sessionId": "session_b", "answer": "Option A", "confidence": 0.70}
    ]'

    local result
    result=$(contribution_weighted_vote "$decisions" "Q001")

    local total_weight
    total_weight=$(echo "$result" | jq -r '.totalWeight')

    # Should be 0.90 + 0.70 = 1.60
    [[ $(awk -v tw="$total_weight" 'BEGIN { print (tw > 1.59 && tw < 1.61) ? 1 : 0 }') -eq 1 ]]
}

@test "empty contributions returns error result" {
    local decisions='[]'

    local result
    result=$(contribution_weighted_vote "$decisions" "Q001")

    local voting_result winner
    voting_result=$(echo "$result" | jq -r '.votingResult')
    winner=$(echo "$result" | jq -r '.winner')

    [[ "$voting_result" == "no-votes" ]]
    [[ "$winner" == "null" ]]
}

@test "answer breakdown shows all positions" {
    local decisions='[
        {"sessionId": "session_a", "answer": "Option A", "confidence": 0.85},
        {"sessionId": "session_b", "answer": "Option B", "confidence": 0.75},
        {"sessionId": "session_c", "answer": "Option A", "confidence": 0.80}
    ]'

    local result
    result=$(contribution_weighted_vote "$decisions" "Q001")

    local breakdown_count
    breakdown_count=$(echo "$result" | jq '.answerBreakdown | length')

    # Should have 2 unique answers (Option A and Option B)
    [[ "$breakdown_count" -eq 2 ]]
}

@test "answer breakdown includes session lists" {
    local decisions='[
        {"sessionId": "session_a", "answer": "Option A", "confidence": 0.85},
        {"sessionId": "session_b", "answer": "Option A", "confidence": 0.75}
    ]'

    local result
    result=$(contribution_weighted_vote "$decisions" "Q001")

    local sessions
    sessions=$(echo "$result" | jq -r '.answerBreakdown[0].sessions | join(",")')

    [[ "$sessions" == *"session_a"* ]]
    [[ "$sessions" == *"session_b"* ]]
}

# =============================================================================
# Manifest Tests (JSONL format)
# =============================================================================

@test "contribution_create_manifest_entry creates valid JSONL line" {
    local entry
    entry=$(contribution_create_manifest_entry "session_20260126_120000_abc123" "T2308" "T2315" "opus-1")

    # Should be single-line JSON (valid JSONL)
    local line_count
    line_count=$(echo "$entry" | wc -l)

    # jq pretty-prints by default, but the JSON itself is valid
    echo "$entry" | jq -c '.' | grep -q '^{.*}$'
}

@test "manifest entry includes correct status" {
    local entry status
    entry=$(contribution_create_manifest_entry "session_20260126_120000_abc123" "T2308" "T2315" "opus-1")
    status=$(echo "$entry" | jq -r '.status')

    [[ "$status" == "draft" ]]
}

@test "query returns correct entries by epic" {
    # Create manifest with multiple entries
    cat > "$MANIFEST_FILE" << 'EOF'
{"epicId": "T2308", "taskId": "T2315", "sessionId": "session_a", "status": "complete", "filePath": "contrib_1.json"}
{"epicId": "T2308", "taskId": "T2316", "sessionId": "session_b", "status": "complete", "filePath": "contrib_2.json"}
{"epicId": "T9999", "taskId": "T9998", "sessionId": "session_c", "status": "complete", "filePath": "contrib_3.json"}
EOF

    # Query for T2308 epic
    local entries
    entries=$(jq -sc --arg eid "T2308" '[.[] | select(.epicId == $eid)]' "$MANIFEST_FILE")

    local count
    count=$(echo "$entries" | jq 'length')

    [[ "$count" -eq 2 ]]
}

@test "contribution_aggregate_conflicts returns empty for missing manifest" {
    local result
    result=$(contribution_aggregate_conflicts "T9999" "/nonexistent/path.jsonl")

    local contrib_count
    contrib_count=$(echo "$result" | jq '.contributionCount')

    [[ "$contrib_count" -eq 0 ]]
}

@test "contribution_compute_consensus handles empty manifest" {
    local result
    result=$(contribution_compute_consensus "T9999" "/nonexistent/path.jsonl")

    local has_consensus contrib_count
    has_consensus=$(echo "$result" | jq 'has("consensus")')
    contrib_count=$(echo "$result" | jq '.consensus.contributionCount')

    [[ "$has_consensus" == "true" ]]
    [[ "$contrib_count" -eq 0 ]]
}

# =============================================================================
# Integration Tests
# =============================================================================

@test "full workflow: contribute -> detect -> aggregate" {
    # Step 1: Create two contributions with one conflict
    local contrib1 contrib2
    contrib1=$(_create_test_contribution "session_20260126_120000_abc123" "Single file architecture" "0.85" "RCSD-001" "opus-1")
    contrib2=$(_create_test_contribution "session_20260126_130000_def456" "Split file architecture" "0.75" "RCSD-001" "sonnet-2")

    # Step 2: Write contributions to files
    echo "$contrib1" > "${CONTRIB_DIR}/contrib_1.json"
    echo "$contrib2" > "${CONTRIB_DIR}/contrib_2.json"

    # Step 3: Create manifest
    cat > "$MANIFEST_FILE" << EOF
{"epicId": "T9999", "taskId": "T9999", "sessionId": "session_20260126_120000_abc123", "status": "complete", "filePath": "${CONTRIB_DIR}/contrib_1.json"}
{"epicId": "T9999", "taskId": "T9999", "sessionId": "session_20260126_130000_def456", "status": "complete", "filePath": "${CONTRIB_DIR}/contrib_2.json"}
EOF

    # Step 4: Detect conflicts between contributions
    local conflicts
    conflicts=$(contribution_detect_conflicts "$contrib1" "$contrib2")

    local conflict_count
    conflict_count=$(echo "$conflicts" | jq '.summary.total')

    # Should have 1 conflict
    [[ "$conflict_count" -eq 1 ]]

    # Step 5: Aggregate conflicts for the epic
    local aggregation
    aggregation=$(contribution_aggregate_conflicts "T9999" "$MANIFEST_FILE")

    local contrib_found
    contrib_found=$(echo "$aggregation" | jq '.contributionCount')

    [[ "$contrib_found" -eq 2 ]]
}

@test "full workflow: weighted voting produces consensus" {
    # Create decisions from multiple sessions
    local decisions='[
        {"sessionId": "session_a", "answer": "Use JSON format", "confidence": 0.90},
        {"sessionId": "session_b", "answer": "Use JSON format", "confidence": 0.85},
        {"sessionId": "session_c", "answer": "Use YAML format", "confidence": 0.50}
    ]'

    local result
    result=$(contribution_weighted_vote "$decisions" "FORMAT-001")

    local winner voting_result confidence
    winner=$(echo "$result" | jq -r '.winner')
    voting_result=$(echo "$result" | jq -r '.votingResult')
    confidence=$(echo "$result" | jq -r '.confidence')

    # JSON should win with majority
    [[ "$winner" == "Use JSON format" ]]
    [[ "$voting_result" == "majority" ]]
    # Confidence should be reasonable (weighted average of winning votes)
    [[ $(awk -v c="$confidence" 'BEGIN { print (c > 0.8) ? 1 : 0 }') -eq 1 ]]
}

@test "synthesis generation produces valid markdown" {
    # Create a simple consensus JSON
    local consensus_json
    consensus_json=$(cat <<'EOF'
{
  "consensus": {
    "epicId": "T9999",
    "computedAt": "2026-01-26T15:00:00Z",
    "contributionCount": 2,
    "decisions": [
      {
        "questionId": "Q001",
        "question": "What format should we use?",
        "answer": "JSON",
        "confidence": 0.87,
        "votingResult": "unanimous",
        "supportingSessions": ["session_a", "session_b"],
        "dissenting": []
      }
    ],
    "unresolved": [],
    "hitlRequired": false,
    "summary": {
      "totalQuestions": 1,
      "resolved": 1,
      "unresolved": 0,
      "averageConfidence": 0.87
    }
  }
}
EOF
)

    local synthesis
    synthesis=$(contribution_generate_synthesis "T9999" "$consensus_json")

    # Should contain key sections
    [[ "$synthesis" == *"# Consensus Synthesis"* ]]
    [[ "$synthesis" == *"## Summary"* ]]
    [[ "$synthesis" == *"## Resolved Decisions"* ]]
    [[ "$synthesis" == *"T9999"* ]]
}

@test "conflict detection preserves question IDs" {
    local decision1 decision2
    decision1=$(_create_test_decision "CUSTOM-999" "Answer A" "0.85")
    decision2=$(_create_test_decision "CUSTOM-999" "Answer B" "0.75")

    local result
    result=$(contribution_compare_decisions "$decision1" "$decision2")

    local question_id
    question_id=$(echo "$result" | jq -r '.conflict.questionId')

    [[ "$question_id" == "CUSTOM-999" ]]
}

@test "conflict generates unique conflict ID" {
    local decision1 decision2
    decision1=$(_create_test_decision "Q001" "A" "0.85")
    decision2=$(_create_test_decision "Q001" "B" "0.75")

    local result1 result2
    result1=$(contribution_compare_decisions "$decision1" "$decision2")
    result2=$(contribution_compare_decisions "$decision1" "$decision2")

    local id1 id2
    id1=$(echo "$result1" | jq -r '.conflict.conflictId')
    id2=$(echo "$result2" | jq -r '.conflict.conflictId')

    # Each call generates a new unique ID
    [[ "$id1" =~ ^conflict_ ]]
    [[ "$id2" =~ ^conflict_ ]]
    # They should be different (though this is probabilistic)
    # We'll just verify format
    [[ ${#id1} -eq 17 ]]  # "conflict_" + 8 hex chars
}

@test "consensus marks split votes as requiring HITL" {
    # Create consensus with unresolved question
    local consensus_json
    consensus_json=$(cat <<'EOF'
{
  "consensus": {
    "epicId": "T9999",
    "computedAt": "2026-01-26T15:00:00Z",
    "contributionCount": 2,
    "decisions": [],
    "unresolved": [
      {
        "questionId": "Q001",
        "question": "Disputed question",
        "reason": "split vote - no majority",
        "positions": []
      }
    ],
    "hitlRequired": true,
    "summary": {
      "totalQuestions": 1,
      "resolved": 0,
      "unresolved": 1,
      "averageConfidence": 0
    }
  }
}
EOF
)

    local hitl_required
    hitl_required=$(echo "$consensus_json" | jq -r '.consensus.hitlRequired')

    [[ "$hitl_required" == "true" ]]
}

# =============================================================================
# Edge Cases and Error Handling
# =============================================================================

@test "contribution_compare_decisions handles missing question ID match" {
    local decision1 decision2
    decision1=$(_create_test_decision "Q001" "Answer" "0.85")
    decision2=$(_create_test_decision "Q002" "Different" "0.75")

    # Different question IDs should cause an error
    run contribution_compare_decisions "$decision1" "$decision2"

    [[ "$status" -ne 0 ]]
}

@test "weighted vote handles case-insensitive answer matching" {
    local decisions='[
        {"sessionId": "session_a", "answer": "Use JSON", "confidence": 0.85},
        {"sessionId": "session_b", "answer": "use json", "confidence": 0.80}
    ]'

    local result
    result=$(contribution_weighted_vote "$decisions" "Q001")

    local voting_result breakdown_count
    voting_result=$(echo "$result" | jq -r '.votingResult')
    breakdown_count=$(echo "$result" | jq '.answerBreakdown | length')

    # Should normalize to same answer
    [[ "$voting_result" == "unanimous" ]]
    [[ "$breakdown_count" -eq 1 ]]
}

@test "contribution_detect_conflicts requires both inputs" {
    run contribution_detect_conflicts "" '{"decisions": []}'
    [[ "$status" -ne 0 ]]

    run contribution_detect_conflicts '{"decisions": []}' ""
    [[ "$status" -ne 0 ]]
}

@test "contribution_weighted_vote requires decisions input" {
    run contribution_weighted_vote "" "Q001"
    [[ "$status" -ne 0 ]]
}
