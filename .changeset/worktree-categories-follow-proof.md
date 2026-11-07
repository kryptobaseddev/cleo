---
id: worktree-categories-follow-proof
tasks: [T14274]
kind: fix
summary: "cleo worktree list reports active, redundant, keep (with a reason) or unknown from the disposal proof; prune --orphaned acts only on redundant rows"
---

`cleo worktree list` classified worktrees with guesses: `merged` counted a
branch with no commits as merged, `orphan` needed a task id that `fix/` and
`test/` branches never yielded, and `stale` was an age guess. A worktree is now
classified by the same proof that disposes of it (`disposeWorktree`, dry run):

- `active`: the primary checkout, a worktree whose task is open, or one with no
  stored task that was active within the stale window. Never pruned.
- `redundant`: its task is done or cancelled (or it has no task and has been
  idle past the window) and nothing in it would be lost.
- `keep`: the same candidates when the proof fails; `keepReason` names the
  clause (uncommitted changes, commits on no remote, something linking into
  it, a task lock held).
- `unknown`: a probe could not answer (a git error). Never redundant.

`isStale`, `isMerged` and `isLocked` remain as annotations.
`cleo worktree prune --orphaned` acts only on `redundant` rows and re-proves
each one before removing it. The orchestrate dashboard counts the four
categories plus the `stale` annotation.
