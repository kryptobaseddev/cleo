# T942 Sentient CLEO — Final Decisions (Owner-Approved 2026-04-18)

## Decision Matrix

| # | Task | Decision | Rationale |
|---|---|---|---|
| 1 | **T943 State SSoT** | **Option F: Unified Evidence Substrate via llmtxt/events** | Single Merkle+RFC3161 tamper-evident event log replaces dual-substrate mess (JSONL + dead DB tables). Cryptographically verifiable. Event-sourced = future-proof. |
| 2 | **T944 Ontology** | **Simpler additive: role + scope + severity + experiments side-table** | Keep `type` column. `role ∈ {work,research,experiment,bug,spike,release}` + `scope ∈ {project,feature,unit}`. Severity is owner-write-only (prevents prompt-injection P0 force-ship). Experiments get side-table, not denormalized columns. |
| 3 | **T944 epic-of-epics** | **Relax validation only** (no other axis changes in W1) | One-line change at `add.ts:800-807`. Zero schema risk. |
| 4 | **T945 Universal Graph** | **5-stage rollout closing coverage gaps** | brain_page_* is ALREADY live. Add: addTask mints nodes, conduit msg node type, llmtxt embeds edges, 5 new edge types, 3 new node types. |
| 5 | **T946 Autonomy** | **HARD BLOCK on T947; realistic 10-12w; agent-in-container** | Hand-rolled Ed25519 + JSONL receipts insufficient. Use `llmtxt/identity` KMS + `llmtxt/events` Merkle chain. Fix picker race. Externally-anchored baselines. No auto-rebase. |
| 6 | **T947 llmtxt v2026.4.9** | **GOES FIRST in W1**; 4 subpath adoption | Retires ~1,100 LoC duplicate primitives. Owner Constraint #4 (zero duplication). Everything else blocks on this. |
| 7 | **T948 SDK** | **Kill `packages/cleo-sdk/`; promote `@cleocode/core`** | Facade is closure bag, not service layer. Single SDK = core. STABILITY.md + .dts-snapshots/ mirroring llmtxt pattern. OpenAPI 3.1. Defer `cleo-api/`. |
| 8 | **Tier 2 queue** | **`status='proposed'` enum + picker filter** | Single axis. `TASK_STATUSES` extended. `dependency-check.ts:103-113` filter added in lockstep. Canon check updated. |

## Unified Event Substrate Design (Option F details)

```
Single substrate: llmtxt/events (Merkle-chained, RFC3161 anchored)

Event types unified across subsystems:

TASKS
  task.created                { taskId, parentId, role, scope, severity? }
  task.status-change          { taskId, from, to, by }
  task.completed              { taskId, receipt }
  gate.verified               { taskId, gate, atoms[], by }
  gate.reset                  { taskId, gate, by }

BRAIN
  memory.observed             { observationId, taskId?, text }
  decision.recorded           { decisionId, taskId?, text }
  pattern.consolidated        { patternId, fromObservations[] }
  plasticity.fired            { fromNode, toNode, deltaWeight }

CONDUIT
  message.sent                { msgId, from, to, threadId, taskId? }
  message.received            { msgId, by }
  message.delivered           { msgId, receipt }
  session.opened              { sessionId, scope }
  session.closed              { sessionId, stats }

NEXUS
  index.refreshed             { stats }
  symbol.added                { symbolId, file, kind }
  symbol.removed              { symbolId }
  impact.computed             { symbolId, affectedTasks[] }

SANDBOX / AUTONOMY
  experiment.started          { experimentId, taskId, baselineEventId }
  experiment.metrics-captured { experimentId, baselineHash, afterHash, deltaJson }
  experiment.merged           { experimentId, commit, receipt }
  experiment.aborted          { experimentId, reason }

OVERRIDES (replaces force-bypass.jsonl)
  override.invoked            { byOwner, reason, targetGate, taskId }

DEPRECATED (dropped in W2):
  - .cleo/audit/gates.jsonl         → migrated to gate.verified events
  - .cleo/audit/force-bypass.jsonl  → migrated to override.invoked events
  - .cleo/audit/assumptions.jsonl   → migrated to memory.observed events
  - .cleo/audit/decisions.jsonl     → migrated to decision.recorded events
  - lifecycle_gate_results table    → dropped (projections can rebuild if needed)
  - lifecycle_evidence table        → dropped
```

## Wave Plan (Realistic 10-12 weeks)

| Wave | Duration | Scope |
|---|---|---|
| **W1** | 1-2 weeks | T947 step 0 (version bump to ^2026.4.9) + T947 `/events` read-write adoption + T948 STABILITY.md on `@cleocode/core` + T943 `computeTaskRollup()` transitional (reads dual + events) |
| **W2** | 2 weeks | T947 `/blob` + `/sdk` adoption + JSONL→events migration (158 entries) + drop dead DB tables + T944 additive migration (role+scope+severity+experiments table) + T945 Stage A+B (additive graph schema + backfill) |
| **W3** | 2 weeks | T947 `/events` hardening + `/identity` adoption + T945 Stage C (auto-populate hooks for addTask/conduit/docs + graph-over-events) |
| **W4** | 2 weeks | T946 Tier 1 daemon (execute existing tasks) + T945 Stage D (SDK re-export) |
| **W5** | 2 weeks | T946 Tier 2 (propose tasks via status='proposed') + T945 Stage E (Studio ego-network + XFKB retirement) |
| **W6-W8** | 3 weeks | T946 Tier 3 (sandbox auto-merge) with all mitigations: agent-in-container, externally-anchored baseline, FF-only abort, kill-switch re-check at each step |

**Destination after W8**: Fully sentient CLEO with 24/7 autonomous self-improving loop; single tamper-evident evidence substrate; zero duplication with llmtxt; AI-LLM-first SDK + REST surface.

## Immediate Next Step

**Spawn T943's child tasks** for W1 implementation:
1. Version bump subtask: `pnpm add llmtxt@^2026.4.9` across monorepo (5 min)
2. `llmtxt/events` wiring subtask: ensure `packages/core` imports and uses `appendEvent` / `queryEvents` / `verifyHashChain`
3. `computeTaskRollup()` pure function subtask in `packages/core/src/lifecycle/rollup.ts`
4. `@cleocode/core/STABILITY.md` subtask per-subpath contract
5. Parity test subtask: `.cleo/audit/gates.jsonl` ↔ llmtxt/events event log equivalence

Owner approval of this plan = green light to spawn W1 child tasks and begin implementation.

## Open Coordination Items

- Spike needed: JSONL→events migration shape (what event type for each gate.jsonl line?)
- ADR needed: ADR-054 "Unified Evidence Substrate via llmtxt/events" documenting the transition from ADR-051's JSONL path
- ADR-051 addendum: supersede the JSONL substrate with the event-sourced equivalent
- Documentation debt: 17 files, 35 occurrences of old substrate references — refresh during W2
