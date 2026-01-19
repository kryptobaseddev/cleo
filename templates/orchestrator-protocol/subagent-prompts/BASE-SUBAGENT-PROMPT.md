## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

### Output Requirements

1. MUST write findings to: `{OUTPUT_DIR}/{DATE}_{TOPIC_SLUG}.md`
2. MUST append ONE line to: `{OUTPUT_DIR}/MANIFEST.jsonl`
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

### CLEO Integration

1. MUST read task details: `cleo show {TASK_ID}`
2. MUST set focus: `cleo focus set {TASK_ID}`
3. MUST complete task when done: `cleo complete {TASK_ID}`
4. SHOULD link research: `cleo research link {TASK_ID} {RESEARCH_ID}`

### Manifest Entry Format

```json
{
  "id": "{TOPIC_SLUG}-{DATE}",
  "file": "{DATE}_{TOPIC_SLUG}.md",
  "title": "{DESCRIPTIVE_TITLE}",
  "date": "{DATE}",
  "status": "complete",
  "topics": ["topic1", "topic2"],
  "key_findings": ["Finding 1", "Finding 2", "Finding 3"],
  "actionable": true|false,
  "needs_followup": ["{NEXT_TASK_IDS}"],
  "linked_tasks": ["{EPIC_ID}", "{TASK_ID}"]
}
```

### Key Findings Guidelines

- 3-7 items maximum
- One sentence each
- Action-oriented language
- No implementation details in findings

### Completion Checklist

- [ ] Task focus set
- [ ] Output file written
- [ ] Manifest entry appended
- [ ] Task completed via cleo
- [ ] Return message only (no content)
