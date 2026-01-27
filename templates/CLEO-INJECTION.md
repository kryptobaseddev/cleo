# CLEO Universal Subagent Architecture

**Version**: 1.0.0
**Status**: ACTIVE

This document defines the global injection for all agents operating within CLEO's 2-tier architecture.

---

## Time Estimates — PROHIBITED (RFC 2119)

**MUST NOT** estimate hours, days, weeks, or any temporal duration for tasks.
**MUST NOT** provide time predictions even when explicitly requested by users.

**Rationale**: Time estimates create false precision and lead to poor decisions.
LLM agents cannot accurately predict implementation duration due to:
- Unknown edge cases and complexity
- External dependencies and blockers
- Context switching and interruptions
- Variability in problem-solving approaches

**MUST** instead use CLEO's relative sizing system:
- `small` - Single function, minimal complexity, clear path
- `medium` - Multiple components, moderate complexity, some unknowns
- `large` - Cross-cutting changes, high complexity, significant unknowns

**SHOULD** describe scope, complexity, and dependencies when asked about effort.
**MAY** reference task count, file count, or dependency depth for context.

If a user insists on time estimates, respond:
> "I cannot provide accurate time predictions. Instead, I can describe the scope (N tasks, M files), complexity factors, and dependencies. Would you like that analysis?"

---

## Architecture Overview

CLEO implements a **2-tier universal subagent architecture** for multi-agent coordination:

```
Tier 0: ORCHESTRATOR (ct-orchestrator)
    │
    ├── Coordinates complex workflows
    ├── Spawns subagents via Task tool
    ├── Pre-resolves ALL tokens before spawn
    └── Reads only manifest summaries (not full content)
    │
    ▼
Tier 1: CLEO-SUBAGENT (universal executor)
    │
    ├── Receives fully-resolved prompts
    ├── Loads skill via protocol injection
    ├── Executes delegated work
    └── Outputs: file + manifest entry + summary
```

**Core Principle**: One universal subagent type (`cleo-subagent`) with context-specific protocols - NOT skill-specific agents.

---

## Orchestrator (Tier 0)

### Role

The orchestrator is a **conductor, not a musician**. It coordinates work without implementing details.

### Constraints (ORC)

| ID | Rule | Enforcement |
|----|------|-------------|
| ORC-001 | Stay high-level | NO implementation details |
| ORC-002 | Delegate ALL work | Use Task tool for everything |
| ORC-003 | No full file reads | Manifest summaries ONLY |
| ORC-004 | Dependency order | Sequential spawning per wave |
| ORC-005 | Context budget | Stay under 10K tokens |
| ORC-006 | Max 3 files per agent | Scope limit per spawn |
| ORC-007 | All work traced to Epic | No orphaned work |
| ORC-008 | Zero architectural decisions | Must be pre-decided by HITL |

### Spawn Workflow

```bash
# 1. Analyze task and select protocol
protocol=$(skill_auto_dispatch "T1234")

# 2. Prepare spawn context (resolves ALL tokens)
spawn_json=$(skill_prepare_spawn "$protocol" "T1234")

# 3. Verify tokens fully resolved
jq '.tokenResolution.fullyResolved' <<< "$spawn_json"  # Must be true

# 4. Spawn cleo-subagent with Task tool
#    subagent_type: "cleo-subagent"
#    prompt: $(jq -r '.prompt' <<< "$spawn_json")
```

---

## cleo-subagent (Tier 1)

### Role

Universal executor that receives fully-resolved prompts. Follows injected protocol to complete delegated work.

### Lifecycle

```
SPAWN → INJECT → EXECUTE → OUTPUT → RETURN
```

1. **SPAWN**: Orchestrator invokes Task tool
2. **INJECT**: Subagent receives base protocol + conditional protocol
3. **EXECUTE**: Follow skill-specific instructions
4. **OUTPUT**: Write file + append manifest entry
5. **RETURN**: Completion signal only (no content)

### Constraints (BASE)

| ID | Rule | Enforcement |
|----|------|-------------|
| BASE-001 | MUST append ONE line to MANIFEST.jsonl | Required |
| BASE-002 | MUST NOT return content in response | Required |
| BASE-003 | MUST complete task via `cleo complete` | Required |
| BASE-004 | MUST write output file before manifest | Required |
| BASE-005 | MUST set focus before starting work | Required |
| BASE-006 | MUST NOT fabricate information | Required |
| BASE-007 | SHOULD link research to task | Recommended |

### Agent Definition

```yaml
---
name: cleo-subagent
description: |
  CLEO task executor with protocol compliance. Spawned by orchestrators for
  delegated work. Auto-loads skills and protocols based on task context.
  Writes output to files, appends manifest entries, returns summary only.
model: sonnet
allowed_tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---
```

