# CLEO Canonical Agent Decision Tree

**Task**: T5610
**Epic**: T5517
**Depends on**: T5609 decision matrix (`CLEO-OPERATIONS-CONSOLIDATION-DECISION.md`)
**Date**: 2026-03-08
**Status**: complete

---

## Overview

This document is the canonical decision tree for CLEO agent operation discovery. It answers one question for every agent goal: **"Given what I'm trying to do, what is the minimum-cost path to the right operation?"**

The tree enforces three invariants:

1. **Progressive disclosure**: agents start with 24 tier-0 ops and expand only when a goal demands it.
2. **No tier-2 gate without an escalation path**: every tier-2 domain has a clearly named tier-0 or tier-1 op that surfaces it.
3. **Anti-pattern prevention**: expensive or deprecated paths are never the first branch shown.

All gateway values are `query` (reads) or `mutate` (writes) per the MCP contract.

---

## Tier Structure

| Tier | Count | When Available | How Discovered |
|------|-------|---------------|----------------|
| **0** | 24 ops | Cold-start — no prior call required | Built into agent protocol |
| **1** | 84 ops | After session initialization | `query admin.help` (no tier flag) |
| **2** | 25 ops | Advanced / specialized workflows | `query admin.help {tier:2}` |
| **Plugin** | varies | Optional, domain-specific | `query tools.skill.list` |

### Tier 0 by Domain

| Domain | Ops (count) |
|--------|-------------|
| tasks | show, find, next, plan, current, add, update, complete, start, stop (10) |
| session | status, handoff.show, briefing.show, start, end (5) |
| memory | find, observe (2) |
| admin | version, health, dash, help (4) |
| tools | skill.list, provider.list, provider.detect (3) |
| check, pipeline, orchestrate, nexus, sticky | 0 each — all tier 1+ |
| **Total** | **24** |

### Tier-2 Escalation Paths (Invariant Enforcement)

Every tier-2 domain reachable only via an explicit `admin.help {tier:2}` call. The table below shows which tier-0/1 op surfaces each tier-2 cluster.

| Tier-2 Cluster | Entry Point (Tier) | Escalation Signal |
|----------------|-------------------|-------------------|
| `pipeline.chain.*` (8 ops) | `admin.help {tier:2}` (0) | `escalationHint` in admin.help response |
| `check.chain.*` (2 ops) | `admin.help {tier:2}` (0) | Same hint mechanism |
| `admin.token.*` (2 ops) | `admin.help {tier:2}` (0) | Same hint mechanism |
| `admin.export` / `admin.import` (2 ops) | `admin.help {tier:2}` (0) | Same hint mechanism |
| `nexus.show`, `nexus.resolve`, `nexus.deps`, `nexus.graph`, etc. | `nexus.status` + `nexus.list` (1) → `admin.help {tier:2}` | nexus.status response includes escalation notice |
| `check.grade`, `check.grade.list` | `admin.help {tier:2}` (0) | Same hint mechanism |
| `admin.adr.show`, `admin.export`, `admin.import` | `admin.help {tier:2}` (0) | Same hint mechanism |

---

## The Decision Tree

### Entry Point: Session Start (MANDATORY for every agent)

Every agent session MUST begin with this sequence before any other operation:

```
Agent starts work
│
├── STEP 1: query session.status
│   ├── Active session exists
│   │   └── query session.handoff.show  → resume prior context, then continue to STEP 2
│   └── No active session
│       └── mutate session.start {scope: "task:TXXX" | "epic:TXXX"}
│
├── STEP 2: query admin.dash  → project overview, active epic, blockers
│
├── STEP 3: query tasks.current  → is a task already in progress?
│   ├── Yes → continue that task (skip STEP 4)
│   └── No → STEP 4
│
└── STEP 4: query tasks.next  → what to work on next
    └── query tasks.show {taskId}  → full task requirements
```

**Anti-pattern blocked**: Never skip `session.status`. Resuming without `handoff.show` loses prior context and causes duplicate work.

---

### Goal: Discover Work

