---
id: pmcore-donetrust-agent-trust
tasks: [T10538]
kind: fix
summary: PM-Core V2 agent-trust completion — cancelled children require a waiver (DP4) and add-under-done-parent reopens the ancestor (DP5)
---

Fixes two PM-Core V2 "agent-trust" completion defects flagged by the saga T10538 audit. Both let a parent be marked `done` while the work was not actually done, eroding trust in task state.

**Design-point 4 — cancelled children no longer silently satisfy parent completion.**
The premature-close guard and the epic / coordination-parent auto-rollup paths previously filtered `cancelled` children out of the completion check, so a parent completed as if the cancelled work had shipped. Completing a parent that has an un-waived `cancelled` child is now rejected with `E_CANCELLED_CHILD_NO_WAIVER` (exit 109); the auto-rollup paths no longer auto-close such a parent. To close it, supply `cleo complete <parentId> --waive-cancelled-children "<reason>"` (cite a replacement task id when applicable) — the waiver is audited to `.cleo/audit/cancelled-child-waiver.jsonl`. The existing T10554 `evaluateCompletion` waiver/replacement model was written but unwired; this change wires the equivalent runtime gate into `completeTask`.

**Design-point 5 — adding a child under a `done` parent reopens the ancestor chain.**
`cleo add --parent <doneEpic>` injected an unsatisfied `child_task` AC into a completed parent with no ancestor reopen, leaving a silently-stale `done` parent. Now the done parent (and any done ancestors) are reopened to `pending` — reusing the canonical `coreTaskReopen` semantics (clear `completedAt`, preserve completion history in notes) — and the reopen is surfaced on the add result as `reopenedAncestors` plus a warning.

The CleoError code/details/fix from these gates are now preserved end-to-end (the `taskComplete` / `completeTaskStrict` catches route through `cleoErrorToEngineResult` instead of flattening every guard rejection to `E_INTERNAL`, which also restores fidelity for the pre-existing `E_EPIC_HAS_PENDING_CHILDREN` guard).

New tests in `packages/core/src/tasks/__tests__/agent-trust-completion.test.ts` cover both design points (block + waiver-success + audit + reopen). Four existing tests that encoded the old broken behavior (cancelled-sibling auto-close / ignore) were updated to the design-point-correct behavior.
