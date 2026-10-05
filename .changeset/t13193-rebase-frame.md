---
id: t13193-rebase-frame
tasks: [T13193]
kind: feat
summary: Scoped rebase frame for sync apply - rewind unsequenced local transactions, apply the incoming one, replay through the merge engine
---

This is the second slice of the scoped rebase (T13193 R-2), against journal spec §3.5 Rules 2-6.

- **Scoped rebase.** When an incoming transaction's footprint (rows written, re-key targets, referenced rows) meets unsequenced
  local transactions, the applier works out the scope to a fixed point. It rewinds that scope newest op first, applies the incoming
  transaction, then replays the scope in commit order. All of this runs inside the transaction's Gate C savepoint, so a post-apply
  void rolls the rewind back as well. An own echo whose fast path fails is rewound and applied at its stream position, which sequences
  it.
- **The rewind restores merge state as well as values.** U ops write back only the columns they changed. An I is deleted, keeping its
  local-only columns for the replay (R7-2). A D is re-inserted with its birth fingerprint, and a K is re-keyed back. Row meta, leaves
  and frontiers come back from the row undo.
- **Each replay re-snapshots the row undo first (D2).** The next rewind restores exactly what the replay sat on, never the sealed
  before-image. A row the replay found already deleted is recorded as absent and is not re-inserted.
- **Rows outside the sync set survive a rewound insert (T13267).** Deleting a rewound insert fires its FK actions. Before the delete,
  the rewind snapshots that row's local children: the rows a cascade removes (task work history, session handoff entries, external
  links, and so on, recursively) and the columns a `SET NULL` clears. It puts them back once the replay, or the own echo, inserts the
  row again.
- **Gate C covers the replay (T13268).** Each replayed local transaction gets the post-apply checks. A transaction that fails them
  stays rewound whole, and its row undo is re-snapshotted on the rewound row. An own echo voided by Gate C is rewound, then sequenced
  `void`.
- **The replay respects LWW (R6-7).** It runs through the merge engine with the local actor, so a newer stream write of the same
  column is not overwritten. Its conflicts are left to the echo to record.
- **Rule 6.** An own echo the stream refuses is sequenced with outcome `void` (`_sync_sequenced.outcome`) and keeps its undo. The
  refused effect stays rewound.
- **Triggers are suspended through the canonical `withTriggersSuspended`.** The rewind suspends capture, guard and side-effect triggers
  (purpose `rewind`). The replay suspends capture and side-effect triggers only, so guards stay active. While capture is suspended,
  the apply write API records no apply intents: an intent mirrors a capture, and the incoming op's own captures stay matched to its
  intents.
- **Stricter own-echo fast path.** It now checks the echo's whole footprint, and declines when a later unsequenced local transaction
  touches that footprint.
- **Foreign-touch index (#1912 follow-ups).** A running count in `_sync_meta` replaces the per-transaction scan near the 200,000
  bound. A restarted `_sync_capture` counter, detected when an undo seq sits above it, marks the index incomplete, so the fast path
  declines and a rebase decides.
- **`ApplyReport.rebased`** counts the transactions applied inside a rebase frame.
- **New sync-journal migration** `t13193-rebase-state`, local-only: `_sync_row_undo.values_json` and `_sync_sequenced.outcome`. Undo
  still turns on only with S4's genesis cut, so all of this stays inert on real stores until then.
