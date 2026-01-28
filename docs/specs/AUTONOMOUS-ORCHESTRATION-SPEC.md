# Autonomous Orchestration Specification

**Version**: 1.0.0
**Status**: ACTIVE
**Created**: 2026-01-27
**Updated**: 2026-01-27
**Author**: Protocol Specification Agent

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Part 1: Preamble

### 1.1 Purpose

This specification defines **autonomous operation mode** for CLEO orchestrators operating without continuous human oversight. It enables multi-session, multi-conversation workflows where an orchestrator can coordinate subagents, manage handoffs, and resume work across context boundaries.

### 1.2 Authority

This specification is **AUTHORITATIVE** for:

- Autonomous operation constraints (AUTO-*)
- Session handoff protocol (HNDOFF-*)
- Session continuity and resume (CONT-*)
- Context management extensions (CTX-006, CTX-007)
- Project-agnostic validation patterns

This specification **DEFERS TO**:

- [ORCHESTRATOR-PROTOCOL-SPEC.md](ORCHESTRATOR-PROTOCOL-SPEC.md) for ORC-001 to ORC-009, CTX-001 to CTX-005
- [MULTI-SESSION-SPEC.md](MULTI-SESSION-SPEC.md) for session lifecycle management
- [PROJECT-LIFECYCLE-SPEC.md](PROJECT-LIFECYCLE-SPEC.md) for RCSD pipeline and HITL gates
- [CLEO-SUBAGENT-PROTOCOL-v1.md](CLEO-SUBAGENT-PROTOCOL-v1.md) for subagent output requirements

### 1.3 Scope

This specification governs:

1. **Autonomous boundaries** - What orchestrators may do without human intervention
2. **Handoff protocol** - How to transfer state between sessions/conversations
3. **Session continuity** - How to resume work after context limits
4. **Validation patterns** - Project-agnostic compliance checking

### 1.4 Non-Goals

This specification explicitly does **NOT**:

- Prescribe specific testing frameworks (BATS, pytest, Jest, etc.)
- Assume code structure or programming languages
- Require application development (research-only projects supported)
- Replace human decision-making for architectural choices

---

## Part 2: Autonomous Operation Constraints (AUTO-*)

### 2.1 Core Constraints

| ID | Constraint | Rationale |
|----|------------|-----------|
| AUTO-001 | Orchestrator MUST spawn ALL subagents; subagents MUST NOT spawn other subagents | Single coordination point; prevents uncontrolled recursion |
| AUTO-002 | Orchestrator MUST read manifest `key_findings` for handoff context; MUST NOT read full output files | Context preservation; O(1) lookup vs O(n) file reading |
| AUTO-003 | Decomposition (epic-architect) MUST be separate from orchestration; orchestrators MUST NOT decompose tasks | Role separation; decomposition is a spawned subagent task |
| AUTO-004 | Orchestrator MUST verify manifest entry exists BEFORE spawning next agent | Compliance chain integrity |
| AUTO-005 | Orchestrator MUST compute dependency waves and spawn in wave order | Correctness; prevent wasted work on blocked tasks |
| AUTO-006 | Orchestrator MUST handle partial/blocked status by creating followup tasks | Graceful degradation; no silent failures |
| AUTO-007 | Orchestrator MUST NOT make architectural decisions autonomously | HITL gates for significant choices |
| AUTO-008 | Orchestrator MUST log all autonomous decisions to manifest | Audit trail; transparency |
| AUTO-009 | Orchestrator MUST respect HITL gates defined in PROJECT-LIFECYCLE-SPEC | Human oversight at critical points |
| AUTO-010 | Orchestrator SHOULD prefer small, atomic tasks over large batches | Context efficiency; parallel execution |
| AUTO-011 | Orchestrator MAY proceed autonomously within approved epic scope | Bounded autonomy |

### 2.2 Architecture Diagram

