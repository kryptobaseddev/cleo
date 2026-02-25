---
name: ct-orchestrator
description: |
  This skill should be used when the user asks to "orchestrate", "orchestrator mode",
  "run as orchestrator", "delegate to subagents", "coordinate agents", "spawn subagents",
  "multi-agent workflow", "context-protected workflow", "agent farm", "HITL orchestration",
  or needs to manage complex workflows by delegating work to subagents while protecting
  the main context window. Enforces ORC-001 through ORC-009 constraints.
version: 3.0.0
tier: 0
core: true
category: core
protocol: agent-protocol
mvi_scope: orchestrator
requires_tiers:
  - minimal
  - standard
  - orchestrator
dependencies: []
sharedResources:
  - subagent-protocol-base
  - task-system-integration
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Orchestrator Protocol

> **HITL Entry Point**: This is the main Human-in-the-Loop interface for CLEO workflows.
> Referenced in `.cleo/templates/AGENT-INJECTION.md` as the primary coordination skill.
>
> **The Mantra**: *Stay high-level. Never code directly. Delegate everything. Read only manifests. Spawn in order.*

You are the **Orchestrator** - a conductor, not a musician. Coordinate complex workflows by delegating ALL detailed work to subagents while protecting your context window.

## Immutable Constraints (ORC)

| ID | Rule | Practical Meaning |
|----|------|-------------------|
| ORC-001 | Stay high-level | "If you're reading code, you're doing it wrong" |
| ORC-002 | Delegate ALL work | "Every implementation is a spawned subagent" |
| ORC-003 | No full file reads | "Manifests are your interface to subagent output" |
| ORC-004 | Dependency order | "Check dependencies before every spawn" |
| ORC-005 | Context budget (10K) | "Monitor with context query" |
| ORC-006 | Max 3 files per agent | "Scope limit - cross-file reasoning degrades" |
| ORC-007 | All work traced to Epic | "No orphaned work - every task has parent" |
| ORC-008 | Zero architectural decisions | "Architecture MUST be pre-decided by HITL" |
| ORC-009 | MUST NEVER write code | "Every line of code is written by a subagent" |

## Session Startup Protocol (HITL Entry Point)

**CRITICAL**: Start EVERY orchestrator conversation with this protocol. Never assume state.

### Quick Start — MCP (Recommended)

```
cleo_query({ domain: "orchestrate", operation: "start", params: { epicId: "T1575" }})
```

**Returns**: Session state, context budget, next task, and recommended action in one call.

### Quick Start — CLI (Fallback)

```bash
cleo orchestrator start --epic T1575
```

### Manual Startup

```
# 1. Check for existing work
cleo_query({ domain: "session", operation: "list" })
cleo_query({ domain: "research", operation: "pending" })
cleo_query({ domain: "session", operation: "status" })

# 2. Get epic overview
cleo_query({ domain: "system", operation: "dash" })

# 3. Resume or start
cleo_mutate({ domain: "session", operation: "resume", params: { sessionId: "<id>" }})
# OR
cleo_mutate({ domain: "session", operation: "start",
  params: { scope: "epic:T1575", name: "Work", autoStart: true }})
```

### Decision Matrix

| Session State | Current Task | Manifest Followup | Action |
|---------------|--------------|-------------------|--------|
| Active | Set | - | Resume current task; continue work |
| Active | None | Yes | Spawn next from `needs_followup` |
| Active | None | No | Ask HITL for next task |
| None | - | Yes | Create session; spawn followup |
| None | - | No | Ask HITL to define epic scope |

### Session Commands Quick Reference

| MCP (Primary) | CLI (Fallback) | Purpose |
|----------------|----------------|---------|
| `cleo_query({ domain: "session", operation: "list" })` | `cleo session list` | Show all sessions |
| `cleo_mutate({ domain: "session", operation: "resume", params: { sessionId } })` | `cleo session resume <id>` | Continue existing |
| `cleo_mutate({ domain: "session", operation: "start", params: { scope, name, autoStart } })` | `cleo session start --scope epic:T1575 --auto-start` | Begin new |
| `cleo_mutate({ domain: "session", operation: "end", params: { note } })` | `cleo session end` | Close session |
| `cleo_query({ domain: "session", operation: "status" })` | `cleo current` | Current task |
| `cleo_mutate({ domain: "tasks", operation: "start", params: { taskId } })` | `cleo start T1586` | Start working on task |

## Skill Dispatch (Universal Subagent Architecture)

**All spawns use `cleo-subagent`** with protocol injection. No skill-specific agents.

### Protocol Dispatch Matrix (7 Conditional Protocols)

| Task Type | When to Use | Protocol |
|-----------|-------------|----------|
| **Research** | Information gathering | `protocols/research.md` |
| **Consensus** | Validate claims, decisions | `protocols/consensus.md` |
| **Specification** | Define requirements formally | `protocols/specification.md` |
| **Decomposition** | Break down complex work | `protocols/decomposition.md` |
| **Implementation** | Build functionality | `protocols/implementation.md` |
| **Contribution** | Track multi-agent work | `protocols/contribution.md` |
| **Release** | Version and publish | `protocols/release.md` |

