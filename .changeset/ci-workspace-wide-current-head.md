---
id: ci-workspace-wide-current-head
tasks: [T14032]
kind: feat
summary: "ci:<pr> for a workspace-wide change accepts green required CI on the current default-branch HEAD when the merge commit's CI is red"
---

A change to the lockfile, a root config or another path outside every package
is workspace-wide: a targeted `test-run:` cannot speak for it, so only
`tool:test` or `ci:<pr>` could prove it. When its merge-commit CI went red for
a reason that was not the change (a secrets job failing on a re-run), and later
commits touched its files, the T12742 descendant rule refused and nothing
honest remained.

`ci:<pr>` now has one more route for a workspace-wide change only (owner
decision D11192): a green `push` run of every required check, and of the
gates' jobs, on the default branch's current HEAD stands in. It must descend
from the merge. A first-parent commit before HEAD also counts when it differs
from HEAD only in documentation. A red or pending decisive run refuses. The
atom records `workspaceWide`, and `cleo complete` re-checks that push run. A
scoped change keeps the T12742 rule alone. The refusal and the evidence
briefing name the route.