```
I need to find what to work on
│
├── What should I do next (auto-selected)?
│   └── query tasks.next  [tier 0]
│       └── query tasks.show {taskId}  [tier 0]  → full details
│
├── I know keywords — search for a specific task
│   └── query tasks.find {query: "..."}  [tier 0]
│       ├── Found one match → query tasks.show {taskId}
│       └── Need to browse children of a known parent
│           └── query tasks.list {parentId: "TXXX"}  [tier 1]  ← ONLY with parentId filter
│               ANTI-PATTERN: tasks.list with no parentId = full dump, never do this
│
├── I need a prioritized planning view (upcoming tasks, blockers, dependencies)
│   └── query tasks.plan  [tier 0]
│
├── I need the full task hierarchy under a parent
│   └── (discover via tasks.find first, then)
│   └── query tasks.tree {taskId}  [tier 1]  → subtask hierarchy
│
├── I need to see what's blocking a task
│   └── query tasks.blockers {taskId}  [tier 1]
│
└── I need leverage-sorted discovery (highest-impact tasks first)
    └── query tasks.analyze  [tier 1]
```

---

### Goal: Create and Update Tasks

```
I need to create or modify a task
│
├── Create a new task
│   └── mutate tasks.add {title, description, parentId?, status?}  [tier 0]
│       RULE: title and description MUST be different non-empty strings
│       RULE: status must be one of: pending | active | blocked | done
│
├── Update fields on an existing task
│   └── mutate tasks.update {taskId, ...fields}  [tier 0]
│
├── Mark a task as done
│   └── mutate tasks.complete {taskId}  [tier 0]
│
├── Start working on a task (activates focus tracking)
│   └── mutate tasks.start {taskId}  [tier 0]
│
├── Stop working (deactivates focus)
│   └── mutate tasks.stop  [tier 0]
│
├── Cancel a task (soft terminal state — use deliberately)
│   └── mutate tasks.cancel {taskId}  [tier 1]
│
├── Archive a task (completed task housekeeping)
│   └── mutate tasks.archive {taskId}  [tier 1]
│
├── Restore a task from done or archive
│   └── mutate tasks.restore {taskId, from: "done" | "archive"}  [tier 1]
│       VERB: use restore, NOT reopen or unarchive (both deprecated)
│
├── Delete a task (hard delete — irreversible)
│   └── mutate tasks.delete {taskId}  [tier 1]  ← requires deliberate escalation
│
├── Move a task to a different parent
│   └── mutate tasks.reparent {taskId, newParentId}  [tier 1]
│       └── Promote to top-level: tasks.reparent {taskId, newParentId: null}
│           VERB: use reparent, NOT promote (deprecated)
│
└── Add a relationship between tasks
    └── mutate tasks.relates.add {taskId, relatedId, type}  [tier 1]
```

---

### Goal: Track Session Context

```
I need to manage session lifecycle or read session state
│
├── Check whether a session is active
│   └── query session.status  [tier 0]
│
├── Resume prior context after a restart
│   └── query session.handoff.show  [tier 0]
│
├── Get a composite cold-start briefing (combines status + handoff)
│   └── query session.briefing.show  [tier 0]
│
├── Start a new session
│   └── mutate session.start {scope: "task:TXXX" | "epic:TXXX"}  [tier 0]
│       RULE: scope is required — no unscoped sessions
│
├── End the current session (triggers debrief + handoff generation)
│   └── mutate session.end  [tier 0]
│
├── Browse past sessions
│   └── query session.find {query: "..."}  [tier 1]
│       └── Full session record: query session.show {sessionId}  [tier 1]
│
├── Resume a specific prior session by ID
│   └── mutate session.resume {sessionId}  [tier 1]
│
├── Record a decision made during this session
│   └── mutate session.record.decision {text, rationale}  [tier 1]
│
└── Inspect context drift during a long session
    └── query session.context.drift  [tier 1]
```

---

### Goal: Memory Operations

```
I need to save or recall information across sessions
│
├── Save an observation right now (free-form)
│   └── mutate memory.observe {text, title?}  [tier 0]
│
├── Search for something I or a prior agent observed
│   └── query memory.find {query: "..."}  [tier 0]  ← ALWAYS start here (cheap)
│       └── Found interesting IDs → query memory.timeline {anchorId}  [tier 1]
│           └── Need full content → query memory.fetch {ids: [...]}  [tier 1]
│       3-LAYER PATTERN: find → timeline → fetch (never skip to fetch directly)
│
├── Save a structured decision (with rationale, alternatives, taskId)
│   └── mutate memory.decision.store {decision, rationale, taskId, alternatives?}  [tier 1]
│       └── Recall: query memory.decision.find {query, taskId?}  [tier 1]
│
├── Save a recurring pattern (with type, impact, antiPattern fields)
│   └── mutate memory.pattern.store {name, type, impact, success, antiPattern?}  [tier 1]
│       └── Recall: query memory.pattern.find {query, type?}  [tier 1]
│
├── Save a learning (confidence-gated)
│   └── mutate memory.learning.store {text, confidence, taskId?}  [tier 1]
│       └── Recall: query memory.learning.find {query, minConfidence?}  [tier 1]
│
└── Associate a memory entry with a task (research linking protocol)
    └── mutate memory.link {memoryId, taskId}  [tier 1]
```

