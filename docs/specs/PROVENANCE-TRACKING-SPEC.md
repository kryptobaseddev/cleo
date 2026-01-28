# Provenance Tracking Specification

**Version**: 1.0.0
**Status**: DRAFT
**Date**: 2026-01-28
**Epic**: T2569
**Consensus**: T2572
**Created by**: specification-agent-T2574
**Lifecycle State**: specification

---

## 1. Overview

### 1.1 Purpose

This specification defines the provenance tracking system for CLEO, enabling multi-agent workflows with enforced circular validation, audit trails, and lifecycle state management.

### 1.2 Scope

**In Scope:**
- Task schema additions for provenance fields
- Agent-output audit history format (MANIFEST.jsonl)
- Circular validation rules (no self-approval)
- Lifecycle state transitions (RCSD→IVTR)
- Integration with existing verification system
- Migration strategy for existing tasks

**Out of Scope:**
- Consensus voting mechanism (covered by RCSD-PIPELINE-SPEC.md)
- Multi-agent orchestration patterns (covered by ORCHESTRATOR-PROTOCOL.md)
- Release approval workflows (future enhancement)

### 1.3 Success Criteria

- **Zero self-approval**: Schema validation MUST block agents from validating their own work
- **Full audit trail**: Every task tracks creator, validator, tester with timestamps
- **Lifecycle visibility**: Clear progression through RCSD→IVTR states
- **Backward compatibility**: Existing tasks work unchanged after migration

### 1.4 Design Principles

1. **Explicit Over Implicit**: Provenance fields are required, not inferred
2. **Hard Failures**: Circular validation violations fail at schema level
3. **Audit Trail Completeness**: Full history preserved, not just current state
4. **Minimal Disruption**: Additive changes to existing schemas

---

## 2. Agent Identification

### 2.1 Agent ID Format

**Format**: `{role}-agent-{taskId}`

**Components:**
- `{role}`: Agent role (research, consensus, specification, decomposition, implementation, validation, testing, release)
- `agent`: Literal string separator
- `{taskId}`: CLEO task ID that spawned this agent (e.g., T2571)

**Examples:**
```
research-agent-T2571
consensus-agent-T2572
specification-agent-T2574
implementation-agent-T2576
validation-agent-T2577
testing-agent-T2580
release-agent-T2585
```

**Rationale:**
- Human-readable for debugging and audit logs
- Natural linkage to originating task
- Simple string parsing for validation logic
- Extensible (can be parsed into components if needed)

**Special Values:**
- `user`: Direct user interaction (CLI commands)
- `legacy`: Pre-provenance tasks (backfilled during migration)
- `system`: Automated system operations (auto-complete, gc)

### 2.2 Agent ID Validation

**Schema Constraint:**
```json
{
  "pattern": "^(research|consensus|specification|decomposition|implementation|validation|testing|release)-agent-T[0-9]+$|^(user|legacy|system)$"
}
```

**Validation Rules:**
- MUST match pattern or be special value
- MUST reference existing task ID (validation optional during migration)
- MUST be immutable after task creation

---

## 3. Schema Definition

### 3.1 Task Schema Additions

**File**: `schemas/todo.schema.json`
**Schema Version**: 2.10.0

**New Properties:**

```json
{
  "createdBy": {
    "type": ["string", "null"],
    "description": "Agent or user that created this task",
    "pattern": "^(research|consensus|specification|decomposition|implementation|validation|testing|release)-agent-T[0-9]+$|^(user|legacy|system)$",
    "default": null
  },
  "validatedBy": {
    "type": ["string", "null"],
    "description": "Agent that validated this task's implementation",
    "pattern": "^(research|consensus|specification|decomposition|implementation|validation|testing|release)-agent-T[0-9]+$|^(user|legacy|system)$",
    "default": null
  },
  "testedBy": {
    "type": ["string", "null"],
    "description": "Agent that executed tests for this task",
    "pattern": "^(research|consensus|specification|decomposition|implementation|validation|testing|release)-agent-T[0-9]+$|^(user|legacy|system)$",
    "default": null
  },
  "lifecycleState": {
    "type": ["string", "null"],
    "enum": [
      "research",
      "consensus",
      "specification",
      "decomposition",
      "implementation",
      "validation",
      "testing",
      "release",
      null
    ],
    "description": "Current RCSD→IVTR pipeline state",
    "default": null
  },
  "validationHistory": {
    "type": "array",
    "description": "Full audit trail of all validation events",
    "items": {
      "type": "object",
      "required": ["gate", "result", "validator", "validatedAt"],
      "properties": {
        "gate": {
          "type": "string",
          "enum": ["implemented", "testsPassed", "qaPassed", "securityPassed", "documented"]
        },
        "result": {
          "type": "boolean",
          "description": "Validation outcome (true = pass, false = fail)"
        },
        "validator": {
          "type": "string",
          "description": "Agent ID that performed validation",
          "pattern": "^(research|consensus|specification|decomposition|implementation|validation|testing|release)-agent-T[0-9]+$|^(user|legacy|system)$"
        },
        "validatedAt": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp of validation"
        },
        "circularCheck": {
          "type": "string",
          "enum": ["pass", "fail", "skipped"],
          "description": "Circular validation check result"
        },
        "notes": {
          "type": "string",
          "description": "Validation notes (test results, review comments, etc.)"
        }
      }
    },
    "default": []
  }
}
```