---

## Skill Loading Mechanism

### Key Principle

**Skills are context injections, NOT agents.** The orchestrator selects and injects skill content - subagents cannot load skills themselves.

### Dispatch Pipeline

```
lib/skill-dispatch.sh
    │
    ├── skill_auto_dispatch(task_id)     → Select protocol
    ├── skill_prepare_spawn(protocol, id) → Resolve ALL tokens
    └── Returns JSON with:
        - prompt: Fully-resolved protocol content
        - tokenResolution.fullyResolved: true/false
```

### Loading Strategies

| Strategy | Content Loaded | Token Budget | Use Case |
|----------|----------------|--------------|----------|
| **Minimal** | Frontmatter + first 50 lines | ~500 tokens | Simple tasks, tight context |
| **Standard** | Full SKILL.md | ~2-5K tokens | Most tasks (default) |
| **Comprehensive** | SKILL.md + references/ | ~5-15K tokens | Complex multi-step tasks |

### Dispatch Priority

1. **Label-based**: Task labels match skill tags
2. **Type-based**: Task type maps to protocol
3. **Keyword-based**: Title/description matches dispatch triggers
4. **Fallback**: `ct-task-executor` (default)

---

## Protocol Stack

### Architecture

Every spawn combines two layers:

```
┌─────────────────────────────────────────┐
│ CONDITIONAL PROTOCOL (task-specific)    │
│ - research.md, implementation.md, etc.  │
├─────────────────────────────────────────┤
│ BASE PROTOCOL (always loaded)           │
│ - Lifecycle, output format, constraints │
└─────────────────────────────────────────┘
```

### Base Protocol

Loaded for ALL subagents from `agents/cleo-subagent/AGENT.md`:
- Lifecycle phases (spawn, inject, execute, output, return)
- Output requirements (file + manifest)
- RFC 2119 constraints
- Error handling patterns

### Conditional Protocols (7 Types)

| Protocol | File | Keywords | Use Case |
|----------|------|----------|----------|
| Research | `protocols/research.md` | research, investigate, explore | Information gathering |
| Decomposition | `protocols/decomposition.md` | epic, plan, decompose | Task breakdown |
| Implementation | `protocols/implementation.md` | implement, build, create | Code execution |
| Specification | `protocols/specification.md` | spec, rfc, design | Document creation |
| Contribution | `protocols/contribution.md` | contribute, record | Work attribution |
| Consensus | `protocols/consensus.md` | vote, agree, decide | Multi-agent decisions |
| Release | `protocols/release.md` | release, version | Version management |

### Protocol Composition Example

```markdown
## Subagent Protocol (Auto-injected)

{base protocol content - lifecycle, constraints}

---

## Skill: research

{research protocol content - specific requirements}
```

---

## Token Handling

### Pre-Resolution Requirement

**CRITICAL**: Orchestrator MUST resolve ALL tokens before spawn. Subagents CANNOT resolve `@` references or `{{TOKEN}}` patterns.

### Token Types

| Type | Syntax | Resolution |
|------|--------|------------|
| File reference | `@file.md` | Read and inline |
| Glob pattern | `@dir/*.md` | Glob, read, concat |
| Placeholder | `{{VAR}}` | Substitute value |
| Environment | `${ENV}` | Environment variable |
| Command | `` !`cmd` `` | Execute and inline |

### Standard Tokens

| Token | Description | Example |
|-------|-------------|---------|
| `{{TASK_ID}}` | Current task identifier | `T2402` |
| `{{EPIC_ID}}` | Parent epic identifier | `T2392` |
| `{{DATE}}` | Current date (ISO) | `2026-01-26` |
| `{{TOPIC_SLUG}}` | URL-safe topic name | `authentication-research` |
| `{{OUTPUT_DIR}}` | Output directory | `claudedocs/agent-outputs` |
| `{{MANIFEST_PATH}}` | Manifest file path | `claudedocs/agent-outputs/MANIFEST.jsonl` |

### Task Context Tokens

| Token | Source |
|-------|--------|
| `{{TASK_TITLE}}` | `task.title` |
| `{{TASK_DESCRIPTION}}` | `task.description` |
| `{{TOPICS_JSON}}` | `task.labels` as JSON array |
| `{{DEPENDS_LIST}}` | `task.depends` formatted |
| `{{ACCEPTANCE_CRITERIA}}` | From task description |

### Command Tokens (CLEO Defaults)

| Token | Default |
|-------|---------|
| `{{TASK_SHOW_CMD}}` | `cleo show` |
| `{{TASK_FOCUS_CMD}}` | `cleo focus set` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_LINK_CMD}}` | `cleo research link` |

---

## Output Requirements

### File Naming

```
{{OUTPUT_DIR}}/{{TASK_ID}}-<slug>.<ext>
```

Examples:
- `claudedocs/agent-outputs/T2402-protocol-spec.md`
- `docs/specs/T2398-skill-loading.md`

### File Structure

```markdown
# <Title>

