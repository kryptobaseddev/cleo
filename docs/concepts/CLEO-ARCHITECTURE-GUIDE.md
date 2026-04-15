# CLEO Architecture Guide — How Everything Fits Together

**Version**: 1.0.0
**Status**: CANONICAL
**Author**: @cleo-historian
**Date**: 2026-03-31
**Canonical Location**: `docs/concepts/CLEO-ARCHITECTURE-GUIDE.md`

---

## Purpose

This is the plain-English guide to the CLEO architecture. No jargon soup. No abbreviation storms. If you're an agent coming online for the first time, a developer trying to understand the codebase, or a human who wants to know what all these names mean — start here.

The technical specs live in `docs/specs/`. This document tells you *what things are* and *how they relate* before you dive into the formal contracts.

---

## The Communication Stack

Everything in CLEO's agent communication follows this stack. Top to bottom:

```
CANT        — What agents SAY        (the language)
Conduit     — HOW messages MOVE      (the phone)
Transport   — WHAT WIRE carries it   (local/SSE/HTTP)
SignalDock  — WHO DELIVERS it        (the tower)
Dispatch    — WHERE it ROUTES        (11 domains)
LOOM        — WHAT STAGE it's in     (the lifecycle)
CAAMP       — WHEN events FIRE       (the hooks)
```

### CANT — The Language Agents Speak

Collaborative Agent Notation Tongue. When an agent posts:

```
/done @all T213 #shipped
```

That's CANT. The `/done` is a directive. `@all` is an address. `T213` is a task reference. `#shipped` is a tag. CANT is the grammar — the rules for how agents talk to each other and to CLEO.

CANT is **not** a transport. It doesn't move messages. It defines what messages look like.

### Conduit — The Phone In Your Hand

Conduit is the client-side TypeScript interface that agents use to send and receive messages. It defines `send()`, `onMessage()`, `connect()`, `disconnect()`. It doesn't care *how* messages get delivered — that's the transport's job.

Think of Conduit as the phone. You talk into it. It handles the rest.

**Conduit is NOT a domain.** It doesn't have its own house in the Circle of Eleven. It doesn't create operations. It lives *through* existing domains — `orchestrate` for coordination, `session` for context, `nexus` for cross-project relay. Conduit is the hallway between rooms, not a room itself.

### Transports — The Wires Between Phone and Tower

Transports are the physical delivery mechanism. Conduit picks the best one automatically:

| Transport | How It Works | When It's Used |
|-----------|-------------|----------------|
| **LocalTransport** | Reads/writes directly to signaldock.db on disk. No network at all. | Preferred whenever signaldock.db exists. Fully offline. |
| **SseTransport** | Server-Sent Events for real-time push from the cloud API. Falls back to HTTP if SSE fails. | When online and SSE endpoint is configured. |
| **HttpTransport** | HTTP polling to api.signaldock.io (primary) or api.clawmsgr.com (fallback). | Always available as last resort. |

Priority: **Local > SSE > HTTP**. Local is always preferred because it's fastest, offline-capable, and has zero network dependency.

### SignalDock — The Cell Tower Network

SignalDock is the server-side backend that actually delivers messages. It's the infrastructure — like the postal service or the cell tower network.

SignalDock runs in **dual mode**:
- **Cloud**: api.signaldock.io — Rust Axum API on Railway, SQLite + Redis + S3
- **Local**: signaldock.db — SQLite database in your `.cleo/` directory, managed by Diesel ORM

Both use the same schema. Messages written locally are the same format as messages in the cloud. An agent can work fully offline with LocalTransport → signaldock.db, then sync to the cloud later.

**SignalDock is NOT a CLEO system.** CLEO has six systems (below). SignalDock is an ally — essential infrastructure, but not part of CLEO's identity.

### The Full Flow

```
Your Agent
  → calls Conduit (TypeScript interface)
    → Conduit picks a Transport (Local > SSE > HTTP)
      → Transport talks to SignalDock (local DB or cloud API)
        → SignalDock delivers to the recipient agent
          → Recipient's Conduit fires onMessage()
```

---

## The Six Great Systems

These are the foundational systems that define what CLEO *is*. They are immutable — they don't change, they don't merge, they don't get replaced.

### TASKS — Work Tracking

The task management system. TASKS is the foundation: every piece of work from epics to subtasks lives here. It stores task hierarchy, dependencies, status, audit history, and lifecycle pipeline state in `tasks.db`.

### LOOM — Logical Order of Operations Methodology

The lifecycle framework. LOOM defines how work flows from idea to shipped product through the **RCASD-IVTR+C pipeline**:

**Planning Phase (RCASD)**:
1. **R**esearch — Gather information before deciding
2. **C**onsensus — Validate recommendations with evidence
3. **A**rchitecture — Document decisions (ADRs)
4. **S**pecification — Formal requirements (RFC 2119)
5. **D**ecomposition — Break into atomic tasks

**Execution Phase (IVTR)**:
6. **I**mplementation — Write code
7. **V**alidation — Verify against spec
8. **T**esting — Test suites
9. **R**elease — Version, document, ship

**Cross-Cutting (+C)**:
10. **C**ontribution — Attribution tracking across all stages

LOOM is **not** a pipeline. `pipeline` is a domain (The Weavers) that *implements* LOOM's lifecycle gates. LOOM is the methodology — the framework that says "work flows through these stages in this order." The domain enforces it at runtime.

### BRAIN — Memory & Cognition

The memory system. BRAIN stores everything agents learn across sessions: observations, patterns, learnings, decisions. It lives in `brain.db` with FTS5 full-text search and vector embeddings.

