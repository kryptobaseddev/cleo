# CLEO Autonomous Runtime Implementation Map

**Version**: 2026.3.6
**Status**: ACTIVE
**Date**: 2026-03-06
**Task**: T5519

---

## 1. Purpose

This document maps the autonomous runtime to concrete TypeScript and Rust ownership boundaries.

It exists so the runtime does not collapse into an incoherent hybrid where:

- Rust re-implements CLEO's domain semantics
- TypeScript becomes an unreliable process supervisor
- `sticky` gets mistaken for the live agent-to-agent message lane

This document is the implementation companion to:

- `docs/concepts/NEXUS-CORE-ASPECTS.md`
- `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md`

---

## 2. Boundary Rules

The split between TypeScript and Rust MUST remain clear:

1. **TypeScript owns canonical CLEO semantics**.
   This includes the ten domains, task/session/memory behavior, Warp chains, Tessera instantiation, lifecycle gates, CAAMP provider resolution, LAFS envelope shaping and validation, and all policy that depends on CLEO's source-of-truth data.

2. **Rust owns long-running runtime mechanics**.
   This includes worker lifecycle, leases, process supervision, terminal multiplexer integration, local socket IPC, patrol scheduling, filesystem/process watches, and durable runtime delivery mechanics.

3. **Rust MUST NOT become a shadow orchestrate domain**.
   It may supervise execution, but it must not redefine task readiness, lifecycle policy, or domain rules that already belong to CLEO.

4. **TypeScript MUST NOT become the process supervisor**.
   It may decide what should happen, but it should not be responsible for keeping workers, panes, or patrol loops alive.

5. **Conduit is the live A2A relay path**.
   `sticky` remains human and provisional capture. `sticky` MAY hold drafts or promoted handoff bundles, but it MUST NOT become the live broker, inbox, or outbox for runtime messaging.

6. **IPC MUST use LAFS-shaped envelopes**.
   The Rust runtime and the TypeScript layer may use a local runtime socket, but the payload contract should remain structured, versioned, and compatible with CLEO's existing envelope discipline.

---

## 3. Foundation Services

| Service | Tasks | TypeScript Owns | Rust Owns | IPC Boundary |
|---------|-------|-----------------|-----------|--------------|
| Agent-Runtime Core | `T5573` | Worker identity schema, role metadata, provider resolution through CAAMP, spawn validation, task/session/memory side effects | Worker registry, leases, process start/stop/recycle, terminal session binding, keepalive state, runtime snapshot server | TS issues spawn/stop/recycle and snapshot requests; Rust emits worker lifecycle and lease telemetry |
| The Impulse Engine | `T5574` | Ready-work selection, priority policy, concurrency rules, Warp/Tessera instantiation, escalation policy | Runtime clocking, wakeups, occupancy tracking, backpressure, dispatch execution triggers | Rust emits work-available and backpressure events; TS returns dispatch decisions or defer instructions |
| Watchers Engine | `T5575` | Interpretation of patrol findings into check/pipeline/admin/memory actions, retry policy, memory follow-up | Patrol loops, heartbeat/inotify/process watches, crash detection, restart backoff, health aggregation | Rust emits patrol findings and health events; TS returns consequences, mutations, or follow-up plans |

---

## 4. Runtime Forms

