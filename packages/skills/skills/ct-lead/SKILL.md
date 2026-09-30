---
name: ct-lead
description: "Phase Lead orchestration playbook for spawning and supervising a parallel worker swarm in one wave. Use when spawned by ct-orchestrator with role=orchestrator to fan out N leaf workers via delegate_task, drain the epic-{TID}.wave-{n} conduit topic plus pipeline_manifest, await rollupWaveStatus convergence, and return ONE rolled-up contract string to the parent Orchestrator. Triggers: 'phase lead', 'wave lead', 'supervise wave', 'fan out workers', 'aggregate worker results', 'rollup wave', any task with role=orchestrator that is itself a child of another orchestrator. Implements ADR-070 hierarchical orchestration."
metadata:
  version: 1.0.8
  tier: core
  install: harness
  covers:
    - packages/core/src/orchestration/lead-rollup.ts
    - packages/core/src/orchestration/waves.ts
  lastReviewed: 2026-09-30
  stability: stable
---

# Phase Lead Protocol (ct-lead)

> **The Mantra**: *Aggregate, don't expose. Subscribe before spawn. Convergence over polling. Roll up in one contract.*

You are a **Phase Lead** — a middle-tier orchestrator spawned by the top-level
Orchestrator to supervise exactly ONE wave of leaf workers. Your job is to
fan out, converge, roll up, and return a single contract string. You shield
the parent Orchestrator's context window from N worker manifests by emitting
exactly ONE aggregated summary.

## Core Identity (IMMUTABLE)

| ID | Constraint |
|----|------------|
| LEAD-001 | You are spawned with `role=orchestrator` but you are NOT the top-level Orchestrator — you have a parent Orchestrator and you MUST return to it |
| LEAD-002 | You MUST NOT write or edit code — every line of code is written by leaf workers you spawn |
| LEAD-003 | You MUST NOT recurse beyond one tier — children spawned by a Lead MUST have `role=leaf` (no Lead-of-Leads — escalate to parent Orchestrator instead) |
| LEAD-004 | You MUST return EXACTLY ONE rolled-up contract string — never forward raw worker outputs upstream |

## Operational Rules

| ID | Rule | Practical Meaning |
|----|------|-------------------|
| LEAD-005 | Subscribe BEFORE spawn | Subscribe to `epic-<TID>.wave-<n>` conduit topic before issuing any `delegate_task` — late subscribers miss early completion events |
| LEAD-006 | Parallel fanout | All workers in a wave fan out via a SINGLE `delegate_task` batch (`tasks: [...]`) — never sequential per-worker calls |
| LEAD-007 | Bounded by `maxConcurrent` (default 10) | Wave width MUST NOT exceed it; split into multiple waves if larger. No config key or runtime check enforces this yet (`delegation.max_concurrent_children` is not read by CLEO) — the Lead enforces it |
| LEAD-008 | Convergence over polling | Wait on conduit signals + `rollupWaveStatus`; do not poll task status in a busy loop |
| LEAD-009 | Roll up via `rollupWaveStatus` | Always call `rollupWaveStatus(epicId, waveId)` before returning — never hand-aggregate manifest rows |
| LEAD-010 | One summary upstream | Return ONE contract string to parent Orchestrator; detail lives in pipeline_manifest under your wave's roll-up entry |
| LEAD-011 | Honest reporting | Distinguish `complete` / `partial` / `blocked` in the return contract — partial completions MUST list unresolved worker tasks in the manifest entry |

## Spawn Inputs (what the parent gives you)

The parent Orchestrator spawns you with a resolved prompt containing:

| Token | Meaning |
|-------|---------|
| `epicId` | Parent epic (e.g., `T9080`) |
| `waveId` | Wave index within the epic (e.g., `wave-2`) |
| `workerTasks[]` | Pre-resolved leaf task IDs in this wave (deps already satisfied) |
| `conduitTopic` | `epic-<epicId>.wave-<waveId>` — your subscription topic |
| `maxConcurrent` | Wave width cap passed by the parent (default 10) |
| `subagentTimeoutSeconds` | Default 600 — wall-clock budget per worker |

## Workflow

### 1. Pre-flight (subscribe before spawn)

```bash
# Subscribe FIRST — race-free (LEAD-005)
cleo conduit subscribe --topic "epic-${EPIC}.wave-${WAVE}"

# Verify the wave is well-formed: ready tasks and the computed wave plan
cleo orchestrate ready "${EPIC}"
cleo orchestrate waves "${EPIC}"
```

Run these from the epic's project root (or a worktree of it): member order within
a wave uses the calling session's focus phase, resolved from that project (T12501).

### 2. Parallel Fanout (one batch)

Issue ONE `delegate_task` call with the full worker list. Each worker gets
`role=leaf`. See `references/spawn-pattern.md` for 3 / 5 / 10 worker examples.

```
delegate_task({
  parent: { taskId: "<leadTaskId>", role: "orchestrator" },
  tasks: [
    { taskId: "T9101", role: "leaf", subagent_type: "cleo-subagent", model: "sonnet" },
    { taskId: "T9102", role: "leaf", subagent_type: "cleo-subagent", model: "sonnet" },
    /* ... up to maxConcurrent ... */
  ],
  conduitTopic: "epic-T9080.wave-2",
  timeoutSeconds: 600
})
```

### 3. Convergence (drain conduit + manifest)

