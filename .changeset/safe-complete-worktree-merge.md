---
id: safe-complete-worktree-merge
tasks: [T14053]
kind: fix
summary: "cleo complete merges a task branch locally only for a CLEO-provisioned worktree into an untouched main checkout; --no-integrate and CLEO_NO_AUTO_WORKTREE_COMPLETE now switch it off, and done --plan shows the decision"
---

`cleo complete` ran a worktree integration after every completion: whenever a
`task/<id>` branch or a worktree existed, it checked out the default branch in
the main checkout, merged the branch with `--no-ff`, and deleted it. A
hand-made `task/<id>` branch was merged too. `CLEO_NO_AUTO_WORKTREE_COMPLETE`
gated only a second, later call, so the merge still happened while the
envelope's `worktreeAutoComplete` reported that it had been skipped.

- One decision, `decideWorktreeIntegration`, serves both the preview and the
  run. `cleo done <id> --plan` shows it as `integration: {branch, worktreePath,
  targetBranch, action: merge|skip|refuse, reason}` from local refs, and
  changes nothing in git.
- A merge happens only when the worktree lifecycle audit records that CLEO
  created or adopted the task's worktree. Any other `task/<id>` branch is
  skipped with a reason and left untouched.
- The merge is refused when the main checkout has uncommitted tracked changes,
  is on a branch other than the default, or is a linked worktree. CLEO never
  switches the checkout, so it stays on the branch it started on.
- `cleo complete --no-integrate` (also on `cleo done`) and
  `CLEO_NO_AUTO_WORKTREE_COMPLETE=1` skip the integration call itself.
- The completion runs one integration call and reports one result,
  `integration: {action, mergeCommit?, targetBranch, pushed: false, reason}`.
  The merge is never pushed.

**Breaking output change.** The `cleo complete` envelope no longer carries
`worktreeAutoComplete`. Read `integration` instead. The exports
`maybeAutoCompleteWorktreeForTask` and `AutoCompleteWorktreeResult` were
removed from `@cleocode/core`.

**Stricter than before.** A clean main checkout that is on a branch other than
the default is refused, not switched. A worktree created before this change has
no lifecycle `create` row, so it is now skipped rather than merged. To recover,
run `cleo worktree adopt <worktree path> --task-id <id>`, which records an
`adopt` row that counts as provisioned. You can also land the branch through a
PR.

`cleo orchestrate worktree-complete` uses the same rules: it reports a branch
CLEO did not provision as `noop` and a refused checkout as `conflict`, with
recovery steps.
