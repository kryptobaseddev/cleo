# T5671 Orchestration Spec Gap Analysis

**Date**: 2026-03-08
**Agent**: spec-writer
**Task**: T5671 Phase 3, Task #4 (post-completion analysis)

---

## 1. Summary

The current `docs/specs/CLEO-MULTI-TIER-AGENT-ORCHESTRATION-SPEC.md` is a practical playbook for the T5671 pattern -- spawning Claude Code agents via the Task/Agent/SendMessage tools. It documents something real and useful. But it is disconnected from the canonical systems defined in the Autonomous Runtime Spec, Conduit Protocol Spec, Implementation Map, and NEXUS Core Aspects.

The current spec is a **Phase 0 document** -- it captures how orchestration worked in the T5671 era using only the tools available at the time (Claude Code's Agent SDK). The canonical systems describe **Phase 1+** -- where CLEO itself provides the orchestration runtime, not the provider's agent framework.

---

## 2. What the Current Spec Describes

- A three-tier hierarchy using Claude Code's Agent SDK tools (TaskCreate, SendMessage, etc.)
- Wave-based execution via topological sort in `waves.ts`
- Context protection via file-based communication in `.cleo/agent-outputs/`
- Communication via SendMessage (a Claude Code SDK primitive, not a CLEO primitive)

---

## 3. Canon Systems the Spec Ignores

### 3.1 Conduit (T5524)

**Canon says**: Conduit is the canonical A2A relay path. It carries live agent-to-agent traffic with LAFS-shaped envelopes, durable delivery state, leases, acknowledgement, and retry. Conduit has a delivery state machine (queued -> leased -> delivered -> acknowledged -> settled), retry policy, dead-letter handling, and crash recovery. See `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md`.

**Current spec does**: Uses `SendMessage` (a provider-specific Claude Code SDK tool) as if it were the communication system. No mention of Conduit, LAFS envelopes, message delivery guarantees, retries, or durable relay state.

**Gap**: The spec treats provider-specific tooling as canonical. Conduit should be the target communication layer, with SendMessage documented as the Phase 0 provider-specific adapter.

### 3.2 The Circle of Ten (T5521)

**Canon says**: The Circle of Ten is a role overlay mapped 1:1 to the canonical domains. Workers bind to aspects (Smiths for tasks, Weavers for pipeline, Conductors for orchestrate, Artificers for tools, Archivists for memory, Scribes for session, Wardens for check, Wayfinders for nexus, Catchers for sticky, Keepers for admin) with role metadata, capability envelopes, and lease-managed lifecycle. See `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md` Section 5.

**Current spec does**: Treats "Team Leads" as ad-hoc agent roles ("routing-lead", "session-lead", "spec-writer") with no formal role binding, no capability envelopes, and no lease management.

**Gap**: Team Leads should map to Circle of Ten aspects. A "tasks-lead" is a worker bound to the Smiths aspect. A "pipeline-lead" is a worker bound to the Weavers aspect.

### 3.3 Agent-Runtime Core (T5573)

**Canon says**: Source of truth for worker lifecycle, leases, identity, and event emission. Rust owns the worker registry, leases, process start/stop/recycle, keepalive state, and runtime snapshot server. TypeScript owns worker identity schema, role metadata, provider resolution through CAAMP, spawn validation, and task/session/memory side effects. See `docs/specs/CLEO-AUTONOMOUS-RUNTIME-IMPLEMENTATION-MAP.md` Section 3.

**Current spec does**: No concept of worker identity, leases, or lifecycle management. Agents are spawned and the Orchestrator hopes they finish. No keepalive, no crash detection, no lease expiry.

**Gap**: Worker lifecycle needs formal management. The spec should define how workers are registered, leased, monitored, and recycled.

### 3.4 The Impulse Engine (T5574)

**Canon says**: Self-propelling work pickup and governed execution triggering. `onWorkAvailable` fires when governed work becomes ready. The Impulse selects ready work and asks Agent-Runtime Core to allocate workers. TypeScript owns ready-work selection, priority policy, concurrency rules, Warp/Tessera instantiation. Rust owns runtime clocking, wakeups, occupancy tracking, backpressure. See `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md` Section 7, steps 3-4.

**Current spec does**: The Orchestrator manually checks TaskList, determines which tasks are ready, and manually spawns agents. No event-driven work pickup, no priority policy, no backpressure.

**Gap**: Wave transitions should be driven by the Impulse Engine's `onWorkAvailable` events rather than manual Orchestrator polling.

### 3.5 Watchers Engine (T5575)

**Canon says**: Scheduled patrols, health monitoring, retry pressure, and continuity checks. Long-running Cascades through existing pipeline, orchestrate, check, and admin behavior. Rust owns patrol loops, heartbeat/inotify/process watches, crash detection, restart backoff, health aggregation. TypeScript owns interpretation of patrol findings into check/pipeline/admin/memory actions, retry policy, memory follow-up. See `docs/specs/CLEO-AUTONOMOUS-RUNTIME-IMPLEMENTATION-MAP.md` Section 3.

**Current spec does**: No health monitoring. If an agent dies, stalls, or runs out of context, nothing detects it. No retry pressure, no continuity checks.

**Gap**: The spec needs a health monitoring layer. Watchers should patrol agent leases, detect stalled workers, trigger retry or escalation, and maintain runtime continuity.

### 3.6 The Looming Engine (T5528)

**Canon says**: Tessera-driven decomposition into Looms, Threads, and execution paths. TypeScript owns Tessera templates, decomposition algorithms, Loom/Thread creation, route planning. Rust owns capacity and occupancy signals that constrain decomposition/execution planning. See `docs/specs/CLEO-AUTONOMOUS-RUNTIME-IMPLEMENTATION-MAP.md` Section 4.

**Current spec does**: The Orchestrator manually decomposes work into tasks via TaskCreate. No reusable patterns, no Tessera templates, no governed decomposition.

**Gap**: Task decomposition should be driven by Tessera pattern cards -- reusable composition patterns that can generate Tapestries (coordinated multi-Loom work) from fresh inputs. The "10-domain gauntlet" is itself a natural Tessera: it could be stamped out for any future audit run.

### 3.7 Refinery (T5526)

**Canon says**: Convergence gate for integration, validation, and merge flow. TypeScript owns merge-readiness policy, gate logic, chain advancement, evidence collection. See `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md` Section 3.2.

**Current spec does**: No merge-readiness concept. Wave transitions happen when all tasks complete, but there is no formal convergence gate that validates integration readiness.

**Gap**: Between waves, the Refinery should validate that the combined output of parallel agents is coherent and merge-ready before advancing.

### 3.8 The Sweep (T5525)

**Canon says**: Quality patrol loop expressed as governed Cascade motion. The repeated review-fix-review motion that keeps defects and regressions from taking root. See `docs/concepts/NEXUS-CORE-ASPECTS.md`.

**Current spec does**: One-shot validation wave (Wave B in T5671). No continuous quality verification, no review-fix-review loops.

**Gap**: The Sweep should run as a continuous quality patrol alongside wave execution, not just a one-time validation pass.

### 3.9 TypeScript/Rust Boundary

**Canon says**: TypeScript owns CLEO semantics (task readiness, lifecycle policy, domain rules). Rust owns runtime mechanics (worker supervision, leases, process management, patrol loops, terminal multiplexer integration). The split is mandatory. See `docs/specs/CLEO-AUTONOMOUS-RUNTIME-IMPLEMENTATION-MAP.md` Section 2.

**Current spec does**: Entirely TypeScript/agent-SDK-level. No Rust runtime layer. No process supervision, no terminal session binding, no local socket IPC.

**Gap**: The modernized spec needs to define what TypeScript decides (what work, what policy, what routing) vs what Rust executes (worker supervision, lease management, patrol loops, crash recovery).

### 3.10 NEXUS Cross-Project Orchestration

**Canon says**: The Wayfinders govern the star road. `nexus.share.*` operations provide cross-project relay. Cross-project delivery through Conduit is mediated by `nexus.share.*` and Wayfinder policy. See `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` Section 6.3.

**Current spec does**: Operates entirely within a single project. No concept of cross-project work coordination.

**Gap**: A modernized spec should define how orchestration spans project boundaries -- how a Tessera in project-a can spawn work in project-b via NEXUS relay.

---

## 4. Proposed Modernized Spec Structure

A unified spec that bridges the current practical reality (Phase 0) with the canonical target state (Phase 1+):

### Section 1: Overview

Why multi-tier orchestration exists. Same motivation (context protection, parallelism, specialization) but positioned within the canon.

### Section 2: Terminology

Merged terminology: canonical workshop vocabulary (Thread, Loom, Tapestry, Tessera, Cascade, Warp) alongside practical terms (Orchestrator, Team Lead, Wave).

### Section 3: Three-Tier Architecture Mapped to Circle of Ten

- Tier 0: Orchestrator = The Conductors (orchestrate aspect)
- Tier 1: Team Leads = Workers bound to Circle of Ten aspects (Smiths, Weavers, Wardens, etc.)
- Tier 2: Subagents = Scoped workers under a Team Lead's aspect lease

### Section 4: Wave-Based Execution via The Impulse

- `computeWaves()` provides the dependency graph (existing)
- The Impulse Engine triggers `onWorkAvailable` when waves unlock (target)
- Agent-Runtime Core allocates workers with leases (target)
- Phase 0 adapter: Orchestrator polls TaskList and spawns manually (current reality)

### Section 5: Communication via Conduit

- Conduit is the canonical A2A relay path with LAFS envelopes
- Message types: tasking, handoff, status, result, attention, patrol
- Delivery state machine: queued -> leased -> delivered -> acknowledged -> settled
- Phase 0 adapter: SendMessage (Claude Code SDK) for current provider

### Section 6: Worker Lifecycle via Agent-Runtime Core

- Worker identity, registration, lease management
- Process supervision and crash detection (Rust-owned)
- Spawn validation and role binding (TypeScript-owned)
- Phase 0: no lifecycle management (spawn and hope)

### Section 7: Health Monitoring via Watchers

- Patrol loops for lease expiry, stalled workers, gate health
- Retry pressure and escalation policy
- Phase 0: no health monitoring

### Section 8: Decomposition via Looming Engine

- Tessera-driven decomposition from reusable pattern cards
- Looms (epic frames) containing Threads (tasks) under Warp (quality gates)
- Phase 0: manual task creation by Orchestrator

### Section 9: Quality via The Sweep and Refinery

- The Sweep: continuous review-fix-review quality loops
- Refinery: convergence gates between waves for integration validation
- Phase 0: one-shot validation wave

### Section 10: Context Protection Rules

- Same as current spec but integrated with lease-managed lifecycle
- Handoff via Conduit rather than file-based ad-hoc communication

### Section 11: Cross-Project Orchestration via NEXUS

- Wayfinder-mediated cross-project relay
- `nexus.share.*` for patterns and work coordination across project boundaries

### Section 12: TypeScript/Rust Boundary

- What TypeScript decides (policy, semantics, domain logic)
- What Rust executes (supervision, leases, patrols, delivery)

### Section 13: T5671 Case Study (Phase 0 Validation)

- Preserved as-is from current spec
- Labeled as "Phase 0: Provider-SDK orchestration before the canonical runtime existed"

### Section 14: Implementation Phases

- Phase 0: Current reality (Claude Code Agent SDK, SendMessage, manual polling)
- Phase 1: Agent-Runtime Core + Conduit (worker lifecycle, LAFS relay)
- Phase 2: Impulse + Watchers (event-driven work pickup, health monitoring)
- Phase 3: Looming Engine + Refinery + Sweep (Tessera decomposition, convergence gates, quality loops)
- Phase 4: NEXUS orchestration (cross-project coordination)

### Section 15: Integration Points and References

- All canon docs referenced with bidirectional links

---

## 5. Key Design Principle

The modernized spec MUST NOT create new domains, transports, or private protocols. It maps orchestration behavior onto the existing 10 canonical domains, the existing hook substrate, and the existing LAFS envelope discipline. This is canon constraint #2 from the Autonomous Runtime Spec.

---

## 6. SignalDock-core Canon Mapping

Based on signaldock-lead's research report (`.cleo/agent-outputs/T5671-signaldock-research-report.md`), SignalDock-core provides concrete implementation substrate for several canon gaps. SignalDock is a Rust library with a clean layered architecture: `protocol -> storage -> transport -> sdk -> api`.

### 6.1 Mapping Table

| Canon Gap | Canon Requirement | SignalDock Capability | Fit |
|-----------|-------------------|----------------------|-----|
| **Conduit** (3.1) | LAFS-shaped A2A relay with delivery state machine, leases, retry, dead-letter | Message delivery with priority transport chain (SSE > Webhook > WS > HTTP/2 > Polling), `MessageStatus` (sent/delivered/read), `RetryPolicy` (6 attempts, exponential backoff), `DeliveryEvent` tracking | HIGH -- near-direct mapping. SignalDock's `DeliveryChain` is structurally equivalent to Conduit's delivery state machine. Envelopes would need LAFS shaping. |
| **Agent-Runtime Core** (3.3) | Worker identity, leases, lifecycle, crash detection | Agent registration with unique IDs, `AgentClass` (code_dev, research, utility_bot), `AgentStatus`, heartbeat tracking, `PrivacyTier` | MEDIUM -- identity and registration are strong. Lease management and process supervision are not SignalDock's scope (it's a messaging layer, not a process supervisor). |
| **The Impulse Engine** (3.4) | Event-driven `onWorkAvailable` work pickup | SSE push-based delivery enables reactive wave transitions. Team Leads post completion events; Orchestrator receives via SSE stream without polling. | MEDIUM -- solves the polling problem for wave coordination, but does not implement ready-work selection policy or Warp/Tessera instantiation (TypeScript-owned). |
| **Watchers Engine** (3.5) | Health patrols, crash detection, restart backoff | Heartbeat tracking on agents, `RetryPolicy` with backoff. No native patrol loop scheduling or process-level crash detection. | LOW-MEDIUM -- heartbeat is useful but patrol loops and process supervision are Rust-runtime concerns beyond SignalDock's scope. |
| **Circle of Ten** (3.2) | Role overlay mapped to domains with capability envelopes | `AgentClass` enum + `AgentCard` metadata. Privacy tiers for visibility control. | MEDIUM -- agent classes could map to Circle of Ten aspects. Would need extension for CLEO-specific role metadata and capability envelopes. |
| **NEXUS Cross-Project** (3.10) | Cross-project relay via `nexus.share.*` | Inherently multi-agent -- any registered agent can message any other regardless of project. Global agent registry. | HIGH -- SignalDock's cross-agent messaging could serve as the transport layer for NEXUS relay, with Wayfinder policy applied at the CLEO TypeScript layer. |
| **IPC Boundary** (3.9) | Local socket between TS semantics and Rust runtime | SignalDock runs as HTTP server (Axum). Phase 1: HTTP client. Phase 2: napi-rs native bindings (stubbed, not yet implemented) for in-process calls. | MEDIUM -- HTTP works for Phase 1. Native bindings would eliminate network overhead but are not yet built. |

