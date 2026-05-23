---
"@cleocode/core": patch
"@cleocode/cleo": patch
---

fix(T9545): orchestrate spawn supervisor — bounded timeout + auto-cleanup (SAGA T10176)

The 60s spawn supervisor now (a) returns a clear `E_TIMEOUT` envelope on
overrun, (b) automatically unwinds the partial worktree state via
`destroyWorktree` (unlock + remove + branch delete + audit log + sentinel-index
eviction), (c) bounds its own cleanup pass at 5s so cleanup itself can never
wedge, and (d) is idempotent — repeated invocation against an absent worktree
succeeds silently.

Reverses the original T9545 (v2026.5.99) decision to preserve partial state.
Saga T10176 / Decision D010 verdict: orphan worktrees compound across parallel
agent waves, so spawn timeouts must self-heal. Callers no longer need to run
`cleo worktree prune` after a spawn timeout — the envelope tells them whether
cleanup succeeded.

Resolves the long-running "60s spawn hang + orphaned worktree" pattern from
prior sagas.
