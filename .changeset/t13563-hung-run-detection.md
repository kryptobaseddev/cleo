---
id: t13563-hung-run-detection
tasks: [T13563]
kind: fix
summary: "cleo run reports an admitted run that overstays its class limit or hangs, without killing it"
---

An admitted `cleo run` now measures its command's whole process tree (CPU time
and resident memory, one `ps` every 30 s). A run past its class's maximum wall
time (test and full builds 60 min, scoped builds 30 min) is reported as
`overdue`; a tree that used no CPU for 10 minutes is reported as `hung?` with
its pid, session and command. Both print on the runner's stderr, so the owner
sees them, and nothing is stopped: the reservation still ends only when the run
exits. Override with `CLEO_RUN_MAX_WALL_MIN` and `CLEO_RUN_IDLE_MIN`.

`cleo doctor tool-locks` shows, for each `cleo run` holder, its session, charged
against measured memory, CPU time, elapsed and idle time and whether it is
overdue or hung, plus `overdueCount` and `hungCount`.
