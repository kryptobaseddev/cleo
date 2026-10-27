---
id: killed-validation-all-paths
tasks: [T13013]
kind: fix
summary: "an OOM or signal kill on the affected-tests and cleo done paths is reported as E_EVIDENCE_TOOL_KILLED with the memory ceiling and accurate heap advice, not as failing tests"
---

`validateAffectedTests` and `cleo done`'s tool runner ignored a run's kill, so
an OOM or signal kill read as `E_EVIDENCE_TOOL_FAILED` or "tests failed".
After #1776 most `tool:test` runs take the affected-tests path. One
`killedValidation` helper now serves `tool:<name>`, the affected-tests run and
`cleo done`. Its message names the systemd memory ceiling when one applies.
It also says that a heap set by the test config (vitest `execArgv`, as in
`vitest.memory-safe`) is not overridden by `NODE_OPTIONS`. The evidence
header now lists `resourceEnv` in the cache key.