```
                    USER / HITL
                        │
                        ▼
    ┌───────────────────────────────────┐
    │         ORCHESTRATOR              │
    │  (Tier 0 - Coordination Only)     │
    │                                   │
    │  - Spawns ALL subagents           │
    │  - Reads manifest summaries       │
    │  - Verifies compliance            │
    │  - Manages handoffs               │
    └───────────┬───────────────────────┘
                │
    ┌───────────┼───────────┬───────────┐
    │           │           │           │
    ▼           ▼           ▼           ▼
┌───────┐  ┌───────┐  ┌───────┐  ┌───────┐
│Agent A│  │Agent B│  │Agent C│  │Agent D│
│(wave0)│  │(wave0)│  │(wave1)│  │(wave2)│
└───┬───┘  └───┬───┘  └───┬───┘  └───┬───┘
    │          │          │          │
    ▼          ▼          ▼          ▼
 MANIFEST   MANIFEST   MANIFEST   MANIFEST
  entry      entry      entry      entry
```

**Key Invariant**: Subagents NEVER spawn other subagents. All spawning flows through orchestrator.

### 2.3 Scope Boundaries

| Autonomous (AUTO-011) | Requires HITL |
|-----------------------|---------------|
| Task execution within epic scope | Architectural decisions |
| Dependency resolution | Scope expansion beyond epic |
| Manifest writing | Force/destructive operations |
| Status updates | Breaking changes |
| Small scope adjustments | Cross-epic work |
| Spawning subagents in wave order | New epic creation |
| Creating followup tasks | Git push to main |

### 2.4 Decision Recording (AUTO-008)

All autonomous decisions MUST be recorded in MANIFEST.jsonl:

```json
{"type":"autonomous_decision","timestamp":"2026-01-27T14:30:00Z","decision":"spawned_subagent","rationale":"all_dependencies_resolved","task_id":"T1234","agent":"ct-orchestrator","confidence":0.95}
```

**Required Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"autonomous_decision"` |
| `timestamp` | string | ISO 8601 timestamp |
| `decision` | string | Action taken |
| `rationale` | string | Why this decision was made |
| `task_id` | string | Related task ID |
| `agent` | string | Agent making decision |
| `confidence` | number | 0.0-1.0 confidence score |

---

## Part 3: Handoff Protocol (HNDOFF-*)

### 3.1 Handoff Triggers

| ID | Constraint | Rationale |
|----|------------|-----------|
| HNDOFF-001 | Orchestrator MUST generate handoff at context critical threshold (80%) | Graceful context management |
| HNDOFF-002 | Orchestrator MUST generate handoff at wave boundary if stopping | Clean state for resume |
| HNDOFF-003 | Orchestrator MUST include resume command in handoff | Actionable next step |
| HNDOFF-004 | Orchestrator MUST persist handoff to MANIFEST.jsonl | Durable state |
| HNDOFF-005 | Orchestrator MUST NOT leave tasks in `in_progress` status at handoff | Clean state invariant |
| HNDOFF-006 | Orchestrator SHOULD prefer stopping at clean wave boundaries | Simpler resume logic |

### 3.2 Handoff Document Structure

```json
{
  "type": "session_handoff",
  "timestamp": "2026-01-27T14:30:00Z",
  "session_id": "session_20260127_143000_abc123",
  "epic_id": "T1575",
  "stop_reason": "context_limit",
  "progress": {
    "completed_tasks": ["T1576", "T1577", "T1578"],
    "current_wave": 2,
    "total_waves": 5,
    "waves_remaining": 3
  },
  "resume": {
    "command": "cleo session resume session_20260127_143000_abc123",
    "next_tasks": ["T1579", "T1580"],
    "blockers": []
  },
  "context_snapshot": {
    "usage_percent": 78,
    "tokens_used": 78000,
    "tokens_remaining": 22000
  },
  "key_findings_summary": [
    "Research phase complete for T1576",
    "Specification drafted for T1577",
    "Implementation blocked on external dependency"
  ]
}
```

### 3.3 Stop Reasons

| Reason | Description | Resume Strategy |
|--------|-------------|-----------------|
| `context_limit` | Context threshold reached | Normal resume; continue from next_tasks |
| `wave_complete` | Wave boundary reached, user requested stop | Normal resume; start next wave |
| `hitl_gate` | HITL decision required | Wait for human decision before resume |
| `error` | Unrecoverable error occurred | Review error, fix, then resume |
| `scope_complete` | All tasks in scope completed | Close session |

### 3.4 Handoff Storage

Handoffs MUST be appended to MANIFEST.jsonl as single-line JSON with `agent_type: "handoff"`.

---

## Part 4: Session Continuity (CONT-*)

### 4.1 Resume Protocol

| ID | Constraint | Rationale |
|----|------------|-----------|
| CONT-001 | Orchestrator MUST read last handoff before resuming work | State recovery |
| CONT-002 | Orchestrator MUST verify task states match handoff expectations | Detect external changes |
| CONT-003 | Orchestrator MUST NOT assume state from previous conversation | Stateless design |
| CONT-004 | Orchestrator MUST check for concurrent modifications | Multi-agent safety |
| CONT-005 | Orchestrator SHOULD summarize resumed context to user | Transparency |
| CONT-006 | Orchestrator MAY skip verification for hot resume (<5 min gap) | Performance optimization |
| CONT-007 | Orchestrator MUST NOT reprocess completed tasks | Idempotency |

### 4.2 Resume Workflow

```
SESSION RESUME
    │
    ├─ 1. Read last handoff from MANIFEST.jsonl
    │     └─ Filter: type="session_handoff" AND session_id matches
    │
    ├─ 2. Verify session still exists
    │     └─ Command: cleo session status <session_id>
    │
    ├─ 3. Check task states for completed since handoff
    │     └─ Compare: handoff.progress.completed_tasks vs current state
    │
    ├─ 4. Detect concurrent modifications
    │     └─ Check: tasks modified by other sessions
    │
    ├─ 5. Resume from next_tasks in handoff
    │     └─ Filter: tasks still pending, dependencies resolved
    │
    └─ 6. Continue autonomous operation
          └─ Apply: AUTO-* constraints
