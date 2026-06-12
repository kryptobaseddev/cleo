---
"@cleocode/core": minor
"@cleocode/cleo": minor
"@cleocode/contracts": patch
---

feat(T11995): janitor MVP — registration-primary process reaper + stale scope/lock/debris sweep (silent, idempotent)

Adds the CLEO Janitor subsystem: a composable GC engine callable from the CLI (`cleo janitor run [--dry-run]`), session lifecycle hooks, and the daemon sentient tick.

Key implementation details (amendments 1-7):
- **Amendment 1 (registration-primary)**: orphan detection uses cleo-owned scope/pgid as PRIMARY discriminator; signature+age reap ONLY for unregistered processes when all stdio pipe peers are dead.
- **Amendment 2 (regression)**: reparented double-fork of a LIVE session is preserved; same of a DEAD session is reaped.
- **Amendment 3 (scope reaping)**: restricted to `cleo-*.scope` units inside `cleo.slice`; never touches `run-*.scope`; allowlist excludes `cleo-daemon.service` and `cleo-gateway.service`.
- **Amendment 4 (idempotency)**: fully-converged state produces zero actions on second run.
- **Amendment 5 (liveness probe)**: stale locks reclaimed only after verifying holder PID is dead; mtime alone is never sufficient.
- **Amendment 6 (silence)**: all actions → `.cleo/audit/janitor.jsonl`; zero desktop/console output in normal mode.
- **Amendment 7 (tmp debris)**: reuses `gc/cleanup.ts` `pruneOrphanTempDirs` patterns directly.

Registers `admin.janitor.run` op in the operations registry (T11995).
