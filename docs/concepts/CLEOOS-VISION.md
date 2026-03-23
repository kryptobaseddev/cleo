# CleoOS: The Agentic Development Environment

**Version**: 2026.3.65
**Status**: VISION
**Date**: 2026-03-22

---

## 1. What CleoOS Is

CleoOS is the full Agentic Development Environment built on top of `@cleocode/core`.

Where `@cleocode/core` is the kernel -- tasks, sessions, memory, orchestration, lifecycle -- CleoOS is the complete operating system: the runtime, the coordination layer, the deployment surface, and the intelligence fabric that turns a solo developer and their AI agents into a governed, continuous software development operation.

CleoOS is not a new product replacing CLEO. It is the name for what CLEO becomes when its four canonical systems (BRAIN, LOOM, NEXUS, LAFS) are fully realized with autonomous execution, multi-agent coordination, and project lifecycle management from inception to maintenance.

> One developer. Many agents. One operating system for the work.

---

## 2. The Kernel Relationship

CleoOS consumes `@cleocode/core` as its kernel. Every capability in CleoOS is built on top of the core business logic, never beside it.

```
CleoOS (Agentic Development Environment)
  |
  +-- Autonomous Runtime (Watchers, Impulse, Patrol)
  +-- Conduit Protocol (agent-to-agent relay)
  +-- The Hearth (operator surface)
  +-- Provider Ecosystem (adapters for every AI coding tool)
  +-- Project Lifecycle Manager (inception to maintenance)
  +-- Brain Intelligence (observation to knowledge graph)
  +-- Nexus Network (cross-project coordination)
  |
  +-- @cleocode/core (kernel)
        |-- tasks, sessions, memory, orchestration
        |-- lifecycle, release, admin, validation
        |-- sticky, nexus, adapters, skills
        |
        +-- @cleocode/contracts (types)
        +-- @cleocode/adapters (provider bridge)
```

The kernel provides the primitives: create a task, start a session, observe a fact, check a gate, query the brain. CleoOS provides the higher-order behaviors: decide what to work on next, coordinate three agents across a refactor, patrol for stale gates, surface the right memory at the right time, and manage the full arc of a project from first commit to long-term maintenance.

This boundary is not decorative. It is the same separation that exists between a kernel and an operating system in any serious system design. The kernel is stable, tested, and independently consumable. The OS is opinionated, adaptive, and built for a specific workflow: solo developer + AI agents + real software projects.

---

## 3. Why CleoOS

The problem is no longer "can AI write code." The problem is "can AI sustain a software project."

Writing code is a burst operation. Sustaining a project is a campaign: weeks of context, evolving requirements, accumulated decisions, shifting priorities, multiple agents that must coordinate without drift, and a developer who needs to trust the system to remember what happened yesterday and act on it tomorrow.

Current tools solve pieces of this:

- Code generation tools write functions
- Task managers track tickets
- Memory systems store observations
- Orchestration frameworks spawn agents

None of them solve the whole problem. None of them provide an integrated environment where tasks, memory, lifecycle, orchestration, and multi-agent coordination operate as a single coherent system with provenance, validation, and continuity.

CleoOS solves the whole problem by assembling the four canonical systems into a unified development environment:

| System | Kernel Role | CleoOS Extension |
|--------|------------|------------------|
| **BRAIN** | Store observations, patterns, learnings, decisions | Active memory circulation, contradiction detection, knowledge graph, temporal reasoning, semantic retrieval |
| **LOOM** | Lifecycle gates, stage transitions, pipeline stages | Autonomous progression through RCASD-IVTR+C, Tessera-driven decomposition, Warp-bound execution |
| **NEXUS** | Cross-project registry, federated queries | Organization-scale coordination, global pattern libraries, shared intelligence |
| **LAFS** | Structured envelopes, exit codes, progressive disclosure | Provider-neutral runtime contract for all agent communication |

---

## 4. Key Components

### 4.1 Autonomous Runtime

The autonomous runtime is the execution layer that makes CLEO self-propelling.

Specified in `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md`, it introduces three foundational services built on top of the existing hook substrate and 10 canonical domains:

- **Agent-Runtime Core** -- Source of truth for worker lifecycle, leases, identity, and event emission
- **The Impulse Engine** -- Self-propelling work pickup: when ready work exists, the system advances it through governed execution without waiting for explicit human or agent instruction
- **Watchers Engine** -- Scheduled patrols for health monitoring, retry pressure, continuity checks, and gate state verification

Higher-order runtime forms include:

