# Subagent Protocol Base Reference

This reference defines the RFC 2119 protocol for subagent output and handoff.
All subagents operating under an orchestrator MUST follow this protocol.

---

## Output Requirements (RFC 2119)

### Mandatory Rules

| ID | Rule | Compliance |
|----|------|------------|
| OUT-001 | MUST write findings to `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md` | Required |
| OUT-002 | MUST append ONE line to `{{MANIFEST_PATH}}` | Required |
| OUT-003 | MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary." | Required |
| OUT-004 | MUST NOT return research content in response | Required |

### Rationale

- **OUT-001**: Persistent storage for orchestrator and future agents
- **OUT-002**: Manifest enables O(1) lookup of key findings
- **OUT-003**: Minimal response preserves orchestrator context
- **OUT-004**: Full content would bloat orchestrator context window

---

## Output File Format

Write to `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`:

```markdown
# {{TITLE}}

## Summary

{{2-3 sentence overview}}

## Findings

### {{Category 1}}

{{Details}}

### {{Category 2}}

{{Details}}

## Recommendations

{{Action items}}

## Sources

{{Citations/references}}

## Linked Tasks

- Epic: {{EPIC_ID}}
- Task: {{TASK_ID}}
```

---

## Manifest Entry Format

Append ONE line (no pretty-printing) to `{{MANIFEST_PATH}}`:

```json
{"id":"{{TOPIC_SLUG}}-{{DATE}}","file":"{{DATE}}_{{TOPIC_SLUG}}.md","title":"{{TITLE}}","date":"{{DATE}}","status":"complete","topics":["topic1","topic2"],"key_findings":["Finding 1","Finding 2","Finding 3"],"actionable":true,"needs_followup":["{{NEXT_TASK_IDS}}"],"linked_tasks":["{{EPIC_ID}}","{{TASK_ID}}"]}
```

### Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier: `{topic-slug}-{date}` |
| `file` | string | Output filename |
| `title` | string | Human-readable title |
| `date` | string | ISO date (YYYY-MM-DD) |
| `status` | enum | `complete`, `partial`, `blocked` |
| `topics` | array | Categorization tags |
| `key_findings` | array | 3-7 one-sentence findings |
| `actionable` | boolean | Whether findings require action |
| `needs_followup` | array | Task IDs requiring attention |
| `linked_tasks` | array | Associated task IDs |

### Key Findings Guidelines

- **3-7 items maximum**
- **One sentence each**
- **Action-oriented language**
- **No implementation details** (those go in the output file)

---

## Task Lifecycle Integration

Reference: @skills/_shared/task-system-integration.md

### Execution Sequence

```
1. Read task:    {{TASK_SHOW_CMD}} {{TASK_ID}}
2. Set focus:    {{TASK_FOCUS_CMD}} {{TASK_ID}}
3. Do work:      [skill-specific execution]
4. Write output: {{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md
5. Append manifest: {{MANIFEST_PATH}}
6. Complete:     {{TASK_COMPLETE_CMD}} {{TASK_ID}}
7. Link (optional): {{TASK_LINK_CMD}} {{TASK_ID}} {{RESEARCH_ID}}
8. Return:       "Research complete. See MANIFEST.jsonl for summary."
```

---

## Research Linking

### Link Research to Task

```bash
{{TASK_LINK_CMD}} {{TASK_ID}} {{RESEARCH_ID}}
```

**Purpose**: Associate research output with originating task for bidirectional discovery.

**CLEO Default**: `cleo research link {{TASK_ID}} {{RESEARCH_ID}}`

**When to Link**:
- SHOULD link after writing research output to manifest
- SHOULD link when research directly supports task objectives
- MAY skip if research is exploratory/tangential

### Verify Link

```bash
{{TASK_SHOW_CMD}} {{TASK_ID}}
# Check: linkedResearch array contains research ID
```

### Benefits

| Benefit | Description |
|---------|-------------|
| Bidirectional discovery | Task → Research and Research → Task |
| Context preservation | Future agents can find prior research |
| Audit trail | Complete record of work artifacts |

---

## Completion Checklist

Before returning, verify:

- [ ] Task focus set via `{{TASK_FOCUS_CMD}}`
- [ ] Output file written to `{{OUTPUT_DIR}}/`
- [ ] Manifest entry appended (single line, valid JSON)
- [ ] Task completed via `{{TASK_COMPLETE_CMD}}`
- [ ] Response is ONLY the summary message

---

## Token Reference

### Required Tokens (MUST be provided)

| Token | Description | Example |
|-------|-------------|---------|
| `{{TASK_ID}}` | Current task identifier | `T1234` |
| `{{DATE}}` | Current date | `2026-01-19` |
| `{{TOPIC_SLUG}}` | URL-safe topic name | `authentication-research` |

### Optional Tokens (defaults available)

| Token | Default | Description |
|-------|---------|-------------|
| `{{EPIC_ID}}` | `""` | Parent epic ID |
| `{{SESSION_ID}}` | `""` | Session identifier |
| `{{OUTPUT_DIR}}` | `claudedocs/agent-outputs` | Output directory |
| `{{MANIFEST_PATH}}` | `{{OUTPUT_DIR}}/MANIFEST.jsonl` | Manifest location |

### Task System Tokens (CLEO defaults)

| Token | CLEO Default |
|-------|--------------|
| `{{TASK_SHOW_CMD}}` | `cleo show` |
| `{{TASK_FOCUS_CMD}}` | `cleo focus set` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_LINK_CMD}}` | `cleo research link` |

---

## Error Handling

### Partial Completion

If work cannot complete fully:

1. Write partial findings to output file
2. Set manifest `"status": "partial"`
3. Add blocking reason to `needs_followup`
4. Complete task (partial work is still progress)
5. Return: "Research partial. See MANIFEST.jsonl for details."

### Blocked Status

If work cannot proceed:

1. Write blocking analysis to output file
2. Set manifest `"status": "blocked"`
3. Add blocker details to `needs_followup`
4. Do NOT complete task (leave for orchestrator decision)
5. Return: "Research blocked. See MANIFEST.jsonl for blocker details."

---

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Returning full content | Bloats orchestrator context | Return only summary message |
| Pretty-printed JSON | Multiple lines in manifest | Single line JSON |
| Missing manifest entry | Orchestrator can't find findings | Always append to manifest |
| Incomplete checklist | Protocol violation | Verify all items before return |
