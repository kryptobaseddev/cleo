# Orchestrator Protocol Guide

**Version**: 2.0.0
**Status**: Active
**Last Updated**: 2026-01-19

## Overview

The Orchestrator Protocol enables complex multi-agent workflows where a single
HITL-facing agent (the "orchestrator") delegates all detailed work to subagents
while protecting its own context window.

### When to Use

| Scenario | Use Orchestrator? | Rationale |
|----------|-------------------|-----------|
| Multi-task epic (5+ tasks) | Yes | Dependency coordination, parallel safety |
| Research-heavy project | Yes | Manifest summaries preserve context |
| Long-running session (>100K tokens) | Yes | Context protection via delegation |
| Single quick task | No | Direct execution is faster |
| Simple bug fix | No | Overhead not justified |

## Activation

### Via Skill (Recommended)

The skill-based approach is **strongly recommended** over CLAUDE.md injection:

```bash
# Natural language triggers:
# - "activate orchestrator mode"
# - "run as orchestrator"
# - "orchestrate this workflow"

# Or via Skill tool directly:
Skill: orchestrator
```

**Why skill-based?**

| Problem with CLAUDE.md | Skill-based solution |
|------------------------|---------------------|
| ALL agents read CLAUDE.md | Skills load ON-DEMAND |
| Subagents ALSO try to orchestrate | Subagents do NOT inherit skills |
| Breaks delegation pattern | Only HITL session operates as orchestrator |
| Always loaded (context overhead) | Loaded when needed |

### Via CLI (Project Installation)

Install the orchestrator skill to your project:

```bash
cleo orchestrator skill --install    # Copy skill to .cleo/skills/
cleo orchestrator skill --verify     # Verify installation
```

### Legacy: CLAUDE.md Injection (DEPRECATED)

> **WARNING**: The CLAUDE.md injection approach is deprecated.
> See `templates/orchestrator-protocol/ORCHESTRATOR-INJECT.md` for migration guidance.

## Core Concepts

### Immutable Constraints

Every orchestrator MUST follow these rules:

| Rule | Constraint | Rationale |
|------|------------|-----------|
| ORC-001 | MUST stay high-level; MUST NOT implement code | Context preservation |
| ORC-002 | MUST delegate ALL work to subagents | Separation of concerns |
| ORC-003 | MUST NOT read full research files (>100 lines) | Token efficiency |
| ORC-004 | MUST spawn agents in dependency order | Avoid wasted work |
| ORC-005 | MUST use manifest for research summaries | O(1) lookup |

**Mantra**: Stay high-level. Delegate everything. Read only manifests. Spawn in order.

### Manifest-Based Handoff

Subagents communicate via `MANIFEST.jsonl`:

```json
{
  "id": "topic-slug-2026-01-18",
  "file": "2026-01-18_topic-slug.md",
  "title": "Descriptive Title",
  "date": "2026-01-18",
  "status": "complete",
  "topics": ["topic1", "topic2"],
  "key_findings": [
    "Finding 1: One sentence summary",
    "Finding 2: Another key insight"
  ],
  "actionable": true,
  "needs_followup": ["T1234"],
  "linked_tasks": ["T1000", "T1234"]
}
```

Key fields:
- `key_findings`: 3-7 items, one sentence each (orchestrator reads these)
- `needs_followup`: Task IDs requiring subsequent agents
- `linked_tasks`: Bidirectional links to CLEO tasks

## Quick Start

### 1. Activate Orchestrator Mode

**Option A: Skill-based (Recommended)**
```bash
# Say "activate orchestrator mode" or use Skill tool
```

**Option B: Install to project**
```bash
cleo orchestrator skill --install
```

### 2. Start an Orchestrator Session

```bash
# Initialize and get startup state
cleo orchestrator start --epic T1575

# Check pending work from previous sessions
cleo orchestrator status
```

### 3. Spawn Subagents

```bash
# Get next task to spawn
cleo orchestrator next --epic T1575

# Generate spawn command with prompt
cleo orchestrator spawn T1586

# Or spawn with specific template
cleo orchestrator spawn T1586 --template RESEARCH-AGENT
```

## Session Startup Protocol

Execute this sequence at conversation start:

```bash
# 1. Check active sessions
cleo session list --status active

# 2. Check manifest for pending work
cat docs/claudedocs/research-outputs/MANIFEST.jsonl | jq -s '[.[] | select(.needs_followup | length > 0)]'

# 3. Check focused task
cleo focus show

# 4. Review epic status
cleo dash --compact
```

### Decision Matrix

| Condition | Action |
|-----------|--------|
| Active session + focus | Resume; continue focused task |
| Active session, no focus | Query manifest needs_followup; spawn next |
| No session + manifest has followup | Create session; spawn for followup |
| No session + no followup | Ask user for direction |

