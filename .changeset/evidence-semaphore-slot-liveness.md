---
id: evidence-semaphore-slot-liveness
tasks: [T12113]
kind: fix
summary: evidence tool slots are released by holder liveness, not by a 10-minute mtime timeout, and the busy error names the holder (gh#1222)
---

A `cleo verify` whose parent shell died left its semaphore slot held.
`proper-lockfile` decides staleness from the lock's mtime, refreshed on a
timer while the holder lives, so an orphan was indistinguishable from a
legitimately long-running suite: both simply waited out `staleMs`, 10 minutes
by default. On a box where evidence runs are frequent, one orphan blocked
every later verify with `E_EVIDENCE_TOOL_BUSY` — and the error named no
holder, so it read as a broken semaphore rather than a stuck one.

Slots now carry a holder record (pid, host, acquisition time), and liveness is
decided by process existence rather than elapsed time: a dead pid on this host
is orphaned now, not in ten minutes. The busy timeout error names every
current holder and flags any that are dead.

Reaping fails SAFE — an unknown holder, a holder on another host, or any error
counts as ALIVE, because reaping a live holder's slot would let two heavy
suites run against one bound, which is the oversubscription the semaphore
exists to prevent.

`listSlotHolders` and `reapOrphanedSlots` are exported to back an
operator-facing lock inspection surface.
