# Handoff Chain Protocol

> Referenced from: @skills/ct-orchestrator/SKILL.md
> Load when: Need details on manifest-mediated handoffs, handoff constraints, prompt templates, or anti-patterns

## Overview

Orchestrator coordinates work through **manifest-mediated handoffs**. Content flows between subagents via files, not through orchestrator context.

## Architecture

```
Orchestrator (Tier 0)
    │
    ├─ Spawns Agent A with task instructions
    │   └─ A completes → writes output file + manifest entry
    │
    ├─ Reads MANIFEST.jsonl → extracts key_findings (3-7 items)
    │   └─ Does NOT read full output file
    │   └─ Does NOT use TaskOutput tool
    │
    ├─ Spawns Agent B with handoff context
    │   └─ Prompt includes: "Previous agent found: [key_findings]"
    │   └─ Prompt includes: "If details needed, read [file path from manifest]"
    │   └─ B reads full file directly if needed
    │
    └─ Continue chain...
```

## Handoff Constraints (RFC 2119)

| ID | Rule | Enforcement |
|----|------|-------------|
| HNDOFF-001 | Orchestrator MUST read only manifest `key_findings` | Not full output files |
| HNDOFF-002 | Orchestrator MUST include `key_findings` in next spawn prompt | Context continuity |
| HNDOFF-003 | Orchestrator MUST include file path for detailed reference | Subagent can read if needed |
| HNDOFF-004 | Subagents MAY read previous agent output files directly | Full context when needed |
| HNDOFF-005 | Orchestrator MUST NOT process or analyze subagent content | Delegation enforcement |

## Handoff Prompt Template

When spawning Agent B after Agent A completes:

```markdown
## Context from Previous Agent

**Previous Task**: {A's task ID} - {A's title}
**Key Findings**:
{bullet list from manifest key_findings}

**Reference**: If you need detailed information, read: {file path from manifest}

## Your Task
{B's instructions}
```

## Example Handoff

```bash
# 1. Agent A completes, manifest shows:
# {"key_findings": ["OAuth2 recommended", "JWT for sessions", "30-day token expiry"]}

# 2. Orchestrator reads manifest summary
cleo research show A-research-id

# 3. Orchestrator spawns Agent B with context:
# "Previous research found: OAuth2 recommended, JWT for sessions, 30-day token expiry.
#  If you need details, read: claudedocs/agent-outputs/2026-01-31_A-research.md
#  Your task: Implement the authentication module based on these findings."
```

## Anti-Pattern: Direct Content Flow

**WRONG** (content through orchestrator):
```
A completes → Orchestrator reads TaskOutput →
Orchestrator analyzes content → Spawns B
```

**CORRECT** (manifest-mediated):
```
A completes → Orchestrator reads manifest key_findings →
Orchestrator spawns B with key_findings + file reference →
B reads file directly if needed
```
