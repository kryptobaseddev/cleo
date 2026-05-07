# Spawn Pattern — Worker Fanout Examples

The Phase Lead fans out all workers in a single `delegate_task` batch.
Width is bounded by `delegation.max_concurrent_children` (default 10).
Each child carries `role=leaf` and inherits the wave's conduit topic.

All examples assume:
- Lead's own task ID: `T9080-lead-w2`
- Epic: `T9080`
- Wave: `wave-2`
- Conduit topic: `epic-T9080.wave-2`

---

## Example 1 — 3-worker fanout (small wave)

Typical for narrowly-scoped IVTR waves where deps fan in tightly.

```json
{
  "tool": "delegate_task",
  "args": {
    "parent": { "taskId": "T9080-lead-w2", "role": "orchestrator" },
    "conduitTopic": "epic-T9080.wave-2",
    "timeoutSeconds": 600,
    "tasks": [
      { "taskId": "T9101", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9102", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9103", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" }
    ]
  }
}
```

CLI equivalent (one shell call, NOT a loop):

```bash
cleo orchestrate spawn-batch \
  --parent T9080-lead-w2 --parent-role orchestrator \
  --topic epic-T9080.wave-2 \
  --timeout 600 \
  --tasks T9101,T9102,T9103 \
  --child-role leaf --model sonnet
```

---

## Example 2 — 5-worker fanout (medium wave)

```json
{
  "tool": "delegate_task",
  "args": {
    "parent": { "taskId": "T9080-lead-w2", "role": "orchestrator" },
    "conduitTopic": "epic-T9080.wave-2",
    "timeoutSeconds": 600,
    "tasks": [
      { "taskId": "T9201", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9202", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9203", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9204", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9205", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" }
    ]
  }
}
```

---

## Example 3 — 10-worker fanout (max-width wave)

This is the upper bound at default `delegation.max_concurrent_children = 10`.
For wider waves, the parent Orchestrator MUST split into multiple Leads.

```json
{
  "tool": "delegate_task",
  "args": {
    "parent": { "taskId": "T9080-lead-w2", "role": "orchestrator" },
    "conduitTopic": "epic-T9080.wave-2",
    "timeoutSeconds": 600,
    "tasks": [
      { "taskId": "T9301", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9302", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9303", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9304", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9305", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9306", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9307", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9308", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9309", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" },
      { "taskId": "T9310", "role": "leaf", "subagent_type": "cleo-subagent", "model": "sonnet" }
    ]
  }
}
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
# WRONG — runtime rejects with E_WAVE_OVERSIZED
cleo orchestrate spawn-batch --tasks $(seq -s, T9301 T9320)   # 20 > 10
```

DO NOT spawn workers with `role=orchestrator`:

```json
// WRONG — would create a Lead-of-Leads recursion (LEAD-003)
{ "taskId": "T9301", "role": "orchestrator" }
```

## Sizing guidance

| Worker count | When to use | Notes |
|--------------|-------------|-------|
| 1–3 | Narrow waves; single-package changes | Minimal overhead, fast convergence |
| 4–6 | Typical IVTR implementation waves | Sweet spot for sonnet workers |
| 7–10 | Max-width parallel waves | Watch conduit signal volume; close to convergence-limit |
| >10  | Split across multiple Leads | Top Orchestrator spawns N Leads, each ≤10 workers |
