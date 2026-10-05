---
id: t13206-trigger-scan-comma-join
tasks: [T13206]
kind: fix
summary: cleo doctor sync-triggers checks every table of a comma-separated FROM list, not only the first
---

review-p0 LOW on #1860. The trigger scan judged only the first table after FROM, so a dropped table named after a comma (FROM b, gone) went unreported. The scan now walks the whole FROM list, skipping aliases and table-valued functions.