BRAIN is **not** a database. `brain.db` is a database. BRAIN is the *system* — the intelligence layer that includes search, retrieval, compression, knowledge graphs, and memory linking. Calling BRAIN "the database" is like calling a human "the skull."

**Three-Layer Retrieval**: Find (search index, cheap) → Timeline (chronological context) → Fetch (full details by ID). Always search before fetching. Never dump the whole database into context.

### NEXUS — Cross-Project Coordination

The network that connects separate CLEO projects together. If you have three repos each with their own `.cleo/` directory, NEXUS lets them discover each other's tasks, share patterns, and coordinate dependencies.

NEXUS is **not** a registry. It uses registries internally, but NEXUS is the *system* — the federation layer, the cross-project intelligence, the shared knowledge graph. Calling NEXUS "the registry" is like calling the internet "the DNS server."

### CANT — Collaborative Agent Notation Tongue

The agent communication protocol. CANT defines how agents speak to each other (conversation syntax: directives, addressing, task references, tags) and how the system speaks back (response syntax: LAFS envelopes). It is the grammar of the workshop floor.

CANT is **not** a transport. It defines what messages look like — the Conduit moves them.

### CONDUIT — Agent-to-Agent Relay

The live relay path for agent-to-agent messaging. Conduit carries tasking, handoff, status, and result messages using LAFS envelopes and A2A delegation. It uses a 4-shell transport stack: Pi native → conduit.db → signaldock-sdk → future broker.

Conduit is **not** a domain. It lives *through* existing domains — `orchestrate` for coordination, `session` for context, `nexus` for cross-project relay.

---

## The Circle of Eleven

CLEO has exactly **eleven** canonical domains. These are the rooms in the building where work gets done.

| Domain | House Name | What Happens Here |
|--------|-----------|-------------------|
| `tasks` | The Smiths | Creating, tracking, and completing work |
| `session` | The Scribes | Managing active work sessions |
| `memory` | The Archivists | Storing and retrieving knowledge (BRAIN) |
| `check` | The Wardens | Validation, quality gates, compliance |
| `pipeline` | The Weavers | Lifecycle stages, releases (LOOM) |
| `orchestrate` | The Conductors | Multi-agent coordination |
| `tools` | The Artificers | Skills, providers, capabilities |
| `admin` | The Keepers | Config, diagnostics, system health |
| `nexus` | The Wayfinders | Cross-project intelligence (NEXUS) |
| `sticky` | The Catchers | Quick captures before formal task creation |
| `intelligence` | The Seers | Quality prediction, pattern extraction, impact analysis |

Every operation in CLEO is addressed as `{domain}.{action}` — for example `tasks.add`, `memory.observe`, `pipeline.stage.validate`. Two gateways route them:

- **Query** (read-only): `show`, `find`, `list`, `status`, `plan`
- **Mutate** (writes): `add`, `update`, `delete`, `complete`, `start`, `stop`

---

## The Allies

These support the system but are **not** systems and **not** domains:

| Ally | Role | Metaphor |
|------|------|----------|
| **CAAMP** | Hook system — fires events before/after operations | The alarm system |
| **CANT** | Message grammar — defines what agents say | The language |
| **SignalDock** | Message delivery — cloud + local backend | The postal service |
| **Conduit** | Client interface — how agents hold the phone | The phone |

---

## The Workshop Vocabulary

CLEO uses a non-normative workshop vocabulary to make work intuitive:

| Term | What It Means |
|------|---------------|
| **Thread** | A single piece of work (maps to a task) |
| **Loom** | A frame holding related Threads (maps to an epic) |
| **Tapestry** | Multiple Looms forming a visible design (maps to a campaign) |
| **Warp** | The vertical structure — protocol chains and quality gates |
| **Cascade** | Work flowing through lifecycle gates (governed momentum) |
| **Cog** | A discrete callable capability (maps to a skill/tool) |
| **Click** | A single execution of a Cog |
| **Tome** | Rendered understanding — living documentation |
| **The Hearth** | The terminal surface where agents work |
| **Tessera** | A repeatable pattern template |
| **Sticky Note** | Quick ephemeral capture before formal classification |

These words are for humans — they make the system feel like a workshop, not a spreadsheet. The runtime still uses the eleven canonical domains.

---

## Quick Reference Card

```
Systems:    TASKS (work) | LOOM (lifecycle) | BRAIN (memory) | NEXUS (network) | CANT (protocol) | CONDUIT (relay)
Allies:     CAAMP (hooks) | LAFS (envelope format) | SignalDock (delivery) | intelligence (quality)
Domains:    tasks | session | memory | check | pipeline | orchestrate | tools | admin | nexus | sticky | intelligence
Gateways:   query (read) | mutate (write)
Transports: Local (SQLite) > SSE (push) > HTTP (poll)
Pipeline:   R → C → A → S → D → I → V → T → R → +C
Verbs:      add show list find update delete archive restore complete start stop
```

---

## References

- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — Formal domain definitions and operation registry
- `docs/specs/VERB-STANDARDS.md` — Canonical verbs with disambiguation rules
- `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` — Transport relay contract
- `docs/concepts/CLEO-VISION.md` — Six systems and identity
- `docs/concepts/NEXUS-CORE-ASPECTS.md` — Workshop vocabulary and Circle of Eleven
- `docs/concepts/CLEO-CANT.md` — Agent communication grammar
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` — Technical flow diagrams
- `CLEO-ULTRAPLAN.md` — Agent lifecycle and orchestration (supersedes `docs/specs/CLEO-ORCH-PLAN.md`, archived)
