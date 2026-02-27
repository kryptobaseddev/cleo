# CLEO 2-Tier Subagent Architecture

**Version**: 1.0.0
**Status**: Active
**Last Updated**: 2026-01-26

## Overview

The CLEO Universal Subagent Architecture implements a 2-tier system for multi-agent coordination, replacing per-skill subagent creation with a unified execution model. This document describes the architecture, skill loading mechanism, and protocol stack.

**The Mantra**: *One subagent type. Skills as context. Protocols as layers.*

## 2-Tier System Architecture

### Tier 0: Orchestrator (ct-orchestrator)

The HITL-facing coordinator that:
- Maintains high-level project context
- Delegates ALL work to subagents
- Reads only manifest summaries
- Enforces dependency order
- Protects its own context window

**Constraints (ORC-001 through ORC-005)**:

| ID | Rule | Description |
|----|------|-------------|
| ORC-001 | Stay high-level | No implementation details |
| ORC-002 | Delegate ALL work | Use Task tool for everything |
| ORC-003 | No full file reads | Manifest summaries only (>100 lines) |
| ORC-004 | Dependency order | No overlapping agents |
| ORC-005 | Context budget | Stay under 10K orchestrator tokens |

### Tier 1: cleo-subagent (Universal Executor)

A single, unified subagent type that:
- Receives skill as context injection
- Follows protocol stack consistently
- Writes to manifest (MANIFEST.jsonl)
- Returns standardized messages
- Integrates with CLEO task system
- Has access to MCP tools for browser automation and research

**Key Principle**: Skills define WHAT to do. Protocol defines HOW to report results.

### Agent Definition (Claude Code)

The cleo-subagent is defined in `.claude/agents/cleo-subagent.md` with these tools:

```yaml
---
name: cleo-subagent
description: |
  CLEO task executor with protocol compliance. Spawned by orchestrators for
  delegated work. Auto-loads skills and protocols based on task context.
  Writes output to files, appends manifest entries, returns summary only.
model: sonnet
tools:
  # Core file operations
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  # Web access
  - WebFetch
  - WebSearch
  # Browser automation (claude-in-chrome MCP)
  - mcp__claude-in-chrome__tabs_context_mcp
  - mcp__claude-in-chrome__tabs_create_mcp
  - mcp__claude-in-chrome__navigate
  - mcp__claude-in-chrome__computer
  - mcp__claude-in-chrome__read_page
  - mcp__claude-in-chrome__find
  - mcp__claude-in-chrome__form_input
  - mcp__claude-in-chrome__javascript_tool
  - mcp__claude-in-chrome__get_page_text
  - mcp__claude-in-chrome__read_console_messages
  - mcp__claude-in-chrome__read_network_requests
  # Documentation lookup (context7 MCP)
  - mcp__context7__resolve-library-id
  - mcp__context7__query-docs
  # Web research (tavily MCP)
  - mcp__tavily__tavily-search
  - mcp__tavily__tavily-extract
---
```

**Installation**: Run `cleo init` to copy the agent definition to `.claude/agents/`.

## Skill Loading as Context Injection

Instead of spawning different agent types, the orchestrator:
1. Selects appropriate skill via `lib/skill-dispatch.sh`
2. Loads skill template from `skills/ct-{skill}/SKILL.md`
3. Injects protocol base from `skills/_shared/subagent-protocol-base.md`
4. Resolves all tokens via `lib/token-inject.sh`
5. Spawns single subagent with combined context

### Skill Dispatch Flow

```
Task → skill_auto_dispatch() → Skill Selection
                                    │
                                    ▼
                        skill_prepare_spawn()
                                    │
                        ┌───────────┴───────────┐
                        │                       │
                        ▼                       ▼
              Load Skill Template    Load Protocol Base
              (SKILL.md)             (subagent-protocol-base.md)
                        │                       │
                        └───────────┬───────────┘
                                    │
                                    ▼
                        Token Injection (ti_*)
                                    │
                                    ▼
                        Combined Prompt
                                    │
                                    ▼
                        Spawn cleo-subagent
```

### Skill Selection Strategies

The `lib/skill-dispatch.sh` library uses three strategies in priority order:

| Strategy | Mechanism | Example |
|----------|-----------|---------|
| **1. Label-based** | Task labels match skill tags | `["research"]` → ct-research-agent |
| **2. Type-based** | Task type maps to skill | `type: "epic"` → ct-epic-architect |
| **3. Keyword-based** | Title/description keywords | "implement auth" → ct-task-executor |

If no match found, defaults to `ct-task-executor`.