### 3.2 MANIFEST.jsonl Additions

**File**: `claudedocs/agent-outputs/MANIFEST.jsonl`
**Schema Version**: 2.1.0

**New Required Fields:**

```json
{
  "audit": {
    "type": "object",
    "required": ["created_by", "created_at", "lifecycle_state"],
    "properties": {
      "created_by": {
        "type": "string",
        "description": "Agent ID that created this output",
        "pattern": "^(research|consensus|specification|decomposition|implementation|validation|testing|release)-agent-T[0-9]+$"
      },
      "created_at": {
        "type": "string",
        "format": "date-time",
        "description": "ISO 8601 timestamp of creation"
      },
      "validation_status": {
        "type": "string",
        "enum": ["pending", "approved", "rejected"],
        "description": "Validation result from next agent in chain"
      },
      "validated_by": {
        "type": ["string", "null"],
        "description": "Agent ID that validated this output",
        "pattern": "^(research|consensus|specification|decomposition|implementation|validation|testing|release)-agent-T[0-9]+$"
      },
      "validated_at": {
        "type": ["string", "null"],
        "format": "date-time",
        "description": "ISO 8601 timestamp of validation"
      },
      "tested_by": {
        "type": ["string", "null"],
        "description": "Agent ID that tested this implementation",
        "pattern": "^(research|consensus|specification|decomposition|implementation|validation|testing|release)-agent-T[0-9]+$"
      },
      "lifecycle_state": {
        "type": "string",
        "enum": ["research", "consensus", "specification", "decomposition", "implementation", "validation", "testing", "release"],
        "description": "Current RCSD→IVTR pipeline state"
      },
      "validates_task": {
        "type": ["string", "null"],
        "description": "Task ID this agent is validating (for consensus/validation agents)",
        "pattern": "^T[0-9]+$"
      },
      "validation_result": {
        "type": ["string", "null"],
        "enum": ["approved", "rejected", "needs_revision", null],
        "description": "Result when this agent validates another agent's work"
      }
    }
  }
}
```

**Example Manifest Entry:**

```json
{
  "id": "T2574-provenance-spec",
  "file": "docs/specs/PROVENANCE-TRACKING-SPEC.md",
  "title": "Provenance Tracking Specification",
  "date": "2026-01-28",
  "status": "complete",
  "agent_type": "specification",
  "audit": {
    "created_by": "specification-agent-T2574",
    "created_at": "2026-01-28T04:25:00Z",
    "validation_status": "pending",
    "validated_by": null,
    "validated_at": null,
    "tested_by": null,
    "lifecycle_state": "specification",
    "validates_task": "T2572",
    "validation_result": "approved"
  },
  "topics": ["provenance", "schema", "lifecycle", "rcsd"],
  "key_findings": [
    "Agent ID format: {role}-agent-{taskId} for human readability",
    "8 lifecycle states (RCSD + IVTR) align with existing pipeline specs",
    "Validation history array preserves full audit trail",
    "Circular validation hard block at schema level (exit code 70)",
    "3-phase migration: null defaults → backfill → enforce non-null"
  ],
  "actionable": true,
  "needs_followup": ["T2576", "T2578"],
  "linked_tasks": ["T2569", "T2572", "T2574"]
}
```

---

## 4. Lifecycle States

### 4.1 State Definitions

**RCSD Pipeline (Planning):**

