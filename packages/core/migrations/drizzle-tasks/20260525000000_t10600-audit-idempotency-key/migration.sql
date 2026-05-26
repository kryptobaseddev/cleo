-- T10600: Persist idempotency keys for mutating dispatch commands.

ALTER TABLE audit_log ADD COLUMN idempotency_key TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_log_idempotency_key
  ON audit_log(idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_log_idempotency_lookup
  ON audit_log(project_hash, domain, operation, idempotency_key);
