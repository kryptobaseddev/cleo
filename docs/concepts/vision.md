# CLEO Vision

**The contract between you and your AI coding agent.**

## Vision Charter (Immutable)

This document is CLEO's constitutional vision and source of product identity. All strategic documents, specifications, ADRs, and implementation work MUST align to this vision. This document defines what CLEO **is** — not what it builds next.

## Agent Entry (Deterministic)

```
MODE: READ_ONLY_IDENTITY_BOOTSTRAP
PRIMARY_SOURCE: docs/concepts/vision.md
IDENTITY_LOCK: TRUE

READ_ORDER:
1) docs/concepts/vision.md                     (this document — canonical identity)
2) docs/specs/PORTABLE-BRAIN-SPEC.md            (normative product contract)
3) README.md                                    (public-facing product statement)
4) docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md    (phase/gate execution plan)
5) docs/specs/CLEO-BRAIN-SPECIFICATION.md       (BRAIN capability model)

NON_NEGOTIABLES:
- Do not redefine CLEO identity
- Treat planned/gated as not shipped
- Preserve canonical pillars and terminology
- LAFS is the agent communication contract
- LOOM (Logical Order of Operations Methodology) is the lifecycle pipeline — encompassing RCASD-IVTR+C
- BRAIN is the memory system
- NEXUS is the cross-project connective layer

CANONICAL_IDENTITY:
CLEO is a vendor-neutral Brain and Memory system for AI software
development that provides portable project memory, verifiable
provenance, and agent-safe orchestration across any repository,
model provider, or coding tool.

CANONICAL_PILLARS:
- Portable Memory (BRAIN)
- Agent Communication Contract (LAFS)
- Structured Lifecycle (RCASD-IVTR+C)
- Deterministic Safety
- Cognitive Retrieval (BRAIN + NEXUS)
```

---

## Canonical Product Statement

CLEO is a vendor-neutral **Brain and Memory system** for AI software development. It provides portable project memory, verifiable provenance, and agent-safe orchestration across any repository, model provider, or coding tool.

> **One developer. One AI agent. One source of truth.**

### The Name

CLEO is the name of the system. It originated as "Command Line Entity Orchestrator" but has evolved beyond that acronym. CLEO is now the proper name for the complete platform — encompassing the Brain, the lifecycle pipeline, the cross-project network, and the agent communication protocol. The name stands on its own.

---

## System Architecture

CLEO is composed of four interdependent systems. Each has a distinct role, and together they form a complete platform for AI-assisted software development.

```
+=====================================================================+
|                            C L E O                                  |
|              The Portable Brain and Memory System                   |
+=====================================================================+
|                                                                     |
|  +------------------------------+  +----------------------------+   |
|  |          B R A I N            |  |     L  O  O  M              |   |
|  |     Memory & Cognition       |  |   Logical Order of         |   |
|  |                              |  |   Operations Methodology   |   |
|  |  Observations  Patterns      |  |                            |   |
|  |  Learnings     Decisions     |  |  RCASD-IVTR+C Pipeline:    |   |
|  |  Sessions      Profiles      |  |  Research -> Consensus     |   |
|  |  FTS5 [OK] + Vec/Graph [TGT] |  |  -> Architecture Decision  |   |
|  |                              |  |  -> Specification          |   |
|  +------------------------------+  |  -> Decomposition          |   |
|                                    |  -> Implementation         |   |
|  +------------------------------+  |  -> Validation -> Testing  |   |
|  |         N E X U S             |  |  -> Release                |   |
|  |   Cross-Project Network      |  |  + Contribution (X-cut)    |   |
|  |                              |  +----------------------------+   |
|  |  Project Registry            |                                   |
|  |  Global Graph                |  +----------------------------+   |
|  |  Permission Model            |  |          L A F S            |   |
|  |  Federated Queries           |  |   Agent Communication      |   |
|  |  PageIndex + Similarity      |  |                            |   |
|  +------------------------------+  |  JSON Envelopes   MVI      |   |
|                                    |  Field Filtering  Flags    |   |
|                                    |  Exit Codes       Schema   |   |
|                                    +----------------------------+   |
|                                                                     |
|  +-----------------------------------------------------------------+
|  |                   Shared Core (src/core/)                       |
|  |  CLI (Commander.js)  |  MCP (cleo_query/cleo_mutate)  | API    |
|  +-----------------------------------------------------------------+
|  |                   SQLite (Drizzle ORM)                          |
|  |  .cleo/tasks.db        .cleo/brain.db          ~/.cleo/nexus.db [TGT]
|  |  (project work)        (memory/cognition)     (global network)  |
|  +-----------------------------------------------------------------+
+=====================================================================+
```

