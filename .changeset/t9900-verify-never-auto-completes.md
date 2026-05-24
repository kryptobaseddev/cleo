---
id: t9900-verify-never-auto-completes
tasks: [T9900]
kind: docs
summary: "GH #94 / T9900: document the canonical contract — cleo verify NEVER auto-completes (verify→complete is explicit)"
---

Resolves the GH #94 auto-complete inconsistency report by documenting
the canonical contract in `docs/specs/CLEO-TASKS-API-SPEC.md §7.1`:
`cleo verify` is scoped exclusively to `task.verification.*` and MUST
NEVER mutate `task.status`. Closing a task is a separate, explicit
`cleo complete <id>` action that re-validates evidence atoms
(E_EVIDENCE_STALE protection).

This is the policy already implemented in
`packages/core/src/validation/engine-ops.ts` (policy (b)); the hint
field `"All gates green. Run: cleo complete <id>"` is emitted on every
gate write that drives `verification.passed = true`. The change here
is doc + a GH #94 reproduction test in
`packages/core/src/validation/__tests__/gate-verify-hint.test.ts`
that explicitly asserts `task.status === 'pending'` is preserved
after all gates green (the exact scenario T448 / T466 hit).

No production code behavior change.
