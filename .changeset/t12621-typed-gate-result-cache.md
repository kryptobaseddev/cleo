---
id: t12621-typed-gate-result-cache
tasks: [T12621]
kind: fix
summary: typed gate passes are cached, `verify --no-run` works, and deadline errors name the phase and the fix
---

Typed acceptance gates now use the ADR-061 evidence cache (`.cleo/cache/evidence/gate-*.json`)
that `tool:` atoms already had. The cache key is the gate definition hash, git HEAD, the
dirty-tree fingerprint, the cwd, and a digest of the captured invocation and every input the
verifier binds, including untracked harness scripts. Only passes are stored, so a failure is
never served as a pass. As a result, `cleo verify <id> --run` followed by
`cleo verify <id> --gate … --evidence …` runs a slow gate once, and a retry does not run it
again. A result served from the cache is still bound to the new write's own receipt.

`--no-run` used to be accepted and silently ignored. On a write it now executes no typed gate:
it records from cached passes, or refuses with `E_GATE_NOT_CACHED` and names the command that
fills the cache. Nothing is recorded when it refuses.

A typed-verification deadline now fails as `E_OPERATION_DEADLINE`, not as a bare
`E_GENERAL "Shared operation deadline reached"`. The message names the phase that ran out
(task and evidence validation, typed gate execution, or persisting the verification) and the
remedies. The `systemd-run unavailable` notice is silent on macOS and Windows, where the pgid
fallback is the expected mode. On Linux it appears once, only under `CLEO_DEBUG`.
