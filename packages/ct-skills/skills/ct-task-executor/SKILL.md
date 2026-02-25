---
name: ct-task-executor
description: General implementation task execution for completing assigned CLEO tasks by following instructions and producing concrete deliverables. Handles coding, configuration, documentation work with quality verification against acceptance criteria and progress reporting. Use when executing implementation tasks, completing assigned work, or producing task deliverables. Triggers on implementation tasks, general execution needs, or task completion work.
version: 2.0.0
tier: 2
core: true
category: core
protocol: implementation
dependencies: []
sharedResources:
  - subagent-protocol-base
  - task-system-integration
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Task Executor Context Injection

**Protocol**: @protocols/implementation.md
**Type**: Context Injection (cleo-subagent)
**Version**: 2.0.0

---

## Purpose

Context injection for implementation tasks spawned via cleo-subagent. Provides domain expertise for completing assigned CLEO tasks by following their instructions and deliverables to produce concrete outputs.

---

## Capabilities

1. **Implementation** - Execute coding, configuration, and documentation tasks
2. **Deliverable Production** - Create files, code, and artifacts as specified
3. **Quality Verification** - Validate work against acceptance criteria
4. **Progress Reporting** - Document completion via subagent protocol

---

## Parameters (Orchestrator-Provided)

| Parameter | Description | Required |
|-----------|-------------|----------|
| `{{TASK_ID}}` | Current task identifier | Yes |
| `{{TASK_NAME}}` | Human-readable task name | Yes |
| `{{TASK_INSTRUCTIONS}}` | Specific execution instructions | Yes |
| `{{DELIVERABLES_LIST}}` | Expected outputs/artifacts | Yes |
| `{{ACCEPTANCE_CRITERIA}}` | Completion verification criteria | Yes |
| `{{TOPIC_SLUG}}` | URL-safe topic name for output | Yes |
| `{{DATE}}` | Current date (YYYY-MM-DD) | Yes |
| `{{EPIC_ID}}` | Parent epic identifier | No |
| `{{SESSION_ID}}` | Session identifier | No |
| `{{DEPENDS_LIST}}` | Dependencies completed | No |
| `{{MANIFEST_SUMMARIES}}` | Context from previous agents | No |
| `{{TOPICS_JSON}}` | JSON array of categorization tags | Yes |

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Execution Sequence

1. Read task: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. Focus already set by orchestrator (set if working standalone)
3. Execute instructions (see Methodology below)
4. Verify deliverables against acceptance criteria
5. Write output: `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`
6. Append manifest: `{{MANIFEST_PATH}}`
7. Complete task: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
8. Return summary message

---

## Methodology

### Pre-Execution

1. **Read task details** - Understand full context from task system
2. **Review dependencies** - Check manifest summaries from previous agents
3. **Identify deliverables** - Know exactly what to produce
4. **Understand acceptance criteria** - Know how success is measured

### Execution

1. **Follow instructions** - Execute `{{TASK_INSTRUCTIONS}}` step by step
2. **Produce deliverables** - Create each item in `{{DELIVERABLES_LIST}}`
3. **Document as you go** - Track progress for output file
4. **Handle blockers** - Report if unable to proceed

### Post-Execution

1. **Verify against criteria** - Check each acceptance criterion
2. **Document completion** - Write detailed output file
3. **Update manifest** - Append summary entry
4. **Complete task** - Mark task done in task system

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST write findings to: `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`
2. MUST append ONE line to: `{{MANIFEST_PATH}}`
3. MUST return ONLY: "Implementation complete. See MANIFEST.jsonl for summary."
4. MUST NOT return implementation details in response

---

## Output File Format

Write to `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`:

```markdown
# {{TASK_NAME}}

## Summary

{{2-3 sentence overview of what was accomplished}}

## Deliverables

### {{Deliverable 1}}

{{Description of what was created/modified}}

**Files affected:**
- {{file path 1}}
- {{file path 2}}

### {{Deliverable 2}}

{{Description of what was created/modified}}

## Acceptance Criteria Verification

| Criterion | Status | Notes |
|-----------|--------|-------|
| {{Criterion 1}} | PASS/FAIL | {{Verification notes}} |
| {{Criterion 2}} | PASS/FAIL | {{Verification notes}} |

## Implementation Notes

{{Technical details, decisions made, edge cases handled}}

## Linked Tasks

- Epic: {{EPIC_ID}}
- Task: {{TASK_ID}}
- Dependencies: {{DEPENDS_LIST}}
```

