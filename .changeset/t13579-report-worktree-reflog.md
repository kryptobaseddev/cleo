---
id: t13579-report-worktree-reflog
tasks: [T13579]
kind: fix
summary: "test-run and qa-run freshness read HEAD-as-of-run from the reflog of the worktree that holds the report"
---

A HEAD reflog is per worktree. A report produced in one linked worktree and verified from a newer worktree, whose reflog starts after the run, was refused as stale ("HEAD as of the run is not in the reflog, so what the run saw is unknown") even when its content was identical. When the report file lives in another linked worktree of the same repository (same git common dir), freshness now reads HEAD as of the run from that worktree's reflog; otherwise from the bound checkout's, as before.
