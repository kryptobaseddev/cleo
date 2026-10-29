---
id: t14154-lease-dead-root
tasks: [T14154]
kind: fix
summary: "an agent-session lease whose project root no longer exists no longer holds a slot"
---

A removed project or worktree runs no session, so a lease taken for it now
counts as dead and its file is removed when leases are counted. The root is
checked with one `stat` each time, never cached. Only a missing root (ENOENT)
counts: a permission error or an unreadable mount keeps the lease, so
admission fails closed. This also stops successful spawns in different test
files of one vitest fork from adding up to a full budget on a small runner.
