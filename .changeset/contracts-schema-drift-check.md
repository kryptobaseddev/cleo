---
id: contracts-schema-drift-check
tasks: [T14064]
kind: chore
summary: "CI fails when committed packages/contracts/schemas differ from the generated output"
---

`gate-result.schema.json` shipped stale because nothing compared the committed
JSON Schemas with `build:schemas` output. The Invariants Docs Render Drift job
now re-emits `packages/contracts/schemas/*.json` after building contracts and
fails on any difference, naming the regenerate command.
