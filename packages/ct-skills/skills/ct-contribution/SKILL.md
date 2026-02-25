---
name: ct-contribution
description: >-
  Guided workflow for multi-agent consensus contributions.
  Use when user says "/contribution", "contribution protocol", "submit contribution",
  "consensus workflow", "multi-agent decision", "create contribution",
  "contribution start", "contribution submit", "detect conflicts",
  "weighted consensus", "decision tracking", "conflict resolution".
version: 1.0.0
tier: 3
core: false
category: meta
protocol: contribution
dependencies: []
sharedResources:
  - subagent-protocol-base
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Contribution Protocol Skill

You are a contribution protocol agent. Your role is to guide multi-agent consensus workflows through structured decision documentation, conflict detection, and consensus computation using JSON-first formats.

## Overview

The Contribution Protocol enables:
- **Machine-parseable decisions** with confidence scores
- **Evidence-based rationale** with traceable references
- **Automated conflict detection** across parallel sessions
- **Weighted consensus computation** for multi-agent agreement

### When to Use

| Scenario | Use Contribution Protocol? | Rationale |
|----------|---------------------------|-----------|
| Multi-agent research (2+ sessions) | **Yes** | Structured conflict detection |
| Consensus-building on architecture | **Yes** | Weighted voting, evidence tracking |
| RCSD pipeline integration | **Yes** | JSON format enables automation |
| Single-agent research | No | Simpler research manifest sufficient |
| Quick decision with no alternatives | No | Protocol overhead not justified |

---

## Commands

### `/contribution start <epic-id>`

Initialize contribution tracking for an epic.

**Usage**:
```
/contribution start T2204
/contribution start T2204 --label rcsd-contrib
```

**Workflow**:
1. Verify epic exists and is active
2. Create contribution task under epic
3. Initialize contribution directories
4. Generate contribution ID
5. Return task ID and setup instructions

**Parameters**:
| Parameter | Description | Default |
|-----------|-------------|---------|
| `<epic-id>` | Parent epic task ID | Required |
| `--label` | Marker label for discovery | `consensus-source` |
| `--agent` | Agent identifier | Current agent |

### `/contribution submit`

Validate and submit the current contribution.

**Usage**:
```
/contribution submit
/contribution submit --task T2215
```

**Workflow**:
1. Validate contribution JSON against schema
2. Compute checksum for integrity
3. Append entry to CONTRIBUTIONS.jsonl manifest
4. Update task notes with contribution reference
5. Mark contribution status as `complete`
6. Return submission confirmation

**Parameters**:
| Parameter | Description | Default |
|-----------|-------------|---------|
| `--task` | Contribution task ID | Current focused task |
| `--dry-run` | Validate without submitting | false |

### `/contribution conflicts [epic-id]`

Detect conflicts between contributions for an epic.

**Usage**:
```
/contribution conflicts T2204
/contribution conflicts --severity high
```

**Workflow**:
1. Load all contributions for epic
2. Group decisions by questionId
3. Compare answers for semantic conflicts
4. Classify conflict type and severity
5. Return conflict report with resolution suggestions

**Parameters**:
| Parameter | Description | Default |
|-----------|-------------|---------|
| `[epic-id]` | Epic to analyze | Current scope |
| `--severity` | Filter by severity | all |

**Output**:
```json
{
  "epicId": "T2204",
  "conflictCount": 2,
  "conflicts": [
    {
      "questionId": "ARCH-001",
      "severity": "high",
      "positions": [
        {"agentId": "opus-1", "answer": "Position A", "confidence": 0.85},
        {"agentId": "sonnet-1", "answer": "Position B", "confidence": 0.75}
      ]
    }
  ]
}
```

### `/contribution status [epic-id]`

Show contribution progress and consensus status.

**Usage**:
```
/contribution status
/contribution status T2204
```

**Workflow**:
1. Query manifest for epic contributions
2. Calculate completion statistics
3. Identify pending conflicts
4. Show consensus progress per question
5. Return status summary

**Output**:
```json
{
  "epicId": "T2204",
  "totalContributions": 3,
  "complete": 2,
  "partial": 1,
  "blocked": 0,
  "conflictsPending": 2,
  "questionsAnswered": 5,
  "consensusReady": false
}
```

---

## Workflow Guides

### Starting a New Contribution

