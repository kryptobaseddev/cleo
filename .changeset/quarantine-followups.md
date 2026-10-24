---
id: quarantine-followups
tasks: [T14003]
kind: fix
summary: "Auto-row quarantine guards are rule ids, not SQL; lessons survive a broken brain store"
---

The `invalid_at` setters behind `cleo memory quarantine-auto-rows` take
auto-row rule ids and resolve the SQL guard themselves, so no caller can pass
raw SQL. A receipt that is not valid JSON fails with `E_QUARANTINE_RECEIPT`,
and `--expect` refuses a store:table pair given twice.

`cleo memory lessons` (scope `all`) and the briefing read the project and
global brains separately: a failing store no longer hides the other's lessons,
and the briefing warns which store failed. Briefing lesson rules are truncated
to 240 characters; the full text is one `cleo memory fetch` away.
