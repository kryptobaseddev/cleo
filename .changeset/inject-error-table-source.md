---
id: inject-error-table-source
tasks: [T14531]
kind: fix
summary: "Generate cleo inject error handling from the delivered protocol template"
---

`cleo inject` now reads the canonical error-handling section from the bundled
protocol templates instead of maintaining a separate exit table. Its exit codes,
recovery commands and killed-write guidance stay in step with provider and spawn
delivery, including `E_GATE_RUN_FAILED`. Missing protocol content produces an
explicit error instead of falling back to stale guidance.