| Runtime Form | Type | Primary Tasks | TypeScript Owns | Rust Owns | IPC Boundary |
|--------------|------|---------------|-----------------|-----------|--------------|
| The Hearth | surface | `T5520` | Operator-facing views, role/session/task presentation, CLI/Web/TUI composition, filters, command intent | Pane creation/capture/control when terminal-backed, session attachment metadata | TS queries runtime snapshots and issues surface commands; Rust streams worker and pane state |
| The Circle of Ten | role overlay | `T5521` | Role definitions, domain mapping, capability envelopes, policy for what each aspect may do | Binding runtime workers to aspect tags, carrying role metadata in leases and runtime snapshots | TS sends role metadata and policies; Rust exposes role occupancy and lease state |
| The Impulse | motion | `T5522`, `T5574` | What work is ready, what path it should take, what policy governs selection | When the motion is triggered, how wakeups/backpressure are enforced in the runtime | Rust emits motion triggers; TS answers with dispatch plans |
| Conduit | relay path | `T5524` | Envelope schema, addressing rules, authorization/policy, query/mutate surfaces for inspection | Live message broker, delivery queue, acknowledgements, retries, durable runtime relay state, terminal/session delivery | TS publishes and inspects envelopes; Rust handles delivery, ack state, retry, and event streaming |
| Watchers | patrols | `T5523`, `T5575` | Patrol meaning, escalation logic, downstream mutations, memory follow-up | Continuous patrol execution, health watches, liveness checks, schedule loops | Rust emits patrol telemetry; TS decides resulting actions |
| The Sweep | quality loop | `T5525` | Sweep templates, review-fix-review logic, check/task/pipeline interactions, evidence writing | Scheduling trigger support via Watchers and runtime progress telemetry | Watchers trigger sweep execution; TS runs the governed loop and reports status |
| Refinery | convergence gate | `T5526` | Merge-readiness policy, gate logic, chain advancement, evidence collection | Repository/worktree primitives and runtime telemetry when native git/runtime support is used | TS requests integration facts/actions; Rust returns repo/runtime state and execution results |
| Looming Engine | decomposition service | `T5528` | Tessera templates, decomposition algorithms, Loom/Thread creation, route planning | Capacity and occupancy signals that constrain decomposition/execution planning | TS turns intent into work plans; Rust returns runtime capacity and spawn outcomes |
| Living BRAIN | memory overlay | `T5527` | Reinforcement, contradiction, retrieval, consolidation, memory writes and reasoning | Runtime telemetry source: worker outcomes, patrol events, relay evidence, liveness context | Rust emits runtime observations; TS persists and interprets them in BRAIN |
| The Proving | validation ground | `T5529` | End-to-end assertions, scenario definitions, evidence collation, pass/fail judgment | Fault injection, runtime stress harness, process/mux failure simulation | TS drives scenarios and evaluates evidence; Rust executes runtime stress conditions and returns traces |

---

## 5. Conduit and Sticky

`sticky` and Conduit serve different purposes and MUST remain separate:

| Concern | Conduit | sticky |
|---------|---------|--------|
| Live agent-to-agent delivery | Yes | No |
| Human quick capture | No | Yes |
| Durable delivery state | Yes | No |
| Draft handoff bundle after explicit promotion | Optional | Yes |
| Runtime inbox/outbox model | Yes | No |
| Scratch-pad note before classification | No | Yes |

The canonical rule is simple:

- **Conduit carries live A2A traffic**
- **sticky holds provisional capture**

The Catchers steward the provisional edge of the realm, but they do not replace Conduit as the message lane.

### 5.1 Minimum Conduit Tooling

`T5524` should deliver, at minimum:

1. envelope validation and versioning through LAFS-shaped payloads
2. address resolution for worker, session, task/thread, and optional cross-project routing
3. acknowledgement and retry state
4. durable runtime relay history for crash recovery
5. inspection surfaces for inbox, outbox, and failed delivery state
6. explicit separation between live delivery and promoted handoff artifacts

See `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` for the normative delivery contract.

### 5.2 Sticky Restrictions

`sticky` MUST NOT be used as:

- the live message broker
- the authoritative inbox for workers
- the retry queue for failed deliveries
- the transport for runtime signalling

`sticky` MAY be used for:

- operator-authored quick capture
- draft handoff packets awaiting formal binding
- promoted message summaries worth retaining as notes or memory

---

## 6. Epic Mapping

| Task | Runtime Role in T5519 | Ownership Emphasis |
|------|------------------------|--------------------|
| `T5573` | Foundation service | Rust-primary runtime control; TS-primary semantics and policy |
| `T5574` | Motion engine | TS policy + Rust execution clock |
| `T5575` | Patrol engine | Rust patrol execution + TS consequence handling |
| `T5520` | Surface | TS-primary operator experience; Rust supports pane/session mechanics |
| `T5521` | Role overlay | TS-primary canon and permissions; Rust carries runtime tags |
| `T5522` | Motion substrate | Hook/events substrate already in place |
| `T5523` | Patrol substrate | Hook/events substrate already in place |
| `T5524` | A2A relay path | Shared split: TS schema/policy, Rust broker/delivery |
| `T5525` | Quality loop | TS-primary governed execution |
| `T5526` | Convergence gate | TS-primary policy with optional Rust repo/runtime primitives |
| `T5527` | Memory overlay | TS-primary BRAIN logic with Rust telemetry feed |
| `T5528` | Decomposition service | TS-primary Tessera/Warp logic with Rust capacity input |
| `T5529` | Validation ground | Shared split: TS assertions/evidence, Rust stress/fault runtime |

---

## 7. Non-Goals

This map does not:

- create an eleventh domain
- move canonical task/session/memory logic into Rust
- turn `sticky` into a runtime mail system
- require Rust ownership for every terminal-facing capability
- require TypeScript ownership for every operator-facing capability

It only defines the clean line between **runtime mechanics** and **CLEO semantics**.

---

## 8. References

- `docs/concepts/NEXUS-CORE-ASPECTS.md`
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md`
- `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md`
