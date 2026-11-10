# Spawn Pattern — Worker Fanout Examples

The Phase Lead fans out all workers in ONE `cleo orchestrate fanout` call.
Width is bounded by `maxConcurrent` (default 10; a convention the Lead enforces — no runtime check exists).
Each child is a leaf, and its prompt names the Lead's AgentMBX mailbox so its
completion message reaches the Lead.

A no-hands lead (`cleo orchestrate lead`, `orchestrate.leadWorker.v1`) has no
Bash: it passes the same command as an argv array to `mcp__cleo-lead__cleo_run`,
for example `["cleo", "orchestrate", "fanout", "T9080", "--tasks", "T9101,T9102,T9103"]`.

All examples assume:
- Epic: `T9080`
- Wave: `wave-2`
- Lead mailbox (AgentMBX): `lead-t9080-w2`

`fanout` takes the epic and the task list only; role, model and timeout come
from each task's spawn prompt (`cleo orchestrate spawn <taskId>`).

---

## Example 1 — 3-worker fanout (small wave)

Typical for narrowly-scoped waves where deps fan in tightly.

```bash
cleo orchestrate fanout T9080 --tasks T9101,T9102,T9103
```

---

## Example 2 — 5-worker fanout (medium wave)

```bash
cleo orchestrate fanout T9080 --tasks T9201,T9202,T9203,T9204,T9205
```

---

## Example 3 — 10-worker fanout (max-width wave)

This is the upper bound at the default `maxConcurrent = 10`.
For wider waves, the parent Orchestrator MUST split into multiple Leads.

```bash
cleo orchestrate fanout T9080 --tasks T9301,T9302,T9303,T9304,T9305,T9306,T9307,T9308,T9309,T9310
```

---

## Anti-patterns

DO NOT issue per-worker calls in a loop:

```bash
# WRONG — sequentializes the wave, defeats parallelism (LEAD-006)
for t in T9301 T9302 T9303 T9304 T9305; do
  cleo orchestrate spawn "$t"   # serial, blocks the lead
done
```

DO NOT exceed `maxConcurrent`:

```bash
# WRONG — 20 workers in one wave; split into waves of at most maxConcurrent
cleo orchestrate fanout T9300 --tasks $(seq -s, T9301 T9320)
```

Nothing in the runtime enforces the cap today; the Lead must.

DO NOT spawn workers with `role=orchestrator`:

```json
// WRONG — would create a Lead-of-Leads recursion (LEAD-003)
{ "taskId": "T9301", "role": "orchestrator" }
```

## Sizing guidance

| Worker count | When to use | Notes |
|--------------|-------------|-------|
| 1–3 | Narrow waves; single-package changes | Minimal overhead, fast convergence |
| 4–6 | Typical implementation waves | Sweet spot for sonnet workers |
| 7–10 | Max-width parallel waves | Watch inbox volume; close to convergence-limit |
| >10  | Split across multiple Leads | Top Orchestrator spawns N Leads, each ≤10 workers |
