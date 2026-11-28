---
id: docs-supersession-audit-warnings
tasks: [T14664]
kind: fix
summary: "a lost docs audit or versioning line after a committed write is now a warning, and both supersession verbs file the audit under the superseded slug"
---

The docs audit log (`.cleo/audit/docs-audit.jsonl`) and the docs-versioning
log (`.cleo/audit/docs-versioning.jsonl`) are best-effort appends written
after the doc change commits. A failed append used to be swallowed, so a
supersession could commit with no audit trail and nobody would know. It now
adds a `W_DOC_AUDIT_APPEND_FAILED` or `W_DOC_VERSIONING_APPEND_FAILED` warning
to the envelope. The change itself still succeeds.

`cleo docs supersede` filed its audit entry under the new slug, while
`cleo docs update --superseded-by` filed it under the old one. Both now file
it under the superseded (old) slug and name the successor in the summary.
