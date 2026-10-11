---
id: t12343-replay-pin
tasks: [T12343, T13298]
kind: feat
summary: Sync checkpoints compute their replay pin - the ordered migration journal hash and a literal-safe trigger-set hash
---

A checkpoint/v3 manifest carries a `replayPin` (journal spec §2.11 §7). It records what an endorsing device must replay under to
recompute the checkpoint's tallies (T12343 S4-1b).

- **`migrationJournalHash(db)`** is sha256 over the whole ordered `__drizzle_migrations` journal, as `[created_at, name, hash]` in
  `(created_at, name)` order. A drifted row below the head changes it.
- **`triggerSetHash(db)`** is sha256 over the DDL of the store's owned triggers (`OWNED_TRIGGERS`: the guard and side-effect
  triggers a replay runs under), sorted by name. Capture triggers (generated per build) and device-local maintenance triggers (the
  twin-collapse docs freeze, whose message names the build that froze that store, and the legacy track triggers) are excluded.
  Otherwise two devices with the same replay semantics would compute different pins and never endorse each other (T13298).
- **`normalizeTriggerDdl(sql)`** normalizes that DDL literal-safely:
  - comments are dropped;
  - outside literals, whitespace collapses and words are lower-cased;
  - string literals are kept byte for byte;
  - every quoted identifier is written `"x"`.
- **`replayPinOf(db, transitions)`** assembles the wire `ReplayPin`. A genesis checkpoint passes no transitions.
