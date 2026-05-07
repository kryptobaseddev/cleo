# ADR-070: Three-tier orchestration: Orchestrator -> Lead -> Worker

- **Status:** Accepted
- **Date:** 2026-05-06
- **Deciders:** cleocode core orchestration working group
- **Tags:** orchestration, conduit, scaling, hitl, manifests
- **Supersedes:** none
- **Related:** ADR-027 (manifest contract), ADR-068 (DB Charter / Canonical Agent System), ADR-069 (Coordination Layers — forthcoming), ct-orchestrator skill, ct-lead skill (T9084 — not yet shipped)

## Context

The cleocode orchestration loop currently has the Orchestrator subagent
spawn Worker subagents directly via `delegate_task`. This pattern works
for small fan-out (1–3 workers) but breaks at scale:

1. **Orchestrator context floods at >5 parallel workers.** Each worker
   returns a roll-up summary that the Orchestrator must read, parse, and
   reconcile against the pipeline manifest. Beyond ~5 concurrent
   workers, the Orchestrator's context window is consumed by status
   triage instead of high-level coordination, and HITL latency degrades
   because the operator cannot get a clean signal from the Orchestrator.
2. **Direct fan-out does not reach "hundreds of workstreams."** The
   stated operator goal is to drive hundreds of parallel workstreams
   off a single HITL session. A flat Orchestrator -> Worker tree cannot
   reach that scale: there is no level of hierarchy at which an agent
   summarises a *phase* rather than a *task*.
3. **Subagent timeouts swallow uncommitted work.** When a Worker times
   out mid-task, any uncommitted edits in its sandboxed worktree are
   lost. Without an intermediate supervisor that owns commit cadence
   for a phase, the Orchestrator has no way to detect or recover that
   silent loss before the manifest is closed.

T1252 already shipped the conduit primitive `parseTopicName` and the
`epic-<TID>.wave-<n>` shape, but the orchestration layer above it has
no formal role contract that consumes those topics.

## Decision

Adopt a three-tier orchestration model with three explicit roles.
Each role has a single responsibility and a constrained surface.

### Role 1: Orchestrator (HITL interface)

- The single subagent the human operator talks to.
- **Never writes code.** Never spawns Workers directly above the
  migration threshold (see Migration below).
- Reads only:
  - `pipeline_manifest` rows (per ADR-027)
  - High-level phase summaries returned by Phase Leads
  - Conduit topic `epic-<TID>.status` (epic-level broadcast only)
- Plans phases, decomposes epics into waves, and delegates each wave
  to exactly one Phase Lead via `delegate_task` with `role=orchestrator`.
- Surfaces blockers and decision points to the operator.

### Role 2: Phase Lead (subagent, role=orchestrator)

- Spawned by the Orchestrator with `delegate_task` parameter
  `role=orchestrator` (see ADR-068 / canonical agent system).
- Owns one phase / one wave for one epic.
- Spawns N Worker subagents in parallel for that wave.
- Subscribes to `epic-<TID>.wave-<n>` for the wave it is leading; reads
  worker status events as workers progress.
- Owns commit cadence: ensures every Worker either commits cleanly or
  has its partial state surfaced before timeout reaps it.
- Aggregates manifest entries from its workers and returns a single
  roll-up summary to the Orchestrator. The Orchestrator never sees the
  per-worker chatter.
- May also subscribe to `epic-<TID>.coordination` to negotiate with
  peer Phase Leads on cross-epic dependencies.

### Role 3: Worker (subagent, role=leaf)

- Spawned by a Phase Lead with `delegate_task` parameter `role=leaf`.
- Single-file or small-scope task (the canonical "do one thing" unit).
- Publishes status events to `epic-<TID>.wave-<n>` (its parent Lead's
  topic) at start, on progress checkpoints, and on completion or error.
- On completion, appends its own row to `pipeline_manifest` per
  ADR-027 (`cleo manifest append <TID> ...`) — Workers own their own
  evidence, Leads do not write manifest rows on behalf of Workers.
- Returns a focused summary (not a full session log) to its Phase Lead.

