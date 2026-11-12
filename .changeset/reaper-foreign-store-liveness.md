---
id: reaper-foreign-store-liveness
tasks: [T14499]
kind: fix
summary: "Worktree reaper: keep foreign checkouts when immutable worker liveness is uncertain"
---

Decide project ownership before the reaper accesses worker records. Own projects
retain their normal worker, lease and process checks. Foreign projects use the
census's immutable store reader, with no migrations, restoration or sidecars;
nonempty WAL files, open executors and unreadable stores keep the checkout with
`unknown (foreign project)`.