**Anti-pattern blocked**: Never call `memory.fetch` without first calling `memory.find`. Fetching all entries is expensive and returns unfiltered data.

---

### Goal: Multi-Agent Coordination

```
I need to coordinate agent work (orchestrator role)
│
├── I am the orchestrator — start coordinating an epic
│   └── mutate orchestrate.start {epicId}  [tier 1]
│       └── query orchestrate.status  [tier 1]  → current orchestration state
│
├── Find the next spawnable task
│   └── query orchestrate.next  [tier 1]
│
├── Get the full set of ready-to-spawn tasks
│   └── query orchestrate.ready  [tier 1]
│
├── Spawn a subagent for a task
│   └── (1) mutate orchestrate.validate {taskId}  [tier 1]  → pre-spawn gate check
│       (2) mutate orchestrate.spawn {taskId, skillIds?}  [tier 1]  → spawn prep
│       (3) mutate orchestrate.spawn.execute {spawnPlan}  [tier 1]  → execute via adapter
│
├── Hand off context to a subagent (atomic 3-step)
│   └── mutate orchestrate.handoff {taskId, context}  [tier 1]
│
├── Run parallel wave of agents
│   └── mutate orchestrate.parallel {action: "start" | "end", waveId?}  [tier 1]
│
├── Analyze the task graph (critical path, bottlenecks)
│   └── query orchestrate.analyze {mode: "standard" | "critical-path"}  [tier 1]
│
└── I am a subagent — complete my work and report
    └── mutate tasks.complete {taskId}  [tier 0]
        mutate pipeline.manifest.append {entry}  [tier 1]  ← MANDATORY per BASE protocol
```

**Subagent BASE protocol requirement**: Every subagent MUST append one entry to MANIFEST.jsonl via `pipeline.manifest.append` before calling `tasks.complete`. Omitting this entry is a protocol violation (exit code 62).

---

### Goal: Cross-Project Data (nexus)

```
I need information about tasks in other projects
│
├── STEP 1 — Check if nexus is initialized
│   └── query nexus.status  [tier 1]  ← discovered via admin.help
│       ├── Not initialized → nexus requires setup by a human admin
│       │   Do NOT attempt nexus.init autonomously
│       └── Initialized → continue
│
├── STEP 2 — List registered projects
│   └── query nexus.list  [tier 1]
│
├── STEP 3 — Deeper cross-project queries (requires admin.help {tier:2})
│   └── query admin.help {tier:2}  [tier 0]  → reveals tier-2 nexus ops
│       ├── query nexus.show {project}  [tier 2]  → project detail
│       ├── query nexus.resolve {ref: "project:taskId"}  [tier 2]  → cross-project task lookup
│       ├── query nexus.deps {project, taskId}  [tier 2]  → cross-project dependencies
│       ├── query nexus.search {query}  [tier 2]  → search across all projects
│       ├── query nexus.discover {query}  [tier 2]  → semantic similarity across projects
│       └── query nexus.graph  [tier 2]  → full global dependency graph (expensive)
│
└── NEVER use filesystem fallback
    ANTI-PATTERN: reading ~/.cleo/projects-registry.json directly is forbidden
    Always use nexus.status + nexus.list as the canonical discovery path
```

**Escalation path invariant**: The nexus.status call (tier 1) MUST include an `escalationHint` in its response pointing agents to `admin.help {tier:2}` for deeper operations. Agents that need more than `status` + `list` MUST call `admin.help {tier:2}` first.

---

### Goal: Validate Work

