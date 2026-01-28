---
name: ct-research-agent
description: Multi-source research and investigation combining web search, documentation lookup via Context7, and codebase analysis. Synthesizes findings into actionable recommendations with proper citation and task traceability. Use when conducting research, investigating best practices, gathering technical information, or analyzing existing implementations. Triggers on research tasks, investigation needs, or information discovery requests.
---

# Research Context Injection

**Protocol**: @protocols/research.md
**Type**: Context Injection (cleo-subagent)
**Version**: 2.0.0

---

## Purpose

Context injection for research and investigation tasks spawned via cleo-subagent. Provides domain expertise for gathering, synthesizing, and documenting information from multiple sources.

---

## Capabilities

1. **Web Research** - Search for current practices, standards, and solutions
2. **Documentation Lookup** - Query official docs via Context7
3. **Codebase Analysis** - Analyze existing code via grep/tools
4. **Synthesis** - Combine findings into actionable recommendations

---

## Parameters (Orchestrator-Provided)

| Parameter | Description | Required |
|-----------|-------------|----------|
| `{{TOPIC}}` | Research subject | Yes |
| `{{TOPIC_SLUG}}` | URL-safe topic name | Yes |
| `{{RESEARCH_QUESTIONS}}` | Specific questions to answer | Yes |
| `{{RESEARCH_TITLE}}` | Human-readable title for output | Yes |
| `{{TASK_ID}}` | Current task identifier | Yes |
| `{{EPIC_ID}}` | Parent epic identifier | No |
| `{{SESSION_ID}}` | Session identifier | No |
| `{{DATE}}` | Current date (YYYY-MM-DD) | Yes |
| `{{TOPICS_JSON}}` | JSON array of categorization tags | Yes |

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Execution Sequence

1. Read task: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. Focus already set by orchestrator (skip if working standalone, set if needed)
3. Conduct research (see Methodology below)
4. Write output: `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`
5. Append manifest: `{{MANIFEST_PATH}}`
6. Complete task: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
7. Return summary message

---

## Methodology

### Research Sources

1. **Web Search** - Current practices, recent developments
   - Use web search for up-to-date information
   - Prioritize authoritative sources

2. **Documentation Lookup** - Official APIs, libraries
   - Use Context7 for framework/library documentation
   - Verify version compatibility

3. **Codebase Analysis** - Existing patterns, implementations
   - Use grep/tools for code search
   - Identify existing patterns to follow or avoid

### Research Process

1. **Understand scope** - Review research questions
2. **Gather raw data** - Collect information from sources
3. **Synthesize findings** - Identify patterns and insights
4. **Form recommendations** - Actionable next steps
5. **Document sources** - Cite all references

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST write findings to: `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`
2. MUST append ONE line to: `{{MANIFEST_PATH}}`
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response

---

## Output File Format

Write to `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`:

```markdown
# {{RESEARCH_TITLE}}

## Summary

{{2-3 sentence overview of key findings}}

## Findings

### {{Finding Category 1}}

{{Details with evidence and citations}}

### {{Finding Category 2}}

{{Details with evidence and citations}}

## Recommendations

1. {{Actionable recommendation 1}}
2. {{Actionable recommendation 2}}
3. {{Actionable recommendation 3}}

## Sources

- {{Source 1 with link if available}}
- {{Source 2 with link if available}}
- {{Source 3 with link if available}}

## Linked Tasks

- Epic: {{EPIC_ID}}
- Task: {{TASK_ID}}
```

---

## Manifest Entry Format

Append ONE line (no pretty-printing) to `{{MANIFEST_PATH}}`:

```json
{"id":"{{TOPIC_SLUG}}-{{DATE}}","file":"{{DATE}}_{{TOPIC_SLUG}}.md","title":"{{RESEARCH_TITLE}}","date":"{{DATE}}","status":"complete","agent_type":"research","topics":{{TOPICS_JSON}},"key_findings":["Finding 1","Finding 2","Finding 3"],"actionable":true,"needs_followup":[],"linked_tasks":["{{EPIC_ID}}","{{TASK_ID}}"]}
```

### Field Guidelines

| Field | Guideline |
|-------|-----------|
| `key_findings` | 3-7 one-sentence findings, action-oriented |
| `actionable` | `true` if findings require implementation work |
| `needs_followup` | Task IDs requiring attention based on findings |
| `topics` | 2-5 categorization tags for discoverability |

---

## Completion Checklist

- [ ] Task details read via `{{TASK_SHOW_CMD}}`
- [ ] Research conducted across multiple sources
- [ ] Findings synthesized with recommendations
- [ ] Output file written to `{{OUTPUT_DIR}}/`
- [ ] Manifest entry appended (single line, valid JSON)
- [ ] Task completed via `{{TASK_COMPLETE_CMD}}`
- [ ] Response is ONLY the summary message

---

## Error Handling

### Partial Research

If complete answers cannot be found:

1. Document what was found
2. Note gaps and why they exist
3. Set manifest `"status": "partial"`
4. Add suggestions for followup to `needs_followup`
5. Complete task
6. Return: "Research partial. See MANIFEST.jsonl for details."

### Blocked Research

If research cannot proceed (access denied, topic too broad, etc.):

1. Document blocking reason
2. Set manifest `"status": "blocked"`
3. Add blocker details to `needs_followup`
4. Do NOT complete task
5. Return: "Research blocked. See MANIFEST.jsonl for blocker details."

---

## Quality Standards

### Findings Quality

- **Evidence-based** - Every claim has a source
- **Current** - Prefer recent sources (within 1-2 years)
- **Relevant** - Directly addresses research questions
- **Actionable** - Clear path from finding to action

### Recommendation Quality

- **Specific** - Concrete actions, not vague suggestions
- **Prioritized** - Most important first
- **Justified** - Tied to specific findings
- **Feasible** - Achievable within project constraints
