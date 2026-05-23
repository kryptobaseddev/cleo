---
id: t10121-saga-reconcile
tasks: [T10121]
kind: feat
summary: "cleo saga reconcile — idempotent cron-safe auto-close repair"
---

feat(T10121): cleo saga reconcile — idempotent cron-safe auto-close repair

Adds `cleo saga reconcile [<sagaId>] [--dry-run]` verb. Re-applies T10116 saga
auto-close logic for paths that don't flow through completeTask (bulk SQL,
crash recovery, manual state edits). Per-saga advisory lock at
`<cleoHome>/locks/saga-reconcile/<sagaId>.lock` serializes concurrent runs;
idempotent — re-running on a correct saga emits `action: 'no-op'`. Every
decision logged to `.cleo/audit/saga-reconcile.jsonl`. Dogfooded against
cleocode: 10 sagas surveyed, 3 closure-ready (T9625, T9787, T9831), 5 with
pending members, 2 already-done. Supersedes T10098 standalone scope.
Saga: T10113. Epic: T10210.
