# Subagent Protocol (RFC 2119 - MANDATORY)

This is the base protocol block to inject into ALL subagent prompts.
Replace `{{TOKENS}}` with actual values before injection.

---

## Output Requirements

1. **MUST** write findings to: `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`
2. **MUST** append ONE line to: `{{MANIFEST_PATH}}`
3. **MUST** return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. **MUST NOT** return research content in response.

## Task Lifecycle

1. **MUST** read task details: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. **MUST** set focus: `{{TASK_FOCUS_CMD}} {{TASK_ID}}`
3. **MUST** complete task when done: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
4. **SHOULD** link research: `{{TASK_LINK_CMD}} {{TASK_ID}} {{RESEARCH_ID}}`

## Manifest Entry Format

```json
{
  "id": "{{TOPIC_SLUG}}-{{DATE}}",
  "file": "{{DATE}}_{{TOPIC_SLUG}}.md",
  "title": "{{TITLE}}",
  "date": "{{DATE}}",
  "status": "complete",
  "topics": ["{{TOPIC_1}}", "{{TOPIC_2}}"],
  "key_findings": ["Finding 1", "Finding 2", "Finding 3"],
  "actionable": true|false,
  "needs_followup": ["{{NEXT_TASK_IDS}}"],
  "linked_tasks": ["{{EPIC_ID}}", "{{TASK_ID}}"]
}
```

## Key Findings Guidelines

- 3-7 items maximum
- One sentence each
- Action-oriented language
- No implementation details in findings

## Completion Checklist

- [ ] Task focus set
- [ ] Output file written
- [ ] Manifest entry appended (single line)
- [ ] Task completed
- [ ] Return message only (no content)

---

## Token Reference

### Required Tokens

| Token | Description |
|-------|-------------|
| `{{TASK_ID}}` | Current task identifier |
| `{{DATE}}` | Current date (YYYY-MM-DD) |
| `{{TOPIC_SLUG}}` | URL-safe topic name |

### Context Tokens

| Token | Default |
|-------|---------|
| `{{EPIC_ID}}` | Parent epic ID (optional) |
| `{{SESSION_ID}}` | Session ID (optional) |
| `{{OUTPUT_DIR}}` | `claudedocs/research-outputs` |
| `{{MANIFEST_PATH}}` | `{{OUTPUT_DIR}}/MANIFEST.jsonl` |

### Task System Tokens (CLEO Defaults)

| Token | Default Value |
|-------|---------------|
| `{{TASK_SHOW_CMD}}` | `cleo show` |
| `{{TASK_FOCUS_CMD}}` | `cleo focus set` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_LINK_CMD}}` | `cleo research link` |

---

## Usage

### Inline Injection (Orchestrator)

```markdown
You are the RESEARCH subagent for {{TOPIC}}.

## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

OUTPUT REQUIREMENTS:
1. MUST write findings to: {{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md
2. MUST append ONE line to: {{MANIFEST_PATH}}
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

TASK LIFECYCLE:
1. MUST read task details: {{TASK_SHOW_CMD}} {{TASK_ID}}
2. MUST set focus: {{TASK_FOCUS_CMD}} {{TASK_ID}}
3. MUST complete task: {{TASK_COMPLETE_CMD}} {{TASK_ID}}

[... rest of subagent instructions ...]
```

### Reference Injection (Skills)

```markdown
## Subagent Protocol

@skills/_shared/subagent-protocol-base.md
```
