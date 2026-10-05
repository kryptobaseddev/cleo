---
id: t12344-apply-frame
tasks: [T12344]
kind: feat
summary: The change journal's synchronous apply frame and its write API, which records exactly what each apply wrote so the sealer echoes nothing back
---

This is the second slice of the apply side (T12344, PR-2 of 6), against journal spec §3.2 and §3.3.

- **`withApplyFrame(db, scope, actor, fn)`** is one `BEGIN IMMEDIATE … COMMIT` holding a `_sync_frame` row of kind `apply`.
  - BEGIN IMMEDIATE runs once. The handle's `busy_timeout` (30 s) bounds the wait, and BUSY is never retried mid-frame.
  - The body must be synchronous. Its return type excludes `PromiseLike`, and a thenable result rolls back with `E_SYNC_APPLY_ASYNC`.
    The dropped promise gets a handler, so it never becomes an unhandled rejection.
  - The API is dead once the frame ends (`E_SYNC_APPLY_ENDED`).
  - The frame refuses to nest (`E_SYNC_APPLY_NESTED`).
- **`runApplyFrame`** awaits the async preparation first, then queues the frame behind the handle's foreground transactions. It uses
  `scheduleTaskBackground`, which is now exported for this.
- **The write API** (`writeFields`, `insertRow`, `deleteRow`, `readRow`) is the only way apply writes synced rows. It uses INSERT, UPDATE
  and DELETE only, never REPLACE, and a test enforces that nothing else in the apply module writes raw SQL. Each write records its
  `_sync_apply_intent` rows from the STORED value, using `RETURNING` with the capture triggers' own `enc()`:
  - an insert records `*I` plus every non-NULL stored captured column, and must carry every identity column;
  - a secret column records `<secret>`, which binds to the write's capture;
  - a delete records `*D`.
- **Integer binding.** Wire integers bind as BigInt, so a TEXT column stores `'42'`, not `'42.0'`.
- **Tests with real sealing.** Inserts, field writes, repeated writes and deletes made through the API seal nothing. A raw side effect
  in the same frame seals as the only residual.