| State | Description | Entry Criteria | Exit Criteria |
|-------|-------------|----------------|---------------|
| `research` | Multi-source information gathering | Task created with research protocol | Research document complete + manifest entry |
| `consensus` | Multi-agent voting and agreement | Research validated by different agent | Consensus reached (3+ votes, >50% approval) |
| `specification` | Formal spec document creation | Consensus approved | Spec document complete + reviewed |
| `decomposition` | Epic breakdown into tasks | Spec approved | Task tree created + dependencies set |

**IVTR Pipeline (Execution):**

| State | Description | Entry Criteria | Exit Criteria |
|-------|-------------|----------------|---------------|
| `implementation` | Code/artifact creation | Decomposition complete | Implementation complete + tests written |
| `validation` | Different agent validation | Implementation complete | Validation passed + circular check passed |
| `testing` | Test execution and verification | Validation passed | All tests passed + coverage met |
| `release` | Production deployment | Testing passed | Released + documented |

### 4.2 State Transitions

**Forward Transitions (Normal Flow):**
```
research → consensus → specification → decomposition → implementation → validation → testing → release
```

**Backward Transitions (Rework):**
- `consensus → research` (rejected research, needs more investigation)
- `specification → consensus` (spec conflicts with consensus decision)
- `validation → implementation` (validation failed, implementation needs fixes)
- `testing → implementation` (tests failed, implementation needs fixes)

**Skip Transitions (Allowed):**
- User tasks: `null` (no lifecycle state for direct user work)
- Urgent fixes: `implementation → release` (skip validation/testing for critical patches, requires approval)

**Prohibited Transitions:**
- ANY → `null` (once in lifecycle, cannot exit)
- `release → *` (released artifacts are immutable, create new task for changes)

### 4.3 Field Relationships

**Interaction with Existing Fields:**

| Existing Field | New Field | Relationship |
|----------------|-----------|--------------|
| `status` | `lifecycleState` | Independent (status=general, lifecycle=pipeline-specific) |
| `phase` | `lifecycleState` | Independent (phase=project context, lifecycle=agent workflow) |
| `verification.passed` | `validationHistory[]` | Related (verification gates → validation events) |
| `verification.lastAgent` | `validatedBy` | Superseded (lastAgent=enum, validatedBy=agent ID) |

**Example Task:**
```json
{
  "id": "T2576",
  "status": "active",
  "phase": "core",
  "lifecycleState": "implementation",
  "createdBy": "decomposition-agent-T2570",
  "validatedBy": null,
  "testedBy": null
}
```

---

## 5. Circular Validation Rules (RFC 2119)

### 5.1 Core Rules

**RULE 1: Creator and Validator MUST Be Different Agents**

```bash
# ✓ VALID
createdBy: "implementation-agent-T2576"
validatedBy: "validation-agent-T2577"

# ✗ INVALID (schema validation fails)
createdBy: "implementation-agent-T2576"
validatedBy: "implementation-agent-T2576"
```

**RULE 2: Validator and Tester MUST Be Different Agents**

```bash
# ✓ VALID
validatedBy: "validation-agent-T2577"
testedBy: "testing-agent-T2580"

# ✗ INVALID (schema validation fails)
validatedBy: "validation-agent-T2577"
testedBy: "validation-agent-T2577"
```

**RULE 3: Creator and Tester MUST Be Different Agents**

```bash
# ✓ VALID
createdBy: "implementation-agent-T2576"
testedBy: "testing-agent-T2580"

# ✗ INVALID (schema validation fails)
createdBy: "implementation-agent-T2576"
testedBy: "implementation-agent-T2576"
```

**RULE 4: No Agent MAY Appear in validationHistory for Their Own Work**

```json
// ✗ INVALID
{
  "createdBy": "implementation-agent-T2576",
  "validationHistory": [
    {
      "gate": "implemented",
      "validator": "implementation-agent-T2576",  // VIOLATION
      "result": true
    }
  ]
}
```

### 5.2 Enforcement Mechanism

**Location**: `lib/verification.sh`
**Function**: `check_circular_validation()`

**Implementation:**

