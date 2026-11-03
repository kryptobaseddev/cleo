---
id: branch-own-work
tasks: [T14191]
kind: fix
summary: "a task branch's work is its own first-parent commits, never the default-branch commits a later merge brought in"
---

`cleo done --plan` warned a docs-only PR that its task "owes the code gates:
its work touches .github/workflows/ci.yml", a file the PR never changed
(T14112, #2632). A task's own work and its branch change set were read as a
merge-base diff of each branch citing the task. When the branch merged a
newer default branch (GitHub's "update branch") and the local default-branch
ref was older than that merge, the diff included the default branch's
commits, here a ci.yml change.

Both now read the branch's own commits: its first-parent, non-merge commits
since the default branch. A merge of the default branch into the task
branch contributes nothing, a branch whose only commits are such merges has
no work, and the branch's own code changes are still found.
