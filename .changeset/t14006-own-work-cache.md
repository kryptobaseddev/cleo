---
id: t14006-own-work-cache
tasks: [T14006]
kind: fix
summary: The own-work search is reused per task within a process, skips done tasks in release plan, and reads origin branches
---

The per-kind gates (T14001) search a non-code task's own work with git
and, for a GitHub origin, one `gh pr list`.

- **Reused within a process.** The answer is reused for a minute while HEAD
  stays put. `cleo verify` asked twice and now searches once. Release plan
  asks once per task.
- **Done tasks skipped.** Release plan grandfathers done tasks, so they now
  keep their declared kind and pay for no search.
- **Remote branches read.** The branch step also reads `origin/` branches
  that cite the task, so a pushed branch with no local copy still counts.
