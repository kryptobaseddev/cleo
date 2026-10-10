---
id: t13398-global-trigger-suspend
tasks: [T13398]
kind: fix
summary: The global store gets cleo_trigger_suspend, so captured writes to global brain tables no longer fail
---

Every capture trigger reads `cleo_trigger_suspend`, but only the project store
created it: the open pass's step 0 ran for the project scope alone, and the
table's only migration is in the project folder. Since the global brain tables
gained row identity and capture triggers, turning `sync.capture` on in the
global store made every write to them fail with "no such table".

The open pass now runs step 0 in both scopes, and installing capture triggers
creates the table first when a handle lacks it. The table is classified
local-only in the global registry, as it already was for the project.