| Form | Purpose |
|------|---------|
| **The Hearth** | Terminal-facing operator surface for observing and interacting with live runtime state |
| **The Sweep** | Quality patrol loop: review, repair, re-check, escalation |
| **Refinery** | Convergence gate for integration, validation, and merge readiness |
| **Looming Engine** | Tessera-driven decomposition from intent into executable work structure |
| **Living BRAIN** | Memory in active circulation with reinforcement, contradiction detection, and retrieval loops |
| **The Proving** | End-to-end validation of the runtime under load and failure conditions |

The autonomous runtime does not create new domains. It layers execution behavior on top of the existing `orchestrate`, `pipeline`, `check`, `admin`, `memory`, and `session` domains through the internal hook substrate (`onWorkAvailable`, `onAgentSpawn`, `onAgentComplete`, `onCascadeStart`, `onPatrol`).

### 4.2 Conduit Protocol

Conduit is the live agent-to-agent relay path within CleoOS.

Specified in `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md`, it provides structured message delivery between workers, sessions, and runtime surfaces:

- **LAFS envelope discipline** -- all messages are LAFS-shaped, ensuring provider neutrality
- **Structured addressing** -- workers, aspects, sessions, threads, and runtime services are addressable by kind and ID
- **Durable delivery** -- messages survive crashes via a persistent relay store with retry, lease, and dead-letter handling
- **Split architecture** -- TypeScript owns semantics (message shape, authorization, domain consequences); Rust owns delivery (broker, retries, leases, socket fanout)

Conduit is a runtime form, not a new domain. Its state surfaces through `orchestrate` (queue state, broker status), `session` (session-scoped trace), and `nexus` (cross-project relay evidence).

### 4.3 Provider Ecosystem

CleoOS is provider-neutral by design. The adapter system in `@cleocode/adapters` provides a bridge to every major AI coding tool:

- **Claude Code** -- Full adapter (hooks + spawn + install)
- **OpenCode** -- Full adapter (hooks + spawn + install)
- **Cursor** -- Minimal adapter (install only)
- **Future providers** -- Any tool that can speak MCP or implement the `CLEOProviderAdapter` interface

Discovery is manifest-based: each adapter declares detection patterns (environment variables, files, CLI availability), and the `AdapterManager` in core automatically activates the matching adapter at startup.

The Memory Bridge ensures every provider starts with context: a static seed file (`.cleo/memory-bridge.md`), guided self-retrieval via the `ct-memory` skill, and dynamic MCP resource endpoints (`cleo://memory/*`).

### 4.4 Project Lifecycle

CleoOS manages the full arc of a software project:

| Phase | What CleoOS Does |
|-------|-----------------|
| **Inception** | `initProject()` scaffolds `.cleo/`, detects the project type, configures the provider adapter, and establishes the brain |
| **Planning** | LOOM's Research and Consensus stages gather information and validate decisions before work begins |
| **Architecture** | ADRs are captured in `tasks.db`, linked to brain observations, and enforced through lifecycle gates |
| **Implementation** | Orchestration coordinates multi-agent waves, Impulse advances ready work, Watchers patrol for drift |
| **Validation** | Four-layer anti-hallucination checks, protocol compliance, and lifecycle gate enforcement |
| **Release** | Version bump, changelog generation, and ship pipeline with full provenance |
| **Maintenance** | Watchers detect stale gates, the Sweep performs quality patrols, Living BRAIN surfaces relevant memory |

Every phase is governed by LOOM's RCASD-IVTR+C pipeline with explicit gate transitions. No phase is skipped silently.

### 4.5 Brain Intelligence

The BRAIN system in `@cleocode/core` stores observations, patterns, learnings, and decisions. CleoOS extends this into active intelligence:

- **Three-layer retrieval** (shipped): search/timeline/fetch with ~10x token savings over traditional RAG
- **FTS5 full-text search** (shipped): keyword search across all brain tables
- **Vector similarity** (in progress): SQLite-vec integration for semantic retrieval
- **Knowledge graph** (planned): relationship-based discovery (updates/extends/derives) with temporal reasoning
- **Active circulation** (planned): Living BRAIN reinforces useful memories, detects contradictions, and surfaces relevant context proactively

The goal is a brain that does not merely store what happened, but actively improves the next action.

### 4.6 Nexus Network

NEXUS connects isolated CLEO projects into a federated intelligence network:

- **Project registry** -- each project is identified by a unique `projectHash` and registered in the global `~/.cleo/nexus.db`
- **Cross-project dependencies** -- `project:task_id` syntax enables dependencies that span project boundaries
- **Federated queries** -- search tasks, patterns, and learnings across all registered projects
- **Permission model** -- three-tier access (read/write/execute) preserves project sovereignty
- **Global pattern library** -- patterns and learnings from one project benefit all registered projects

At organizational scale, NEXUS transforms isolated project brains into a collective intelligence that learns across the entire development portfolio.

> **Phase 3 Deferral (T045 Assessment)**: A production usage audit conducted 2026-03-22 found that zero Nexus operations have been invoked outside of automated tests in 15+ days of availability. All 22 registered operations are implemented and tested (~5,753 production LOC, ~4,423 test LOC), but no real workflow has exercised cross-project coordination, task discovery, graph traversal, or transfer. The current use case -- single-project workflows -- does not yet require federated coordination. Nexus is formally deferred to Phase 3. Deferral criteria: any real workflow requires cross-project task references, or CleoOS delivers multi-project workspace views needing federated task data. See `.cleo/agent-outputs/T045-nexus-assessment.md` for the full analysis.

---

## 5. Architecture Layers

CleoOS is organized in layers, each with a clear responsibility:

```
+==================================================================+
|                        C l e o O S                                |
|                 Agentic Development Environment                   |
+==================================================================+
|                                                                   |
|  Operator Layer         The Hearth (terminal surface)             |
|                         Dashboard, diagnostics, runtime control   |
|                                                                   |
|  Execution Layer        Autonomous Runtime                        |
|                         Impulse + Watchers + Sweep + Refinery     |
|                         Looming Engine + Living BRAIN              |
|                                                                   |
|  Relay Layer            Conduit Protocol                          |
|                         LAFS/A2A agent-to-agent messaging         |
|                         Durable delivery, leases, retry           |
|                                                                   |
|  Coordination Layer     Orchestration + Lifecycle                 |
|                         Wave planning, spawn, gate enforcement    |
|                                                                   |
|  Network Layer          NEXUS                                     |
|                         Cross-project graph, federated queries    |
|                                                                   |
|  +---------------------------------------------------------+     |
|  |              @cleocode/core (kernel)                     |     |
|  |  Tasks | Sessions | Memory | Validation | Release       |     |
|  |  Admin | Sticky | Adapters | Skills | Compliance        |     |
|  +---------------------------------------------------------+     |
|  |           @cleocode/contracts (types)                    |     |
|  +---------------------------------------------------------+     |
|  |           SQLite (node:sqlite via Drizzle ORM)           |     |
|  |  tasks.db    brain.db    nexus.db                        |     |
|  +---------------------------------------------------------+     |
+==================================================================+
```

Each layer depends only on the layers below it. The kernel never reaches up into CleoOS execution or relay layers. This boundary is enforced by CI purity gates.

---

## 6. Vision Timeline

### What Exists Now (Core)

The kernel is shipped and operational:

- `@cleocode/core` v2.0.0 -- standalone business logic kernel with 45 domain modules
- `@cleocode/contracts` -- type-only interfaces (zero runtime deps)
- `@cleocode/adapters` -- unified provider adapters (Claude Code, OpenCode, Cursor)
- `@cleocode/cleo` -- full CLI + MCP product (221 operations across 10 dispatch domains)
- BRAIN with brain.db, FTS5 search, 3-layer retrieval, observation system, and agent execution learning
- LOOM with RCASD-IVTR+C pipeline, lifecycle gates, stage management, and pipeline stage binding (T056)
- NEXUS with project registry, cross-project queries, and dependency graph (deferred to Phase 3 -- see Section 4.6)
- LAFS with structured envelopes, MVI progressive disclosure, and RFC 9457 errors
- Cleo facade class with 12 domain APIs (tasks, sessions, memory, orchestration, lifecycle, release, admin, sticky, nexus, sync, agents, intelligence) and three consumer patterns
- Config schema audited: ~113 live fields (T101, down from ~283 before vaporware removal)
- Agent health monitoring, heartbeat protocol, crash detection, and capacity tracking (T038)
- General-purpose retry utility with exponential backoff in `lib` namespace (T038)
- Task hardening gates operational: AC enforcement, pipeline stage binding, verification auto-init, epic lifecycle enforcement (T056)
- Compliance telemetry and strictness presets (T056/T067)
- Impact prediction for downstream dependency analysis (T038)
- Cleo facade `agents` getter: register, deregister, health, detectCrashed, recordHeartbeat, capacity, isOverloaded, list (T127)
- Cleo facade `intelligence` getter: predictImpact, blastRadius (T127)
- Session+task binding: `sessions.start({ startTask })` for CleoOS workspace integration (T125)
- Task work on facade: `tasks.start/stop/current` — no direct barrel imports needed (T126)
- Bootstrap injection chain: legacy template sync, CAAMP sanitization, post-bootstrap health check (T124)
- Migration resilience: journal reconciliation and `ensureRequiredColumns()` safety net (v2026.3.61)

