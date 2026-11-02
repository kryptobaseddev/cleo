---
id: invoking-checkout-checks
tasks: [T14183]
kind: fix
summary: "Repo-reading checks run from a CLEO worktree read that worktree, not the root checkout"
---

Run from a CLEO worktree, `cleo check canon`, `cleo check canon docs`,
`cleo check test` (status and coverage), `check test.run`, `check output` and
`cleo docs rot` read the root checkout's files, which can sit on another branch
(a stale root reported 129 doc-name violations that main does not have).

- They now read the checkout the command was started from, through the
  release verbs' resolver (T14160), now shared as `resolveInvokingCheckout`.
- An explicit `CLEO_ROOT` / `CLEO_PROJECT_ROOT` still wins.
- The task and docs stores stay at the project root.
