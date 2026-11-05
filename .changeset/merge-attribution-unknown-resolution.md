---
id: merge-attribution-unknown-resolution
tasks: [T14255]
kind: feat
summary: "an unknown merge attribution resolves only on a later green main run that contains the change, with no rerun"
---

An `unknown` receipt (no parent observation) never closes a task by itself.
The merge sweep now looks for a later main commit that contains the change:
a first-parent descendant of the merge, or, when the merge is no longer on
main, the main commit carrying the same patch (`git patch-id`) and its
descendants. When every job the receipt left undecided has a completed green
run there (each at its first attempt), the receipt records `resolution`
(`holds-on-main`, that commit, how it contains the change, and the run
attempts). A red run moves on to the next commit and a running one waits;
nothing triggers a rerun. Each look reads at most 20 commits and records
`unresolvedThrough`, so the next sweep continues after it (no window). The
verdict stays `unknown`, and in shadow mode nothing closes on it.
