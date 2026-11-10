---
id: core-barrel-load-effects
tasks: [T14391]
kind: fix
summary: "Release invariants register through an explicit init, and CORE modules stop loading their own internal barrel"
---

Importing `release/invariants` (and so every CORE barrel that re-exports it)
registered the archive-reason invariant as a side effect. It now registers
through `registerReleaseInvariants()`, which `@cleocode/core/registrations`
and `cleo reconcile release` call. The barrel registers nothing.

Eight CORE modules (`sentient/*`, `nexus/projects-scan.ts`,
`nexus/analyze-orchestrator.ts`) loaded `@cleocode/core/internal`, the whole
CORE barrel, to reach one function each. They now import the module that
declares it. At runtime those paths load a few modules instead of about 1,100.
The static import graph also stops treating every CORE module as reachable
from them, so file-level test selection covers more single-package core PRs.