### The Four Systems

- **BRAIN — Memory & Cognition**: The persistent memory backend. Stores observations, patterns, learnings, and decisions in a dedicated `brain.db` (SQLite via Drizzle ORM). Shipped: brain.db schema with 6 tables, 3-layer retrieval (search/timeline/fetch), observe operation, and 5,122 migrated observations. Target: FTS5 search, vector similarity via SQLite-vec, and graph-based retrieval. The lifeblood of anti-hallucination.

- **LOOM — Logical Order of Operations Methodology**: The systematic framework for how CLEO processes project threads from concept to completion. LOOM encompasses the RCASD-IVTR+C pipeline (Research, Consensus, Architecture Decision, Specification, Decomposition, Implementation, Validation, Testing, Release) with the Contribution protocol (+C) running across all stages. It is the "order of operations" that moves work through its lifecycle.

- **NEXUS — Cross-Project Network**: The connective layer between registered CLEO projects. Uses the project's exposed tools to bridge global graphs, shared patterns, and federated queries while preserving per-project isolation.

- **LAFS — Agent Communication Contract**: The LLM-Agent-First Specification protocol. Defines how agents communicate with CLEO: JSON envelopes, MVI progressive disclosure, field filtering, exit codes, and output format semantics.

---

## Five Pillars

1. **Portable Memory (BRAIN)** — Every project carries its own `.cleo/` directory with SQLite storage (`tasks.db` for project work, sessions, ADRs, lifecycle, and audit; `brain.db` for dedicated memory/cognition) and three JSON configuration files (`config.json` for runtime settings, `project-info.json` for project identity/health, `project-context.json` for LLM agent guidance). Move the `.cleo/` directory, and the entire brain moves with it. Each project is identified by a unique `projectHash` in `project-info.json`. See ADR-011 for the complete configuration architecture.

2. **Agent Communication Contract (LAFS)** — All agent-CLEO communication follows the LAFS protocol: JSON envelopes with metadata, MVI-tiered progressive disclosure (minimal/standard/full/custom), field filtering via `_fields`, and deterministic exit codes. This contract is provider-neutral — any LLM agent that speaks LAFS can use CLEO.

3. **Structured Lifecycle (LOOM / RCASD-IVTR+C)** — Every significant piece of work follows LOOM's structured pipeline: Research, Consensus, Architecture Decision, Specification, Decomposition, Implementation, Validation, Testing, Release — plus the cross-cutting Contribution protocol for provenance. Lifecycle gates enforce progression.

4. **Deterministic Safety** — Four-layer validation (schema, semantic, referential, state machine), atomic write operations, immutable audit logs, and lifecycle gate enforcement. No partial writes. No hallucinated references. No skipped validation.

5. **Cognitive Retrieval (BRAIN + NEXUS)** — Three-tier retrieval in `brain.db`: FTS5 keyword search (SHIPPED), vector similarity via SQLite-vec (in progress), and graph-based discovery via PageIndex and dependency traversal (planned). The 3-layer retrieval API (search/timeline/fetch) is shipped and operational. Vectorless RAG (5 discovery methods) and ADR cognitive search are also shipped. NEXUS extends retrieval across project boundaries with federated queries and global pattern libraries.

