-- T1118 L4a — Add owner_auth_token column to sessions table.
--
-- Stores the HMAC-SHA256 token derived from (session_id, owner_password)
-- when a session is started with `cleo session start --owner-auth`.
-- Override calls must present a matching --auth-token to pass L4a.
--
-- The column is nullable: sessions without --owner-auth have no token
-- and the L4a gate is skipped (backwards compatible).

ALTER TABLE `sessions` ADD COLUMN `owner_auth_token` TEXT;--> statement-breakpoint
