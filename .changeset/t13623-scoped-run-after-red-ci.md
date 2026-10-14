---
id: t13623-scoped-run-after-red-ci
tasks: [T13623]
kind: fix
summary: cleo complete accepts a covering test-run on main when merged CI was red or skipped, and a scheduled run no longer decides a merge commit's CI
---

Once a change merged, `cleo complete` proved testsPassed only from the merged
PR's required CI. When that CI was red (often for an unrelated, main-wide
reason) or its required jobs were skipped, the only remedy it offered was a
full local `tool:test`, which agent machines must not run. The task could not
be completed at all.

Now a targeted `test-run:` recorded on the default branch after the merge
stands in for testsPassed when merged CI concluded without proving the change.
It fails closed: every report must carry the HEAD and tree it was bound to,
that HEAD must descend from the merge commit, the tree must still be the
current one (a report that predates a later edit is refused), and the reports
together must cover the change's own files (every affected package with tests,
and every test file the change added or edited). A refusal names this remedy
and says why the recorded run did not qualify.

The merge-commit verdict also ignored the event that started a run, so a
nightly `schedule` run that happened to land on a merge commit could turn a
green push run red. Scheduled runs are now dropped before the verdict: only the
merge commit's push run, a tree-equal PR head's pull_request run, or a later
main commit's push run (T12742) decides it.
