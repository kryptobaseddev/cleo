---
id: spawn-precheck-worktree-proof
tasks: [T14552]
kind: fix
summary: "cleo orchestrate spawn no longer times out on projects with many worktrees, and finished worktrees holding only CLEO's pnpm .npmrc are pruned"
---

A tier-1/2 spawn ran the full worktree disposal proof for every worktree, once in
the atomicity pre-check and again in the real prompt, through the dashboard line.
On a project with 183 worktrees that took about 200 s and the spawn failed with
`E_TIMEOUT` at `validate-readiness`.

- The pre-check now composes only what the atomicity verdict needs, with no
  dashboard, attention digest or attachments. A spawn under
  `--orchestrator-defer` no longer spends its budget before the waiver applies.
- The spawn prompt's dashboard line reads one `git worktree list` and the owning
  task statuses. Finished worktrees are counted as unproven, and no disposal
  proof runs. `cleo orchestrate dashboard` still runs the proof.
- Provisioning now also excludes the untracked store-dir `.npmrc` through
  `info/exclude`, so a fresh worktree has no untracked file. A tracked `.npmrc`
  is still never edited.
- The disposal proof treats CLEO's pnpm provisioning as regenerable: the
  worktree's `.pnpm-store/`, and an `.npmrc` that holds only the main checkout's
  lines plus `store-dir=<worktree>/.pnpm-store`. Existing finished, merged
  worktrees whose only extra content is that `.npmrc` become prunable. Any other
  untracked file, or an `.npmrc` with any other line, still keeps the worktree.
