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

**Timings.** Measured on a Mac mini (Mac17,16, Apple M5 Pro, internal APFS SSD) with synthetic
stores: 70 MB copies in 0.29 s and 1 GB in 2.4 s. A slow or FUSE-mounted disk can be 20–50 times
slower.

**Fix.** The threshold is now `GLOBAL_BACKUP_LOCK_STALE_MS`: 10 minutes, at least three times the
worst case, matching `EXODUS_LOCK_STALE_MS`.

**Discard on compromise.** A lock reported compromised is recorded instead of thrown, and the copy
made under it is discarded. So is a copy that outlasted the stale window: the copy blocks the event
loop, so a compromise could surface only after it. The copy is written under a temporary name and
published by a rename only if neither happened. A discarded copy is deleted with nothing renamed,
listed or rotated, and a warning is logged.
