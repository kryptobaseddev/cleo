# CLEO Agent Injection Protocol

**Version**: 2.0.0
**Status**: ACTIVE

<!-- MVI Progressive Disclosure Architecture
     Tier 0 (Minimal):       ALL agents — identity, MCP tools, CLI fallback, errors
     Tier 1 (Standard):      Lead agents — sessions, RCSD-IVTR, research, tokens, skills
     Tier 2 (Orchestrator):  Orchestrators — ORC constraints, spawn pipeline, lifecycle gates

     Include tiers cumulatively: Orchestrator agents get all three tiers.
     Conditional markers: <!-- TIER:minimal --> <!-- TIER:standard --> <!-- TIER:orchestrator -->
-->

---

<!-- TIER:minimal -->

## CLEO Identity

CLEO is the task management protocol for AI coding agents. It provides structured task tracking, session management, and multi-agent coordination with anti-hallucination validation.

### Time Estimates Prohibited (RFC 2119)

- **MUST NOT** estimate hours, days, weeks, or temporal duration
- **MUST** use relative sizing: `small` / `medium` / `large`
- **SHOULD** describe scope, complexity, dependencies when asked

## MCP Tools (Primary Interface)

MCP is the **primary** entry point. Use `cleo_query` for reads and `cleo_mutate` for writes.

### Read Operations (`cleo_query`)

| Domain | Operation | Description |
|--------|-----------|-------------|
| `tasks` | `show` | Get task details (`params: { taskId }`) |
| `tasks` | `find` | Search tasks (`params: { query }` or `{ id }`) |
| `tasks` | `list` | List tasks (`params: { parent?, status? }`) |
| `session` | `status` | Current session state |
| `session` | `list` | All sessions |
| `orchestrate` | `analyze` | Dependency wave analysis (`params: { epicId }`) |
| `orchestrate` | `ready` | Tasks ready to spawn (`params: { epicId }`) |
| `orchestrate` | `next` | Next task suggestion (`params: { epicId }`) |
| `research` | `list` | Research manifest entries |
| `research` | `show` | Research entry details (`params: { entryId }`) |
| `validate` | `report` | Validate task data integrity |
| `system` | `dash` | Project overview dashboard |
| `system` | `context` | Context window usage |
| `skills` | `list` | Available skills |
| `skills` | `show` | Skill details (`params: { name }`) |

### Write Operations (`cleo_mutate`)

| Domain | Operation | Description |
|--------|-----------|-------------|
| `tasks` | `add` | Create task (`params: { title, description?, parent?, depends? }`) |
| `tasks` | `update` | Update task (`params: { taskId, title?, status?, notes? }`) |
| `tasks` | `complete` | Complete task (`params: { taskId }`) |
| `session` | `start` | Start session (`params: { scope, name, autoStart? }`) |
| `session` | `end` | End session (`params: { note? }`) |
| `session` | `resume` | Resume session (`params: { sessionId }`) |
| `tasks` | `start` | Set active focus task (`params: { taskId }`) |
| `research` | `link` | Link research to task (`params: { taskId, entryId }`) |
| `orchestrate` | `spawn` | Generate spawn prompt for subagent (`params: { taskId }`) |

## CLI Fallback

When MCP tools are unavailable, use `ct` (alias for `cleo`) CLI commands.

### Essential Commands
```bash
ct show T1234              # Task details
ct find "query"            # Search (99% less context than list)
ct find --id 142           # Search by ID
ct add "Task title"        # Create task
ct complete T1234          # Complete task
ct focus set T1234         # Set active focus
ct dash                    # Project overview
```

### Error Handling

**CRITICAL: NEVER ignore exit codes. Failed commands = tasks NOT created/updated.**

After EVERY command:
1. Exit code `0` = success, `1-22` = error, `100+` = special (not error)
2. JSON `"success": false` = operation failed
3. Execute `error.fix` -- copy-paste-ready fix command

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | `E_NOT_FOUND` | Use `ct find` or `ct list` to verify |
| 6 | `E_VALIDATION_*` | Check field lengths, escape `$` as `\$` |
| 10 | `E_PARENT_NOT_FOUND` | Verify with `ct exists <parent-id>` |
| 11 | `E_DEPTH_EXCEEDED` | Max depth 3 (epic->task->subtask) |
| 12 | `E_SIBLING_LIMIT` | Max 7 siblings per parent |

### Task Discovery (Context Efficiency)

**MUST** use efficient commands -- `find` for discovery, `show` for details:
```bash
ct find "query"              # Minimal fields (99% less context)
ct show T1234                # Full details for specific task
ct list --parent T001        # Direct children only
```

`list` includes full notes arrays (huge). `find` returns minimal fields only.

<!-- /TIER:minimal -->

---

<!-- TIER:standard -->

## Session Protocol

Sessions track work context across agent interactions. **CRITICAL: Multi-session requires BOTH flags.**

