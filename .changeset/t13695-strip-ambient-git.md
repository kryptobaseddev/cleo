---
id: t13695-strip-ambient-git
tasks: [T13695, T13697]
kind: fix
summary: evidence and typed-gate git reads use the resolved tree, never an inherited GIT_DIR or GIT_WORK_TREE
---

The HEAD, tree hash and dirty-tree fingerprint behind the tool cache, the
typed-gate cache and a test-run's tree binding (`captureHead`, `captureTree`
and every git call inside it, `captureDirtyFingerprint`, gate-runner's own git
reads, and the evidence execution root's toplevel probe) ran `git` with the
inherited environment. An
exported `GIT_DIR` therefore made `git -C <tree>` read a different repository
whenever the two disagreed. Since T13649 the tree comes from the evidence
declaration (`CLEO_EVIDENCE_GIT_ROOT`, `GIT_WORK_TREE`, `evidence.gitRoot`) or
the invocation directory, so these reads now drop `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_COMMON_DIR`, `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY`, as directory
discovery already did. Exporting `GIT_DIR` and `GIT_WORK_TREE` to a worktree
still works: `GIT_WORK_TREE` is read as the declaration.
