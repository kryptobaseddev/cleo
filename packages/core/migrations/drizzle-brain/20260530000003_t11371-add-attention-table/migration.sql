-- T11371 — Tier-2 attention buffer: decaying, scope-keyed working-memory items.
--
-- Background:
--   Epic T11288 (E2 · Saga T11283 SG-COGNITIVE-SUBSTRATE) introduces a
--   per-agent, scope-keyed working-memory layer. Each `cleo attention add`
--   (alias `jot`) writes ONE row here, auto-keyed to the NARROWEST scope the
--   writing agent resolves (agent > task > epic > saga > session > global) via
--   the E0 env-first identity resolvers. Because visibility is the scope key
--   itself — not a filter applied after loading every row — an agent working
--   task T-A can never read agent/task-scoped items written by an agent working
--   T-B. Cross-agent leakage is structurally impossible (leakage test: T11375).
--
--   `tags` is a JSONB BLOB (E4 `jsonb<string[]>()` helper). Membership filtering
--   runs in SQL via `json_each(tags)`; the raw BLOB is NEVER JSON.parse-d
--   (the on-disk JSONB encoding is version-unstable). Default is `jsonb('[]')`.
--
-- Decay/TTL model:
--   An item is "live" while status = 'open' AND (expires_at IS NULL OR
--   expires_at > now) AND (decay_score IS NULL OR decay_score >= threshold).
--   Items failing the predicate are excluded from the open-items query and may
--   be swept to status = 'discarded'.
--
-- Changes (idempotent — safe to re-run):
--   1. CREATE TABLE brain_attention (text PK, JSONB tags, scope keying, TTL/decay).
--   2. CREATE INDEX (scope_kind, scope_id)      — scoped-read path (dominant).
--   3. CREATE INDEX (session_id)                — session sweep / audit path.
--   4. CREATE INDEX (status, expires_at)        — TTL sweep path.
--
-- @task T11371
-- @epic T11288
-- @saga T11283

CREATE TABLE IF NOT EXISTS `brain_attention` (
  `id` text PRIMARY KEY NOT NULL,
  `content` text NOT NULL,
  `session_id` text,
  `agent_id` text,
  `scope_kind` text NOT NULL,
  `scope_id` text NOT NULL,
  `tags` blob DEFAULT (jsonb('[]')),
  `created_at` integer DEFAULT ((unixepoch() * 1000)) NOT NULL,
  `expires_at` integer,
  `decay_score` real,
  `status` text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_attention_scope` ON `brain_attention` (`scope_kind`,`scope_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_attention_session` ON `brain_attention` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_attention_status_expires` ON `brain_attention` (`status`,`expires_at`);
