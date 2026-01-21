# CLEO Unified Vision

**The Task Management Protocol for Solo Developers and Their AI Coding Agents**

*Version 1.1.0 | January 2026*

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
10. [Command System Architecture](#command-system-architecture)
11. [For Solo Developers](#for-solo-developers)

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

## Command System Architecture

CLEO provides **55+ CLI commands** organized into functional categories that support the core philosophy. Each command is designed for machine consumption (JSON output, exit codes) with human readability as an opt-in feature (`--human`).

### Command Categories

| Category | Commands | Purpose | Philosophy Support |
|----------|----------|---------|-------------------|
| **Read** | 17 | Query without side effects | Context efficiency |
| **Write** | 14 | Modify task state | Anti-hallucination validation |
| **Analysis** | 8 | Decision support | Leverage scoring, triage |
| **Orchestration** | 6 | Multi-agent coordination | ORC protocol support |
| **Maintenance** | 10 | System administration | Data integrity |

### Read Commands (Context-Efficient Querying)

Commands that query state without modification. Use these liberally - they're designed for minimal context consumption.

| Command | Purpose | Context Impact |
|---------|---------|----------------|
| `list` | View all tasks with filters | Medium (full metadata) |
| `find "query"` | Fuzzy search tasks | **99% less than list** |
| `show <id>` | Full single task details | Low (one task) |
| `exists <id>` | Validate task ID exists | Minimal (exit code only) |
| `dash` | Project overview | Low (summary) |
| `next` | Suggest next task | Low (one recommendation) |
| `deps <id>` | Show dependencies | Low |
| `blockers` | Show blocked tasks | Low |
| `tree` | Hierarchical task view | Medium |
| `phases` | Phase progress overview | Low |
| `labels` | Label listing with counts | Low |
| `stats` | Project statistics | Low |
| `log` | Audit trail entries | Medium |
| `history` | Completion timeline | Medium |
| `commands` | Command discovery | Low |
| `context` | Context window usage | Minimal |
| `roadmap` | Project roadmap view | Medium |

**Context Efficiency Pattern:**
```bash
# ✅ EFFICIENT: Discovery → Specific lookup
cleo find "auth"              # Find candidates (minimal fields)
cleo show T1234               # Get full details (one task)

# ❌ INEFFICIENT: Full list when searching
cleo list | jq '.tasks[] | select(.title | contains("auth"))'
```

### Write Commands (Anti-Hallucination Validated)

Every write command passes through four validation layers before modifying state.

| Command | Purpose | Validation Enforced |
|---------|---------|---------------------|
| `add "Title"` | Create new task | Unique ID, required fields |
| `update <id>` | Modify task fields | ID exists, valid enum values |
| `complete <id>` | Mark task done | ID exists, sets `implemented` gate |
| `delete <id>` | Cancel/soft-delete task | ID exists, reason required |
| `uncancel <id>` | Restore cancelled task | Was cancelled |
| `reopen <id>` | Restore completed task | Was completed |
| `reparent <id>` | Move in hierarchy | Valid parent, depth ≤3 |
| `promote <id>` | Remove parent (make root) | Has parent |
| `focus set <id>` | Set active task | ID exists, sets status=active |
| `focus note` | Add session progress note | Session active |
| `verify <id>` | Set verification gate | ID exists, valid gate name |
| `archive` | Move done tasks to archive | Completed tasks only |
| `unarchive <id>` | Restore from archive | Exists in archive |
| `reorder <id>` | Change sibling position | Valid position |

**Validation Layers (All Writes):**
```
1. Schema     → JSON structure valid
2. Semantic   → Business logic (unique IDs, valid enums)
3. Cross-file → Referential integrity (parent exists)
4. State      → Valid transitions (pending→active→done)
```

### Analysis Commands (Decision Support)

Commands that help agents and developers make informed decisions about what to work on.

| Command | Purpose | Output |
|---------|---------|--------|
| `analyze` | **Task triage with leverage scoring** | Priority-ranked task list |
| `analyze --auto-focus` | Analyze and set focus to top task | Sets focus automatically |
| `blockers analyze` | Critical path analysis | Blocking chain visualization |
| `deps tree` | Full dependency graph | Tree visualization |
| `next --explain` | Suggestion with reasoning | Why this task next |
| `phases stats` | Detailed phase breakdown | Progress by phase |
| `archive-stats` | Completion analytics | By phase, label, time |
| `sequence check` | ID sequence integrity | Gap detection |

**The `analyze` Command:**

The `analyze` command is central to CLEO's decision-making support. It calculates **leverage scores** based on:
- Priority weight (critical=4, high=3, medium=2, low=1)
- Dependency unblocking (tasks that unblock others score higher)
- Size strategy (configurable: quick-wins, big-impact, balanced)

```bash
cleo analyze                    # JSON with scored tasks
cleo analyze --parent T001      # Analyze epic's children only
cleo analyze --auto-focus       # Auto-set focus to top task
cleo config set analyze.sizeStrategy quick-wins  # Favor small tasks
```

### Orchestration Commands (Multi-Agent Coordination)

Commands that support the Orchestrator Protocol for managing complex workflows with subagents.

| Command | Purpose | ORC Support |
|---------|---------|-------------|
| `orchestrator spawn <id>` | Generate subagent spawn command | ORC-002 (delegation) |
| `orchestrator next` | Get next task for spawning | ORC-004 (dependency order) |
| `orchestrator ready` | List parallel-safe tasks | Wave-based execution |
| `orchestrator analyze` | Show dependency waves | Wave visualization |
| `orchestrator validate` | Check protocol compliance | ORC constraint verification |
| `safestop` | Graceful agent shutdown | Context preservation |

**Orchestrator Workflow:**
```bash
# 1. Analyze waves
cleo orchestrator analyze T001

# 2. Get next task respecting dependencies
cleo orchestrator next --epic T001

# 3. Spawn subagent for task
cleo orchestrator spawn T1234

# 4. On context limit, graceful shutdown
cleo safestop --reason "context-limit" --handoff ./handoff.json
```

### Session Commands (Context Preservation)

Commands that maintain continuity across conversations and agent sessions.

| Command | Purpose | Persistence |
|---------|---------|-------------|
| `session start` | Begin work session | Creates session record |
| `session end` | End session (resumable) | Preserves state |
| `session suspend` | Pause session | Waiting for external |
| `session resume <id>` | Continue session | Full context restored |
| `session close <id>` | Archive permanently | All tasks must be done |
| `session list` | Show all sessions | Filter by status |
| `session switch <id>` | Change active session | Multi-session support |
| `session status` | Current session info | Quick check |

### Research Commands (Knowledge Persistence)

Commands that support the manifest-based research system for orchestrator workflows.

| Command | Purpose | Manifest Integration |
|---------|---------|---------------------|
| `research "query"` | Multi-source web research | Creates manifest entry |
| `research --library X` | Library docs via Context7 | Curated documentation |
| `research --reddit` | Reddit discussions | Community insights |
| `research --url` | Extract from URL | Direct extraction |
| `research init` | Initialize outputs directory | Creates MANIFEST.jsonl |
| `research list` | List manifest entries | Query by status |
| `research show <id>` | Show research details | Full or summary |
| `research inject` | Subagent protocol template | ORC-003 compliance |
| `research link <task> <id>` | Link research to task | Traceability |

### Maintenance Commands (System Health)

Commands for maintaining data integrity and system health.

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `validate` | Check file integrity | After errors |
| `validate --fix` | Repair checksum issues | Recovery |
| `backup` | Create snapshot backup | Before risky ops |
| `restore` | Restore from backup | Recovery |
| `upgrade` | Unified maintenance | After CLEO update |
| `doctor` | System health diagnostics | Troubleshooting |
| `doctor --fix` | Auto-fix issues | Automated repair |
| `migrate-backups` | Backup taxonomy migration | Legacy systems |
| `sequence show/check` | ID sequence state | Integrity check |
| `self-update` | Update CLEO installation | Keep current |

### Multi-Agent Setup Commands

Commands for configuring CLEO across multiple AI coding agents.

| Command | Purpose | Files Affected |
|---------|---------|----------------|
| `init` | Initialize project + inject docs | CLAUDE.md, AGENTS.md, GEMINI.md |
| `upgrade` | Update all project injections | All agent docs |
| `setup-agents` | Global agent configuration | ~/.claude/CLAUDE.md, etc. |
| `claude-migrate` | Migrate from legacy formats | Config files |

### Import/Export Commands

Commands for cross-project task transfer.

| Command | Purpose | Format |
|---------|---------|--------|
| `export-tasks <id>` | Export task(s) to file | JSON |
| `export-tasks --subtree` | Export with children | JSON |
| `import-tasks <file>` | Import from file | JSON |
| `export --format csv` | Export all to CSV | CSV |
| `export --format todowrite` | Export for TodoWrite | TodoWrite format |

### Command Aliases

Built-in shortcuts for common operations:

| Alias | Expands To | Purpose |
|-------|------------|---------|
| `ct` | `cleo` | Short form |
| `ls` | `list` | Unix familiarity |
| `done` | `complete` | Natural language |
| `new` | `add` | Natural language |
| `edit` | `update` | Natural language |
| `rm` | `archive` | Unix familiarity |
| `check` | `validate` | Natural language |
| `tags` | `labels` | Alternative term |
| `overview` | `dash` | Descriptive |
| `dig` | `research` | Short form |
| `tree` | `list --tree` | Convenience |
| `cancel` | `delete` | Alternative term |
| `restore-cancelled` | `uncancel` | Descriptive |
| `restore-done` | `reopen` | Descriptive |
| `swap` | `reorder` | Alternative term |

### How Commands Support Philosophy

| Philosophy Principle | Supporting Commands |
|---------------------|---------------------|
| **Anti-hallucination** | `exists`, `validate`, all write validation |
| **Context efficiency** | `find` (99% less), `show` (single task) |
| **Agent-first output** | All commands default JSON, exit codes |
| **Session persistence** | `session *`, `focus *` |
| **Audit trails** | `log`, `history`, automatic logging |
| **Atomic operations** | All writes via `backup` + `validate` |
| **Orchestrator protocol** | `orchestrator *`, `research *`, `safestop` |

### Command Discovery

```bash
cleo commands                    # List all commands (JSON)
cleo commands --human            # Human-readable list
cleo commands -c write           # Filter by category
cleo commands -r critical        # Filter by agent relevance
cleo commands add                # Details for specific command
cleo commands --workflows        # Agent workflow sequences
cleo help <command>              # Detailed help
```

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
| **Commands** | 55+ CLI operations | Read, Write, Analysis, Orchestration, Maintenance |
| **Solo Dev** | Human-agent partnership | Shared source of truth |

**CLEO: The contract between you and your AI coding agent.**

---

*This document synthesizes findings from comprehensive research waves covering CLEO's historical origins, architecture, integrations, and operational patterns. It serves as the authoritative reference bridging all layers of the CLEO system.*
