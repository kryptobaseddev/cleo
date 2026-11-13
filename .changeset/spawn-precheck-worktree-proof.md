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
- The disposal proof treats CLEO's pnpm provisioning as regenerable, but only
  what it can attribute. The first part is the worktree's `.pnpm-store/`, when
  it is a real directory and every entry under it is pnpm's own. That means
  sha512-named content files and package index files in two-hex shard
  directories, hex-named symlinks under `projects/`, and an empty `tmp/`. A
  file named `.pnpm-store`, a symlink, any foreign file, or anything left in
  `tmp/` keeps the worktree. The second part is an `.npmrc` that is byte-for-byte
  what provisioning wrote for that worktree. Provisioning records those bytes in
  the worktree's git admin dir. Both the `.npmrc` and that record must be
  regular files with one link, and the record must be outside the worktree, so
  an `.npmrc` linked to the record and edited through the link is kept. A
  worktree provisioned before this change matches only the bare
  `store-dir=<worktree>/.pnpm-store` line, and the proof never consults the main
  checkout's current config. Existing finished, merged worktrees whose only
  extra content is that `.npmrc` become prunable.
