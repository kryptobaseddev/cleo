# CLEO Autonomous Runtime Specification

**Version**: 2026.3.6
**Status**: ACTIVE
**Date**: 2026-03-06
**Task**: T5519

---

## 1. Purpose

This specification defines CLEO's autonomous runtime as a canon-aligned execution layer built on top of the existing four systems, ten canonical domains, and two MCP gateways.

It gives implementation meaning to the live workshop terms:

- The Hearth
- The Circle of Ten
- The Impulse
- Conduit
- Watchers
- The Sweep
- Refinery
- Looming Engine
- Living BRAIN
- The Proving

This document is normative for terminology, mapping, and architectural constraints. It does not create new runtime domains.

---

## 2. Canonical Constraints

The autonomous runtime MUST obey the following constraints:

1. CLEO keeps exactly 10 canonical domains: `tasks`, `session`, `memory`, `check`, `pipeline`, `orchestrate`, `tools`, `admin`, `nexus`, `sticky`.
2. The autonomous runtime introduces no additional domains, transports, or private protocols.
3. Conduit MUST use LAFS envelopes and A2A delegation only.
4. `sticky` MUST remain provisional capture and MUST NOT become the live agent-to-agent broker, inbox, or outbox.
5. Watchers MUST be implemented as long-running Cascades through existing `pipeline`, `orchestrate`, `check`, and `admin` behavior, not as a separate daemon domain.
6. All autonomous work MUST remain governed by Warp chains and lifecycle gates.
7. Tessera-driven decomposition remains the canonical way to generate repeatable work patterns.
8. The autonomous runtime is layered on the existing hook substrate; it does not replace the dispatch-first shared core.
9. `sticky` remains the stable protocol slug for provisional capture. The Catchers are the Circle of Ten house for that domain, and Conduit owns live relay.

---

## 3. Runtime Foundation

The autonomous runtime is composed of three foundational services and a set of higher-order runtime forms. These forms are not all the same kind of thing, and the canon stays coherent only if their types remain explicit.

### 3.1 Foundational Services

| Component | Task | Purpose |
|-----------|------|---------|
| Agent-Runtime Core | `T5573` | Source of truth for worker lifecycle, leases, identity, and event emission |
| The Impulse Engine | `T5574` | Self-propelling work pickup and execution triggering |
| Watchers Engine | `T5575` | Scheduled patrols, health monitoring, retry pressure, and continuity checks |

### 3.2 Canonical Runtime Forms

| Form | Runtime Type | Primary Task | Purpose |
|------|--------------|--------------|---------|
| The Hearth | surface | `T5520` | Terminal-facing workshop surface for observing and interacting with live runtime state |
| The Circle of Ten | role overlay | `T5521` | Persistent aspect model mapped to the ten canonical domains |
| The Impulse | motion | `T5522`, `T5574` | Self-propelling work pickup and governed execution triggering |
| Conduit | relay path | `T5524` | Agent relay path using LAFS and A2A only |
| Watchers | patrols | `T5523`, `T5575` | Long-running Cascade patrols for health, continuity, and retry pressure |
| The Sweep | quality loop | `T5525` | Quality patrol loop expressed as governed Cascade motion |
| Refinery | convergence gate | `T5526` | Convergence gate for integration, validation, and merge flow |
| Looming Engine | decomposition service | `T5528` | Tessera-driven decomposition into Looms, Threads, and execution paths |
| Living BRAIN | memory overlay | `T5527` | Memory in active circulation with reinforcement, contradiction, and retrieval loops |
| The Proving | validation ground | `T5529` | End-to-end validation of the autonomous runtime under load and failure |

---

## 4. Canon Mapping

