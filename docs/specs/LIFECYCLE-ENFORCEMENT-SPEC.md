# Lifecycle Enforcement Specification

**Version**: 1.0.0
**Status**: DRAFT
**Date**: 2026-01-28
**Epic**: T2569 - EPIC: Provenance & Lifecycle Enforcement System
**Consensus Validated**: T2572 (Task Provenance), T2573 (MANIFEST Audit)
**Lifecycle State**: specification
**Created By**: specification-agent-T2575
**Must Be Validated By**: implementation-agent

---

## 1. RCSD→IVTR Pipeline Definition

### 1.1 Complete Lifecycle States

The CLEO lifecycle enforces an 8-state pipeline combining Research-Consensus-Specification-Decomposition (RCSD) with Implementation-Validation-Testing-Release (IVTR):

| State | Purpose | Agent Type | Output |
|-------|---------|-----------|--------|
| **research** | Multi-source information gathering | research-agent | Research document + evidence |
| **consensus** | Multi-agent voting and agreement | consensus-agent | Consensus decisions + validation |
| **specification** | Formal spec document creation | specification-agent | Technical specification |
| **decomposition** | Epic breakdown into tasks | decomposition-agent | Task structure + dependencies |
| **implementation** | Code/artifact creation | implementation-agent | Code + tests + docs |
| **validation** | Different-agent validation | validation-agent | Validation report + approval |
| **testing** | Test execution and verification | testing-agent | Test results + coverage |
| **release** | Production deployment | release-agent | Release notes + artifacts |

### 1.2 State Transitions

**Linear Progression** (standard path):
```
research → consensus → specification → decomposition → implementation → validation → testing → release
```

**Allowed Skips** (with warning):
- research → specification (skip consensus for single-agent work)
- specification → implementation (skip decomposition for single-task specs)
- implementation → testing (skip validation if self-tested)

**Blocked Transitions** (hard fail):
- Backward transitions (e.g., specification → consensus)
- Skipping RCSD entry point (must start at research or specification)
- Skipping validation + testing (at least one verification stage required)

### 1.3 Schema Definition

**Task Schema** (`schemas/todo.schema.json` v2.10.0+):
```json
{
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
    "description": "RCSD→IVTR pipeline state. Null for user-created tasks not in pipeline."
  }
}
```

**MANIFEST Schema** (`schemas/manifest.schema.json` v1.0.0+):
```json
{
  "audit": {
    "type": "object",
    "required": ["created_by", "created_at", "validation_status", "lifecycle_state"],
    "properties": {
      "lifecycle_state": {
        "type": "string",
        "enum": [
          "research",
          "consensus",
          "specification",
          "decomposition",
          "implementation",
          "validation",
          "testing",
          "release"
        ]
      }
    }
  }
}
```

---

## 2. Gate Requirements

### 2.1 Entry Gates (Stage Prerequisites)

Each stage requires validation of previous stage output:

| Stage | Entry Gate | Validation Required |
|-------|-----------|---------------------|
| **consensus** | Research document exists | Different agent must validate research findings |
| **specification** | Consensus decisions finalized | Different agent must validate consensus votes |
| **decomposition** | Specification approved | Different agent must validate spec completeness |
| **implementation** | Task structure defined | Different agent must validate task breakdown |
| **validation** | Code/artifacts complete | Different agent must review implementation |
| **testing** | Validation passed | Different agent must execute test suite |
| **release** | Tests passed | Different agent must approve release readiness |

### 2.2 Exit Gates (Stage Completion)

Each stage produces required outputs before progression:

| Stage | Exit Gate | Required Outputs |
|-------|-----------|------------------|
| **research** | Document + evidence | MANIFEST entry with `status: complete`, `agent_type: research` |
| **consensus** | Decisions + validation | MANIFEST entry with `status: complete`, `agent_type: consensus`, `audit.validated_by` set |
| **specification** | Formal spec | MANIFEST entry + spec file in `docs/specs/` |
| **decomposition** | Task structure | Tasks created with `parentId`, `depends`, `lifecycleState: implementation` |
| **implementation** | Code + tests + docs | Files committed, task `status: done`, `verification.gates.implemented: true` |
| **validation** | Approval report | MANIFEST entry with `audit.validation_status: approved` |
| **testing** | Test results | MANIFEST entry with `status: complete`, `verification.gates.testsPassed: true` |
| **release** | Deployment complete | Release tag, changelog, `lifecycleState: release` |

