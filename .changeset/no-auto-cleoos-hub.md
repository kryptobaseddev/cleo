---
id: no-auto-cleoos-hub
tasks: [T13994]
kind: chore
summary: "cleo init, cleo upgrade and the global scaffold stop seeding the CleoOS hub; cleo admin scaffold-hub is deprecated"
---
The Pi/CleoOS harness is retiring (ADR-098, owner decision D11173). `cleo
init`, `cleo upgrade` and the global scaffold (`install.global`) no longer seed
the CleoOS hub's Pi extensions, CANT workflows and starter justfile into the
global CLEO home. `ensureGlobalScaffold()` keeps its `cleoosHub` field, which
now always reports `skipped`. `cleo admin scaffold-hub` still seeds the hub on
request and warns that it is deprecated. Existing hubs are left in place.
