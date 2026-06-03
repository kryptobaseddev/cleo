---
id: t11658-purge-clawmsgr
tasks: [T11658]
kind: chore
summary: Remove legacy ClawMsgr integration — drop api.clawmsgr.com Conduit transport fallback + all refs.
---

Purged the legacy ClawMsgr integration from the repository. Removed the `api.clawmsgr.com` Conduit HTTP fallback endpoint and all ClawMsgr references from shipped code, scripts, source docs, generated docs, and `.gitignore` files.

`HttpTransport` previously carried a primary/fallback failover machinery whose sole purpose was the legacy `api.clawmsgr.com` endpoint. That machinery is removed: the transport now connects to the single configured `apiBaseUrl` (`api.signaldock.io`). The primary SignalDock HTTP transport is unaffected — push/poll/ack continue to work against the configured base URL. The `TransportConfig.apiBaseUrlFallback` contract field (only ever populated with a ClawMsgr URL and only read by the removed fallback path) was dropped.

Left untouched by deliberate decision: `CHANGELOG.md` (immutable historical release record) and the comment in the frozen `20260327000000_agent-credentials` migration — drizzle's `readMigrationFiles` hashes the full `.sql` file content, so editing the comment would change the migration hash and orphan the journal entry on already-migrated databases.
