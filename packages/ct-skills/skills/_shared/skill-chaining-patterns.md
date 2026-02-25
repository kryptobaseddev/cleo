# Skill Chaining Patterns

This reference defines patterns for multi-level skill invocation and context propagation across agent boundaries.

---

## Pattern Overview

| Pattern | Description | Use Case |
|---------|-------------|----------|
| Single-level | Orchestrator spawns one skill | Simple task delegation |
| Skill chaining | Skill invokes other skills | Workflow orchestration |
| Multi-level | Subagent becomes orchestrator | Complex nested workflows |

---

## Pattern 1: Single-Level Spawning

The orchestrator delegates work to a subagent via Task tool with skill injection.

### Flow

```
┌─────────────────┐
│   ORCHESTRATOR  │
│  (ct-orchestrator)
└────────┬────────┘
         │ Task tool + skill template
         ▼
┌─────────────────┐
│    SUBAGENT     │
│ (ct-research-agent)
└─────────────────┘
```

### Implementation

```bash
# Orchestrator prepares context
source lib/token-inject.sh
export TI_TASK_ID="T1234"
export TI_DATE="$(date +%Y-%m-%d)"
export TI_TOPIC_SLUG="auth-research"
ti_set_defaults

# Load skill template with tokens
template=$(ti_load_template "skills/ct-research-agent/SKILL.md")

# Spawn via Task tool (includes subagent protocol block)
```

### Context Propagation

- **Input**: Task ID, skill template, previous manifest key_findings
- **Output**: Manifest entry with key_findings for next agent
- **Response**: "Research complete. See MANIFEST.jsonl for summary."

---

## Pattern 2: Skill Chaining

A skill invokes other skills to complete workflow phases. The loaded skill maintains context while delegating specialized work.

### Example: ct-documentor

```
┌─────────────────────┐
│   ct-documentor     │ ← Loaded by user request
│  (Documentation     │
│   Specialist)       │
└─────────┬───────────┘
          │
    ┌─────┴─────┬────────────┐
    ▼           ▼            ▼
┌───────┐  ┌────────┐  ┌─────────┐
│lookup │  │ write  │  │ review  │
│(Phase │  │(Phase  │  │(Phase   │
│   1)  │  │   3)   │  │   4)    │
└───────┘  └────────┘  └─────────┘
```

### Skill Invocation Methods

```markdown
# Via Skill tool (programmatic)
Skill(skill="ct-docs-lookup")
Skill(skill="ct-docs-write")
Skill(skill="ct-docs-review")

# Via slash command (user-facing)
/ct-docs-lookup
/ct-docs-write
/ct-docs-review
```

### When to Use Skill Chaining

| Scenario | Pattern |
|----------|---------|
| Workflow has distinct phases | Chain skills for each phase |
| Skills share common context | Parent skill maintains state |
| Quality gates between phases | Invoke review skill before completion |
| Specialized expertise needed | Delegate to domain-specific skill |

### Context Management

**Within skill chain (same agent)**:
- Skills share the agent's context window
- State persists between skill invocations
- No manifest needed for internal handoffs

**Across agent boundaries**:
- Use manifest for key_findings only
- Write detailed output to files
- Return minimal response to preserve parent context

---

## Pattern 3: Multi-Level Orchestration

A subagent can itself become an orchestrator, spawning further subagents for complex nested workflows.

### Flow

```
┌─────────────────────┐
│    ORCHESTRATOR     │  Level 0: Main workflow
│   (ct-orchestrator) │
└─────────┬───────────┘
          │ Task tool
          ▼
┌─────────────────────┐
│ SUB-ORCHESTRATOR    │  Level 1: Epic decomposition
│ (ct-epic-architect) │
└─────────┬───────────┘
          │ Task tool
          ▼
┌─────────────────────┐
│    WORKER AGENT     │  Level 2: Task execution
│ (ct-task-executor)  │
└─────────────────────┘
```

### Guidelines for Multi-Level

1. **Depth limit**: SHOULD NOT exceed 3 levels (diminishing returns)
2. **Context budget**: Each level MUST stay under 10K tokens
3. **Manifest propagation**: Each level writes to shared manifest
4. **Response contract**: Each level returns only summary message

### When Multi-Level is Appropriate

| Use Case | Levels | Structure |
|----------|--------|-----------|
| Simple research | 1 | Orchestrator → Researcher |
| Epic planning | 2 | Orchestrator → Architect → Executor |
| Complex pipeline | 3 | Orchestrator → Coordinator → Workers |

---

## Context Boundary Rules

### Rule 1: Manifest for Handoffs (MUST)

```json
// Subagent appends ONE line to MANIFEST.jsonl
{"id":"topic-2026-01-20","key_findings":["Finding 1","Finding 2"],"needs_followup":["T1235"]}
```

Parent reads only key_findings, not full research files.

### Rule 2: Minimal Response (MUST)

```
Subagent MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
Subagent MUST NOT return research content in response.
```

### Rule 3: File-Based Details (MUST)

Detailed findings go to output files, not manifest or response:
- Full analysis → `{{OUTPUT_DIR}}/YYYY-MM-DD_topic.md`
- Summary only → `MANIFEST.jsonl` key_findings array

### Rule 4: Token Injection (SHOULD)

Use `lib/token-inject.sh` for dynamic token replacement:

```bash
# Required tokens for all subagents
TI_TASK_ID    # Current task identifier
TI_DATE       # Execution date (YYYY-MM-DD)
TI_TOPIC_SLUG # URL-safe topic name
```

---

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Reading full files at parent | Context explosion | Use manifest key_findings |
| Returning research content | Context bloat | Return summary message only |
| Parallel subagent spawning | Race conditions | Sequential spawning only |
| Deep nesting (4+ levels) | Coordination overhead | Flatten to 3 levels max |
| Skipping manifest entry | Lost handoff | Always append manifest |

---

## Implementation Checklist

Before spawning subagent:
- [ ] Identify appropriate skill for task type
- [ ] Prepare token context (TI_TASK_ID, TI_DATE, TI_TOPIC_SLUG)
- [ ] Load skill template with `ti_load_template()`
- [ ] Include subagent protocol block in prompt

Before chaining to another skill:
- [ ] Determine if skill shares context (same agent) or needs delegation
- [ ] For same-agent: Use `Skill(skill="name")` or `/skill-name`
- [ ] For new agent: Use Task tool with full protocol injection

Before completion:
- [ ] Verify manifest entry appended
- [ ] Confirm output file written
- [ ] Return ONLY the summary message

---

## Reference Skills

| Skill | Demonstrates |
|-------|--------------|
| `ct-orchestrator` | Single-level spawning via Task tool |
| `ct-documentor` | Skill chaining (lookup → write → review) |
| `ct-epic-architect` | Potential multi-level orchestration |

See also:
- @skills/_shared/subagent-protocol-base.md
- @skills/_shared/task-system-integration.md
