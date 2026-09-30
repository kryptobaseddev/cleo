---
id: t12817-memory-observe-silent
tasks: [T12817]
kind: fix
summary: cleo memory observe --agent no longer exits 0 with empty stdout and nothing stored; memory recent/diary/watch read the real narrative column instead of silently returning empty lists
---

**Silent observe.** An observation with `--agent` and a mental-model type
(`discovery`, the default, `decision`, `change`, `feature`, `bugfix`,
`refactor`) was routed through the mental-model queue, whose only drain a
one-shot process could reach was an unref'd 5 s timer. The awaited promise
could never settle, the event loop emptied, and Node exited 0 with zero bytes
on stdout — the observation was lost. Session binding played no part. Every
`enqueue` now schedules a prompt drain on the next macrotask (a ref'd
`setImmediate`), drains are serialised so entries enqueued during an in-flight
drain are picked up, and every caller's promise settles. Fixes every
`memoryObserve` caller (`memory observe`, `memory diary write --agent`,
orchestrate pivot, sentient hygiene/dream).

**Empty reads.** `memory recent`, `memory diary read` and `memory watch`
selected a `text` column `brain_observations` never had and swallowed the
error, so they always reported `count: 0`. They now select
`narrative AS text`, and a failing query returns an error envelope instead of
an empty list. The pending-transcript scanner had the same column bug.