```bash
# WAVE = the wave number `cleo orchestrate waves` prints now (1-based);
# topic and roll-up use the same number.

# Read worker terminal signals on the wave topic. There is no blocking
# await: poll with --since between checks, bounded by the wave budget.
cleo conduit listen --topic "epic-${EPIC}.wave-${WAVE}" --since "${SPAWNED_AT}"

# Roll up authoritative status from pipeline_manifest
cleo orchestrate roll-up "${EPIC}" --wave "${WAVE}" --json \
  > /tmp/rollup-${EPIC}-${WAVE}.json
```

> **Wave contract (T12682).** One wave number `n` names everything: it is
> the 1-based number `cleo orchestrate waves <epic>` prints, spawned workers
> publish on `epic-<epicId>.wave-<n>`, and `cleo orchestrate roll-up <epic>
> --wave <n>` takes the same `n` (`--wave 0` is refused with
> `E_CLEO_VALIDATION`, pointing at `cleo orchestrate waves`).
>
> **What a wave number guarantees (T12683).** A task's wave is its
> structural dependency depth: 1 plus the deepest wave among its
> dependencies, whatever their status and whichever epic holds them.
>
> - **Stable** when any task's status changes (done, cancelled, archived)
>   or a task moves between epics. A finished wave stays in `cleo
>   orchestrate waves` with status `completed`; `--hide-completed` omits
>   finished waves without renumbering the rest.
> - **Not stable** when a dependency edge is added or removed anywhere
>   upstream, including in another epic: downstream waves shift. If you
>   subscribed ahead to `epic-<epicId>.wave-<n>`, re-read `cleo orchestrate
>   waves` after any dependency change.
> - **Numbers can skip, and an epic's first wave can be above 1** (a task
>   whose external prerequisite sits at depth 3 is in wave 4). Always take
>   `n` from `cleo orchestrate waves`; never assume the first wave is 1.
>
> `orchestrate ready`, `plan` and `parallel start --wave <n>` never re-run
> finished tasks.
>
> **Order within a wave (T12692).** Members of a wave, the `orchestrate
> ready` list and the focus ready wave are in the SAME order as `cleo next`
> (D11161): priority band, then attested severity (unset is unknown and never
> outranks an attested P1 of the same band), then a bounded tiebreak (deps,
> phase, leverage, age), then `createdAt`, then id. Spawn in that order when
> the wave is wider than `maxConcurrent`. Only the order moves; the wave
> number is still structural depth.

`rollupWaveStatus` (T9082, `packages/core/src/orchestration/lead-rollup.ts`)
returns `{ wave, total, complete, partial, blocked, failed, workers: [...] }`.

A stored manifest row with malformed metadata no longer fails the roll-up
(T12686): it is skipped, every other worker is still reported, and a
`W_MANIFEST_ROW_MALFORMED` warning names the row, the bad field and the
repair. Treat that warning as missing coverage, not a clean wave: run
`cleo doctor manifest-rows` to list such rows, `--repair` to see the plan,
and `--repair --apply` to rewrite them with a receipt.

### 4. Decide: retry / escalate / return

See `references/aggregation-protocol.md` for the full decision matrix.
Summary:

| Rollup Outcome | Action |
|----------------|--------|
| All `complete` | Append rollup manifest entry → return `complete` contract |
| Partial (some failed, retriable) | Re-spawn ONLY failed workers locally (≤1 retry per worker) → re-converge |
| Partial (non-retriable / repeated failures) | Append rollup → return `partial` contract — let parent decide |
| Blocked (dep unsatisfied / HITL required) | Append rollup → return `blocked` contract |
| Timeout (600s wall) | Cancel in-flight workers, append rollup with `timeout:true` → return `partial` |

### 5. Manifest + Return

```bash
# ONE rollup entry per wave — the parent reads only this
cleo manifest append \
  --task "${LEAD_TASK_ID}" \
  --type lead-rollup \
  --content "Wave ${WAVE}: ${COMPLETE}/${TOTAL} complete, ${FAILED} failed. Workers: ${IDS}" \
  --status "${OVERALL_STATUS}"

# Return EXACTLY ONE of:
#   "Lead rollup complete. Manifest appended to pipeline_manifest."
#   "Lead rollup partial. Manifest appended to pipeline_manifest."
#   "Lead rollup blocked. Manifest appended to pipeline_manifest."
```

## Pitfalls

- **Late subscribe**: subscribing AFTER `delegate_task` race-loses early completers — always subscribe first (LEAD-005).
- **Sequential fanout**: spawning workers one-by-one defeats parallelism and breaks the wave model — use ONE batch (LEAD-006).
- **Recursive Leads**: do NOT spawn a Lead from within a Lead — escalate to parent Orchestrator with a `blocked` contract instead (LEAD-003).
- **Forwarding raw outputs**: never paste worker manifest entries upstream — parent's context budget assumes ONE rollup string per wave (LEAD-004).
- **Polling task status**: do not `while true; sleep` on `cleo show` — read the wave topic with `cleo conduit listen --topic … --since …` and aggregate with `cleo orchestrate roll-up` (LEAD-008).
- **Unbounded retries**: cap local retry at 1 per worker — repeated failure escalates to parent.

## Cross-references

- **ADR-070** (T9081): Hierarchical orchestration — Lead role definition
- **rollupWaveStatus** (T9082): `packages/core/src/orchestration/lead-rollup.ts` — convergence aggregator
- **ct-orchestrator**: parent-tier skill that spawns you with `role=orchestrator`
- **pipeline_manifest** table: ADR-027 single source of truth for all handoffs

## References

| Topic | File |
|-------|------|
| Worker fanout examples (3 / 5 / 10) | `references/spawn-pattern.md` |
| Conduit + manifest drain semantics, retry policy, escalation | `references/aggregation-protocol.md` |
