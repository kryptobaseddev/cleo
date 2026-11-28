---
id: worktree-dispose-detached-by-path
tasks: [T14627]
kind: fix
summary: "cleo worktree prune now disposes clean detached worktrees with only build output, destroy takes --path, and projects declare build output in build.outputPaths"
---

A taskless detached worktree at a commit already on main (`p0caps-main`,
`release-23`) was never pruned: ignored build output was exempt only for a
worktree whose own merged commits are not on main's first-parent line, which a
detached checkout of a main commit never has. The listing, prune and destroy
now exempt ignored build output whenever the disposal engine's commit proof
holds, which is the guarantee the source that rebuilds it survives.

- `cleo worktree destroy --path <p>` disposes a registered linked worktree by
  its exact path through `disposeWorktree`. It accepts only a worktree under
  the project's canonical worktree root that no task names (a task worktree is
  refused with the `cleo worktree destroy <taskId>` to run), refuses the main
  checkout and any directory git has not registered, keeps a worktree a
  process has its cwd or an open file in, and deletes no branch for a
  detached checkout.
- List and prune consider a worktree that names no task only under the
  canonical worktree root, and keep one a process is using.
- `build.outputPaths` in `.cleo/project-context.json` declares build output
  beyond `dist/`, `.turbo/`, `coverage/` and `*.tsbuildinfo` (globs, read from
  the main checkout). Only plain globs that start with a literal path segment
  are accepted: a wildcard first segment (`**`, `*/dist`), a segment starting
  with `.`, braces, brackets and extglobs are refused, since each can reach
  ignored files such as `.env` or a local key. Ignored content outside those still keeps a worktree.
  This repository declares `packages/cant/napi`, compiled `extensions/` output
  and `packages/**/__pycache__`.
