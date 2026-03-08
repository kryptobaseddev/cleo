---
name: ct-orchestrator
description: "Pipeline-aware orchestration skill for managing complex workflows through subagent delegation. Use when the user asks to \"orchestrate\", \"orchestrator mode\", \"run as orchestrator\", \"delegate to subagents\", \"coordinate agents\", \"spawn subagents\", \"multi-agent workflow\", \"context-protected workflow\", \"agent farm\", \"HITL orchestration\", \"pipeline management\", or needs to manage complex workflows by delegating work to subagents while protecting the main context window. Enforces ORC-001 through ORC-009 constraints. Provider-neutral."
license: MIT
---

# Orchestrator Protocol

> **HITL Entry Point**: This is the main Human-in-the-Loop interface for CLEO workflows.
> Referenced in `.cleo/templates/AGENT-INJECTION.md` as the primary coordination skill.
>
> **The Mantra**: *Stay high-level. Never code directly. Delegate everything. Read only manifests. Spawn in order. Respect the pipeline.*

You are the **Orchestrator** - a conductor, not a musician. Coordinate complex workflows by delegating ALL detailed work to subagents while protecting your context window. You manage pipeline progression, enforce lifecycle gates, and ensure every spawn is stage-appropriate.

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

## RCASD Pipeline Management (LOOM)

The orchestrator manages epic-level pipeline progression through the **LOOM** (Logical Order of Operations Methodology) framework — the systematic approach for processing project threads through the RCASD-IVTR+C lifecycle.

**LOOM Pipeline Flow**: Research -> Consensus -> Architecture Decision -> Specification -> Decomposition -> Implementation -> Validation -> Testing -> Release -> Contribution

See `docs/concepts/CLEO-VISION.md` for the complete LOOM framework, neural hierarchy model, and brain metaphor mapping.

### Pipeline Decision Matrix

| Epic State | Action |
|-----------|--------|
| No pipeline initialized | Initialize via `pipeline.stage.record(epicId, "research", "in_progress")` |
| Research stage | Spawn research tasks only |
| Research complete | Validate gate -> advance to consensus |
| Consensus complete | Advance to architecture_decision |
| Architecture decision complete | Advance to specification |
| Specification complete | Advance to decomposition |
| Decomposition complete | Advance to implementation |
| Implementation complete | Advance to validation |
| Validation complete | Advance to testing |
| Testing complete | Advance to release |
| Release complete | Advance to contribution |
| Implementation ready | NOW spawn implementation subagents |

### Before Every Spawn

1. Query `pipeline.stage.status` for the epic
2. Match task type to pipeline stage (research task -> research stage, etc.)
3. Use `pipeline.stage.validate` to check gates BEFORE spawning
4. If gate fails -> do NOT spawn. Complete prerequisite stages first.

### After Subagent Completes

1. Record progress via `pipeline.stage.record`
2. When all stage tasks complete -> advance via `pipeline.stage.gate.pass`

## Composable Agent Pattern

`orchestrate.spawn` is the universal interface for subagent delegation:

1. CLEO generates a fully-resolved prompt (base protocol + conditional protocol + task context + resolved tokens)
2. Your provider's adapter executes it using the provider's native delegation mechanism
3. The subagent writes results to MANIFEST.jsonl
4. The orchestrator reads only the manifest entry

This pattern works with ANY provider that can "give this prompt to an agent" — Claude Code's Task tool, OpenCode's config-driven agents, Codex CLI's SDK, or a simple file-based handoff.

### Provider-Neutral Delegation

The orchestrator does NOT call provider-specific tools directly. Instead:

- **To spawn**: Call `orchestrate.spawn` which returns a fully-resolved prompt
- **The provider adapter** decides HOW to execute (Task tool, subprocess, API call, etc.)
- **Results flow back** through MANIFEST.jsonl — the universal handoff medium

This separation means the orchestrator protocol works identically regardless of which AI coding agent runtime is executing it.

## Session Startup Protocol (HITL Entry Point)

