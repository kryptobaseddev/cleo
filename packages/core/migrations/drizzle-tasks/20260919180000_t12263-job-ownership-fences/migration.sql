-- T12263: extend the established active runtime table without moving historical rows.
-- Epoch-ms timestamps and all existing values remain unchanged. NULL ownership
-- means unresolved legacy work, not an expired claim. The separate prefixed
-- tasks_background_jobs historical surface is intentionally untouched.
-- Some fresh consolidated stores never created the active legacy job table.
-- Bootstrap only its established shape before applying the same additive steps.
CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY, operation TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  started_at INTEGER NOT NULL, completed_at INTEGER, result TEXT, error TEXT,
  progress INTEGER, heartbeat_at INTEGER NOT NULL, claimed_by TEXT
);
--> statement-breakpoint
ALTER TABLE background_jobs ADD COLUMN project_id TEXT;
--> statement-breakpoint
ALTER TABLE background_jobs ADD COLUMN owner_id TEXT;
--> statement-breakpoint
ALTER TABLE background_jobs ADD COLUMN lease_expires_at INTEGER;
--> statement-breakpoint
ALTER TABLE background_jobs ADD COLUMN fencing_epoch INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE background_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE background_jobs ADD COLUMN cancellation_requested_at INTEGER;
--> statement-breakpoint
ALTER TABLE background_jobs ADD COLUMN checkpoint_json TEXT;
--> statement-breakpoint
ALTER TABLE background_jobs ADD COLUMN checkpoint_at INTEGER;
--> statement-breakpoint
ALTER TABLE background_jobs ADD COLUMN idempotency_key TEXT;
--> statement-breakpoint
ALTER TABLE background_jobs ADD COLUMN proposal_hash TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_background_jobs_scoped_idempotency
  ON background_jobs(project_id, operation, idempotency_key);
