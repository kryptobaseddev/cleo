---
id: t9905-unified-urgent-surface
tasks: [T9905]
kind: feat
summary: "Unified urgent surface across find/next/briefing/show (priority + severity dual-axis)"
---

Tasks carry two orthogonal urgency axes — `priority`
(low|medium|high|critical) and `severity` (P0|P1|P2|P3) — but before
T9905 there was no unified way to ask "what's urgent?". Operators had
to query each axis separately and reconcile the result themselves.

This change introduces a single urgency predicate across five surfaces:

- **`cleo find --urgent`** — new boolean flag (alias `-u`) that selects
  tasks where `priority IN ('critical','high') OR severity IN ('P0','P1')`.
  Composes with `--status`, `--kind`, free-text query, etc. via AND.
- **`cleo next`** — scoring now bumps P0 by +30 and P1 by +15. A P0
  filed with the default `medium` priority decisively outranks an
  unrelated `priority='medium'` peer, matching operator intuition.
- **`cleo briefing`** — new `urgentTasks: BriefingUrgentTask[]` field
  (always present; empty array when nothing is urgent). Capped at 5
  entries by the diet, sorted by urgency tier so the most-urgent row
  surfaces first.
- **`cleo show`** — renderer now emits an `Urgency:` line that lays the
  two axes side-by-side (`priority=critical severity=P0`). Tasks with
  no severity render `severity=—`.
- **`cleo update --help`** — `--priority` and `--severity` descriptions
  now cross-reference each other, eliminating the conflation that
  operators repeatedly hit.

The unified predicate lives in `isUrgentTask()` exported from
`@cleocode/core/tasks/find` so future surfaces can share it without
re-deriving the rule.

Wire-shape additions:

- `TasksFindParams.urgent?: boolean` (`@cleocode/contracts`)
- `MinimalTaskRecord.severity?: string | null` so `cleo find --urgent`
  surfaces the second axis without a follow-up `cleo show` per row.
- `SessionBriefing.urgentTasks: BriefingUrgentTask[]`

Test coverage:

- `find-urgent.test.ts` (5 tests) — disjunctive predicate semantics
- `task-next-severity-boost.test.ts` (4 tests) — P0/P1 boost ordering
- `briefing-urgent.test.ts` (5 tests) — section header + filter rules
- `show-urgency.test.ts` (2 tests) — dual-axis renderer line
- `find-urgent-flag.test.ts` (3 tests) — CLI flag forwarding
- `update-help-dual-axis.test.ts` (4 tests) — help cross-references

Closes GH#398.
