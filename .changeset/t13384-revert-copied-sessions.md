---
id: t13384-revert-copied-sessions
tasks: [T13384]
kind: fix
summary: a reconcile that copied a session reverts cleanly, and --rollback works on it
---

Reverting a reconcile run, whether refused or through `cleo doctor superseded-store --rollback`, threw "untracked trigger side effects: main.tasks_tasks claimed_by_session" whenever the run had copied a tasks_sessions row. Deleting a session fires the trigger that releases its task claims, and the recovery guard refused it. Nothing was reverted, the error escaped, and a refused run left its copied rows with no receipt. Recovery now accepts that trigger, and first refuses when a live task claims the copied session, so the trigger matches no row and the store returns to its exact prior state. A refused run whose revert cannot run still writes a refused receipt naming the rows it left, and `--rollback` reverts them once the conflict is resolved.
