---
id: t14620-repair-holder-teardown
tasks: [T14620]
kind: fix
summary: "Repair-store: recheck named defunct holders before declaring a store busy"
---

Keep the existing bounded retry for unreadable exiting Linux processes and verify both repair-store flakes with deterministic holder shutdown and branch repeat runs.
