---
id: t11563-conduit-attachments-collision
tasks: [T11563]
kind: fix
summary: Fix conduit drizzle-conduit migration crash on a fresh cleo.db — prefix the conduit attachment-family tables to avoid colliding with the docs-domain bare attachments table
---

The conduit forward migration (introduced by E6-L3 #900) created a bare `attachments` table that collided with the docs-domain bare `attachments` table once conduit was routed into the consolidated `cleo.db`. The conduit `CREATE TABLE IF NOT EXISTS attachments` silently no-opped against the docs table, then `CREATE INDEX attachments_conversation_idx ON attachments(conversation_id)` crashed with `no such column: conversation_id`, breaking `cleo agent list` and every `cleo conduit *` command on a fresh build. The four conduit attachment-family tables (`attachments`, `attachment_versions`, `attachment_approvals`, `attachment_contributors`) now carry the `conduit_` prefix so they are physically disjoint from the docs `attachments` table, matching the consolidated schema and the exodus rename-map target. The signaldock→conduit one-shot migration maps the legacy bare source names to the prefixed destination names.
