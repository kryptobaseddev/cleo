# CLEO Subagent Protocol Specification v1

**Version**: 1.0.0
**Status**: DRAFT
**Date**: 2026-01-26
**Epic**: T2392 (CLEO Universal Subagent Architecture)

---

## 1. Overview

This specification defines the protocol for CLEO subagent spawning, execution, and output handling. The protocol enables orchestrators to delegate work to specialized subagents while maintaining context efficiency and consistent output formats.

### 1.1 Scope

- Base protocol structure for subagent lifecycle
- Skill injection patterns and token resolution
- Output requirements and manifest integration
- Error handling and recovery patterns

### 1.2 Terminology (RFC 2119)

| Term | Definition |
|------|------------|
| Orchestrator | Parent agent spawning subagents via Task tool |
| Subagent | Spawned agent executing delegated work |
| Skill | Loadable capability from plugin system |
| Manifest | JSONL registry of agent outputs |

---

## 2. Base Protocol Structure

### 2.1 Subagent Lifecycle

```
SPAWN → INJECT → EXECUTE → OUTPUT → RETURN
  │        │         │        │        │
  └─ Task tool invocation      │        │
           └─ Skill/token resolution    │
                      └─ Work execution │
                               └─ Manifest + file write
                                          └─ Completion signal
```

### 2.2 Agent Frontmatter Requirements

Subagents registered via `agents/` directory **MUST** include YAML frontmatter:

```yaml
---
name: cleo-subagent         # REQUIRED: Unique identifier
description: |              # REQUIRED: Purpose description
  Executes delegated tasks with CLEO protocol compliance.
model: claude-sonnet-4-20250514  # OPTIONAL: Model override
tools:                      # REQUIRED: Allowed tools
  - Read
  - Write
  - Bash
  - Glob
  - Grep
skills:                     # OPTIONAL: Skills to inject
  - ct-research-agent
  - ct-task-executor
allowed_commands:           # OPTIONAL: Permitted bash commands
  - cleo
  - git
---
```

**Required Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique agent identifier |
| `description` | string | Agent purpose and capabilities |
| `tools` | array | Allowed tool set |

**Optional Fields**:
| Field | Type | Default |
|-------|------|---------|
| `model` | string | Inherits from parent |
| `skills` | array | `[]` |
| `allowed_commands` | array | Inherits from parent |

### 2.3 System Prompt Structure

Subagent system prompts **MUST** follow this structure:

```markdown
## Task Context
{task_description}

## Protocol Requirements
{protocol_injection}

## Skill Context
{injected_skills}

## Output Requirements
{output_specification}
```

**Injection Order** (CRITICAL):
1. Task context (from orchestrator)
2. Protocol requirements (this specification)
3. Skill content (resolved skills)
4. Output requirements (manifest format)

---

## 3. Skill Injection Pattern

### 3.1 Core Principle

**Subagents do NOT inherit skills from parent context.** Skills **MUST** be explicitly listed in the agent's `skills` field or injected via the Task tool prompt.

### 3.2 Injection Methods

#### Method A: Agent Definition (Static)

Skills listed in agent frontmatter are injected at spawn:

```yaml
skills:
  - ct-research-agent
  - ct-task-executor
```

#### Method B: Task Prompt (Dynamic)

Orchestrator injects skill content directly in Task tool prompt:

```markdown
## Skill: ct-research-agent

{resolved skill content here}
```

### 3.3 Token Pre-Resolution

Subagents **CANNOT** resolve `@` references. Orchestrator **MUST** resolve all tokens before spawning:

| Token Type | Resolution Requirement |
|------------|----------------------|
| `@file.md` | Read and inline content |
| `@docs/*.md` | Glob, read, and inline |
| `${VAR}` | Substitute with value |
| `{{PLACEHOLDER}}` | Replace with concrete value |

**Example Pre-Resolution**:

```markdown
# Before (orchestrator context)
@docs/research-outputs/MANIFEST.jsonl

# After (subagent prompt)
{"id":"entry1",...}
{"id":"entry2",...}
```

### 3.4 Progressive Loading

For large skills, use 3-level progressive disclosure:

| Level | Content | Token Budget |
|-------|---------|--------------|
| L0 | Name + description | ~100 tokens |
| L1 | Full SKILL.md | ~2K tokens |
| L2 | Supporting files | Variable |

**Load Trigger**: Subagent requests deeper level via output signal.

---

## 4. Token Handling

### 4.1 CLEO Default Tokens

| Token | Default Value | Description |
|-------|---------------|-------------|
| `${CLEO_ROOT}` | `.cleo/` | Project CLEO directory |
| `${RESEARCH_DIR}` | `claudedocs/agent-outputs/` | Research output directory |
| `${MANIFEST_FILE}` | `claudedocs/agent-outputs/MANIFEST.jsonl` | Manifest location |
| `${SPECS_DIR}` | `docs/specs/` | Specification directory |

### 4.2 Resolution Order

1. Environment variables (`$VAR`)
2. CLEO defaults (above)
3. Task-specific overrides (from orchestrator)
4. Literal fallback (if no match)

### 4.3 Escaping Requirements

| Character | Escape Sequence | Context |
|-----------|-----------------|---------|
| `$` | `\$` | Bash notes/commands |
| `{` | `\{` | JSON in Markdown |
| `|` | `\|` | Table cells |

---

## 5. Output Requirements

### 5.1 Manifest Entry Format

