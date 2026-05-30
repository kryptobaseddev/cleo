---
id: t11404-reclaim-core-tools-files
tasks: [T11404, T11390]
kind: refactor
summary: Reclaim core/src/tools — relocate 5 file squatters to honest core siblings (engine/doctor/scaffold/backfill)
---

E3 T11404 (file portion). Moves engine-ops.ts→core/src/engine, doctor-project.ts→core/src/doctor, scaffold-global/project.ts→core/src/scaffold, adr-backfill-walker.ts→core/src/backfill (same-depth moves preserve relative imports; honest homes already exist). tools/index.ts barrel repointed + internal.ts importer fixed — public API unchanged (zero behavior change). core/src/tools now holds the atomic primitives (fs/shell/guard) + the 3 remaining dir squatters (brain-tools/task-tools/sdk — follow-up, need depth-fixups). T11404 stays open.