### MCP Session Operations
```
cleo_mutate({ domain: "session", operation: "start",
  params: { scope: "epic:T001", name: "Work", autoStart: true }})
cleo_query({ domain: "session", operation: "status" })
cleo_mutate({ domain: "session", operation: "end", params: { note: "Progress" }})
```

### CLI Session Protocol
```bash
# START (ALWAYS first):
ct session list                # Check existing sessions
ct session status              # Current session
ct session resume <id>         # Resume existing
# OR (only if no suitable session):
ct session start --scope epic:T001 --auto-focus --name "Work"

# WORK:
ct focus show                  # Current focus
ct next                        # Task suggestion
ct add "Task" --depends T005   # Add related
ct complete T005               # Complete task
ct focus set T006              # Move focus

# END (ALWAYS when stopping):
ct complete <id>               # Complete current
ct archive                     # Clean up done tasks
ct session end --note "Progress"
```

## RCSD-IVTR Lifecycle

Projects follow a structured lifecycle with gate enforcement:

```
RCSD PIPELINE (setup phase):
  Research -> Consensus -> Specification -> Decomposition
                              |
                              v
EXECUTION (core/polish):
  Implementation -> Contribution -> Release
```

Each stage has a **lifecycle gate**. Entering a later stage requires prior stages to be `completed` or `skipped`. Gate enforcement mode is configured in `.cleo/config.json` (`strict` | `advisory` | `off`).

### Conditional Protocols (9 Types)

| Protocol | Keywords | Use Case |
|----------|----------|----------|
| Research | research, investigate, explore | Information gathering |
| Consensus | vote, validate, decide | Multi-agent decisions |
| Specification | spec, rfc, design | Document creation |
| Decomposition | epic, plan, decompose | Task breakdown |
| Implementation | implement, build, create | Code execution |
| Contribution | PR, merge, shared | Work attribution |
| Release | release, version, publish | Version management |
| Artifact Publish | publish, artifact, package | Artifact distribution |
| Provenance | provenance, attestation, SLSA | Supply chain integrity |

## Research & Manifest Operations

### Output Requirements

Subagent output files follow this structure:
```markdown
# <Title>

**Task**: T####
**Epic**: T####
**Date**: YYYY-MM-DD
**Status**: complete | partial | blocked

---

## Summary
<2-3 sentence executive summary>

## Content
<main deliverable>
```

### Manifest Entry (MANIFEST.jsonl)

Append ONE line (no pretty-printing):
```json
{"id":"T####-slug","file":"path","title":"...","date":"YYYY-MM-DD","status":"complete","agent_type":"research","topics":[],"key_findings":[],"actionable":true,"needs_followup":[],"linked_tasks":["T####"]}
```

### Status Classification

| Status | Condition | Action |
|--------|-----------|--------|
| `complete` | All objectives achieved | Complete normally |
| `partial` | Some objectives achieved | Populate `needs_followup` |
| `blocked` | Cannot proceed | Document blocker |

## Token System

Orchestrators resolve ALL tokens before spawning subagents. Subagents CANNOT resolve `@` references or `{{TOKEN}}` patterns.

### Standard Tokens

| Token | Description |
|-------|-------------|
| `{{TASK_ID}}` | Current task identifier |
| `{{EPIC_ID}}` | Parent epic identifier |
| `{{DATE}}` | Current date (ISO) |
| `{{TOPIC_SLUG}}` | URL-safe topic name |
| `{{OUTPUT_DIR}}` | Output directory |
| `{{MANIFEST_PATH}}` | Manifest file path |
| `{{TASK_TITLE}}` | Task title |
| `{{TASK_DESCRIPTION}}` | Task description |

### Command Tokens

| Token | Default |
|-------|---------|
| `{{TASK_SHOW_CMD}}` | `cleo show` |
| `{{TASK_FOCUS_CMD}}` | `cleo start` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_LINK_CMD}}` | `cleo research link` |

## Skill Ecosystem

Skills are **context injections, NOT agents**. The orchestrator selects and injects skill content into `cleo-subagent`.

### Discovery
```
cleo_query({ domain: "skills", operation: "list" })
cleo_query({ domain: "skills", operation: "show", params: { name: "ct-orchestrator" }})
```

### Key Skills

| Skill | Category | Use Case |
|-------|----------|----------|
| `ct-orchestrator` | orchestration | Multi-agent coordination |
| `ct-epic-architect` | planning | Epic decomposition |
| `ct-task-executor` | execution | General task execution |
| `ct-research-agent` | research | Information gathering |
| `ct-spec-writer` | specification | Document creation |
| `ct-validator` | validation | Quality checks |
| `ct-documentor` | documentation | Documentation generation |
| `ct-test-writer-bats` | testing | BATS test creation |

### Dispatch Priority
1. **Label-based**: Task labels match skill tags
2. **Catalog-based**: CAAMP dispatch matrix
3. **Type-based**: Task type maps to protocol
4. **Keyword-based**: Title/description matches triggers
5. **Fallback**: `ct-task-executor`

## Release Workflow

**CRITICAL**: `release ship` only commits version metadata. All code changes MUST be committed BEFORE running `release ship`.

```bash
git add <files> && git commit -m "feat(T####): description"
cleo release create v1.0.0
cleo release ship v1.0.0 --bump-version --create-tag --push
```

## Project Context

When available, project-specific configuration is loaded from `.cleo/project-context.json` (generated by `cleo init --detect`). Contains detected project type, testing framework, and LLM hints.

<!-- /TIER:standard -->

---

<!-- TIER:orchestrator -->

## Architecture Overview

CLEO implements a **2-tier universal subagent architecture**:

```
Tier 0: ORCHESTRATOR (ct-orchestrator)
    |
    +-- Coordinates complex workflows
    +-- Spawns subagents via Task tool
    +-- Pre-resolves ALL tokens before spawn
    +-- Reads only manifest summaries (not full content)
    |
    v
