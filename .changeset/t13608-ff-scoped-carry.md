---
id: t13608-ff-scoped-carry
tasks: [T13608]
kind: fix
summary: "A scoped testsPassed now carries after a fast-forward or direct landing"
---

After a change merged, `cleo complete` accepts a scoped `testsPassed` only
when the tested tree matches the merged change. A change that reached the
default branch by fast-forward or direct push has no merge commit, so every
scoped run was refused with "the merge commit is not known here", even one
recorded at the landed HEAD. The check now compares the scoped run against the
newest landed implementing commit over the files the implementing commits
changed; it still refuses when main later edited one of those files.
