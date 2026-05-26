-- Revert T10600: remove idempotency-key persistence indexes.
-- SQLite cannot drop columns before 3.35 without table rebuild; leave
-- audit_log.idempotency_key in place for backward-compatible rollback.

DROP INDEX IF EXISTS idx_audit_log_idempotency_lookup;
DROP INDEX IF EXISTS idx_audit_log_idempotency_key;