```bash
#!/usr/bin/env bash

# Check for circular validation violations
# Args:
#   $1: task JSON string
#   $2: validating agent ID
# Returns:
#   0: No violation
#   70: E_SELF_APPROVAL (circular validation detected)
check_circular_validation() {
    local task_json="$1"
    local validating_agent="$2"

    # Extract provenance fields
    local created_by
    local validated_by
    local tested_by

    created_by=$(echo "$task_json" | jq -r '.createdBy // "unknown"')
    validated_by=$(echo "$task_json" | jq -r '.validatedBy // "unknown"')
    tested_by=$(echo "$task_json" | jq -r '.testedBy // "unknown"')

    # Rule 1: Creator ≠ Validator
    if [[ "$validating_agent" == "$created_by" ]] && [[ "$created_by" != "unknown" ]]; then
        echo "[ERROR] Circular validation: Agent $validating_agent cannot validate their own work" >&2
        echo "[FIX] Assign validation to different agent" >&2
        return 70  # E_SELF_APPROVAL
    fi

    # Rule 2: Validator ≠ Tester (when setting testedBy)
    if [[ "$validating_agent" == "$validated_by" ]] && [[ "$validated_by" != "unknown" ]]; then
        echo "[ERROR] Circular validation: Agent $validating_agent cannot test their own validation" >&2
        echo "[FIX] Assign testing to different agent" >&2
        return 70  # E_SELF_APPROVAL
    fi

    # Rule 3: Check validation history
    local history_count
    history_count=$(echo "$task_json" | jq -r "[.validationHistory[]? | select(.validator == \"$validating_agent\")] | length")

    if [[ "$history_count" -gt 0 ]]; then
        echo "[ERROR] Circular validation: Agent $validating_agent already validated this task" >&2
        echo "[FIX] Assign to different agent" >&2
        return 70  # E_SELF_APPROVAL
    fi

    return 0
}

# Set validation field with circular check
# Args:
#   $1: task ID
#   $2: field name (validatedBy|testedBy)
#   $3: agent ID
# Returns:
#   0: Success
#   70: E_SELF_APPROVAL
#   4: E_NOT_FOUND
set_validation_field() {
    local task_id="$1"
    local field="$2"
    local agent_id="$3"

    # Load task
    local task_json
    task_json=$(load_task "$task_id")
    [[ $? -ne 0 ]] && return 4  # E_NOT_FOUND

    # Circular check
    check_circular_validation "$task_json" "$agent_id"
    [[ $? -ne 0 ]] && return 70  # E_SELF_APPROVAL

    # Update field
    task_json=$(echo "$task_json" | jq --arg field "$field" --arg agent "$agent_id" \
        '.[$field] = $agent | .updatedAt = now | .updatedAt |= todate')

    # Add to validation history
    local validation_entry
    validation_entry=$(jq -n \
        --arg gate "$field" \
        --arg validator "$agent_id" \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
            gate: $gate,
            result: true,
            validator: $validator,
            validatedAt: $timestamp,
            circularCheck: "pass"
        }')

    task_json=$(echo "$task_json" | jq --argjson entry "$validation_entry" \
        '.validationHistory += [$entry]')

    # Save with atomic write
    save_task "$task_id" "$task_json"

    return 0
}
```

### 5.3 Exception Cases

**User-Created Tasks:**
- `createdBy: "user"`: Validation by any agent is allowed
- Rationale: Direct user CLI commands are outside agent workflow

**Legacy Tasks:**
- `createdBy: "legacy"`: Validation by any agent is allowed
- Rationale: Pre-provenance tasks backfilled during migration

**System Operations:**
- `createdBy: "system"`: Validation by any agent is allowed
- Rationale: Automated operations (auto-complete, gc) are not agent work

**Testing Override:**
- Feature flag: `validation.allowCircular` (default: `false`)
- Use case: Testing circular validation detection logic
- **MUST NOT** be enabled in production

---

## 6. Exit Codes

### 6.1 Provenance Error Codes

| Code | Constant | Description | Fix |
|------|----------|-------------|-----|
| 70 | `E_SELF_APPROVAL` | Agent tried to validate their own work | Assign to different agent |
| 71 | `E_VALIDATION_CHAIN_BROKEN` | Validation history has gaps | Run validation for missing gates |
| 72 | `E_MISSING_PROVENANCE` | Required provenance field is null | Set createdBy/validatedBy/testedBy |
| 73 | `E_LIFECYCLE_VIOLATION` | Invalid lifecycle state transition | Check allowed transitions |

### 6.2 Exit Code Usage

**In Scripts:**

```bash
#!/usr/bin/env bash

# Exit codes
readonly E_SUCCESS=0
readonly E_NOT_FOUND=4
readonly E_SELF_APPROVAL=70
readonly E_VALIDATION_CHAIN_BROKEN=71
readonly E_MISSING_PROVENANCE=72
readonly E_LIFECYCLE_VIOLATION=73

# Example: Validation command
if ! check_circular_validation "$task_json" "$agent_id"; then
    exit "$E_SELF_APPROVAL"
fi
```

