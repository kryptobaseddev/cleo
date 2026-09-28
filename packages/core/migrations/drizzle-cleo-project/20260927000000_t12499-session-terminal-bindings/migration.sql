-- T12499 (E-MULTI-SESSION · epic T12497) — terminal-bound session identity.
--
-- One row per terminal / harness identity key (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID,
-- TMUX_PANE, TERM_SESSION_ID, WT_SESSION, … or the ppid-chain fallback), mapping it to
-- the CLEO session that terminal started. `cleo session start` upserts the row;
-- session resolution reads it BEFORE the newest-active-row fallback, so an unbound
-- short-lived `cleo` call no longer resolves another agent's session.
--
-- PROJECT scope only: sessions live in the project `tasks_sessions` table, so the
-- binding lives beside it and is never mirrored into the global cleo.db (no
-- dual-scope ambiguity for gate 21). Pure runtime infrastructure, like `schedules`
-- (T11962) — NOT part of the exodus target shape under `schema/cleo-project/`.
--
-- `session_id` is an intra-DB foreign key to `tasks_sessions.id` (same project cleo.db),
-- ON DELETE CASCADE, so deleting a session removes its bindings. Resolution still
-- re-checks that the bound session is active before honouring a binding.
--
-- `IF NOT EXISTS` so a re-open over an already-migrated DB is a no-op. Statements are
-- separated by the drizzle breakpoint marker line so node:sqlite prepare() does not
-- truncate the multi-statement file to statement one (the marker token is not spelled
-- out in this comment — readMigrationFiles splits on that literal substring).
--
-- @task T12499
-- @epic T12497

CREATE TABLE IF NOT EXISTS `session_terminal_bindings` (
  `binding_key` TEXT PRIMARY KEY NOT NULL,
  `key_source` TEXT NOT NULL,
  `key_kind` TEXT NOT NULL,
  `session_id` TEXT NOT NULL REFERENCES `tasks_sessions`(`id`) ON DELETE CASCADE,
  `bound_at` TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_session_terminal_bindings_session` ON `session_terminal_bindings` (`session_id`);
