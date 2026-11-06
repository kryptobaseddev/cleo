---
id: merge-attribution-attempt-pin
tasks: [T14253]
kind: fix
summary: "the merge attribution receipt pins the CI run attempt and judges the first parent at the same point in time"
---

GitHub's `commits/<sha>/check-runs` keeps only each job's latest attempt, so a
rerun replaced the evidence a receipt was judged on: #1980's merge and parent
showed a 2026-10-12 rerun that died on a missing build artifact, and #1910 a
full rerun seven days after its merge.

The receipt now reads jobs per run attempt
(`actions/runs/<id>/attempts/<n>/jobs`):

- each merge job is judged at its first attempt; a same-day rerun that passed
  it on the same sha counts, a failing, crashed or later rerun never does;
- the parent job is judged at its latest attempt that had started when the
  merge job did, never at a later rerun;
- the required aggregate (`CI`) is left out, since it only reports the jobs it
  needs;
- the receipt stores `mergeRuns` and `parentRuns` (run id, attempt,
  completion time), and a stored receipt is final.

A merge whose jobs passed except for cancelled ones is `superseded`, not
`clean`. Rule version 2.