### 6.2 What SignalDock Does NOT Cover

SignalDock is a messaging infrastructure layer. It does not provide:

- **Process supervision** (starting/stopping/recycling worker processes) -- Agent-Runtime Core Rust-side concern
- **Terminal multiplexer integration** -- Hearth/runtime concern
- **Tessera decomposition** -- Looming Engine is TypeScript-owned business logic
- **Quality gate evaluation** -- Sweep/Refinery are CLEO check/pipeline domain logic
- **Lifecycle policy** -- Warp chains, RCASD gates, lifecycle enforcement remain TypeScript-owned

### 6.3 Recommended Integration Phases

| Phase | What | SignalDock Role | CLEO Work |
|-------|------|-----------------|-----------|
| Phase 0 (current) | Provider-SDK orchestration | None | SendMessage (Claude Code) |
| Phase 1 | Provider-neutral messaging | HTTP API client to SignalDock server (sidecar) | `src/core/signaldock/client.ts`, `AgentTransport` interface abstracting SendMessage vs SignalDock |
| Phase 2 | In-process messaging | napi-rs native bindings (SignalDock embedded in CLEO process) | Consume `@signaldock/core` npm package, embedded SQLite |
| Phase 3 | Full Conduit | SignalDock as Conduit delivery layer with LAFS envelope shaping | TypeScript owns envelope schema/policy; SignalDock/Rust owns broker/delivery/retry |
| Phase 4 | NEXUS relay | SignalDock as cross-project transport for `nexus.share.*` | Wayfinder policy in TypeScript, SignalDock handles cross-agent routing |