```
I need to check compliance, schemas, or test status
│
├── Check protocol compliance for my current task
│   └── query check.protocol {taskId, protocolType?}  [tier 1]
│       protocolType options: "consensus" | "contribution" | "decomposition" | "implementation" | "specification"
│
├── Check overall compliance summary
│   └── query check.compliance.summary  [tier 1]
│       └── Need violations list: check.compliance.summary {detail: true}  [tier 1]
│
├── Validate a specific task's fields
│   └── query check.task {taskId}  [tier 1]
│
├── Check schema validity of a data file
│   └── query check.schema  [tier 1]
│
├── Check test status or coverage
│   └── query check.test {format: "status" | "coverage"}  [tier 1]
│       └── Run tests: mutate check.test.run  [tier 1]
│
├── Check a lifecycle gate status
│   └── query check.gate.status (split from gate.verify)  [tier 1]
│       └── Set/reset a gate: mutate check.gate.set  [tier 1]
│
└── Behavioral grading (advanced — requires tier-2 escalation)
    └── query admin.help {tier:2}  [tier 0]  → reveals check.grade
        └── query check.grade  [tier 2]
```

---

### Goal: Release and Pipeline

```
I need to manage a release or pipeline stage
│
├── Ship a release (all steps, or specific step)
│   └── mutate pipeline.release.ship  [tier 1]
│       └── Specific step: pipeline.release.ship {step: "prepare" | "changelog" | "commit" | "tag" | "push" | "gates"}
│       └── Rollback if needed: mutate pipeline.release.rollback  [tier 1]
│
├── Read pipeline stage state
│   └── query pipeline.stage.status {stageId, include?: ["gates"]}  [tier 1]
│       └── Validate prerequisites: query pipeline.stage.validate {stageId}  [tier 1]
│
├── Record a stage event
│   └── mutate pipeline.stage.record {stageId, ...}  [tier 1]
│       ├── Pass a gate: mutate pipeline.stage.gate.pass {stageId, gateId}  [tier 1]
│       └── Fail a gate: mutate pipeline.stage.gate.fail {stageId, gateId, reason}  [tier 1]
│
├── Work with the research manifest (subagent protocol)
│   ├── Read: query pipeline.manifest.show {id}  [tier 1]
│   ├── List: query pipeline.manifest.list {filter?: "pending"}  [tier 1]
│   ├── Search: query pipeline.manifest.find {query}  [tier 1]
│   └── Append (MANDATORY per BASE): mutate pipeline.manifest.append {entry}  [tier 1]
│
├── Manage pipeline phases
│   ├── Set phase: mutate pipeline.phase.set {phaseId, action: "start" | "complete"}  [tier 1]
│   └── Auto-advance: mutate pipeline.phase.advance  [tier 1]
│
└── WarpChain operations (advanced — requires tier-2 escalation)
    └── query admin.help {tier:2}  [tier 0]  → reveals pipeline.chain.*
        ├── query pipeline.chain.show  [tier 2]
        ├── mutate pipeline.chain.add  [tier 2]
        └── mutate pipeline.chain.instantiate  [tier 2]
        ANTI-PATTERN: These ops have no cold-start use. Always escalate first.
```

---

### Goal: Discover Available Skills and Providers

```
I need to know what skills or providers are available
│
├── List all installed skills (cold-start safe)
│   └── query tools.skill.list  [tier 0]
│       └── Detail on a specific skill: query tools.skill.show {skillId}  [tier 1]
│
├── List all known LLM/agent providers
│   └── query tools.provider.list  [tier 0]
│
├── Detect the currently active provider
│   └── query tools.provider.detect  [tier 0]
│
├── Install or update a skill
│   └── mutate tools.skill.install {skillId}  [tier 1]
│       └── Bulk update all skills: mutate tools.skill.refresh  [tier 1]
│
└── Advanced skill catalog (full protocol/profile metadata — tier 2)
    └── query admin.help {tier:2}  → reveals tools.skill.catalog
        └── query tools.skill.catalog {type: "protocols" | "profiles" | "resources" | "info"}  [tier 2]
```

---

### Goal: System Information

```
I need system or configuration info
│
├── What version of CLEO is running?
│   └── query admin.version  [tier 0]
│
├── Is the CLEO installation healthy?
│   └── query admin.health  [tier 0]
│       └── Run diagnostics: admin.health {mode: "diagnose"}
│       └── Auto-repair: mutate admin.health {mode: "repair"}  [tier 1]
│
├── What is the overall project state?
│   └── query admin.dash  [tier 0]
│
├── What operations are available at this tier?
│   └── query admin.help  [tier 0]  → tier 0 + tier 1 ops
│       └── query admin.help {tier:2}  → reveals tier-2 ops + escalation hints
│
└── Inspect configuration
    └── query admin.config.show  [tier 1]
        └── Update: mutate admin.config.set {key, value}  [tier 1]
```