```

### 4.3 State Recovery Matrix

| Handoff State | Current State | Action |
|---------------|---------------|--------|
| Task pending | Task pending | Resume normally |
| Task pending | Task done | Skip (CONT-007) |
| Task pending | Task blocked | Check blocker, create followup |
| Task in_progress | Any | Error - violates HNDOFF-005 |
| Task done | Task done | Skip (CONT-007) |

---

## Part 5: Context Management Extensions (CTX-*)

### 5.1 Extended Context Rules

| ID | Constraint | Rationale |
|----|------------|-----------|
| CTX-006 | Orchestrator MUST track cumulative context across session | Awareness of total usage |
| CTX-007 | Orchestrator MUST checkpoint context state at wave boundaries | Recovery points |

### 5.2 Context Checkpoints

At each wave boundary, orchestrator MUST record:

```json
{
  "type": "context_checkpoint",
  "timestamp": "2026-01-27T14:25:00Z",
  "wave": 2,
  "usage_percent": 45,
  "tasks_completed_this_wave": 3,
  "cumulative_tokens": 45000,
  "session_id": "session_20260127_143000_abc123"
}
```

### 5.3 Context Thresholds

| Threshold | Percentage | Action Required |
|-----------|------------|-----------------|
| OK | 0-69% | Continue normally |
| Warning | 70-79% | Log warning, continue |
| Critical | 80-89% | Generate handoff, stop |
| Emergency | 90%+ | Immediate stop, minimal handoff |

---

## Part 6: Project-Agnostic Validation

### 6.1 Design Principles

This specification MUST NOT assume:

- Specific testing frameworks (BATS, pytest, Jest, Mocha, etc.)
- Code file structure or directory conventions
- Programming languages or runtimes
- CI/CD systems or deployment targets
- Application vs. research project type

### 6.2 Generic Validation Gates

**Core Gates** (always enforced):

| Gate | Description | Check |
|------|-------------|-------|
| `manifest_entry_exists` | Output recorded in MANIFEST.jsonl | `grep <id> MANIFEST.jsonl` |
| `output_file_exists` | File written to expected path | `test -f <path>` |
| `task_completed` | CLEO task status updated | `cleo show <id>` status |

**Core gates require NO external tools** - only CLEO CLI and standard shell.

### 6.3 Custom Validation Configuration

Projects MAY define custom validation gates in `.cleo/config.json`:

```json
{
  "orchestrator": {
    "validation": {
      "customGates": [
        {
          "name": "tests_pass",
          "command": "./tests/run-all-tests.sh",
          "required": true,
          "description": "All tests must pass"
        },
        {
          "name": "lint_clean",
          "command": "npm run lint",
          "required": false,
          "description": "Code style check"
        }
      ]
    }
  }
}
```

**Custom Gate Schema**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique gate identifier |
| `command` | string | Yes | Shell command to execute |
| `required` | boolean | No | If true, failure blocks spawn (default: false) |
| `description` | string | No | Human-readable description |

### 6.4 Validation Execution Order

1. **Core gates** run first (fail-fast)
2. **Custom required gates** run second
3. **Custom optional gates** run last
4. All required gates MUST pass for spawn approval

### 6.5 Research-Only Projects

For research-only projects (no code):

- Core gates still apply (manifest, output file, task status)
- Custom gates may be empty or omitted
- Validation focuses on documentation artifacts

---

## Part 7: Integration with Existing Specs

### 7.1 Specification Relationships

```
AUTONOMOUS-ORCHESTRATION-SPEC (this document)
        │
        ├─── extends ──→ ORCHESTRATOR-PROTOCOL-SPEC
        │                (ORC-001 to ORC-009, CTX-001 to CTX-005)
        │
        ├─── uses ─────→ MULTI-SESSION-SPEC
        │                (session lifecycle, scope binding)
        │
        ├─── respects ─→ PROJECT-LIFECYCLE-SPEC
        │                (RCSD pipeline, HITL gates)
        │
        └─── outputs ──→ MANIFEST.jsonl
                         (handoffs, checkpoints, decisions)
