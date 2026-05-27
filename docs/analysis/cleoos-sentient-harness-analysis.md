# CLEOOS SENTIENT HARNESS — UNIFIED ARCHITECTURE ANALYSIS
## Hermes Agent + Cleo CORE SDK Integration Roadmap

**Date:** 2026-05-04
**Analyst:** Agent Swarm (Cleo Diagnosis + Hermes Analysis + Sandbox Audit)
**Scope:** Full architectural merger of Hermes Agent capabilities into CleoOS harness

---

## EXECUTIVE SUMMARY

The Cleo ecosystem has a **massive opportunity** to become the most powerful
open-source Sentient AGI harness by merging:

1. **Cleo CORE SDK** (~628K LOC TypeScript) — battle-tested task management,
   verification gates, sentient daemon, brain graph, nexus registry
2. **Hermes Agent** (~292K LOC Python) — 60+ tools, multi-platform gateway,
   subagent delegation, MCP client, cron scheduler, skills system
3. **Cleo Sandbox** — Docker-based testing infrastructure with 7 passing scenarios

**Current State:** These are THREE SEPARATE CODEBASES with significant duplication
and zero integration. CleoOS (packages/cleo-os/) is only 18K LOC — mostly a Pi
adapter stub. The real power is locked in packages/core/ and packages/adapters/.

**The Vision:** A unified `cleo agent` command that spawns a Hermes-powered
AI agent with full Cleo task integration — the agent can create tasks, verify
them, run the daemon, and self-improve using the sandbox.

---

## PART 1: CLEO ECOSYSTEM REALITY ASSESSMENT

### 1.1 Sandbox Test Results (Baseline)

| Scenario | Result | Duration | Notes |
|----------|--------|----------|-------|
| fresh-install-linux | PASS | 22s | Clean install, XDG dirs, init/add/dash |
| upgrade-from-legacy-dotcleo | PASS | 57s | Legacy migration without data loss |
| multi-project-registry | PASS | 57s | 5 projects, nexus.db registry |
| corrupted-db-recovery | PASS | 14s | Graceful degradation on corrupt DB |
| harness-e2e | PASS | 43s | Full lifecycle: init→add→verify→complete |
| living-brain-e2e | PASS | 103s | 5-substrate proof (NEXUS, TASKS, BRAIN, CONDUIT) |
| sentient-anomaly-proof | PASS | 111s | Tier-2 nexus ingester with 3 documented bugs |

**All 7 scenarios PASS on Ubuntu.** This is a solid foundation.

### 1.2 Cleo Monorepo — What's Real vs Theatre

| Package | LOC | Status | Reality |
|---------|-----|--------|---------|
| packages/core/ | ~628K | SUBSTANTIAL | Tasks, sentient daemon, verification, memory, store, GC — ALL REAL |
| packages/cleo/ | ~219K | REAL BUT THIN | CLI wrapper — dispatches to core |
| packages/cleo-os/ | ~18K | MOSTLY THEATRE | Only Pi adapter is real; 8 of 9 providers are stubs |
| packages/contracts/ | ~53K | REAL | Shared types, envelopes |
| packages/brain/ | ~3.3K | REAL BUT NEW | Graph substrate, recently promoted |
| packages/adapters/ | ~60K | REAL | CAAMP provider adapters (Claude-Code, Codex, Cursor, etc.) |
| packages/skills/ | ~1.6K | REAL | Markdown skill definitions (orchestrator, council, validator) |
| packages/nexus/ | ~39K | REAL | Code symbol registry |
| packages/studio/ | ~1.3M | REAL | SvelteKit frontend (separate concern) |

### 1.3 Key Theatre Items (Must Fix)

1. **Tier-3 auto-merge**: Referenced everywhere, NOT IMPLEMENTED (blocked on T992+T993+T995)
2. **CleoOS harness**: Only Pi has real adapter; Claude-Code, Codex, Cursor, etc. are just provider IDs
3. **8 of 9 provider adapters in cleo-os**: Listed in matrix but no lifecycle management
4. **Autonomous loop**: Documented as pseudocode in AGENTS.md, NOT a running service
5. **MCP adapter**: Only 379 LOC — extremely minimal compared to Hermes' 1050-line MCP client