### 2.3 Gate Enforcement Rules

**MUST enforce** (hard block):
1. **Entry gate validation**: Cannot enter stage without previous stage completion
2. **Circular validation prevention**: `audit.validated_by ≠ audit.created_by`
3. **Required output creation**: Cannot advance without producing stage artifacts
4. **State transition order**: Cannot skip required RCSD stages

**SHOULD warn** (soft alert):
1. **Skipped optional stages**: Consensus or decomposition skipped
2. **Single validation path**: Only validation OR testing, not both
3. **Long stage duration**: Stage active >7 days without progression

---

## 3. Audit Object Schema

### 3.1 MANIFEST.jsonl Audit Structure

Based on T2573 consensus decisions, every MANIFEST entry MUST include:

```json
{
  "id": "T2575-lifecycle-spec",
  "file": "docs/specs/LIFECYCLE-ENFORCEMENT-SPEC.md",
  "title": "Lifecycle Enforcement Specification",
  "date": "2026-01-28",
  "status": "complete",
  "agent_type": "specification",
  "audit": {
    "created_by": "specification-agent-T2575",
    "created_at": "2026-01-28T04:21:00Z",
    "validation_status": "pending",
    "validated_by": null,
    "validated_at": null,
    "tested_by": null,
    "tested_at": null,
    "lifecycle_state": "specification",
    "provenance_chain": [
      {"type": "task", "id": "T2569", "title": "EPIC: Provenance & Lifecycle Enforcement System"},
      {"type": "research", "id": "T2571-provenance-research"},
      {"type": "consensus", "id": "T2572-provenance-schema-consensus"},
      {"type": "consensus", "id": "T2573-audit-history-consensus"},
      {"type": "specification", "id": "T2575-lifecycle-spec"}
    ]
  },
  "topics": ["lifecycle", "rcsd", "ivtr", "gates", "enforcement"],
  "key_findings": [
    "8-state RCSD→IVTR pipeline with defined entry/exit gates",
    "Hard-block enforcement for circular validation and backward transitions",
    "5-state validation workflow: pending/in_review/approved/rejected/needs_revision",
    "Full provenance chain tracking for audit trail and impact analysis"
  ],
  "actionable": true,
  "needs_followup": ["T2578", "T2579"],
  "linked_tasks": ["T2569", "T2571", "T2572", "T2573", "T2575"]
}
```

### 3.2 Required Audit Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `created_by` | string | YES | Agent ID format: `{role}-agent-{taskId}` |
| `created_at` | ISO-8601 | YES | Creation timestamp (RFC 3339) |
| `validation_status` | enum | YES | One of: pending, in_review, approved, rejected, needs_revision |
| `validated_by` | string\|null | YES | Different agent ID (MUST NOT match `created_by`) |
| `validated_at` | ISO-8601\|null | YES | Validation timestamp (null if not validated) |
| `tested_by` | string\|null | YES | Testing agent ID (may match `created_by` for self-testing) |
| `tested_at` | ISO-8601\|null | YES | Testing timestamp (null if not tested) |
| `lifecycle_state` | enum | YES | Current RCSD→IVTR state |
| `provenance_chain` | array | YES | Full chain of parent tasks/entries (see 3.3) |

### 3.3 Provenance Chain Format

**Purpose**: Track complete lineage from epic → research → consensus → spec → implementation

**Structure**:
```json
{
  "provenance_chain": [
    {
      "type": "task",
      "id": "T2569",
      "title": "EPIC: Provenance & Lifecycle Enforcement System"
    },
    {
      "type": "research",
      "id": "T2571-provenance-research",
      "title": "Provenance & Lifecycle Research"
    },
    {
      "type": "consensus",
      "id": "T2572-provenance-schema-consensus",
      "title": "Task Provenance Schema Consensus"
    }
  ]
}
```