---

## BRAIN: The Memory System

BRAIN is the persistent memory backend that makes CLEO a non-hallucination tool system. Inspired by [claude-mem](https://github.com/thedotmack/claude-mem) (observation compression, progressive disclosure, and the three-layer retrieval workflow) and [supermemory](https://github.com/supermemoryai/supermemory) (knowledge graphs, temporal decay, memory extraction, and semantic retrieval), BRAIN uses a dedicated memory database (`brain.db`) alongside the project work database (`tasks.db`). The brain.db migration is complete: 6 tables shipped, 3-layer retrieval operational, and 5,122 observations migrated from claude-mem.

### Brain Metaphor: Domains as Cognitive Functions

CLEO's 10 canonical domains map directly to cognitive functions — each domain operates like a specialized brain system:

| Domain | Brain Metaphor | What It Means |
|--------|---------------|---------------|
| **tasks** | Neurons | Atomic knowledge units — the leaf thoughts. Tasks are the fundamental building blocks of work, just as neurons are the fundamental building blocks of cognition. |
| **session** | Working Memory | Short-term context, what you're thinking about now. Sessions maintain the immediate context of active work, holding the "mental workspace" for the current agent interaction. |
| **memory** | Long-term Memory | Stored knowledge, patterns, learnings, decisions. The BRAIN database (`brain.db`) persists observations, patterns, and decisions across sessions. |
| **check** | Immune System | Validation, quality — catches problems before they spread. The check domain identifies issues, validates compliance, and ensures work quality before problems propagate. |
| **pipeline** | Executive Pipeline | RCASD-IVTR+C — the structured process of deciding and doing. The pipeline domain governs the LOOM lifecycle stages with gate enforcement and stage management. |
| **orchestrate** | Executive Function | Multi-agent coordination — how the brain delegates work. Orchestrate handles wave planning, agent spawning, and coordination of parallel workstreams. |
| **tools** | Capabilities | Skills, providers — learned abilities. The tools domain manages the capabilities CLEO can invoke: skills, provider integrations, and issue tracking. |
| **admin** | Autonomic System | Background infrastructure — breathing, heartbeat, backups. Admin handles the unconscious operations: configuration, backups, migrations, and system health. |
| **nexus** | Hive Network | Cross-project intelligence — connecting brains. Nexus enables knowledge sharing and federated queries across registered CLEO projects. |
| **sharing** | Social Memory | What gets shared with others. The sharing domain manages allowlists and sync status for cross-project collaboration. |

This metaphor isn't decorative — it reflects the architectural design where tasks form neural networks via dependencies and hierarchy, orchestration mirrors executive function, and the pipeline serves as the executive pathway for moving work from conception to completion.

### Database Architecture

| Database | Contents | Scope |
|----------|----------|-------|
| **`.cleo/tasks.db`** | Tasks, sessions, lifecycle pipelines, ADRs, audit log, status registry | Project work — the structured RCASD-IVTR+C pipeline |
| **`.cleo/brain.db`** | Observations, patterns, learnings, decisions, memory links, FTS5 indexes | Memory and cognition — SHIPPED with 6 tables, 3-layer retrieval. Vector embeddings and PageIndex are planned. |
| **`~/.cleo/nexus.db`** [TARGET] | Project registry, cross-project graph edges, permissions, global pattern library | Global NEXUS network — currently served by JSON registry |

Three JSON configuration files complement the databases (exempt from SQLite-only storage per ADR-006, ADR-011):

| File | Contents | Audience |
|------|----------|----------|
| **`.cleo/config.json`** | Runtime behavior: hierarchy limits, session rules, lifecycle mode, backup retention | CLEO runtime (every operation) |
| **`.cleo/project-info.json`** | Project identity: `projectHash`, schema versions, injection status, health diagnostics, feature flags | CLEO internals, NEXUS registry |
| **`.cleo/project-context.json`** | LLM agent guidance: detected language, test framework, package manager, conventions, LLM hints | LLM agents (via `@` injection into AGENTS.md) |

`brain.db` is linked to `tasks.db` via task IDs in the `brain_memory_links` table — every observation, pattern, and learning references the task context it came from. This separation keeps project work operations fast while allowing BRAIN to grow with rich memory structures (FTS5 virtual tables, vector indexes, graph edges) without impacting task CRUD performance.

### Memory Model

BRAIN distinguishes between **raw artifacts** (session transcripts, code diffs, manifest entries) and **extracted knowledge** (patterns, learnings, decisions). This mirrors the Document/Memory distinction — raw input is ingested, then AI-powered extraction produces structured, searchable knowledge units.

| Memory Type | Description | Persistence |
|-------------|-------------|-------------|
| **Observations** | Compressed records of what happened during sessions | Permanent |
| **Patterns** | Recurring workflows, blockers, successes, and optimizations | Strengthens with repetition |
| **Learnings** | Actionable insights extracted from project work | Confidence-scored |
| **Decisions** | Architecture Decision Records (ADRs) with cognitive search | Permanent (version-chained) |
| **Sessions** | Handoff notes, briefings, and continuity context | Per-session |
| **Profiles** | Static project facts + dynamic recent context | Auto-maintained |

### Three-Layer Retrieval [SHIPPED]

BRAIN implements a progressive retrieval workflow (inspired by claude-mem) that achieves ~10x token savings over traditional RAG:

1. **Find** (`memory find`) — Returns a compact index with IDs and titles (~50-100 tokens per result)
2. **Timeline** (`memory timeline`) — Shows chronological context around interesting results
3. **Fetch** (`memory fetch`) — Retrieves full details ONLY for pre-filtered IDs (~500-1000 tokens each)

The agent manages its own token budget by deciding what to fetch based on relevance. Saving new observations uses `memory observe` via the mutate gateway.

### Knowledge Graph [GATED]

Memories will form a graph with three relationship types:

| Relation | Meaning | Example |
|----------|---------|---------|
| **Updates** | Supersedes prior knowledge | New ADR replaces old architecture decision |
| **Extends** | Enriches existing knowledge | Implementation detail adds to specification |
| **Derives** | Inferred from related context | Pattern detected from recurring task failures |

The `isLatest` flag will track which version of a fact is current, enabling temporal reasoning and preventing stale knowledge from polluting agent context.

### Search Infrastructure

| Tier | Technology | Status | Capability |
|------|-----------|--------|------------|
| **S** | `brain.db` + FTS5 | Shipped | Full-text keyword search across decisions, patterns, learnings, observations |
| **M** | `brain.db` + SQLite-vec | In Progress (T5157) | Vector embeddings for semantic similarity search |
| **L** | `brain.db` + PageIndex + Graph | Planned (T5160) | Graph-based traversal and cross-reference discovery via NEXUS |

> **Current state (2026-03-02)**: BRAIN memory is in `brain.db` (SQLite) with 5 tables, FTS5 search, 3-layer retrieval API, and 5,122 observations migrated from claude-mem. The JSONL file era is over.

### Current State vs Target

**Shipped**: `brain.db` (5 tables: decisions, patterns, learnings, observations, memory_links), FTS5 full-text search, 3-layer retrieval (memory find / timeline / fetch), memory observe, 201 MCP operations (112 query + 89 mutate), 5,122 observations migrated from claude-mem, ADR cognitive search, session handoffs, contradiction detection, vectorless RAG

**In Progress**: SQLite-vec integration (T5157), NEXUS MCP wiring (nexus-wirer), PageIndex graph tables (T5160)

**Planned**: Vector embeddings pipeline (T5158-T5159), reasoning engine (T5162-T5163), memory consolidation (T5166), temporal decay (T5167), full claude-mem plugin retirement

---

## LAFS: The Agent Communication Contract

[LAFS](https://github.com/kryptobaseddev/lafs-protocol) (LLM-Agent-First Specification) is the protocol that makes CLEO truly provider-neutral. It defines the contract between any AI agent and CLEO's tools.

### Why LAFS Matters

Every LLM provider has different capabilities, context windows, and tool-calling conventions. LAFS normalizes communication so that Claude, GPT, Gemini, or any future model can use CLEO identically:

| LAFS Component | Purpose |
|----------------|---------|
| **JSON Envelopes** | Structured response format with `_meta`, `result`, and `_warnings` |
| **MVI Levels** | Progressive disclosure: `minimal` (lists), `standard` (details), `full` (everything), `custom` (field-filtered) |
| **Field Filtering** | `_fields` parameter for token-efficient partial responses |
| **Exit Codes** | Deterministic numeric codes for programmatic error handling |
| **Output Formats** | `--json` (default for agents), `--human` (for developers), `--quiet` (for scripts) |
| **Flag Resolution** | Deterministic precedence rules when multiple format flags conflict |

### Agent-First Design

CLEO is built for LLM agents first, with human accessibility second:

| Dimension | Human User | LLM Agent |
|-----------|------------|-----------|
| **Input** | Natural language, flexibility | Structured data, constraints |
| **Errors** | Reads error messages | Branches on exit codes |
| **Validation** | Trusts own judgment | Needs external ground truth |
| **Context** | Maintains mental model | Loses context between sessions |
| **Completion** | Knows when "done" | Needs explicit success criteria |
| **Output** | Prefers readable text | Prefers parseable JSON |

---

## LOOM: Logical Order of Operations Methodology

LOOM is the systematic framework for how CLEO processes project threads through the complete RCASD-IVTR+C pipeline. It gives a name to the "order of operations" for how work flows from concept to completion — the loom upon which ideas are woven into shipped software.

### The LOOM Framework

LOOM encompasses the full lifecycle methodology that transforms raw ideas into delivered artifacts. While RCASD-IVTR+C defines the stages, LOOM defines the system that moves threads through them:

```
LOOM — Logical Order of Operations Methodology
├── Thread Ingestion       Ideas enter via Research
├── Consensus Weaving      Multi-agent validation and ADR capture
├── Specification Design   Formal requirements in RFC 2119
├── Task Decomposition     Breaking work into atomic units
├── Execution Orchestration Implementation with validation loops
├── Quality Assurance      Testing and gate enforcement
└── Release Completion     Shipping with full provenance
```

LOOM treats the pipeline as a continuous thread: Research feeds Consensus, which produces ADRs, which inform Specifications, which drive Decomposition, which generates Implementation tasks that cycle through Validation and Testing until they emerge as Releases. The +C (Contribution) protocol runs through every stage, ensuring attribution and provenance.

### The Neural Hierarchy of Work

Within LOOM, work units form a neural hierarchy:

| Element | Brain Analog | Meaning |
|---------|--------------|---------|
| **Tasks** | Neurons | Atomic knowledge units — the leaf thoughts |
| **Dependencies** | Synapses | Directional connections between tasks |
| **Hierarchy** | Weights | Proximity strengthens relevance (parent-child relationships) |

This neural model enables CLEO's vectorless RAG: structural discovery through dependency graphs and hierarchy traversal, without requiring vector embeddings.

---

## RCASD-IVTR+C: The Lifecycle Pipeline

Every significant piece of work in CLEO follows the RCASD-IVTR+C pipeline — the structured lifecycle stages that LOOM moves work through. This ensures quality, traceability, and reproducibility across autonomous agent workflows.

### Pipeline Stages

```
RCASD (Planning Phase)
  R  Research              Gather information before deciding
  C  Consensus             Validate recommendations, evidence-based decisions
  A  Architecture Decision Document architectural choices (ADRs)
  S  Specification         Formal requirements (RFC 2119 language)
  D  Decomposition         Break into atomic tasks with dependencies

IVTR (Execution Phase)
  I  Implementation        Write code that meets specifications
  V  Validation            Verify implementation matches spec
  T  Testing               Formal test suites for coverage
  R  Release               Version, document, and ship

+C (Cross-Cutting)
  C  Contribution          Attribution tracking across ALL stages
```

### Lifecycle Gates

Each stage transition is enforced by a **lifecycle gate**. Gates verify that prerequisite stages are complete before allowing progression:

```mermaid
flowchart LR
    R[Research] --> C[Consensus]
    C --> A[Architecture<br/>Decision]
    A --> S[Specification]
    S --> D[Decomposition]
    D --> I[Implementation]
    I --> V[Validation]
    V --> T[Testing]
    T --> Rel[Release]

    style R fill:#0D9373
    style C fill:#0D9373
    style A fill:#0D9373
    style S fill:#0D9373
    style D fill:#0D9373
    style I fill:#07C983
    style V fill:#07C983
    style T fill:#07C983
    style Rel fill:#07C983
```

| Mode | Behavior | Use Case |
|------|----------|----------|
| `strict` | Blocks progression with exit 75 | Production (default) |
| `advisory` | Warns but allows progression | Development |
| `off` | Skips gate checks | Emergency bypass |

### Provenance

The Contribution protocol (+C) applies across all stages. Every task completion, manifest entry, and audit log record carries provenance tags linking work to its task ID, agent, session, and lifecycle stage. This creates an unbroken chain from research finding to shipped release.

---

## NEXUS: The Cross-Project Network

NEXUS extends CLEO's tools across project boundaries. Each CLEO project is self-contained in its `.cleo/` directory. NEXUS connects them.

### Design Principles

- NEXUS uses each project's **existing exposed tools** — it does not bypass project boundaries
- Every project remains portable: `.cleo/` is the complete brain, NEXUS is the optional network
- Cross-project queries respect a three-tier permission model (read/write/execute)
- On-demand operation, not real-time sync — solo developer focus

### Architecture

```
~/.cleo/                          (Global NEXUS Layer)
  nexus.db [TGT]                  Global registry, cross-project graph, permissions
  config.json                     Global CLEO configuration

/project-a/.cleo/                 (Project A — fully portable)
  tasks.db                        Tasks, sessions, ADRs, lifecycle, audit
  brain.db                        Observations, patterns, learnings, decisions
  config.json                     Runtime settings (hierarchy, session, lifecycle)
  project-info.json               Project identity, projectHash (85f1cc25bb9f)
  project-context.json            LLM agent guidance (language, framework, conventions)

/project-b/.cleo/                 (Project B — fully portable)
  tasks.db                        Tasks, sessions, ADRs, lifecycle, audit
  brain.db                        Observations, patterns, learnings, decisions
  config.json                     Runtime settings
  project-info.json               Project identity, projectHash (c4e9a1f03d72)
  project-context.json            LLM agent guidance

NEXUS connects them:
  project-a:T042 --depends--> project-b:T015
  Pattern from project-a discoverable in project-b
  Federated search across all registered projects

Portability:
  Move .cleo/ directory → project works anywhere
  NEXUS auto-detects registered projects via project-info.json
  Unregistered projects work standalone (no NEXUS required)
```

### Capabilities

- **Cross-Project Discovery** — Find related tasks, patterns, and decisions across all registered projects using graph traversal and similarity algorithms
- **Federated Dependencies** — Reference syntax `project:task_id` enables dependencies that span project boundaries
- **Permission Control** — Three-tier access model (read/write/execute) preserves project isolation while enabling collaboration
- **Global Pattern Library** — Patterns and learnings from BRAIN can be shared across projects — what works in one project benefits all

### Graph Infrastructure

NEXUS leverages graph structures built into each project's `tasks.db` and `brain.db`:

| Component | Purpose | Storage |
|-----------|---------|---------|
| **PageIndex** | Hierarchical content index for efficient retrieval | `brain.db` [GATED] |
| **Dependency Graph** | Forward and reverse task dependency edges | `tasks.db` — `taskDependencies` + `taskRelations` tables (shipped) |
| **Similarity Graph** | Weighted edges from label/description/file/hierarchy matching | Computed on demand, cached in memory (shipped) |
| **Vector Index** | Embedding-based similarity for semantic search | `brain.db` via SQLite-vec [GATED] |
| **Knowledge Graph** | Memory relationships (updates/extends/derives) | `brain.db` [GATED] |

### Current State vs Target

**Shipped**: Project registry (JSON), three-tier permissions, cross-project task resolution, dependency graph in `tasks.db`, vectorless similarity discovery (5 methods), graph caching with TTL, `project-info.json` with unique `projectHash` for portable identity

**Gated**: Dedicated `nexus.db` (migration from JSON registry), PageIndex tables in `brain.db`, vector similarity via SQLite-vec, federated BRAIN queries across projects, global pattern/learning library, knowledge graph with version chains

---

## Anti-Hallucination Protocol

Every operation undergoes **four-layer validation**:

### Layer 1: Schema — JSON Schema Enforcement

- Structure validation
- Type checking
- Enum constraints (`status: pending|active|blocked|done`)
- Format validation (ISO 8601 timestamps, T### IDs)

### Layer 2: Semantic — Cross-Record Integrity

- ID uniqueness across active + archived tasks
- Timestamp sanity (not future, `completedAt > createdAt`)
- Content pairing (title != description)
- Duplicate detection

### Layer 3: Referential — Referential Integrity

- Audit log entries reference valid task IDs
- Dependency targets exist
- Parent-child hierarchy valid (max depth 3)
- Archive consistency

### Layer 4: State Machine — Transition Validation

- Valid status transitions only
- Lifecycle gate enforcement (RCASD-IVTR+C)
- Protocol compliance checking (exit codes 60-67)
- Configuration policy enforcement

## Atomic Operations

> **No partial writes. No data corruption. Full rollback on any failure.**

Every write operation follows this pattern:

```mermaid
graph LR
    A[Write temp file] --> B{Validate against schema}
    B -->|Invalid| C[Delete temp & abort]
    B -->|Valid| D[Backup current file]
    D --> E[Atomic rename]
    E --> F[Log to audit trail]
```

---

## The Contract

When you use CLEO with any AI coding tool, you establish a formal contract:

- **Stable Identity** — Tasks are identified by stable IDs (`T001`) that **never change**, regardless of hierarchy restructuring
- **LAFS-Compliant Output** — All output follows the LAFS protocol: JSON envelopes with `_meta`, MVI-tiered progressive disclosure, and deterministic field filtering
- **Numeric Exit Codes** — All errors have numeric exit codes for programmatic branching (0-99 standard, 100+ special conditions)
- **Validation First** — All operations validate first, fail fast on invalid input — four-layer anti-hallucination
- **Persistent Memory** — All project state is persisted in SQLite (`tasks.db` for work and sessions; `brain.db` for dedicated memory) as the single source of truth per project
- **Immutable Audit Trail** — All changes are logged in an append-only audit log with provenance tags
- **Atomic Writes** — All writes are atomic with automatic backup and rollback — no partial corruption
- **Lifecycle Governance** — Significant work follows the RCASD-IVTR+C pipeline with gate enforcement

This contract enables **reliable, repeatable AI-assisted development** regardless of which LLM provider powers the agent.

---

## Shared-Core Architecture

CLEO uses a shared-core architecture where both MCP and CLI are thin wrappers around `src/core/`:

- **MCP (Primary)**: 2 tools (`cleo_query`, `cleo_mutate`), 201 operations across 10 domains — the agent interface
- **CLI (Backup)**: 86 commands via Commander.js — the human interface
- **src/core/ (Canonical)**: All business logic. Both MCP and CLI delegate here
- **Adapters (Optional)**: Tool-specific UX optimizations without changing core semantics

All interfaces MUST preserve the same memory model, lifecycle guarantees, provenance invariants, and LAFS compliance.

---

## Founding Principles

1. **Simplicity** — Flat sequential IDs (`T001`, `T042`) that never change, regardless of hierarchy restructuring
2. **Flat Structures** — Three-level hierarchy maximum: Epic -> Task -> Subtask. Seven siblings maximum per parent.
3. **Computed Metrics** — No time estimates; scope-based sizing only (small/medium/large). AI cannot accurately predict duration.
4. **Portability** — Per-project `.cleo/` directory is the complete brain. Global `~/.cleo/` for NEXUS and shared configuration.
5. **Dual Readability** — JSON for agents (default via LAFS), human-readable on request (`--human`). Agent-first, human-accessible.

---

## Provider Neutrality

CLEO is provider-agnostic by design. The LAFS protocol ensures that any LLM agent — Claude, GPT, Gemini, Llama, or future models — can use CLEO identically through the same structured interface.

- Tool-specific integrations (Claude Code plugin, Cursor adapter) MAY optimize user experience
- Core memory models, provenance semantics, and lifecycle enforcement MUST remain neutral and portable
- BRAIN stores project knowledge in SQLite (`tasks.db` + `brain.db`) — no cloud dependencies, no vendor lock-in
- NEXUS connects projects locally — no external services required

---

## What CLEO Solves

| Problem | CLEO Solution |
|---------|---------------|
| AI agent forgets yesterday's context | **BRAIN** memory with session handoffs and observation compression |
| Unclear which tasks are actually done | **RCASD-IVTR+C** lifecycle gates and verification |
| Hallucinated task references | Four-layer anti-hallucination validation on every operation |
| Context degrades over long sessions | Progressive disclosure via **LAFS** MVI levels and three-layer retrieval |
| Complex workflows overwhelm context | Orchestrated multi-agent coordination with 10K token budget |
| Knowledge trapped in one project | **NEXUS** cross-project discovery and federated queries |
| Agent outputs aren't traceable | Provenance by default — every artifact linked to task, agent, session |

---

## Daily Workflow

### Morning Routine

```bash
cleo session start
cleo dash              # See project state via BRAIN
cleo current           # What was I working on?
cleo next --explain    # What should I do next?
```

### During Work

```bash
cleo start T042              # Start task (lifecycle tracking)
cleo update T042 --notes "..." # Document progress (BRAIN stores it)
cleo complete T042             # Finish task (provenance recorded)
```

### End of Day

```bash
cleo session end --note "Completed auth flow, tests passing"
# BRAIN persists session context for next time
```

---

## Vision Governance

- This document defines what CLEO **is**, not just what it builds next.
- Any change that alters canonical identity requires explicit vision amendment.
- Changes MUST be synchronized to `README.md` and `docs/specs/PORTABLE-BRAIN-SPEC.md`.
- Strategic documents MUST align to this vision; they cannot redefine it.
- The four systems (BRAIN, LOOM, NEXUS, LAFS) are canonical and immutable.
- Individual system specifications may evolve, but the roles described here are fixed.

### Document Authority Hierarchy

| Priority | Document | Purpose |
|----------|----------|---------|
| 1 | `docs/concepts/vision.md` | Immutable vision identity (this document) |
| 2 | `docs/specs/PORTABLE-BRAIN-SPEC.md` | Normative product contract |
| 3 | `README.md` | Public-facing product statement |
| 4 | `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` | Phase/gate execution plan |
| 5 | `docs/specs/CLEO-BRAIN-SPECIFICATION.md` | BRAIN capability model |

If conflicts occur, higher priority prevails.

> **Migration note**: Specs at priority 2, 4, and 5 are currently in `docs/mintlify/specs/` awaiting validation and promotion to `docs/specs/`. See T4573 for alignment task tracking.
