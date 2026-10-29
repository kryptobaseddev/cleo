---
id: session-end-no-brain-scan
tasks: [T14120]
kind: fix
summary: "cleo session end returns in about a second on a large store: it no longer runs the brain noise scan, and the scan's orphan-edge query is index-searched"
---

`cleo session end` took about 120 s on a copy of a real 1.4 GB store. A CPU
profile put 120.3 of the 121.9 s in `scanBrainGraphOrphans`; the backup was
not the cause, because the session-end snapshot already runs in a detached
worker.

- **Session end skips the scan.** Both session-end paths (the CLI engine and
  the SessionEnd journal hook) ran the full brain noise scan only to write a
  `doctorSummary` field into the session journal, and nothing reads that
  field. Session end no longer runs the scan. Brain health remains
  `cleo memory doctor`'s job, and older journal entries still parse.
- **The scan's slow query is fixed.** Its orphan-edge query joined
  `tasks_tasks` on `e.from_id = 'task:' || task_source.id`, which scanned
  every task for each edge (170k edges by 7k tasks). The join now searches the
  primary key with `task_source.id = substr(e.from_id, 6)`, still exact and
  case-sensitive. On the same copy the query went from 48.5 s to 0.27 s with
  identical results, so `cleo memory doctor` and `cleo doctor knowledge` are
  fast too.
