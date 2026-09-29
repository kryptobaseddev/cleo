# Aggregation Protocol — Conduit + Manifest Drain Semantics

The Phase Lead converges on wave completion via TWO complementary channels:

1. **Conduit topic** (`epic-<TID>.wave-<n>`) — low-latency event stream
   carrying terminal-status signals (`complete` / `partial` / `blocked` /
   `failed` / `timeout`) from each worker as it returns.
2. **pipeline_manifest** (SQLite, ADR-027) — durable source of truth for
   each worker's structured output (key_findings, files, gates).

Conduit drives **timing**; manifest drives **content**. `rollupWaveStatus`
(T9082) reads BOTH and produces the authoritative wave verdict.

---

## 1. Subscription timing

The Lead MUST subscribe to the conduit topic BEFORE issuing `delegate_task`.
Subscription is idempotent and cheap; late subscription races against
fast-finishing workers and silently loses early `complete` signals.

```bash
# CORRECT — subscribe, then spawn
cleo conduit subscribe --topic "epic-T9080.wave-2"
cleo orchestrate fanout T9080 --tasks T9301,T9302,T9303

# WRONG — fanout, then subscribe (race window)
cleo orchestrate fanout T9080 --tasks T9301,T9302,T9303
cleo conduit subscribe --topic "epic-T9080.wave-2"   # may miss T9301 done
```

The conduit retains buffered signals for `conduit.replay_window` (default 30s)
to defend against tiny races, but relying on the buffer is brittle.

---

## 2. Drain loop

There is no blocking await. The Lead polls the wave topic with
`cleo conduit listen --topic <topic> --since <last-seen>` until the expected number of
terminal signals has arrived OR its wall-clock budget elapses.

```bash
cleo conduit listen --topic "epic-T9080.wave-2" --since "${SPAWNED_AT}" \
  > /tmp/conduit-drain.json

# Then read authoritative state from manifest — same wave number as the topic.
cleo orchestrate roll-up T9080 --wave 2 --json > /tmp/rollup.json
```

> **Wave contract (T12682).** One wave number `n` names everything: it is
> the 1-based number `cleo orchestrate waves <epic>` prints, spawned workers
> publish on `epic-<epicId>.wave-<n>`, and `cleo orchestrate roll-up <epic>
> --wave <n>` takes the same `n` (`--wave 0` is refused with
> `E_CLEO_VALIDATION`, pointing at `cleo orchestrate waves`).
>
> **Read `n` when you subscribe.** Wave numbers are recomputed from the
> tasks still open, so they shift as earlier waves complete. Take `n` from
> `cleo orchestrate waves` at the moment you subscribe and spawn; do not
> hard-code the numbers of future waves until stable numbering (T12683)
> lands.


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

# Re-spawn ONLY those (NEW conduit topic suffix to avoid replay collision)
cleo conduit subscribe --topic "epic-T9080.wave-2.retry-1"
cleo orchestrate fanout T9080 --tasks "$(echo $RETRIABLE | tr ' ' ,)"

# Re-drain on the retry topic, then roll up again (the manifest holds the
# latest status of every worker, retries included)
cleo conduit listen --topic "epic-T9080.wave-2.retry-1" --since "${RETRY_AT}"
cleo orchestrate roll-up T9080 --wave 2 --json > /tmp/rollup-final.json
```

After the single retry pass, whatever `rollup-final.json` shows IS the
verdict — no second retry pass.

---

## 4. 600-second subagent timeout handling

Every leaf worker is bounded by a 600s wall-clock timeout (configurable via
`subagentTimeoutSeconds`). The Lead's drain timeout MUST be at least equal
to the worker timeout — typically equal, since workers report terminally
on timeout via the conduit.

Behaviour matrix:

| Worker outcome at 600s | Conduit signal | Manifest entry | Lead action |
|------------------------|----------------|----------------|-------------|
| Worker returned a contract string in time | `complete`/`partial`/`blocked` | Present, full | Aggregate normally |
| Worker exited cleanly past 600s (race) | None | Present | `rollupWaveStatus` reconciles via manifest |
| Worker hung; runtime killed it | `timeout` | Stub entry with `status:timeout` | Treat as `failed` non-retriable; return `partial` |
| Network partition between worker and conduit | None | None | Drain times out; `rollup` flags `missing` workers; return `partial` |

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
- Conduit drain times out with `missing` workers
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
