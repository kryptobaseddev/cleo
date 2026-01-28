# Consensus Protocol

**Version**: 1.0.0
**Type**: Conditional Protocol
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Decision Making | "vote", "decide", "choose", "select" | Multi-option choice |
| Agreement | "consensus", "agree", "alignment" | Stakeholder coordination |
| Conflict Resolution | "resolve", "dispute", "conflict" | Opposing positions |
| Validation | "validate claim", "verify assertion" | Evidence-based judgment |

**Explicit Override**: `--protocol consensus` flag on task creation.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| CONS-001 | MUST use structured voting format |
| CONS-002 | MUST document rationale for each position |
| CONS-003 | MUST include confidence scores (0.0-1.0) |
| CONS-004 | MUST cite evidence supporting positions |
| CONS-005 | MUST flag conflicts with severity levels |
| CONS-006 | MUST escalate to HITL when threshold not reached |
| CONS-007 | MUST set `agent_type: "analysis"` in manifest |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| CONS-010 | SHOULD present multiple perspectives |
| CONS-011 | SHOULD identify hidden assumptions |
| CONS-012 | SHOULD document rejected alternatives |
| CONS-013 | SHOULD include uncertainty notes for low confidence |

### MAY

| Requirement | Description |
|-------------|-------------|
| CONS-020 | MAY propose compromise positions |
| CONS-021 | MAY defer non-critical decisions |
| CONS-022 | MAY request additional research |

---

## Output Format

### Voting Structure

```json
{
  "questionId": "CONS-001",
  "question": "Decision question being answered",
  "options": [
    {
      "option": "Option A description",
      "vote": "accept|reject|abstain",
      "confidence": 0.85,
      "rationale": "Why this position",
      "evidence": [{"file": "path", "section": "name", "type": "code"}]
    }
  ],
  "verdict": "PROVEN|REFUTED|CONTESTED|INSUFFICIENT_EVIDENCE",
  "consensusThreshold": 0.8,
  "actualConsensus": 0.75
}
```

### Verdict Thresholds

| Verdict | Threshold | Evidence Requirement |
|---------|-----------|---------------------|
| **PROVEN** | 3/5 agents OR 50%+ weighted confidence | Reproducible evidence |
| **REFUTED** | Counter-evidence invalidates | Counter-proof exists |
| **CONTESTED** | 3/5 split after 2 challenge rounds | Document both sides |
| **INSUFFICIENT_EVIDENCE** | Cannot reach verdict | Request investigation |

### Conflict Structure

```json
{
  "conflictId": "conflict_a1b2c3d4",
  "severity": "critical|high|medium|low",
  "conflictType": "contradiction|partial-overlap|scope-difference|priority-difference",
  "positions": [
    {"agentId": "opus-1", "position": "Position A", "confidence": 0.85},
    {"agentId": "sonnet-1", "position": "Position B", "confidence": 0.75}
  ],
  "resolution": {
    "status": "pending|proposed|accepted|rejected",
    "resolutionType": "merge|choose-a|choose-b|new|defer|escalate"
  }
}
```

### File Output

```markdown
# Consensus Report: {Decision Title}

**Task**: T####
**Date**: YYYY-MM-DD
**Status**: complete|partial|blocked
**Agent Type**: analysis

---

## Decision Question

{Clear statement of what needs to be decided}

## Options Evaluated

### Option A: {Name}

**Confidence**: X.XX
**Rationale**: {Why this option}
**Evidence**: {Citations}
**Pros**: {Advantages}
**Cons**: {Disadvantages}

### Option B: {Name}

{Same structure}

## Voting Matrix

| Agent | Option A | Option B | Confidence | Notes |
|-------|----------|----------|------------|-------|
| opus-1 | Accept | - | 0.85 | {Rationale} |
| sonnet-1 | - | Accept | 0.70 | {Rationale} |

## Verdict

**Result**: {PROVEN|REFUTED|CONTESTED|INSUFFICIENT_EVIDENCE}
**Consensus**: {X}% weighted agreement
**Recommendation**: {Final recommendation}

## Conflicts

{If any conflicts exist}

## Next Steps

1. {Action item}
```

### Manifest Entry

