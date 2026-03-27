# CLEO Orchestration Plan

**Status**: DRAFT — Supersedes ORCH-PLAN.md Phase 7
**Author**: @cleo-rust-lead
**Date**: 2026-03-27
**Predecessors**: ORCH-PLAN.md (ClawMsgr-era), T202 (CANT DSL), T211 (Local SignalDock Stack)

---

## 1. The Problem (Why ORCH-PLAN.md Phase 7 Is Outdated)

The original ORCH-PLAN.md Phase 7 envisioned multi-project agent topology but was designed around:
- **ClawMsgr Python workers** (clawmsgr-worker.py) — now deprecated
- **JSON file configs** (clawmsgr-*.json) — moving to DB-backed credentials
- **Flat file state** (~/.local/share/clawmsgr/{agent-id}/) — moving to signaldock.db
- **Manual polling** with no guaranteed delivery — need SSE/local transport
- **No programmatic agent lifecycle** — agents go idle with no way to wake them

**What we have now that ORCH-PLAN.md didn't**:
- CANT DSL (shipped: 694 tests, full parser + validator + LSP + runtime)
- napi-rs 3.8+ bridge (Rust → Node native)
- signaldock.db (Rust-managed, 17 migrations)
- CLEO task system with full RCASD pipeline
- Agent credentials table with AES-256-GCM encryption
- Conduit protocol with Transport abstraction (HttpTransport working, Local/SSE/WS planned)
- @cleocode/runtime package with AgentPoller

---

## 2. Target Architecture: CLEO-Native Orchestration

### 2.1 The Five Roles

| Role | Abbreviation | Responsibility | Lifetime | Example |
|------|-------------|----------------|----------|---------|
| **Human-in-the-Loop** | HITL | Final authority, approvals, direction | Permanent | Owner |
| **Prime Orchestrator** | PRIME | Cross-project coordination, conflict resolution, agent lifecycle | Long-running | cleo-prime |
| **Project Lead** | LEAD | Project-level orchestration, task management, agent coordination | Per-project | cleo-rust-lead |
| **Team Lead** | TEAM | Team-level delegation, can spawn specialists | Per-team | cleo-db-lead |
| **Specialist/Ephemeral** | AGENT | Execute specific tasks, report to lead | Per-task or session | signaldock-backend |

### 2.2 The Core Loop

```
HITL gives direction to PRIME
  → PRIME breaks into project-level directives
    → LEAD assigns tasks via CLEO task system
      → TEAM delegates to specialists
        → AGENTS pick up tasks, execute, report
          → Results flow back up the chain
```

**The critical missing piece**: There is no programmatic way to:
1. **Start an agent** — agents are started manually by opening a terminal
2. **Wake an idle agent** — no push mechanism, only polling
3. **Know if an agent is alive** — no heartbeat enforcement
4. **Assign work an agent will see** — CLEO tasks exist but agents don't auto-poll them
5. **Stop an agent** — no graceful shutdown signal

### 2.3 Agent Lifecycle (Target State)

```
                    ┌─────────────┐
                    │   OFFLINE   │ Agent process not running
                    └──────┬──────┘
                           │ cleo agent start {name}
                           ▼
                    ┌─────────────┐
                    │  SIGNING IN │ Load .cant profile, get credentials,
                    │             │ connect transport, send heartbeat
                    └──────┬──────┘
                           │ Credentials loaded, transport connected
                           ▼
                    ┌─────────────┐
                    │   ONLINE    │ Polling/SSE active, heartbeat running
                    │             │ → Check CLEO tasks (cleo next)
                    │             │ → Process messages (peek/ack)
                    │             │ → Self-delegate from task queue
                    └──────┬──────┘
                           │ Assigned task or self-picked
                           ▼
                    ┌─────────────┐
                    │   WORKING   │ Executing task, reporting progress
                    │             │ → cleo start T{id}
                    │             │ → Do work
                    │             │ → cleo complete T{id}
                    └──────┬──────┘
                           │ Task complete or no more work
                           ▼
                    ┌─────────────┐
                    │  IDLE/WAIT  │ No assigned work, watching for:
                    │             │ → New task assignments
                    │             │ → @mention in messages
                    │             │ → PRIME directive
                    │             │ → Timeout → sign out
                    └──────┬──────┘
                           │ cleo agent stop or timeout
                           ▼
                    ┌─────────────┐
                    │ SIGNING OUT │ End session, handoff, go offline
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   OFFLINE   │
                    └─────────────┘
```

