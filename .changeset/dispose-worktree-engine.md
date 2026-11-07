---
id: dispose-worktree-engine
tasks: [T13924, T14276]
kind: fix
summary: "One worktree disposal engine: no path deletes uncommitted, untracked or unpushed work, a failed probe is never clean, and destroy --force archives first"
---

Seven paths deleted worktrees under three policies. `cleo complete` force-removed
a dirty worktree, `worktree prune --orphaned` and `gc worktrees` treated a failed
`git status` as clean, and `worktree destroy` never checked for unpushed commits.

Every path now calls `disposeWorktree` in `@cleocode/worktree`. A worktree is
removed only with proof that nothing in it is lost:

- nothing outside links into it, and no evidence lives only there;
- no tracked change, and every untracked or ignored path is `node_modules`,
  merged build output, or identical in the main checkout;
- every commit it holds is also on a remote or another branch;
- the caller's in-use probe (a task lock) answers no.

Every probe fails closed. Without proof the worktree is kept, untouched, with the
failing clause named. `cleo worktree destroy --force` is the only override: it
archives the worktree first, as a `refs/cleo/archive/<task>/<time>` ref holding
every commit and change (bar `node_modules`), plus a patch and a JSON receipt
under `.cleo/archive/worktrees/`, and removes it only once the archive is
verified. The dependents and evidence guard still holds under `--force`.

The tar quarantine that left dirty worktrees on disk beside an archive is gone:
kept worktrees are reported (`quarantined` in the prune results) and left as
they are. New arch gate 41 (`scripts/lint-no-raw-worktree-removal.mjs`) refuses
any source outside the engine that names a raw removal.
