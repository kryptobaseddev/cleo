---
title: "Protocol Stack Specification"
description: "Protocol stack for CLEO subagents with conditional protocol loading"
icon: "layer-group"
---

# Protocol Stack Specification

**Version**: 1.0.0 | **Status**: PROPOSED | **RFC 2119**

This specification defines the protocol stack for CLEO subagents using RFC 2119 keywords.

## Protocol Hierarchy

```
┌─────────────────────────────────────┐
│        SKILL TEMPLATE               │  ← Skill-specific instructions
│   (skills/ct-*/SKILL.md)            │
├─────────────────────────────────────┤
│        BASE PROTOCOL                │  ← Always loaded (OUT-001 to OUT-004)
│   (_shared/subagent-protocol-base)  │
├─────────────────────────────────────┤
│     CONDITIONAL PROTOCOLS           │  ← Context-dependent (7 types)
│   (_shared/*.md)                    │
└─────────────────────────────────────┘
```

## Base Protocol (REQUIRED)

**Location**: `skills/_shared/subagent-protocol-base.md`

### OUT-001: Output File Requirement

**MUST** write findings to designated output file:
```
claudedocs/agent-outputs/{{DATE}}_{{TOPIC_SLUG}}.md
```

**MUST NOT** write to any other location without explicit instruction.

### OUT-002: Manifest Entry Requirement

**MUST** append exactly ONE line to manifest:
```
claudedocs/agent-outputs/MANIFEST.jsonl
```

**MUST** use single-line JSON (no pretty-printing).

**MUST** include required fields:
```json
{
  "id": "{{TOPIC_SLUG}}-{{DATE}}",
  "file": "{{DATE}}_{{TOPIC_SLUG}}.md",
  "title": "{{TASK_TITLE}}",
  "date": "{{DATE}}",
  "status": "complete|partial|blocked",
  "agent_type": "research|implementation|specification",
  "topics": ["tag1", "tag2"],
  "key_findings": ["finding1", "finding2"],
  "actionable": false,
  "needs_followup": [],
  "linked_tasks": ["{{TASK_ID}}"]
}
```

### OUT-003: Return Message Requirement

**MUST** return ONLY a summary message:
```
"Implementation complete. See MANIFEST.jsonl for summary."
```

**MUST NOT** include implementation details in response.

### OUT-004: No Content Return

**MUST NOT** return file contents in response.
**MUST NOT** return code blocks in response.
**SHOULD** direct user to output files for details.

## Conditional Protocols

### 1. Task Lifecycle Protocol

**Trigger**: Always loaded
**Location**: `skills/_shared/task-system-integration.md`

**Rules:**

| ID | Requirement |
|----|-------------|
| TL-001 | **MUST** read task via `cleo show {{TASK_ID}}` before execution |
| TL-002 | **MUST** set focus via `cleo focus set {{TASK_ID}}` if not pre-set |
| TL-003 | **MUST** complete task via `cleo complete {{TASK_ID}} --notes "..."` |
| TL-004 | **SHOULD** add notes for significant progress |
| TL-005 | **MAY** create subtasks for discovered work |

### 2. Research Linking Protocol

**Trigger**: Task has research dependencies or produces research
**Location**: `skills/_shared/research-linking.md`

**Rules:**

| ID | Requirement |
|----|-------------|
| RL-001 | **MUST** check `MANIFEST.jsonl` for prior research |
| RL-002 | **MUST** link research via `cleo research link {{TASK_ID}} {{RESEARCH_ID}}` |
| RL-003 | **SHOULD** reference prior research in output |
| RL-004 | **MAY** set `needs_followup` for dependent research |

### 3. Verification Gates Protocol

**Trigger**: Task requires verification (`verification.required: true`)
**Location**: `skills/_shared/verification-gates.md`

**Rules:**

| ID | Requirement |
|----|-------------|
| VG-001 | **MUST** verify against acceptance criteria |
| VG-002 | **MUST** set verification gates via `cleo verify {{TASK_ID}} --gate <gate>` |
| VG-003 | **SHOULD** document verification in output file |
| VG-004 | **MUST NOT** complete task if verification fails |

**Gates:**
- `implemented` - Auto-set on complete
- `testsPassed` - Tests pass
- `qaPassed` - QA review done
- `securityPassed` - Security scan clear
- `documented` - Documentation complete

### 4. Phase Awareness Protocol

**Trigger**: Project has phase tracking enabled
**Location**: `skills/_shared/phase-awareness.md`

**Rules:**

| ID | Requirement |
|----|-------------|
| PA-001 | **MUST** check current phase via `cleo phase show` |
| PA-002 | **SHOULD** prefer tasks in current phase |
| PA-003 | **MAY** document cross-phase rationale |

### 5. Dependency Context Protocol

**Trigger**: Task has dependencies (`depends: [...]`)
**Location**: `skills/_shared/dependency-context.md`

**Rules:**

| ID | Requirement |
|----|-------------|
| DC-001 | **MUST** verify dependencies complete before execution |
| DC-002 | **SHOULD** reference dependency outputs |
| DC-003 | **MUST NOT** proceed if dependencies blocked |

### 6. Error Handling Protocol

**Trigger**: Always loaded
**Location**: `skills/_shared/error-handling.md`

**Rules:**

| ID | Requirement |
|----|-------------|
| EH-001 | **MUST** set manifest `"status": "partial"` for incomplete work |
| EH-002 | **MUST** set manifest `"status": "blocked"` for blocked execution |
| EH-003 | **MUST** add blocking items to `needs_followup` |
| EH-004 | **MUST NOT** complete task if blocked |
| EH-005 | **SHOULD** document error details in output file |

### 7. Session Integration Protocol

**Trigger**: Session is active (`CLEO_SESSION` set)
**Location**: `skills/_shared/session-integration.md`

**Rules:**

| ID | Requirement |
|----|-------------|
| SI-001 | **MUST** use `CLEO_SESSION` for all cleo commands |
| SI-002 | **MUST** end session with note on completion |
| SI-003 | **SHOULD** check session timeout (72h) |
| SI-004 | **MAY** use `cleo session gc` for cleanup |

## Protocol Interaction

### Load Order

1. Skill template (always first)
2. Base protocol (always second)
3. Conditional protocols (context-dependent, any order)

### Conflict Resolution

If protocols conflict:
1. Base protocol rules take precedence
2. Error handling protocol takes precedence over success paths
3. Task lifecycle rules are mandatory

### Protocol Versioning

Each protocol tracks version in header:
```markdown
**Protocol Version**: 1.0.0
```

Breaking changes require major version bump.

## Compliance Verification

Post-spawn compliance checks:

| Check | Rule | Action on Failure |
|-------|------|-------------------|
| Manifest entry exists | OUT-002 | Log violation |
| Output file exists | OUT-001 | Log violation |
| Return message format | OUT-003 | Warn |
| Task completed | TL-003 | Block next spawn |

## Related

- [Protocol Injection Flow](../guides/PROTOCOL-INJECTION-FLOW.md)
- [Skill Dispatch Algorithm](../guides/SKILL-DISPATCH-ALGORITHM.md)
- [Subagent Architecture](../architecture/CLEO-SUBAGENT.md)
