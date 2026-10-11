---
id: t12343-genesis-cut
tasks: [T12343]
kind: feat
summary: Sync genesis cut - where a stream's pushed history begins (S4-1a), behind the unreleased sync.push flag
---

The genesis cut starts a stream's pushed history: every earlier effect travels in the genesis checkpoint, never in segments (journal
spec §2.11 §10, §3.5 Rule 2; T12343 S4-1a). `sync.push` stays unreleased, so only tests can turn it on.

- **`cutGenesis(db, {scope, stream})`** checks the step-0 preconditions (T13032 AC2), seals everything pending, then in one
  `BEGIN IMMEDIATE` with no frame open:
  - records `genesis_cut:<stream>` and `genesis_source_seq:<stream>`, the highest capture seq the checkpoint carries;
  - folds every sealed, unsegmented transaction (`state = 'folded'`), so it is never sent;
  - gives genesis row meta to every row that has none, before the stream starts (T13217);
  - sets `undo_enabled`, raises `min_writer_version` and turns `sync.push` on, so every pushed transaction has undo;
  - leaves `genesis_pending:<stream>` until the genesis checkpoint is stored (S4-1b).

  A second cut of the same stream changes nothing. A write that lands between the drain and the lock is drained too.
- **`genesisPreconditions`** refuses, and changes nothing, when:
  - capture is off, or a capture trigger differs from the schema;
  - an owned guard trigger is unsound;
  - the sealer may not run;
  - no replica is bound;
  - identity is not on the current recipe, or a minted row lacks its uid or birth_fp;
  - a table is suspect, or a capture is quarantined.

  Each refusal names its `cleo doctor` remedy.
- **`captureTriggerDrift(db, scope)`** moves from the doctor into `store/sync/capture.ts`, so the doctor and the genesis check share it.
  **`rowIdentityRecipeCurrent(db, scope)`** is new.