```

### 7.2 Constraint Precedence

When constraints conflict, precedence order:

1. **HITL gates** (PROJECT-LIFECYCLE-SPEC) - Always highest priority
2. **Context limits** (CTX-*) - Override autonomous continuation
3. **Dependency order** (ORC-004, AUTO-005) - Block out-of-order execution
4. **Autonomous boundaries** (AUTO-*) - Guide normal operation

### 7.3 ORC-* Integration

AUTO-* constraints **extend** ORC-* constraints:

| ORC Constraint | AUTO Extension |
|----------------|----------------|
| ORC-002: Delegate all work | AUTO-001: Orchestrator spawns ALL agents |
| ORC-003: No full file reads | AUTO-002: Read manifest key_findings only |
| ORC-004: Dependency order | AUTO-005: Wave-based execution |
| ORC-008: Verify compliance | AUTO-004: Verify before next spawn |
| ORC-009: Auto-stop at critical | HNDOFF-001: Generate handoff at 80% |

---

## Part 8: Corrected Injection Template

### 8.1 Autonomous Orchestration Protocol Block

```markdown
## Autonomous Orchestration Protocol

### IMMUTABLE CONSTRAINTS

| ID | Level | Rule |
|----|-------|------|
| AUTO-001 | MUST | Spawn ALL subagents (subagents MUST NOT spawn other subagents) |
| AUTO-002 | MUST | Read manifest `key_findings` for handoff (NOT full output files) |
| AUTO-003 | MUST | Decomposition is separate from orchestration |
| AUTO-004 | MUST | Verify manifest entry BEFORE spawning next agent |
| AUTO-005 | MUST | Compute dependency waves; spawn in wave order |
| AUTO-006 | MUST | Handle partial/blocked by creating followup tasks |
| CTX-002 | MUST | Auto-stop at 80% context; generate handoff |
| SESS-001 | MUST | Start with `cleo session list` |

