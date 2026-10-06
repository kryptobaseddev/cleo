---
id: t12343-replay-pin
tasks: [T12343]
kind: feat
summary: Sync checkpoints compute their replay pin - the ordered migration journal hash and a literal-safe trigger-set hash
---

A checkpoint/v3 manifest carries a `replayPin` (journal spec §2.11 §7). It records what an endorsing device must replay under to
recompute the checkpoint's tallies (T12343 S4-1b).

- **`migrationJournalHash(db)`** is sha256 over the whole ordered `__drizzle_migrations` journal, as `[created_at, name, hash]` in
  `(created_at, name)` order. A drifted row below the head changes it.
- **`triggerSetHash(db)`** is sha256 over every non-capture trigger's DDL, sorted by name. Capture triggers are excluded, because they
  are generated per build and never run in a replay.
- **`normalizeTriggerDdl(sql)`** normalizes that DDL literal-safely:
  - comments are dropped;
  - outside literals, whitespace collapses and words are lower-cased;
  - string literals are kept byte for byte;
  - every quoted identifier is written `"x"`.
- **`replayPinOf(db, transitions)`** assembles the wire `ReplayPin`. A genesis checkpoint passes no transitions.
