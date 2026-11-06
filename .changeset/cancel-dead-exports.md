---
id: cancel-dead-exports
tasks: [T14273]
kind: fix
summary: "the SDK sessions.gc(hours) converts hours to days, and the dead cancel helpers and store-side gcSessions are gone"
---

`Cleo.sessions.gc(hours)` passed its hours straight through as days, so
`gc(24)` only orphaned sessions idle for 24 days. It now converts, as the
store provider already did: `gc(24)` orphans a session idle for more than a
day and keeps one active two hours ago.

Removed dead code with no runtime importer:

- `tasks/deletion-strategy.ts`: `handleChildren`, `isValidStrategy`,
  `VALID_STRATEGIES`, their helpers and a second `cascadeThreshold = 10`.
  `ChildStrategy` moved to `@cleocode/contracts` and types `tasks.cancel`.
- `tasks/cancel-ops.ts`: `cancelTask`, `cancelMultiple` and `CancelResult`;
  `canCancel` stays, since the settled-child predicate does not absorb it
  (it allows an archived task).
- `store/session-store.ts`: `gcSessions`, which computed a threshold it
  never used. The session gc is `sessions/index.ts`.

Ledger: adds nothing; deletes the dead exports and the duplicate
`cascadeThreshold`.