### 1.4 Sentient Subsystem Architecture (Real)

```
Tier-1 (Daemon) — REAL, running
  ├── daemon.ts (962 LOC) — detached Node.js process, cron every 5 min
  ├── tick.ts (1,454 LOC) — pick task, spawn worker, retry/backoff
  └── Kill-switch with fs.watch propagation

Tier-2 (Propose) — REAL, disabled by default
  ├── propose-tick.ts (506 LOC) — runs every 2 hours
  ├── 3 ingesters: brain, nexus, test
  └── NO LLM calls — structured template titles only

Tier-3 (Auto-merge) — THEATRE / STUB
  ├── Referenced in docs but NOT IMPLEMENTED
  └── Blocked on T992+T993+T995
```

---

## PART 2: HERMES AGENT DEEP ANALYSIS

### 2.1 Hermes Architecture Overview

**Language:** Python (292K LOC code, 64K comments, 989 .py files)
**Core Pattern:** Synchronous agent loop with async tool bridging
**Key Innovation:** Self-registering tool registry + subagent delegation

```
hermes-agent/
├── run_agent.py (11,952 LOC) — AIAgent class, conversation loop
├── model_tools.py (611 LOC) — Tool orchestration, discovery, dispatch
├── toolsets.py (720 LOC) — Toolset definitions and validation
├── cli.py (10,805 LOC) — HermesCLI interactive CLI
├── hermes_state.py (1,443 LOC) — SessionDB (SQLite + FTS5)
├── tools/ (60+ tool implementations)
│   ├── registry.py (482 LOC) — Central registry with AST discovery
│   ├── delegate_tool.py (1,200 LOC) — Subagent architecture
│   ├── terminal_tool.py — Terminal orchestration
│   ├── file_tools.py — File read/write/search/patch
│   ├── web_tools.py — Web search/extract
│   ├── browser_tool.py — Browser automation
│   ├── code_execution_tool.py — Python sandbox
│   ├── mcp_tool.py (~1050 LOC) — MCP client
│   ├── cronjob_tools.py — Cron scheduler integration
│   ├── memory_tool.py — Persistent memory
│   └── environments/ — Terminal backends (local, docker, ssh, modal, daytona)
├── gateway/ (11,005 LOC) — Messaging platform gateway
│   ├── run.py — Main loop, slash commands
│   └── platforms/ — Telegram, Discord, Slack, WhatsApp, etc.
├── agent/ — Agent internals
│   ├── prompt_builder.py — System prompt assembly
│   ├── context_compressor.py — Auto context compression
│   ├── prompt_caching.py — Anthropic prompt caching
│   └── auxiliary_client.py — Vision, summarization
├── cron/ — Scheduler (jobs.py, scheduler.py)
├── ui-tui/ — Ink (React) terminal UI
└── tests/ — ~3000 pytest tests
```

### 2.2 Hermes Tool Registry (The Crown Jewel)

**Self-Registering Pattern:**
```python
# Each tool file calls registry.register() at module level
registry.register(
    name="web_search",
    toolset="web",
    schema={...},
    handler=handle_web_search,
    check_fn=lambda: True,
    requires_env=["OPENROUTER_API_KEY"],
    is_async=False,
    description="Search the web",
    emoji="🔍",
)
```

**Discovery:** AST parsing finds `registry.register()` calls, then imports modules.
**MCP Integration:** Dynamic tool discovery from external MCP servers.
**Plugin System:** User/project/pip plugins can register additional tools.

### 2.3 Hermes Subagent Delegation

**Architecture:**
- Parent spawns child AIAgent instances with isolated context
- Children get restricted toolsets (no recursive delegation, no clarify, no memory writes)
- ThreadPoolExecutor for parallel batch execution (max 3 concurrent)
- Max depth: 2 (parent → child → grandchild rejected)
- Parent blocks until all children complete

**Key Feature:** Children cannot see parent history — only the delegation call
and summary result are visible. This prevents context pollution.

### 2.4 Hermes Gateway (Multi-Platform)

**Platforms Supported:**
- Telegram (full bot with commands)
- Discord (slash commands, DMs)
- Slack (slash commands, threads)
- WhatsApp
- Home Assistant
- Signal
- QQ Bot