**Chain Entry Types**:
| Type | ID Format | Source |
|------|-----------|--------|
| `task` | `T####` | CLEO task ID |
| `research` | `T####-research-slug` | MANIFEST entry ID |
| `consensus` | `T####-consensus-slug` | MANIFEST entry ID |
| `specification` | `T####-spec-slug` | MANIFEST entry ID |
| `decomposition` | `T####-decomp-slug` | MANIFEST entry ID |
| `implementation` | `T####-impl-slug` | MANIFEST entry ID |
| `validation` | `T####-validation-slug` | MANIFEST entry ID |
| `testing` | `T####-testing-slug` | MANIFEST entry ID |
| `release` | `T####-release-slug` | MANIFEST entry ID |

### 3.4 Validation Status Workflow

**5-State Validation Lifecycle** (based on T2573 Decision 3):

```
pending → in_review → approved (release-eligible)
                   ↓
                needs_revision → in_review (iterative loop)
                   ↓
                rejected (terminal state)
```

**State Definitions**:
- `pending`: Not yet reviewed by different agent
- `in_review`: Under active review (may involve multi-agent consensus)
- `approved`: Validated by different agent, release-eligible
- `needs_revision`: Issues found, requires iteration
- `rejected`: Permanently archived, not usable

---

## 4. Circular Validation Protocol

### 4.1 Circular Validation Definition

**Circular validation** occurs when:
- Same agent validates their own work: `audit.validated_by == audit.created_by`
- Agent A validates Agent B, Agent B validates Agent A (2-cycle)
- Transitive validation cycles: A→B→C→A (N-cycle)

### 4.2 Detection Algorithm

**Immediate Circular Check** (1-hop):
```bash
check_circular_validation() {
    local created_by="$1"
    local validated_by="$2"

    if [[ "$validated_by" == "$created_by" ]]; then
        return 77  # E_CIRCULAR_VALIDATION_REQUIRED
    fi

    return 0
}
```

**Transitive Cycle Check** (N-hop):
```bash
check_provenance_cycle() {
    local manifest_entry="$1"
    local validating_agent="$2"

    # Extract provenance chain
    local chain
    chain=$(echo "$manifest_entry" | jq -r '.audit.provenance_chain[].id')

    # Check if validating agent created any ancestor
    for ancestor_id in $chain; do
        local ancestor_creator
        ancestor_creator=$(get_manifest_entry "$ancestor_id" | jq -r '.audit.created_by')

        if [[ "$validating_agent" == "$ancestor_creator" ]]; then
            echo "ERROR: Transitive circular validation detected" >&2
            echo "Agent $validating_agent created ancestor $ancestor_id" >&2
            return 77  # E_CIRCULAR_VALIDATION_REQUIRED
        fi
    done

    return 0
}
```

### 4.3 Enforcement Rules

**Hard Block** (based on T2572 Decision 4):
1. **Schema validation fails**: MANIFEST entries with `validated_by == created_by` rejected
2. **Exit code 77**: Commands return `E_CIRCULAR_VALIDATION_REQUIRED`
3. **Clear error message**: Show which agent and which entry violated rule
4. **No override flag**: No `--force` option (only config-level feature flag for testing)

**Exceptions** (allowed circular validation):
| Scenario | Rationale |
|----------|-----------|
| `created_by: "user"` | Human-created work can be validated by any agent |
| `created_by: "legacy"` | Pre-provenance tasks allow any validator |
| `tested_by` field | Self-testing is allowed (testing your own implementation) |

### 4.4 Validation Recording

Every validation attempt MUST be recorded in MANIFEST audit:

```json
{
  "audit": {
    "validation_status": "approved",
    "validated_by": "validation-agent-T2578",
    "validated_at": "2026-01-28T05:00:00Z",
    "circular_check": "pass"
  }
}
```

**Circular Check Values**:
- `pass`: No circular validation detected
- `fail`: Circular validation detected, validation rejected
- `override`: Admin override (requires config flag `validation.allowCircular: true`)

---

## 5. Task Schema Provenance Fields

### 5.1 Task-Level Provenance

