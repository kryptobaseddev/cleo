---
id: ci-evidence-unretried-timeout
tasks: [T14086]
kind: fix
summary: "ci: evidence looks past a later main run whose only failure was a test timeout the quarantine budget never retried"
---

The stand-in search for `ci:<pr>` refused at the first later default-branch
run with any non-quarantined failure. On main 891e827e4 (blocking T13287's
`ci:1934`) that failure was a 5000 ms timeout of a whole-tree lint test in a
run the flaky-quarantine budget stopped before its rerun-once flake rule could
judge it. For later runs only, a failing test whose error is vitest's "Test
timed out" now counts like a quarantined one in such a budget-cut run, so the
search moves on to the next decisive run; an assertion failure still refuses,
and the merge commit's own run never gets this allowance. The atom records
each run it looked past in `passedOverRuns`.