---

## 3. What Needs to Be Built

### 3.1 Agent Profile System (CANT-Defined Personas)

**Bridge between CANT DSL and runtime identity.**

Each agent has a `.cant` profile file that defines their persona:

```cant
---
kind: agent
version: 1
---

agent cleo-rust-lead:
  model: opus
  prompt: "You are the Rust lead for the CLEO ecosystem. You own cant-core, cant-napi, cant-lsp, cant-runtime. You coordinate with cleo-db-lead on schemas and signaldock-core-agent on Rust crate architecture."
  persist: project
  skills: ["ct-cleo", "ct-orchestrator", "ct-dev-workflow"]
  permissions:
    tasks: read, write
    session: read, write
    memory: read, write
    agent: read

  role: project-lead
  parent: cleo-prime
  projects: ["cleocode"]

on SessionStart:
  /checkin @all
  session "Review current sprint state"
    context: [active-tasks, recent-decisions]

on TaskComplete:
  if **the completed task unblocks other agents**:
    /action @all T{completed.id} #unblocked
```

**On `cleo agent start cleo-rust-lead`**:
1. Read `.cleo/agents/cleo-rust-lead.cant` (CANT profile)
2. Parse with `parse_document()` → extract AgentDef
3. Load/create credentials from `agent_credentials` table
4. Connect transport (Local > SSE > HTTP)
5. Send heartbeat → mark online
6. Start work loop: `cleo next` → pick task → execute → complete → repeat

### 3.2 Agent Profiles Table (NEW — tasks.db)

```sql
CREATE TABLE agent_profiles (
    agent_id TEXT PRIMARY KEY REFERENCES agent_credentials(agent_id),
    display_name TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'sonnet',
    system_prompt TEXT NOT NULL,
    persist_scope TEXT NOT NULL DEFAULT 'project',
    role TEXT NOT NULL DEFAULT 'specialist',  -- prime, project-lead, team-lead, specialist, ephemeral
    parent_agent TEXT,                         -- who manages this agent
    projects_json TEXT NOT NULL DEFAULT '[]',  -- projects this agent belongs to
    skills_json TEXT NOT NULL DEFAULT '[]',    -- CLEO skills (ct-cleo, etc.)
    tools_json TEXT NOT NULL DEFAULT '[]',     -- available tool definitions
    permissions_json TEXT NOT NULL DEFAULT '{}', -- domain: [access] map
    hooks_json TEXT NOT NULL DEFAULT '[]',     -- serialized hook definitions
    cant_file TEXT,                            -- path to source .cant file
    cant_hash TEXT,                            -- SHA-256 of .cant file (detect changes)
    status TEXT NOT NULL DEFAULT 'offline',    -- offline, online, working, idle
    current_task TEXT,                         -- task ID currently being worked on
    last_heartbeat TEXT,                       -- ISO8601
    last_session_id TEXT,                      -- link to sessions table
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_agent_profiles_status ON agent_profiles(status);
CREATE INDEX idx_agent_profiles_role ON agent_profiles(role);
CREATE INDEX idx_agent_profiles_parent ON agent_profiles(parent_agent);
```

### 3.3 Agent Lifecycle Commands

```bash
# Start an agent (loads .cant profile, connects, goes online)
cleo agent start {name}              # Start from .cant profile
cleo agent start {name} --worktree   # Start in isolated git worktree

# Agent work loop
cleo agent work {name}               # Full autonomous loop: start → pick task → execute → repeat

# Status
cleo agent status                    # Show all agents and their status
cleo agent status {name}             # Detailed status for one agent

# Communication
cleo agent send {name} "message"     # Send message to agent
cleo agent wake {name}               # Send wake signal (priority message)

# Stop
cleo agent stop {name}               # Graceful shutdown (handoff, sign out)
cleo agent stop --all                # Stop all agents

# Management (PRIME/LEAD only)
cleo agent assign {name} T{id}       # Assign task to agent
cleo agent reassign T{id} {name}     # Reassign task to different agent
cleo agent spawn {name} --role specialist --task T{id}  # Create ephemeral agent for a task
```

