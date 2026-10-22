---
id: t13817-redaction-hardening
tasks: [T13817]
kind: fix
summary: "Unencrypted exports of projects with two or more playbook approvals no longer fail; a non-JSON journal image never ships"
---

An unencrypted bundle clears credential columns. A NOT NULL column became
`''` in every row, so `tasks_playbook_approvals.token`, which is also UNIQUE,
failed the export as soon as a project held two approvals. A NOT NULL UNIQUE
credential column now takes a per-row placeholder (`redacted:<rowid>`).

The change journal's credential images are redacted key by key; an image of a
credential table that is not valid JSON is now replaced whole (NULL, or `{}`
where the column is NOT NULL) instead of being shipped as written.
