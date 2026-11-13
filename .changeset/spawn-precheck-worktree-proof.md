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
- The disposal proof treats CLEO's pnpm provisioning as regenerable. The first
  part is the worktree's `.pnpm-store/`, only when it is a real directory laid
  out as a pnpm store. A file named `.pnpm-store`, a symlink, or any unexpected
  name inside the store keeps the worktree. The second part is an `.npmrc` that
  is byte-for-byte what provisioning wrote for that worktree. Provisioning now
  records those bytes in the worktree's git admin dir. A worktree provisioned
  before this change matches only the bare `store-dir=<worktree>/.pnpm-store`
  line, and the proof never consults the main checkout's current config.
  Existing finished, merged worktrees whose only extra content is that `.npmrc`
  become prunable. An edited `.npmrc` or any other untracked file still keeps
  the worktree.
