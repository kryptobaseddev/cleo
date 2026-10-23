# Aggregation Protocol — AgentMBX + Manifest Drain Semantics

The Phase Lead converges on wave completion via TWO complementary channels:

1. **AgentMBX** (the Lead's mailbox) — one completion message per worker
   carrying its terminal status (`complete` / `partial` / `blocked` /
   `failed` / `timeout`) and task id. Agent messages travel over AgentMBX,
   not CONDUIT (D11172).
2. **pipeline_manifest** (SQLite, ADR-027) — durable source of truth for
   each worker's structured output (key_findings, files, gates).

Messages drive **timing**; the manifest drives **content**. `rollupWaveStatus`
(T9082) reads the manifest and produces the authoritative wave verdict.

---

## 1. Mailbox before spawn

Before issuing `delegate_task`, build each worker's prompt with `cleo
orchestrate spawn <taskId> --lead-mbx <you>` so its completion message reaches
you (`fanout` cannot carry the name yet, T13966: put it in the task notes). A mailbox keeps messages until
they are read, so a worker that finishes first is never lost; a worker that
does not know your name cannot report at all.

```bash
# CORRECT — each worker prompt names the Lead mailbox
cleo orchestrate spawn T9301 --lead-mbx lead-t9080-w2
```

---

## 2. Drain loop

There is no blocking await. Between waits the Lead reads its inbox
(`mbx_inbox` / `mbx_read`, or `agentmbx inbox --as <you>`) until every
worker's completion message has arrived OR its wall-clock budget elapses,
and acks each message it acted on.

```bash
# Then read authoritative state from the manifest, by the wave number
# `cleo orchestrate waves` prints.
cleo orchestrate roll-up T9080 --wave 2 --json > /tmp/rollup.json
```

> **Wave contract (T12682).** One wave number `n` names everything: it is
> the 1-based number `cleo orchestrate waves <epic>` prints, and `cleo
> orchestrate roll-up <epic> --wave <n>` takes the same `n` (`--wave 0` is refused with
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
>   noted a wave number ahead of time, re-read `cleo orchestrate waves`
>   after any dependency change.
> - **Numbers can skip, and an epic's first wave can be above 1** (a task
>   whose external prerequisite sits at depth 3 is in wave 4). Always take
>   `n` from `cleo orchestrate waves`; never assume the first wave is 1.
>
> `orchestrate ready`, `plan` and `parallel start --wave <n>` never re-run
> finished tasks.


`rollupWaveStatus` returns:

```json
{
  "epicId": "T9080",
  "waveId": "wave-2",
  "total": 5,
  "complete": 4,
  "partial": 0,
  "blocked": 0,
  "failed": 1,
  "timeout": false,
  "workers": [
    { "taskId": "T9301", "status": "complete", "manifestEntryId": "..." },
    { "taskId": "T9305", "status": "failed",   "reason": "E_GATE_FAILED:qaPassed" }
  ]
}
```

---

## 3. Retry policy on partial failures

The Lead has a STRICT local retry budget: **at most 1 retry per worker**.
Repeated failure escalates to the parent Orchestrator via a `partial`
return contract — the Lead does NOT loop forever.

| Failure class | Retry locally? | Rationale |
|---------------|----------------|-----------|
| `E_TIMEOUT` (worker hit 600s) | NO — return `partial` | Time pressure suggests scope problem; parent decides re-budget |
| `E_GATE_FAILED:testsPassed` | YES (1×) | Often flaky — single retry is cheap |
| `E_GATE_FAILED:qaPassed` | YES (1×) | Lint/format intermittents acceptable |
| `E_GATE_FAILED:implemented` | NO — return `partial` | Substantive — needs spec review |
| `E_DEP_UNSATISFIED` | NO — return `blocked` | Wave was mis-scheduled; parent re-plans |
| `E_HITL_REQUIRED` | NO — return `blocked` | By definition outside autonomous scope |
| `E_INFRASTRUCTURE` (DB lock, fs full) | YES (1×, after 5s backoff) | Transient |
| Worker returned `blocked` | NO — propagate `blocked` | Worker self-identified human dependency |

Local retry shape:

```bash
# After first drain, identify retriable failures
RETRIABLE=$(jq -r '.workers[] | select(.status=="failed" and (.reason|test("testsPassed|qaPassed|INFRASTRUCTURE"))) | .taskId' /tmp/rollup.json)

# Re-spawn ONLY those; their briefs name the Lead mailbox and say "retry 1"
cleo orchestrate fanout T9080 --tasks "$(echo $RETRIABLE | tr ' ' ,)"

# Read the retry completion messages, then roll up again (the manifest holds
# the latest status of every worker, retries included)
cleo orchestrate roll-up T9080 --wave 2 --json > /tmp/rollup-final.json
```

After the single retry pass, whatever `rollup-final.json` shows IS the
verdict — no second retry pass.

---

## 4. 600-second subagent timeout handling

Every leaf worker is bounded by a 600s wall-clock timeout (configurable via
`subagentTimeoutSeconds`). The Lead's drain timeout MUST be at least equal
to the worker timeout — typically equal, since workers report terminally
on timeout over AgentMBX.

Behaviour matrix:

| Worker outcome at 600s | AgentMBX message | Manifest entry | Lead action |
|------------------------|----------------|----------------|-------------|
| Worker returned a contract string in time | `complete`/`partial`/`blocked` | Present, full | Aggregate normally |
| Worker exited cleanly past 600s (race) | None | Present | `rollupWaveStatus` reconciles via manifest |
| Worker hung; runtime killed it | `timeout` | Stub entry with `status:timeout` | Treat as `failed` non-retriable; return `partial` |
| Worker could not reach AgentMBX | None | None | Drain times out; `rollup` flags `missing` workers; return `partial` |

The Lead's own wall-clock budget should be `subagentTimeoutSeconds + 60s`
of slack to allow the rollup query and manifest append to complete.

---

## 5. Escalation decision tree

```
rollupWaveStatus() →
├── all complete       → manifest append → "Lead rollup complete..."
├── any blocked        → manifest append → "Lead rollup blocked..."
├── retriable failures → local retry (1×) → re-rollup → recurse this tree
└── non-retriable      → manifest append → "Lead rollup partial..."
```

Escalate to parent Orchestrator (return `partial` or `blocked`) when:
- ANY worker requires HITL input (architectural decision, scope expansion)
- Same worker fails after the single local retry
- The inbox drain times out with `missing` workers
- A worker reports `E_DEP_UNSATISFIED` (wave was mis-planned)
- Cumulative wave wall-clock exceeds `subagentTimeoutSeconds + 60s`

Retry locally (do NOT escalate yet) when:
- Failure is in `testsPassed` / `qaPassed` / `INFRASTRUCTURE` class
- Retry budget (1×) for that worker is unspent
- Lead's own wall-clock has > 300s remaining

---

## 6. Rollup manifest entry shape

Exactly ONE rollup entry per wave per Lead invocation:

```bash
cleo manifest append \
  --task "${LEAD_TASK_ID}" \
  --type lead-rollup \
  --content "Wave wave-2 of T9080: 4/5 complete, 1 failed (T9305 E_GATE_FAILED:implemented). Retried 0. Workers: T9301(c), T9302(c), T9303(c), T9304(c), T9305(f)." \
  --status partial
```

The parent Orchestrator reads ONLY this entry's `key_findings` — never the
underlying worker manifest entries. This is the context-budget invariant
that makes hierarchical orchestration scalable (ADR-070).