## Conduit Topic Naming Convention

The canonical topic shape (already partially shipped via T1252's
`parseTopicName`):

```
epic-<TID>.wave-<n>      Worker status events for wave n of epic <TID>.
                         Producer: Workers in that wave.
                         Consumer: the Phase Lead leading that wave.

epic-<TID>.coordination  Lead-to-Lead coordination for cross-epic
                         dependencies. Producer/consumer: Phase Leads
                         (any wave) on related epics.

epic-<TID>.status        Epic-level status broadcast.
                         Producer: Phase Leads (rolled up from waves).
                         Consumer: Orchestrator only.
```

### Subscription patterns

- **Worker** publishes to `epic-<TID>.wave-<n>` only. Does not
  subscribe.
- **Phase Lead** subscribes to `epic-<TID>.wave-<n>` on spawn (the wave
  it owns). May also subscribe to `epic-<TID>.coordination` if its
  epic has declared cross-epic dependencies. Publishes rolled-up state
  to `epic-<TID>.status`.
- **Orchestrator** subscribes to `epic-<TID>.status` only. Never
  subscribes to wave-level traffic. This is the property that bounds
  Orchestrator context regardless of wave fan-out.

This subscription topology is what makes the model scale: per-worker
chatter never reaches the Orchestrator, and per-wave chatter never
reaches sibling Leads.

## Migration

The existing direct-spawn pattern (Orchestrator -> Worker) remains
**valid** for small jobs. The trigger thresholds:

- **<=3 Workers in a phase, single wave, no cross-epic deps:**
  direct-spawn from Orchestrator is fine. No Phase Lead required.
- **>3 Workers in a phase OR any IVTR phase that crosses wave
  boundaries:** a Phase Lead is **required**. The Orchestrator must
  delegate to a Lead, not spawn Workers directly.

Existing in-flight epics that fit the small-job profile do not need to
be retrofitted. New epics with declared wave plans should use the
three-tier model from inception.

## Consequences

Positive:

- Orchestrator context stays bounded irrespective of total worker
  count; "hundreds of workstreams" becomes reachable by stacking waves
  under multiple Leads.
- Phase Leads provide a natural commit-cadence checkpoint, mitigating
  the timeout-loses-work failure mode.
- Topic naming is now a contract: tooling (conduit subscribers,
  dashboards, replay) can rely on `epic-<T>.wave-<n>` /
  `.coordination` / `.status` shapes.

Negative / costs:

- One extra hop in the spawn chain adds latency for small jobs — hence
  the migration threshold preserving direct-spawn for <=3 workers.
- Phase Leads are a new failure mode: a Lead crash now strands a whole
  wave. Recovery is owned by ADR-069 (Coordination Layers, forthcoming).

## Acceptance Criteria Mapping

The following T9080 children consume this ADR:

- **T9081** — this ADR document itself.
- **T9082** — Phase Lead spawn primitive in `delegate_task`
  (`role=orchestrator` enforcement, wave-topic subscription on spawn).
- **T9083** — Conduit topic schema validation against the canonical
  three-shape convention (`wave-<n>`, `coordination`, `status`).
- **T9084** — `ct-lead` skill: the operator-visible skill that
  encodes the Phase Lead role contract. Cross-linked here; not yet
  shipped.
- **T9085** — Orchestrator subscription guard: enforces that the
  Orchestrator subagent only ever subscribes to `.status` topics.
- **T9086** — Manifest aggregation rules for Phase Lead roll-ups
  (per ADR-027 § append semantics).

## References

- ADR-027 — Manifest contract (workers append their own rows).
- ADR-068 — Canonical Agent System / DB Charter (defines `role=`
  values used here: `orchestrator`, `leaf`).
- ADR-069 — Coordination Layers (forthcoming; covers Lead crash
  recovery and cross-epic dependency negotiation).
- ct-orchestrator skill — Orchestrator role contract.
- ct-lead skill (T9084) — Phase Lead role contract (forthcoming).
- T1252 — `parseTopicName` and the `epic-<TID>.wave-<n>` primitive.
