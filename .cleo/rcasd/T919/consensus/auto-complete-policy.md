# Consensus: T919 — Task Auto-Complete Inconsistency (GH #94)

**Date**: 2026-04-18
**Task**: T919
**Reviewer**: cleo-worker (sonnet-4-6)

---

## Findings

### Root Cause

GH #94 reports that tasks with `verification.passed=true` and all gates green sometimes
auto-transition to `done`, while other tasks stay `pending`. Examples: T448/T466 stayed
pending; T445 "auto-completed" in the same session.

After tracing the code:

1. `validateGateVerify` (validate-engine.ts:900–1143) sets `verification.passed` and saves
   the task — it **never touches `task.status`**. There is no auto-complete-on-verify path.

2. The ONLY auto-complete path is in `completeTask` (complete.ts:267–292): when `cleo complete
   <child>` is called and ALL siblings of a parent epic are done/cancelled, the parent epic
   itself is auto-completed. This is correct behavior, not a bug.

3. T445 "auto-completing" was almost certainly the **parent epic** of T445 being auto-completed
   when T445 was the last pending sibling — not T445 itself transitioning without `cleo complete`.

4. The actual bug is a **UX gap**: after `cleo verify <id> --gate <g> --evidence ...` drives
   `verification.passed` to `true`, the CLI output returns `verificationStatus: 'passed'` and
   `missingGates: []`, but **emits no actionable hint** directing the user to run `cleo complete`.
   Users reasonably expect the task to finish automatically, causing confusion.

### Code Locations

| File | Relevant section |
|------|-----------------|
| `packages/cleo/src/dispatch/engines/validate-engine.ts:1065` | `verification.passed = computePassed(...)` — sets passed flag, never sets status |
| `packages/cleo/src/dispatch/engines/validate-engine.ts:1112-1138` | Result assembly — where the "hint" should be added |
| `packages/core/src/tasks/complete.ts:267-292` | Epic auto-complete — triggered by `cleo complete`, NOT by `cleo verify` |
| `packages/core/src/tasks/__tests__/epic-auto-complete.test.ts` | Existing auto-complete tests (not affected by this change) |

---

## Policy Decision

**VOTE: APPROVE policy (b) — NEVER auto-complete + emit clear hint**

Rationale:
- Policy (a) (auto-complete on final gate) is dangerous: it removes human checkpointing and
  bypasses the ADR-051 evidence model which requires `cleo complete` to re-validate evidence.
- Policy (b) is already the implemented behavior. The fix is purely additive: add a `hint`
  field to `GateVerifyResult` and populate it when `verification.passed` transitions to `true`
  during a gate write.
- The hint makes the required next step explicit, removing the confusion documented in #94.

---

## Implementation Plan

### Change 1: Add `hint` field to `GateVerifyResult` (validate-engine.ts)

When `action` is `set_gate` or `set_all` AND `verification.passed === true` after the write,
populate `result.hint = "All gates green. Run: cleo complete <taskId>"`.

This is a purely additive, non-breaking change. The JSON envelope already passes through to
the CLI output layer.

### Change 2: Add tests

Add a test case in `validate-engine.ts`'s existing integration tests (or a new test file) that
verifies:
- Setting the final required gate triggers `hint` in the response.
- A partial gate set (not all gates green) does NOT emit `hint`.
- View-mode (no gate write) does NOT emit `hint`.

---

## Risks

| # | Risk | Likelihood | Severity | Mitigation |
|---|------|-----------|---------|-----------|
| 1 | `hint` field breaks downstream JSON consumers | Low | Low | Field is additive; consumers ignoring unknown fields are unaffected |
| 2 | Hint shown when task is already done (immutable path) | N/A | N/A | Immutable guard (line 924) rejects before this code runs |
| 3 | Epic auto-complete logic misread as the bug | Medium | Low | Documented in this consensus; no change to epic auto-complete path |
| 4 | Test environment uses `verification.enabled: false`, masking the hint | Low | Low | Hint is emitted from validate-engine, independent of complete.ts enforcement |
| 5 | Missing `hint` field type in contracts package causes type error | Medium | Low | Must update `GateVerifyResult` type in validate-engine.ts (inline type, not contracts) |

---

## Alternatives Rejected

| Option | Reason rejected |
|--------|----------------|
| (a) Auto-complete on final gate | Removes human checkpoint; breaks ADR-051 re-validation on complete |
| Remove epic auto-complete entirely | Not related to this bug; breaks intended behavior for epics |
| Add warning to `cleo complete` | Wrong direction: warning at complete time doesn't help users who are waiting |

---

## Decision

**APPROVE** — implement policy (b) with `hint` field. Zero behavior change; additive UX improvement.
