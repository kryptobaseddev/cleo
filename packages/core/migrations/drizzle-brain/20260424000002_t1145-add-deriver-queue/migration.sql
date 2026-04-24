-- T1145 Wave 5: Add deriver_queue table
--
-- Durable background derivation work queue backed by SQLite WAL.
-- Uses "status column + ORDER BY priority DESC, created_at ASC" pattern
-- as a SKIP LOCKED analog for single-node CLI operation.
--
-- State machine: pending -> in_progress -> done | failed
-- Stale recovery: claimed_at older than threshold -> re-queued to pending
--
-- Worker dispatch: sentient tick calls runDeriverBatch() analogously to
-- checkAndDream(). No separate daemon needed.

CREATE TABLE IF NOT EXISTS deriver_queue (
  id            TEXT PRIMARY KEY,
  item_type     TEXT NOT NULL,                         -- 'observation'|'session'|'narrative'|'embedding'
  item_id       TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',        -- pending|in_progress|done|failed
  claimed_at    TEXT,
  claimed_by    TEXT,
  error_msg     TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_deriver_queue_status_priority
  ON deriver_queue(status, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_deriver_queue_item
  ON deriver_queue(item_type, item_id);

CREATE INDEX IF NOT EXISTS idx_deriver_queue_claimed_at
  ON deriver_queue(claimed_at);
