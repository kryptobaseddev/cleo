---
id: t13590-encounter-cold-open-budget
tasks: [T13590]
kind: fix
summary: "Project registration no longer times out while the global store first opens"
---

Registering a project on encounter runs under a 2 s operation budget. The
first registration on a new CLEO home also cold-opens the global store, which
applies its schema migrations; under load that took longer than the budget and
the registration failed with "Shared operation deadline reached". The store
is now opened before the budget starts, so the budget covers only the
registration itself.
