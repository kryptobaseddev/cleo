-- T12342 — change journal (S1): store-level sync flags, the HLC clock and the
-- replica binding. Journal spec t12342-t12343-journal-design §1.4, §1.5, §5.1.
--
-- NOT a drizzle migration. The sync schema is applied lazily by
-- packages/core/src/store/sync/schema.ts, and only when a sync.* flag is first
-- enabled on a store. With every flag off (the default), opening a store
-- writes nothing: no table, no journal row. Applied folders are journaled in
-- _sync_meta under the key 'schema:<folder name>', never in
-- __drizzle_migrations.
--
-- All three tables are local-only (never synced; tier-1 backed up like every
-- table) and identical in the project and the global store. Statements are
-- separated by the drizzle breakpoint marker line, like the drizzle lineages.
--
-- @task T12342

CREATE TABLE IF NOT EXISTS _sync_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS _sync_clock (
  replica_id TEXT PRIMARY KEY,
  phys       INTEGER NOT NULL CHECK (phys >= 0),
  ctr        INTEGER NOT NULL CHECK (ctr BETWEEN 0 AND 999999)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS _sync_replica (
  replica_id TEXT PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  nonce      TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  file_ino   INTEGER NOT NULL,
  file_birth INTEGER,
  bound_at   TEXT NOT NULL,
  bound_why  TEXT NOT NULL,
  retired_at TEXT,
  successor  TEXT
) WITHOUT ROWID;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS _sync_replica_active ON _sync_replica (scope) WHERE retired_at IS NULL;