**Pattern:** Single gateway core with platform adapters. All slash commands
derive from central `COMMAND_REGISTRY`.

### 2.5 Hermes Session/Memory System

- **SessionDB:** SQLite with FTS5 for conversation search
- **Persistent Memory:** `~/.hermes/memory.md` — durable facts across sessions
- **Session Search:** Full-text search across all past conversations
- **Skills:** Markdown files with YAML frontmatter in `~/.hermes/skills/`

### 2.6 Hermes Unique Capabilities (Cleo Lacks)

| Capability | Hermes | Cleo |
|------------|--------|------|
| 60+ built-in tools | ✅ | ❌ (CLI only) |
| Browser automation | ✅ (CamoFox, CDP, Browserbase) | ❌ |
| Code execution sandbox | ✅ (Python with hermes_tools import) | ❌ |
| Subagent delegation | ✅ (parallel, isolated, depth-limited) | ❌ (CANT templates only) |
| MCP client | ✅ (~1050 LOC, OAuth, reconnect) | ❌ (379 LOC stub) |
| Multi-platform gateway | ✅ (7 platforms) | ❌ (Studio only) |
| Cron scheduler | ✅ (jobs + scheduler) | ❌ (system cron only) |
| Context compression | ✅ (auto-compression with auxiliary LLM) | ❌ |
| Prompt caching | ✅ (Anthropic cache control) | ❌ |
| Voice/TTS | ✅ (Edge, OpenAI, ElevenLabs, xAI) | ❌ |
| Vision analysis | ✅ | ❌ |
| Image generation | ✅ | ❌ |
| RL training environments | ✅ (Atropos) | ❌ |
| Terminal backends | ✅ (local, docker, ssh, modal, daytona, singularity) | ❌ (local only) |
| TUI (Ink/React) | ✅ | ❌ |
| 3000+ tests | ✅ | ❌ (sandbox scenarios only) |

---

## PART 3: THE GRAND INTEGRATION — CLEOOS SENTIENT HARNESS

### 3.1 The Core Insight

**Cleo has the brain. Hermes has the body. They need to become one organism.**

Cleo's strengths:
- Task/verification system with strict gates
- Sentient daemon with tiered autonomy
- Brain graph for cross-session learning
- Nexus registry for cross-project code awareness
- LAFS envelope protocol for structured communication

Hermes' strengths:
- Massive tool ecosystem (60+ tools)
- Multi-platform gateway
- Subagent delegation for parallel work
- Advanced context management
- Production-hardened with 3000+ tests

### 3.2 Proposed Architecture: CleoOS v2

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLEOOS SENTIENT HARNESS v2                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │   Telegram   │  │   Discord    │  │    Slack     │  │    CLI/TUI   │   │
│  │   Adapter    │  │   Adapter    │  │   Adapter    │  │   (Ink/React)│   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                 │                 │                 │           │
│         └─────────────────┴─────────────────┴─────────────────┘           │
│                              │                                            │
│                    ┌─────────┴─────────┐                                   │
│                    │  CLEOOS GATEWAY   │  ← Hermes gateway pattern        │
│                    │  (TypeScript)     │     adapted to LAFS envelopes    │
│                    └─────────┬─────────┘                                   │
│                              │                                            │
│         ┌────────────────────┼────────────────────┐                        │
│         │                    │                    │                        │
│  ┌──────┴──────┐   ┌────────┴────────┐   ┌──────┴──────┐               │
│  │  CLEO CORE   │   │  HERMES BRIDGE   │   │  CLEO STUDIO │               │
│  │   SDK (TS)   │   │   (Python IPC)   │   │  (SvelteKit) │               │
│  │              │   │                  │   │              │               │
│  │ • Tasks      │   │ • Tool dispatch │   │ • Dashboard  │               │
│  │ • Brain      │   │ • LLM calls     │   │ • Task board   │               │
│  │ • Nexus      │   │ • Subagents     │   │ • Analytics  │               │
│  │ • Sentient   │   │ • 60+ tools     │   │ • Settings   │               │
│  │ • Verification│   │ • Environments  │   │              │               │
│  └──────┬───────┘   └────────┬────────┘   └──────────────┘               │
│         │                      │                                          │
│         └──────────────────────┘                                          │
│                    │                                                      │
│         ┌─────────┴──────────┐                                           │
│         │   UNIFIED STORE    │                                           │
│         │  (SQLite + IPC)    │                                           │
│         │                    │                                           │
│         │ • tasks.db         │                                           │
│         │ • brain.db         │                                           │
│         │ • nexus.db         │                                           │
│         │ • sessions.db      │  ← Hermes session store merged            │
│         └────────────────────┘                                           │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     CLEO SANDBOX (Docker)                            │   │
│  │  • Test scenarios (7 passing)                                      │   │
│  │  • Agent harnesses (Claude-Code, Codex, Cursor, etc.)              │   │
│  │  • Autonomous improvement loop (to be implemented)                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Integration Strategy: The Hermes Bridge

