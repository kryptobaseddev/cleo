---
id: verify-run-failure-envelope
tasks: [T14524]
kind: fix
summary: "verify --run returns a coded failure when a typed gate fails or errors"
---

`cleo verify --run` now returns `success: false` with `E_GATE_RUN_FAILED`
and exit status 6 for error and fail gate results. Advisory warnings and
skipped manual gates remain successful, with their results visible.
The complete preview, including results, captured evidence and cache details,
is preserved in `error.details`, alongside per-failure recovery hints. Test collection errors and unprovable test
counts can no longer appear as successful runs. Verification recording and
pass caching keep their existing behavior.
