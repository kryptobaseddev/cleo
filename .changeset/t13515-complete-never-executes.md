---
id: t13515-complete-never-executes
tasks: [T13515]
kind: fix
summary: "cleo complete never executes a typed gate command: its merged-CI auto-record write is cache-only (noRun)"
---

When `evidence.ciSatisfies` is set and the PR has merged, `cleo complete`
records `ci:<pr>` for missing gates through the ordinary gate write. That
write executed every typed gate without a cached pass, so completing a task
could run gate commands, against live services or databases among them. The
write is now cache-only (`noRun`). If a typed gate the write links has no
cached pass, merged CI cannot stand in and completion says so; run
`cleo verify <id> --run` first. A test also pins that
`cleo verify --run --req` on a cold cache executes only the selected gates.