### WORKFLOW

1. **Session**: `cleo session list` → resume OR start with `--scope epic:T####`
2. **Waves**: `cleo orchestrator analyze T####` → compute dependency waves
3. **Spawn Loop**:
   - Spawn subagent via Task tool (subagent_type: cleo-subagent)
   - Wait for return message
   - Verify: `cleo research show <id>` → manifest entry exists
   - Link: `cleo research link T#### <id>`
   - Check wave dependencies before next spawn
4. **Context**: `cleo context` before each spawn → check threshold
5. **End**: `cleo session end --note "Wave N complete, next: T####"`

### PROHIBITED

- Subagent spawning subagents
- Reading full output files (use manifest summaries)
- Skipping manifest verification between spawns
- Continuing past 80% context without handoff
- Spawning out of dependency wave order
- Making architectural decisions without HITL
```

### 8.2 Corrections Applied

| Original Pattern | Correction | Constraint Reference |
|------------------|-----------|----------------------|
| "subagent to subagent handoff" | Orchestrator spawns ALL agents | AUTO-001 |
| "NEVER read Task Output" | Read manifest summaries, not full files | AUTO-002, ORC-003 |
| "epic-architect creates chain" | Decomposition ≠ orchestration | AUTO-003 |
| No verification step | Verify manifest before next spawn | AUTO-004 |
| No wave ordering | Spawn in dependency wave order | AUTO-005, ORC-004 |
| Implicit 80% stop | Explicit handoff at context threshold | HNDOFF-001 |

---

## Part 9: Conformance

### 9.1 Required Conformance

A conforming autonomous orchestrator MUST:

1. Implement all AUTO-001 through AUTO-009 constraints
2. Generate compliant handoff documents per HNDOFF-*
3. Follow resume protocol per CONT-*
4. Respect context extensions CTX-006, CTX-007
5. Execute core validation gates before spawning
6. Record autonomous decisions to manifest

### 9.2 Optional Conformance

A conforming implementation MAY:

- Define custom validation gates (Part 6.3)
- Implement hot resume optimization (CONT-006)
- Add project-specific autonomous boundaries
- Extend handoff document with custom fields

### 9.3 Conformance Verification

```bash
# Verify handoff document structure
jq 'select(.type == "session_handoff")' MANIFEST.jsonl | \
  jq 'has("session_id") and has("resume") and has("progress")'

# Verify autonomous decision recording
jq 'select(.type == "autonomous_decision")' MANIFEST.jsonl | \
  jq 'has("decision") and has("rationale") and has("task_id")'

# Verify no tasks left in_progress at handoff
cleo list --status active --format json | jq '.tasks | length == 0'
```

---

## Appendix A: Exit Codes

| Code | Constant | Meaning | Recovery |
|------|----------|---------|----------|
| 64 | EXIT_AUTONOMOUS_BOUNDARY | Autonomous operation boundary reached | HITL decision required |
| 65 | EXIT_HANDOFF_REQUIRED | Must generate handoff before stopping | Generate handoff, then stop |
| 66 | EXIT_RESUME_FAILED | Could not resume from handoff | Verify session/handoff state |
| 67 | EXIT_CONCURRENT_SESSION | Another session active on same scope | Wait or use different scope |

---

## Appendix B: Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-27 | Initial specification |

---

## References

- [ORCHESTRATOR-PROTOCOL-SPEC.md](ORCHESTRATOR-PROTOCOL-SPEC.md) - Base orchestrator constraints
- [PROJECT-LIFECYCLE-SPEC.md](PROJECT-LIFECYCLE-SPEC.md) - RCSD pipeline and HITL gates
- [MULTI-SESSION-SPEC.md](MULTI-SESSION-SPEC.md) - Session lifecycle management
- [CLEO-SUBAGENT-PROTOCOL-v1.md](CLEO-SUBAGENT-PROTOCOL-v1.md) - Subagent output requirements