Based on T2572 consensus decisions, task schema MUST include:

```json
{
  "createdBy": {
    "type": ["string", "null"],
    "description": "Agent or human identifier that created this task",
    "examples": ["research-agent-T2571", "user", "legacy"]
  },
  "validatedBy": {
    "type": ["string", "null"],
    "description": "Different agent that validated this work (MUST NOT match createdBy)",
    "examples": ["consensus-agent-T2572", null]
  },
  "testedBy": {
    "type": ["string", "null"],
    "description": "Agent that executed tests (may match createdBy)",
    "examples": ["testing-agent-T2577", null]
  },
  "lifecycleState": {
    "type": ["string", "null"],
    "enum": ["research", "consensus", "specification", "decomposition",
             "implementation", "validation", "testing", "release", null],
    "description": "RCSD→IVTR pipeline state (null for user-created tasks)"
  }
}
```

### 5.2 Validation History Tracking

Based on T2572 Decision 3, add to `verification` object:

```json
{
  "verification": {
    "validationHistory": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["gate", "result", "validator", "validatedAt", "circularCheck"],
        "properties": {
          "gate": {
            "type": "string",
            "enum": ["implemented", "testsPassed", "qaPassed", "cleanupDone",
                     "securityPassed", "documented"]
          },
          "result": {"type": "boolean"},
          "validator": {
            "type": "string",
            "description": "Agent ID that performed validation"
          },
          "validatedAt": {
            "type": "string",
            "format": "date-time"
          },
          "circularCheck": {
            "type": "string",
            "enum": ["pass", "fail", "override"]
          },
          "notes": {"type": "string"}
        }
      }
    }
  }
}
```

### 5.3 Agent ID Format

Based on T2572 Decision 1: **Simple String Format**

**Convention**: `{role}-agent-{taskId}`

**Examples**:
- `research-agent-T2571`
- `consensus-agent-T2572`
- `specification-agent-T2575`
- `implementation-agent-T2578`
- `validation-agent-T2580`
- `testing-agent-T2581`

**Special Values**:
- `user` - Human-created task (manual CLI usage)
- `legacy` - Pre-provenance task (migration backfill)
- `orchestrator` - Created by orchestration agent

---

## 6. Exit Codes

### 6.1 New Error Codes

| Code | Name | Condition | Fatal |
|------|------|-----------|-------|
| **75** | `E_LIFECYCLE_GATE_FAILED` | Entry gate requirements not met | YES |
| **76** | `E_AUDIT_MISSING` | Required audit fields missing | YES |
| **77** | `E_CIRCULAR_VALIDATION_REQUIRED` | Same agent validating own work | YES |
| **78** | `E_LIFECYCLE_TRANSITION_INVALID` | Invalid state transition | YES |
| **79** | `E_PROVENANCE_REQUIRED` | Missing required provenance field | YES |
| **100** | `E_AUDIT_MISSING_WARNING` | Audit fields missing (warn-only phase) | NO |

### 6.2 Exit Code Usage

**Command**: `cleo complete <task-id>`
```bash
# Check lifecycle gate before completion
if ! check_lifecycle_gate "$task_id"; then
    echo "ERROR: Cannot complete task - lifecycle gate failed" >&2
    echo "Current state: $(get_lifecycle_state "$task_id")" >&2
    echo "Required: Entry gate validation from previous stage" >&2
    exit 75  # E_LIFECYCLE_GATE_FAILED
fi
```

**Command**: `cleo research inject`
```bash
# Validate audit fields in template
if [[ "$AUDIT_ENFORCEMENT" == "strict" ]]; then
    if ! validate_audit_fields "$manifest_entry"; then
        echo "ERROR: Required audit fields missing" >&2
        exit 76  # E_AUDIT_MISSING
    fi
elif [[ "$AUDIT_ENFORCEMENT" == "warn" ]]; then
    if ! validate_audit_fields "$manifest_entry"; then
        echo "WARNING: Audit fields missing - will be required in future" >&2
        exit 100  # E_AUDIT_MISSING_WARNING (non-fatal)
    fi
fi
```

