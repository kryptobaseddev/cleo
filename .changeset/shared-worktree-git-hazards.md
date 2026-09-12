---
id: shared-worktree-git-hazards
tasks: [T12161]
kind: fix
summary: cleo doctor warns when a shared .git lets one session's stash or identity silently reach another
---

A `.git` directory shared by several worktrees also shares two things that
look tree-local and are not: the stash stack and the committing identity.
Both bit this repository on 2026-09-12, in separate incidents, hours apart,
and nothing warned in either case.

**The stash stack is repository-wide.** `git stash pop` with no argument takes
`stash@{0}` — whichever entry was pushed most recently by *any* worktree. An
agent ran `git stash push` on an untracked file (a no-op, so nothing of its
own was pushed) and then `git stash pop`, and silently received an unrelated
entry from a 26-deep stack belonging to another session's branch. It modified
a generated command manifest that agent had never touched. It was caught by
reading the diff before committing, not by tooling. The stack is not
transient: entries here date back months, across branches long since merged.

**`user.name` / `user.email` live in the shared config.** One session setting a
throwaway identity re-authors every commit made by every other session, in
every other worktree, until someone notices. A `compose probe <probe@local>`
identity left behind by a merge-composition experiment authored three commits
from a different session on a different branch before it was spotted in
`git log` for an unrelated reason.

Both checks run inside `cleo doctor` and are gated on the `.git` actually being
shared — a stash in a single-worktree repo is ordinary and private, and a new
identity there is usually just a new contributor. Warning about either would be
noise. Where several trees share one config, an identity that authored none of
the last 50 commits is a strong signal it was set by somebody else for
something else, and the remedy names the identity to restore rather than only
describing the problem.

Neither check mutates anything, and neither fails the doctor run: both report
`warning`, because a shared stash and a deliberate identity change are both
legitimate — the defect is that they are *invisible*, not that they are wrong.
