---
id: t13172-reconcile-id-collision
tasks: [T13172]
kind: fix
summary: superseded-store --reconcile recovers a legacy task whose id a newer task took, instead of silently skipping it
---

When exodus-on-open was deferred (#1826) and you kept working, the empty store gave your first new
task the id `T001`, which your legacy `tasks.db` also holds. `cleo doctor superseded-store
--reconcile` skipped the legacy `T001`, attached its children to the new task, and still reported
"every legacy row is now present in cleo.db".

The reconcile now finds every legacy task whose id a different live task holds (same id, different
creation time) and recovers it under a new id. Its children, dependencies, acceptance criteria and
other references follow it. The renumbering happens in a scratch copy, so your legacy file and
your existing tasks are never changed. `--dry-run` and the receipt list each remap (`legacy T001
("…") -> T004, because live T001 is "…"`) in a new `remaps` field, and a second run recognises
the recovered task and copies nothing.

Everything that refers to the recovered task follows it, as in a display-id rename: every column
that holds a task id (declared foreign keys and the registry's refs, including a session's
`tasks_completed_json`), and acceptance criteria whose ids are derived from the task id are
re-derived, so a "tests pass" criterion is not lost to the newer task's identical one. Legacy
twins (same title and creation time) are paired with distinct recovered tasks. A collision whose
creation time does not parse is never renumbered: it is listed as an `id-collision-undecided`
conflict and the receipt says it was left uncopied. A recovered id that a concurrent write takes
before the copy makes the run refuse and revert. Task ids written inside free text are not
rewritten.

The read-only `cleo doctor superseded-store` now counts those shadowed tasks as missing, and never
calls `tasks.db` safe to archive while one is waiting. Keep `.cleo/tasks.db` until the reconcile
reports every row present.