---

## Anti-Pattern Reference

| Bad Pattern | Correct Pattern | Why |
|-------------|----------------|-----|
| `tasks.list` (no filter) | `tasks.find {query: "..."}` | list returns ALL tasks + notes; expensive |
| `tasks.list` for discovery | `tasks.find` | find is low-cost; list is for direct children only |
| `research.list` | `pipeline.manifest.list` | research domain is defunct |
| `research.find` | `pipeline.manifest.find` | research domain is defunct |
| `system.dash` | `admin.dash` | system domain is defunct |
| `tasks.reopen` | `tasks.restore {from: "done"}` | reopen is deprecated verb |
| `tasks.unarchive` | `tasks.restore {from: "archive"}` | unarchive is deprecated verb |
| `tasks.promote` | `tasks.reparent {newParentId: null}` | promote is deprecated verb |
| `tasks.exists` | `tasks.find {query, exact: true}` + check `results.length > 0` | exists removed |
| `memory.fetch` (without find first) | `memory.find` → filter → `memory.fetch` | fetch without filter returns everything |
| Reading `~/.cleo/projects-registry.json` directly | `nexus.status` then `nexus.list` | filesystem bypass breaks audit trail |
| Calling nexus deep ops without `admin.help {tier:2}` first | `admin.help {tier:2}` → then nexus op | escalation path is mandatory |
| Completing a task without manifest append | `pipeline.manifest.append` then `tasks.complete` | BASE protocol violation (exit 62) |
| Skipping `session.status` at start | Always check session.status first | Resuming without handoff.show loses context |
| Using `memory.brain.search` | `memory.find` | old operation name; cutover complete (T5241) |
| Using `memory.brain.observe` | `memory.observe` | old operation name; cutover complete (T5241) |
| Using `tasks.search` | `tasks.find` | `search` violates VERB-STANDARDS; use `find` |
| Using `nexus.query` | `nexus.resolve` | `query` violates VERB-STANDARDS; renamed in T5609 |
| `pipeline.release.prepare` / `.changelog` / `.commit` / etc. | `pipeline.release.ship {step: "..."}` | all sub-steps merged into ship (T5609) |

---

## Tier 0 — The 24 Cold-Start Operations

These 24 operations are available to every agent at session start without calling `admin.help`. Agents MUST know these without any discovery step.

### tasks (10 ops)

| Operation | Gateway | Purpose |
|-----------|---------|---------|
| `tasks.show` | query | Retrieve full details for a specific task by ID |
| `tasks.find` | query | Search tasks by keyword — always use before tasks.list |
| `tasks.next` | query | Auto-select the highest-priority next task to work on |
| `tasks.plan` | query | Composite planning view: upcoming tasks, blockers, dependencies |
| `tasks.current` | query | Show the currently active (started) task |
| `tasks.add` | mutate | Create a new task with anti-hallucination validation |
| `tasks.update` | mutate | Update fields on an existing task |
| `tasks.complete` | mutate | Mark a task as done (terminal lifecycle step) |
| `tasks.start` | mutate | Begin working on a task (activates focus tracking) |
| `tasks.stop` | mutate | Stop working on the current task |

### session (5 ops)

| Operation | Gateway | Purpose |
|-----------|---------|---------|
| `session.status` | query | Check whether a session is currently active — mandatory first call |
| `session.handoff.show` | query | Read prior session handoff for context resumption |
| `session.briefing.show` | query | Composite cold-start briefing (status + handoff combined) |
| `session.start` | mutate | Start a new session with a required scope |
| `session.end` | mutate | End current session, triggering debrief and handoff generation |

### memory (2 ops)

| Operation | Gateway | Purpose |
|-----------|---------|---------|
| `memory.find` | query | Search the brain for past observations, decisions, patterns, learnings |
| `memory.observe` | mutate | Save a new free-form observation to the brain |

### admin (4 ops)

| Operation | Gateway | Purpose |
|-----------|---------|---------|
| `admin.version` | query | CLEO version number |
| `admin.health` | query | Installation health check; use `{mode:"diagnose"}` for diagnostics |
| `admin.dash` | query | Project dashboard — mandatory efficiency sequence step 2 |
| `admin.help` | query | Discover available operations at the current tier; use `{tier:2}` to reveal advanced ops |

