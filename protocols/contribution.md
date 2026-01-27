# Contribution Protocol

**Version**: 1.0.0
**Type**: Conditional Protocol
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Shared File Modification | Modifying CLAUDE.md, AGENTS.md, shared configs | Multi-session files |
| PR Creation | "pull request", "PR", "merge request" | Code review workflow |
| Cross-Session Work | Multiple agents on same epic | Coordination needed |
| Audit Trail | Provenance, attribution, tracking | Accountability |

**Explicit Override**: `--protocol contribution` flag on task creation.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| CONT-001 | MUST follow commit message conventions |
| CONT-002 | MUST include provenance tags in code comments |
| CONT-003 | MUST pass all validation gates before merge |
| CONT-004 | MUST document decisions with rationale |
| CONT-005 | MUST flag conflicts with other sessions |
| CONT-006 | MUST write contribution record to manifest |
| CONT-007 | MUST set `agent_type: "implementation"` in manifest |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| CONT-010 | SHOULD include test coverage for changes |
| CONT-011 | SHOULD link to related tasks and research |
| CONT-012 | SHOULD document rejected alternatives |
| CONT-013 | SHOULD request review for significant changes |

### MAY

| Requirement | Description |
|-------------|-------------|
| CONT-020 | MAY batch related changes into single contribution |
| CONT-021 | MAY defer documentation updates |
| CONT-022 | MAY propose follow-up improvements |

---

## Output Format

### Commit Message Format

```
<type>(<scope>): <summary>

<body>

<footer>

Co-Authored-By: <agent-id> <noreply@anthropic.com>
Task: T####
Session: session_YYYYMMDD_HHMMSS_######
```

**Types**: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`

### Provenance Tag Format

```javascript
/**
 * @task T####
 * @session session_YYYYMMDD_HHMMSS_######
 * @agent opus-1
 * @date YYYY-MM-DD
 */
```

```bash
# Task: T####
# Session: session_YYYYMMDD_HHMMSS_######
# Agent: opus-1
```

### Contribution Record

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/contribution.schema.json",
  "_meta": {
    "contributionId": "contrib_a1b2c3d4",
    "createdAt": "2026-01-26T14:00:00Z",
    "agentId": "opus-1"
  },
  "sessionId": "session_20260126_140000_abc123",
  "epicId": "T2308",
  "taskId": "T2315",
  "markerLabel": "feature-contrib",
  "decisions": [
    {
      "questionId": "IMPL-001",
      "question": "Decision made during implementation",
      "answer": "Concrete decision value",
      "confidence": 0.85,
      "rationale": "Why this decision",
      "evidence": [{"file": "path", "section": "name", "type": "code"}]
    }
  ],
  "conflicts": [],
  "status": "complete"
}
```

### Validation Gates

| Gate | Check | Required |
|------|-------|----------|
| Schema | JSON Schema validation | MUST pass |
| Tests | All tests pass | MUST pass |
| Lint | Code style compliance | SHOULD pass |
| Security | No secrets committed | MUST pass |
| Conflicts | No unresolved conflicts | MUST resolve |

### File Output

```markdown
# Contribution: {Title}

**Task**: T####
**Date**: YYYY-MM-DD
**Status**: complete|partial|blocked
**Agent Type**: implementation

---

## Summary

{2-3 sentence summary of contribution}

## Changes

### Files Modified

| File | Type | Lines Changed |
|------|------|---------------|
| {path} | {added|modified|deleted} | +X/-Y |

### Decisions Made

| ID | Decision | Rationale |
|----|----------|-----------|
| IMPL-001 | {Decision} | {Why} |

## Validation Results

| Gate | Status | Notes |
|------|--------|-------|
| Tests | Pass | All 42 tests pass |
| Lint | Pass | No warnings |
| Schema | Pass | Valid JSON |

## Conflicts

{If any, document with resolution}

## Review Checklist

- [ ] Code follows style guide
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] No breaking changes (or documented)
```

### Manifest Entry

```json
{"id":"T####-contrib-slug","file":"YYYY-MM-DD_contribution.md","title":"Contribution: Feature Name","date":"YYYY-MM-DD","status":"complete","agent_type":"implementation","topics":["contribution","feature"],"key_findings":["3 files modified","Tests passing","No conflicts"],"actionable":false,"needs_followup":[],"linked_tasks":["T####"]}
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
| implementation | Contribution tracks implementation work |
| consensus | Consensus resolves contribution conflicts |
| release | Contribution records feed release notes |

### Conflict Detection

| Conflict Type | Detection | Resolution |
|---------------|-----------|------------|
| Same file edit | File path collision | Merge or choose |
| Semantic conflict | Decision contradiction | Consensus protocol |
| Dependency conflict | Breaking change | Escalate to HITL |

---

## Example

**Task**: Implement session binding for multi-agent support

**Commit**:
```
feat(session): Add session binding for multi-agent support

Implements session isolation per agent with TTY binding
for terminal-based sessions and env var fallback for
headless operations.

- Add session binding file management
- Implement CLEO_SESSION env var support
- Add session switch command

Co-Authored-By: opus-1 <noreply@anthropic.com>
Task: T2315
Session: session_20260126_140000_abc123
```

**Manifest Entry**:
```json
{"id":"T2315-session-binding","file":"2026-01-26_session-binding.md","title":"Contribution: Session Binding","date":"2026-01-26","status":"complete","agent_type":"implementation","topics":["session","multi-agent","binding"],"key_findings":["TTY binding implemented","Env var fallback added","4 new tests"],"actionable":false,"needs_followup":[],"linked_tasks":["T2315","T2308"]}
```

---

## Anti-Patterns

| Pattern | Why Avoid |
|---------|-----------|
| Committing without provenance | Breaks audit trail |
| Skipping validation gates | Quality regression |
| Ignoring conflicts | Creates merge debt |
| Large unfocused commits | Hard to review/revert |
| Missing decision documentation | Lost context |

---

*Protocol Version 1.0.0 - Contribution Protocol*
