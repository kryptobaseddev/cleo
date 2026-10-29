---
id: backup-list-window-note
tasks: [T14150]
kind: fix
summary: "cleo backup list says how far back it looked for failed session-end runs"
---

Failed or skipped session-end runs are read from the last 200 lines of the
session-end worker log, so an older failure drops out of `cleo backup list`.
Each such entry now carries a `note` naming that window and how many failed
or skipped runs it found, so the limit is visible instead of silent.