Tier 1: CLEO-SUBAGENT (universal executor)
    |
    +-- Receives fully-resolved prompts
    +-- Loads skill via protocol injection
    +-- Executes delegated work
    +-- Outputs: file + manifest entry + summary
```

**Core Principle**: One universal subagent type (`cleo-subagent`) with context-specific protocols -- NOT skill-specific agents.

## Orchestrator Constraints (ORC)

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

## Spawn Pipeline

### MCP Spawn Operations
```
# Analyze dependency waves
cleo_query({ domain: "orchestrate", operation: "analyze", params: { epicId: "T001" }})

# Get ready tasks
cleo_query({ domain: "orchestrate", operation: "ready", params: { epicId: "T001" }})

# Get next task suggestion
cleo_query({ domain: "orchestrate", operation: "next", params: { epicId: "T001" }})
```

### CLI Spawn Operations
```bash
cleo orchestrator start --epic T001
cleo orchestrator analyze T001
cleo orchestrator ready --epic T001
cleo orchestrator next --epic T001
cleo orchestrator spawn T002
```

### Spawn Workflow

1. Select skill protocol for task (auto-dispatch or explicit)
2. Prepare spawn context (resolve ALL tokens)
3. Verify `tokenResolution.fullyResolved == true`
4. Spawn `cleo-subagent` with resolved prompt via Task tool

### Protocol Stack

Every spawn combines two layers:

```
+------------------------------------------+
| CONDITIONAL PROTOCOL (task-specific)     |
| - research.md, implementation.md, etc.   |
+------------------------------------------+
| BASE PROTOCOL (always loaded)            |
| - Lifecycle, output format, constraints  |
+------------------------------------------+
```

### Token Pre-Resolution

**CRITICAL**: Orchestrator MUST resolve ALL tokens before spawn. Verify:
- All `@` references resolved
- All `{{TOKEN}}` placeholders substituted
- `tokenResolution.fullyResolved == true`
- Task exists (`cleo exists T####`)
- Output directory exists

## Subagent (cleo-subagent)

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

### Subagent Lifecycle
```
SPAWN -> INJECT -> EXECUTE -> OUTPUT -> RETURN
```

1. **SPAWN**: Orchestrator invokes Task tool
2. **INJECT**: Subagent receives base protocol + conditional protocol
3. **EXECUTE**: Follow skill-specific instructions
4. **OUTPUT**: Write file + append manifest entry
5. **RETURN**: Completion signal only (no content)

### Return Messages

| Status | Message |
|--------|---------|
| Complete | `[Type] complete. See MANIFEST.jsonl for summary.` |
| Partial | `[Type] partial. See MANIFEST.jsonl for details.` |
| Blocked | `[Type] blocked. See MANIFEST.jsonl for blocker details.` |

## Lifecycle Gate Enforcement

CLEO enforces RCSD-IVTR lifecycle progression through automatic gate checks at spawn time.

```
research --+---> consensus --+---> specification --+---> decomposition
           |                 |                     |
           | GATE            | GATE                | GATE
           |                 |                     |
           +-----------------+---------------------+---> implementation ---> release
```

| Enforcement Mode | On Gate Failure | Default |
|------------------|-----------------|---------|
| `strict` | Blocks spawn with exit 75 | yes |
| `advisory` | Warns but proceeds | |
| `off` | Skips all checks | |

### Emergency Bypass
```bash
cleo config set lifecycleEnforcement.mode off
# ... emergency work ...
cleo config set lifecycleEnforcement.mode strict
```

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
| Skipping focus | Protocol violation | Always `cleo start` first |

<!-- /TIER:orchestrator -->

---

## References

- **Base Protocol**: `skills/_shared/subagent-protocol-base.md`
- **Task System Integration**: `skills/_shared/task-system-integration.md`
- **Project Lifecycle**: `docs/specs/PROJECT-LIFECYCLE-SPEC.md`
- **Protocol Stack**: `docs/specs/PROTOCOL-STACK-SPEC.md`
- **Orchestrator Skill**: `skills/ct-orchestrator/SKILL.md`
- **Subagent Agent**: `agents/cleo-subagent/AGENT.md`