**Approach:** Don't rewrite Hermes in TypeScript. Create a **bridge layer** that
allows Cleo CORE SDK to spawn and communicate with Hermes Agent processes.

**The Bridge Pattern:**
```
Cleo CORE SDK (TypeScript)
    ↓ LAFS envelope (IPC / HTTP / WebSocket)
Hermes Bridge (Python wrapper around hermes-agent)
    ↓ Python imports
Hermes Agent internals (run_agent.py, tools/, etc.)
```

**Why this works:**
1. Hermes is already designed for subprocess usage (TUI gateway uses JSON-RPC)
2. Cleo's LAFS envelope protocol is language-agnostic
3. Both use SQLite for persistence — can share databases via WAL mode
4. Hermes' `delegate_task` already spawns isolated subagents — perfect for Cleo's worker model

### 3.4 Duplication Elimination Map

| Duplicated Concern | Cleo Implementation | Hermes Implementation | Resolution |
|-------------------|---------------------|----------------------|------------|
| Task management | Cleo tasks.db + verification | Hermes todo tool | **Keep Cleo** — much more sophisticated |
| Session persistence | Cleo sessions | Hermes SessionDB | **Merge** — use Cleo's SQLite with Hermes' FTS5 |
| Skills system | packages/skills/ (markdown) | ~/.hermes/skills/ (markdown) | **Unify** — single skill directory format |
| Memory | brain.db + memory-bridge.md | ~/.hermes/memory.md | **Merge** — Cleo's graph + Hermes' search |
| Subagent delegation | CANT templates (declarative) | delegate_tool.py (runtime) | **Use Hermes** — real runtime delegation |
| MCP client | packages/mcp-adapter/ (379 LOC) | tools/mcp_tool.py (~1050 LOC) | **Use Hermes** — much more complete |
| Cron/scheduler | System cron only | cron/jobs.py + scheduler.py | **Use Hermes** — built-in scheduler |
| Terminal environments | Local only | local, docker, ssh, modal, daytona | **Use Hermes** — multi-backend |
| Web search | None | web_tools.py | **Use Hermes** — Firecrawl, Tavily, etc. |
| Browser automation | None | browser_tool.py | **Use Hermes** — CamoFox, CDP, Browserbase |
| Code execution | None | code_execution_tool.py | **Use Hermes** — Python sandbox |
| Gateway/platforms | Studio only (SvelteKit) | 7 platform adapters | **Merge** — add Cleo gateway to Hermes pattern |

---

## PART 4: IMPLEMENTATION ROADMAP

### Phase 1: Foundation (Weeks 1-2)
**Goal:** Establish the Hermes Bridge and prove communication

**Tasks:**
1. **T2001** — Create `packages/cleo-os/src/hermes-bridge/` directory
   - Bridge process launcher (spawns hermes-agent as child)
   - JSON-RPC over stdio (same pattern as TUI gateway)
   - LAFS envelope ↔ Hermes message format adapter

2. **T2002** — Implement `cleo agent start` command
   - Spawns Hermes Bridge process
   - Connects to tasks.db for context injection
   - Injects Cleo project context (AGENTS.md, CAAMP manifest)

3. **T2003** — Create unified skill directory format
   - Merge Cleo's `packages/skills/` structure with Hermes' `~/.hermes/skills/`
   - Single YAML frontmatter schema
   - CANT validator + Hermes skill loader both read same files

### Phase 2: Tool Integration (Weeks 3-4)
**Goal:** Expose Hermes tools through Cleo CLI

