---
id: verify-run-failure-envelope
tasks: [T14524]
kind: fix
summary: "verify --run returns a coded failure when any typed gate does not pass"
---

`cleo verify --run` now returns `success: false` with `E_GATE_RUN_FAILED`
and a nonzero exit status for error, fail, warn and skipped gate results.
The complete preview, including results, captured evidence and cache details,
is preserved in `error.details`. Test collection errors and unprovable test
counts can no longer appear as successful runs. Verification recording and
pass caching keep their existing behavior.
