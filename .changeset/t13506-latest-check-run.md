---
id: t13506-latest-check-run
tasks: [T13506]
kind: fix
summary: "pr: evidence lets the latest run of a re-run check decide, so a PR re-run to green can be proven"
---

A PR's `statusCheckRollup` lists every run of a check on its head. When a
required check failed (for example while main was red) and was re-run green,
the stale FAILURE stayed in the rollup, and an exact-name FAILURE is fatal, so
`cleo verify` refused the merged, green PR with "Required PR checks failed".
Re-runs of one check (same workflow and job name) now collapse to the latest
completed run; a check with only pending runs still reports pending, and a
latest run that failed is still fatal.
