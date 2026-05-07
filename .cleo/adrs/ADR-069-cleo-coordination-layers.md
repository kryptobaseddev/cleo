# ADR-069: CLEO Coordination Layers — Workflow / Messaging / Storage / Data

**Date**: 2026-05-06
**Status**: Accepted
**Accepted**: 2026-05-06
**Related Tasks**: T9049, T9050 (umbrella DataAccessor / `openCleoDb` chokepoint), T9047 (parent epic)
**Related ADRs**: ADR-006 (canonical SQLite storage), ADR-008 (shared-core + CQRS dispatch), ADR-013 (runtime data safety), ADR-027 (manifest unification → `pipeline_manifest`), ADR-035 (Pi v2/v3 harness), ADR-037 (conduit + signaldock separation), ADR-049 (harness sovereignty), ADR-050 (CleoOS sovereign harness), ADR-054 (manifest unification), ADR-068 (canonical agent system)
**Keywords**: coordination-layers, workflow, messaging, storage, data, harness, conduit, dataaccessor, opencleodb, feedback-channels, layering-contract, false-positive
**Topics**: architecture, layering, orchestration, messaging, storage
**Decision**: D003 (CLEO Coordination Layering Contract)

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

### The recurring "overlapping coordination systems" false-positive

Graph-AI tooling (gitnexus, BRAIN scans, third-party static analysers) periodically flags CLEO as having "overlapping" or "three-tier redundant" coordination systems. The flag fires because, on first inspection, CLEO appears to ship multiple parallel feedback channels:

1. **Conduit messages** — agent-to-agent DMs persisted in `.cleo/conduit.db` (ADR-037).
2. **Agent output drops** — `.cleo/agent-outputs/*.md` Markdown artefacts written by subagents on completion.
3. **Completion gates** — `cleo verify --gate <name> --evidence …` writing programmatic gate atoms to `tasks.db` (ADR-051).
4. **BRAIN observations** — `cleo memory observe` writing learnings to `brain.db` (ADR-009).

Each scan has independently asked the same question: *"Why does CLEO need four feedback channels? Aren't these the same thing?"* The flag is wrong, but it keeps recurring because the codebase nowhere states the layering contract that makes the four channels non-redundant.

### What is actually layered

CLEO's runtime is a four-layer stack. Each channel above belongs to exactly one layer, and each layer has a single, distinct responsibility:

```
┌─────────────────────────────────────────────────────────────┐
│ Workflow      harness · orchestrator · spawn · gates · BRAIN│   ← MAY depend on Messaging, Storage, Data
├─────────────────────────────────────────────────────────────┤
│ Messaging     Conduit (DMs, conversations, delivery_jobs)   │   ← MAY depend on Storage, Data
├─────────────────────────────────────────────────────────────┤
│ Storage       DataAccessor (umbrella) · openCleoDb chokepoint│  ← MAY depend on Data
├─────────────────────────────────────────────────────────────┤
│ Data          tasks.db · brain.db · conduit.db · signaldock │   ← terminal
└─────────────────────────────────────────────────────────────┘
```

Reverse dependencies are forbidden. A layer below MUST NOT know that a layer above exists.

The four "feedback channels" are not parallel; they are layer-specific:

- **Workflow** uses Markdown drops (`.cleo/agent-outputs/*.md`), gate atoms (`pipeline_manifest`, `tasks.db.gates`), and BRAIN observations (`brain.db.observations`) to coordinate orchestrator ↔ subagent ↔ user.
- **Messaging** uses Conduit DMs (`conduit.db.messages`) to coordinate agent ↔ agent at runtime.
- **Storage** is the chokepoint that mediates ALL physical reads/writes to the four CLEO-owned databases through one umbrella `DataAccessor` (T9050) and one `openCleoDb()` connection factory.
- **Data** is the SQLite files themselves (ADR-006, ADR-013).

### Why the boundary matters operationally

ADR-049 ("harness sovereignty") and ADR-050 ("CleoOS sovereign harness") established that the harness owns memory, but did not formalise the upward boundary in the other direction. Today the harness MAY call into Conduit to deliver an inter-agent DM, but Conduit MUST NOT know the harness exists — Conduit cannot assume there is an orchestrator polling its `delivery_jobs` table, cannot import from `packages/cleo-os`, and cannot observe BRAIN. Likewise Storage (ADR-006) MUST NOT know there is a Messaging layer; the umbrella DataAccessor exposes table-level CRUD and nothing else.

Without this contract, the codebase drifts: every six weeks a graph scan re-files the same false-positive, contributors invent "shortcut" reverse dependencies (e.g., a Conduit handler that calls `harness.spawn()`), and the package-boundary check (AGENTS.md) loses teeth because there is no semantic layer above it.