### tools (3 ops)

| Operation | Gateway | Purpose |
|-----------|---------|---------|
| `tools.skill.list` | query | List all installed agent skills |
| `tools.provider.list` | query | List all known LLM/agent providers |
| `tools.provider.detect` | query | Detect the currently active provider |

---

## Escalation Paths

The following table maps every tier-2 cluster to its explicit escalation path. Agents that need tier-2 ops MUST call the escalation entry point first.

| Tier-2 Cluster | Ops | Tier-0 Entry | Tier-1 Entry | How to Escalate |
|----------------|-----|-------------|-------------|-----------------|
| `pipeline.chain.*` | 8 ops | `admin.help` | — | `admin.help {tier:2}` → shows escalation hint |
| `check.chain.*` | 2 ops | `admin.help` | — | `admin.help {tier:2}` → shows escalation hint |
| `admin.token.*` | 2 ops | `admin.help` | — | `admin.help {tier:2}` → shows escalation hint |
| `admin.export` / `admin.import` | 2 ops | `admin.help` | — | `admin.help {tier:2}` → shows escalation hint |
| `admin.adr.show` | 1 op | `admin.help` | `admin.adr.find` | `admin.help {tier:2}` → shows escalation hint |
| `check.grade`, `check.grade.list` | 2 ops | `admin.help` | — | `admin.help {tier:2}` → shows escalation hint |
| `admin.install.global` | 1 op | `admin.help` | — | `admin.help {tier:2}` → shows escalation hint |
| `admin.adr.sync` | 1 op | `admin.help` | `admin.adr.find` | `admin.help {tier:2}` → shows escalation hint |
| `nexus.show`, `nexus.resolve`, `nexus.deps`, `nexus.graph`, `nexus.discover`, `nexus.search`, `nexus.blockers.show`, `nexus.path.show`, `nexus.orphans.list` | 9 ops | `admin.help` | `nexus.status`, `nexus.list` | `nexus.status` response includes escalation notice; confirm with `admin.help {tier:2}` |
| `nexus.init`, `nexus.register`, `nexus.unregister`, `nexus.sync`, `nexus.permission.set`, `nexus.reconcile`, `nexus.share.*` | 7 ops | `admin.help` | `nexus.status` (shows not initialized) | Human admin required for init/register; `admin.help {tier:2}` for others |
| `tools.skill.catalog` | 1 op | `tools.skill.list` | — | `admin.help {tier:2}` → shows escalation hint |

---

## Implementation Notes

### Registry Metadata Requirement

Each tier-2 registry entry MUST include an `escalationHint` field:

```json
{
  "operation": "pipeline.chain.show",
  "tier": 2,
  "escalationHint": "Discovered via admin.help {tier:2}. WarpChain feature — see admin.help response for usage."
}
```

The `admin.help` response at tier 0/1 MUST surface a summary of tier-2 domains and their escalation hints, even when those ops are not listed in detail.

### Mandatory Efficiency Sequence (unchanged from protocol)

Every agent session must run this sequence at startup, in order, before any task work:

1. `query session.status` (~200 tokens) — resume existing session?
2. `query admin.dash` (~500 tokens) — project overview
3. `query tasks.current` (~100 tokens) — active task?
4. `query tasks.next` (~300 tokens) — what to work on
5. `query tasks.show {taskId}` (~400 tokens) — full details for chosen task

### Subagent BASE Protocol Checklist

Before returning from any subagent spawn:

- [ ] `cleo focus set {taskId}` — set focus (marks task active)
- [ ] Do the work
- [ ] Write output file to `{{OUTPUT_DIR}}/`
- [ ] `pipeline.manifest.append {entry}` — append manifest entry (ONE line)
- [ ] `tasks.complete {taskId}` — mark task done
- [ ] Return ONLY the summary message, no content

---

## References

- `CLEO-OPERATIONS-CONSOLIDATION-DECISION.md` (T5609) — source decision matrix
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — canonical operation registry
- `docs/specs/VERB-STANDARDS.md` — canonical verb rules (add, show, find, etc.)
- `docs/specs/MCP-AGENT-INTERACTION-SPEC.md` — progressive disclosure patterns
- `.cleo/templates/CLEO-INJECTION.md` — base protocol injected into all agents
- T5517 — Operations Consolidation epic
- T5608 — Tier audit (source of tier demotion decisions)
- T5609 — Decision matrix (source of this tree)
