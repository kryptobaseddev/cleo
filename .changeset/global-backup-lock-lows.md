---
id: global-backup-lock-lows
tasks: [T13299, T13293]
kind: fix
summary: "Global backup lock: stale clock starts at acquisition; a lost lock is abandoned, never removed; orphaned copies swept"
---

Three follow-ups to the single-flight session-end global backup (#1948 review):

- The stale-window clock starts when the lock is taken, so a slow `db-heavy`
  admission counts against it. A lock held past the window still discards
  the copy instead of publishing it.
- A lock that was lost, or held past its stale window, is abandoned rather
  than released. proper-lockfile's release and its exit hook remove the lock
  directory without checking who owns it, which could delete the lock of the
  process that took it over. The new `acquireAbandonableLock` routes the
  lock's file operations through a guarded fs, so after `abandon()` neither
  path touches the directory. A directory that was still ours is already
  stale, and the next taker reclaims it.
- `cleo.db.<id>.tmp` copies (and their SQLite sidecars) left by a backup
  killed mid-copy are swept from the global backup directory, under the lock,
  once they are older than the stale window.
