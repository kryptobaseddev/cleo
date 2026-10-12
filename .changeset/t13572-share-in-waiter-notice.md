---
id: t13572-share-in-waiter-notice
tasks: [T13572]
kind: fix
summary: "Admission waiter notices and cleo doctor tool-locks name the pressure-narrowed budget and its share"
---

A run waiting on a pressure-halved budget saw `machine budget in use: 24 of 48 GiB`, which reads as free capacity. The refusal reason and the long-wait holder report now name the budget the run is held to, with its share and the capacity, whenever a share narrows it, e.g. `24 of 24 GiB light budget (light share half from memory pressure; capacity 48 GiB)`. When the share is full the text is unchanged. `cleo doctor tool-locks` reports a `budget` object with `share`, `lightShare`, `lightBudgetBytes`, `heavyBudgetBytes`, `capacityBytes` and `sampledAtMs`, read from the ledger's cached pressure verdict (`readLedgerBudget`).
