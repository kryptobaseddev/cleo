---
id: t13293-global-backup-lock-stale
tasks: [T13293, T13286]
kind: fix
summary: the session-end global backup lock outlasts a blocking VACUUM INTO, so a long copy is never taken over by a second one
---

The single-flight lock around the session-end global backup (T13286) was stale after 60 s. Its
`VACUUM INTO` is synchronous: while it runs, the event loop is blocked and proper-lockfile cannot
refresh the lock. A copy longer than 60 s could therefore have its lock taken as stale by another
session end, which then started a second full copy.

**Timings.** Measured on an SSD: 70 MB copies in 0.29 s and 1 GB in 2.4 s. A slow or FUSE-mounted
disk can be 20–50 times slower.

**Fix.** The threshold is now `GLOBAL_BACKUP_LOCK_STALE_MS`: 10 minutes, at least three times the
worst case, matching `EXODUS_LOCK_STALE_MS`. A compromised lock is logged instead of thrown.