| Canon Term | Runtime Type | Runtime Meaning | Primary Domains | Hook/Event Focus | Primary Tasks |
|------------|--------------|-----------------|-----------------|------------------|---------------|
| **The Hearth** | surface | Terminal-facing workshop surface and operator viewport | `session`, `orchestrate`, `tools` | `onAgentSpawn`, `onAgentComplete` | `T5520` |
| **The Circle of Ten** | role overlay | Persistent aspect overlay mapped 1:1 to the canonical domains | all 10 domains | runtime role assignment | `T5521` |
| **The Impulse** | motion | Self-propelling motion that advances ready work | `orchestrate`, `pipeline`, `tasks` | `onWorkAvailable`, `onCascadeStart` | `T5522`, `T5574` |
| **Conduit** | relay path | LAFS/A2A relay path between workers, sessions, and runtime surfaces | `orchestrate`, `session`, `nexus` | `onAgentSpawn`, `onAgentComplete` | `T5524` |
| **Watchers** | patrols | Long-running Cascades that patrol health, continuity, and gate state | `pipeline`, `orchestrate`, `check`, `admin` | `onPatrol` | `T5523`, `T5575` |
| **The Sweep** | quality loop | Quality patrol loop: review, repair, re-check, and escalation | `check`, `pipeline`, `orchestrate` | `onPatrol`, `onCascadeStart` | `T5525` |
| **Refinery** | convergence gate | Convergence gate for integration and merge readiness | `pipeline`, `check`, `orchestrate` | `onCascadeStart`, `onAgentComplete` | `T5526` |
| **Looming Engine** | decomposition service | Tessera-driven decomposition from intent into work structure | `pipeline`, `tasks`, `orchestrate`, `tools` | `onWorkAvailable` | `T5528` |
| **Living BRAIN** | memory overlay | Active memory circulation, reinforcement, contradiction, and recall | `memory`, `session`, `nexus` | `onAgentComplete`, `onPatrol` | `T5527` |
| **The Proving** | validation ground | End-to-end runtime validation, resilience, and evidence of correctness | `check`, `pipeline` | all CLEO-local runtime events | `T5529` |

---

## 5. The Circle of Ten

The Circle of Ten is a role overlay, not a new namespace. Each aspect maps directly to an existing canonical domain:

| Aspect | Canonical Domain | Duty |
|--------|------------------|------|
| The Smiths | `tasks` | Forge Threads, task relationships, and actionable units of work |
| The Weavers | `pipeline` | Mount Looms, shape Tapestries, and govern Cascade progression |
| The Conductors | `orchestrate` | Assign motion, route work, and coordinate parallel execution |
| The Artificers | `tools` | Supply Cogs, Clicks, providers, and tool-facing capabilities |
| The Archivists | `memory` | Tend observations, patterns, decisions, and durable recall |
| The Scribes | `session` | Hold the immediate present, handoffs, and working context |
| The Wardens | `check` | Judge whether work may pass gates, tests, and validations |
| The Wayfinders | `nexus` | Govern the star road, cross-project lookup, and `nexus.share.*` relay |
| The Catchers | `sticky` | Carry quick captures, draft handoffs, and promotable notes |
| The Keepers | `admin` | Maintain health, backup, sequencing, and runtime continuity |

`sticky` is the house of the Catchers. It is a provisional shelf, not the live A2A lane. Cross-project sharing remains under `nexus.share.*` and belongs to the Wayfinders.

---

## 6. Hook Substrate

CLEO's autonomous runtime uses the existing internal coordination events:

| Hook | Purpose | Primary Consumers |
|------|---------|-------------------|
| `onWorkAvailable` | Signals that ready work exists and may be advanced | The Impulse, Looming Engine |
| `onAgentSpawn` | Signals worker creation and identity assignment | The Hearth, Conduit, Living BRAIN |
| `onAgentComplete` | Signals worker completion and result capture | Conduit, Living BRAIN, Refinery, The Proving |
| `onCascadeStart` | Signals governed runtime motion through a chain | The Impulse, The Sweep, Refinery |
| `onPatrol` | Signals scheduled patrol work | Watchers, The Sweep, Living BRAIN |

These are CLEO-local events. They are not provider-capability events and MUST NOT be exposed as CAAMP provider hooks.

---

## 7. Runtime Flow

The autonomous runtime follows this high-level motion:

1. Intent is captured directly as a Sticky Note, Thread, or structured instruction.
2. Looming Engine turns reusable Tesserae and direct intent into Looms, Threads, dependencies, and Warp-bound execution paths.
3. `onWorkAvailable` fires when governed work becomes ready.
4. The Impulse selects ready work and asks Agent-Runtime Core to allocate workers.
5. Agent-Runtime Core emits `onAgentSpawn`, manages leases, and binds workers to Circle of Ten aspects.
6. Conduit relays tasking, handoff, and completion messages using LAFS/A2A only. `sticky` may receive explicit drafts or promoted summaries, but it is never the live relay lane.
7. Watchers patrol leases, gate health, retries, continuity, and backlog pressure through `onPatrol`.
8. The Sweep performs review-fix-review quality loops.
9. Refinery acts as the convergence gate for integration-ready work.
10. Living BRAIN records outcomes, contradictions, reinforcement, and retrieval cues.
11. The Proving validates system behavior under realistic load, failure, and recovery conditions.

---

## 8. Relationship to T5158 and T5159

`T5158` and `T5159` are part of the older BRAIN vector-search track:

| Task | Canonical Meaning |
|------|-------------------|
| `T5158` | Embedding generation pipeline for BRAIN content |
| `T5159` | Vector similarity retrieval on top of generated embeddings |

They are **not** the autonomous runtime epic.

They remain relevant because Living BRAIN can use the embedding and vector-retrieval substrate, but the autonomous runtime epic is `T5519` with supporting foundation work in `T5573`, `T5574`, and `T5575`.

---

## 9. Implementation Order

The implementation order for the autonomous runtime SHOULD follow dependency layers rather than a flat poetic list:

### 9.1 Foundation Layer

| Layer | Tasks | Meaning |
|-------|-------|---------|
| Foundation | `T5573` | Agent-Runtime Core as the source of truth for worker lifecycle, leases, identity, and event emission |

### 9.2 Layer 1

| Layer | Tasks | Meaning |
|-------|-------|---------|
| Layer 1 | `T5574`, `T5575`, `T5521`, `T5524` | Motion engine, patrol engine, role overlay, and relay path on top of Agent-Runtime Core |

### 9.3 Layer 2

| Layer | Tasks | Meaning |
|-------|-------|---------|
| Layer 2 | `T5520`, `T5525`, `T5526` | Operator surface, quality loop, and convergence gate built on the runtime substrate |

### 9.4 Layer 3

| Layer | Tasks | Meaning |
|-------|-------|---------|
| Layer 3 | `T5527`, `T5528` | Active memory circulation and Tessera-driven decomposition built on the runtime substrate |

### 9.5 Final Layer

| Layer | Tasks | Meaning |
|-------|-------|---------|
| Final | `T5529` | End-to-end proving of the entire runtime under concurrency, failure, and recovery |

### 9.6 Infrastructure Substrate Already Present

| Task | Meaning |
|------|---------|
| `T5522` | The Impulse hook substrate is present; `T5574` is the engine implementation that makes the motion real |
| `T5523` | The Watchers hook substrate is present; `T5575` is the engine implementation that makes patrols real |

This dependency layering preserves the runtime foundation before operator surface work and keeps concept-level names separate from engine-level implementation tasks.

---

## 10. Non-Goals

The autonomous runtime does not:

- create an eleventh domain
- replace dispatch, shared core, or MCP gateways
- replace LAFS with a private message protocol
- redefine `nexus.share.*` as `sticky`
- treat The Hearth as the source of truth
- collapse BRAIN vector work (`T5158`/`T5159`) into the runtime epic

---

## 11. References

- `docs/concepts/CLEO-VISION.md`
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md`
- `docs/concepts/NEXUS-CORE-ASPECTS.md`
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
- `docs/specs/CAAMP-INTEGRATION-SPEC.md`
- `docs/specs/CLEO-AUTONOMOUS-RUNTIME-IMPLEMENTATION-MAP.md`
- `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md`