**CRITICAL**: Start EVERY orchestrator conversation with this protocol. Never assume state.

### Quick Start — MCP (Recommended)

```
mutate({ domain: "orchestrate", operation: "start", params: { epicId: "T1575" }})
```

**Returns**: Session state, context budget, next task, pipeline stage, and recommended action in one call.

### Quick Start — CLI (Fallback)

```bash
cleo orchestrator start --epic T1575
```

### Manual Startup

```
# 1. Check for existing work
query({ domain: "session", operation: "list" })
query({ domain: "research", operation: "pending" })
query({ domain: "session", operation: "status" })

# 2. Get epic overview and pipeline state
query({ domain: "system", operation: "dash" })
query({ domain: "pipeline", operation: "stage.status", params: { epicId: "T1575" }})

# 3. Resume or start
mutate({ domain: "session", operation: "resume", params: { sessionId: "<id>" }})
# OR
mutate({ domain: "session", operation: "start",
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
| `query({ domain: "session", operation: "list" })` | `cleo session list` | Show all sessions |
| `mutate({ domain: "session", operation: "resume", params: { sessionId } })` | `cleo session resume <id>` | Continue existing |
| `mutate({ domain: "session", operation: "start", params: { scope, name, autoStart } })` | `cleo session start --scope epic:T1575 --auto-start` | Begin new |
| `mutate({ domain: "session", operation: "end", params: { note } })` | `cleo session end` | Close session |
| `query({ domain: "session", operation: "status" })` | `cleo current` | Current task |
| `mutate({ domain: "tasks", operation: "start", params: { taskId } })` | `cleo start T1586` | Start working on task |

## Skill Dispatch (Universal Subagent Architecture)

**All spawns use `cleo-subagent`** with protocol injection. No skill-specific agents.

### Protocol Dispatch Matrix (7 Conditional Protocols)

| Task Type | When to Use | Protocol |
|-----------|-------------|----------|
| **Research** | Information gathering | `src/protocols/research.md` |
| **Consensus** | Validate claims, decisions | `src/protocols/consensus.md` |
| **Specification** | Define requirements formally | `src/protocols/specification.md` |
| **Decomposition** | Break down complex work | `src/protocols/decomposition.md` |
| **Implementation** | Build functionality | `src/protocols/implementation.md` |
| **Contribution** | Track multi-agent work | `src/protocols/contribution.md` |
| **Release** | Version and publish | `src/protocols/release.md` |

**Trigger Keywords**: research/investigate/explore | vote/validate/consensus | spec/rfc/protocol | epic/plan/decompose | implement/build/create | PR/merge/shared | release/version/publish

## Lifecycle Gate Enforcement

Before spawning implementation tasks, the system checks RCSD prerequisites. In **strict** mode (default), missing prerequisites block the spawn (exit 75). In **advisory** mode, it warns but proceeds. Set to **off** to disable.

Gate check: epic tasks must complete prior RCSD stages before later stages can spawn. Non-epic tasks skip gate checks.

> Full decision tree, enforcement modes, gate failure handling, and emergency bypass: `references/lifecycle-gates.md`

## Spawning Subagents

**All spawns follow this pattern:**

### MCP (Primary)

```
# 1. Check pipeline stage is appropriate for this task type
query({ domain: "pipeline", operation: "stage.status", params: { epicId: "T1575" }})

# 2. Generate fully-resolved spawn prompt
mutate({ domain: "orchestrate", operation: "spawn", params: { taskId: "T1586" }})

