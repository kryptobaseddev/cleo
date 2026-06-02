-- T11523 (E6-L3) → T11578 (AC4 · COMPLETE-CUTOVER): conduit FTS5 quartet over the
-- consolidated `conduit_*` tables.
--
-- ## History
--
-- E6-L3 (T11523) routed `ensureConduitDb()` through `openDualScopeDb('project')`
-- (the consolidated `cleo.db` chokepoint, ADR-068/069) and reproduced the legacy
-- BARE-table conduit shape (`conversations`, `messages`, `delivery_jobs`, …) here
-- as a forward migration so the runtime writers kept working unchanged. The bare
-- tables co-existed (disjoint names) with the consolidated `conduit_*` tables the
-- exodus migration (T11248 / T11553) renames into.
--
-- ## AC4 cutover (T11578)
--
-- The conduit runtime READ + WRITE path now targets the PREFIXED consolidated
-- tables (`conduit_conversations`, `conduit_messages`, `conduit_topics`, …) that
-- the consolidated cleo-project migration
-- (`drizzle-cleo-project/20260531000001_t11363-consolidation-cleo-project`)
-- creates. Those 14 prefixed tables are therefore NO LONGER created here — the
-- consolidated migration owns them (single SSoT; CHECK constraints + ISO-8601
-- TEXT timestamp affinity are injected by T11363). This migration's sole
-- remaining responsibility is the FTS5 full-text index over `conduit_messages`,
-- which drizzle-orm sqlite-core cannot model (FTS5 virtual tables) and which the
-- consolidated migration therefore omits.
--
-- ## FTS5 rename: `messages_fts` → `conduit_messages_fts` (T11578 decision)
--
-- The full-text index and its three sync triggers are renamed with the `conduit_`
-- domain prefix for clarity and to stay disjoint inside the shared `cleo.db`
-- (which also holds `brain_*_fts` indexes). The index content table is
-- `conduit_messages` and `content_rowid='rowid'` is preserved. The exodus
-- migration skips `*_fts` tables (rebuilt post-migration from their content
-- table — see exodus/table-name-map.ts `isDerivedFtsTable`), so the
-- `INSERT INTO conduit_messages_fts(conduit_messages_fts) VALUES('rebuild')` seed
-- below reindexes whatever rows the consolidated migration + exodus already
-- placed in `conduit_messages`. Every statement is `IF NOT EXISTS`, so re-running
-- on a DB that already has the FTS index is idempotent.

-- -------------------------------------------------------------------------
-- FTS5 virtual table for full-text search on conduit_messages content.
-- The INSERT … VALUES('rebuild') is idempotent — safe to run on every open;
-- it (re)indexes the existing conduit_messages rows.
-- -------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS conduit_messages_fts
    USING fts5(content, from_agent_id, content='conduit_messages', content_rowid='rowid');
--> statement-breakpoint
INSERT INTO conduit_messages_fts(conduit_messages_fts) VALUES('rebuild');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS conduit_messages_ai AFTER INSERT ON conduit_messages BEGIN
    INSERT INTO conduit_messages_fts(rowid, content, from_agent_id)
        VALUES (new.rowid, new.content, new.from_agent_id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS conduit_messages_ad AFTER DELETE ON conduit_messages BEGIN
    INSERT INTO conduit_messages_fts(conduit_messages_fts, rowid, content, from_agent_id)
        VALUES('delete', old.rowid, old.content, old.from_agent_id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS conduit_messages_au AFTER UPDATE ON conduit_messages BEGIN
    INSERT INTO conduit_messages_fts(conduit_messages_fts, rowid, content, from_agent_id)
        VALUES('delete', old.rowid, old.content, old.from_agent_id);
    INSERT INTO conduit_messages_fts(rowid, content, from_agent_id)
        VALUES (new.rowid, new.content, new.from_agent_id);
END;
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- Legacy meta tracking tables — retained for backwards-compatible health
-- probes (`checkConduitDbHealth` reads `_conduit_meta.schema_version`).
-- `__drizzle_migrations` is the canonical migration journal; these are kept
-- only for the pre-T1407 health-check consumers.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _conduit_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS _conduit_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
