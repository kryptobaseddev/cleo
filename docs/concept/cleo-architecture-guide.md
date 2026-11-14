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

## Agent Messaging

CLEO does not run its own message transport. **AgentMBX** is CLEO's messaging layer (D11176): every agent-to-agent message, same project or across machines, goes through the `mbx` mailbox and its daemon, with one inbox and one history. Orca dispatches workers and relays their reports over the same mailbox (D11242).

```
CANT       — WHAT agents say        (the grammar)
AgentMBX   — HOW messages move      (the mailbox: send, inbox, read, reply, ack)
Dispatch   — WHERE work routes      (11 domains, `cleo <command>`)
LOOM       — WHAT STAGE work is in  (the lifecycle)
CAAMP      — WHEN events fire       (the hooks)
```

### CANT — The Language Agents Speak

Collaborative Agent Notation Tongue. When an agent posts:

```
/done @all T213 #shipped
```

That's CANT. The `/done` is a directive. `@all` is an address. `T213` is a task reference. `#shipped` is a tag. CANT is the grammar — the rules for how agents talk to each other and to CLEO.

CANT is **not** a transport. It defines what messages look like; AgentMBX carries them.

### Conduit and SignalDock (legacy)

- **Conduit** is legacy: only a thin client over AgentMBX, with no standalone database or transport of its own.
- **SignalDock** is deprecated. Its cloud API, `signaldock.db` and the Local/SSE/HTTP transport stack are no longer how CLEO agents talk.

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

CANT is **not** a transport. It defines what messages look like — AgentMBX moves them.

### CONDUIT — Agent-to-Agent Relay (legacy)

Agent-to-agent messages travel over AgentMBX (D11176). Conduit remains only as a thin client over AgentMBX, with no standalone database or transport.

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
| **AgentMBX** | Agent messaging — mailbox, delivery and history (D11176) | The post office |

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

## Request Flow

Folded from the retired `cleo-system-flow-atlas` (T14108 docs census). Every CLI
operation takes the same path:

1. **Parse.** The command (`packages/cleo/src/cli/commands/`, built with
   `defineCommand`) parses flags into a dispatch request through the CLI adapter
   (`packages/cleo/src/dispatch/adapters/cli.ts`).
2. **Resolve.** The dispatcher (`@cleocode/runtime/gateway`) looks up the
   operation by domain and name in the registry
   (`packages/cleo/src/dispatch/registry.ts`, described by
   `packages/contracts/src/dispatch/operations-registry.ts`) and checks required
   parameters. An unknown or removed operation fails; there is no fallback.
3. **Middleware.** The request passes the pipeline in
   `packages/cleo/src/dispatch/middleware/`: sanitizer, session resolution,
   rate limit, protocol enforcement, verification gates, idempotency, store
   write guard, audit, and the field and projection filters.
4. **Handle.** The domain handler (`packages/cleo/src/dispatch/domains/`) calls
   its engine (`packages/cleo/src/dispatch/engines/`), which calls the
   business logic in `@cleocode/core`.
5. **Store.** Core reads and writes one `cleo.db` per scope (project and
   global, prefixed tables) through `openDualScopeDb` and the store accessors.
6. **Respond.** The result returns as one LAFS envelope on stdout (ADR-086);
   logs go to stderr.

Queries never change state; mutations may. `tasks.update` with `status=done`
goes through the same completion checks as `tasks.complete`.

## Quick Reference Card

```
Systems:    TASKS (work) | LOOM (lifecycle) | BRAIN (memory) | NEXUS (network) | CANT (protocol) | CONDUIT (relay)
Allies:     CAAMP (hooks) | LAFS (envelope format) | AgentMBX (messaging) | intelligence (quality)
Domains:    tasks | session | memory | check | pipeline | orchestrate | tools | admin | nexus | sticky | intelligence
Gateways:   query (read) | mutate (write)
Messaging:  AgentMBX (mbx send / inbox / read / reply / ack)
Pipeline:   R → C → A → S → D → I → V → T → R → +C
Verbs:      add show list find update delete archive restore complete start stop
```

---

## Canonical Artifact Paths