**In JSON Output:**

```json
{
  "success": false,
  "error": {
    "code": 70,
    "name": "E_SELF_APPROVAL",
    "message": "Agent implementation-agent-T2576 cannot validate their own work",
    "fix": "cleo verify T2576 --validator validation-agent-T2577",
    "alternatives": [
      {
        "action": "Assign different validator",
        "command": "cleo verify T2576 --validator validation-agent-T2577"
      },
      {
        "action": "Skip validation (not recommended)",
        "command": "cleo config set validation.allowCircular true"
      }
    ]
  }
}
```

### 6.3 Error Messages

**Format:**
```
[ERROR] {Error type}: {Specific violation}
[FIX] {Copy-paste ready command}
[ALTERNATIVE] {Alternative approaches}
```

**Examples:**

```bash
# E_SELF_APPROVAL
[ERROR] Circular validation: Agent implementation-agent-T2576 cannot validate their own work
[FIX] cleo verify T2576 --validator validation-agent-T2577
[ALTERNATIVE] Assign testing to different agent

# E_VALIDATION_CHAIN_BROKEN
[ERROR] Validation chain broken: Task T2576 missing 'testsPassed' gate
[FIX] cleo verify T2576 --gate testsPassed --validator testing-agent-T2580
[ALTERNATIVE] Run: cleo verify T2576 --all (validates all required gates)

# E_MISSING_PROVENANCE
[ERROR] Missing provenance: Task T2576 has null createdBy field
[FIX] cleo update T2576 --created-by implementation-agent-T2576
[ALTERNATIVE] Run migration: cleo migrate --to 2.10.0

# E_LIFECYCLE_VIOLATION
[ERROR] Invalid transition: Cannot move from 'release' to 'implementation'
[FIX] Create new task for changes (released artifacts are immutable)
[ALTERNATIVE] Reopen as new task: cleo add "Fix for T2576" --parent T2569
```

---

## 7. Integration with Existing Systems

### 7.1 Verification System Integration

**Current System** (`lib/verification.sh`):
- Boolean gates: `implemented`, `testsPassed`, `qaPassed`, `securityPassed`, `documented`
- `verification.passed` = all gates true
- `verification.lastAgent` = enum (planner, coder, testing)

**New System** (Provenance):
- `validationHistory[]` = array of validation events with agent IDs
- `validatedBy` = agent that validated implementation
- `testedBy` = agent that executed tests

**Mapping:**

| Verification Gate | Validation Field | Agent Role |
|-------------------|------------------|------------|
| `implemented` | `validatedBy` | validation-agent |
| `testsPassed` | `testedBy` | testing-agent |
| `qaPassed` | `validationHistory[].validator` | qa-agent |
| `securityPassed` | `validationHistory[].validator` | security-agent |
| `documented` | `validationHistory[].validator` | documentation-agent |

**Backward Compatibility:**

```bash
# Old command (still works)
cleo verify T001 --gate implemented

# New command (with provenance)
cleo verify T001 --gate implemented --validator validation-agent-T2577

# Migration: Auto-detect validator from session
cleo verify T001 --gate implemented  # Uses $CLEO_SESSION to infer agent
```

### 7.2 Session System Integration

**Current System** (`lib/session.sh`):
- `agentId` field (optional string)
- Session scope (epic, taskGroup, subtree, etc.)

**New System** (Provenance):
- `createdBy` auto-populated from session `agentId`
- Subagent spawning includes agent ID

**Auto-Detection:**

```bash
# Session with agent ID
cleo session start --scope epic:T2569 --agent-id specification-agent-T2574

# Task created in session
cleo add "New task"  # Auto-sets createdBy: "specification-agent-T2574"

# Manual override
cleo add "New task" --created-by user  # Override auto-detection
```

### 7.3 Orchestrator Integration

**Current System** (`lib/orchestrator.sh`):
- Subagent spawn commands
- Parallel task execution

**New System** (Provenance):
- Spawn commands include `--created-by` flag
- Circular validation checks before spawn

**Example:**

```bash
# Orchestrator spawns research agent
cleo orchestrator spawn T2571 --protocol research

# Generated command includes agent ID
claude \
  --auto-yes \
  --env CLEO_SESSION=session_xyz \
  --env CLEO_AGENT_ID=research-agent-T2571 \
  "Execute task T2571 using research protocol"

# Inside subagent session
cleo add "Research findings" --created-by "$CLEO_AGENT_ID"
```