### What Is Specified (Runtime, Conduit)

The autonomous runtime and Conduit protocol are specified but not yet implemented:

- Autonomous Runtime Spec (`CLEO-AUTONOMOUS-RUNTIME-SPEC.md`) -- canon mapping, hook substrate, implementation order
- Conduit Protocol Spec (`CLEO-CONDUIT-PROTOCOL-SPEC.md`) -- envelope model, addressing, delivery state machine, IPC boundary
- Implementation tasks decomposed across foundation, Layer 1-3, and final proving layer

### What Is Future (CleoOS)

The full CleoOS vision requires:

- Agent-Runtime Core implementation (worker lifecycle, leases, identity)
- Impulse Engine (self-propelling work execution)
- Watchers Engine (patrol scheduling and health monitoring)
- Conduit broker (Rust delivery layer with durable relay state)
- The Hearth (terminal operator surface)
- Living BRAIN (active memory circulation with vector search and knowledge graph)
- Looming Engine (Tessera-driven decomposition)
- The Proving (end-to-end runtime validation)
- NEXUS at organizational scale (global pattern libraries, federated intelligence)

---

## 7. Design Principles

CleoOS inherits and extends the principles from `@cleocode/core`:

1. **Kernel stability** -- The kernel ships independently. CleoOS execution layers never destabilize core business logic.

2. **No new domains** -- The 10 canonical domains are fixed. CleoOS adds execution behavior on top of existing domains, never beside them.

3. **Provider neutrality** -- Every CleoOS capability works with any provider that implements the adapter contract. No provider lock-in at any layer.

4. **Local-first** -- All state lives in SQLite databases within the project's `.cleo/` directory. No cloud dependencies. Full portability.

5. **Governed execution** -- All autonomous work is bound by Warp chains and lifecycle gates. The system does not act without governance.

6. **Memory as infrastructure** -- BRAIN is not a feature. It is the foundation that makes sustained, multi-session, multi-agent development possible.

7. **Provenance by default** -- Every action, decision, and artifact carries attribution linking it to a task, agent, session, and lifecycle stage.

8. **Progressive disclosure** -- Agents manage their own token budget. The system provides minimal responses by default and full detail on request.

---

## 8. What CleoOS Is Not

- CleoOS is **not a cloud platform**. It runs locally, on the developer's machine, in their terminal.
- CleoOS is **not a replacement for CLEO**. It is the full realization of what CLEO's four systems become when assembled into a complete environment.
- CleoOS is **not an AI model**. It coordinates AI agents but does not provide intelligence itself. The intelligence comes from the models; CleoOS provides memory, governance, and continuity.
- CleoOS is **not a new protocol**. It uses LAFS, A2A, and MCP. It does not invent new communication standards.
- CleoOS is **not a multi-tenant SaaS**. It is built for one developer and their agents, with NEXUS providing optional cross-project coordination.

---

## 9. The Operating Metaphor

If `@cleocode/core` is the kernel, then:

- **BRAIN** is the filesystem -- persistent, structured, queryable memory
- **LOOM** is the process scheduler -- work progresses through governed stages
- **LAFS** is the system call interface -- structured contracts between user space and kernel
- **NEXUS** is the network stack -- connecting isolated systems into a coherent whole
- **The Impulse** is the init process -- the first motion that starts everything else
- **Conduit** is IPC -- how processes (agents) communicate
- **Watchers** are cron -- scheduled operations that maintain system health
- **The Hearth** is the terminal -- where the operator observes and interacts

CleoOS is the operating system that makes all of these work together as a single, coherent development environment.

---

## References

- `docs/concepts/CLEO-VISION.md` -- Canonical CLEO identity and system architecture
- `docs/concepts/CLEO-MANIFESTO.md` -- Founding myth and practical canon
- `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md` -- Autonomous runtime specification
- `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` -- Conduit protocol specification
- `docs/specs/CORE-PACKAGE-SPEC.md` -- @cleocode/core package contract
- `docs/adrs/ADR-001-provider-adapter-architecture.md` -- Adapter architecture
- `docs/adrs/ADR-002-provider-agnostic-memory-bridge.md` -- Memory bridge design