### 3.4 Self-Delegation / Task Pickup

Agents autonomously pick up work:

```
Agent Work Loop:
  1. cleo next → get next available task matching my skills/role
  2. cleo start T{id} → claim the task
  3. Execute the work
  4. cleo complete T{id} → mark done
  5. cleo next → repeat or idle

Task Matching:
  - Filter by agent's skills (from .cant profile)
  - Filter by agent's role (specialist only sees specialist-level tasks)
  - Filter by agent's project assignments
  - Priority ordering: P0 > assigned-to-me > unassigned > P1 > P2
```

### 3.5 Wake/Push Mechanism

**The key missing piece**: How to wake an idle agent.

**Option A: Local SignalDock push (preferred for local)**
- Agent subscribes to in-process pub/sub via LocalTransport
- PRIME/LEAD publishes wake signal
- Agent receives immediately (no polling delay)

**Option B: SSE push (for cloud)**
- Agent maintains SSE connection to SignalDock
- Server pushes wake event when task assigned or message received

**Option C: Filesystem signal (fallback)**
- Write signal file to `.cleo/signals/{agent-id}.wake`
- Agent watches directory with inotify/fswatch
- Works even without network

### 3.6 Heartbeat Enforcement

```
Agent sends heartbeat every 60s:
  POST /agents/{id}/heartbeat  (or local DB update)

PRIME monitors heartbeat:
  - If agent misses 3 heartbeats (3 minutes) → mark STALE
  - If agent misses 10 heartbeats (10 minutes) → mark OFFLINE
  - STALE agents get wake signal
  - OFFLINE agents' tasks get reassigned

Dashboard:
  cleo agent status
  ┌─────────────────────────────────────────────────────┐
  │ Agent                Role          Status    Task    │
  ├─────────────────────────────────────────────────────┤
  │ cleo-rust-lead       project-lead  ONLINE    T215   │
  │ cleo-db-lead         team-lead     STALE     T212   │
  │ signaldock-core-agent specialist   OFFLINE   —      │
  │ versionguard         specialist    ONLINE    —      │
  └─────────────────────────────────────────────────────┘
```

---

## 4. Multi-Project Topology (Evolved from ORCH-PLAN Phase 7)

### 4.1 What Carries Forward

From ORCH-PLAN.md Phase 7:
- Hierarchical orchestration tree (PRIME → LEAD → agents) — **YES, keep**
- Project-scoped conversations — **YES, but via CLEO task system, not just messaging**
- Agent membership matrix (shared vs dedicated) — **YES, defined in .cant profiles**
- Per-project agent state — **YES, via agent_profiles.projects_json + signaldock.db**
- Cross-project digest for PRIME — **YES, via cleo dash --all-projects**

### 4.2 What Changes

| ORCH-PLAN.md (old) | CLEO-ORCH-PLAN (new) |
|---------------------|----------------------|
| Python worker polling | @cleocode/runtime with LocalTransport/SSE |
| JSON file configs | agent_credentials + agent_profiles in tasks.db |
| Flat file state (~/.local/share/) | signaldock.db + sessions table |
| Manual agent coordination | CANT-defined profiles with auto-lifecycle |
| No programmatic start/stop | cleo agent start/stop/work commands |
| No task auto-pickup | Self-delegation from CLEO task queue |
| No heartbeat | Mandatory heartbeat with STALE/OFFLINE detection |
| ClawMsgr skill for messaging | Native CLEO conduit integration |

### 4.3 Project Scoping

Each agent's `.cant` profile lists their projects:
```cant
agent forge-ts-opus:
  role: specialist
  projects: ["cleocode", "llmtxt", "versionguard", "forge-ts"]
```

When polling for tasks:
```bash
cleo next --project cleocode  # Only tasks from this project
cleo next                     # Tasks from any assigned project, priority-ordered
```

When polling for messages:
```bash
# Transport auto-filters by project-scoped conversations
# Agent only sees messages in conversations for their assigned projects
```

