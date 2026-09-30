-- T12343 — change journal (S2): the capture outbox, transaction frames and the
-- undo log. Journal spec t12342-t12343-journal-design §2.3 and §3.5 Rule 2.
--
-- Applied lazily by packages/core/src/store/sync/schema.ts when a sync.* flag
-- is first enabled (never at open with every flag off); journaled in
-- _sync_meta by sha256, never in __drizzle_migrations. All tables are
-- local-only. Capture triggers (_sync_cap_*) are generated per table by the
-- open pass (store/sync/capture.ts) and are never part of any migration.
--
-- @task T12343

CREATE TABLE IF NOT EXISTS _sync_capture (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl    TEXT NOT NULL,
  op     TEXT NOT NULL CHECK (op IN ('I', 'U', 'D', 'K')),
  rk     TEXT NOT NULL,
  uid    TEXT,
  img    TEXT NOT NULL,
  at_ms  INTEGER NOT NULL,
  conn   TEXT,
  frame  TEXT,
  kind   TEXT,
  state  TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'inherited', 'folded'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS _sync_capture_frame ON _sync_capture (frame) WHERE frame IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS _sync_capture_key ON _sync_capture (tbl, rk, op);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS _sync_frame (
  frame     TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  actor     TEXT,
  first_seq INTEGER
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS _sync_undo (
  seq         INTEGER PRIMARY KEY,
  txn_local   TEXT,
  kind        TEXT,
  tbl         TEXT NOT NULL,
  rk          TEXT NOT NULL,
  uid         TEXT,
  op          TEXT NOT NULL,
  before_full TEXT,
  after_full  TEXT
);