### 6.4 Key Architecture Decision Needed

The Implementation Map says **Rust owns** the Conduit delivery layer. SignalDock IS a Rust library. The question is whether SignalDock becomes the Conduit delivery layer directly, or whether CLEO builds its own Rust runtime and consumes SignalDock as a dependency within it.

**Option A: SignalDock IS the Conduit delivery layer.** CLEO wraps SignalDock's SDK services with LAFS envelope shaping. The Rust runtime for Agent-Runtime Core, Impulse, and Watchers is built separately and communicates with SignalDock for messaging.

**Option B: SignalDock is consumed by a broader CLEO Rust runtime.** A unified Rust binary provides process supervision (Agent-Runtime Core), work triggers (Impulse), health patrols (Watchers), AND messaging (via SignalDock as a library dependency). TypeScript talks to one Rust process via local socket.

Option B is cleaner architecturally but requires more Rust development. Option A is faster to ship but creates two Rust processes (SignalDock server + CLEO runtime daemon).

---

## 7. References

- `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md` -- Normative runtime mapping (T5519)
- `docs/specs/CLEO-AUTONOMOUS-RUNTIME-IMPLEMENTATION-MAP.md` -- TS/Rust boundary (T5519)
- `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` -- Live relay contract (T5524)
- `docs/concepts/CLEO-CANON-INDEX.md` -- Canon reading order
- `docs/concepts/CLEO-VISION.md` -- Constitutional vision
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` -- System flow and domain interaction
- `docs/concepts/NEXUS-CORE-ASPECTS.md` -- Workshop vocabulary and live orchestration language
- `docs/specs/CLEO-MULTI-TIER-AGENT-ORCHESTRATION-SPEC.md` -- Current Phase 0 spec (T5671)
- `packages/ct-skills/skills/ct-orchestrator/SKILL.md` -- Orchestrator behavioral protocol
- `src/core/orchestration/waves.ts` -- Wave computation implementation (T4784)
- `.cleo/agent-outputs/T5671-signaldock-research-report.md` -- SignalDock-core integration research (signaldock-lead)
