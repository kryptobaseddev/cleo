# CLEO Unified Vision

**The Task Management Protocol for Solo Developers and Their AI Coding Agents**

*Version 1.0.0 | January 2026*

---

## Table of Contents

1. [Mission Statement](#mission-statement)
2. [Core Philosophy](#core-philosophy)
3. [Architecture Layers](#architecture-layers)
4. [Task Hierarchy](#task-hierarchy)
5. [Orchestrator Protocol](#orchestrator-protocol)
6. [Skills System](#skills-system)
7. [MCP Integration](#mcp-integration)
8. [Data Flow](#data-flow)
9. [Session Protocol](#session-protocol)
10. [For Solo Developers](#for-solo-developers)

---

## Mission Statement

**CLEO is the contract between you and your AI coding agent.**

It provides a structured protocol that:
- **Prevents hallucination** through four-layer validation
- **Maintains context** across sessions with immutable audit trails
- **Enables reliable workflows** through atomic operations and exit codes
- **Scales complexity** via orchestrated multi-agent coordination

**One developer. One AI agent. One source of truth.**

---

## Core Philosophy

### Agent-First Design

CLEO is built for LLM agents first, with human accessibility second. Traditional task management assumes human users, but when your primary "user" is Claude Code, everything changes:

| Dimension | Human User | LLM Agent |
|-----------|------------|-----------|
| **Input preference** | Natural language, flexibility | Structured data, constraints |
| **Error handling** | Reads error messages | Branches on exit codes |
| **Validation** | Trusts own judgment | Needs external ground truth |
| **Context** | Maintains mental model | Loses context between sessions |
| **Completion** | Knows when "done" | Needs explicit success criteria |

### Five Founding Principles

1. **Simplicity** - Flat sequential IDs (`T001`, `T042`) that never change
2. **Flat Structures** - Three-level hierarchy maximum (Epic -> Task -> Subtask)
3. **Computed Metrics** - No time estimates; scope-based sizing only
4. **Portability** - Single installation, per-project initialization
5. **Dual Readability** - JSON for agents (default), human-readable on request

### Anti-Hallucination Protocol

Every operation undergoes four-layer validation:

```
Layer 1: JSON Schema Enforcement
    ├── Structure validation
    ├── Type checking
    ├── Enum constraints (status: pending|active|blocked|done)
    └── Format validation (ISO 8601 timestamps, T### IDs)

Layer 2: Semantic Validation
    ├── ID uniqueness (across todo.json + archive)
    ├── Timestamp sanity (not future, completedAt > createdAt)
    ├── Content pairing (title != description)
    └── Duplicate detection

Layer 3: Cross-File Integrity
    ├── Referential integrity (log entries reference valid IDs)
    ├── Archive consistency
    └── Synchronized updates

Layer 4: State Machine Validation
    ├── Valid status transitions only
    ├── Configuration policy enforcement
    └── Constraint checking
```

### Atomic Operations

Every file modification follows this pattern:

```
1. Write to temporary file (.todo.json.tmp)
2. Validate against JSON Schema
3. IF INVALID: Delete temp -> Abort -> Error
4. IF VALID:
   a. Backup current file -> .cleo/.backups/todo.json.N
   b. Atomic rename: .tmp -> .json (OS-level guarantee)
   c. Log operation to todo-log.json
```

**No partial writes. No data corruption. Full rollback on any failure.**

---

## Architecture Layers

CLEO implements a layered architecture with clear separation of concerns:

### Layer Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Layer                                │
│  55 command scripts in scripts/                                  │
│  add-task.sh | complete-task.sh | focus.sh | session.sh | ...   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Library Layer (57 modules)                  │
│                                                                  │
│  Layer 0: Core Utilities                                        │
│    exit-codes.sh | config.sh | paths.sh | jq-helpers.sh         │
│                                                                  │
│  Layer 1: Data Operations                                       │
│    file-ops.sh | validation.sh | logging.sh | backup.sh         │
│                                                                  │
│  Layer 2: Task Logic                                            │
│    task-operations.sh | phase-tracking.sh | sessions.sh         │
│    dependency-graph.sh | hierarchy.sh | focus-helpers.sh        │
│                                                                  │
│  Layer 3: Advanced Features                                     │
│    token-inject.sh | skill-dispatch.sh | skill-validate.sh      │
│    orchestrator-spawn.sh | research-manifest.sh                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Schema Layer (24 schemas)                  │
│  todo.schema.json | config.schema.json | sessions.schema.json   │
│  archive.schema.json | log.schema.json | research-manifest.json │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Data Layer                                │
│  .cleo/                                                         │
│    ├── todo.json          (active tasks)                        │
│    ├── todo-archive.json  (completed tasks)                     │
│    ├── config.json        (project configuration)               │
│    ├── todo-log.json      (immutable audit trail)               │
│    ├── sessions.json      (session state)                       │
│    └── .backups/          (operational backups)                 │
└─────────────────────────────────────────────────────────────────┘
```

### Exit Code System

CLEO uses numeric exit codes for programmatic handling:

| Range | Purpose | Examples |
|-------|---------|----------|
| `0` | Success | Operation completed |
| `1-9` | General errors | Not found (4), invalid input (6), file error (7) |
| `10-19` | Hierarchy errors | Parent not found (10), depth exceeded (11) |
| `20-29` | Concurrency errors | Checksum mismatch (20), ID collision (21) |
| `50-54` | Context alerts | Warning (50), caution (51), critical (52), emergency (53) |
| `100+` | Special conditions | No data (100), already exists (101), no change (102) |

---

## Task Hierarchy

### Three Levels Only

```
Epic (strategic initiative)
  └── Task (primary work unit)
        └── Subtask (atomic operation)
```

**Why not deeper?** Research shows 3 levels is optimal for navigation. Deeper nesting increases cognitive overhead for both humans and agents.

### Flat Sequential IDs

| Aspect | Hierarchical (`T001.2.3`) | Flat (`T042`) |
|--------|---------------------------|---------------|
| **Stability** | Breaks on restructure | Never changes |
| **Git references** | `"Fixes T001.2.3"` -> orphaned | `"Fixes T042"` -> eternal |
| **LLM reasoning** | Unbounded pattern space | Bounded, predictable |
| **Multi-agent** | ID collision on parallel create | Single counter, no collision |

**Key insight: Hierarchy is a relationship, not identity.**

```json
{
  "id": "T042",        // Never changes
  "parentId": "T001",  // Can be updated via reparent
  "type": "task"       // epic | task | subtask
}
```

### Configurable Limits

| Constraint | Default | Purpose |
|------------|---------|---------|
| Max depth | 3 | Prevents over-nesting |
| Max siblings | 20 | LLM-optimized (not human 7+/-2) |
| Max active siblings | 8 | Focuses current work |

### Auto-Completion with Verification Gates

Epics auto-complete when all children are done AND verified:

```
Verification Gates:
  ├── implemented    (auto-set by complete)
  ├── testsPassed    (tests pass)
  ├── qaPassed       (QA review done)
  ├── securityPassed (security scan clear)
  └── documented     (documentation complete)
```

---

## Orchestrator Protocol

### Conductor, Not Musician

The orchestrator coordinates complex workflows by **delegating ALL work** to subagents while preserving its own context. It reads only manifest summaries, never full file contents.

### Five Immutable ORC Constraints

| ID | Constraint | Enforcement |
|----|-----------|-------------|
| ORC-001 | Stay high-level: coordinate, don't implement | Delegation required |
| ORC-002 | Delegate everything via Task tool | No direct work |
| ORC-003 | Read only manifest key_findings (not full files) | Context preservation |
| ORC-004 | Spawn tasks in dependency wave order | Execution correctness |
| ORC-005 | Maintain 10K token budget | Context efficiency |

### Wave-Based Execution

Tasks are grouped by dependency depth for parallel execution:

```
Wave 0: [T001, T002, T003]  <- No dependencies
         │
         ▼
Wave 1: [T004, T005]        <- Depends on Wave 0
         │
         ▼
Wave 2: [T006]              <- Depends on Wave 1
```

**Wave computation algorithm:**
1. Extract dependency graph from tasks
2. Calculate depth for each task (0 if no deps)
3. Group tasks by depth into waves
4. Spawn all tasks in wave N before wave N+1

### Manifest-Based Handoff

Subagents write to `MANIFEST.jsonl` with key findings:

```json
{
  "id": "auth-research-2026-01-20",
  "title": "Authentication Research",
  "status": "complete",
  "key_findings": [
    "JWT tokens should rotate every 24 hours",
    "Refresh tokens require separate storage",
    "Rate limiting prevents brute force attacks"
  ],
  "needs_followup": ["T1235", "T1236"],
  "linked_tasks": ["T1234"]
}
```

**Context efficiency:** ~200 tokens/entry vs ~5000+ tokens for full file reads (25x savings).

### Seven Epic Types

| Type | Use Case | Pattern |
|------|----------|---------|
| Feature | New functionality | Greenfield implementation |
| Bug Fix | Defect resolution | Investigation -> fix -> verify |
| Research | Information gathering | Multi-source synthesis |
| Refactor | Code improvement | Behavior-preserving transformation |
| Migration | System upgrade | Incremental, reversible changes |
| Brownfield | Existing codebase changes | Discovery-first approach |
| Greenfield | New project/component | Clean-slate implementation |

---

## Skills System

### Skill Architecture

CLEO includes 14 specialized skills for different task types:

```
skills/
├── manifest.json              (single source of truth)
├── _shared/                   (shared protocols and tokens)
│   ├── subagent-protocol-base.md
│   ├── task-system-integration.md
│   └── placeholders.json
├── ct-epic-architect/         (epic planning)
├── ct-orchestrator/           (workflow coordination)
├── ct-docs-lookup/            (library documentation)
├── ct-docs-write/             (documentation creation)
├── ct-docs-review/            (documentation review)
├── ct-documentor/             (docs orchestration)
├── ct-research-agent/         (information gathering)
├── ct-task-executor/          (generic implementation)
├── ct-test-writer-bats/       (BATS test creation)
├── ct-spec-writer/            (specification writing)
├── ct-library-implementer-bash/ (bash library creation)
├── ct-validator/              (compliance checking)
├── ct-skill-lookup/           (skill discovery)
└── ct-skill-creator/          (skill creation)
```

### Skill Dispatch

Three-tier dispatch strategy:

1. **Label match** - Task labels map to skill triggers
2. **Type match** - Task type (epic/task/subtask) determines skill
3. **Keyword match** - Task title keywords trigger skills
4. **Fallback** - `ct-task-executor` handles unmatched tasks

### Token Injection

Skills use `{{TOKEN}}` placeholders resolved at spawn time:

```markdown
## Task Context

- **Task ID**: {{TASK_ID}}
- **Title**: {{TASK_TITLE}}
- **Description**: {{TASK_DESCRIPTION}}

## Execution

1. Set focus: {{TASK_FOCUS_CMD}} {{TASK_ID}}
2. Do work...
3. Complete: {{TASK_COMPLETE_CMD}} {{TASK_ID}}
```

Token sources (priority order):
1. `placeholders.json` - Canonical registry
2. Task context - From CLEO task data
3. Skill-specific - Per-skill customizations
4. Defaults - Fallback values

### Subagent Protocol (OUT-001 to OUT-004)

| ID | Rule | Purpose |
|----|------|---------|
| OUT-001 | MUST write to `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md` | Persistent storage |
| OUT-002 | MUST append ONE line to `{{MANIFEST_PATH}}` | O(1) lookup |
| OUT-003 | MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary." | Context preservation |
| OUT-004 | MUST NOT return content in response | Prevents context bloat |

### Skill Patterns

| Pattern | Description | Example |
|---------|-------------|---------|
| Single-level | One skill handles entire task | `ct-task-executor` |
| Skill chaining | Skill loads other skills in same context | `ct-documentor` loads `ct-docs-lookup` + `ct-docs-write` + `ct-docs-review` |
| Multi-level | Orchestrator spawns skills via Task tool | Max 3 levels deep |

---

## MCP Integration

### Recommended Tools

| Tool | Purpose | Recommendation |
|------|---------|----------------|
| **Context7** | Library documentation lookup | HIGHLY RECOMMENDED |
| **Tavily** | Current web research | Recommended for research tasks |
| **Claude-in-Chrome** | Browser automation | Optional for visual tasks |

### Context7 Usage

Use for version-specific, curated documentation that prevents hallucination from outdated training data:

```bash
# Before implementing
"How do I configure authentication with Auth0?" -> Context7

# For framework patterns
"React 19 useEffect best practices" -> Context7

# For library APIs
"Drizzle ORM migration syntax" -> Context7
```

### Integration Patterns

**Research Pipeline:**
```
Context7 (docs) -> Tavily (current info) -> Chrome (verification)
```

**Documentation Verification:**
```
Read docs -> Chrome screenshot -> Compare to implementation
```

**Epic Planning Research:**
```
Context7 (framework patterns) -> Tavily (alternatives) -> Synthesis
```

### Tool Selection Matrix

| Task Type | Primary MCP | Backup MCP |
|-----------|-------------|------------|
| Library usage | Context7 | Tavily |
| Current events | Tavily | WebSearch |
| Visual verification | Chrome | None |
| API documentation | Context7 | Tavily |
| Competitive research | Tavily | Chrome |

---

## Data Flow

### Task Lifecycle

```
                    ┌─────────────┐
                    │   CREATE    │
                    │  add-task   │
                    └──────┬──────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                      todo.json                          │
│                                                         │
│  Tasks flow through statuses:                          │
│                                                         │
│  pending ──► active ──► done ──► [archive policy]     │
│      │         │                        │              │
│      └─────► blocked ──────────────────►│              │
│                                                         │
└──────────────────────────┬──────────────────────────────┘
                           │
                           │ Archive Policy Triggered
                           ▼
┌─────────────────────────────────────────────────────────┐
│                  todo-archive.json                       │
│                                                         │
│  Completed tasks (immutable storage)                   │
│  Default: Archive after 7 days                         │
└─────────────────────────────────────────────────────────┘

All operations logged to: todo-log.json (append-only)
All writes backed up to:  .cleo/.backups/
```

### Research Output Flow

```
┌─────────────────────────────────────────────────────────┐
│                    SUBAGENT WORK                         │
│                                                         │
│  1. Read task: cleo show T1234                         │
│  2. Set focus: cleo focus set T1234                    │
│  3. Do work...                                          │
│  4. Write output file                                   │
│  5. Append to manifest                                  │
│  6. Complete: cleo complete T1234                      │
│  7. Return: "Research complete. See MANIFEST.jsonl..."  │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              claudedocs/research-outputs/               │
│                                                         │
│  2026-01-20_topic-slug.md  <── Full content            │
│  MANIFEST.jsonl            <── Key findings only       │
│                                (orchestrator reads this)│
└─────────────────────────────────────────────────────────┘
```

### Backup Tiers

| Tier | Location | Purpose | Trigger |
|------|----------|---------|---------|
| Tier 1 | `.cleo/.backups/` | Atomic write safety | Every write |
| Tier 2 | `.cleo/backups/{type}/` | Point-in-time recovery | Manual or pre-destructive |

---

## Session Protocol

### Why Sessions Matter

Agents lose context between invocations. Sessions provide checkpoints for context recovery, agent handoffs, and debugging.

### Session States

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│ active  │ ──► │suspended│ ──► │  ended  │ ──► │ closed  │
└─────────┘     └─────────┘     └─────────┘     └─────────┘
     │               │               │               │
Currently      Paused         Complete         Archived
working      (resumable)   (resumable)    (permanent)
```

### Session Workflow

```bash
# START Phase (State Awareness)
cleo session list              # Check existing sessions
cleo dash                      # Project overview
cleo session resume <id>       # Resume existing
# OR
cleo session start --scope epic:T001 --auto-focus

# WORK Phase
cleo focus set T042            # Set active task
cleo focus note "Progress..."  # Add session notes
cleo complete T042             # Complete task
cleo focus set T043            # Next task

# END Phase
cleo archive                   # Clean up completed
cleo session end --note "Summary of work"
```

### Multi-Session Architecture

Multiple agents can work concurrently on different scopes:

```bash
# Agent 1: Working on auth epic
cleo session start --scope epic:T001 --agent opus-1

# Agent 2: Working on UI epic (different scope = no conflict)
cleo session start --scope epic:T050 --agent sonnet-1
```

**Scope types:**
| Type | Definition | Example |
|------|------------|---------|
| `task` | Single task only | `--scope task:T005` |
| `taskGroup` | Parent + direct children | `--scope taskGroup:T005` |
| `subtree` | Parent + all descendants | `--scope subtree:T001` |
| `epicPhase` | Epic filtered by phase | `--scope epicPhase --root T001 --phase testing` |
| `epic` | Full epic tree | `--scope epic:T001` |

### Five-Phase Discipline

```
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────────┐
│  setup  │──►│  core   │──►│ testing │──►│ polish  │──►│ maintenance │
└─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────────┘
     │             │             │             │               │
 Foundation    Feature      Validation   Refinement    Ongoing
 & planning  development   & QA         & docs        support
```

Tasks inherit `project.currentPhase` on creation. Use `--phase` to override.

---

## For Solo Developers

### The Daily Workflow

You're building something. Claude Code is your pair programmer. CLEO is your shared memory.

**Morning routine:**
```bash
cleo session start
cleo dash              # See project state
cleo focus show        # What was I working on?
cleo next --explain    # What should I do next?
```

**During work:**
```bash
cleo focus set T042              # Start task
cleo update T042 --notes "..."   # Document progress
cleo complete T042               # Finish task
```

**End of day:**
```bash
cleo session end --note "Completed auth flow, tests passing"
```

### What CLEO Solves

| Problem | CLEO Solution |
|---------|---------------|
| Claude forgets yesterday's context | Session notes + audit logs |
| Unclear which tasks are actually done | Verification gates + status tracking |
| Hallucinated task references | ID validation on every operation |
| Context degrades over long sessions | Manifest-based handoffs |
| Complex workflows overwhelm context | Orchestrator with 10K token budget |

### Quick Reference

| Command | Purpose |
|---------|---------|
| `cleo dash` | Project overview |
| `cleo list` | View tasks |
| `cleo find "query"` | Search tasks (99% less context) |
| `cleo show T###` | Full task details |
| `cleo add "Title"` | Create task |
| `cleo complete T###` | Complete task |
| `cleo focus set T###` | Set active task |
| `cleo next` | Suggest next task |
| `cleo session start/end` | Session lifecycle |
| `cleo context` | Check context usage |

### The Contract

When you use CLEO with Claude Code, you're establishing a formal contract:

1. **Tasks are identified by stable IDs** (`T001`) that never change
2. **All output is machine-parseable** by default (JSON)
3. **All errors have numeric exit codes** for programmatic handling
4. **All operations validate first**, fail fast on invalid input
5. **All state is persisted** in `todo.json` as single source of truth
6. **All changes are logged** in immutable audit trail
7. **All writes are atomic** with automatic backup and rollback

This contract enables **reliable, repeatable AI-assisted development**.

---

## Summary

CLEO bridges the gap between human intention and AI execution:

| Layer | Purpose | Implementation |
|-------|---------|----------------|
| **Mission** | Reliable AI-assisted development | Anti-hallucination + persistence |
| **Philosophy** | Agent-first design | JSON output, exit codes, validation |
| **Architecture** | Clear separation of concerns | CLI -> lib -> schema -> data |
| **Hierarchy** | Organized work breakdown | Epic -> Task -> Subtask (max 3) |
| **Orchestrator** | Complex workflow coordination | ORC constraints, wave execution |
| **Skills** | Specialized agent capabilities | 14 skills with token injection |
| **MCP** | External tool integration | Context7, Tavily, Chrome |
| **Data Flow** | Traceable state management | todo -> archive -> log lifecycle |
| **Sessions** | Context preservation | Multi-session with scoped isolation |
| **Solo Dev** | Human-agent partnership | Shared source of truth |

**CLEO: The contract between you and your AI coding agent.**

---

*This document synthesizes findings from comprehensive research waves covering CLEO's historical origins, architecture, integrations, and operational patterns. It serves as the authoritative reference bridging all layers of the CLEO system.*