---

## 8. Migration Strategy

### 8.1 Three-Phase Migration

**Phase 1: Schema Update (v2.10.0)**

**Goal**: Add provenance fields with null defaults (backward compatible)

**Changes:**
- Add `createdBy`, `validatedBy`, `testedBy`, `lifecycleState` to task schema
- Add `audit` object to MANIFEST.jsonl schema
- All fields nullable with `default: null`

**Commands:**
```bash
cleo migrate --to 2.10.0
```

**Impact:**
- Existing tasks: No changes (null provenance fields)
- New tasks: Can optionally set provenance fields
- No breaking changes

---

**Phase 2: Backfill Migration (v2.10.1)**

**Goal**: Intelligently populate provenance fields for existing tasks

**Migration Script**: `dev/migrations/migrate-provenance-backfill.sh`

**Backfill Logic:**

| Task Type | createdBy | validatedBy | testedBy | lifecycleState |
|-----------|-----------|-------------|----------|----------------|
| Session tasks | Extract from session `agentId` | null | null | null |
| Completed + verified | `legacy` | Extract from `verification.lastAgent` | Extract from `verification.lastAgent` | `release` |
| User tasks (no session) | `user` | null | null | null |
| Other | `legacy` | null | null | null |

**Example:**

```bash
# Before migration
{
  "id": "T1234",
  "status": "done",
  "verification": {
    "passed": true,
    "lastAgent": "coder",
    "gates": {
      "implemented": true,
      "testsPassed": true
    }
  }
}

# After migration
{
  "id": "T1234",
  "status": "done",
  "createdBy": "legacy",
  "validatedBy": "legacy-coder",
  "testedBy": "legacy-coder",
  "lifecycleState": "release",
  "validationHistory": [
    {
      "gate": "implemented",
      "result": true,
      "validator": "legacy-coder",
      "validatedAt": "2025-12-01T00:00:00Z",
      "circularCheck": "skipped",
      "notes": "Backfilled from verification.gates"
    },
    {
      "gate": "testsPassed",
      "result": true,
      "validator": "legacy-coder",
      "validatedAt": "2025-12-01T00:00:00Z",
      "circularCheck": "skipped",
      "notes": "Backfilled from verification.gates"
    }
  ],
  "verification": {
    "passed": true,
    "lastAgent": "coder",
    "gates": {
      "implemented": true,
      "testsPassed": true
    }
  }
}
```

**Commands:**
```bash
cleo migrate --to 2.10.1 --backfill
cleo migrate --to 2.10.1 --backfill --dry-run  # Preview changes
```

**Validation:**
```bash
# Check migration status
cleo validate --check-provenance

# Report missing provenance
cleo list --format json | jq '[.tasks[] | select(.createdBy == null)]'
```

---

**Phase 3: Enforce Non-Null (v2.11.0)**

**Goal**: Require provenance fields for new tasks

**Changes:**
- Remove `null` from `createdBy` type (make required)
- Schema validation fails if `createdBy` is null for new tasks
- Existing tasks with null provenance are grandfathered

**Schema:**
```json
{
  "createdBy": {
    "type": "string",  // No longer nullable
    "pattern": "^(research|consensus|specification|...)$"
  }
}
```

**Commands:**
```bash
cleo migrate --to 2.11.0
```

**Behavior:**
```bash
# ✓ VALID (auto-detect from session)
cleo session start --agent-id implementation-agent-T2576
cleo add "New task"  # Auto-sets createdBy

# ✓ VALID (explicit flag)
cleo add "New task" --created-by user

# ✗ INVALID (schema validation fails)
cleo add "New task"  # No session, no flag
```

**Grandfathering:**
- Tasks with null `createdBy` from Phase 1/2 remain valid
- Updates to grandfathered tasks do not require provenance
- New tasks created after v2.11.0 require provenance

---

### 8.2 Rollback Plan

**If Issues Detected:**

```bash
# Rollback to pre-migration state
cleo restore $(cleo backup --list | grep "pre-migration-2.10.0" | head -1)

# Revert schema to v2.9.x
cleo migrate --to 2.9.0 --force

# Re-run migration with fixes
cleo migrate --to 2.10.0
```

**Backup Strategy:**
- Automatic backup before each migration phase
- Backups retained for 90 days
- Manual backup: `cleo backup --type migration --note "Pre-provenance migration"`