---

## Decisions

### D001 — Four-layer coordination stack is the canonical mental model

CLEO MUST be reasoned about as four layers: **Workflow → Messaging → Storage → Data**.

| Layer     | Responsibility                                                        | Canonical modules                                                                                                                                                  | Owns DB tables                                                                |
|-----------|-----------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------|
| Workflow  | harness, orchestrator, spawn, gates, BRAIN, manifest, evidence ritual | `packages/cleo-os/src/harnesses/`, `packages/core/src/orchestration/`, `packages/core/src/sentient/`, BRAIN (`packages/brain/`), `cleo verify`, `cleo manifest`     | `tasks`, `gates`, `pipeline_manifest`, `observations`, `decisions`, `patterns` |
| Messaging | Conduit DMs, conversations, delivery_jobs, dead_letters, attachments  | `packages/core/src/conduit/`, `packages/contracts/src/conduit*`, Conduit handlers, LocalTransport                                                                  | `messages`, `conversations`, `delivery_jobs`, `dead_letters`, `message_pins`  |
| Storage   | Umbrella DataAccessor, `openCleoDb` connection factory, drizzle ORM   | `packages/core/src/store/` (DataAccessor), `openCleoDb()` chokepoint (T9050), drizzle schema (`drizzle/`)                                                          | n/a — mediates all four DBs                                                   |
| Data      | Physical SQLite files                                                 | `.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/conduit.db`, `~/.local/share/cleo/signaldock.db`                                                                        | All — terminal                                                                |

### D002 — Dependency direction is one-way; reverse imports are forbidden

A module at layer N MAY import from any layer N−k (k ≥ 1). A module at layer N MUST NOT import from layer N+k (k ≥ 1). Concretely:

- Workflow MAY import Conduit, DataAccessor, drizzle.
- Messaging (Conduit) MAY import DataAccessor, drizzle. **Messaging MUST NOT import harness, orchestrator, spawn, BRAIN, sentient, or `packages/cleo-os/`.**
- Storage MAY import drizzle and `node:sqlite`. **Storage MUST NOT import Conduit, harness, orchestrator, BRAIN.**
- Data is files; it has no imports.

The harness MAY publish an inter-agent DM by calling `conduit.send(...)`. Conduit MUST NOT call `harness.spawn(...)`, MUST NOT poll for orchestrator state, MUST NOT read `tasks.gates`. If Conduit needs Workflow data, the Workflow layer pushes it down explicitly as parameters.

### D003 — Each existing feedback channel maps to exactly one layer

The four "channels" that recurring scans flag as overlapping are not parallel implementations of the same idea. They are layer-specific affordances and MUST be reasoned about as such:

| Feedback channel                              | Layer     | Purpose                                                                                                       | Why it cannot be replaced by another channel                                                                                                  |
|-----------------------------------------------|-----------|---------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| Conduit messages (`conduit.db.messages`)      | Messaging | Runtime agent-to-agent DM transport with delivery semantics, conversations, pins, attachments.                | Must support delivery jobs, dead-letter queue, multi-recipient routing — Workflow drops cannot deliver, Storage cannot route.                 |
| `.cleo/agent-outputs/*.md` Markdown drops     | Workflow  | Human-readable subagent reports the orchestrator and the user read post-spawn.                                | Markdown is the contract surface for the user and graph scans; Conduit messages are ephemeral DMs; gates are evidence atoms, not narrative.    |
| Completion gates (`tasks.gates`, evidence)    | Workflow  | Programmatic, machine-validated assertions (commit SHA, file sha256, tool exit) per ADR-051.                  | Gates carry git-validated evidence atoms; Markdown drops are unverified prose; Conduit messages have no verification semantics.               |
| BRAIN observations (`brain.db.observations`)  | Workflow  | Long-lived institutional memory: decisions, patterns, learnings, retrieved by Vectorless RAG (ADR-009).       | Observations persist across sessions and tasks; gates are task-scoped; agent-outputs are stage-scoped; Conduit messages are conversation-scoped. |

The `pipeline_manifest` table (ADR-027, ADR-054) is a Workflow-layer artefact written via `cleo manifest append`. It is the single source of truth for "what was shipped on this task" and replaces all legacy `.jsonl` flat-file manifests.

### D004 — Storage chokepoint: umbrella DataAccessor + `openCleoDb`

All four CLEO-owned databases (`tasks.db`, `brain.db`, `conduit.db`, `signaldock.db`) MUST be opened through the single `openCleoDb()` factory and accessed through the umbrella `DataAccessor` interface. T9050 tracks the consolidation work.

