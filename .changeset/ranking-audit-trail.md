---
id: ranking-audit-trail
tasks: [T12693]
kind: feat
summary: "every change to a task's priority, severity, kind or depends records actor, session, reason and before/after; cleo history ranking <id> shows them and cleo history revert <entryId> undoes one (D11161)"
---
Owner decision D11161: agents may change a task's ranking inputs directly,
with an audit trail.

- **Audit row.** `updateTask` writes one `ranking_changed` audit row, in the
  same transaction as the change, whenever `priority`, `severity`, `kind` or
  `depends` changes. The row records:
  - the actor: `CLEO_AGENT_ID`, else `human`;
  - the session: env first, then the bound session (now stored in
    `audit_log.session_id`);
  - the `--reason`;
  - the changed fields, with before and after values.

  Deleting a prerequisite records the change to its dependents' `depends` the
  same way (source `delete-cascade`).
- **Reason prompt.** `cleo update --reason` now documents the ranking use. An
  agent that changes ranking inputs without a reason gets
  `W_RANKING_REASON_MISSING`.
- **`cleo history ranking <id>`** (`tasks.history` with `ranking: true`) lists
  who changed what, in which session, and why, newest first.
- **`cleo history revert <entryId>`** (new `tasks.ranking.revert`) sets the
  fields one change touched back to their before values, as a new audited
  change (source `revert`). It is refused when a field has changed again since,
  unless `--force`. `cleo update --severity` now also accepts `null` to clear
  (core API).
