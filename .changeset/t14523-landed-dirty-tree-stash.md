---
id: t14523-landed-dirty-tree-stash
tasks: [T14523]
kind: fix
summary: "Refuse a dirty checkout for landed-commit evidence; stash, never commit, unreviewed edits"
---

`cleo done --commit` now refuses tracked edits in the checkout the tools run
in, as the branch and PR sources do. For a merged PR or landed commit the
dirty-tree remedy stashes the edits instead of `git commit -am`: a local commit
would still contain the reviewed commit, so the tools would measure unreviewed
edits. Untracked worktree-include files such as `.npmrc` remain allowed.