**Command**: `cleo verify <task-id> --validator <agent-id>`
```bash
# Check circular validation
if ! check_circular_validation "$created_by" "$validator_agent"; then
    echo "ERROR: Circular validation detected" >&2
    echo "Agent $validator_agent cannot validate work created by $created_by" >&2
    echo "SOLUTION: Assign validation to different agent" >&2
    exit 77  # E_CIRCULAR_VALIDATION_REQUIRED
fi
```

---

## 7. Command Integration

### 7.1 Modified Commands

**`cleo complete <task-id>`**:
- Check current `lifecycleState`
- Validate entry gate requirements met
- Update `lifecycleState` to next stage if applicable
- Record completion in `validationHistory`

**`cleo verify <task-id> --gate <gate> --validator <agent-id>`**:
- Check circular validation: `validator ≠ createdBy`
- Check provenance chain for transitive cycles
- Record validation in `validationHistory`
- Update `validatedBy` and `validatedAt` fields

**`cleo add <title> --lifecycle-state <state> --created-by <agent-id>`**:
- Set initial `lifecycleState` if provided
- Set `createdBy` field (default: "user")
- Validate state is valid RCSD→IVTR entry point

### 7.2 New Commands

**`cleo lifecycle show <task-id>`**:
- Display current lifecycle state
- Show entry gate status (passed/pending)
- Show exit gate status (complete/incomplete)
- Show allowed next states

**`cleo lifecycle validate <task-id>`**:
- Check all gate requirements
- Verify provenance chain integrity
- Check circular validation rules
- Return validation report

**`cleo lifecycle transition <task-id> --to <state> --validator <agent-id>`**:
- Validate transition is allowed
- Check entry gate requirements
- Record transition in audit trail
- Update `lifecycleState` field

### 7.3 MANIFEST Commands

**`cleo research inject`** (modified):
- Include full `audit` object in template
- Pre-populate `created_by`, `created_at`, `lifecycle_state`
- Set `validation_status: pending`
- Initialize empty `provenance_chain`

**`cleo research validate <entry-id>`** (new):
- Validate audit structure against schema
- Check circular validation rules
- Verify provenance chain links
- Return validation status

**`cleo research pending`** (modified):
- Filter by `audit.validation_status: pending`
- Show entries awaiting different-agent validation
- Group by `lifecycle_state` for orchestrator handoffs

---

## 8. Migration Strategy

### 8.1 Three-Phase Rollout

**Phase 1: Optional Audit (v2.10.0)** - Current
- Audit fields added to schema with `null` defaults
- No validation enforcement
- Commands accept but don't require audit fields
- Status: `E_AUDIT_MISSING_WARNING` (exit code 100, non-fatal)

**Phase 2: Warn on Missing Audit (v2.11.0)** - 2-4 weeks
- Schema validation warns when audit missing
- Commands log warnings to stderr
- Track compliance via `cleo research stats --audit-compliance`
- Enforcement trigger: 90% of new entries include audit

**Phase 3: Enforce Audit (v3.0.0)** - After 90% compliance
- Schema validation fails without audit
- Commands return `E_AUDIT_MISSING` (exit code 76, fatal)
- Breaking change - major version bump

### 8.2 Migration Script

**Command**: `cleo migrate --to 2.10.0`

**Backfill Strategy** (based on T2572 Decision 5):

1. **Tasks with session data**:
   - Extract agent from `session.agentId`
   - Set `createdBy: "{agentId}"`
   - Set `lifecycleState: null` (user-session work)

2. **Tasks without session**:
   - Set `createdBy: "legacy"`
   - Set `lifecycleState: null`
   - Set `validatedBy: null`

3. **Completed tasks with verification**:
   - Infer from `verification.lastAgent`
   - Set `validatedBy: "{lastAgent}"`
   - Convert gates to `validationHistory` entries

4. **MANIFEST entries** (append-only):
   - No retroactive updates to existing entries
   - New entries MUST include audit fields
   - Old entries remain valid (schema allows null)

### 8.3 Backward Compatibility