```bash
# 1. Verify epic exists
ct show T2204

# 2. Initialize contribution
/contribution start T2204 --label rcsd-contrib

# 3. Create contribution task (if not auto-created)
ct add "Session B: Architecture Analysis" \
  --parent T2204 \
  --labels consensus-source,research \
  --phase core

# 4. Start task
ct start T2215

# 5. Create contribution directory
mkdir -p .cleo/contributions

# 6. Generate contribution ID
source lib/contribution-protocol.sh
CONTRIB_ID=$(contribution_generate_id)
echo "Contribution ID: $CONTRIB_ID"
```

### Writing a Contribution

Create `.cleo/contributions/T2215.json`:

```json
{
  "$schema": "https://cleo-dev.com/schemas/v2/contribution.schema.json",
  "_meta": {
    "contributionId": "contrib_a1b2c3d4",
    "protocolVersion": "2.0.0",
    "createdAt": "2026-01-26T14:00:00Z",
    "agentId": "opus-1",
    "consensusReady": false
  },
  "sessionId": "session_20260126_140000_abc123",
  "epicId": "T2204",
  "taskId": "T2215",
  "markerLabel": "consensus-source",
  "researchOutputs": [],
  "decisions": [
    {
      "questionId": "ARCH-001",
      "question": "Single file or split file architecture?",
      "answer": "Single JSON file with internal sections",
      "confidence": 0.85,
      "rationale": "Simplifies atomic updates and validation",
      "evidence": [
        {
          "file": "lib/file-ops.sh",
          "section": "atomic_write function",
          "type": "code"
        }
      ]
    }
  ],
  "conflicts": [],
  "status": "draft"
}
```

### Submitting a Contribution

```bash
# 1. Validate contribution
/contribution submit --dry-run

# 2. Submit contribution
/contribution submit --task T2215

# 3. Complete task
ct complete T2215
```

### Detecting and Resolving Conflicts

```bash
# 1. Check for conflicts
/contribution conflicts T2204

# 2. Review conflict details
jq '.conflicts[] | select(.severity == "high")' .cleo/contributions/CONTRIBUTIONS.jsonl

# 3. Add conflict resolution to contribution
# Edit .cleo/contributions/T2215.json to add:
{
  "conflicts": [
    {
      "questionId": "ARCH-001",
      "conflictId": "conflict_b2c3d4e5",
      "severity": "high",
      "conflictType": "contradiction",
      "thisSession": {
        "position": "Single file architecture",
        "confidence": 0.85,
        "evidence": [...]
      },
      "otherSession": {
        "sessionId": "session_...",
        "position": "Split file architecture",
        "confidence": 0.75,
        "evidence": [...]
      },
      "rationale": "Different priorities: simplicity vs parallelism",
      "resolution": {
        "status": "proposed",
        "resolutionType": "merge",
        "proposal": "Single file with future split option"
      },
      "requiresConsensus": true
    }
  ]
}

# 4. Re-submit with conflict documentation
/contribution submit
```

---

## JSON Format Reference

> **Authoritative Specification**: [CONTRIBUTION-FORMAT-SPEC.md](../../docs/specs/CONTRIBUTION-FORMAT-SPEC.md)
>
> **JSON Schema**: [contribution.schema.json](../../schemas/contribution.schema.json)

### Decision Object

```json
{
  "questionId": "RCSD-001",
  "question": "The decision question being answered",
  "answer": "Concrete, actionable decision (no hedging)",
  "confidence": 0.85,
  "rationale": "Reasoning with evidence references",
  "evidence": [
    {
      "file": "lib/file-ops.sh",
      "section": "atomic_write function",
      "quote": "temp file -> validate -> backup -> rename",
      "line": 142,
      "type": "code"
    }
  ],
  "uncertaintyNote": "Required if confidence < 0.7",
  "alternatives": [
    {
      "option": "Alternative considered",
      "reason": "Why not chosen"
    }
  ]
}
```

### Confidence Score Semantics

| Range | Level | Requirements |
|-------|-------|--------------|
| 0.90-1.00 | Very High | MUST have 2+ independent evidence sources |
| 0.70-0.89 | High | MUST have at least 1 evidence source |
| 0.50-0.69 | Medium | SHOULD include `uncertaintyNote` |
| 0.30-0.49 | Low | MUST include `uncertaintyNote` |
| 0.00-0.29 | Tentative | MUST include `uncertaintyNote`, SHOULD NOT use for critical decisions |

### Conflict Severity

| Severity | Definition | Action |
|----------|------------|--------|
| `critical` | Mutually exclusive positions | MUST resolve before merge |
| `high` | Significant implementation impact | SHOULD resolve before merge |
| `medium` | Both approaches viable | MAY defer resolution |
| `low` | Minor preference differences | MAY accept either |

---

## Library Integration

The skill uses functions from `lib/contribution-protocol.sh`:

### contribution_generate_id()

Generate unique contribution ID.

```bash
source lib/contribution-protocol.sh
id=$(contribution_generate_id)
echo "$id"  # contrib_a1b2c3d4
```

### contribution_validate_task()

Validate task against contribution protocol requirements.

```bash
source lib/contribution-protocol.sh
result=$(contribution_validate_task "T2215" "T2204" "consensus-source")
echo "$result" | jq '.valid'
```

### contribution_get_injection()

Get injection block for subagent prompts.

```bash
source lib/contribution-protocol.sh
injection=$(contribution_get_injection "T2204" "claudedocs/protocol.md")
```

### contribution_create_manifest_entry()

Create a contribution manifest entry.

```bash
source lib/contribution-protocol.sh
entry=$(contribution_create_manifest_entry \
  "$CLEO_SESSION" \
  "T2204" \
  "T2215" \
  "opus-1"
)
echo "$entry" | jq '.'
```

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Execution Sequence

1. Read task: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. Start task: `{{TASK_START_CMD}} {{TASK_ID}}` (if not already started)
3. Create/load contribution JSON
4. Document decisions with evidence
5. Check for conflicts with baseline
6. Submit contribution to manifest
7. Complete task: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
8. Return summary message

---

## Directory Structure

```
.cleo/contributions/
├── CONTRIBUTIONS.jsonl      # Append-only manifest
├── T2204.json              # Individual contribution files
├── T2205.json
└── archive/                # Completed epic contributions
    └── T1000/
        ├── CONTRIBUTIONS.jsonl
        └── *.json
```

---

## Manifest Query Patterns

### All contributions for an epic

```bash
jq -s '[.[] | select(.epicId == "T2204")]' .cleo/contributions/CONTRIBUTIONS.jsonl
```

### Contributions with conflicts

```bash
jq -s '[.[] | select(.conflictCount > 0)]' .cleo/contributions/CONTRIBUTIONS.jsonl
```

### Latest contribution for a task

```bash
jq -s '[.[] | select(.taskId == "T2215")] | sort_by(.updatedAt) | .[-1]' .cleo/contributions/CONTRIBUTIONS.jsonl
```

### Summary statistics

```bash
jq -s '{
  total: length,
  complete: [.[] | select(.status == "complete")] | length,
  partial: [.[] | select(.status == "partial")] | length,
  blocked: [.[] | select(.status == "blocked")] | length,
  totalConflicts: [.[].conflictCount] | add
}' .cleo/contributions/CONTRIBUTIONS.jsonl
```

---

## Completion Checklist

- [ ] Epic exists and is active
- [ ] Contribution task created with correct parent and label
- [ ] Task started
- [ ] Contribution JSON created with valid schema
- [ ] All decisions include rationale and evidence
- [ ] Low confidence decisions include uncertainty notes
- [ ] Conflicts with baseline documented
- [ ] Contribution submitted to manifest
- [ ] Task completed

---

## Error Handling

### Validation Errors

| Error Code | Message | Fix |
|------------|---------|-----|
| `CONTRIB-001` | Session ID mismatch | Use active CLEO session |
| `CONTRIB-002` | Missing marker label | Add label to task |
| `CONTRIB-005` | Missing decisions | Document all key questions |
| `CONTRIB-007` | Missing rationale/evidence | Complete decision objects |
| `CONTRIB-011` | Vague answer language | Use concrete, unambiguous answers |

### Recovery Patterns

**Checksum mismatch**:
```bash
# Recompute checksum
jq 'del(._meta.checksum)' .cleo/contributions/T2215.json | sha256sum | cut -c1-16
```

**Missing baseline reference**:
```bash
# Query for prior contributions
jq -s '[.[] | select(.epicId == "T2204")] | .[0]' .cleo/contributions/CONTRIBUTIONS.jsonl
```

---

## Related Documentation

| Document | Relationship |
|----------|--------------|
| [CONTRIBUTION-FORMAT-SPEC.md](../../docs/specs/CONTRIBUTION-FORMAT-SPEC.md) | **Authoritative** for JSON format |
| [contribution.schema.json](../../schemas/contribution.schema.json) | **Authoritative** for JSON Schema |
| [CONTRIBUTION-PROTOCOL-GUIDE.md](../../docs/guides/CONTRIBUTION-PROTOCOL-GUIDE.md) | Usage guide with examples |
| [CONSENSUS-FRAMEWORK-SPEC.md](../../docs/specs/CONSENSUS-FRAMEWORK-SPEC.md) | Consensus voting thresholds |