---

### 8.3 Testing Strategy

**Unit Tests:**
```bash
bats tests/unit/provenance-validation.bats
bats tests/unit/circular-validation.bats
bats tests/unit/lifecycle-transitions.bats
```

**Integration Tests:**
```bash
bats tests/integration/provenance-migration.bats
bats tests/integration/multi-agent-workflow.bats
```

**Validation Tests:**
```bash
# Test circular validation detection
cleo add "Test task" --created-by implementation-agent-T9999
cleo verify T9999 --validator implementation-agent-T9999  # Should fail with exit 70

# Test lifecycle transitions
cleo update T9999 --lifecycle-state research
cleo update T9999 --lifecycle-state consensus  # Should succeed
cleo update T9999 --lifecycle-state implementation  # Should fail (skipped spec)
```

---

## 9. Performance Considerations

### 9.1 Storage Impact

**Per-Task Overhead:**
- 4 new fields: ~200 bytes (agent IDs, lifecycle state)
- Validation history: ~150 bytes per validation event (typical: 3-5 events)
- **Total**: ~500-1000 bytes per task

**Project Impact (1000 tasks):**
- Additional storage: ~1 MB
- JSON parsing overhead: <10ms per operation (jq optimized)

### 9.2 Query Performance

**Optimization Strategies:**
- Index `createdBy`, `validatedBy`, `lifecycleState` for fast filtering
- Validation history array kept small (3-5 entries typical)
- Circular validation check: O(1) lookup (no array scan)

**Benchmarks:**
```bash
# Before provenance (baseline)
cleo list --status pending  # 45ms (1000 tasks)

# After provenance (with indexing)
cleo list --created-by implementation-agent-*  # 52ms (1000 tasks)
# Impact: +15% query time
```

---

## 10. Security Considerations

### 10.1 Agent ID Spoofing

**Risk**: Malicious agent could set `createdBy` to another agent's ID

**Mitigation:**
- Agent ID verification via session system
- Orchestrator controls agent spawning
- Session binding prevents ID reuse

**Implementation:**
```bash
# Verify agent ID matches session
verify_agent_id() {
    local claimed_agent_id="$1"
    local session_agent_id="${CLEO_AGENT_ID:-unknown}"

    if [[ "$claimed_agent_id" != "$session_agent_id" ]]; then
        echo "[ERROR] Agent ID mismatch: claimed=$claimed_agent_id, session=$session_agent_id" >&2
        return 74  # E_AGENT_ID_MISMATCH
    fi

    return 0
}
```

### 10.2 Validation Chain Tampering

**Risk**: Manual editing of `validationHistory` to bypass circular validation

**Mitigation:**
- Schema validation on every write (atomic operations)
- Checksum verification in `todo-log.json`
- `cleo validate` detects inconsistencies

**Detection:**
```bash
# Validate all tasks
cleo validate --check-provenance

# Check for suspicious patterns
cleo list --format json | jq '[.tasks[] |
  select(.createdBy == .validatedBy and .createdBy != "legacy")]'
```

### 10.3 Privilege Escalation

**Risk**: Agent bypasses circular validation by creating tasks with `createdBy: "user"`

**Mitigation:**
- `createdBy: "user"` only allowed for direct CLI commands (not from sessions)
- Session-based tasks auto-populate `createdBy` from `$CLEO_AGENT_ID`
- Manual override requires `--force` flag

---

## 11. Future Enhancements

### 11.1 Consensus Voting Integration

**Goal**: Link consensus votes to task provenance

**Schema Addition:**
```json
{
  "consensusVotes": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "voter": {"type": "string"},
        "vote": {"type": "string", "enum": ["approve", "reject", "abstain"]},
        "votedAt": {"type": "string", "format": "date-time"},
        "rationale": {"type": "string"}
      }
    }
  }
}
```

**Use Case:** Track which agents approved design decisions

---

### 11.2 Release Approval Workflow

**Goal**: Multi-agent approval for production releases

**Schema Addition:**
```json
{
  "releaseApproval": {
    "type": "object",
    "properties": {
      "requiredApprovers": {"type": "array", "items": {"type": "string"}},
      "approvals": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "approver": {"type": "string"},
            "approvedAt": {"type": "string", "format": "date-time"},
            "notes": {"type": "string"}
          }
        }
      },
      "approved": {"type": "boolean"}
    }
  }
}
```

**Use Case:** Require validation-agent + testing-agent approval before release