### Dispatch Matrix

The `skills/manifest.json` contains explicit mappings:

```json
{
  "dispatch_matrix": {
    "by_task_type": {
      "research": "ct-research-agent",
      "planning": "ct-epic-architect",
      "implementation": "ct-task-executor",
      "testing": "ct-test-writer-bats"
    },
    "by_keyword": {
      "research|investigate|explore": "ct-research-agent",
      "epic|plan|decompose": "ct-epic-architect",
      "implement|build|execute": "ct-task-executor"
    }
  }
}
```

## Protocol Stack

The protocol stack is a layered system of mandatory behaviors:

### Base Protocol (Always Loaded)

From `skills/_shared/subagent-protocol-base.md`:

| ID | Rule | Compliance |
|----|------|------------|
| OUT-001 | MUST write findings to output file | Required |
| OUT-002 | MUST append ONE line to MANIFEST.jsonl | Required |
| OUT-003 | MUST return ONLY summary message | Required |
| OUT-004 | MUST NOT return content in response | Required |

### 7 Conditional Protocols

Loaded based on skill and task context:

| Protocol | When Loaded | Purpose |
|----------|-------------|---------|
| **Task Lifecycle** | All skills | Focus, complete, link operations |
| **Research Linking** | Research skills | Bidirectional task-research links |
| **Verification Gates** | Testing/validation | testsPassed, securityPassed gates |
| **Phase Awareness** | Phase-filtered work | Current phase context |
| **Dependency Context** | Has dependencies | Manifest summaries from deps |
| **Error Handling** | All skills | Partial/blocked status handling |
| **Session Integration** | Session-scoped | Session context preservation |

### Protocol Combination Example

A validation task might combine:

```
┌─────────────────────────────────────────┐
│ BASE PROTOCOL                           │
│ - Output file format                    │
│ - Manifest entry requirements           │
│ - Return message format                 │
├─────────────────────────────────────────┤
│ + TASK LIFECYCLE PROTOCOL               │
│ - cleo start                        │
│ - cleo complete                         │
├─────────────────────────────────────────┤
│ + VERIFICATION GATES PROTOCOL           │
│ - cleo verify --gate testsPassed        │
│ - cleo verify --gate securityPassed     │
├─────────────────────────────────────────┤
│ + DEPENDENCY CONTEXT PROTOCOL           │
│ - Prior task manifest summaries         │
│ - Dependency completion status          │
└─────────────────────────────────────────┘
```

## Token Pre-Resolution

All tokens are resolved BEFORE spawning via `ti_set_full_context()`:

### Required Tokens

| Token | Source | Example |
|-------|--------|---------|
| `{{TASK_ID}}` | Task system | `T1234` |
| `{{DATE}}` | Generated | `2026-01-26` |
| `{{TOPIC_SLUG}}` | Generated from title | `authentication-research` |

### Task Context Tokens

| Token | Source | Description |
|-------|--------|-------------|
| `{{TASK_TITLE}}` | Task data | Task title |
| `{{TASK_DESCRIPTION}}` | Task data | Full description |
| `{{DEPENDS_LIST}}` | Task data | Completed dependencies |
| `{{ACCEPTANCE_CRITERIA}}` | Task data | Completion criteria |
| `{{DELIVERABLES_LIST}}` | Task data | Expected outputs |
| `{{MANIFEST_SUMMARIES}}` | Dependency tasks | Key findings from deps |
| `{{NEXT_TASK_IDS}}` | Task system | Unblocked after completion |

### Command Tokens

| Token | Default Value |
|-------|---------------|
| `{{TASK_SHOW_CMD}}` | `cleo show` |
| `{{TASK_START_CMD}}` | `cleo start` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_LINK_CMD}}` | `cleo research link` |

### Token Resolution Verification

The `skill_prepare_spawn()` function verifies all tokens are resolved:

```json
{
  "tokenResolution": {
    "fullyResolved": true,
    "unresolvedCount": 0,
    "unresolvedTokens": []
  }
}
```

If unresolved tokens remain, they are logged as warnings.

## Usage Patterns

### Orchestrator Spawning a Subagent

```bash
# Via CLI
cleo orchestrator spawn T1234

# With specific skill override
cleo orchestrator spawn T1234 --template ct-research-agent

# Programmatically
source lib/orchestrator-spawn.sh
result=$(orchestrator_spawn_for_task "T1234")
prompt=$(echo "$result" | jq -r '.result.prompt')
```

### Skill Auto-Selection

```bash
source lib/skill-dispatch.sh

