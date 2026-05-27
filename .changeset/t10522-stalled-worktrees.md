---
id: t10522-stalled-worktrees
tasks:
  - T10522
kind: feat
summary: Surface stalled dirty, unpushed, and stale worker worktrees in the orchestration dashboard.
releaseNotes:
  section: added
  audience:
    - operators
  scope: ops
  targets:
    - cleo orchestrate dashboard
  impact: Orchestrators can see worker worktrees that are stalled by dirty changes, unpushed commits, or stale status before dispatching more work.
  includeInChangelog: true
---

Adds stalled worktree counts and details to the multi-agent orchestration dashboard so dirty, unpushed, and stale worker worktrees are visible in the existing dashboard snapshot.