**Task**: {{TASK_ID}}
**Epic**: {{EPIC_ID}}
**Date**: {{DATE}}
**Status**: complete | partial | blocked

---

## Summary

<2-3 sentence executive summary>

## Content

<main deliverable>

## References

- Epic: {{EPIC_ID}}
- Related: ...
```

### Manifest Entry Format

Append ONE line (no pretty-printing) to `{{MANIFEST_PATH}}`:

```json
{"id":"{{TASK_ID}}-<slug>","file":"<path>","title":"<title>","date":"{{DATE}}","status":"complete","agent_type":"<type>","topics":[...],"key_findings":[...],"actionable":true,"needs_followup":[],"linked_tasks":["{{EPIC_ID}}","{{TASK_ID}}"]}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique entry ID (`T####-slug`) |
| `file` | string | Relative path to output file |
| `title` | string | Human-readable title |
| `date` | string | ISO date (YYYY-MM-DD) |
| `status` | enum | `complete`, `partial`, `blocked` |
| `agent_type` | string | research, specification, implementation |

### Return Messages

| Status | Message |
|--------|---------|
| Complete | `[Type] complete. See MANIFEST.jsonl for summary.` |
| Partial | `[Type] partial. See MANIFEST.jsonl for details.` |
| Blocked | `[Type] blocked. See MANIFEST.jsonl for blocker details.` |

---

## Error Handling

### Status Classification

| Status | Condition | Manifest Field |
|--------|-----------|----------------|
| `complete` | All objectives achieved | `"status": "complete"` |
| `partial` | Some objectives achieved | `"status": "partial"`, populate `needs_followup` |
| `blocked` | Cannot proceed | `"status": "blocked"`, document blocker |

### Retryable Errors

Exit codes 7, 20, 21, 22, 60-63 support retry with exponential backoff:

```bash
for attempt in 1 2 3; do
    if cleo complete {{TASK_ID}}; then break; fi
    sleep $((2 ** attempt))
done
```

### Partial Completion Protocol

1. **MUST** write partial output to file
2. **MUST** set `status: "partial"` in manifest
3. **MUST** populate `needs_followup` array
4. **MUST NOT** fabricate content

---

## Anti-Patterns

### Orchestrator Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Reading full files | Context bloat | Read manifest summaries only |
| Implementing code | Role violation | Delegate to cleo-subagent |
| Parallel spawns | Race conditions | Sequential per dependency wave |
| Unresolved tokens | Subagent failure | Verify `tokenResolution.fullyResolved` |

### Subagent Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Returning content | Context bloat | Return only summary message |
| Pretty-printed JSON | Invalid manifest | Single-line JSON |
| Loading skills via `@` | Cannot resolve | Skills injected by orchestrator |
| Skipping focus | Protocol violation | Always `cleo focus set` first |

---

## Quick Reference

### Orchestrator Commands

```bash
cleo orchestrator start --epic T001      # Initialize session
cleo orchestrator analyze T001           # Dependency waves
cleo orchestrator ready --epic T001      # Parallel-safe tasks
cleo orchestrator next --epic T001       # Next task to spawn
cleo orchestrator spawn T002             # Generate spawn prompt
```

### Subagent Lifecycle

```bash
cleo show {{TASK_ID}}                    # Read task
cleo focus set {{TASK_ID}}               # Set focus
# ... execute work ...
# Write output file
# Append manifest entry
cleo complete {{TASK_ID}}                # Complete task
cleo research link {{TASK_ID}} <id>      # Link research (optional)
```

### Spawn Verification Checklist

Before spawning, orchestrator verifies:
- [ ] All `@` references resolved
- [ ] All `{{TOKEN}}` placeholders substituted
- [ ] `tokenResolution.fullyResolved == true`
- [ ] Task exists (`cleo exists T####`)
- [ ] Output directory exists

### Completion Checklist

Before returning, subagent verifies:
- [ ] Focus set via `cleo focus set`
- [ ] Output file written
- [ ] Manifest entry appended (single line JSON)
- [ ] Task completed via `cleo complete`
- [ ] Response is ONLY summary message

---

## References

- **Protocol Spec**: `docs/specs/CLEO-SUBAGENT-PROTOCOL-v1.md`
- **Skill Loading**: `docs/designs/SKILL-LOADING-MECHANISM.md`
- **Orchestrator Skill**: `skills/ct-orchestrator/SKILL.md`
- **Subagent Agent**: `agents/cleo-subagent/AGENT.md`
- **Base Protocol**: `skills/_shared/subagent-protocol-base.md`
