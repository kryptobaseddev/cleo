---
id: t13703-broken-worktree-refused
tasks: [T13703, T13702]
kind: fix
summary: a test-run or qa-run is refused when its worktree cannot be opened by git, and a stale verdict names the reflog it read
---

Evidence reads ignore exported `GIT_DIR`/`GIT_WORK_TREE`. A linked worktree
whose `.git` link points at a moved main repository works for its owner only
with those exported, so every freshness and coverage probe failed there and the
receipt was judged against nothing: on 2026.10.12 a stale receipt passed, and
with the tree capture also ignoring the exported pointers it would have been
recorded with no binding at all. A test-run or qa-run whose bind root git
cannot open on its own (a `.git` that does not resolve, or `GIT_DIR`/
`GIT_WORK_TREE` exported over a non-checkout) is now refused with
`E_EVIDENCE_GIT_ROOT`, naming `git worktree repair` and `CLEO_EVIDENCE_GIT_ROOT`.
A genuine non-git root keeps its no-binding behaviour.

A stale verdict for "HEAD as of the run is not in the reflog" now names the
worktree and the reflog file it read, and says that a receipt must stay in the
worktree it ran in: the reflog consulted is that of the worktree holding the
receipt, so a receipt copied into a newer worktree is judged there (T13702).