---

## Manifest Entry Format

Append ONE line (no pretty-printing) to `{{MANIFEST_PATH}}`:

```json
{"id":"{{TOPIC_SLUG}}-{{DATE}}","file":"{{DATE}}_{{TOPIC_SLUG}}.md","title":"{{TASK_NAME}}","date":"{{DATE}}","status":"complete","agent_type":"implementation","topics":{{TOPICS_JSON}},"key_findings":["Completed: deliverable 1","Completed: deliverable 2","All acceptance criteria passed"],"actionable":false,"needs_followup":[],"linked_tasks":["{{EPIC_ID}}","{{TASK_ID}}"]}
```

### Field Guidelines

| Field | Guideline |
|-------|-----------|
| `key_findings` | 3-7 items: deliverables completed, key decisions made |
| `actionable` | `false` if task complete, `true` if followup needed |
| `needs_followup` | Task IDs for dependent work identified during execution |
| `topics` | 2-5 categorization tags matching task labels |

---

## Completion Checklist

- [ ] Task details read via `{{TASK_SHOW_CMD}}`
- [ ] Focus set (if not pre-set by orchestrator)
- [ ] All instructions executed
- [ ] All deliverables produced
- [ ] Acceptance criteria verified
- [ ] Output file written to `{{OUTPUT_DIR}}/`
- [ ] Manifest entry appended (single line, valid JSON)
- [ ] Task completed via `{{TASK_COMPLETE_CMD}}`
- [ ] Session ended with summary note (if executor owns session)
- [ ] Response is ONLY the summary message

---

## Error Handling

### Partial Completion

If all deliverables cannot be produced:

1. Complete what is possible
2. Document partial progress in output file
3. Set manifest `"status": "partial"`
4. Add blocking items to `needs_followup`
5. Complete task (partial work is progress)
6. Return: "Implementation partial. See MANIFEST.jsonl for details."

### Blocked Execution

If work cannot proceed (missing dependencies, access issues, unclear requirements):

1. Document blocking reason in output file
2. Set manifest `"status": "blocked"`
3. Add blocker details to `needs_followup`
4. Do NOT complete task
5. Return: "Implementation blocked. See MANIFEST.jsonl for blocker details."

### Acceptance Criteria Failure

If deliverables don't pass acceptance criteria:

1. Document what failed and why
2. Set manifest `"status": "partial"` or `"blocked"`
3. Add remediation suggestions to `needs_followup`
4. Complete task only if failure is documented and understood
5. Return appropriate status message

---

## Session Management

### Session Lifecycle

Task executor sessions support long-running work with a **72-hour timeout**. Sessions persist across Claude conversations, allowing work to resume seamlessly.

**MUST** end sessions properly when completing work:

```bash
# After completing task work
cleo session end --note "Task {{TASK_ID}} completed: {{summary}}"
```

### Session Cleanup

If session accumulation occurs (stale sessions from crashed agents or incomplete work):

```bash
# List all sessions including stale ones
cleo session list --all

# Clean up stale sessions (72h+ inactive)
cleo session gc

# Force cleanup including active sessions (use cautiously)
cleo session gc --include-active
```

### Best Practices

| Practice | Rationale |
|----------|-----------|
| Always end sessions | Prevents accumulation, maintains clean state |
| Use descriptive end notes | Provides context for future sessions |
| Check session status on startup | Resume existing session if applicable |
| Report session issues | Blocked sessions need orchestrator attention |

---

## Quality Standards

### Deliverable Quality

- **Complete** - All specified deliverables produced
- **Correct** - Meets acceptance criteria
- **Documented** - Changes are explained
- **Tested** - Verified where applicable

### Execution Quality

- **Methodical** - Follow instructions in order
- **Thorough** - Don't skip steps
- **Transparent** - Document decisions
- **Communicative** - Report blockers immediately

---

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Skipping acceptance check | Incomplete work | Verify every criterion |
| Partial deliverables | Missing outputs | Complete all or report partial |
| Undocumented changes | Lost context | Write detailed output file |
| Silent failures | Orchestrator unaware | Report via manifest status |
