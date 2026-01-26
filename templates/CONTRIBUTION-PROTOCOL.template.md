# Agent Contribution Protocol for {{EPIC_ID}}

**Epic**: {{EPIC_ID}} - {{EPIC_TITLE}}
**Version**: {{VERSION}}
**Date**: {{DATE}}

---

## Purpose

This protocol ensures all agent sessions contributing to {{EPIC_ID}} produce outputs that can be consolidated, compared, and synthesized into a single authoritative consensus.

---

## Step 1: Create Your Task Group

```bash
cleo add "Session {{SESSION_LETTER}}: [Your Focus Area]" \
  --type task \
  --parent {{EPIC_ID}} \
  --priority high \
  --phase {{PHASE}} \
  --labels "session-{{SESSION_LETTER}},{{MARKER_LABEL}}" \
  --description "[Your session description with research scope]"
```

**Replace:**
- `{{SESSION_LETTER}}` with your session letter (B, C, D, etc.)
- `[Your Focus Area]` with your research scope

---

## Step 2: Document Your Research Outputs

In your task description, list ALL research files produced:

```markdown
## Research Outputs (N files)
- {{OUTPUT_DIR}}/{{DATE}}_filename-1.md
- {{OUTPUT_DIR}}/{{DATE}}_filename-2.md
```

Then add a note with file paths to trigger auto-detection:

```bash
cleo update TXXXX --notes "Research files:
{{OUTPUT_DIR}}/{{DATE}}_my-research.md
{{OUTPUT_DIR}}/{{DATE}}_my-analysis.md"
```

The auto-detection will link these files to your task.

---

## Step 3: Document Key Decisions

Your task description MUST include explicit conclusions on these questions:

### Required Decision Points

{{#each DECISION_QUESTIONS}}
| {{this.id}} | {{this.question}} | |
{{/each}}

### Decision Documentation Format

```markdown
## Key Decisions Made

{{#each DECISION_QUESTIONS}}
### {{this.id}}. {{this.question}}
**Decision**: [Your answer]
**Rationale**: [Why this decision]
**Evidence**: [Reference to research doc section]

{{/each}}
```

---

## Step 4: Flag Conflicts with {{BASELINE_SESSION}}

{{BASELINE_SESSION}} has established baseline decisions. Compare your conclusions:

| Question | {{BASELINE_SESSION}} Says | Your Session Says | Conflict? |
|----------|--------------------------|-------------------|-----------|
{{#each BASELINE_DECISIONS}}
| {{this.question}} | {{this.position}} | ? | Yes/No |
{{/each}}

For each conflict, add a note:

```bash
cleo update TXXXX --notes "CONFLICT with {{BASELINE_SESSION}}:
Question: [Decision topic]
{{BASELINE_SESSION}}: [Baseline position]
This session: [Your position]
Rationale: [Why we disagree]
Evidence: [Reference]
Suggested Resolution: [How to resolve]"
```

---

## Step 5: Complete Your Task

When all research is documented:

```bash
cleo complete TXXXX
```

---

## Critical Rules (RFC 2119)

### MUST

| ID | Requirement |
|----|-------------|
| CONTRIB-001 | Create a child task under {{EPIC_ID}} |
| CONTRIB-002 | Use label `{{MARKER_LABEL}}` on your task |
| CONTRIB-003 | List ALL research files in task description |
| CONTRIB-004 | Add notes with file paths for auto-linking |
| CONTRIB-005 | Document decisions on ALL key questions |
| CONTRIB-006 | Flag conflicts with {{BASELINE_SESSION}} explicitly |
| CONTRIB-007 | Include rationale and evidence for decisions |

### MUST NOT

| ID | Requirement |
|----|-------------|
| CONTRIB-008 | Make any code changes - planning only |
| CONTRIB-009 | Edit other sessions' research files |
| CONTRIB-010 | Skip conflict documentation |
| CONTRIB-011 | Use vague or ambiguous decision language |

### SHOULD

| ID | Requirement |
|----|-------------|
| CONTRIB-012 | Use consistent file naming: `YYYY-MM-DD_topic-slug.md` |
| CONTRIB-013 | Reference specific sections when citing evidence |
| CONTRIB-014 | Propose resolution for conflicts identified |
| CONTRIB-015 | Note uncertainty levels for tentative decisions |

---

## {{BASELINE_SESSION}} Reference

{{BASELINE_SESSION}} established these baseline decisions:

| Decision | {{BASELINE_SESSION}} Position |
|----------|------------------------------|
{{#each BASELINE_DECISIONS}}
| **{{this.question}}** | {{this.position}} |
{{/each}}

### {{BASELINE_SESSION}} Research Files

{{#each BASELINE_FILES}}
- `{{this}}`
{{/each}}

---

## Final Synthesis

After all sessions complete their contributions, task {{SYNTHESIS_TASK_ID}} will:

1. Read all session task groups
2. Identify all conflicts
3. Apply structured debate to resolve
4. Produce unified consensus document
5. Create implementation epic with no ambiguity

Your thorough documentation enables this synthesis.

---

*Protocol Version {{VERSION}} - {{DATE}}*

---

## Token Reference

### Required Tokens

| Token | Type | Description |
|-------|------|-------------|
| `{{EPIC_ID}}` | string | Epic task ID (e.g., T2204) |
| `{{EPIC_TITLE}}` | string | Epic title |
| `{{VERSION}}` | semver | Protocol version |
| `{{DATE}}` | date | Protocol date (YYYY-MM-DD) |
| `{{MARKER_LABEL}}` | string | Label for consensus discovery |
| `{{OUTPUT_DIR}}` | path | Research output directory |
| `{{BASELINE_SESSION}}` | string | Baseline session name |
| `{{DECISION_QUESTIONS}}` | array | Decision point objects |
| `{{BASELINE_DECISIONS}}` | array | Baseline position objects |

### Optional Tokens

| Token | Type | Default |
|-------|------|---------|
| `{{SESSION_LETTER}}` | char | Replaced by contributor |
| `{{PHASE}}` | string | `core` |
| `{{SYNTHESIS_TASK_ID}}` | string | Final synthesis task |
| `{{BASELINE_FILES}}` | array | Baseline research files |

### Array Structures

**`{{DECISION_QUESTIONS}}`**:
```json
[
  {"id": 1, "question": "Question text"}
]
```

**`{{BASELINE_DECISIONS}}`**:
```json
[
  {"question": "Topic", "position": "Baseline position"}
]
```
