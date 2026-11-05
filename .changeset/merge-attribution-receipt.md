---
id: merge-attribution-receipt
tasks: [T14252]
kind: feat
summary: "the merge sweep records an attribution receipt per merged PR (shadow): a test-level first-parent differential of its merge-commit CI"
---

Phase 1 of the durability program (D11224, Council change 1). For each
merged PR it closes tasks for, the merge sweep now computes, once per (PR,
merge sha), what the merge-commit CI shows about the PR itself and stores it
as a `merge_attribution` audit row:

- a failing test identity that also fails on the merge's first parent is
  `disjoint`; one new at the merge is `pr-caused` (`combination` when the
  PR head's own run passed that job), never excused;
- a job that failed in the same step as the parent's is `disjoint`; a
  quarantine-budget-only failure over a green parent is `budget-crossed`;
- cancelled or skipped runs, and jobs that tested nothing, are `superseded`;
  a green merge is `clean`;
- no parent observation (no run, a skipped matrix, a cancelled parent, an
  unreadable log, a parent seen at another point in time) is `unknown` with
  its reason.

Only failures that blocked the job count (after the CI re-run of failing
files). SHADOW: the receipt is listed beside each PR's outcome
(`attribution`) and changes no closure. Log reading reuses ci-evidence.ts
(`isQuarantineBudgetOnlyLog`, `untestedFailureCause`,
`isSetupStepFailureLog`, plus `blockingTestIds` and `failedStepOf` beside
them). At most 20 receipts are looked up per sweep.
