---
id: critical-gate-refusal
tasks: [T12160]
kind: fix
summary: The critical-gate refusal no longer proposes the bypass as its own remedy, and the override path applies the per-gate minimum
---

**gh#1278.** Two halves of one defect in `validation/engine-ops.ts`, fixed
together because either alone leaves the other live.

**(a) The override branch skipped the per-gate minimum.** The non-override path
applies `checkGateEvidenceMinimumDetailed` to every target gate; the override
path stopped at the T9245 hard-atom check. Since `files:` is a hard atom, it
cleared that check and satisfied `testsPassed` through the override route — the
same evidence the ordinary route correctly refuses. **Override evidence was
weaker-gated than ordinary evidence, on the one gate where that matters most.**

The new check is scoped to `criticalTargets` deliberately, not to all targets:
`qaPassed`, `documented`, `securityPassed` and `cleanupDone` legitimately pass on
override-only evidence per ADR-051, and widening it would break that.

**(b) The refusal advertised the evidence the gate rejects.**
`E_CRITICAL_GATE_OVERRIDE_REJECTED` interpolated the refused gate into a
*fixed* atom list, so refusing `testsPassed` printed:

```
Re-run 'cleo verify T123 --gate testsPassed --evidence "commit:<sha>;files:<paths>"'
```

A reader following that verbatim lands straight back on a refusal. It also
asserted "Critical gates require a hard atom (commit/files/test-run/tool)" —
true of the T9245 check it had just applied, false of what `testsPassed`
actually requires.

The remediation is now derived from the refused gate's own minimum and returned
through `engineError`'s `fix` field, so the message cannot drift from the rule
again.

**This is the same geometry as `tasks_acceptance_projection_state` (gh#1290): a
surface whose advice is computed independently of the rule it describes.** The
rule was correct and enforced; the sentence next to it was assembled separately
and was free to disagree. ADR-092 material.

Both new tests were run against the unfixed code first — **2 failed, 13 passed**
— so neither is vacuous.