**Guaranteed**:
- Existing tasks remain valid (audit fields nullable)
- Existing MANIFEST entries remain readable
- Existing commands work unchanged
- No breaking API changes in v2.x

**Breaking Changes** (v3.0.0 only):
- Audit fields become required (non-null)
- `cleo add` requires `--created-by` flag
- MANIFEST schema validation enforces audit

---

## 9. Testing Requirements

### 9.1 Unit Tests Required

**File**: `tests/unit/lifecycle-enforcement.bats`

Test coverage MUST include:
1. Lifecycle state transitions (valid + invalid)
2. Entry gate validation (all 8 states)
3. Exit gate validation (all 8 states)
4. Circular validation detection (1-hop + N-hop)
5. Agent ID format validation
6. Provenance chain integrity
7. Validation status workflow
8. Error code generation

### 9.2 Integration Tests Required

**File**: `tests/integration/lifecycle-workflow.bats`

Test scenarios MUST include:
1. Complete RCSD→IVTR pipeline (research → release)
2. Skipped stage workflows (research → spec → impl)
3. Validation rejection + needs_revision loop
4. Multi-agent consensus validation
5. Circular validation prevention
6. Migration script execution
7. MANIFEST audit enforcement

### 9.3 Validation Test Cases

| Test Case | Expected Result |
|-----------|----------------|
| Same agent validates own work | Exit 77 (E_CIRCULAR_VALIDATION_REQUIRED) |
| Backward state transition (spec → research) | Exit 78 (E_LIFECYCLE_TRANSITION_INVALID) |
| Skip required RCSD stage | Exit 75 (E_LIFECYCLE_GATE_FAILED) |
| Missing audit fields (Phase 3) | Exit 76 (E_AUDIT_MISSING) |
| Invalid agent ID format | Exit 79 (E_PROVENANCE_REQUIRED) |
| Transitive circular validation (A→B→A) | Exit 77 (E_CIRCULAR_VALIDATION_REQUIRED) |

---

## 10. Implementation Tasks

### 10.1 Task Breakdown (from T2569 epic)

**Consensus Stage** (complete):
- ✅ T2572: Task Provenance Schema Consensus
- ✅ T2573: MANIFEST Audit History Consensus

**Specification Stage** (current):
- 🔄 T2575: THIS DOCUMENT - Lifecycle Enforcement Spec

**Implementation Stage** (next):
- T2578: Implement task provenance fields (createdBy, validatedBy, testedBy)
- T2579: Add lifecycle gate enforcement to cleo commands
- T2580: Implement circular validation checks
- T2581: Add lifecycle state transitions
- T2582: Create migration script (v2.10.0)

**Testing Stage**:
- T2583: Write lifecycle enforcement test suite
- T2584: Integration tests for RCSD→IVTR workflow

**Release Stage**:
- T2585: Release v2.10.0 with lifecycle enforcement

### 10.2 Critical Path

```
T2572, T2573 (Consensus) ─┐
                          ├─→ T2575 (Spec) ─→ T2578 (Impl: Fields) ─┐
                          │                                           ├─→ T2583 (Tests) ─→ T2585 (Release)
                          └─→ T2579 (Impl: Gates) ─→ T2580, T2581 ──┘
```

### 10.3 Implementation Priority

**High Priority** (blocking):
1. T2578: Task provenance fields (schema foundation)
2. T2579: Lifecycle gate enforcement (core feature)
3. T2580: Circular validation (safety critical)

**Medium Priority** (non-blocking):
4. T2581: Lifecycle transitions (usability)
5. T2582: Migration script (backward compatibility)

**Low Priority** (polish):
6. T2583: Test suite (quality assurance)
7. T2584: Integration tests (end-to-end validation)

---

## 11. Risks & Mitigations

### 11.1 Implementation Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Migration script data corruption** | Low | Critical | Safety backup before migration, dry-run mode, rollback capability |
| **Circular validation false positives** | Medium | High | Comprehensive test suite, feature flag for testing override |
| **Performance impact of provenance checks** | Low | Medium | Cache provenance chains, optimize N-hop cycle detection |
| **Agent ID format conflicts** | Medium | Medium | Validate format in `add-task.sh`, clear error messages |
| **Breaking existing workflows** | High | High | Phased rollout (3 phases), backward compatibility in v2.x |