**Tasks:**
1. **T2004** — Map Hermes tools to Cleo LAFS operations
   - Each Hermes tool becomes a LAFS operation type
   - Tool results wrapped in LAFS envelopes
   - Cleo CLI can invoke any Hermes tool via `cleo tool <name>`

2. **T2005** — Integrate Hermes subagent delegation with Cleo spawn system
   - Cleo's `spawn.ts` can spawn Hermes subagents instead of Pi binary
   - Hermes children get Cleo task context injected
   - Results flow back through verification gates

3. **T2006** — Port Hermes MCP client to Cleo
   - Either bridge to Hermes' mcp_tool.py OR port to TypeScript
   - Recommendation: Bridge first (faster), port later (cleaner)

### Phase 3: Sentient Integration (Weeks 5-6)
**Goal:** Make the sentient daemon actually use LLM capabilities

**Tasks:**
1. **T2007** — Replace Tier-2 template proposals with LLM-generated proposals
   - Current: `[T2-BRAIN] Fix memory issue in brain.ts` (structured template)
   - Target: LLM analyzes brain.db, nexus.db, test results → generates real proposals
   - Use Hermes' `mixture_of_agents` for proposal quality

2. **T2008** — Implement Tier-3 auto-merge (finally)
   - Hermes subagent runs the full test suite in sandbox
   - Analyzes results, generates patch
   - Submits PR with verification evidence
   - Blocked on: sandbox autonomous loop + Hermes delegation

3. **T2009** — Dream cycle LLM integration
   - Current: Fire-and-forget with basic synthesis
   - Target: Full Hermes agent analyzes 24h observations
   - Generates decisions, patterns, learnings with proper context

### Phase 4: Gateway Unification (Weeks 7-8)
**Goal:** Single gateway for all platforms

**Tasks:**
1. **T2010** — Create CleoGateway class (TypeScript, Hermes pattern)
   - Platform adapters: Telegram, Discord, Slack, WhatsApp
   - Slash command registry (same pattern as Hermes)
   - Message dispatch to Hermes Bridge for LLM processing

2. **T2011** — Port Hermes platform adapters to TypeScript
   - Or: Run Hermes gateway as a service, Cleo gateway proxies to it
   - Recommendation: Proxy pattern — faster, less rewrite

3. **T2012** — Unified session store
   - Merge Hermes SessionDB schema into Cleo's SQLite ecosystem
   - Single `sessions.db` with FTS5
   - Cross-session search via `cleo memory search`

### Phase 5: Sandbox Autonomy (Weeks 9-10)
**Goal:** Implement the autonomous improvement loop

**Tasks:**
1. **T2013** — Implement autonomous loop as a service
   - Daemon process (not pseudocode)
   - `while true: test-all → diagnose → patch → re-test`
   - Uses Hermes delegation for parallel scenario fixing

2. **T2014** — Create `cleo sentient sandbox` command
   - Spawns autonomous loop in Docker container
   - Resource limits, seccomp, network isolation
   - Kill-switch with fs.watch

3. **T2015** — Self-improvement metrics dashboard
   - Track pass rate over time
   - Identify flaky scenarios
   - Measure time-to-fix

### Phase 6: Production Hardening (Weeks 11-12)
**Goal:** Production-ready Sentient Harness

**Tasks:**
1. **T2016** — Full test coverage for bridge layer
   - Unit tests for envelope translation
   - Integration tests for tool dispatch
   - End-to-end tests for agent lifecycle

2. **T2017** — Documentation and examples
   - `cleo agent --help` with full tool listing
   - Example: `cleo agent "fix the failing tests"`
   - Example: `cleo agent "review PR #123"`

