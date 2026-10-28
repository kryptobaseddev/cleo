---
id: ac-lock-append
tasks: [T12237]
kind: fix
summary: "appending acceptance criteria at a locked stage no longer needs --reason; removing or altering one still does, and the refusal names which criteria"
---

The acceptance-criteria lock refused every change at a locked stage, so
appending a criterion that makes closure harder needed the same `--reason`
override as deleting one. Agents learned to reach for the override
reflexively, and an override that fires on safe edits stops meaning anything.

- An update that keeps every existing criterion byte-for-byte and in place
  and adds one or more after them is allowed without `--reason`. It is
  audited in `.cleo/audit/ac-changes.jsonl` as `change: "append"`.
- Removing, altering, splitting or reordering an existing criterion still needs
  `--reason` and is audited as `change: "override"`. The refusal names the
  criteria the update would remove or alter (`AC2`) and says that appending
  needs no reason. Its details carry `attempted` and `changedCriteria`.