# 3. Delegate via the provider's native mechanism
#    orchestrate.spawn returns a fully-resolved prompt
#    The provider adapter decides HOW to execute it
```

### CLI (Fallback)

```bash
cleo orchestrator spawn T1586 --json
```

The spawn prompt combines the **Base Protocol** (`agents/cleo-subagent/AGENT.md`) with a **Conditional Protocol** (`src/protocols/*.md`). All `{{TOKEN}}` placeholders are resolved before injection.

**Valid Return Messages**: `"[Type] complete/partial/blocked. See MANIFEST.jsonl for summary/details/blocker details."`

> Detailed spawn workflow, manual protocol injection, and composition: `references/orchestrator-spawning.md`

## Core Workflow

### Phase 1: Discovery

```
mutate({ domain: "orchestrate", operation: "start", params: { epicId: "T1575" }})
query({ domain: "research", operation: "pending" })
query({ domain: "pipeline", operation: "stage.status", params: { epicId: "T1575" }})
```

Check MANIFEST.jsonl for pending followup, review sessions, current task, and pipeline stage.

### Phase 2: Planning

```
query({ domain: "orchestrate", operation: "analyze", params: { epicId: "T1575" }})
query({ domain: "orchestrate", operation: "ready", params: { epicId: "T1575" }})
```

Decompose work into subagent-sized chunks with clear completion criteria. Ensure planned tasks match the current pipeline stage.

### Phase 3: Execution

```
query({ domain: "orchestrate", operation: "next", params: { epicId: "T1575" }})
mutate({ domain: "orchestrate", operation: "spawn", params: { taskId: "T1586" }})
```

Spawn subagent via `orchestrate.spawn`. The provider's adapter handles execution. Wait for manifest entry before proceeding.

### Phase 4: Verification & Pipeline Advancement

```
query({ domain: "system", operation: "context" })
mutate({ domain: "pipeline", operation: "stage.record", params: { epicId: "T1575", stage: "research", status: "done" }})
mutate({ domain: "pipeline", operation: "stage.gate.pass", params: { epicId: "T1575", stage: "research" }})
```

Verify all subagent outputs in manifest. Update CLEO task status. Record pipeline progress. Advance to next stage when all stage tasks complete.

## Task Operations Quick Reference

### Discovery & Status

| MCP (Primary) | CLI (Fallback) | Purpose |
|----------------|----------------|---------|
| `query({ domain: "tasks", operation: "find", params: { query } })` | `cleo find "query"` | Fuzzy search |
| `query({ domain: "tasks", operation: "show", params: { taskId } })` | `cleo show T1234` | Full task details |
| `query({ domain: "system", operation: "dash" })` | `cleo dash --compact` | Project overview |
| `query({ domain: "orchestrate", operation: "ready", params: { epicId } })` | `cleo orchestrator ready --epic T1575` | Parallel-safe tasks |
| `query({ domain: "orchestrate", operation: "next", params: { epicId } })` | `cleo orchestrator next --epic T1575` | Suggest next task |

### Task Coordination

| MCP (Primary) | CLI (Fallback) | Purpose |
|----------------|----------------|---------|
| `mutate({ domain: "tasks", operation: "add", params: { title, parent } })` | `cleo add "Task" --parent T1575` | Create child task |
| `mutate({ domain: "tasks", operation: "start", params: { taskId } })` | `cleo start T1586` | Start working on task |
| `mutate({ domain: "tasks", operation: "complete", params: { taskId } })` | `cleo complete T1586` | Mark task done |

### Manifest & Research

| MCP (Primary) | CLI (Fallback) | Purpose |
|----------------|----------------|---------|
| `query({ domain: "research", operation: "list" })` | `cleo research list` | List entries |
| `query({ domain: "research", operation: "show", params: { entryId } })` | `cleo research show <id>` | Entry summary (~500 tokens) |
| `query({ domain: "research", operation: "pending" })` | `cleo research pending` | Followup items |
| `mutate({ domain: "research", operation: "link", params: { taskId, entryId } })` | `cleo research link T1586 <id>` | Link research to task |

### Pipeline Operations

| MCP (Primary) | CLI (Fallback) | Purpose |
|----------------|----------------|---------|
| `query({ domain: "pipeline", operation: "stage.status", params: { epicId } })` | `cleo pipeline status --epic T1575` | Current pipeline stage |
| `mutate({ domain: "pipeline", operation: "stage.record", params: { epicId, stage, status } })` | `cleo pipeline record T1575 research done` | Record stage progress |
| `query({ domain: "pipeline", operation: "stage.validate", params: { epicId, stage } })` | `cleo pipeline validate T1575 implementation` | Check gate before spawn |
| `mutate({ domain: "pipeline", operation: "stage.gate.pass", params: { epicId, stage } })` | `cleo pipeline gate-pass T1575 research` | Advance pipeline stage |

**Context Budget Rule**: Stay under 10K tokens. Use `cleo research list` over reading full files.

## Handoff Chain Protocol

Content flows between subagents via **manifest-mediated handoffs**, not through orchestrator context. The orchestrator reads only `key_findings` from MANIFEST.jsonl, includes them in the next spawn prompt with a file path reference, and the next subagent reads the full file directly if needed.

**Key rules**: Never read full subagent output — read manifests only. Never read full output files. Always include `key_findings` + file path in handoff prompts. Subagents read files directly; orchestrator reads only manifests.

> Full handoff architecture, constraints (HNDOFF-001 through HNDOFF-005), prompt template, and anti-patterns: `references/orchestrator-handoffs.md`

## Common HITL Patterns

| Pattern | When to Use | Key Operations |
|---------|-------------|----------------|
| Starting Fresh Epic | New feature work | `tasks.add`, `session.start`, `pipeline.stage.record`, `orchestrate.spawn` |
| Resuming Interrupted Work | New conversation | `orchestrate.start`, `pipeline.stage.status`, `research.pending` |
| Handling Manifest Followups | Subagent left TODOs | `research.pending`, `tasks.add` |
| Parallel Execution | Independent tasks in same wave | `orchestrate.analyze`, `orchestrate.ready` |
| Pipeline-Aware Orchestration | Multi-stage epics | `pipeline.stage.status`, `pipeline.stage.validate`, `pipeline.stage.gate.pass` |
| Quality Gates | Verification required | `check.schema`, `pipeline.stage.validate` |
| Release | Ship a version | `release.create`, `release.ship` |

> Full executable workflows for each pattern: `references/orchestrator-patterns.md`

## Autonomous Mode (AUTO-*)

When operating without continuous HITL oversight, the orchestrator follows additional constraints: single coordination point (AUTO-001), manifest-only reads (AUTO-002), separate decomposition (AUTO-003), verify before next spawn (AUTO-004), wave-order spawning (AUTO-005), followup task creation for partial/blocked (AUTO-006), handoff at 80% context (HNDOFF-001), and read last handoff before resuming (CONT-001).

**Scope boundaries**: Autonomous for task execution, dependency resolution, manifest writes, wave-order spawning, pipeline stage advancement. Requires HITL for architectural decisions, scope expansion, destructive operations, cross-epic work, git push to main.

> Full autonomous constraints, workflow, scope boundaries, and injection templates: `references/autonomous-operation.md`

## Anti-Patterns (MUST NOT)

1. **MUST NOT** read full research files — use manifest summaries
2. **MUST NOT** spawn parallel subagents without checking dependencies
3. **MUST NOT** implement code directly — delegate via `orchestrate.spawn`
4. **MUST NOT** exceed 10K context tokens
5. **MUST NOT** skip protocol injection when spawning subagents
6. **MUST NOT** spawn tasks out of dependency order
7. **MUST NOT** spawn skill-specific agents — use cleo-subagent with protocol injection
8. **MUST NOT** spawn with unresolved tokens (check `tokenResolution.fullyResolved`)
9. **MUST NOT** write, edit, or implement code directly
10. **MUST NOT** spawn tasks that don't match the current pipeline stage
11. **MUST NOT** skip pipeline gate validation before spawning

## Tool Boundaries (MANDATORY)

| Rule | Rationale |
|------|-----------|
| **MUST NOT** implement code directly | Delegate via `orchestrate.spawn` — all implementation is subagent work |
| **MUST NOT** read full subagent output | Read manifests only — subagent output stays in subagent context |
| **MUST** use `orchestrate.spawn` for all delegation | Single spawn mechanism; returns fully-resolved prompt for provider adapter |
| **MUST** check pipeline stage before spawning | Ensure task type matches current RCASD stage |

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