3. **T2018** — Performance optimization
   - Lazy tool loading (don't import all 60+ tools until needed)
   - Connection pooling for LLM APIs
   - Context caching for repeated operations

---

## PART 5: TECHNICAL SPECIFICATIONS

### 5.1 Hermes Bridge Protocol

```typescript
// packages/cleo-os/src/hermes-bridge/types.ts
interface HermesBridgeEnvelope {
  id: string;
  type: 'invoke' | 'delegate' | 'query' | 'event';
  operation: string;  // Hermes tool name or LAFS operation
  payload: unknown;
  context: {
    taskId?: string;
    projectPath?: string;
    sessionId?: string;
    enabledToolsets?: string[];
  };
}

interface HermesBridgeResponse {
  id: string;
  status: 'success' | 'error' | 'partial';
  result: unknown;
  metadata: {
    toolCalls: number;
    tokensUsed: number;
    durationMs: number;
  };
}
```

### 5.2 Cleo Agent Command Interface

```bash
# Start an interactive agent session
cleo agent start --model anthropic/claude-opus-4 --toolsets "terminal,file,web"

# Run a one-shot task
cleo agent "Find all TODO comments in the codebase and create tasks for each"

# Run with specific context
cleo agent "Review the authentication code" --file src/auth.ts --toolsets "file,web"

# Delegate to subagents
cleo agent "Implement the full feature" --delegate --workers 3

# Use the sentient daemon
cleo sentient start  # Starts Tier-1 daemon
cleo sentient propose enable  # Enable Tier-2 LLM proposals
cleo sentient sandbox start  # Start autonomous improvement loop
```

### 5.3 Database Schema Merge

```sql
-- Unified sessions table (merges Hermes SessionDB + Cleo sessions)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,  -- 'cli', 'telegram', 'discord', etc.
  user_id TEXT,
  started_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  messages_json TEXT NOT NULL,  -- OpenAI format messages
  metadata_json TEXT,
  -- FTS5 virtual table for full-text search
  content TEXT  -- concatenated message content for search
);

-- Bridge operations audit log
CREATE TABLE bridge_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  tool_name TEXT NOT NULL,
  toolset TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  status TEXT,
  error TEXT
);
```

---

## PART 6: RISK ANALYSIS

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Python/TypeScript interop complexity | High | High | Start with JSON-RPC bridge, proven pattern |
| Hermes API changes breaking bridge | Medium | High | Pin Hermes version, automated compatibility tests |
| Performance overhead of bridge | Medium | Medium | Benchmark early, optimize hot paths |
| Cleo task system incompatible with Hermes todo | Low | Medium | Cleo tasks are superset — map at bridge layer |
| Security: Hermes tools in sandbox | Medium | High | Use existing seccomp + Cleo's kill-switch |
| Scope creep (12 weeks → 6 months) | High | High | Strict phase gates, MVP first |

---

## PART 7: IMMEDIATE NEXT STEPS

1. **Create Epic E200** in Cleo task system for "CleoOS Sentient Harness v2"
2. **Create child tasks** T2001-T2018 under E200
3. **Start T2001** (Hermes Bridge foundation) immediately
4. **Run Hermes tests** to establish baseline compatibility
5. **Create proof-of-concept** bridge that can spawn Hermes and run a single tool

---

## APPENDIX A: File Inventory

### Key Files Referenced
- `/mnt/projects/cleocode/packages/core/src/sentient/daemon.ts` — Tier-1 daemon
- `/mnt/projects/cleocode/packages/core/src/sentient/tick.ts` — Task spawning
- `/mnt/projects/cleocode/packages/core/src/sentient/propose-tick.ts` — Tier-2 proposals
- `/mnt/projects/cleocode/packages/cleo-os/src/pi/spawn.ts` — Only real harness adapter
- `/mnt/projects/hermes-agent/run_agent.py` — AIAgent class (11,952 LOC)
- `/mnt/projects/hermes-agent/tools/registry.py` — Tool registry (482 LOC)
- `/mnt/projects/hermes-agent/tools/delegate_tool.py` — Subagent delegation (1,200 LOC)
- `/mnt/projects/hermes-agent/gateway/run.py` — Gateway core (11,005 LOC)
- `/mnt/projects/hermes-agent/tools/mcp_tool.py` — MCP client (~1050 LOC)
- `/mnt/projects/cleo-sandbox/AGENTS.md` — Sandbox agent reference
- `/mnt/projects/cleo-sandbox/bin/sandbox` — Test dispatcher

### Analysis Reports Generated
- Cleo Monorepo Analysis: 8,837 files, ~2.4M LOC total
- Hermes Agent Analysis: 989 Python files, 292K LOC code
- Sandbox Test Results: 7/7 scenarios PASS on Ubuntu

---

*End of Analysis*