## Subagent Requirements

Every subagent MUST follow this protocol:

### Output Requirements

1. **MUST** write findings to: `docs/claudedocs/research-outputs/YYYY-MM-DD_{topic-slug}.md`
2. **MUST** append ONE line to: `docs/claudedocs/research-outputs/MANIFEST.jsonl`
3. **MUST** return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. **MUST NOT** return research content in response

### CLEO Integration

1. **MUST** read task details: `cleo show <task-id>`
2. **MUST** set focus: `cleo focus set <task-id>`
3. **MUST** complete task when done: `cleo complete <task-id>`
4. **SHOULD** link research: `cleo research link <task-id> <research-id>`

### Injection Block

Include this in every spawn prompt:

```markdown
## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

OUTPUT REQUIREMENTS:
1. MUST write findings to: docs/claudedocs/research-outputs/YYYY-MM-DD_{topic-slug}.md
2. MUST append ONE line to: docs/claudedocs/research-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

CLEO INTEGRATION:
1. MUST read task details: `cleo show <task-id>`
2. MUST set focus: `cleo focus set <task-id>`
3. MUST complete task when done: `cleo complete <task-id>`
4. SHOULD link research: `cleo research link <task-id> <research-id>`
```

## Manifest Operations

### Query Patterns

```bash
# Latest entry
jq -s '.[-1]' MANIFEST.jsonl

# Pending followups
jq -s '[.[] | select(.needs_followup | length > 0)]' MANIFEST.jsonl

# By topic
jq -s '[.[] | select(.topics | contains(["auth"]))]' MANIFEST.jsonl

# Actionable items
jq -s '[.[] | select(.actionable)]' MANIFEST.jsonl

# Key findings for epic
jq -s '[.[] | select(.linked_tasks | contains(["T1575"])) | .key_findings] | flatten' MANIFEST.jsonl
```

### CLI Commands

```bash
# List research entries (context-efficient)
cleo research list
cleo research list --status complete --limit 10

# Get entry details
cleo research show <research-id>
cleo research show <research-id> --full  # Include file content

# Get pending followups
cleo research pending

# Link research to task
cleo research link T1234 research-id-2026-01-18

# Validate research links
cleo research links T1234
```

## Context Protection

### Budget Rules

| Rule | Constraint |
|------|------------|
| CTX-001 | MUST NOT read research files > 100 lines |
| CTX-002 | MUST use `cleo research list` over raw manifest |
| CTX-003 | MUST use `cleo show --brief` for task summaries |
| CTX-004 | Subagent MUST NOT return content in response |
| CTX-005 | Manifest key_findings: 3-7 items, one sentence each |

### Context Check

```bash
# Check current context usage
cleo orchestrator context

# With specific token count
cleo orchestrator context --tokens 5000
```

Exit codes:
- `0`: OK (<70%)
- `52`: Critical (>90%)

## Error Recovery

| Failure | Recovery |
|---------|----------|
| No output file | Re-spawn with clearer instructions |
| No manifest entry | Manual entry or rebuild |
| Task not completed | Orchestrator completes manually |
| Partial status | Spawn continuation agent |
| Blocked status | Flag for human review |

## Validation

```bash
# Full protocol validation
cleo orchestrator validate

# Validate for specific epic
cleo orchestrator validate --epic T1575

# Validate specific subagent output
cleo orchestrator validate --subagent research-id-2026-01-18

# Validate manifest only
cleo orchestrator validate --manifest

# Validate orchestrator compliance
cleo orchestrator validate --orchestrator
```

## Parallel Execution

### Check Task Independence

```bash
# Analyze dependency waves
cleo orchestrator analyze T1575

# Get parallel-safe tasks
cleo orchestrator ready --epic T1575

# Check if specific tasks can run in parallel
cleo orchestrator check T1578 T1580 T1582
```

### Wave-Based Execution

Tasks are grouped into waves based on dependencies:

- **Wave 0**: Tasks with no dependencies (can run in parallel)
- **Wave 1**: Tasks depending only on Wave 0 (can run in parallel)
- **Wave N**: Tasks depending on Wave N-1 or earlier

## Best Practices

### DO

- Query manifest summaries before spawning
- Check dependencies before each spawn
- Use templates for consistent subagent prompts
- Complete tasks via CLEO after subagent work
- Link research to tasks for traceability

### DON'T

- Read full research files as orchestrator
- Spawn agents out of dependency order
- Return research content in responses
- Skip manifest entries
- Implement code directly as orchestrator

## Related Documentation

- [CLI Reference: orchestrator](../commands/orchestrator.md)
- [Example Session](../examples/orchestrator-example-session.md)
- [Template Quick Start](../../templates/orchestrator-protocol/README.md)
- [Research Command Reference](../commands/research.md)
