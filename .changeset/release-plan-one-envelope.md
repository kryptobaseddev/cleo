---
id: release-plan-one-envelope
tasks: [T13322, T13323]
kind: fix
summary: release plan writes one JSON envelope on stdout; a --tasks plan no longer picks an epic
---

`cleo release plan` printed the spawn-readiness report ("Spawn Readiness
Check ... All gates passed") on stdout, above the LAFS envelope. A caller that
parsed stdout as JSON failed (ADR-086). The report now goes to stderr. The
standalone `cleo hygiene validate-spawn-readiness` still prints it on stdout.

A `--tasks` plan set `epicId` to the first task's parent. For the v2026.10.5
dry run, 28 tasks spanning four epics were attributed to T12323. A `--tasks`
plan now records `epicId: null` (the contract allows null), and each task's
`epicAncestor` is its own parent instead of the first task's.
