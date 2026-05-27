---
id: t10111-relates-remove-registry
tasks: [T10111]
kind: fix
summary: "Wire mutate:tasks.relates.remove in the operations registry so `cleo relates remove` succeeds"
---

`cleo relates remove <a> <b>` previously returned
`E_INVALID_OPERATION: Unknown operation: mutate:tasks.relates.remove`
because the operation handler was wired in the dispatch domain
(packages/cleo/src/dispatch/domains/tasks.ts) and listed in MUTATE_OPS,
but the contracts OPERATIONS registry never declared it. The dispatcher
falls back at the `resolve()` registry lookup before reaching the
handler.

Fix:

- Add `mutate:tasks.relates.remove` entry to
  `packages/contracts/src/dispatch/operations-registry.ts` with
  `requiredParams: ['taskId', 'relatedId']` and an optional `type` flag
  to match the existing CLI + dispatch-domain shapes.
- Update the operations-registry snapshot.
- Regression-lock with two new tests:
  - `packages/cleo/src/dispatch/__tests__/registry.test.ts`: `resolve()`
    finds the entry and reports the right required params.
  - `packages/core/src/tasks/__tests__/relates.test.ts`: round-trip —
    `addRelation` → `listRelations` (count=1) → `removeRelation` →
    `listRelations` (count=0); plus typed/untyped + missing-task cases.

Unblocks ADR-073 I7 cleanup. Verified end-to-end against the built CLI:
`cleo relates remove T9799 T9831` now returns a success envelope with
`{from, to, removed: true}`; invalid IDs return an `E_VALIDATION_FAILED`
envelope.
