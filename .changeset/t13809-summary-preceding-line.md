---
id: t13809-summary-preceding-line
tasks: [T13809]
kind: fix
summary: ci evidence refuses a quarantine-budget log whose last vitest summary follows unprefixed child output
---

The quarantine-budget check reads the run's own final vitest summary. A full summary a child vitest echoed through inherited stdio (no `stdout |` prefix), followed only by more unprefixed child output and a kill mid-test, still read as the run's own. The line right before the summary's `Test Files` line must now be blank or a test-result line, as vitest prints it; anything else refuses.
