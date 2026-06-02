---
id: pmcore-quickfix-relates-batch-mixed-ac
tasks: [T11575, T11576]
kind: fix
summary: register relates.add-batch operation (T11575) and guard mixed parent-text-AC plus children for new work (T11576)
---

Two PM-Core V2 "agent-trust" quick fixes from the saga T10538 audit, both in service of "Tasks work flawlessly".

T11575 — `cleo relates add-batch` failed with `E_INVALID_OPERATION` before reaching its handler. The handler (`dispatch/domains/tasks.ts`) and CLI command (`cli/commands/relates.ts`) shipped, but no `relates.add-batch` OperationDef existed in the OPERATIONS registry, so `resolve()` returned undefined and the dispatcher rejected the call; the op was also absent from the tasks-domain `MUTATE_OPS` allowlist. Both are now registered, so the command reaches the handler for dry-run and real writes.

T11576 — `cleo add` silently mixed a parent's own free-text acceptance criteria with machine-managed `child_task` projections, turning a leaf into a half-defined container by surprise. `addTask` now rejects (clear `E_CLEO_VALIDATION` error with an actionable fix) adding a child under a `task`/`subtask` parent that already owns free-text ACs. Epics and sagas are exempt — they are containers by design and legitimately carry text ACs alongside child projections (the canonical PM-Core V2 shape). The guard runs during validation so dry-run and real adds behave identically.
