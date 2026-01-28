# Research Protocol

**Version**: 1.0.0
**Type**: Conditional Protocol
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Investigation | "research", "investigate", "explore", "study" | Information gathering |
| Analysis | "analyze", "compare", "evaluate", "assess" | Data synthesis |
| Discovery | "find out", "discover", "learn about" | New information |
| Documentation | "document findings", "report on" | Structured output |

**Explicit Override**: `--protocol research` flag on task creation.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| RSCH-001 | MUST NOT implement code or make changes to codebase |
| RSCH-002 | MUST document all sources with citations |
| RSCH-003 | MUST write findings to `claudedocs/agent-outputs/` |
| RSCH-004 | MUST append entry to `MANIFEST.jsonl` |
| RSCH-005 | MUST return only completion message (no content in response) |
| RSCH-006 | MUST include 3-7 key findings in manifest entry |
| RSCH-007 | MUST set `agent_type: "research"` in manifest |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| RSCH-010 | SHOULD use multiple independent sources |
| RSCH-011 | SHOULD cross-reference findings for accuracy |
| RSCH-012 | SHOULD include confidence levels for claims |
| RSCH-013 | SHOULD identify gaps or areas needing further research |
| RSCH-014 | SHOULD link research to relevant tasks |

### MAY

| Requirement | Description |
|-------------|-------------|
| RSCH-020 | MAY propose follow-up research tasks |
| RSCH-021 | MAY include visual diagrams or tables |
| RSCH-022 | MAY compare multiple approaches or solutions |

---

## Output Format

### File Output

```markdown
# {Research Title}

**Task**: T####
**Date**: YYYY-MM-DD
**Status**: complete|partial|blocked
**Agent Type**: research

---

## Executive Summary

{2-3 sentence summary of findings}

## Research Questions

1. {Question 1}
2. {Question 2}

## Findings

### {Topic 1}

{Detailed findings with citations}

### {Topic 2}

{Detailed findings with citations}

## Sources

| Source | Type | Relevance |
|--------|------|-----------|
| {Source 1} | {documentation|code|external} | {High|Medium|Low} |

## Recommendations

1. {Actionable recommendation 1}
2. {Actionable recommendation 2}

## Open Questions

- {Unresolved question or gap}
```

### Manifest Entry

```json
{"id":"T####-research-slug","file":"YYYY-MM-DD_topic.md","title":"Research Title","date":"YYYY-MM-DD","status":"complete","agent_type":"research","topics":["topic1","topic2"],"key_findings":["Finding 1","Finding 2","Finding 3"],"actionable":true,"needs_followup":[],"linked_tasks":["T####"]}
```

---

## Integration Points

### Base Protocol

- Inherits task lifecycle (focus, execute, complete)
- Inherits manifest append requirement
- Inherits error handling patterns

### Protocol Interactions

| Combined With | Behavior |
|---------------|----------|
| specification | Research informs spec decisions |
| decomposition | Research identifies task structure |
| consensus | Research provides evidence for voting |

### Handoff Patterns

| Scenario | Handoff Target |
|----------|----------------|
| Research identifies implementation need | implementation protocol |
| Research reveals design decisions needed | specification protocol |
| Research requires expert validation | consensus protocol |

---

## Example

**Task**: Research authentication patterns for CLEO plugin system

**Manifest Entry**:
```json
{"id":"T2398-auth-patterns","file":"2026-01-26_auth-patterns.md","title":"Authentication Patterns Research","date":"2026-01-26","status":"complete","agent_type":"research","topics":["authentication","plugins","security"],"key_findings":["OAuth2 is standard for plugin auth","Token refresh needed for long sessions","Rate limiting prevents abuse"],"actionable":true,"needs_followup":["T2400"],"linked_tasks":["T2398","T2392"]}
```

**Return Message**:
```
Research complete. See MANIFEST.jsonl for summary.
```

---

## Enforcement

### Tool Allowlist

**Allowed Tools** (Read-only operations):
- `Read` - File reading
- `Grep` - Content search
- `Glob` - File pattern matching
- `Bash` - **Read-only commands only** (ls, cat, grep, find, etc.)

**Prohibited Tools**:
- `Write` - File writing
- `Edit` - File modification
- **Any** code compilation or execution

**Rationale**: Research must remain read-only to prevent contamination of implementation tasks.

### Validation Command

**Command** (planned): `cleo research validate [--task TASK_ID]`

**Current State**: Available via `validate_research_protocol()` in `lib/protocol-validation.sh`

```bash
# Programmatic validation
source lib/protocol-validation.sh
result=$(validate_research_protocol "T1234" "$manifest_entry" "false")
```

**Checks**:
- RSCH-001: No code changes in git diff
- RSCH-004: Manifest entry appended
- RSCH-006: 3-7 key findings
- RSCH-007: agent_type = "research"

### Orchestrator Integration

**Pre-Spawn Validation**:
```bash
# In lib/orchestrator-spawn.sh Step 6.5
protocol_type=$(_osp_skill_to_protocol "ct-research-agent")  # Returns "research"
validate_research_protocol "$task_id" "$manifest_entry" "false"
# Blocks spawn on MUST violations with EXIT_PROTOCOL_RESEARCH (60)
```

**Post-Completion Verification**:
- Git diff analysis detects code modifications
- Manifest parsing validates key_findings count
- Agent type verification

### Exit Codes

- `EXIT_PROTOCOL_RESEARCH` (60) - Research protocol violation
- Common violations: Code changes detected, wrong agent_type, insufficient findings

---

## Anti-Patterns

| Pattern | Why Avoid |
|---------|-----------|
| Implementing code during research | Pollutes research context, mixes concerns |
| Returning findings in response | Wastes orchestrator context |
| Single-source conclusions | Risk of bias or error |
| Vague findings without evidence | Not actionable |
| Skipping manifest entry | Breaks orchestrator workflow |

---

*Protocol Version 1.0.0 - Research Protocol*