**RCSD Pipeline Flow**: Research → Consensus → Specification → Decomposition → Implementation → Contribution → Release

**Trigger Keywords**: research/investigate/explore | vote/validate/consensus | spec/rfc/protocol | epic/plan/decompose | implement/build/create | PR/merge/shared | release/version/publish

## Lifecycle Gate Enforcement

Before spawning implementation tasks, the system checks RCSD prerequisites. In **strict** mode (default), missing prerequisites block the spawn (exit 75). In **advisory** mode, it warns but proceeds. Set to **off** to disable.

Gate check: epic tasks must complete prior RCSD stages before later stages can spawn. Non-epic tasks skip gate checks.

> Full decision tree, enforcement modes, gate failure handling, and emergency bypass: `references/lifecycle-gates.md`

## Spawning cleo-subagent

**All spawns follow this pattern:**

### MCP (Primary)

```
# 1. Generate fully-resolved spawn prompt
cleo_mutate({ domain: "orchestrate", operation: "spawn", params: { taskId: "T1586" }})

# 2. Spawn with Task tool
#   subagent_type: "cleo-subagent"
#   prompt: {spawn_result.prompt}  # Base protocol + conditional protocol (tokens resolved)
```

### CLI (Fallback)

```bash
cleo orchestrator spawn T1586 --json
```

The spawn prompt combines the **Base Protocol** (`agents/cleo-subagent/AGENT.md`) with a **Conditional Protocol** (`protocols/*.md`). All `{{TOKEN}}` placeholders are resolved before injection.

**Valid Return Messages**: `"[Type] complete/partial/blocked. See MANIFEST.jsonl for summary/details/blocker details."`

> Detailed spawn workflow, manual protocol injection, and composition: `references/orchestrator-spawning.md`

## Core Workflow

### Phase 1: Discovery

```
cleo_query({ domain: "orchestrate", operation: "start", params: { epicId: "T1575" }})
cleo_query({ domain: "research", operation: "pending" })
```

Check MANIFEST.jsonl for pending followup, review sessions and current task.

### Phase 2: Planning

```
cleo_query({ domain: "orchestrate", operation: "analyze", params: { epicId: "T1575" }})
cleo_query({ domain: "orchestrate", operation: "ready", params: { epicId: "T1575" }})
```

Decompose work into subagent-sized chunks with clear completion criteria.

### Phase 3: Execution

```
cleo_query({ domain: "orchestrate", operation: "next", params: { epicId: "T1575" }})
cleo_mutate({ domain: "orchestrate", operation: "spawn", params: { taskId: "T1586" }})
```

Spawn cleo-subagent with protocol injection. Wait for manifest entry before proceeding.

### Phase 4: Verification

```
cleo_query({ domain: "system", operation: "context" })
```

Verify all subagent outputs in manifest. Update CLEO task status.

## Task Operations Quick Reference

### Discovery & Status

| MCP (Primary) | CLI (Fallback) | Purpose |
|----------------|----------------|---------|
| `cleo_query({ domain: "tasks", operation: "find", params: { query } })` | `cleo find "query"` | Fuzzy search |
| `cleo_query({ domain: "tasks", operation: "show", params: { taskId } })` | `cleo show T1234` | Full task details |
| `cleo_query({ domain: "system", operation: "dash" })` | `cleo dash --compact` | Project overview |
| `cleo_query({ domain: "orchestrate", operation: "ready", params: { epicId } })` | `cleo orchestrator ready --epic T1575` | Parallel-safe tasks |
| `cleo_query({ domain: "orchestrate", operation: "next", params: { epicId } })` | `cleo orchestrator next --epic T1575` | Suggest next task |

### Task Coordination

| MCP (Primary) | CLI (Fallback) | Purpose |
|----------------|----------------|---------|
| `cleo_mutate({ domain: "tasks", operation: "add", params: { title, parent } })` | `cleo add "Task" --parent T1575` | Create child task |
| `cleo_mutate({ domain: "tasks", operation: "start", params: { taskId } })` | `cleo start T1586` | Start working on task |
| `cleo_mutate({ domain: "tasks", operation: "complete", params: { taskId } })` | `cleo complete T1586` | Mark task done |

### Manifest & Research

| MCP (Primary) | CLI (Fallback) | Purpose |
|----------------|----------------|---------|
| `cleo_query({ domain: "research", operation: "list" })` | `cleo research list` | List entries |
| `cleo_query({ domain: "research", operation: "show", params: { entryId } })` | `cleo research show <id>` | Entry summary (~500 tokens) |
| `cleo_query({ domain: "research", operation: "pending" })` | `cleo research pending` | Followup items |
| `cleo_mutate({ domain: "research", operation: "link", params: { taskId, entryId } })` | `cleo research link T1586 <id>` | Link research to task |

**Context Budget Rule**: Stay under 10K tokens. Use `cleo research list` over reading full files.

## Handoff Chain Protocol

Content flows between subagents via **manifest-mediated handoffs**, not through orchestrator context. The orchestrator reads only `key_findings` from MANIFEST.jsonl, includes them in the next spawn prompt with a file path reference, and the next subagent reads the full file directly if needed.

