# Validator Context Injection

**Protocol**: @protocols/implementation.md
**Type**: Context Injection (cleo-subagent)
**Version**: 2.0.0

---

## Purpose

Context injection for compliance validation tasks spawned via cleo-subagent. Provides domain expertise for verifying that systems, documents, or code comply with specified requirements, schemas, or standards.

---

## Capabilities

1. **Schema Validation** - Verify data structures against JSON Schema
2. **Code Compliance** - Check code against style guides and standards
3. **Document Validation** - Verify documents meet structural requirements
4. **Protocol Compliance** - Check implementations against specifications

---

## Validation Methodology

### Standard Workflow

1. **Define scope** - What is being validated
2. **Identify criteria** - What rules apply
3. **Execute checks** - Run validation against criteria
4. **Document findings** - Record pass/fail with details
5. **Report status** - Summarize compliance level

---

## Output Format

### Validation Report Structure

```markdown
# Validation Report: {{VALIDATION_TARGET}}

## Summary

- **Status**: PASS | PARTIAL | FAIL
- **Compliance**: {X}%
- **Critical Issues**: {N}

## Checklist Results

| Check | Status | Details |
|-------|--------|---------|
| {CHECK_1} | PASS/FAIL | {Details} |
| {CHECK_2} | PASS/FAIL | {Details} |

## Issues Found

### Critical
{List or "None"}

### Warnings
{List or "None"}

### Suggestions
{List or "None"}

## Remediation

{Required fixes if FAIL/PARTIAL, or "No remediation required" if PASS}
```

---

## Status Definitions

| Status | Meaning | Criteria |
|--------|---------|----------|
| **PASS** | Fully compliant | All checks pass, 0 critical issues |
| **PARTIAL** | Mostly compliant | >70% pass, no critical issues |
| **FAIL** | Non-compliant | <70% pass OR any critical issues |

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Execution Sequence

1. Read task: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. Set focus: `{{TASK_FOCUS_CMD}} {{TASK_ID}}` (if not already set by orchestrator)
3. Execute validation checks
4. Write validation report to `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`
5. Append manifest entry to `{{MANIFEST_PATH}}`
6. Complete task: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
7. Return summary message

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST write validation report to: `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`
2. MUST append ONE line to: `{{MANIFEST_PATH}}`
3. MUST return ONLY: "Validation complete. See MANIFEST.jsonl for summary."
4. MUST NOT return validation content in response

### Manifest Entry Format

```json
{"id":"{{TOPIC_SLUG}}-{{DATE}}","file":"{{DATE}}_{{TOPIC_SLUG}}.md","title":"{{VALIDATION_TARGET}} Validation","date":"{{DATE}}","status":"complete","agent_type":"validation","topics":["validation","compliance","{{TOPIC}}"],"key_findings":["Overall: {PASS|PARTIAL|FAIL} at {X}%","{N} critical issues found","{SUMMARY_OF_MAIN_FINDINGS}"],"actionable":{TRUE_IF_ISSUES},"needs_followup":["{REMEDIATION_TASK_IDS}"],"linked_tasks":["{{EPIC_ID}}","{{TASK_ID}}"]}
```

---

## Validation Types

### Schema Validation

```bash
# JSON Schema validation example
{{VALIDATION_COMMANDS}}
```

**Checks**:
- Required fields present
- Field types correct
- Enum values valid
- Constraints satisfied

### Code Compliance

**Checks**:
- Style guide conformance
- Naming conventions
- Documentation requirements
- Security patterns

### Document Validation

**Checks**:
- Required sections present
- Frontmatter complete
- Links valid
- Format consistent

### Protocol Compliance

**Checks**:
- RFC 2119 keywords used correctly
- Required behaviors implemented
- Constraints enforced
- Error handling present

---

## Completion Checklist

- [ ] Task focus set via `{{TASK_FOCUS_CMD}}` (if not already set)
- [ ] All validation checks executed
- [ ] Results documented with PASS/FAIL status
- [ ] Compliance percentage calculated
- [ ] Critical issues flagged
- [ ] Remediation steps provided (if FAIL/PARTIAL)
- [ ] Validation report written to output directory
- [ ] Manifest entry appended
- [ ] Task completed via `{{TASK_COMPLETE_CMD}}`
- [ ] Return summary message only

---

## Context Variables

When invoked by orchestrator, expect these context tokens:

| Token | Description | Example |
|-------|-------------|---------|
| `{{VALIDATION_TARGET}}` | What is being validated | `CLEO Schema v2.6.0` |
| `{{TARGET_FILES_OR_SYSTEMS}}` | Files/paths to check | `schemas/*.json` |
| `{{VALIDATION_CRITERIA}}` | Checklist of requirements | RFC 2119 compliance items |
| `{{VALIDATION_COMMANDS}}` | Specific commands to run | `ajv validate --spec=draft7` |
| `{{TOPIC_SLUG}}` | URL-safe topic name | `schema-validation` |

---

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Skipping failing checks | Incomplete report | Run all checks, report all failures |
| Vague findings | Unclear remediation | Specific issue + file/line + fix |
| Missing severity | Can't prioritize | Always classify: critical/warning/suggestion |
| No remediation | Findings not actionable | Always provide fix for FAIL/PARTIAL |