### 11.2 Adoption Challenges

| Challenge | Impact | Mitigation |
|-----------|--------|------------|
| **Learning curve for new fields** | Medium | Auto-populate from session context, clear documentation |
| **Manual task creation complexity** | Low | Default `createdBy: "user"`, optional flags |
| **Agent orchestrator complexity** | High | Detailed orchestration guide, command examples |
| **Testing validation rules** | Medium | Comprehensive test suite (T2583) |
| **MANIFEST backfill** | Medium | Append-only (no retroactive updates), gradual adoption |

### 11.3 Rollback Plan

**Rollback Trigger**: Critical bug discovered in Phase 2/3

**Rollback Steps**:
1. Restore backup from safety backup (Tier 2)
2. Downgrade to previous schema version
3. Disable audit enforcement via config: `validation.auditEnforcement: none`
4. Document issue in GitHub issue tracker
5. Schedule fix in next sprint

---

## 12. Success Metrics

### 12.1 Compliance Metrics

Track via `cleo research stats --audit-compliance`:

| Metric | Target | Enforcement Trigger |
|--------|--------|---------------------|
| **New entries with audit** | >90% | Enable Phase 3 enforcement |
| **Circular validation blocks** | 0 failures after warnings | Validate detection works |
| **Lifecycle gate failures** | <5% of transitions | Validate enforcement is appropriate |
| **Migration success rate** | 100% (no data loss) | Safe to deploy v2.10.0 |

### 12.2 Quality Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Test coverage** | >90% | BATS test suite |
| **Documentation completeness** | 100% | All commands documented |
| **Error message clarity** | >95% user satisfaction | Issue tracker feedback |
| **Performance impact** | <5% overhead | Benchmark tests |

---

## 13. References

### 13.1 Consensus Documents

1. **T2572**: Task Provenance Schema Consensus (validates T2571 research)
   - Agent ID format: Simple string (`{role}-agent-{taskId}`)
   - Lifecycle states: 8 states (RCSD + IVTR)
   - Validation chain: Full history array
   - Circular validation: Hard block
   - Migration: Backfill required

2. **T2573**: MANIFEST Audit History Consensus (validates T2571 research)
   - Audit location: Top-level `audit` object
   - Required fields: 9 audit fields
   - Validation status: 5-state workflow
   - Provenance chain: Full array of task/manifest IDs
   - Enforcement: Gradual rollout (warn → enforce)

### 13.2 Research Documents

3. **T2571**: Provenance & Lifecycle Research
   - Identified 5 critical gaps in current system
   - Proposed audit structure for MANIFEST
   - Proposed provenance fields for tasks
   - Evidence-based gap analysis

### 13.3 Specifications

4. **RCSD-PIPELINE-SPEC.md** (v2.2.0): Research → Consensus → Specification → Decomposition
5. **PROJECT-LIFECYCLE-SPEC.md** (v1.0.0): Full project lifecycle including IVTR stages
6. **CLEO-SUBAGENT-BASE.md** (v1.0.0): Subagent protocol and manifest requirements

### 13.4 Schemas

7. **schemas/todo.schema.json** (v2.9.0): Current task schema
8. **schemas/manifest.schema.json** (v1.0.0): New MANIFEST schema (to be created)

---

## 14. Open Questions for Implementation

### 14.1 Technical Decisions

1. **Agent ID persistence**: Store in config file or derive from session context?
2. **Verification gate enhancement**: Breaking change (v3.0.0) or parallel structure (v2.11.0)?
3. **MANIFEST audit schema**: New file (`schemas/manifest.schema.json`) or extend existing?
4. **Lifecycle state transitions**: Enforce strict order or allow skips with warnings?
5. **Performance optimization**: Cache provenance chains or compute on-demand?

### 14.2 UX Decisions

6. **Default `createdBy` value**: Auto-detect from session or require explicit flag?
7. **Circular validation override**: Admin-only feature flag or user-configurable?
8. **Error message verbosity**: Show full provenance chain or just immediate circular violation?
9. **MANIFEST audit display**: Show in `cleo research list` or only in `research show`?