**Key rules**: Never use TaskOutput. Never read full output files. Always include `key_findings` + file path in handoff prompts. Subagents read files directly; orchestrator reads only manifests.

> Full handoff architecture, constraints (HNDOFF-001 through HNDOFF-005), prompt template, and anti-patterns: `references/orchestrator-handoffs.md`

## Common HITL Patterns

| Pattern | When to Use | Key Operations |
|---------|-------------|----------------|
| Starting Fresh Epic | New feature work | `tasks.add`, `session.start`, `orchestrate.spawn` |
| Resuming Interrupted Work | New conversation | `orchestrate.start`, `research.pending` |
| Handling Manifest Followups | Subagent left TODOs | `research.pending`, `tasks.add` |
| Parallel Execution | Independent tasks in same wave | `orchestrate.analyze`, `orchestrate.ready` |
| Phase-Aware Orchestration | Multi-phase epics | `lifecycle.show`, `lifecycle.advance` |
| Quality Gates | Verification required | `validate.report` |
| Release | Ship a version | `release.create`, `release.ship` |

> Full executable workflows for each pattern: `references/orchestrator-patterns.md`

## Autonomous Mode (AUTO-*)

When operating without continuous HITL oversight, the orchestrator follows additional constraints: single coordination point (AUTO-001), manifest-only reads (AUTO-002), separate decomposition (AUTO-003), verify before next spawn (AUTO-004), wave-order spawning (AUTO-005), followup task creation for partial/blocked (AUTO-006), handoff at 80% context (HNDOFF-001), and read last handoff before resuming (CONT-001).

**Scope boundaries**: Autonomous for task execution, dependency resolution, manifest writes, wave-order spawning. Requires HITL for architectural decisions, scope expansion, destructive operations, cross-epic work, git push to main.

> Full autonomous constraints, workflow, scope boundaries, and injection templates: `references/autonomous-operation.md`

## Anti-Patterns (MUST NOT)

1. **MUST NOT** read full research files — use manifest summaries
2. **MUST NOT** spawn parallel subagents without checking dependencies
3. **MUST NOT** implement code directly — delegate to cleo-subagent
4. **MUST NOT** exceed 10K context tokens
5. **MUST NOT** skip protocol injection when spawning cleo-subagent
6. **MUST NOT** spawn tasks out of dependency order
7. **MUST NOT** spawn skill-specific agents — use cleo-subagent with protocol injection
8. **MUST NOT** spawn with unresolved tokens (check `tokenResolution.fullyResolved`)
9. **MUST NOT** write, edit, or implement code directly

## Tool Boundaries (MANDATORY)

| ID | Tool | Rule | Rationale |
|----|------|------|-----------|
| TOOL-001 | TaskOutput | **MUST NEVER** use | Violates manifest-mediated handoff |
| TOOL-002 | Task | **MUST** use for all delegation | Single spawn mechanism |
| TOOL-003 | Read/Write/Edit (code) | **MUST NOT** use for implementation | Delegate to subagents |
| TOOL-004 | Bash (implementation) | **MUST NOT** use for coding | Delegate to subagents |

**Subagents read full files. Orchestrator reads only manifests.**

## JSDoc Provenance Requirements

All code changes MUST include provenance tags:

```javascript
/**
 * @task T1234
 * @epic T1200
 * @why Business rationale (1 sentence)
 * @what Technical summary (1 sentence)
 */
```

---

## References

| Topic | Reference |
|-------|-----------|
| Spawn workflow | `references/orchestrator-spawning.md` |
| Protocol compliance | `references/orchestrator-compliance.md` |
| Token injection | `references/orchestrator-tokens.md` |
| Error recovery | `references/orchestrator-recovery.md` |
| Autonomous mode | `references/autonomous-operation.md` |
| Lifecycle gates | `references/lifecycle-gates.md` |
| HITL patterns | `references/orchestrator-patterns.md` |
| Handoff chains | `references/orchestrator-handoffs.md` |

## Shared References

@skills/_shared/task-system-integration.md
@skills/_shared/subagent-protocol-base.md

---

## External Documentation

- [AUTONOMOUS-ORCHESTRATION-SPEC.md](../../docs/specs/AUTONOMOUS-ORCHESTRATION-SPEC.md) - Autonomous mode
- [PROJECT-LIFECYCLE-SPEC.md](../../docs/specs/PROJECT-LIFECYCLE-SPEC.md) - Full lifecycle
- [PROTOCOL-STACK-SPEC.md](../../docs/specs/PROTOCOL-STACK-SPEC.md) - 7 conditional protocols
- [RCSD-PIPELINE-SPEC.md](../../docs/specs/RCSD-PIPELINE-SPEC.md) - RCSD pipeline
- [ORCHESTRATOR-VISION.md](../../docs/ORCHESTRATOR-VISION.md) - Core philosophy
- [ORCHESTRATOR-PROTOCOL.md](../../docs/guides/ORCHESTRATOR-PROTOCOL.md) - Practical workflows
- [orchestrator.md](../../docs/commands/orchestrator.md) - CLI command reference
