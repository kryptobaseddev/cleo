---
id: git-command-running-forms
tasks: [T14398]
kind: fix
summary: "cleo run keeps git rebase --exec, bisect run, submodule foreach and filter-branch on the class plan"
---

`cleo run` charged every git subcommand but gc, repack, fsck and clone light,
so `git rebase -x 'pnpm test'`, `git bisect run pnpm vitest` and
`git submodule foreach 'pnpm build'` ran their heavy commands under a 1 GiB
charge. A git command that runs a command of the caller's now keeps its class
plan. `git rebase` also lists `post-checkout` among the hooks it may run.