Subagents **MUST** append exactly ONE line to `MANIFEST.jsonl`:

```json
{"id":"<task-id>-<slug>","file":"<relative-path>","title":"<title>","date":"<YYYY-MM-DD>","status":"complete","agent_type":"<type>","topics":[...],"key_findings":[...],"actionable":<bool>,"needs_followup":[...],"linked_tasks":[...]}
```

**Required Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique entry ID (`T####-slug` format) |
| `file` | string | Relative path from manifest directory |
| `title` | string | Human-readable title |
| `date` | string | ISO date (YYYY-MM-DD) |
| `status` | enum | `complete`, `partial`, `blocked` |
| `agent_type` | string | Category (research, specification, implementation) |

**Optional Fields**:

| Field | Type | Default |
|-------|------|---------|
| `topics` | array | `[]` |
| `key_findings` | array | `[]` |
| `actionable` | boolean | `true` |
| `needs_followup` | array | `[]` |
| `linked_tasks` | array | `[]` |

### 5.2 File Naming Convention

```
<category>/<TASK-ID>-<slug>.<ext>
```

**Examples**:
- `specs/CLEO-SUBAGENT-PROTOCOL-v1.md`
- `research/T2398-protocol-analysis.md`
- `implementations/T2400-skill-loader.sh`

### 5.3 Output File Structure

All output files **SHOULD** include:

```markdown
# <Title>

**Task**: T####
**Date**: YYYY-MM-DD
**Status**: complete|partial|blocked

---

## Summary

<executive summary in 2-3 sentences>

## Content

<main content>

## References

<links to related tasks, specs, or research>
```

---

## 6. Error Handling

### 6.1 Status Classification

| Status | Condition | Action |
|--------|-----------|--------|
| `complete` | All objectives achieved | Normal return |
| `partial` | Some objectives achieved | Document gaps in `needs_followup` |
| `blocked` | Cannot proceed | Document blockers, suggest alternatives |

### 6.2 Partial Completion Protocol

When subagent cannot complete all objectives:

1. **MUST** write partial output to file
2. **MUST** set status to `partial` in manifest
3. **MUST** populate `needs_followup` array
4. **MUST** return summary of completed vs remaining

**Manifest Example**:

```json
{"id":"T2398-partial","status":"partial","needs_followup":["skill-injection-testing","error-recovery-patterns"]}
```

### 6.3 Blocked Status Handling

When subagent encounters blocking condition:

1. **MUST** document blocker in manifest
2. **MUST NOT** fabricate content to appear complete
3. **SHOULD** suggest alternative approaches
4. **MAY** request orchestrator intervention

**Blocker Categories**:

| Category | Example | Recommended Action |
|----------|---------|-------------------|
| Missing context | Required file not provided | Request from orchestrator |
| Permission denied | Tool not allowed | Escalate to orchestrator |
| Resource unavailable | External service down | Retry with backoff |
| Ambiguous requirements | Conflicting instructions | Clarify before proceeding |

### 6.4 Retry and Recovery

**Retryable Errors** (exit codes 7, 20, 21, 22, 60-63):

```bash
# Exponential backoff pattern
for attempt in 1 2 3; do
    if cleo complete T####; then
        break
    fi
    sleep $((2 ** attempt))
done
```

**Non-Retryable Errors**:
- Validation failures (fix input, retry)
- Permission errors (escalate)
- Not found errors (verify task exists)

---

## 7. Orchestrator Integration

### 7.1 Task Tool Invocation

```javascript
{
  "tool": "Task",
  "subagent_type": "cleo-subagent",
  "prompt": "## Task Context\n...\n## Protocol\n...",
  "skills": ["ct-research-agent"]
}
```

### 7.2 Pre-Spawn Checklist

Orchestrator **MUST** verify before spawning:

- [ ] All `@` references resolved
- [ ] All tokens substituted
- [ ] Output directory exists
- [ ] Task ID is valid (`cleo exists T####`)
- [ ] Skills are available

### 7.3 Post-Return Processing

Orchestrator **SHOULD**:

1. Verify manifest entry exists
2. Link research to task (`cleo research link`)
3. Update task status (`cleo complete` or `cleo update`)
4. Process `needs_followup` items

---

## 8. Implementation Guidance

### 8.1 Minimum Viable Subagent

```markdown
---
name: cleo-basic-subagent
description: Minimal CLEO-compliant subagent
tools:
  - Read
  - Write
---

## Protocol Compliance

1. Read task context
2. Execute objective
3. Write output file
4. Append manifest entry
5. Return completion signal
```

### 8.2 Skill-Enhanced Subagent

```markdown
---
name: cleo-research-subagent
description: Research-capable CLEO subagent
tools:
  - Read
  - Write
  - WebSearch
  - mcp__tavily__tavily-search
skills:
  - ct-research-agent
---
```

### 8.3 Token Budget Guidelines

| Component | Budget | Notes |
|-----------|--------|-------|
| Task context | 2K tokens | From orchestrator |
| Protocol injection | 1K tokens | This spec summary |
| Skill content | 15K tokens | All skills combined |
| Working space | 80K tokens | Remaining context |

---

## 9. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-26 | Initial specification |

---

## 10. References

- T2394: Skill Loading Analysis
- T2395: Alternative Providers Analysis
- T2396: Plugin API Investigation
- T2397: Caching Strategy Research
- T2392: CLEO Universal Subagent Architecture (Epic)