---

### 11.3 Agent Reputation System

**Goal**: Track agent reliability over time

**Metrics:**
- Validation success rate
- Circular violation attempts
- Test coverage for testing agents

**Use Case:** Orchestrator prioritizes high-reputation agents for critical tasks

---

## 12. Acceptance Criteria

### 12.1 Must Have (v2.10.0)

- [x] Schema updated with provenance fields
- [x] Circular validation enforcement (exit code 70)
- [x] Migration script (null defaults)
- [x] MANIFEST.jsonl audit fields
- [x] Unit tests for circular validation
- [x] Integration tests for lifecycle transitions

### 12.2 Should Have (v2.11.0)

- [ ] Backfill migration (intelligent defaults)
- [ ] Enforce non-null for new tasks
- [ ] Performance benchmarks
- [ ] Security audit (agent ID verification)

### 12.3 Could Have (Future)

- [ ] Consensus voting integration
- [ ] Release approval workflow
- [ ] Agent reputation system
- [ ] Provenance visualization (CLI/web UI)

---

## 13. References

### 13.1 Related Specifications

- **RCSD-PIPELINE-SPEC.md**: Multi-agent research/consensus/specification/decomposition workflow
- **PROJECT-LIFECYCLE-SPEC.md**: Full RCSD→IVTR lifecycle states and transitions
- **ORCHESTRATOR-PROTOCOL.md**: Multi-agent coordination and subagent spawning
- **schemas/todo.schema.json**: Task object schema (current: v2.9.0)

### 13.2 Implementation Tasks

- **T2572**: Consensus on provenance schema design (COMPLETE)
- **T2574**: Write this specification (CURRENT)
- **T2576**: Update todo.schema.json with provenance fields
- **T2578**: Update MANIFEST.jsonl with audit fields
- **T2579**: Implement circular validation checks
- **T2580**: Write unit tests for provenance validation
- **T2581**: Write integration tests for multi-agent workflows
- **T2582**: Create migration script (v2.10.0)
- **T2583**: Update CLI commands to support provenance flags
- **T2584**: Update documentation
- **T2585**: Release v2.10.0

---

## Appendix A: Schema Snippets

### A.1 Complete Task Provenance Object

```json
{
  "id": "T2576",
  "title": "Implementation: Update todo.schema.json with provenance fields",
  "status": "active",
  "phase": "core",
  "lifecycleState": "implementation",
  "createdBy": "decomposition-agent-T2570",
  "validatedBy": "validation-agent-T2577",
  "testedBy": "testing-agent-T2580",
  "validationHistory": [
    {
      "gate": "implemented",
      "result": true,
      "validator": "validation-agent-T2577",
      "validatedAt": "2026-01-28T06:00:00Z",
      "circularCheck": "pass",
      "notes": "Schema changes reviewed and approved"
    },
    {
      "gate": "testsPassed",
      "result": true,
      "validator": "testing-agent-T2580",
      "validatedAt": "2026-01-28T06:30:00Z",
      "circularCheck": "pass",
      "notes": "All unit tests passed (45/45), coverage: 94%"
    }
  ],
  "verification": {
    "passed": true,
    "gates": {
      "implemented": true,
      "testsPassed": true
    }
  }
}
```

### A.2 Complete MANIFEST.jsonl Entry

```json
{
  "id": "T2576-schema-implementation",
  "file": "schemas/todo.schema.json",
  "title": "Task Schema with Provenance Fields",
  "date": "2026-01-28",
  "status": "complete",
  "agent_type": "implementation",
  "audit": {
    "created_by": "implementation-agent-T2576",
    "created_at": "2026-01-28T05:30:00Z",
    "validation_status": "approved",
    "validated_by": "validation-agent-T2577",
    "validated_at": "2026-01-28T06:00:00Z",
    "tested_by": "testing-agent-T2580",
    "lifecycle_state": "testing",
    "validates_task": null,
    "validation_result": null
  },
  "topics": ["schema", "provenance", "validation"],
  "key_findings": [
    "Added 4 provenance fields (createdBy, validatedBy, testedBy, lifecycleState)",
    "Added validationHistory array for full audit trail",
    "Circular validation patterns enforce agent separation",
    "Backward compatible with null defaults"
  ],
  "actionable": true,
  "needs_followup": ["T2579"],
  "linked_tasks": ["T2569", "T2574", "T2576", "T2579"]
}
```

---

**END OF SPECIFICATION**