Artifacts produced during work follow a standardized path structure. See [ADR-045](../../docs/adr/adr-045-cleo-scaffolding-ssot.md) and [cleo-scaffolding-ssot-spec.md](../spec/cleo-scaffolding-ssot.md) for full details.

### RCASD Lifecycle Stage Artifacts

All RCASD (Research–Consensus–Architecture–Specification–Decomposition) stage outputs for epic `{epicId}` are stored at:

```
.cleo/rcasd/{epicId}/{stageSubdir}/{epicId}-{stageSlug}.md
```

| Stage | Subdir | Slug | Example Path |
|-------|--------|------|--------------|
| Research | `research` | `research` | `.cleo/rcasd/T687/research/T687-research.md` |
| Consensus | `consensus` | `consensus` | `.cleo/rcasd/T687/consensus/T687-consensus.md` |
| Architecture Decision | `architecture` | `architecture-decision` | `.cleo/rcasd/T687/architecture/T687-architecture-decision.md` |
| Specification | `specification` | `specification` | `.cleo/rcasd/T687/specification/T687-specification.md` |
| Decomposition | `decomposition` | `decomposition` | `.cleo/rcasd/T687/decomposition/T687-decomposition.md` |
| Implementation | `implementation` | `implementation` | `.cleo/rcasd/T687/implementation/T687-implementation.md` |
| Validation | `validation` | `validation` | `.cleo/rcasd/T687/validation/T687-validation.md` |
| Testing | `testing` | `testing` | `.cleo/rcasd/T687/testing/T687-testing.md` |
| Release | `release` | `release` | `.cleo/rcasd/T687/release/T687-release.md` |
| Contribution | `contributions` | `contribution` | `.cleo/rcasd/T687/contributions/T687-contribution.md` |

### Architecture Decision Records (ADRs)

ADRs are stored at:

```
.cleo/adrs/ADR-NNN-short-description.md
```

Example: `docs/adr/adr-045-cleo-scaffolding-ssot.md`

ADRs are managed via `cleo adr` commands and mirrored to the `architecture_decisions` database table.

### Agent Output Files (Ad-hoc)

Ad-hoc agent outputs (non-RCASD) are stored at:

```
.cleo/agent-outputs/{taskId}-{slug}.md
```

Examples:
- `.cleo/agent-outputs/T687-scaffolding-rcasd-plan.md`
- `.cleo/agent-outputs/T505-CLI-audit-report.md`
- `.cleo/agent-outputs/T684-browser-validation/validation-report.md`

### Published Specifications

Normative, human-facing specifications (RFC 2119 language, stable contracts) are stored at:

```
docs/specs/SPEC-NAME.md
```

Example: `docs/specs/cleo-scaffolding-ssot-spec.md`

### Engineering Plans

Active engineering plans are stored at:

```
docs/plans/PLAN-NAME.md
```

Examples:
- `docs/plans/CLEO-ULTRAPLAN.md`
- `docs/plans/T662-council-round-table-report.md`

### Deprecated Paths (Do Not Use)

The following paths are **deprecated** and MUST NOT be used for new files:

- `claudedocs/agent-outputs/` → use `.cleo/agent-outputs/`
- `claudedocs/research-outputs/` → use `.cleo/agent-outputs/`
- `.cleo/research/` → use `.cleo/rcasd/{epicId}/research/`
- `.cleo/consensus/` → use `.cleo/rcasd/{epicId}/consensus/`
- `.cleo/specs/` → use `.cleo/rcasd/{epicId}/specification/`
- `.cleo/decomposition/` → use `.cleo/rcasd/{epicId}/decomposition/`

---

## References

- [CLEO canon index](cleo-canon-index.md) — read order and map of the canonical docs
- [Operation constitution](../spec/cleo-operation-constitution.md) — formal domain definitions and operation registry
- [Verb standards](../spec/verb-standards.md) — canonical verbs with disambiguation rules
- [CANT reference](../reference/cant.md) — agent communication grammar (absorbs the retired `cleo-cant` overview)
- [Orchestration flow](orchestration-flow.md) — spawn layers, spawn execution, lead and worker roles