# Auto-select based on task metadata
skill=$(skill_auto_dispatch "T1234")

# Get full spawn context
context=$(skill_prepare_spawn "$skill" "T1234")
```

### Protocol Validation

```bash
source lib/orchestrator-spawn.sh

# Verify prompt contains protocol block
if orchestrator_verify_protocol_injection "$prompt"; then
    echo "Protocol present"
fi

# Verify manifest entry after completion
orchestrator_verify_manifest_entry "auth-research-2026-01-26"
```

## Skill Tier System

Skills are organized by tier for spawn ordering:

| Tier | Role | Skills |
|------|------|--------|
| **0** | Orchestrator | ct-orchestrator |
| **1** | Planning | ct-epic-architect |
| **2** | Execution | ct-task-executor, ct-research-agent, ct-spec-writer, ct-test-writer-bats, ct-library-implementer-bash, ct-validator |
| **3** | Chaining | ct-documentor, ct-docs-lookup, ct-docs-write, ct-docs-review |

Tier 2 skills can chain to Tier 3 for documentation follow-up.

## Output Requirements

All cleo-subagent instances MUST:

### 1. Write Output File

Location: `claudedocs/agent-outputs/{{DATE}}_{{TOPIC_SLUG}}.md`

```markdown
# {{TITLE}}

## Summary
{{2-3 sentence overview}}

## Findings
{{Detailed findings}}

## Recommendations
{{Action items}}

## Linked Tasks
- Epic: {{EPIC_ID}}
- Task: {{TASK_ID}}
```

### 2. Append Manifest Entry

Single line to `claudedocs/agent-outputs/MANIFEST.jsonl`:

```json
{"id":"topic-2026-01-26","file":"2026-01-26_topic.md","title":"Title","date":"2026-01-26","status":"complete","topics":["t1"],"key_findings":["Finding 1","Finding 2"],"actionable":true,"needs_followup":[],"linked_tasks":["T1000","T1234"]}
```

### 3. Return Summary Message

One of three allowed responses:
- `"Research complete. See MANIFEST.jsonl for summary."`
- `"Research partial. See MANIFEST.jsonl for details."`
- `"Research blocked. See MANIFEST.jsonl for blocker details."`

## Error Handling

### E_PROTOCOL_MISSING (Exit 60)

If protocol block is missing from generated prompt:

```json
{
  "error": {
    "code": "E_PROTOCOL_MISSING",
    "message": "SPAWN BLOCKED: Generated prompt missing SUBAGENT PROTOCOL marker",
    "fix": "cleo orchestrator spawn --force-inject",
    "alternatives": [
      {"action": "Manually append protocol", "command": "cleo research inject"},
      {"action": "Check skill template", "command": "cat skills/.../SKILL.md | grep protocol"}
    ]
  }
}
```

### Manifest Verification Failure

After subagent completion, verify manifest entry exists:

```bash
if ! orchestrator_verify_manifest_entry "$research_id"; then
    # Re-spawn with explicit manifest requirement
fi
```

## Library Reference

### lib/skill-dispatch.sh

Primary functions:

| Function | Purpose |
|----------|---------|
| `skill_auto_dispatch` | Auto-select skill for task |
| `skill_prepare_spawn` | Generate full spawn context |
| `skill_dispatch_by_keywords` | Match by keyword patterns |
| `skill_dispatch_by_type` | Match by task type |
| `skill_get_metadata` | Get skill manifest entry |
| `skill_list_by_tier` | List skills at tier level |

### lib/orchestrator-spawn.sh

Primary functions:

| Function | Purpose |
|----------|---------|
| `orchestrator_spawn_for_task` | Complete spawn preparation |
| `orchestrator_spawn_batch` | Batch spawn for multiple tasks |
| `orchestrator_verify_protocol_injection` | Validate protocol block |
| `orchestrator_verify_manifest_entry` | Verify manifest after spawn |
| `orchestrator_get_protocol_block` | Get protocol injection block |

### lib/token-inject.sh

Primary functions:

| Function | Purpose |
|----------|---------|
| `ti_set_full_context` | Set all tokens from task |
| `ti_inject_tokens` | Replace tokens in template |
| `ti_load_template` | Load and inject template |
| `ti_set_task_context` | Set task-specific tokens |

## Related Documentation

- [Orchestrator Protocol Guide](../guides/ORCHESTRATOR-PROTOCOL.md)
- [Orchestrator CLI Reference](../commands/orchestrator.md)
- [Skills Manifest](../../skills/manifest.json)
- [Subagent Protocol Base](../../skills/_shared/subagent-protocol-base.md)