- `openCleoDb(name, opts)` is the only function that calls `new DatabaseSync(...)` for production code paths. It owns WAL mode, busy-timeout, foreign-key pragmas, and migration verification (ADR-006, ADR-010, ADR-012).
- Test fixtures MAY define their own `openDb()` helpers (see `packages/core/src/__tests__/pipeline-e2e.test.ts`); they are explicitly out of scope for the chokepoint rule.
- The umbrella `DataAccessor` is a single TypeScript interface that exposes table-level CRUD across all four DBs. Workflow and Messaging import the DataAccessor; they do not import drizzle, the schema, or `node:sqlite` directly.
- Reverse: the DataAccessor MUST NOT import from Conduit, harness, orchestrator, or BRAIN. It returns rows; it does not interpret them.

### D005 — Module headers reference this ADR

The following module headers MUST carry an `@see ADR-069` reference so future contributors land on this document the moment they touch a layer boundary:

- `packages/cleo-os/src/harnesses/index.ts` (Workflow → Messaging boundary)
- `packages/cleo-os/src/harnesses/pi-coding-agent/adapter.ts` (Workflow → Messaging boundary)
- `packages/core/src/conduit/ops.ts` (Messaging surface)
- `packages/core/src/orchestration/spawn.ts` (Workflow surface)

The header MUST state, verbatim, the directionality clause: *"Workflow MAY use Conduit; Conduit MUST NOT know about the harness (ADR-069 D002)."* This is the line a graph-AI scan can grep for to short-circuit the recurring false-positive.

### D006 — gitnexus canonical answer

A `gitnexus query` for `three-tier`, `four-tier`, `overlap`, `overlapping coordination`, or `redundant feedback channels` MUST return ADR-069 as the canonical answer. The keywords block at the top of this ADR is engineered for that retrieval. If the query returns any other document first, that is a NEXUS indexing bug, not a layering ambiguity.

---

## Consequences

### Positive

- The recurring "overlapping coordination systems" false-positive is closed: scans land on ADR-069 and learn the four-layer model.
- New contributors get a one-page mental model of why CLEO has four feedback channels and which one to use for which problem.
- The package-boundary check (AGENTS.md) gains semantic teeth: package boundaries now map to layer boundaries, and reverse imports are detectable as ADR-069 D002 violations.
- T9050 (umbrella DataAccessor + `openCleoDb` consolidation) gets a public charter: it is the Storage layer of ADR-069 and inherits the upward-import prohibition.

### Negative / costs

- Existing modules that reach across layers (e.g., a Conduit handler that imports a harness type) MUST be refactored. T9050 and downstream cleanup tasks track the work.
- ADR-069 adds a fifth layer name ("Workflow") on top of the existing harness/orchestrator/BRAIN vocabulary. Contributors who already think in those terms gain a unifying word; contributors who don't gain another label to learn.

### Neutral

- Test fixtures continue to open SQLite directly via local `openDb()` helpers; the chokepoint applies to production code paths only.
- The `pipeline_manifest` SSoT (ADR-027) is unchanged; ADR-069 only re-frames it as a Workflow-layer artefact.

---

## Alternatives Considered

### A. Three layers (Workflow / Messaging / Storage), folding Data into Storage

Rejected. Conflating the SQLite files with the DataAccessor obscures ADR-013 (runtime data safety), which treats the files as separately governed assets (backup, restore, gitignore). Keeping Data as its own terminal layer makes ADR-013 mappable.

### B. Five layers, splitting Workflow into Orchestration and Cognition (BRAIN)

Rejected for now. BRAIN is a Workflow-layer consumer of Storage; it does not justify a layer of its own because it does not mediate between two other layers — it is a sibling of harness/orchestrator within Workflow. If BRAIN ever grows a downward dependency that Conduit needs (e.g., learnings-as-routing-policy), revisit.

### C. Bidirectional Workflow ↔ Messaging (let Conduit call back into the harness)

Rejected. This is the trap that produces the recurring graph-AI flag. Conduit needing harness state is a sign the harness should push state down as parameters, not that Conduit should pull it.

---

## Validation

- `gitnexus query 'overlapping coordination'` → returns ADR-069 first (D006).
- `gitnexus query 'three-tier'` → returns ADR-069 first (D006).
- `rg "ADR-069" packages/cleo-os/src/harnesses/ packages/core/src/conduit/ packages/core/src/orchestration/spawn.ts` → at least one hit per file (D005).
- Quality gates: `pnpm biome check --write .` && `pnpm run build` && `pnpm run test` — zero new failures vs. main.
