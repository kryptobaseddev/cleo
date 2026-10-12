---
id: t13602-cloud-status-autosync-suppressed
tasks: [T13602]
kind: fix
summary: "cleo cloud status says when CI or a test runner suppresses background auto-sync"
---

Background auto-sync never starts under a test runner or CI. `cleo cloud
status` now reports that with a `W_AUTO_SYNC_SUPPRESSED` warning naming the
variable (`CI`, `VITEST` or `NODE_ENV=test`), so a machine that never syncs in
the background explains why. The spawn guard and the status read the same
predicate.