### 14.3 Policy Decisions

10. **Enforcement timeline**: Fixed schedule or dynamic based on compliance metrics?
11. **Migration required**: Mandatory for all users or optional backfill?
12. **Backward compatibility**: Support v2.x schema forever or deprecate after v3.0.0?

---

## Appendix A: Example Workflows

### A.1 Complete RCSD→IVTR Pipeline

```bash
# Epic: Add OAuth2 support
cleo add "EPIC: Add OAuth2 support" --type epic --lifecycle-state research

# Research stage
cleo research "OAuth2 best practices" --link-task T3000
# Output: claudedocs/agent-outputs/T3001-oauth2-research.md
# MANIFEST: audit.created_by = "research-agent-T3001"
#           audit.lifecycle_state = "research"
#           audit.validation_status = "pending"

# Consensus stage (validate research)
cleo complete T3001 --validator consensus-agent-T3002
# Check: consensus-agent-T3002 ≠ research-agent-T3001 ✓
# Update MANIFEST: audit.validated_by = "consensus-agent-T3002"
#                  audit.validation_status = "approved"

# Specification stage
cleo add "Specification: OAuth2 implementation spec" \
  --parent T3000 --lifecycle-state specification \
  --created-by specification-agent-T3003
# Output: docs/specs/OAUTH2-SPEC.md

# Decomposition stage
cleo add "Implementation: OAuth2 client library" \
  --parent T3003 --lifecycle-state implementation \
  --created-by decomposition-agent-T3004

# Implementation stage
cleo complete T3004 --validator validation-agent-T3005
# Check: validation-agent-T3005 ≠ decomposition-agent-T3004 ✓

# Testing stage
cleo add "Testing: OAuth2 integration tests" \
  --parent T3004 --lifecycle-state testing \
  --created-by testing-agent-T3006

# Release stage
cleo complete T3006 --validator release-agent-T3007
# Ready for deployment
```

### A.2 Circular Validation Prevention

```bash
# ❌ BLOCKED: Same agent validates own work
cleo verify T3001 --validator research-agent-T3001
# ERROR: Circular validation detected
# Agent research-agent-T3001 cannot validate their own work
# Exit code: 77 (E_CIRCULAR_VALIDATION_REQUIRED)

# ✅ ALLOWED: Different agent validates
cleo verify T3001 --validator consensus-agent-T3002
# SUCCESS: Validation recorded
# MANIFEST updated: audit.validated_by = "consensus-agent-T3002"

# ❌ BLOCKED: Transitive circular validation
# research-agent-T3001 creates T3001
# consensus-agent-T3002 validates T3001 (creates T3002)
# research-agent-T3001 tries to validate T3002
cleo verify T3002 --validator research-agent-T3001
# ERROR: Transitive circular validation detected
# Agent research-agent-T3001 created ancestor T3001
# Exit code: 77 (E_CIRCULAR_VALIDATION_REQUIRED)
```

### A.3 Lifecycle Gate Enforcement

```bash
# ❌ BLOCKED: Skip required RCSD stage
cleo add "Implementation" --lifecycle-state implementation
# (no parent research or spec)
# ERROR: Lifecycle gate failed
# Cannot enter 'implementation' without 'specification' or 'decomposition'
# Exit code: 75 (E_LIFECYCLE_GATE_FAILED)

# ✅ ALLOWED: Valid transition
cleo add "Research" --lifecycle-state research
cleo complete T4001  # research → consensus
cleo add "Specification" --parent T4001 --lifecycle-state specification
# SUCCESS: Valid RCSD progression

# ⚠️ WARN: Skipped optional stage (consensus)
cleo add "Specification" --parent T4001 --lifecycle-state specification
# (skips consensus)
# WARNING: Skipped optional 'consensus' stage
# Consider multi-agent validation for complex changes
```

---

**Specification Complete**: 2026-01-28T04:25:00Z
**Validation Status**: pending (awaits implementation-agent validation)
**Next Stage**: Implementation (T2578, T2579, T2580, T2581, T2582)
