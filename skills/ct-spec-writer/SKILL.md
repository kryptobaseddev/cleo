# Specification Writer Context Injection

**Protocol**: @protocols/specification.md
**Type**: Context Injection (cleo-subagent)
**Version**: 2.0.0

---

## Purpose

Context injection for specification writing tasks spawned via cleo-subagent. Provides domain expertise for creating clear, unambiguous technical specifications using RFC 2119 language.

---

## Capabilities

1. **Protocol Specifications** - Define behavior rules with RFC 2119 keywords
2. **Technical Requirements** - Document system requirements with constraints
3. **API Specifications** - Define interfaces, schemas, and contracts
4. **Architecture Documents** - Document system design decisions

---

## RFC 2119 Keywords (MANDATORY)

Use these keywords with their precise meanings:

| Keyword | Meaning | Compliance |
|---------|---------|------------|
| **MUST** | Absolute requirement | 95-98% |
| **MUST NOT** | Absolute prohibition | 93-97% |
| **SHOULD** | Recommended unless good reason exists | 75-85% |
| **SHOULD NOT** | Discouraged unless good reason exists | 75-85% |
| **MAY** | Truly optional | 40-60% |

---

## Specification Structure

### Standard Layout

```markdown
# {Specification Title} v{X.Y.Z}

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document
are to be interpreted as described in RFC 2119.

---

## Overview

{2-3 sentence summary of what this spec defines}

---

## Definitions

| Term | Definition |
|------|------------|
| {term} | {definition} |

---

## Requirements

### {Category 1}

**REQ-001**: {Requirement description}
- Rationale: {Why this requirement exists}
- Verification: {How to verify compliance}

### {Category 2}

**REQ-002**: {Requirement description}
...

---

## Constraints

| ID | Constraint | Enforcement |
|----|------------|-------------|
| CON-001 | {constraint} | {how enforced} |

---

## Compliance

A system is compliant if:
1. {condition 1}
2. {condition 2}
3. {condition 3}

Non-compliant implementations SHOULD {remediation}.
```

---

## Writing Guidelines

### Be Precise
- Every requirement MUST be testable
- Avoid ambiguous terms ("appropriate", "reasonable", "adequate")
- Use specific values, not ranges when possible

### Be Complete
- Define all terms that might be misunderstood
- Cover error cases and edge conditions
- Specify what happens when requirements conflict

### Be Organized
- Group related requirements
- Use consistent numbering (REQ-XXX, CON-XXX)
- Cross-reference related sections

---

## Output Location

Specifications go in: `docs/specs/{{SPEC_NAME}}.md`

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Execution Sequence

1. Read task: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. Set focus: `{{TASK_FOCUS_CMD}} {{TASK_ID}}` (if not already set by orchestrator)
3. Write specification to `docs/specs/{{SPEC_NAME}}.md`
4. Append manifest entry to `{{MANIFEST_PATH}}`
5. Complete task: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
6. Return summary message

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST write specification to: `docs/specs/{{SPEC_NAME}}.md`
2. MUST append ONE line to: `{{MANIFEST_PATH}}`
3. MUST return ONLY: "Specification complete. See MANIFEST.jsonl for summary."
4. MUST NOT return specification content in response

### Manifest Entry Format

```json
{"id":"spec-{{SPEC_NAME}}-{{DATE}}","file":"{{DATE}}_spec-{{SPEC_NAME}}.md","title":"Specification: {{TITLE}}","date":"{{DATE}}","status":"complete","agent_type":"specification","topics":["specification","{{DOMAIN}}"],"key_findings":["Defined N requirements in M categories","Established X constraints with enforcement rules","Compliance criteria: summary"],"actionable":true,"needs_followup":["{{IMPLEMENTATION_TASK_IDS}}"],"linked_tasks":["{{TASK_ID}}"]}
```

---

## Completion Checklist

- [ ] Task focus set via `{{TASK_FOCUS_CMD}}` (if not already set)
- [ ] RFC 2119 header included
- [ ] All requirements numbered (REQ-XXX)
- [ ] All constraints numbered (CON-XXX)
- [ ] Compliance section defines pass/fail
- [ ] Specification written to docs/specs/
- [ ] Manifest entry appended
- [ ] Task completed via `{{TASK_COMPLETE_CMD}}`
- [ ] Return summary message only
