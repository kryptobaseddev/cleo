---
id: t10508-acceptance-uuid-wiring
tasks: [T10508]
kind: feat
summary: "cleo add/update --acceptance writes to task_acceptance_criteria table (T10381 Wave 2b)"
---

Wires `cleo add --acceptance` and `cleo update --acceptance` to dual-write the new `task_acceptance_criteria` table from Wave 2a (T10502/T10504) — every AC now gets a UUIDv4 stable identifier the moment it is created, alongside the legacy `tasks.acceptance` JSON column that stays in sync for backward compatibility.

Update paths handled per ADR-079-r1 §2.2 ordinal-monotonicity rule:

- **extend** (was N, now N+M with prefix match): new ACs append at `maxOrdinal+1`; existing rows untouched, no history written.
- **shrink** (was N, now M < N with strict prefix): trailing ACs append to `task_acceptance_criteria_history` with `reason='edit'` BEFORE the delete, kept prefix preserves its UUIDs + ordinals so `satisfies:` bindings survive.
- **replace-all** (text drift / reorder / mid-edit): ALL existing rows → history; all new rows inserted with fresh UUIDs from ordinal=1.

Plus a third surface: `cleo show <id>` now hydrates `acRows` from the new table when present, returning `{ id, alias, ordinal, text }` per criterion alongside the legacy `task.acceptance` field. Consumers should prefer `acRows` when populated and fall back to the legacy string otherwise.

Core additions: `packages/core/src/tasks/ac-table.ts` (the planner — `buildFreshAcRows`, `planAcUpdate`, `applyAcPlan`). Contract additions: `TransactionAccessor.{insertAcRows, getAcRows, deleteAcRowsForTask, appendAcHistory}` + `DataAccessor.getAcRows` + `TasksShowResult.acRows` + `TaskShowAcRowEntry` + `AcRow`. CLI handlers stay thin — all business logic lives in core. Tests: 13 planner units + 7 end-to-end integration tests covering create-new, extend, shrink, replace-all, and dual-write parity.