```json
{"id":"T####-consensus-slug","file":"YYYY-MM-DD_consensus.md","title":"Consensus: Decision Title","date":"YYYY-MM-DD","status":"complete","agent_type":"analysis","topics":["consensus","decision"],"key_findings":["Verdict reached","Option A selected","80% confidence"],"actionable":true,"needs_followup":[],"linked_tasks":["T####"]}
```

---

## Integration Points

### Base Protocol

- Inherits task lifecycle (focus, execute, complete)
- Inherits manifest append requirement
- Inherits error handling patterns

### Protocol Interactions

| Combined With | Behavior |
|---------------|----------|
| research | Research provides evidence for voting |
| specification | Consensus resolves spec ambiguities |
| contribution | Consensus validates contributions |

### HITL Escalation

| Condition | Action |
|-----------|--------|
| Contested verdict (3/5 split) | Present conflict to user |
| Critical severity conflict | Immediate escalation |
| Insufficient evidence | Request user guidance |
| Unanimous suspicious consensus | Verify with user |

---

## Example

**Task**: Decide on codebase map architecture

**Manifest Entry**:
```json
{"id":"T2216-arch-consensus","file":"2026-01-26_arch-consensus.md","title":"Consensus: Codebase Map Architecture","date":"2026-01-26","status":"complete","agent_type":"analysis","topics":["architecture","consensus","codebase-map"],"key_findings":["Single file selected over split","4/5 agents agree","Atomic operations priority"],"actionable":true,"needs_followup":["T2217"],"linked_tasks":["T2204","T2216"]}
```

---

## Integration

### Implementation Location

**Library**: `lib/contribution-protocol.sh`

**Primary Function**: `contribution_compute_consensus(epic_id, [manifest_path])`
- Loads complete contributions for epic
- Groups decisions by question ID across contributions
- Runs weighted voting per question
- Classifies: unanimous/majority = resolved, split = unresolved
- Flags unresolved questions for HITL review

**Supporting Functions**:
- `contribution_weighted_vote(votes_json)` - Calculates weighted consensus
- `contribution_create_synthesis(consensus_json, epic_id)` - Creates Markdown synthesis

### CLI Usage

**Note**: No dedicated `cleo consensus` command exists yet. Consensus computation is invoked programmatically through the contribution workflow.

**Programmatic Usage**:
```bash
source lib/contribution-protocol.sh

# Compute consensus for an epic
consensus=$(contribution_compute_consensus "T2679")

# Extract resolved/unresolved questions
resolved=$(echo "$consensus" | jq '.resolvedQuestions')
unresolved=$(echo "$consensus" | jq '.unresolvedQuestions')
```

### Orchestrator Integration

**Spawn Context**: When spawning consensus agents via orchestrator:

```bash
# Orchestrator detects consensus protocol from task labels
protocol_type=$(_osp_skill_to_protocol "ct-validator")  # Returns "consensus"

# Validates consensus requirements before spawn
validate_consensus_protocol "$task_id" "$manifest_entry" "$voting_matrix" "false"

# Blocks spawn if:
# - Voting matrix has <2 options (CONS-001)
# - Confidence scores invalid (CONS-003)
# - Top confidence below 50% threshold (CONS-004)
# - agent_type not "analysis" (CONS-007)
```

**Exit Codes**:
- `EXIT_PROTOCOL_CONSENSUS` (61) - Consensus protocol violation
- `EXIT_PROTOCOL_GENERIC` (67) - Generic protocol error

### Validation Hook

**Function**: `validate_consensus_protocol(task_id, manifest_entry, voting_matrix, strict)`

**Location**: `lib/protocol-validation.sh`

**Validates**:
- CONS-001: ≥2 options in voting matrix
- CONS-003: Confidence scores 0.0-1.0
- CONS-004: Top confidence ≥50% threshold
- CONS-007: agent_type = "analysis"

---

## Anti-Patterns

| Pattern | Why Avoid |
|---------|-----------|
| Accepting unanimous consensus without scrutiny | May indicate groupthink |
| Skipping evidence citations | Decisions lack foundation |
| Binary voting without confidence | Loses nuance |
| Ignoring minority positions | May miss valid concerns |
| Premature escalation | Wastes human attention |

---

*Protocol Version 1.0.0 - Consensus Protocol*