### 4.4 PRIME Orchestrator Capabilities

The PRIME orchestrator (human-controlled or autonomous) can:

```bash
# Cross-project visibility
cleo dash --all-projects              # Aggregated status across all projects
cleo agent status --all               # All agents across all projects

# Resource allocation
cleo agent assign forge-ts-opus T215  # Assign shared agent to specific task
cleo agent reassign T212 cleo-rust-lead  # Move task between agents
cleo agent spawn temp-reviewer --role ephemeral --task T215  # Spin up ephemeral

# Priority resolution
cleo agent priority forge-ts-opus cleocode  # Set project priority for shared agent

# Wake/stop
cleo agent wake cleo-db-lead          # Wake idle agent
cleo agent stop signaldock-backend    # Stop agent gracefully
```

---

## 5. Implementation Phases

### Phase A: Agent Profiles + Sign-In (T215 + T214)

**Scope**: CANT profile loading, agent_profiles table, `cleo agent start/stop`

1. Create `agent_profiles` Drizzle schema in tasks.db
2. Implement CANT profile parser → agent_profiles DB mapping
3. `cleo agent start {name}` — load .cant, create/update profile, connect transport, heartbeat
4. `cleo agent stop {name}` — end session, handoff, mark offline
5. `cleo agent status` — show all agents with status

**Depends on**: T202 (CANT DSL, done), agent_credentials (done)
**Blocked by**: Nothing (can start now)

### Phase B: Self-Delegation + Work Loop (NEW)

**Scope**: Agent auto-picks tasks, executes, reports

1. `cleo agent work {name}` — autonomous work loop
2. Task matching: filter by skills, role, project
3. Integration with `cleo next` for task discovery
4. Progress reporting via session notes
5. Idle detection + timeout

**Depends on**: Phase A

### Phase C: Wake/Push + Heartbeat (T218 partial)

**Scope**: Push delivery, heartbeat enforcement, stale detection

1. Heartbeat service in @cleocode/runtime
2. STALE/OFFLINE detection with configurable thresholds
3. Wake signal delivery (local pub/sub, SSE, or filesystem)
4. `cleo agent wake {name}` command
5. Auto-reassign tasks from OFFLINE agents

**Depends on**: Phase A, T213 (LocalTransport) or T216 (SseTransport)

### Phase D: Multi-Project Topology (from ORCH-PLAN Phase 7)

**Scope**: Project scoping, PRIME capabilities, shared agent coordination

1. Project-scoped task filtering
2. Project-scoped message filtering
3. PRIME dashboard (`cleo dash --all-projects`)
4. Agent priority per project
5. Shared agent conflict resolution

**Depends on**: Phases A-C

---

## 6. What This Replaces

| Old System | New System |
|------------|------------|
| clawmsgr-worker.py | @cleocode/runtime AgentPoller + heartbeat |
| clawmsgr-*.json | agent_credentials table (AES-256-GCM) |
| ClawMsgr SKILL.md | CANT DSL agent profiles (.cant files) |
| Manual terminal sessions | cleo agent start/stop/work |
| /clawmsgr-check cron | Native transport subscription (Local/SSE) |
| Group conversation polling | CLEO task system + conduit |
| ORCH-PLAN.md Phase 7 | This document (CLEO-ORCH-PLAN.md) |

---

## 7. Open Questions

1. **Should PRIME be a long-running daemon or CLI-invoked?** If daemon, it monitors all agents and acts autonomously. If CLI, it's invoked by the human.

2. **Ephemeral agents**: How do they get .cant profiles? Auto-generated from a template? Or the spawning agent creates one dynamically?

3. **Git worktree isolation**: When an agent starts in a worktree, how does it share signaldock.db and agent_credentials from the main worktree?

4. **Rate limiting**: How many agents can be ONLINE simultaneously? What are the resource constraints?

5. **Audit trail**: Should all agent lifecycle events (start, stop, wake, assign, reassign) be logged to the audit_log table?

---

*This document supersedes ORCH-PLAN.md Phase 7. The decisions from Phases 1-6 of ORCH-PLAN.md remain valid — they cover SignalDock backend features that are already shipped.*
