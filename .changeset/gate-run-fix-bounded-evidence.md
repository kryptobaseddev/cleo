---
id: gate-run-fix-bounded-evidence
tasks: [T14528]
kind: fix
summary: "verify --run fix hints quote a bounded evidence summary, and the exit table names E_GATE_RUN_FAILED"
---

When a failing typed gate carries no `errorMessage`, the `E_GATE_RUN_FAILED`
fix hint now quotes the first lines of its evidence (capped) and points at
`error.details.failures[n].evidence` instead of inlining full tool stdout.
CLEO-INJECTION's exit table lists `E_GATE_RUN_FAILED` beside `E_VALIDATION`
for exit 6 with its own recovery hint.
